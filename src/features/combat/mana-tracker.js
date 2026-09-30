/**
 * Mana tracker
 *
 * What your abilities are costing you, per fight.
 *
 * Mana is the constraint nobody watches. Damage is in the combat log; mana is
 * visible only as the moment an ability does not fire, and by then the fight has
 * already gone differently. The figure worth having is per fight rather than the
 * running total, because a total only says how long you have been playing.
 *
 * ## The game says what was cast, not what it cost
 *
 * `battle_consumable_ability_updated` announces a cast. The cost comes from
 * `abilityDetailMap[hrid].manaCost`, so a cast is a message and its mana is a
 * lookup. An ability the game has never described contributes casts and no mana,
 * and the summary says so rather than reporting a short total as a measurement.
 *
 * The arithmetic is in `utils/mana-spend.js` with tests. This module subscribes,
 * looks costs up, and draws one line.
 *
 * The model is MAna's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { findOwnBattlePlayer } from '../../core/character-abilities.js';
import webSocketHook from '../../core/websocket.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS, glyph } from '../../utils/overlay-format.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { newManaTally, recordCast, recordFight, manaSummary } from '../../utils/mana-spend.js';
import { buildMpCandidates, findBestOptimAllocation, findMaxMpAllocation } from '../../utils/mp-optimizer.js';
import { resolveItemPrice } from '../../utils/profit-helpers.js';

/** A rate over less wall-clock time than this is noise, not a measurement */
const MIN_RATE_SPAN_MS = 60_000;

/**
 * A silence longer than this between counted events means the character left combat (skilling, away), not
 * that it is still fighting. In combat a cast, `new_battle` or auto-cycle arrives every few seconds, the
 * wave respawn gap is about 3 s, and a player death in a trial can idle up to about 150 s; 5 minutes clears
 * all of those, so only a real departure is cut out of the rate's denominator.
 */
const COMBAT_GAP_MS = 5 * 60_000;

/**
 * Wall-clock span of the tally, for a per-minute rate. Kept beside the tally
 * rather than in it: `mana-spend.js` counts fights and casts and has no clock.
 */
let firstEventAt = null;
let lastEventAt = null;
/**
 * Observed time banked from earlier stretches of the tally. The tracker being disabled pauses the clock:
 * `cleanup()` banks the stretch so far and clears `firstEventAt`, and the next event opens a new one, so
 * the disabled interval never reaches the rate's denominator.
 */
let bankedMs = 0;
/**
 * Mana already counted when the clock started. A cast that opens the span (tracking began mid-fight, with
 * no `new_battle` before it) marks the start of the interval rather than filling it, so it stays out of
 * the rate's numerator; a `new_battle` starts the clock with none. A stretch resumed after a pause adds its
 * opening cast here the same way.
 */
let baselineMana = 0;

/** The character's own food haste and drink concentration, from the last `new_battle` */
let haste = { foodHaste: 0, drinkConcentration: 0 };
/** The character's own consumable slots, from `new_battle`; null until seen (the planner then assumes 3 + 3) */
let slots = null;
/** The character's own max MP, from `new_battle`; null until seen (instant restores are then uncapped) */
let maxMana = null;

/** What the MP optimizer panel section was last asked for; null until typed, so the measured rate fills it */
let optimTarget = null;

/**
 * The running tally, at module scope so the row can read it.
 *
 * Kept across the feature being disabled and re-enabled: a mana figure is only
 * useful over a run, and throwing it away on a settings change would make it
 * impossible to measure a long one.
 */
let tally = newManaTally();

/**
 * The character the tally, typed target, haste and slots belong to. While the feature is disabled its
 * `character_switching` handler is unregistered, so a switch then resets nothing; `initialize()` compares
 * this against the current character instead. Null until something is written.
 */
let ownerCharacterId = null;

/** Mark the retained state as the current character's; called wherever that state is written */
function claimState() {
    ownerCharacterId = dataManager.getCurrentCharacterId?.() ?? ownerCharacterId;
}

