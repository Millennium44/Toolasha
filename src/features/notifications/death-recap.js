/**
 * Death Recap
 *
 * "What happened just before I died?" — answered after the fight has already
 * moved on. A small in-memory ring of the logged-in character's last seconds
 * (HP, MP, incoming hits, casts) is frozen into a compact recap when a death is
 * seen, and opened from the death alert or a small button.
 *
 * ## Cost
 *
 * One `battle_updated` listener. Per tick it reads the local player's `pMap`
 * entry (HP, MP, ability) and runs the same incoming-damage diff the Damage
 * Taken tracker uses, then pushes one small sample. The ring holds at most
 * `MAX_SAMPLES` samples and `WINDOW_MS` of them — a busy fight sends ~50 ticks in
 * the window, objects of roughly 100 bytes, so tens of KB at most. Nothing is stored and no sync key is used; a reload
 * forgets everything, and the recap says "insufficient recording" when it has
 * less than the window.
 *
 * ## Two signals, one death
 *
 * `detectDeath` is the one place that decides a death happened:
 *
 * - **Primary — the tick.** Measured live, a solo death produces no `new_battle`:
 *   the player respawns inside the same battle about 15 s later, so the
 *   server's `deathCount` does not move until some later battle. A tick where
 *   the own HP goes from above 0 to 0 (or `isActive` goes false) freezes a
 *   recap at once, once per death — not on every tick spent dead.
 * - **Secondary — the counter.** `deathCount` rising on a `new_battle` is
 *   matched against the recaps the ticks froze in the fight that just ended
 *   (marking them count-confirmed). A rise with nothing to match — a missed
 *   tick, a party fight — creates one recap from the outgoing tail, snapshotted
 *   before the ring is cleared. Several unmatched deaths get one labelled recap.
 *
 * A pMap that omits the player means "unchanged", so such a tick records nothing
 * rather than a zero.
 *
 * ## Only your own
 *
 * `pMap` is keyed by position in the battle, so the local seat is resolved from
 * each `new_battle` (character id, then name). No entry for us: nothing is
 * recorded rather than someone else's numbers being filed as ours.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { seatFromBattle, seatFromTick, guessContradicted, rosterHp } from './own-seat.js';
import { attributeIncoming, newTakenState, seedTakenState, resolveName } from '../../utils/damage-taken.js';

/** Setting that gates the whole module */
export const SETTING = 'combatDeathRecap';

/** How much history a recap carries */
export const WINDOW_MS = 15000;
/**
 * Hard cap on buffered ticks, whatever their spacing. Sized so the window, not the count, bounds the history: a
 * captured party fight sent 52 ticks in 15 s, and a cap of 30 cut that to under 9 s
 */
export const MAX_SAMPLES = 150;
/** Hits kept per tick */
const MAX_HITS_PER_SAMPLE = 6;
/** Casts kept in the ring */
const MAX_CASTS = 20;
/** Frozen recaps kept */
export const MAX_RECAPS = 5;
/** How much of the tail the recap displays */
export const SHOWN_MS = WINDOW_MS;

const BUTTON_ID = 'toolasha-death-recap-button';
const MODAL_ID = 'toolasha-death-recap-modal';

/** Samples, oldest first: {t, hp, mp, hits: [{amount, src, miss}], regen} */
let ring = [];
/** Casts, oldest first: {t, ability} */
let casts = [];
let ownIndex = null;
/** Whether the seat came from the solo fallback rather than a roster */
let seatGuessed = false;
/** Whether a new_battle has arrived since start; after one, a missing seat is not a gap to guess across */
let battleSeen = false;
let ownCharacterId = null;
let battleId = null;
let takenState = newTakenState();
let monsterNames = {};
let lastAbility = null;
/** The ability being prepared going into the latest tick, and the action counter then */
let lastPrepared = null;
let lastAtk = null;
let dead = false;
let lastCount = null;
/** Recaps frozen by a tick in the current fight that no death count has matched yet */
let pending = [];
/** Observed deaths older than the retained `pending` recaps: owed a counter rise, nothing left to confirm */
let evictedPending = 0;
/** Frozen recaps, newest first */
let recaps = [];
let nextId = 1;
/** Whether `new_battle` just seeded the damage baselines for the next tick's battle */
let seeded = false;

