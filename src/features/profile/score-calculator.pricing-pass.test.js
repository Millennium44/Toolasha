/**
 * The profile score's pricing pass on a heavily enhanced loadout.
 *
 * Opening a profile with several +20 pieces froze the page for two long tasks of 13-15 s each: every
 * strategy of every sub-level re-priced the base copy, the material bill and the protection item,
 * each through the resolver and a walk of the whole shop map (test-server sized). These tests run
 * the real pricing chain — enhancement-input-pricing, profit-helpers, market-data, game-lookups —
 * with only the game, the market feed, the settings and the worker stubbed, and pin that each input
 * is priced once per item, that the figures are the ones the old per-strategy pass produced, and
 * that the pass hands the browser a frame between items.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ clientData: null, books: {}, settings: {}, counts: {}, yields: 0 }));

vi.mock('../../utils/ability-cost-calculator.js', () => ({
    explainAbilityCost: () => ({ books: 0, bookPrice: null, total: null }),
}));
vi.mock('../../utils/house-cost-calculator.js', () => ({
    calculateBattleHousesCost: () => ({ totalCost: 0, breakdown: [] }),
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.clientData,
        getItemDetails: (hrid) => mocks.clientData?.itemDetailMap?.[hrid] ?? null,
        getMarketItemValues: () => null,
        getBuffStateVersion: () => 0,
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => mocks.settings[key] ?? null,
        getSettingValue: (key) => mocks.settings[key] ?? null,
        isFeatureEnabled: () => false,
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        getPrice: (hrid, level = 0) => mocks.books[`${hrid}:${level}`] ?? null,
        on: () => {},
        liveSourced: false,
    },
}));
vi.mock('../../utils/game-server.js', () => ({ isTestServer: () => true }));
vi.mock('../../utils/action-context.js', () => ({ resolveActionContext: () => ({ equipment: {}, drinks: [] }) }));
vi.mock('../../features/settings/custom-price-overrides.js', () => ({
    getCustomPrice: () => null,
    getCustomPriceVersion: () => 0,
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => ({ enhancingLevel: 120, toolBonus: 20, speedBonus: 0, teas: { blessed: true } }),
}));
vi.mock('../../utils/enhancement-worker-manager.js', () => ({
    // Deterministic stand-ins for the Markov results: what matters here is that every strategy has one
    calculateEnhancementBatch: async (tasks) =>
        tasks.map((t) => ({
            attempts: 2 ** (t.targetLevel / 3) * (t.protectFrom ? 1 + 1 / t.protectFrom : 2),
            protectionCount: t.protectFrom ? t.targetLevel - t.protectFrom + 1 : 0,
        })),
}));
vi.mock('../../utils/guild-credit-pricing.js', () => ({
    buildGoldPerCredit: () => ({}),
    priceGuildCreditCosts: () => ({ lines: [], total: null, unpriced: [] }),
}));
vi.mock('../../utils/yield-to-browser.js', () => ({
    yieldToBrowser: async () => {
        mocks.yields += 1;
    },
}));
// Counted, not replaced: every price the pass asks for goes through the resolver
vi.mock('../../utils/profit-helpers.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        resolveItemPrice: (...args) => {
            mocks.counts.resolve = (mocks.counts.resolve || 0) + 1;
            return actual.resolveItemPrice(...args);
        },
    };
});

const { calculateCombatScore } = await import('./score-calculator.js');

const COMBAT_SLOTS = ['head', 'body', 'feet', 'hands', 'main_hand', 'off_hand', 'neck', 'ring', 'earrings', 'back'];

/**
 * A heavily enhanced character: ten combat pieces at +15/+20, two skilling tools at +20, a pouch with
 * no requirement (scored in both passes), a +5 piece priced off its own book, and a +14 piece whose
 * material nothing prices. Materials are a mix of book-priced and recipe-priced; the shop is
 * test-server sized.
 */