/**
 * Forget the supply planner's per-character state: the typed target, haste and slots.
 * Called on a character switch, and by tests between cases.
 */
export function resetMpPlanner() {
    haste = { foodHaste: 0, drinkConcentration: 0 };
    slots = null;
    maxMana = null;
    optimTarget = null;
}

/** Start the count again from here */
export function resetManaTally() {
    tally = newManaTally();
    firstEventAt = null;
    lastEventAt = null;
    bankedMs = 0;
    baselineMana = 0;
}

/** Pause the span clock: bank the stretch observed so far; the next event opens a new one */
function pauseSpan() {
    if (firstEventAt === null) return;
    bankedMs += lastEventAt - firstEventAt;
    firstEventAt = null;
}

/**
 * Note that something was counted, for the span a per-minute rate divides by.
 * @param {number} [openingMana] - Mana of the event, when it is a cast: kept out of the rate if it starts the span
 * @param {number} [now] - Clock reading, injectable for tests
 */
function markEvent(openingMana = 0, now = Date.now()) {
    // A gap this long is time spent outside combat: bank the stretch before it and open a new one here
    if (firstEventAt !== null && now - lastEventAt > COMBAT_GAP_MS) pauseSpan();
    if (firstEventAt === null) {
        firstEventAt = now;
        baselineMana += openingMana;
    }
    lastEventAt = now;
}

/**
 * Mana spent per minute of observed wall-clock time, from the first counted event to the last, idle gaps
 * between fights included and time the tracker was disabled or the character was out of combat excluded — the rate consumables must sustain.
 * @returns {number|null} Null until a minute has been observed, and while any observed ability has no
 *   stated cost: its casts add no mana, so the known subtotal would understate the spend.
 *   Zero once a minute has been observed with a complete tally and nothing spent
 */
export function manaPerMinuteMeasured() {
    const observedMs = bankedMs + (firstEventAt === null ? 0 : lastEventAt - firstEventAt);
    if (observedMs < MIN_RATE_SPAN_MS) return null;
    const summary = manaSpend();
    if (summary.incomplete) return null;
    const mana = summary.mana - baselineMana;
    // A complete tally over a full span that spent nothing is a real rate: zero, not "still measuring"
    if (!(mana > 0)) return 0;
    return (mana / observedMs) * 60_000;
}

/**
 * Cheapest and maximum MP supply for a target, priced at the current pricing mode.
 *
 * @param {number} targetMpPerMinute - MP per minute the items must supply
 * @returns {{best: Object|null, max: Object|null, candidates: number}} `best` is null when out of reach
 */
export function mpSupplyPlan(targetMpPerMinute) {
    const itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap || {};
    const candidates = buildMpCandidates(itemDetailMap, {
        priceOf: (hrid) => resolveItemPrice(hrid, { context: 'profit', side: 'buy' }).price,
        ...haste,
        maxMana,
    });
    // A character without a maxed pouch may hold a single food: a plan that needs two must not be offered
    const options = slots ? { maxSlots: slots } : {};
    return {
        best: findBestOptimAllocation(candidates, targetMpPerMinute, options),
        max: findMaxMpAllocation(candidates, options),
        candidates: candidates.length,
    };
}

/** @returns {Object} From `manaSummary` */
export function manaSpend() {
    return manaSummary(tally);
}

/**
 * An ability's readable name.
 * @param {string} abilityHrid - The ability
 * @returns {string}
 */
export function abilityLabel(abilityHrid) {
    const detail = dataManager.getInitClientData?.()?.abilityDetailMap?.[abilityHrid];
    if (detail?.name) return detail.name;

    return String(abilityHrid || '')
        .split('/')
        .pop()
        .replace(/_/g, ' ');
}

/**
 * @param {string} abilityHrid - The ability
 * @returns {number} Its mana cost, or 0 when the game has not said
 */
function manaCostOf(abilityHrid) {
    return dataManager.getInitClientData?.()?.abilityDetailMap?.[abilityHrid]?.manaCost || 0;
}

