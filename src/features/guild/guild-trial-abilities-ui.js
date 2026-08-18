/**
 * The Trial Abilities panel: capture progress and aura coverage, live.
 *
 * The session logic lives in `guild-trial-abilities.js`; this file only draws
 * it. While the roster is still being clicked through, every claim on the
 * panel is hedged — coverage reads `Unknown`, never `MISSING`, because a kit
 * nobody has looked at is not an empty kit. Only when every current
 * participant has an authoritative capture does the panel say what is missing.
 *
 * The controls never skip anyone: a capture that times out leaves its player
 * outstanding and retryable, and nothing here auto-completes the roster.
 */

import dataManager from '../../core/data-manager.js';
import guildLoadoutCapture from './guild-loadout-capture.js';
import { findBattleUnits, REQUEST_TIMEOUT_MS } from './guild-member-skills.js';
import guildTrialAbilities from './guild-trial-abilities.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import { isAuraAbility } from '../../utils/party-lint.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';

const ACCENT = '#a8d6a0';

/** Exact section title — the label the export's readers key their eyes on too */
export const AURA_SECTION_TITLE = 'Equipped aura coverage';

/**
 * A tier as the panel writes one.
 * @param {number|string|null} tier - e.g. `4` or `'T4'`
 * @returns {string|null} e.g. `T4`
 */
export function tierText(tier) {
    if (tier === null || tier === undefined || tier === '') return null;
    const numeric = Number(tier);
    if (Number.isFinite(numeric)) return `T${numeric}`;
    return String(tier);
}

/**
 * The tiers a session's captures span, as one label.
 * @param {Array<number|string>} capturedTiers - From the session
 * @param {number|string|null} captureTier - Tier at first capture
 * @returns {string|null} `T4`, `T4-T5`, or null when no tier is known
 */
export function tierRangeLabel(capturedTiers, captureTier = null) {
    const tiers = [...new Set((capturedTiers || []).map((tier) => Number(tier)).filter(Number.isFinite))].sort(
        (a, b) => a - b
    );
    if (!tiers.length) return tierText(captureTier);
    if (tiers.length === 1) return `T${tiers[0]}`;
    return `T${tiers[0]}-T${tiers[tiers.length - 1]}`;
}

/**
 * The panel's headline while collecting and after.
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @returns {string} e.g. `Trial abilities — 42/50 captured`
 */
export function headerLine(state) {
    return `Trial abilities — ${state.capturedCount}/${state.rosterCount} captured`;
}

/**
 * The completion line, once there is one.
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @returns {string|null} e.g. `50/50 captured on T4` or `50/50 captured across T4-T5`
 */
export function completionLine(state) {
    if (!state.complete) return null;
    const range = tierRangeLabel(state.capturedTiers, state.captureTier);
    const mixed = new Set((state.capturedTiers || []).map(String)).size > 1;
    const where = range ? (mixed ? ` across ${range}` : ` on ${range}`) : '';
    return `${state.capturedCount}/${state.rosterCount} captured${where}`;
}

/**
 * Player rows in the order the panel shows them: outstanding first while
 * collecting (they are what the next click is for), alphabetical once done.
 *
 * @param {Array<Object>} participants - From `guildTrialAbilities.state()`
 * @param {boolean} complete - Whether every current participant is captured
 * @returns {Array<Object>} Sorted copy
 */
export function sortParticipants(participants, complete) {
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    const rows = [...(participants || [])];
    if (complete) return rows.sort(byName);
    return rows.sort((a, b) => Number(a.captured) - Number(b.captured) || byName(a, b));
}

/**
 * When each outstanding player's unit was last clicked, lowercased name → clock.
 *
 * The trial's own request ledger, deliberately separate from the roster
 * feature's. It only debounces: a click younger than
 * {@link REQUEST_TIMEOUT_MS} is a request still in flight, and once the window
 * lapses the player is simply offered again — a fetch that never answered is
 * retried, never skipped.
 */
const trialUnitRequests = {};

/** Forget every in-flight stamp — a recapture owes nobody a wait */
export function resetTrialUnitRequests() {
    for (const key of Object.keys(trialUnitRequests)) delete trialUnitRequests[key];
}