function buildWorld({ shopEntries = 1500 } = {}) {
    const itemDetailMap = {};
    const actionDetailMap = {};
    const shopItemDetailMap = {};
    mocks.books = {};
    for (let i = 0; i < 40; i++) {
        itemDetailMap[`/items/raw_${i}`] = { hrid: `/items/raw_${i}`, name: `Raw ${i}`, itemLevel: 1 };
        mocks.books[`/items/raw_${i}:0`] = { ask: 100 + i, bid: 90 + i };
    }
    // Enhancing materials with no book of their own: priced by their recipe
    for (let i = 0; i < 6; i++) {
        const hrid = `/items/craft_${i}`;
        itemDetailMap[hrid] = { hrid, name: `Craft ${i}`, itemLevel: 50 };
        actionDetailMap[`/actions/cheesesmithing/craft_${i}`] = {
            hrid: `/actions/cheesesmithing/craft_${i}`,
            type: '/action_types/cheesesmithing',
            inputItems: [
                { itemHrid: `/items/raw_${i}`, count: 3 },
                { itemHrid: `/items/raw_${i + 10}`, count: 2 },
            ],
            outputItems: [{ itemHrid: hrid, count: 1 }],
        };
    }
    itemDetailMap['/items/unlisted_dust'] = { hrid: '/items/unlisted_dust', name: 'Unlisted Dust', itemLevel: 1 };
    itemDetailMap['/items/mirror_of_protection'] = { hrid: '/items/mirror_of_protection', name: 'Mirror' };
    mocks.books['/items/mirror_of_protection:0'] = { ask: 9_000_000, bid: 8_500_000 };
    itemDetailMap['/items/philosophers_mirror'] = { hrid: '/items/philosophers_mirror', name: 'PM' };
    mocks.books['/items/philosophers_mirror:0'] = { ask: 900_000_000, bid: 880_000_000 };

    const wearableItemMap = {};
    const wear = (slot, hrid, enhancementLevel, details) => {
        itemDetailMap[hrid] = { hrid, name: hrid.replace('/items/', ''), itemLevel: 90, ...details };
        mocks.books[`${hrid}:0`] = { ask: 50_000_000, bid: 45_000_000 };
        wearableItemMap[`/item_locations/${slot}`] = {
            itemLocationHrid: `/item_locations/${slot}`,
            itemHrid: hrid,
            enhancementLevel,
        };
    };
    const costs = (i, extra = []) => [
        { itemHrid: `/items/craft_${i % 6}`, count: 4 },
        { itemHrid: `/items/raw_${i}`, count: 30 },
        { itemHrid: '/items/coin', count: 5000 },
        ...extra,
    ];
    COMBAT_SLOTS.forEach((slot, i) => {
        wear(slot, `/items/gear_${slot}`, i < 6 ? 20 : 15, {
            equipmentDetail: { levelRequirements: [{ skillHrid: '/skills/melee', level: 90 }] },
            enhancementCosts: costs(i),
            protectionItemHrids: [`/items/raw_${i + 20}`, `/items/craft_${(i + 1) % 6}`],
        });
    });
    for (const [i, tool] of [
        [10, 'enhancing_tool'],
        [11, 'cheesesmithing_tool'],
    ]) {
        wear(tool, `/items/gear_${tool}`, 20, {
            equipmentDetail: { levelRequirements: [{ skillHrid: '/skills/enhancing', level: 90 }] },
            enhancementCosts: costs(i),
            protectionItemHrids: [`/items/raw_${i + 20}`],
        });
    }
    // No requirement: in the combat and the skiller score both
    wear('pouch', '/items/gear_pouch', 18, { equipmentDetail: {}, enhancementCosts: costs(12) });
    // Priced off its own +5 book, never the worker
    wear('legs', '/items/gear_legs', 5, {
        equipmentDetail: { levelRequirements: [{ skillHrid: '/skills/defense', level: 90 }] },
        enhancementCosts: costs(13),
    });
    mocks.books['/items/gear_legs:5'] = { ask: 70_000_000, bid: 65_000_000 };
    // A material nothing prices: the piece is unpriced, not cheaper
    wear('charm', '/items/gear_charm', 14, {
        equipmentDetail: { levelRequirements: [{ skillHrid: '/skills/attack', level: 90 }] },
        enhancementCosts: costs(14, [{ itemHrid: '/items/unlisted_dust', count: 1 }]),
    });

    // The Tester tab sells most things: a test-server-sized shop
    for (let i = 0; i < shopEntries; i++) {
        shopItemDetailMap[`/shop_items/tester_${i}`] = {
            hrid: `/shop_items/tester_${i}`,
            category: '/shop_categories/tester',
            itemHrid: `/items/filler_${i}`,
            costs: [{ itemHrid: '/items/coin', count: 1000 }],
        };
    }
    mocks.clientData = { itemDetailMap, actionDetailMap, shopItemDetailMap, guildBuffDetailMap: {} };
    return { profile: { wearableItemMap, equippedAbilities: [] } };
}