let onNewBattle = null;
let onAbility = null;
let onCharacterSwitching = null;

export default {
    name: 'Mana Tracker',
    initialize: () => {
        // getSetting, not isFeatureEnabled: this key is not in the legacy
        // features map, so the registry's own check always passed and the
        // checkbox did nothing
        if (!config.getSetting('manaTracker')) return;

        // A switch made while disabled reached no handler: what is retained belongs to the previous character
        const currentId = dataManager.getCurrentCharacterId?.();
        if (ownerCharacterId !== null && currentId && currentId !== ownerCharacterId) {
            resetManaTally();
            resetMpPlanner();
            ownerCharacterId = null;
        }

        onNewBattle = (data) => {
            claimState();
            recordFight(tally);
            markEvent();

            const characterId = dataManager.getCurrentCharacterId?.();
            // Id first, then name: a player entry is not guaranteed to carry an id
            const characterName = dataManager.getCurrentCharacterName?.();
            const self = findOwnBattlePlayer(data, { characterId, characterName });
            const stats = self?.combatDetails?.combatStats;
            const max = Number(self?.combatDetails?.maxManapoints);
            if (max > 0) maxMana = max;
            if (stats) {
                haste = { foodHaste: stats.foodHaste || 0, drinkConcentration: stats.drinkConcentration || 0 };
                if (Number.isFinite(stats.foodSlots) && Number.isFinite(stats.drinkSlots)) {
                    slots = { food: stats.foodSlots, drink: stats.drinkSlots };
                }
            }
        };
        onAbility = (data) => {
            // A spectated guild trial's own casts ride this same message,
            // flagged `isGuildBattle` (KikiMeter reads the same flag off it).
            // `new_battle` never fires for a trial being watched, so those
            // casts would add mana with no fight ever recorded to divide it
            // by — inflating Mana/fight and every per-ability share for
            // whoever happens to be spectating one.
            if (data?.isGuildBattle) return;
            claimState();

            // The message carries either the ability object or its hrid, and
            // both shapes have been seen in the wild
            const abilityHrid = data?.ability?.abilityHrid || data?.ability;
            if (typeof abilityHrid !== 'string') return;
            const cost = manaCostOf(abilityHrid);
            recordCast(tally, abilityHrid, cost);
            markEvent(cost);
        };
        // The tally is kept across a settings toggle on purpose — see the
        // module note — but a character switch is a different character's run
        // and not the same one continuing, the same distinction
        // rotation-tracker.js draws on the same event for the same reason.
        // Without this, mana spent by whoever was played before the switch
        // stayed in the total and was shown as this character's.
        onCharacterSwitching = () => {
            resetManaTally();
            // Another character's haste would price this one's items wrongly
            resetMpPlanner();
            ownerCharacterId = null;
        };

        webSocketHook.on('new_battle', onNewBattle);
        webSocketHook.on('battle_consumable_ability_updated', onAbility);
        dataManager.on?.('character_switching', onCharacterSwitching);
    },
    cleanup: () => {
        if (onNewBattle) webSocketHook.off('new_battle', onNewBattle);
        if (onAbility) webSocketHook.off('battle_consumable_ability_updated', onAbility);
        if (onCharacterSwitching) dataManager.off?.('character_switching', onCharacterSwitching);
        onNewBattle = null;
        onAbility = null;
        onCharacterSwitching = null;
        pauseSpan();
    },
};

/**
 * One allocation as panel lines and a total.
 * @param {HTMLElement} card - Card to fill
 * @param {{items: Array<Object>, mpPerMinute: number, costPerHour: number}} allocation
 */