let handlers = [];
const uiNodes = { button: null, modal: null };
/** The recap the open modal is showing, kept even after it is evicted from `recaps` */
let viewing = null;

/** @returns {string|null} The logged-in character id */
function currentId() {
    return dataManager.getCurrentCharacterId?.() ?? null;
}

/** @param {string} hrid Ability hrid @returns {string} Display name */
function abilityName(hrid) {
    const detail = dataManager.getInitClientData?.()?.abilityDetailMap?.[hrid];
    return detail?.name || String(hrid).split('/').pop().replace(/_/g, ' ');
}

/** @param {Object} monster A `new_battle` monster @returns {string|null} Its name */
function monsterName(monster) {
    if (monster?.name) return monster.name;
    const hrid = monster?.combatMonsterHrid || monster?.monsterHrid || monster?.hrid;
    if (!hrid) return null;
    // The live payload carries only the hrid; the game's own name for it, else one made from the hrid
    const known = dataManager.getInitClientData?.()?.combatMonsterDetailMap?.[hrid]?.name;
    return known || String(hrid).split('/').pop().replace(/_/g, ' ');
}

/** Monster names by roster index from a `new_battle` payload */
function namesFrom(battle) {
    const names = {};
    for (const [index, monster] of Object.entries(battle?.monsters || {})) {
        const name = monsterName(monster);
        if (name) names[index] = name;
    }
    return names;
}

/** Drop what is past the window or the cap */
function trim(now) {
    while (ring.length && (now - ring[0].t > WINDOW_MS || ring.length > MAX_SAMPLES)) ring.shift();
    while (casts.length && (now - casts[0].t > WINDOW_MS || casts.length > MAX_CASTS)) casts.shift();
}

/**
 * Build a recap from a copy of the buffer.
 * @param {Array<Object>} samples - Ring snapshot
 * @param {Array<Object>} castList - Casts snapshot
 * @param {Object} meta - {source, confirmed, deaths}
 * @returns {Object} The recap
 */
function buildRecap(samples, castList, meta) {
    const end = samples.length ? samples[samples.length - 1].t : Date.now();
    const shown = samples.filter((s) => end - s.t <= WINDOW_MS);
    const totals = {};
    for (const sample of shown) {
        for (const hit of sample.hits) {
            if (hit.miss) continue;
            totals[hit.src] = (totals[hit.src] || 0) + hit.amount;
        }
    }
    const sources = Object.entries(totals)
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 3);
    return {
        id: nextId++,
        at: Date.now(),
        characterId: ownCharacterId,
        source: meta.source,
        confirmed: meta.confirmed,
        deaths: meta.deaths || 1,
        samples: shown.map((s) => ({ ...s, hits: s.hits.map((h) => ({ ...h })), rel: s.t - end })),
        sources,
        casts: castList
            .filter((c) => end - c.t <= WINDOW_MS)
            .slice(-5)
            .map((c) => ({ ability: c.ability, rel: c.t - end })),
        // Less than the window means recording began late or ticks were missed
        insufficient: !shown.length || end - shown[0].t < WINDOW_MS - 3000,
    };
}

/** Insert a recap, newest first, bounded */
function keep(recap) {
    recaps.unshift(recap);
    if (recaps.length > MAX_RECAPS) recaps.length = MAX_RECAPS;
    refreshButton();
    // An open modal's "n of N" and its Older/Newer targets were drawn for the old list
    if (uiNodes.modal && viewing) {
        const scroll = uiNodes.modal.scrollTop;
        renderRecap(viewing);
        if (uiNodes.modal) uiNodes.modal.scrollTop = scroll;
    }
}

