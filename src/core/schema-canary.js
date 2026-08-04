/**
 * Schema canary
 *
 * One pass, once, over the static game data the whole script is built on.
 *
 * Almost every module here reaches into `initClientData` by a literal key —
 * `itemDetailMap`, `combatMonsterDetailMap`, `enhancementLevelTotalBonusMultiplierTable`
 * — or by a literal hrid, `/items/philosophers_mirror`, `/buff_types/wisdom`.
 * None of those are a contract. When the game renames one, nothing throws: an
 * optional chain yields `undefined`, a `|| {}` yields an empty map, a lookup
 * yields `null`, and the feature quietly draws nothing. The failure is invisible
 * until a player notices a number that stopped appearing weeks ago.
 *
 * The selector canary in the entrypoint is the same idea one layer up — it
 * catches the game renaming its CSS classes. This catches the game renaming its
 * data. Both report through `UI.healthStatus.reportFailures`, both say "game
 * update?", because that is what both of them mean.
 *
 * Conservative on purpose. Every assertion below is about something a healthy
 * client *always* has, whatever the character has done or which panel is open:
 * a map that is always populated, an item that has existed since launch, a buff
 * type carried by a tea anyone can buy. Nothing here depends on the character's
 * own progress, because a canary that fires for a new account is a canary that
 * gets ignored.
 */

import dataManager from './data-manager.js';

/** The one reason every failure from this pass carries */
export const SCHEMA_REASON = 'data shape changed — game update?';

/**
 * Top-level keys the script indexes into by name, each of which is populated on
 * every client. A missing one is not a degraded feature, it is a whole category
 * of them: no `itemDetailMap` and every price, tooltip and profit figure in the
 * script is reading from `{}`.
 *
 * Kept to maps whose absence would be unambiguous. Anything that is legitimately
 * empty for some accounts does not belong here.
 */
export const REQUIRED_MAPS = [
    ['itemDetailMap', 'Item details'],
    ['actionDetailMap', 'Action details'],
    ['abilityDetailMap', 'Ability details'],
    ['combatMonsterDetailMap', 'Monster details'],
    ['houseRoomDetailMap', 'House room details'],
    ['guildBuffDetailMap', 'Guild buff details'],
    ['taskShopItemDetailMap', 'Task shop items'],
    ['communityBuffTypeDetailMap', 'Community buff types'],
    ['enhancementLevelTotalBonusMultiplierTable', 'Enhancement multiplier table'],
    ['levelExperienceTable', 'Level/experience table'],
];

/**
 * Item hrids written into this script as literals.
 *
 * Every one is bought, dropped or spent by an ordinary account and has existed
 * for as long as the feature that names it — a renamed one is a feature that has
 * silently stopped working, not a player who has not got there yet.
 */
export const SAMPLE_ITEM_HRIDS = [
    '/items/coin',
    '/items/cowbell',
    '/items/bag_of_10_cowbells',
    '/items/philosophers_mirror',
    '/items/blessed_tea',
    '/items/chimerical_chest',
];

/**
 * Buff type hrids the script matches on by string.
 *
 * Only the six carried by teas, because teas are where this pass can prove a
 * buff type still resolves: their `consumableDetail.buffs` is part of
 * `itemDetailMap`, so the check is a lookup rather than an assumption. Buff
 * types that only ever arrive on equipment or from a house room are deliberately
 * left out — not because they matter less, but because there is no reading of
 * them here that could not produce a false alarm.
 */
export const SAMPLE_BUFF_TYPE_HRIDS = [
    '/buff_types/wisdom',
    '/buff_types/efficiency',
    '/buff_types/gathering',
    '/buff_types/artisan',
    '/buff_types/gourmet',
    '/buff_types/processing',
];

/**
 * The wave counts `dungeon-tracker-storage.js` falls back to when the game data
 * does not carry one.
 *
 * A fallback is only ever right by accident: it was copied from the game once.
 * When the game *does* supply `maxWaves` and it disagrees with what was copied,
 * every run recorded on a client where the game did not supply it has been
 * measured against the wrong finish line. That is worth a word, and it is
 * checkable here for free.
 */
export const DUNGEON_WAVE_FALLBACKS = {
    '/actions/combat/chimerical_den': 50,
    '/actions/combat/sinister_circus': 60,
    '/actions/combat/enchanted_fortress': 65,
    '/actions/combat/pirate_cove': 65,
};

/**
 * Is this a populated map or table?
 * @param {*} value - Candidate
 * @returns {boolean} True when it holds at least one entry
 */
