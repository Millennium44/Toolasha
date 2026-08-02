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

import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { newManaTally, recordCast, recordFight, manaSummary } from '../../utils/mana-spend.js';

/**
 * The running tally, at module scope so the row can read it.
 *
 * Kept across the feature being disabled and re-enabled: a mana figure is only
 * useful over a run, and throwing it away on a settings change would make it
 * impossible to measure a long one.
 */
let tally = newManaTally();

/** Start the count again from here */
export function resetManaTally() {
    tally = newManaTally();
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

export default {
    name: 'Mana Tracker',
    initialize: () => {
        onNewBattle = () => recordFight(tally);
        onAbility = (data) => {
            // The message carries either the ability object or its hrid, and
            // both shapes have been seen in the wild
            const abilityHrid = data?.ability?.abilityHrid || data?.ability;
            if (typeof abilityHrid !== 'string') return;
            recordCast(tally, abilityHrid, manaCostOf(abilityHrid));
        };

        webSocketHook.on('new_battle', onNewBattle);
        webSocketHook.on('battle_consumable_ability_updated', onAbility);
    },
    cleanup: () => {
        if (onNewBattle) webSocketHook.off('new_battle', onNewBattle);
        if (onAbility) webSocketHook.off('battle_consumable_ability_updated', onAbility);
        onNewBattle = null;
        onAbility = null;
    },
};

registerRow({
    key: 'manaPerFight',
    name: 'Mana/fight',
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        const summary = manaSpend();
        // Nothing rather than a zero: no fights recorded is not a mana cost of
        // nothing, it is not having watched a fight yet
        if (summary.manaPerFight === null) return blank(container);

        row(container, [
            { text: '💧', color: ROW_COLORS.dim },
            { text: `${formatWithSeparator(Math.round(summary.manaPerFight))}/fight`, color: ROW_COLORS.accent },
            { text: `${summary.castsPerFight.toFixed(1)} casts`, color: ROW_COLORS.dim, push: true },
            summary.incomplete ? { text: '⚠', color: ROW_COLORS.bad } : null,
        ]);

        const worst = summary.abilities[0];
        container.title =
            `${formatWithSeparator(Math.round(summary.mana))} mana over ${summary.fights} fights.` +
            (worst ? `\nMost of it on ${abilityLabel(worst.abilityHrid)}.` : '') +
            (summary.incomplete ? '\nSome abilities have no stated mana cost, so the total is a lower bound.' : '');
    },
});