function drawAllocation(card, allocation) {
    for (const item of allocation.items) {
        card.appendChild(
            panelLine(
                item.name,
                `${formatWithSeparator(Math.round(item.mpPerMinute))} MP/min  ·  ${formatWithSeparator(Math.round(item.costPerHour))}/h`,
                ROW_COLORS.gold,
                `${formatWithSeparator(item.mpPerUse)} MP per use, ${item.usesPerMinute.toFixed(2)} uses per minute at ` +
                    `${formatWithSeparator(Math.round(item.price))} each` +
                    (item.alsoHeals ? '. It also heals, so it takes an HP slot type as well.' : '')
            )
        );
    }
    card.appendChild(
        panelLine('Total', `${formatWithSeparator(Math.round(allocation.mpPerMinute))} MP/min`, ROW_COLORS.accent)
    );
    card.appendChild(
        panelLine('Cost', `${formatWithSeparator(Math.round(allocation.costPerHour))}/h`, ROW_COLORS.accent)
    );
}

/**
 * The cheapest mana foods and drinks for a target, and the most the slots allow.
 * @param {HTMLElement} body - Panel body
 */
function drawMpSupply(body) {
    const measured = manaPerMinuteMeasured();
    const target = optimTarget ?? (measured === null ? null : Math.ceil(measured));

    const card = panelCard(body, 'Cheapest MP supply', '#8fd6ff');

    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '3px' });

    const label = document.createElement('span');
    label.textContent = 'Target MP/min';
    label.style.color = 'rgba(232, 236, 245, 0.5)';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.dataset.mpTarget = 'true';
    input.value = target === null ? '' : String(target);
    Object.assign(input.style, {
        width: '80px',
        background: 'rgba(255, 255, 255, 0.08)',
        border: '1px solid rgba(255, 255, 255, 0.10)',
        borderRadius: '3px',
        color: '#e8ecf5',
        padding: '2px 6px',
    });

    const apply = () => {
        const typed = parseFloat(input.value);
        optimTarget = Number.isFinite(typed) && typed >= 0 ? typed : null;
        claimState();
        manaPanel.render();
    };
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') apply();
    });

    const go = document.createElement('button');
    go.textContent = 'Calculate';
    go.dataset.mpCalculate = 'true';
    Object.assign(go.style, {
        background: 'rgba(255, 255, 255, 0.08)',
        border: '1px solid rgba(255, 255, 255, 0.10)',
        borderRadius: '3px',
        color: '#e8ecf5',
        cursor: 'pointer',
        fontSize: '11px',
        padding: '2px 10px',
    });
    go.addEventListener('click', apply);

    controls.append(label, input, go);
    card.appendChild(controls);

    const unknownCosts = measured === null && manaSpend().incomplete;
    if (unknownCosts) {
        card.appendChild(panelNote('Measured spend unavailable: unknown ability costs. Enter a target to plan for.'));
    }
    if (measured !== null) {
        card.appendChild(
            panelLine(
                'Measured spend',
                `${formatWithSeparator(Math.round(measured))} MP/min`,
                ROW_COLORS.accent,
                'Mana spent over the time between the first and last counted cast or fight, idle gaps included.'
            )
        );
    }

    const plan = mpSupplyPlan(target ?? 0);
    if (plan.candidates === 0) {
        card.appendChild(panelNote('No priced mana food or drink to choose from yet. Open the market to load prices.'));
        return;
    }
    if (target === null && !unknownCosts) {
        card.appendChild(panelNote('Enter a target, or fight for a minute so the measured spend can fill it in.'));
    } else if (target === 0) {
        card.appendChild(panelNote('No MP needed: nothing has been spent, so no mana food or drink is required.'));
    } else if (plan.best) {
        drawAllocation(card, plan.best);
    } else {
        card.appendChild(panelNote(`${formatWithSeparator(target)} MP/min is out of reach with the slots available.`));
    }

    if (plan.max && (target === null || !plan.best || plan.max.mpPerMinute > plan.best.mpPerMinute + 1e-9)) {
        const max = panelCard(body, 'Most MP the slots allow', '#8fd6ff');
        drawAllocation(max, plan.max);
    }

    body.appendChild(
        panelNote(
            'Rates assume each item is used every time its cooldown ends, before natural regeneration. ' +
                'Prices follow your pricing mode.'
        )
    );
}