/**
 * Click the next outstanding trial participant's unit box.
 *
 * Gated by the *trial session's* outstanding list and nothing else. The roster
 * cycler in `guild-member-skills.js` skips any fighter whose combat sheet is
 * fresh in the shared loadout store — right for the roster panel, and exactly
 * what starved this panel: a sheet from `new_battle` or a stat-only popup
 * counts as fresh there while the trial session (which only accepts the
 * trial's own Battle Info) still needs the player. Here a player the session
 * has not captured is always clickable, the local player's own full card
 * included, however fresh their sheet looks to the roster feature.
 *
 * @param {number} [now] - Clock
 * @returns {{opened: string|null, how: 'unit'|'awaiting'|'no-unit'}} What happened
 */
export function openNextTrialUnit(now = Date.now()) {
    const state = guildTrialAbilities.state();
    const units = findBattleUnits(state.outstanding);
    for (const unit of units) {
        const key = unit.name.toLowerCase();
        if (now - (Number(trialUnitRequests[key]) || 0) < REQUEST_TIMEOUT_MS) continue;
        trialUnitRequests[key] = now;
        unit.el.click();
        return { opened: unit.name, how: 'unit' };
    }
    // Every outstanding fighter on screen was asked moments ago — the answer
    // is a wait or (after the window) a retry, never a skip
    return { opened: null, how: units.length ? 'awaiting' : 'no-unit' };
}

/**
 * Click one outstanding player's unit again, ignoring the request window.
 *
 * The "Retry current player" gesture: a capture that timed out or came back
 * without abilities is asked for again on demand.
 *
 * @param {string|null} [name] - Who to retry; defaults to the first outstanding unit
 * @param {number} [now] - Clock
 * @returns {{opened: string|null, how: 'unit'|'no-unit'}} What happened
 */
export function retryTrialUnit(name = null, now = Date.now()) {
    const state = guildTrialAbilities.state();
    const units = findBattleUnits(state.outstanding);
    const wanted = String(name || '')
        .trim()
        .toLowerCase();
    const unit = (wanted && units.find((entry) => entry.name.toLowerCase() === wanted)) || units[0] || null;
    if (!unit) return { opened: null, how: 'no-unit' };
    trialUnitRequests[unit.name.toLowerCase()] = now;
    unit.el.click();
    return { opened: unit.name, how: 'unit' };
}

/**
 * The controls, replaceable by the orchestrator.
 *
 * Defaults use the trial's own cycler above: one click opens one outstanding
 * participant's Battle Info, which is what makes the game send the sheet.
 * "Retry" is the same gesture aimed at a named player, window ignored.
 */
const controls = {
    openNext: () => openNextTrialUnit(),
    retryCurrent: (name) => retryTrialUnit(name),
};

/**
 * Let the orchestrator wire its own control actions.
 * @param {{openNext?: Function, retryCurrent?: Function}} overrides - Replacements
 */
export function setControls(overrides = {}) {
    if (typeof overrides.openNext === 'function') controls.openNext = overrides.openNext;
    if (typeof overrides.retryCurrent === 'function') controls.retryCurrent = overrides.retryCurrent;
}

/**
 * An ability's readable name.
 * @param {string} hrid - Ability hrid
 * @param {Object} abilityDetailMap - Game data
 * @returns {string} The name, or the hrid tail
 */
function abilityName(hrid, abilityDetailMap) {
    return abilityDetailMap?.[hrid]?.name || String(hrid).split('/').pop().replace(/_/g, ' ');
}

/**
 * The header card: progress, tier, and what the panel will not yet claim.
 * @param {HTMLElement} body - Panel body
 * @param {Object} state - From `guildTrialAbilities.state()`
 */
function drawHeader(body, state) {
    const card = panelCard(body, headerLine(state), ACCENT);

    if (!state.rosterCount) {
        card.appendChild(panelNote('No trial roster yet — the participants are fed in when a trial is on.'));
        return;
    }

    if (state.complete) {
        card.appendChild(panelLine('Complete', completionLine(state), ROW_COLORS.good));
        return;
    }

    const tier = tierRangeLabel(state.capturedTiers, state.captureTier);
    if (tier) card.appendChild(panelLine('Capture tier', tier, ROW_COLORS.gold));
    card.appendChild(
        panelLine(
            'Still needed',
            `${state.outstanding.length} player${state.outstanding.length === 1 ? '' : 's'} still need Battle Info`,
            ROW_COLORS.bad
        )
    );
    card.appendChild(panelNote('Aura coverage unknown until capture is complete.'));
}

/**
 * The aura coverage card: one row per aura the game data declares.
 * @param {HTMLElement} body - Panel body
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @param {Object} abilityDetailMap - Game data
 */
