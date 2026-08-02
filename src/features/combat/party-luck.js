/**
 * Party luck
 *
 * How every member of the party has done against what they were owed.
 *
 * The drop-luck feature answers this for the session as a whole, which is the
 * right question when you are alone and the wrong one in a party: the party
 * shares a zone and a battle count, and nothing else. Drop rate, rare find and
 * drop quantity are each somebody's own gear, so five people fighting the same
 * monsters are owed five different amounts, and a single figure is an average
 * over people who are not comparable.
 *
 * ## One model per player, not one model split five ways
 *
 * MCS computes a base expectation and then multiplies each player's share by
 * their own rate and quantity bonuses. This builds the whole session per player
 * with their own bonuses instead, which comes to the same arithmetic — the
 * bonuses enter the model as multipliers either way — and cannot drift from the
 * single-player model, because it *is* the single-player model.
 *
 * It costs a walk of the drop tables per player. That is microseconds: the
 * expensive part of drop luck is inverting the distribution for a percentile,
 * and none of this does that.
 *
 * ## What is owed is not what is fair
 *
 * A player with no drop gear is owed less and will read as being on par while
 * taking home half of what somebody else does. That is what the figure means and
 * it is the useful meaning — "am I unlucky" is a different question from "am I
 * contributing" — but it is worth saying out loud, so the panel says it.
 *
 * The model is LYuck's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import dataManager from '../../core/data-manager.js';
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { getItemPrice } from '../../utils/market-data.js';
import {
    buildCombatSession,
    expectedItemCounts,
    sessionMean,
    lootValue,
    percentOfExpected,
} from '../../utils/combat-drop-model.js';

/**
 * One price source for the model and the takings alike.
 *
 * A model built at one side of the book and an income counted at the other reads
 * as luck when it is only the spread.
 *
 * @param {string} itemHrid - The item
 * @returns {number|null}
 */
function priceOf(itemHrid) {
    return itemHrid === '/items/coin' ? 1 : getItemPrice(itemHrid, { context: 'profit', side: 'sell' });
}

/**
 * What one player was owed and what they got.
 *
 * @param {Object} input - What it needs
 * @param {Object} input.player - A collector player entry
 * @param {Object} input.actionDetail - The zone
 * @param {Object} input.monsterDetailMap - The game's monsters
 * @param {number} input.battles - Battles fought
 * @param {number} input.difficultyTier - Zone difficulty
 * @param {number} input.partySize - How many are splitting the loot
 * @returns {Object|null} Null when the zone cannot be modelled
 */
function playerLuck({ player, actionDetail, monsterDetailMap, battles, difficultyTier, partySize }) {
    const stats = player?.combatStats || {};
    const bonuses = {
        combatDropRate: stats.combatDropRate || 0,
        combatRareFind: stats.combatRareFind || 0,
        combatDropQuantity: stats.combatDropQuantity || 0,
    };

    const session = buildCombatSession({
        actionDetail,
        monsterDetailMap,
        battles,
        priceOf,
        difficultyTier,
        bonuses,
        partySize,
    });
    if (!session) return null;

    const expectedCounts = expectedItemCounts(session);
    const expectedValue = sessionMean(session);
    const actualValue = lootValue(player.loot || {}, priceOf);

    // Every item either side has seen, so a drop that came and was not owed is a
    // row rather than a silence — those are the interesting ones
    const items = [];
    const hrids = new Set([...Object.keys(player.loot || {}), ...Object.keys(expectedCounts)]);

    for (const key of hrids) {
        const entry = player.loot?.[key];
        const itemHrid = entry?.itemHrid || key;
        const count = entry?.count || 0;
        const expected = expectedCounts[itemHrid] || 0;
        const price = priceOf(itemHrid) || 0;

        if (!count && !expected) continue;
        items.push({
            itemHrid,
            count,
            value: count * price,
            expected,
            expectedValue: expected * price,
            percent: percentOfExpected(count, expected),
        });
    }
    items.sort((a, b) => b.value - a.value);

    return {
        name: player.name,
        isCurrentPlayer: Boolean(player.isCurrentPlayer),
        bonuses,
        actualValue,
        expectedValue,
        percent: percentOfExpected(actualValue, expectedValue),
        items,
    };
}

/**
 * Every player in the party, against what each was owed.
 *
 * @param {Object|null} context - `{actionHrid, difficultyTier, battles}` as
 *   captured off the wire mid-combat
 * @returns {{players: Array<Object>, total: Object|null, battles: number}}
 *   `total` compares the party's takings with the party's expectation, which is
 *   a real figure — unlike an average of the percentages, which weights a
 *   player who looted one item the same as one who looted a hundred
 */
export function partyLuck(context) {
    // Two sources, and both are needed. The zone, the difficulty and the battle
    // count are only on the wire mid-combat and are captured as they go past by
    // the drop-luck feature, which passes them in rather than being imported —
    // it imports this, and a cycle between the two would leave whichever
    // evaluated first holding an undefined. The collector is the only place with
    // each player's own loot and drop stats. Neither alone can answer this.
    const players = combatStatsDataCollector.getLatestData?.()?.players || [];
    const battles = context?.battles || 0;

    const empty = { players: [], total: null, battles };
    if (!context || !players.length || !(battles > 0)) return empty;

    const actionDetail = dataManager.getActionDetails?.(context.actionHrid);
    const monsterDetailMap = dataManager.getInitClientData?.()?.combatMonsterDetailMap;
    if (!actionDetail || !monsterDetailMap) return empty;

    const measured = players
        .map((player) =>
            playerLuck({
                player,
                actionDetail,
                monsterDetailMap,
                battles,
                difficultyTier: context.difficultyTier || 0,
                // The party the model splits loot between is the one that fought,
                // which is the collector's list rather than the context's count
                partySize: players.length,
            })
        )
        .filter(Boolean);

    if (!measured.length) return empty;

    const actualValue = measured.reduce((sum, player) => sum + player.actualValue, 0);
    const expectedValue = measured.reduce((sum, player) => sum + player.expectedValue, 0);

    return {
        players: measured,
        total: { actualValue, expectedValue, percent: percentOfExpected(actualValue, expectedValue) },
        battles,
    };
}