/**
 * The one place a death is decided. Two signals, one recap per death.
 *
 * @param {'hp'|'count'} signal - Which evidence arrived
 * @param {Object} [info] - For 'hp': nothing. For 'count': `{rise, samples, casts}` — the outgoing
 *   fight's snapshot, taken before the ring was cleared, and how many deaths the counter rose by
 * @returns {Object|null} The recap that was created or confirmed (for 'count': the newest), or null
 */
export function detectDeath(signal, info = {}) {
    if (signal === 'hp') {
        if (!ring.length) return null;
        const recap = buildRecap(ring.slice(), casts.slice(), { source: 'hp', confirmed: false });
        pending.push(recap);
        // The display cap is not the accounting: an evicted reference is still an observed, unconfirmed death
        if (pending.length > MAX_RECAPS) {
            pending.shift();
            evictedPending += 1;
        }
        keep(recap);
        // The next death's tail must not include this one's samples or the time spent dead
        ring = [];
        casts = [];
        return recap;
    }

    if (signal === 'count') {
        const rise = info.rise || 0;
        // The tick-frozen recaps belong to the fight that ended either way; none carries over
        // Tick-frozen recaps stay owed until a rise consumes them; the counter can lag by several battles
        // Oldest first: evicted observed deaths, then the retained recaps in order
        const owed = Math.max(0, rise);
        const fromEvicted = Math.min(evictedPending, owed);
        evictedPending -= fromEvicted;
        const matched = pending.splice(0, owed - fromEvicted);
        for (const recap of matched) {
            recap.confirmed = true;
            recap.source = 'both';
        }
        const unseen = rise - fromEvicted - matched.length;
        let created = null;
        if (unseen > 0) {
            // No tick-observed death for these: the previous fight's tail is the only evidence, and
            // several unseen deaths do not get separate timelines
            created = buildRecap(info.samples || [], info.casts || [], {
                source: 'count',
                confirmed: true,
                deaths: unseen,
            });
            keep(created);
        }
        refreshButton();
        return created || matched[matched.length - 1] || null;
    }
    return null;
}

/** Handle a `new_battle` */
function onNewBattle(data) {
    try {
        const own = seatFromBattle(data);

        // Death-count signal, read against the fight that just ended
        let rise = 0;
        if (own) {
            const count = Number(own.player.deathCount ?? 0);
            if (Number.isFinite(count)) {
                // A counter that went down is a new session: nothing pending is owed a rise
                if (lastCount !== null && count < lastCount) {
                    pending = [];
                    evictedPending = 0;
                }
                // A first reading is only a baseline: it confirms and consumes nothing
                if (lastCount !== null && count > lastCount) rise = count - lastCount;
                lastCount = count;
            }
        }
        // Snapshot BEFORE the ring is cleared
        const samples = ring.slice();
        const castSnapshot = casts.slice();
        const counted = rise > 0 ? detectDeath('count', { rise, samples, casts: castSnapshot }) : null;

        // A new encounter or dungeon wave is not a new recording: the last seconds before it are still the
        // last seconds before a death that follows. History is dropped only when it cannot belong to the
        // next death: no seat of ours (or another character), or it was just frozen into a counter-made recap.
        // (A tick-frozen death already emptied the ring when it froze.) Every sample is the local player's
        // by construction, and monster names are stored as text, so a seat change does not misattribute them.
        const sameCharacter = own && ownCharacterId !== null && ownCharacterId === currentId();
        if (!sameCharacter || counted?.source === 'count') {
            ring = [];
            casts = [];
        } else {
            trim(Date.now());
        }
        // Still dead if the roster says so (a new wave starting while we wait to respawn); unknown keeps the
        // state, and only a positive HP observed on a tick or here ends it
        const startHp = own ? rosterHp(own.player) : NaN;
        dead = own ? (Number.isFinite(startHp) ? startHp <= 0 : dead) : false;
        // Seed the cast baseline from our row so the opening cast is recorded
        const startAtk = Number(
            own?.player?.attackAttemptCounter ??
                own?.player?.atkCounter ??
                own?.player?.combatDetails?.attackAttemptCounter
        );
        lastAtk = Number.isFinite(startAtk) ? startAtk : null;
        lastPrepared = own?.player?.preparingAbilityHrid || own?.player?.abilityHrid || null;
        lastAbility = lastPrepared;
        takenState = newTakenState();
        seedTakenState(takenState, data);
        monsterNames = namesFrom(data);
        ownIndex = own ? own.index : null;
        seatGuessed = false;
        battleSeen = true;
        ownCharacterId = own ? currentId() : null;
        seeded = true;
    } catch (error) {
        console.error('[DeathRecap] Reading a new battle failed:', error);
    }
}