function drawAuraCoverage(body, state, abilityDetailMap) {
    const card = panelCard(body, AURA_SECTION_TITLE, ACCENT);
    const hrids = Object.keys(state.coverage).sort((a, b) =>
        abilityName(a, abilityDetailMap).localeCompare(abilityName(b, abilityDetailMap))
    );
    if (!hrids.length) {
        card.appendChild(panelNote('No aura data in the game data yet.'));
        return;
    }

    for (const hrid of hrids) {
        const name = abilityName(hrid, abilityDetailMap);
        const aura = state.auras[hrid];
        const covered = state.coverage[hrid] === 'covered';

        if (covered) {
            const level = aura.highestLevel !== null ? `Lv${aura.highestLevel}` : 'Lv?';
            const extra = aura.duplicateCount
                ? ` · ${aura.duplicateCount} redundant cop${aura.duplicateCount === 1 ? 'y' : 'ies'}`
                : '';
            const providers = aura.providers
                .map((provider) => `${provider.name}${provider.level !== null ? ` Lv${provider.level}` : ''}`)
                .join(', ');
            card.appendChild(
                panelLine(
                    name,
                    `${level} — ${aura.provider}${extra}`,
                    ROW_COLORS.good,
                    `Highest equipped copy, not an effective value.\nProviders: ${providers}`
                )
            );
        } else if (state.coverage[hrid] === 'missing') {
            card.appendChild(
                panelLine(name, 'MISSING', ROW_COLORS.bad, 'Every participant is captured and nobody equips it.')
            );
        } else {
            card.appendChild(
                panelLine(name, 'Unknown', ROW_COLORS.dim, 'Not seen yet — some participants still need Battle Info.')
            );
        }
    }
}

/**
 * One player's abilities as inline spans, auras highlighted.
 * @param {Object} capture - The player's session entry
 * @param {Object} abilityDetailMap - Game data
 * @returns {HTMLElement} The line
 */
function abilityRow(capture, abilityDetailMap) {
    const line = document.createElement('div');
    Object.assign(line.style, { display: 'flex', flexWrap: 'wrap', gap: '4px 10px', paddingLeft: '10px' });

    if (!capture.abilities?.length) {
        const empty = document.createElement('span');
        empty.textContent = 'no abilities equipped';
        empty.style.color = 'rgba(232, 236, 245, 0.5)';
        line.appendChild(empty);
        return line;
    }

    // Slot order as captured — the order the payload listed them in
    for (const ability of capture.abilities) {
        const span = document.createElement('span');
        const level = ability.level !== null && ability.level !== undefined ? ` ${ability.level}` : '';
        span.textContent = `${abilityName(ability.hrid, abilityDetailMap)}${level}`;
        if (isAuraAbility(abilityDetailMap?.[ability.hrid])) {
            span.style.color = ROW_COLORS.gold;
            span.title = 'Aura — its buff reaches the whole party.';
        } else {
            span.style.color = 'rgba(232, 236, 245, 0.75)';
        }
        line.appendChild(span);
    }
    return line;
}

/**
 * The players card: capture status and kits, in the sort the moment calls for.
 * @param {HTMLElement} body - Panel body
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @param {Object} abilityDetailMap - Game data
 */
function drawPlayers(body, state, abilityDetailMap) {
    const card = panelCard(body, `Players (${state.capturedCount}/${state.rosterCount})`, ACCENT);
    if (!state.participants.length) {
        card.appendChild(panelNote('No participants fed in yet.'));
    }

    for (const row of sortParticipants(state.participants, state.complete)) {
        if (!row.capture) {
            card.appendChild(panelLine(row.name, 'needs Battle Info', ROW_COLORS.bad));
            continue;
        }
        if (!row.captured) {
            // Seen, but only as a stat sheet: unavailable is not the same claim
            // as "no abilities equipped", so the player stays outstanding
            card.appendChild(
                panelLine(
                    row.name,
                    'abilities unavailable — needs Battle Info',
                    ROW_COLORS.bad,
                    'A stat-only sighting; the popup payload carried no ability list.'
                )
            );
            continue;
        }
        const tier = tierText(row.capture.capturedTier);
        card.appendChild(panelLine(row.name, `captured${tier ? ` (${tier})` : ''}`, ROW_COLORS.good));
        card.appendChild(abilityRow(row.capture, abilityDetailMap));
    }

    for (const player of state.notCurrent) {
        card.appendChild(
            panelLine(
                player.name || '(unnamed)',
                'not in the current roster',
                ROW_COLORS.dim,
                'Captured this session, then left the trial — the capture is kept.'
            )
        );
    }
}

