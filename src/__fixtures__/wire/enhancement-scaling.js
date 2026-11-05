/**
 * The game's enhancement multiplier table and five real items, for tests of how a worn item's
 * noncombat stats scale with its enhancement level.
 *
 * Source: `initClientData` read off the TEST server page (https://test.milkywayidle.com),
 * 2026-11-05. `enhancementLevelTotalBonusMultiplierTable` is NOT a fraction. It counts steps, and the
 * game adds `base + table[level] * noncombatEnhancementBonuses[stat]`; the bonus is 2% of the base
 * times the slot multiplier (5 for neck, back, ring, earrings, trinket, charm). So +10 reads 14.5 and
 * means 29%, +20 reads 50 and means 100%. 3.76.0 fed this table into a fraction formula and every
 * skilling figure went 100x off. Fixtures that invent a gentle table like `[1, 1.02, 1.05]` agree
 * with that kind of code instead of catching it; use this one.
 *
 * Values read off the page: every `noncombatStats` base, the bonuses for foragers_top and
 * celestial_shears, the +10 totals for gatherer_cape_refined and philosophers_necklace, and the
 * guzzling_pouch bonus. A bonus not read off the page is derived as (value at +10 - base) / 14.5 and
 * marked below; nothing else is invented.
 *
 * To refresh after a game patch: on the test server run
 *   const d = localStorageUtil.getInitClientData();
 *   d.enhancementLevelTotalBonusMultiplierTable;
 *   ['foragers_top','celestial_shears','gatherer_cape_refined','philosophers_necklace','guzzling_pouch']
 *     .map(k => d.itemDetailMap['/items/' + k].equipmentDetail);
 * and paste the table, `type`, `noncombatStats` and `noncombatEnhancementBonuses` in. If the table
 * or a base moved, the scaling test in `src/utils/enhancement-scaling-real-data.test.js` says so.
 */

/** `initClientData.enhancementLevelTotalBonusMultiplierTable`, levels 0 to 20 */
export const ENHANCEMENT_TABLE = [
    0, 1, 2.1, 3.3, 4.6, 6, 7.5, 9.1, 10.8, 12.6, 14.5, 16.7, 19.2, 22, 25.1, 28.5, 32.2, 36.2, 40.5, 45.1, 50,
];

/**
 * Item slot for each fixture item: the `itemLocationHrid` the worn-equipment map is keyed by.
 */
export const FIXTURE_LOCATIONS = {
    '/items/foragers_top': '/item_locations/body',
    '/items/celestial_shears': '/item_locations/foraging_tool',
    '/items/gatherer_cape_refined': '/item_locations/back',
    '/items/philosophers_necklace': '/item_locations/neck',
    '/items/guzzling_pouch': '/item_locations/pouch',
};

/** `itemDetailMap` entries, trimmed to the fields the parsers read */
export const FIXTURE_ITEMS = {
    '/items/foragers_top': {
        hrid: '/items/foragers_top',
        name: "Forager's Top",
        equipmentDetail: {
            type: '/equipment_types/body',
            noncombatStats: { foragingEfficiency: 0.1, foragingRareFind: 0.15 },
            noncombatEnhancementBonuses: { foragingEfficiency: 0.002, foragingRareFind: 0.003 },
        },
    },
    '/items/celestial_shears': {
        hrid: '/items/celestial_shears',
        name: 'Celestial Shears',
        equipmentDetail: {
            type: '/equipment_types/foraging_tool',
            noncombatStats: { foragingSpeed: 1.05, foragingExperience: 0.04, foragingRareFind: 0.15 },
            noncombatEnhancementBonuses: { foragingSpeed: 0.021, foragingExperience: 0.0008, foragingRareFind: 0.003 },
        },
    },
    // Bonuses derived: foragingSpeed (0.1421 - 0.058) / 14.5 = 0.0058, foragingExperience
    // (0.0853 - 0.0348) / 14.5 = 0.00348
    '/items/gatherer_cape_refined': {
        hrid: '/items/gatherer_cape_refined',
        name: 'Gatherer Cape (Refined)',
        equipmentDetail: {
            type: '/equipment_types/back',
            noncombatStats: { foragingSpeed: 0.058, foragingExperience: 0.0348 },
            noncombatEnhancementBonuses: { foragingSpeed: 0.0058, foragingExperience: 0.00348 },
        },
    },
    // Bonuses derived from the +10 totals 0.049, 0.098, 0.0735: 0.002, 0.004, 0.003
    '/items/philosophers_necklace': {
        hrid: '/items/philosophers_necklace',
        name: "Philosopher's Necklace",
        equipmentDetail: {
            type: '/equipment_types/neck',
            noncombatStats: { skillingEfficiency: 0.02, skillingSpeed: 0.04, skillingExperience: 0.03 },
            noncombatEnhancementBonuses: { skillingEfficiency: 0.002, skillingSpeed: 0.004, skillingExperience: 0.003 },
        },
    },
    '/items/guzzling_pouch': {
        hrid: '/items/guzzling_pouch',
        name: 'Guzzling Pouch',
        equipmentDetail: {
            type: '/equipment_types/pouch',
            noncombatStats: { drinkConcentration: 0.1 },
            noncombatEnhancementBonuses: { drinkConcentration: 0.002 },
        },
    },
};

/** What the game reports at +10, read off the page, to pin the derived bonuses */
export const READ_OFF_AT_PLUS_10 = {
    '/items/gatherer_cape_refined': { foragingSpeed: 0.1421, foragingExperience: 0.0853 },
    '/items/philosophers_necklace': { skillingEfficiency: 0.049, skillingSpeed: 0.098, skillingExperience: 0.0735 },
};

/**
 * @param {string} itemHrid - One of the fixture items
 * @param {number} level - Enhancement level
 * @returns {Map} A worn-equipment map holding just that item, keyed as the game keys it
 */
export function wornOnly(itemHrid, level) {
    return new Map([
        [
            FIXTURE_LOCATIONS[itemHrid],
            { itemHrid, itemLocationHrid: FIXTURE_LOCATIONS[itemHrid], enhancementLevel: level },
        ],
    ]);
}
