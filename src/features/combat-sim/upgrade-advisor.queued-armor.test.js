/**
 * Queued swaps that meet the generated forced-armor rows in an all-fights run: the queued row is priced the way
 * the generated one is (`labSim_keepReplacedGear`), and a generated pair that is only the queued piece plus
 * pieces already worn is not shown beside it.
 *
 * Runs the real advisor with only the market, the simulator and the armor generator stood in for.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../profile/build-score-row.js', () => ({
    readOwnScore: () => null,
    ensureOwnScore: async () => null,
    ownProfileData: () => null,
    buildFingerprint: () => null,
    scorePricingStamp: () => '',
}));
vi.mock('../profile/score-calculator.js', () => ({ calculateCombatScore: async () => null }));
vi.mock('../../utils/enhancement-input-pricing.js', async () => {
    const { resolveItemPrice } = await import('../../utils/profit-helpers.js');
    const via = (hrid) => {
        const price = resolveItemPrice(hrid, { side: 'buy', enhancementLevel: 0 })?.price;
        return price > 0
            ? { price, unpriced: false, estimated: false }
            : { price: null, unpriced: true, estimated: false };
    };
    return {
        priceMirror: () => via('/items/philosophers_mirror'),
        priceBase: (hrid) => via(hrid),
        priceAtLevel: (hrid) => via(hrid),
        getCheapestProtectionPrice: () => ({ price: null, itemHrid: null }),
        perAttemptMaterialCost: () => ({ cost: 0, hasCost: false, hasMissingPrices: true }),
    };
});

const state = vi.hoisted(() => ({ sim: null, armor: [], keep: true }));

const BACK = '/equipment_types/back';
const BODY = '/equipment_types/body';
const LEGS = '/equipment_types/legs';
const MAIN = '/equipment_types/main_hand';
const SWORD = '/items/cheese_sword';
const OLD_CAPE = '/items/old_cape';
const CAPE = '/items/sinister_cape';
const TOP = '/items/royal_robe_top';
const BOTTOMS = '/items/royal_robe_bottoms';
const OLD_BOTTOMS = '/items/old_robe_bottoms';

const piece = (name, type, level = 80) => ({
    name,
    itemLevel: level,
    equipmentDetail: { type, combatStats: { slashDamage: 0.1 } },
});
const ITEM_DETAIL_MAP = {
    [SWORD]: piece('Cheese Sword', MAIN, 10),
    [OLD_CAPE]: piece('Old Cape', BACK, 90),
    [CAPE]: piece('Sinister Cape', BACK),
    [TOP]: piece('Royal Robe Top', BODY),
    [BOTTOMS]: piece('Royal Robe Bottoms', LEGS),
    [OLD_BOTTOMS]: piece('Old Robe Bottoms', LEGS, 90),
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: ITEM_DETAIL_MAP }),
        getCurrentCharacterId: () => 1,
        getGuildBuildingLevel: () => 0,
        getSkills: () => [],
        get characterData() {
            return { characterAbilities: [] };
        },
    },
}));
vi.mock('./combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,
    buildGameDataPayload: vi.fn(() => ({
        itemDetailMap: ITEM_DETAIL_MAP,
        abilityDetailMap: {},
        actionDetailMap: { '/actions/combat/fly': {} },
    })),
    calculateSimRevenue: vi.fn(),
    getGuildBuffDetailMap: () => ({}),
    guildBuffMaxLevel: () => 0,
    applyGuildBuffLevel: () => [],
}));
vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: vi.fn(),
    runLabyrinthSimulation: vi.fn((params) => state.sim(params)),
    getMaxWorkers: () => 4,
    plannedWorkerCount: vi.fn(() => 1),
}));
vi.mock('./lab-armor-candidates.js', async (importOriginal) => ({
    ...(await importOriginal()),
    generateLabArmorCandidates: () => state.armor.map((candidate) => ({ ...candidate })),
}));
vi.mock('../combat/labyrinth-clear-rate.js', () => ({ default: {} }));
vi.mock('./labyrinth-level-finder.js', () => ({ findMaxLabyrinthLevel: vi.fn(), defaultThreshold: () => 0.7 }));
vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false, testerGearPrice: () => null }));
vi.mock('./direct-enhancement-cost.js', () => ({
    calculateDirectEnhancementCost: () => 0,
    enhancementSweepParams: () => ({}),
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ describeEnhancementSource: () => null }));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => price,
    outputTaxRate: () => 0,
    // Selling pays half of what buying costs, so crediting a resale is a different number from keeping the piece
    resolveItemPrice: vi.fn((_hrid, options) => ({ price: options?.side === 'sell' ? 1_000_000 : 2_000_000 })),
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: vi.fn(() => ({ ask: 5_000_000, bid: 1_000_000 })) }));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));

const advisor = await import('./upgrade-advisor.js');
const { buildQueuedCombatCandidates } = await import('./lab-swap-check.js');
const { default: config } = await import('../../core/config.js');

const gameData = { itemDetailMap: ITEM_DETAIL_MAP, abilityDetailMap: {}, actionDetailMap: {} };
const worn = (hrid, enhancementLevel = 0) => ({ hrid, enhancementLevel });
const dto = (equipment) => ({ equipment: { [MAIN]: worn(SWORD), ...equipment }, abilities: [] });
const fight = (name, equipment) => ({
    monsterHrid: `/monsters/${name}`,
    monsterName: name,
    roomLevel: 50,
    dto: dto(equipment),
    loadoutName: `${name} loadout`,
});
const params = (fights, extra) => ({
    fights,
    crates: [],
    hours: 1,
    precision: null,
    communityBuffs: {},
    labyrinthCombatBuffs: [],
    modes: ['equipment'],
    ...extra,
});
const generatedCape = (removed) => ({
    type: 'cross_slot',
    labArmor: true,
    slot: BACK,
    currentHrid: OLD_CAPE,
    currentLevel: 0,
    upgradeHrid: CAPE,
    upgradeLevel: 0,
    addedSlots: { [BACK]: { hrid: CAPE, enhancementLevel: 0 } },
    clearedSlots: [],
    removedItems: removed,
    description: 'Old Cape → Sinister Cape',
});

const run = async (fights, queue, extra = {}) => {
    const built = queue.length ? buildQueuedCombatCandidates(queue, fights, gameData, true) : null;
    return advisor.runLabyrinthAllFightsAnalysis(
        params(fights, { extraCandidates: built?.candidates || [], ...extra }),
        () => {}
    );
};
const rowsFor = (raw, hrid) => raw.results.filter((row) => row.candidate.upgradeHrid === hrid);

let keepSpy;
beforeEach(() => {
    state.sim = async () => ({ encounters: 600, labyAttemptCount: 1000, experienceGained: {}, simulatedTime: 1 });
    state.armor = [];
    state.keep = true;
    const real = config.getSettingValue.bind(config);
    keepSpy = vi
        .spyOn(config, 'getSettingValue')
        .mockImplementation((key, fallback) => (key === 'labSim_keepReplacedGear' ? state.keep : real(key, fallback)));
});
afterEach(() => keepSpy.mockRestore());

describe('a queued item that is also a generated forced-armor row', () => {
    const fights = () => [fight('mimic', { [BACK]: worn(OLD_CAPE) })];

    test('is priced as the generated row is, with the replaced gear kept', async () => {
        state.armor = [generatedCape([worn(OLD_CAPE)])];
        const generated = rowsFor(await run(fights(), []), CAPE);
        const queued = rowsFor(await run(fights(), [{ hrid: CAPE, level: 0 }]), CAPE);

        expect(generated).toHaveLength(1);
        expect(queued).toHaveLength(1);
        expect(queued[0].candidate.checkedSwap).toBe(true);
        expect(queued[0].cost).toBe(generated[0].cost);
        expect(queued[0].candidate.keptItems).toEqual([worn(OLD_CAPE)]);
        expect(queued[0].candidate.removedItems).toEqual([]);
    });

    test('keeps the resale credit when the setting is off, as the generated row does', async () => {
        state.keep = false;
        state.armor = [generatedCape([worn(OLD_CAPE)])];
        const generated = rowsFor(await run(fights(), []), CAPE);
        const queued = rowsFor(await run(fights(), [{ hrid: CAPE, level: 0 }]), CAPE);

        expect(queued).toHaveLength(1);
        expect(queued[0].cost).toBe(generated[0].cost);
        expect(queued[0].candidate.removedItems).toEqual([worn(OLD_CAPE)]);
        // Crediting the old cape's resale is cheaper than keeping it
        state.keep = true;
        const kept = rowsFor(await run(fights(), [{ hrid: CAPE, level: 0 }]), CAPE);
        expect(kept[0].cost).toBeGreaterThan(queued[0].cost);
    });

    test('a queued item with no generated row keeps the price Check gives it', async () => {
        state.armor = [];
        const queued = rowsFor(await run(fights(), [{ hrid: CAPE, level: 0 }]), CAPE);
        expect(queued).toHaveLength(1);
        expect(queued[0].candidate.removedItems).toEqual([worn(OLD_CAPE)]);
        expect(queued[0].candidate.keptItems).toBeUndefined();
    });

    test('a copy already worn stays free', async () => {
        state.armor = [generatedCape([worn(OLD_CAPE)])];
        const raw = await run(
            [fight('mimic', { [BACK]: worn(OLD_CAPE) }), fight('eye', { [BACK]: worn(CAPE) })],
            [{ hrid: CAPE, level: 0 }]
        );
        const queued = rowsFor(raw, CAPE).filter((row) => row.candidate.checkedSwap);
        expect(queued).toHaveLength(1);
        expect(queued[0].cost).toBe(0);
    });

    test('an empty queue leaves the generated row exactly as it was', async () => {
        state.armor = [generatedCape([worn(OLD_CAPE)])];
        const raw = await run(fights(), []);
        expect(rowsFor(raw, CAPE)[0].candidate.keptItems).toEqual([worn(OLD_CAPE)]);
    });
});