function isPopulated(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (!value || typeof value !== 'object') return false;
    for (const _key in value) return true;
    return false;
}

/**
 * A failure in the shape the health status panel reads.
 * @param {string} key - Stable identifier, shown beside the reason
 * @param {string} name - What is wrong, in a few words
 * @returns {{key: string, name: string, reason: string}} Failure record
 */
function failure(key, name) {
    return { key, name, reason: SCHEMA_REASON };
}

/**
 * Every buff type hrid this client data mentions anywhere the script reads them.
 *
 * One pass over the three places a `typeHrid` appears, collected into a set, so
 * the sample below is a set membership rather than six separate searches.
 *
 * @param {Object} clientData - `initClientData`
 * @returns {Set<string>} Buff type hrids in use
 */
export function collectBuffTypeHrids(clientData) {
    const found = new Set();

    const take = (buffs) => {
        if (!Array.isArray(buffs)) return;
        for (const buff of buffs) {
            if (typeof buff?.typeHrid === 'string') found.add(buff.typeHrid);
        }
    };

    for (const item of Object.values(clientData?.itemDetailMap || {})) {
        take(item?.consumableDetail?.buffs);
    }
    for (const room of Object.values(clientData?.houseRoomDetailMap || {})) {
        take(room?.actionBuffs);
        take(room?.globalBuffs);
    }
    for (const guildBuff of Object.values(clientData?.guildBuffDetailMap || {})) {
        if (typeof guildBuff?.buff?.typeHrid === 'string') found.add(guildBuff.buff.typeHrid);
    }

    return found;
}

/**
 * Assert the structural promises this script makes about the game's own data.
 *
 * Returns an empty list — not a failure — when there is no client data at all.
 * "It has not arrived yet" and "it has gone away" look identical from here, and
 * of the two only one is worth interrupting a player about, so neither is.
 *
 * @param {Object|null} clientData - `initClientData` from the websocket or localStorage
 * @returns {Array<{key: string, name: string, reason: string}>} Failures, empty when healthy
 */
export function checkClientDataShape(clientData) {
    if (!clientData || typeof clientData !== 'object') return [];

    const failures = [];

    for (const [key, label] of REQUIRED_MAPS) {
        if (!isPopulated(clientData[key])) failures.push(failure(`schema:${key}`, `${label} (${key}) is missing`));
    }

    // The item checks below read this map, so a missing one would report six
    // absent items instead of the one thing that is actually wrong
    const items = clientData.itemDetailMap;
    if (isPopulated(items)) {
        for (const hrid of SAMPLE_ITEM_HRIDS) {
            if (!items[hrid]) failures.push(failure(`schema:item:${hrid}`, `${hrid} is no longer an item`));
        }

        const buffTypes = collectBuffTypeHrids(clientData);
        for (const hrid of SAMPLE_BUFF_TYPE_HRIDS) {
            if (!buffTypes.has(hrid)) failures.push(failure(`schema:buff:${hrid}`, `${hrid} is no longer a buff type`));
        }
    }

    const actions = clientData.actionDetailMap;
    if (isPopulated(actions)) {
        for (const [hrid, fallbackWaves] of Object.entries(DUNGEON_WAVE_FALLBACKS)) {
            const action = actions[hrid];
            if (!action) {
                failures.push(failure(`schema:dungeon:${hrid}`, `${hrid} is no longer an action`));
                continue;
            }

            const maxWaves = action.combatZoneInfo?.dungeonInfo?.maxWaves;
            // Absent is the case the fallback exists for, and says nothing about
            // whether the fallback is right — only a supplied count can do that
            if (!Number.isFinite(maxWaves) || maxWaves <= 0) continue;
            if (maxWaves !== fallbackWaves) {
                failures.push(
                    failure(
                        `schema:dungeon:${hrid}`,
                        `${hrid} has ${maxWaves} waves, the script falls back to ${fallbackWaves}`
                    )
                );
            }
        }
    }

    return failures;
}

/**
 * Run the pass against whatever client data this session loaded.
 * @returns {Array<{key: string, name: string, reason: string}>} Failures, empty when healthy
 */
export function runSchemaCanary() {
    try {
        return checkClientDataShape(dataManager.getInitClientData());
    } catch (error) {
        // A canary that can throw is a canary that can break startup
        console.error('[SchemaCanary] The shape check itself failed:', error);
        return [];
    }
}

export default { SCHEMA_REASON, checkClientDataShape, collectBuffTypeHrids, runSchemaCanary };