/**
 * A tick whose own row omits `cHP` or `dmgCounter` means "unchanged". The damage diff reads a missing `cHP` as NaN
 * (a hit of NaN damage, then a poisoned baseline) and a missing counter as 0 (so the next real counter reads as
 * a new hit), so the last known values are filled in. With no baseline to fill from, the row is left out.
 * @param {Object} data - `battle_updated` payload
 * @param {string} index - Our seat
 * @returns {Object} The payload to diff, never mutating `data`
 */
function carryOmitted(data, index) {
    const row = data?.pMap?.[index];
    if (!row) return data;
    const known = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
    const patch = {};
    if (!known(row.cHP)) {
        if (!known(takenState.playersHP[index])) {
            const { [index]: _omitted, ...rest } = data.pMap;
            return { ...data, pMap: rest };
        }
        patch.cHP = takenState.playersHP[index];
    }
    if (!known(row.dmgCounter) && known(takenState.playersDmg[index])) patch.dmgCounter = takenState.playersDmg[index];
    return Object.keys(patch).length ? { ...data, pMap: { ...data.pMap, [index]: { ...row, ...patch } } } : data;
}

/** Handle a `battle_updated` tick */
function onBattleUpdated(data) {
    try {
        if (data?.battleId !== battleId) {
            battleId = data?.battleId;
            if (!seeded) takenState = newTakenState();
            seeded = false;
        }
        if (ownIndex === null) {
            // A new_battle that named no seat of ours is an answer (not our fight); only a missing one is a gap
            if (battleSeen) return;
            // No new_battle named the seat (a reload in an ongoing fight): the cached battle or a safe solo guess
            const found = seatFromTick(data);
            if (!found) return;
            ownIndex = found.index;
            seatGuessed = found.guessed;
            ownCharacterId = currentId();
        } else if (seatGuessed && guessContradicted(data)) {
            ownIndex = null;
            seatGuessed = false;
            return;
        }
        const player = data?.pMap?.[ownIndex];
        if (!player) return;

        const now = Date.now();
        const events = attributeIncoming(carryOmitted(data, ownIndex), takenState).filter(
            (e) => e.playerIndex === ownIndex
        );

        // A reload in an ongoing fight: its new_battle came before this module listened, and a solo respawn sends
        // none, so the names come from the data manager's cached copy, as the seat does (seatFromTick)
        if (!battleSeen && !Object.keys(monsterNames).length) monsterNames = namesFrom(dataManager.battleData);
        const nameOf = (i) => monsterNames[i] || null;
        const hits = [];
        let regen = 0;
        for (const event of events) {
            if (event.isRegen) regen += event.damage;
            else if (event.isDeath || event.isRevive) continue;
            else if (hits.length < MAX_HITS_PER_SAMPLE) {
                hits.push({
                    amount: event.damage,
                    miss: !!event.isMiss,
                    src: resolveName(event.monsters, nameOf),
                });
            }
        }

        // A field the tick omits is unchanged, not zero: carry the last known value forward
        const last = ring[ring.length - 1];
        const hp = Number.isFinite(Number(player.cHP)) && player.cHP !== null ? Number(player.cHP) : (last?.hp ?? NaN);
        const mp = Number.isFinite(Number(player.cMP)) && player.cMP !== null ? Number(player.cMP) : (last?.mp ?? NaN);
        const down = (Number.isFinite(hp) && hp <= 0) || player.isActive === false;
        // Ticks spent dead (waiting to respawn) are not part of any tail
        if (down && dead) return;

        ring.push({ t: now, hp: Number.isFinite(hp) ? hp : null, mp: Number.isFinite(mp) ? mp : null, hits, regen });

        const ability = player.preparingAbilityHrid || player.abilityHrid || null;
        const atk = Number(player.atkCounter);
        if (Number.isFinite(atk)) {
            // The action counter advancing is a swing; the ability prepared going into the tick is what it
            // was. This records repeated casts of one ability, which a change of label cannot.
            if (lastAtk !== null && atk > lastAtk && lastPrepared) casts.push({ t: now, ability: lastPrepared });
            lastAtk = atk;
        } else if (ability && ability !== lastAbility) {
            // No counter on this tick: fall back to a change of label
            casts.push({ t: now, ability });
        }
        lastAbility = ability || lastAbility;
        if (ability) lastPrepared = ability;
        else if (player.isPreparingAutoAttack || player.isAutoAtk) lastPrepared = null;
        trim(now);

        // Dead: HP at 0, or the game's own flag. Alive again once HP is back and the flag is not false
        if (down && !dead) {
            dead = true;
            detectDeath('hp');
        } else if (!down && Number.isFinite(hp) && hp > 0) {
            dead = false;
        }
    } catch (error) {
        console.error('[DeathRecap] Reading a combat tick failed:', error);
    }
}