/**
 * A small control button in the panel's idiom.
 * @param {string} label - Button text
 * @param {string} title - Tooltip
 * @param {Function} onClick - Action
 * @returns {HTMLElement} The button
 */
function controlButton(label, title, onClick) {
    const button = document.createElement('button');
    button.textContent = label;
    button.title = title;
    button.style.cssText =
        'background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); color: #e8ecf5; ' +
        'border-radius: 5px; padding: 4px 8px; cursor: pointer; font-size: 12px;';
    button.addEventListener('click', onClick);
    return button;
}

/**
 * The controls card.
 * @param {HTMLElement} body - Panel body
 * @param {Object} state - From `guildTrialAbilities.state()`
 */
function drawControls(body, state) {
    const card = panelCard(body, 'Controls', ACCENT);
    Object.assign(card.style, { flexDirection: 'row', flexWrap: 'wrap', gap: '6px' });

    card.appendChild(
        controlButton(
            'Open next Battle Info',
            'Click the next outstanding fighter’s unit box — one popup per click, nothing automatic.',
            () => {
                controls.openNext();
                guildTrialAbilitiesPanel.render();
            }
        )
    );
    card.appendChild(
        controlButton(
            'Retry current player',
            'Ask again for the player still outstanding. A timed-out capture is retryable, never skipped.',
            () => {
                controls.retryCurrent(state.outstanding[0]?.name ?? null);
                guildTrialAbilitiesPanel.render();
            }
        )
    );
    card.appendChild(
        controlButton(
            'Recapture trial roster',
            'Throw this session’s captures away and collect the roster again from nothing.',
            () => {
                guildTrialAbilities.recapture();
                resetTrialUnitRequests();
                guildTrialAbilitiesPanel.render();
            }
        )
    );
}

export const guildTrialAbilitiesPanel = createPanel({
    id: 'guildTrialAbilities',
    title: 'Trial Abilities',
    size: { width: 440, height: 520 },
    accent: ACCENT,
    draw: (body) => {
        const abilityDetailMap = dataManager.getInitClientData?.()?.abilityDetailMap || {};
        const state = guildTrialAbilities.state(abilityDetailMap);
        drawHeader(body, state);
        drawAuraCoverage(body, state, abilityDetailMap);
        drawPlayers(body, state, abilityDetailMap);
        drawControls(body, state);
    },
});

/**
 * Open the panel — the hook the trials UI calls.
 */
export function openTrialAbilitiesPanel() {
    guildTrialAbilitiesPanel.show();
}

/** Unsubscribe from the loadout capture's events; set in `initialize` */
let offCaptured = null;

/**
 * A loadout landed somewhere in the client — fold it in and redraw.
 *
 * The event only names who; the snapshot itself (abilities included) is read
 * back off the capture store, which has already folded it.
 *
 * @param {{name: string|null}} event - From `guildLoadoutCapture.onCaptured`
 */
function onCapturedEvent(event) {
    try {
        if (!event?.name) return;
        const snapshot = guildLoadoutCapture.forPlayer?.(event.name);
        if (!snapshot) return;
        // Your own zone fight's `new_battle` carries your combatAbilities —
        // your *current* kit, not the one this trial was entered with — and
        // folding it in marked the local player "captured" with the wrong
        // abilities while everyone else honestly said "needs Battle Info".
        // The trial session takes only what the trial itself can show: the
        // Battle Info popups, the same source for every participant.
        if (snapshot.source === 'new_battle') return;
        guildTrialAbilities.recordCapture(snapshot);
        // An answered request is over: the next click moves on to the next
        // player at once instead of waiting out the request window. Only an
        // authoritative sheet clears it — a stat-only popup sighting leaves
        // the window standing so the same popup is not hammered.
        if (snapshot.abilitiesAuthoritative === true && event.name) {
            delete trialUnitRequests[String(event.name).toLowerCase()];
        }
        guildTrialAbilitiesPanel.render();
    } catch (error) {
        console.error('[GuildTrialAbilitiesUI] Handling a capture failed:', error);
    }
}

export default {
    name: 'Guild Trial Abilities',
    /**
     * @param {string|null} [guildName] - The key the session is stored under
     * @returns {Promise<void>}
     */
    initialize: async (guildName = null) => {
        await guildTrialAbilities.initialize(guildName);
        offCaptured = guildLoadoutCapture.onCaptured?.((event) => onCapturedEvent(event)) ?? null;
    },
    cleanup: () => {
        offCaptured?.();
        offCaptured = null;
        guildTrialAbilitiesPanel.hide({ remember: false });
        guildTrialAbilities.cleanup();
    },
};