beforeEach(() => {
    mocks.settings = { networth_highEnhancementUseCost: true, networth_highEnhancementMinLevel: 13 };
    mocks.counts = {};
    mocks.yields = 0;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('profile score pricing pass', () => {
    test('prices each input once per item, not once per strategy and sub-level', async () => {
        const profile = buildWorld();
        const score = await calculateCombatScore(profile);
        expect(score.total).toBeGreaterThan(0);

        // Worker-costed pieces per pass: 10 combat + the pouch, then 2 tools + the pouch. Each prices
        // its base (1), its two non-coin materials (2), its protection options (self, the mirror of
        // protection, up to two listed items, then the pick re-read: 5) and the mirror (1). The old
        // pass repeated base, materials and protection for every strategy: 14,000+ resolves.
        const workerPieces = 14;
        expect(mocks.counts.resolve).toBeLessThanOrEqual(workerPieces * 9 + 20);
    });

    test('scores match the old per-strategy pass to the coin', async () => {
        const score = await calculateCombatScore(buildWorld());

        // Pinned from the per-strategy pass this replaced, on this same world
        expect(score.total).toBe(EXPECTED.total);
        expect(score.skillerTotal).toBe(EXPECTED.skillerTotal);
        expect(score.equipmentUnpriced).toBe(1);
        expect(score.breakdown.equipment.map((row) => [row.slot, row.cost, row.unpriced])).toEqual(EXPECTED.combatRows);
        expect(score.skillerBreakdown.equipment.map((row) => [row.slot, row.cost, row.unpriced])).toEqual(
            EXPECTED.skillerRows
        );
    });

    test('hands the browser a frame between items once a slice runs long', async () => {
        const profile = buildWorld();
        const plain = await calculateCombatScore(profile);
        expect(mocks.yields).toBe(0);

        // A clock that moves 20 ms per reading: every item is past the slice budget
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => (now += 20));
        const sliced = await calculateCombatScore(profile);

        // 13 combat rows + 3 skiller rows; the first item of each pass starts a fresh slice
        expect(mocks.yields).toBeGreaterThanOrEqual(13 + 3 - 2);
        expect(sliced.total).toBe(plain.total);
        expect(sliced.skillerTotal).toBe(plain.skillerTotal);
    });
});

// Filled from a run of the per-strategy pass (HEAD before this change) on buildWorld()
const EXPECTED = {
    total: 629.2802462628872,
    skillerTotal: 153.57352116401674,
    combatRows: [
        ['/item_locations/legs', 70000000, false],
        ['/item_locations/pouch', 51336320, false],
        ['/item_locations/off_hand', 51102060.712651074, false],
        ['/item_locations/main_hand', 51096726.04511646, false],
        ['/item_locations/hands', 51091391.37758185, false],
        ['/item_locations/feet', 51086056.71004724, false],
        ['/item_locations/body', 51080722.042512625, false],
        ['/item_locations/head', 51075387.37497801, false],
        ['/item_locations/back', 50355457, false],
        ['/item_locations/earrings', 50353749.333333336, false],
        ['/item_locations/ring', 50352041.666666664, false],
        ['/item_locations/neck', 50350334, false],
        ['/item_locations/charm', 0, true],
    ],
    skillerRows: [
        ['/item_locations/pouch', 51336320, false],
        ['/item_locations/cheesesmithing_tool', 51121267.91577569, false],
        ['/item_locations/enhancing_tool', 51115933.248241074, false],
    ],
};