/**
 * What the run has cost in mana, ability by ability.
 *
 * The tile carries one figure; the question behind it is which ability is
 * spending it, because that is the one a rotation change moves.
 */
export const manaPanel = createPanel({
    id: 'manaPanel',
    title: 'Mana',
    size: { width: 400, height: 560 },
    accent: '#8fd6ff',
    draw: (body) => {
        const summary = manaSpend();

        const run = panelCard(body, 'This run', '#8fd6ff');
        run.append(
            panelLine('Fights', formatWithSeparator(summary.fights)),
            panelLine('Mana spent', formatWithSeparator(Math.round(summary.mana)), ROW_COLORS.accent),
            panelLine(
                'Per fight',
                summary.manaPerFight === null ? 'measuring…' : formatWithSeparator(Math.round(summary.manaPerFight)),
                summary.manaPerFight === null ? 'rgba(232, 236, 245, 0.5)' : ROW_COLORS.accent
            ),
            panelLine('Casts per fight', summary.castsPerFight === null ? '—' : summary.castsPerFight.toFixed(2))
        );

        const reset = document.createElement('button');
        reset.textContent = 'Reset';
        reset.dataset.resetMana = 'true';
        Object.assign(reset.style, {
            background: 'rgba(255, 255, 255, 0.08)',
            border: '1px solid rgba(255, 255, 255, 0.10)',
            borderRadius: '3px',
            color: '#e8ecf5',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 10px',
            marginTop: '4px',
            alignSelf: 'flex-start',
        });
        reset.addEventListener('click', () => {
            resetManaTally();
            manaPanel.render();
        });
        run.appendChild(reset);

        drawMpSupply(body);

        if (!summary.abilities.length) {
            body.appendChild(panelNote('Nothing cast yet. Mana is counted from the game announcing a cast.'));
            return;
        }

        const byAbility = panelCard(body, 'Where it goes', '#8fd6ff');
        for (const ability of summary.abilities) {
            const share = summary.mana > 0 ? (ability.mana / summary.mana) * 100 : 0;
            byAbility.appendChild(
                panelLine(
                    abilityLabel(ability.abilityHrid),
                    `${formatWithSeparator(Math.round(ability.mana))}  ·  ${share.toFixed(0)}%`,
                    ability.unknownCost ? ROW_COLORS.bad : ROW_COLORS.gold,
                    ability.unknownCost
                        ? 'The game states no mana cost for this ability, so its casts are counted and its mana is not.'
                        : `${formatWithSeparator(ability.casts)} casts` +
                              (ability.perFight === null ? '' : `, ${ability.perFight.toFixed(2)} per fight`)
                )
            );
        }

        if (summary.incomplete) {
            body.appendChild(
                panelNote(
                    'Some abilities have no stated mana cost, so the total is a lower bound rather than a figure.'
                )
            );
        }
    },
});

registerRow({
    key: 'manaPerFight',
    empty: 'No casts yet',
    name: 'Mana/fight',
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        const summary = manaSpend();
        // Nothing rather than a zero: no fights recorded is not a mana cost of
        // nothing, it is not having watched a fight yet
        if (summary.manaPerFight === null) return blank(container);

        row(container, [
            glyph('mana'),
            { text: `${formatWithSeparator(Math.round(summary.manaPerFight))}/fight`, color: ROW_COLORS.accent },
            { text: `${summary.castsPerFight.toFixed(1)} casts`, color: ROW_COLORS.dim, push: true },
            summary.incomplete ? { text: '⚠', color: ROW_COLORS.bad } : null,
        ]);

        const worst = summary.abilities[0];
        container.title =
            `${formatWithSeparator(Math.round(summary.mana))} mana over ${summary.fights} fights.` +
            (worst ? `\nMost of it on ${abilityLabel(worst.abilityHrid)}.` : '') +
            (summary.incomplete ? '\nSome abilities have no stated mana cost, so the total is a lower bound.' : '') +
            '\nDouble-click for the breakdown by ability.';
    },
    onOpen: () => manaPanel.toggle(),
});
