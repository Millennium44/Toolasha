/**
 * Trigger rows that can never be true.
 *
 * The engine reads a percentage condition (`lowest_hp_percentage`) as the lowest HP fraction among
 * the living units times 100: at most 100 (a unit at full HP), and always above 0 for a living unit.
 * A row such as "Allies' Total Lowest HP % >= 350" can therefore never be met, and the ability behind
 * it is never cast. The sim does not complain, so this module names such rows for the editor and the
 * Results tab. Only rows that are impossible by the engine's own reading are reported; a row that
 * merely needs luck is not.
 */
import { activeRows, describeRow } from './trigger-tuning.js';

const CMP_GTE = '/combat_trigger_comparators/greater_than_equal';
const CMP_LTE = '/combat_trigger_comparators/less_than_equal';
const COND_LOWEST_HP_PCT = '/combat_trigger_conditions/lowest_hp_percentage';

/** Conditions whose reading is a plain count or point total: never below 0 */
const NON_NEGATIVE_CONDITIONS = new Set([
    '/combat_trigger_conditions/number_of_active_units',
    '/combat_trigger_conditions/number_of_dead_units',
    '/combat_trigger_conditions/current_hp',
    '/combat_trigger_conditions/current_mp',
    '/combat_trigger_conditions/missing_hp',
    '/combat_trigger_conditions/missing_mp',
    COND_LOWEST_HP_PCT,
]);

/**
 * Why a trigger row can never be true, or null when it can.
 *
 * - `lowest_hp_percentage >= v` with v above 100: the lowest HP% is at most 100.
 * - `lowest_hp_percentage <= v` with v at or below 0: a living unit always has HP above 0, so its
 *   percentage is above 0.
 * - any count or point reading `<= v` with v below 0: the reading is never negative.
 *
 * Not checked: a threshold above the player's HP or MP pool (buffs can raise the pool mid-fight and
 * the pools are not known where the editor draws), and unit counts above the party size.
 * @param {Object} row - { conditionHrid, comparatorHrid, value }
 * @returns {string|null} Plain-text reason
 */
export function neverFiresReason(row) {
    if (!row) return null;
    const value = Number(row.value) || 0;
    const cmp = row.comparatorHrid;
    if (row.conditionHrid === COND_LOWEST_HP_PCT) {
        if (cmp === CMP_GTE && value > 100) {
            return `Lowest HP % is never above 100, so >= ${value} is never true`;
        }
        if (cmp === CMP_LTE && value <= 0) {
            return `A living unit's HP % is always above 0, so <= ${value} is never true`;
        }
    }
    if (cmp === CMP_LTE && value < 0 && NON_NEGATIVE_CONDITIONS.has(row.conditionHrid)) {
        return `This reading is never below 0, so <= ${value} is never true`;
    }
    return null;
}

/**
 * Every ability, food and drink row of the given players that can never be true. A slot with several
 * rows needs all of them (the engine ANDs them), so one impossible row is enough to block it.
 * @param {Array<Object>} playerDTOs - Player DTOs
 * @param {Object} gameData - Game data payload
 * @param {Object} [playerNames] - hrid to display name
 * @returns {Array<{playerHrid: string, playerName: string, slotType: string, itemHrid: string, itemName: string, rowIndex: number, row: Object, reason: string}>}
 */
export function findNeverFiringRows(playerDTOs, gameData, playerNames = {}) {
    const out = [];
    for (const dto of playerDTOs || []) {
        if (!dto) continue;
        for (const slotType of ['abilities', 'food', 'drinks']) {
            for (const slot of dto[slotType] || []) {
                if (!slot?.hrid) continue;
                const { rows } = activeRows(slot, slotType, gameData);
                const itemName =
                    (slotType === 'abilities'
                        ? gameData?.abilityDetailMap?.[slot.hrid]?.name
                        : gameData?.itemDetailMap?.[slot.hrid]?.name) || String(slot.hrid).split('/').pop();
                rows.forEach((row, rowIndex) => {
                    const reason = neverFiresReason(row);
                    if (!reason) return;
                    out.push({
                        playerHrid: dto.hrid,
                        playerName: playerNames[dto.hrid] || dto.name || dto.hrid,
                        slotType,
                        itemHrid: slot.hrid,
                        itemName,
                        rowIndex,
                        row,
                        reason,
                    });
                });
            }
        }
    }
    return out;
}

const escapeHtml = (text) =>
    String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

/**
 * The never-fires rows as lines for the Results tab's warning box (HTML-safe text).
 * @param {Array<Object>} playerDTOs - Player DTOs as the sim ran them
 * @param {Array<{hrid: string, name: string}>} playerInfo - Player names
 * @param {Object} gameData - Game data payload
 * @returns {Array<string>}
 */
export function neverFiringWarnings(playerDTOs, playerInfo, gameData) {
    const names = {};
    for (const info of playerInfo || []) names[info.hrid] = info.name;
    return findNeverFiringRows(playerDTOs, gameData, names).map((f) => {
        const kind = f.slotType === 'abilities' ? 'ability' : f.slotType === 'food' ? 'food' : 'drink';
        return (
            `${escapeHtml(f.playerName)}: ${escapeHtml(f.itemName)} (${kind}) will never be used. Its trigger ` +
            `"${escapeHtml(describeRow(f.row, gameData, f.row.value))}" can never be true. ${escapeHtml(f.reason)}.`
        );
    });
}
