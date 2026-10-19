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
 * `MAX_SAMPLES` samples and `WINDOW_MS` of them — about 30 objects of roughly
 * 100 bytes, under 10 KB. Nothing is stored and no sync key is used; a reload
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
import { attributeIncoming, newTakenState, seedTakenState, resolveName } from '../../utils/damage-taken.js';

/** Setting that gates the whole module */
export const SETTING = 'combatDeathRecap';

/** How much history a recap carries */
export const WINDOW_MS = 15000;
/** Hard cap on buffered ticks, whatever their spacing */
export const MAX_SAMPLES = 30;
/** Hits kept per tick */
const MAX_HITS_PER_SAMPLE = 6;
/** Casts kept in the ring */
const MAX_CASTS = 20;
/** Frozen recaps kept */
export const MAX_RECAPS = 5;
/** How much of the tail the recap displays */
export const SHOWN_MS = 10000;

const BUTTON_ID = 'toolasha-death-recap-button';
const MODAL_ID = 'toolasha-death-recap-modal';

/** Samples, oldest first: {t, hp, mp, hits: [{amount, src, miss}], regen} */
let ring = [];
/** Casts, oldest first: {t, ability} */
let casts = [];
let ownIndex = null;
let ownCharacterId = null;
let battleId = null;
let takenState = newTakenState();
let monsterNames = {};
let lastAbility = null;
let dead = false;
let lastCount = null;
/** Recaps frozen by a tick in the current fight that no death count has matched yet */
let pending = [];
/** Frozen recaps, newest first */
let recaps = [];
let nextId = 1;
/** Whether `new_battle` just seeded the damage baselines for the next tick's battle */
let seeded = false;

let handlers = [];
const uiNodes = { button: null, modal: null };

/** @returns {string|null} The logged-in character id */
function currentId() {
    return dataManager.getCurrentCharacterId?.() ?? null;
}

/**
 * The local player's seat and entry in a `new_battle`.
 * @param {Object} data - `new_battle` payload
 * @returns {{index: string, player: Object}|null} Null when no entry is ours
 */
function findOwn(data) {
    const raw = data?.players;
    const entries = Object.entries(raw || {});
    const id = currentId();
    const name = dataManager.getCurrentCharacterName?.() ?? null;
    const hit =
        entries.find(([, p]) => id !== null && p?.character?.id === id) ||
        entries.find(([, p]) => name && (p?.character?.name === name || p?.name === name));
    return hit ? { index: hit[0], player: hit[1] } : null;
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
    return hrid ? String(hrid).split('/').pop().replace(/_/g, ' ') : null;
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
    const shown = samples.filter((s) => end - s.t <= SHOWN_MS);
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
            .filter((c) => end - c.t <= SHOWN_MS)
            .slice(-5)
            .map((c) => ({ ability: c.ability, rel: c.t - end })),
        // Less than the window means recording began late or ticks were missed
        insufficient: !shown.length || end - shown[0].t < SHOWN_MS - 3000,
    };
}

/** Insert a recap, newest first, bounded */
function keep(recap) {
    recaps.unshift(recap);
    if (recaps.length > MAX_RECAPS) recaps.length = MAX_RECAPS;
    refreshButton();
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
        keep(recap);
        // The next death's tail must not include this one's samples or the time spent dead
        ring = [];
        casts = [];
        return recap;
    }

    if (signal === 'count') {
        const rise = info.rise || 0;
        // The tick-frozen recaps belong to the fight that ended either way; none carries over
        const matched = pending.splice(0, Math.max(0, rise));
        pending = [];
        for (const recap of matched) {
            recap.confirmed = true;
            recap.source = 'both';
        }
        const unseen = rise - matched.length;
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
        const own = findOwn(data);

        // Death-count signal, read against the fight that just ended
        let rise = 0;
        if (own) {
            const count = Number(own.player.deathCount ?? 0);
            if (Number.isFinite(count)) {
                if (lastCount !== null && count > lastCount) rise = count - lastCount;
                lastCount = count;
            }
        }
        // Snapshot BEFORE the ring is cleared
        const samples = ring.slice();
        const castSnapshot = casts.slice();
        if (own || pending.length) detectDeath('count', { rise, samples, casts: castSnapshot });

        ring = [];
        casts = [];
        dead = false;
        lastAbility = null;
        takenState = newTakenState();
        seedTakenState(takenState, data);
        monsterNames = {};
        for (const [index, monster] of Object.entries(data?.monsters || {})) {
            const name = monsterName(monster);
            if (name) monsterNames[index] = name;
        }
        ownIndex = own ? own.index : null;
        ownCharacterId = own ? currentId() : null;
        seeded = true;
    } catch (error) {
        console.error('[DeathRecap] Reading a new battle failed:', error);
    }
}

/** Handle a `battle_updated` tick */
function onBattleUpdated(data) {
    try {
        if (data?.battleId !== battleId) {
            battleId = data?.battleId;
            if (!seeded) takenState = newTakenState();
            seeded = false;
        }
        if (ownIndex === null) return;
        const player = data?.pMap?.[ownIndex];
        if (!player) return;

        const now = Date.now();
        const events = attributeIncoming(data, takenState).filter((e) => e.playerIndex === ownIndex);

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
        if (ability && ability !== lastAbility) casts.push({ t: now, ability });
        lastAbility = ability || lastAbility;
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
    if (typeof document === 'undefined' || !document.body) return false;
    const recap = id === undefined ? recaps[0] : recaps.find((r) => r.id === id);
    if (!recap) return false;
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
    return true;
}

/** Remove the modal */
function closeModal() {
    uiNodes.modal?.remove();
    uiNodes.modal = null;
}

/** Forget everything and detach */
function disable() {
    for (const off of handlers) off();
    handlers = [];
    ring = [];
    casts = [];
    recaps = [];
    pending = [];
    ownIndex = null;
    ownCharacterId = null;
    battleId = null;
    lastCount = null;
    lastAbility = null;
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
