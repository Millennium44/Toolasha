/**
 * Drop sources
 *
 * Everything a combat zone can drop, and everything a chest can contain.
 *
 * The point is to turn one gesture — "track Pirate Cove" — into the thirty rows
 * that means. Doing it by hand is thirty clicks and a wiki tab; doing it from
 * the game's own data is exact and cannot go stale.
 *
 * ## Three tables, not one
 *
 * An ordinary zone drops from its monsters, and a monster has **two** tables:
 * `dropTable` and `rareDropTable`. They are separate in the game's data because
 * they scale by different stats, and a walk that reads only the first quietly
 * omits precisely the drops anybody would be tracking a zone for.
 *
 * A zone also has **boss spawns** alongside its random ones, whose drops are
 * again the interesting ones.
 *
 * A **dungeon** does not work like either: it pays out of a reward table on
 * completion rather than per monster, so its drops come from `dungeonInfo`
 * instead. Reading a dungeon as an ordinary zone finds nothing at all.
 *
 * Coins are excluded throughout. Everything drops coins, they are not an item
 * anybody tracks, and one row saying "Coin" on every set is noise.
 *
 * The model is NTally's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

const COIN_HRID = '/items/coin';
const COMBAT_ACTION_PREFIX = '/actions/combat/';

/**
 * An item's display name, falling back to something readable.
 *
 * @param {string} itemHrid - e.g. `/items/purples_gift`
 * @param {Object} itemDetailMap - The game's map
 * @returns {string}
 */
function nameOf(itemHrid, itemDetailMap) {
    const known = itemDetailMap?.[itemHrid]?.name;
    if (known) return known;

    return itemHrid.replace('/items/', '').replace(/_/g, ' ');
}

/**
 * Every combat zone the game has, as sets you could track.
 *
 * Read from the action map rather than listed, so a zone added by an update
 * appears without anybody editing a constant — which is what a hardcoded list of
 * fifteen planets guarantees will not happen.
 *
 * @param {Object} actionDetailMap - The game's map
 * @returns {Array<{id: string, hrid: string, name: string, isDungeon: boolean}>}
 */
export function combatZones(actionDetailMap) {
    const zones = [];

    for (const [hrid, action] of Object.entries(actionDetailMap || {})) {
        if (!hrid.startsWith(COMBAT_ACTION_PREFIX) || !action?.combatZoneInfo) continue;

        zones.push({
            // Keyed by hrid, like the chests are, because the id is what gets
            // handed back to look the set's contents up — a short name looks
            // tidier in storage and resolves to nothing in the action map
            id: hrid,
            hrid,
            name: action.name || hrid.slice(COMBAT_ACTION_PREFIX.length).replace(/_/g, ' '),
            isDungeon: Boolean(action.combatZoneInfo.isDungeon),
        });
    }
    return zones.sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0) || a.name.localeCompare(b.name));
}

/**
 * Everything a zone can drop.
 *
 * @param {string} actionHrid - e.g. `/actions/combat/pirate_cove`
 * @param {Object} data - The game's `initClientData`
 * @returns {Array<{hrid: string, name: string}>} Deduplicated, coins excluded
 */
export function zoneDrops(actionHrid, data) {
    const { actionDetailMap, combatMonsterDetailMap, itemDetailMap } = data || {};
    const zone = actionDetailMap?.[actionHrid]?.combatZoneInfo;
    if (!zone) return [];

    const drops = new Map();
    const add = (drop) => {
        const hrid = drop?.itemHrid;
        if (!hrid || hrid === COIN_HRID || drops.has(hrid)) return;
        drops.set(hrid, { hrid, name: nameOf(hrid, itemDetailMap) });
    };

    // A dungeon pays out of a reward table on completion, so its monsters'
    // tables are not where its drops come from
    if (zone.isDungeon) {
        for (const drop of zone.dungeonInfo?.rewardDropTable || []) add(drop);
        return [...drops.values()];
    }

    const fight = zone.fightInfo;
    if (!fight || !combatMonsterDetailMap) return [];

    const addMonster = (monsterHrid) => {
        const monster = combatMonsterDetailMap[monsterHrid];
        if (!monster) return;
        // Both tables: rare is where the reason to track a zone usually lives
        for (const drop of monster.dropTable || []) add(drop);
        for (const drop of monster.rareDropTable || []) add(drop);
    };

    for (const spawn of fight.randomSpawnInfo?.spawns || []) addMonster(spawn.combatMonsterHrid);
    for (const spawn of fight.bossSpawns || []) addMonster(spawn.combatMonsterHrid);

    return [...drops.values()];
}

/**
 * Every item that can be opened, as sets you could track.
 *
 * @param {Object} data - The game's `initClientData`
 * @returns {Array<{id: string, hrid: string, name: string}>}
 */
export function openableItems(data) {
    const { openableLootDropMap, itemDetailMap } = data || {};

    return Object.keys(openableLootDropMap || {})
        .map((hrid) => ({ id: hrid, hrid, name: nameOf(hrid, itemDetailMap) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Everything a chest can contain, and the chest itself.
 *
 * The chest is included because a chest you have not opened is a thing you hold
 * and a thing with a price, and a list of its contents that omits it cannot tell
 * you what the pile is worth.
 *
 * @param {string} chestHrid - e.g. `/items/purples_gift`
 * @param {Object} data - The game's `initClientData`
 * @returns {Array<{hrid: string, name: string}>} Deduplicated, coins excluded
 */
export function openableDrops(chestHrid, data) {
    const { openableLootDropMap, itemDetailMap } = data || {};
    const table = openableLootDropMap?.[chestHrid];
    if (!table) return [];

    const drops = new Map([[chestHrid, { hrid: chestHrid, name: nameOf(chestHrid, itemDetailMap) }]]);

    for (const drop of table) {
        const hrid = drop?.itemHrid;
        if (!hrid || hrid === COIN_HRID || drops.has(hrid)) continue;
        drops.set(hrid, { hrid, name: nameOf(hrid, itemDetailMap) });
    }
    return [...drops.values()];
}