/** @returns {Array<Object>} Frozen recaps, newest first (read-only view) */
export function recapHistory() {
    return recaps;
}

// --- UI ---

/** Show or hide the small button according to whether anything is kept */
function refreshButton() {
    if (typeof document === 'undefined' || !document.body) return;
    if (!recaps.length) {
        uiNodes.button?.remove();
        uiNodes.button = null;
        return;
    }
    if (!uiNodes.button) {
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        Object.assign(button.style, {
            position: 'fixed',
            left: '12px',
            bottom: '12px',
            zIndex: '1190',
            background: 'rgba(36, 14, 14, 0.95)',
            color: '#ff9e9e',
            border: '1px solid rgba(255, 82, 82, 0.8)',
            borderRadius: '6px',
            padding: '4px 8px',
            fontSize: '12px',
            cursor: 'pointer',
        });
        button.addEventListener('click', () => openRecap());
        document.body.appendChild(button);
        uiNodes.button = button;
    }
    uiNodes.button.textContent = `Death recap (${recaps.length})`;
}

/** @param {number} n @returns {string} HP/MP figure */
function fmt(n) {
    return n === null || n === undefined ? '?' : Math.round(n).toLocaleString('en-US');
}

/**
 * Open the recap for a death, newest by default.
 * @param {number} [id] - Recap id
 * @returns {boolean} Whether a recap was shown
 */
export function openRecap(id) {
    const recap = id === undefined ? recaps[0] : recaps.find((r) => r.id === id);
    return recap ? renderRecap(recap) : false;
}

/** @param {Object} recap A recap object @returns {boolean} Whether it was drawn */
function renderRecap(recap) {
    if (typeof document === 'undefined' || !document.body) return false;
    closeModal();

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    Object.assign(modal.style, {
        position: 'fixed',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        width: 'min(460px, 92vw)',
        maxHeight: '80vh',
        overflowY: 'auto',
        zIndex: '1195',
        background: 'rgba(20, 14, 14, 0.98)',
        color: '#e6d6d6',
        border: '1px solid rgba(255, 82, 82, 0.8)',
        borderRadius: '8px',
        padding: '12px',
        fontSize: '13px',
        lineHeight: '1.4',
    });

    const line = (text, bold) => {
        const div = document.createElement('div');
        div.textContent = text;
        if (bold) div.style.fontWeight = '600';
        modal.appendChild(div);
        return div;
    };

    const status =
        recap.source === 'count'
            ? 'reported by the server death count; the timeline is the end of the previous fight'
            : recap.confirmed
              ? 'seen live (HP reached 0) and confirmed by the server death count'
              : 'seen live (HP reached 0); the server death count has not reported it yet';
    line(`Death recap — ${new Date(recap.at).toLocaleTimeString()}`, true);
    // Several kept: step between them. Recaps are newest first, so "older" is the next index. The buttons
    // live inside the modal, so closing it (or re-rendering for another recap) disposes their listeners.
    const position = recaps.indexOf(recap);
    if (recaps.length > 1 && position >= 0) {
        const nav = document.createElement('div');
        nav.dataset.role = 'recap-nav';
        Object.assign(nav.style, { display: 'flex', gap: '8px', alignItems: 'center', margin: '4px 0' });
        const step = (label, target) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.disabled = !target;
            if (target) button.addEventListener('click', () => openRecap(target.id));
            nav.appendChild(button);
        };
        step('‹ Older', recaps[position + 1]);
        const where = document.createElement('span');
        where.textContent = `${position + 1} of ${recaps.length}`;
        nav.appendChild(where);
        step('Newer ›', recaps[position - 1]);
        modal.appendChild(nav);
    }
    line(status);
    if (recap.deaths > 1) line(`${recap.deaths} deaths arrived at once; only the last fight tail is shown.`);
    if (recap.insufficient) line('Insufficient recording: ticks before this point were not observed.');

    line('Last seconds', true);
    if (!recap.samples.length) line('No ticks were recorded for this death.');
    for (const s of recap.samples) {
        const hits = s.hits.map((h) => (h.miss ? `${h.src} missed` : `${h.src} -${fmt(h.amount)}`)).join(', ');
        line(`${(s.rel / 1000).toFixed(1)}s  HP ${fmt(s.hp)}  MP ${fmt(s.mp)}${hits ? '  ' + hits : ''}`);
    }

    line('Top damage sources', true);
    if (!recap.sources.length) line('None observed (attribution is approximate).');
    for (const src of recap.sources) line(`${src.name}: ${fmt(src.amount)}`);

    line('Last casts', true);
    if (!recap.casts.length) line('None observed.');
    for (const c of recap.casts) line(`${(c.rel / 1000).toFixed(1)}s  ${abilityName(c.ability)}`);

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.style.marginTop = '8px';
    close.addEventListener('click', closeModal);
    modal.appendChild(close);

    document.body.appendChild(modal);
    uiNodes.modal = modal;
    viewing = recap;
    return true;
}

/** Remove the modal */
function closeModal() {
    uiNodes.modal?.remove();
    uiNodes.modal = null;
    viewing = null;
}

/** Forget everything and detach */
function disable() {
    for (const off of handlers) off();
    handlers = [];
    ring = [];
    casts = [];
    recaps = [];
    pending = [];
    evictedPending = 0;
    ownIndex = null;
    seatGuessed = false;
    battleSeen = false;
    ownCharacterId = null;
    battleId = null;
    lastCount = null;
    lastAbility = null;
    lastPrepared = null;
    lastAtk = null;
    dead = false;
    seeded = false;
    monsterNames = {};
    takenState = newTakenState();
    closeModal();
    uiNodes.button?.remove();
    uiNodes.button = null;
}

export default {
    name: 'Death Recap',
    initialize: async () => {
        if (!config.getSetting(SETTING)) return;
        disable();
        webSocketHook.on('new_battle', onNewBattle);
        webSocketHook.on('battle_updated', onBattleUpdated);
        const onSwitching = () => disable();
        dataManager.on('character_switching', onSwitching);
        handlers = [
            () => webSocketHook.off('new_battle', onNewBattle),
            () => webSocketHook.off('battle_updated', onBattleUpdated),
            () => dataManager.off('character_switching', onSwitching),
        ];
    },
    disable,
    cleanup: disable,
};
