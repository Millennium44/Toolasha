/**
 * Self-enhanced gear in the upgrade advisor: a cape or quiver is priced as an
 * enhance from the copy the ladder picks, never at a market ask.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    /** `characterItems`, inventory and equipped together, as init_character_data sends them */
    items: [],
    /** Enhancement sweeps the advisor asked for */
    sweeps: [],
    /** Extra init_client_data maps (shops) */
    shops: {},
}));

const CAPE = '/items/sinister_cape';
const SWORD = '/items/cheese_sword';
const CHAR = 161296;

// Capes carry no `isTradable` at all; tradables carry `isTradable: true`
const ITEM_DETAIL_MAP = {
    [CAPE]: {
        hrid: CAPE,
        name: 'Sinister Cape',
        equipmentDetail: { type: '/equipment_types/back' },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
    },
    [SWORD]: {
        hrid: SWORD,
        name: 'Cheese Sword',
        isTradable: true,
        equipmentDetail: { type: '/equipment_types/main_hand' },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [...state.items],
        getInitClientData: () => ({ itemDetailMap: ITEM_DETAIL_MAP, ...state.shops }),
        getCurrentCharacterId: () => CHAR,
        getGuildBuildingLevel: () => 0,
        characterData: { characterAbilities: [] },
    },
}));
vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: vi.fn(),
    calculateSimRevenue: vi.fn(),
    getGuildBuffDetailMap: () => ({}),
    guildBuffMaxLevel: () => 0,
    applyGuildBuffLevel: () => [],
}));
vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: vi.fn(),
    runLabyrinthSimulation: vi.fn(),
    getMaxWorkers: () => 4,
    plannedWorkerCount: vi.fn(() => 1),
}));
vi.mock('../combat/labyrinth-clear-rate.js', () => ({ default: {} }));
vi.mock('./labyrinth-level-finder.js', () => ({ findMaxLabyrinthLevel: vi.fn(), defaultThreshold: () => 0.7 }));
vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false, testerGearPrice: () => null }));
// The sweep's own arithmetic has its suite; here it is a price per level stepped
vi.mock('./direct-enhancement-cost.js', () => ({
    calculateDirectEnhancementCost: (itemHrid, from, to) => {
        state.sweeps.push({ itemHrid, from, to });
        return (to - from) * 1_000_000;
    },
    enhancementSweepParams: () => ({}),
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ describeEnhancementSource: () => null }));
vi.mock('../../utils/profit-helpers.js', () => ({
    // A cape base with no listing: the craft estimate the ordinary +0 path returns
    resolveItemPrice: vi.fn((hrid) => ({ price: hrid === CAPE ? 5_000_000 : 2_000_000 })),
}));
vi.mock('../../utils/market-data.js', () => ({
    // Every level of everything has an ask; a cape must never use one
    getItemPrices: vi.fn(() => ({ ask: 999_000_000, bid: 1 })),
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));

const { calculateUpgradeCost, explainUpgradeCost, runLabyrinthUpgradeAnalysis } = await import('./upgrade-advisor.js');
const { buildGameDataPayload } = await import('./combat-sim-adapter.js');
const { runLabyrinthSimulation } = await import('./combat-sim-runner.js');

/** One stack of `characterItems`, in the game's shape */
function stack(itemHrid, level, location = '/item_locations/inventory', count = 1) {
    return {
        id: Math.floor(Math.random() * 1e9),
        characterID: CHAR,
        itemLocationHrid: location,
        itemHrid,
        enhancementLevel: level,
        count,
        hash: `${CHAR}::${location}::${itemHrid}::${level}`,
    };
}

const gameData = { itemDetailMap: ITEM_DETAIL_MAP };
const tier = (itemHrid, level) => ({
    type: 'equipment',
    upgradeHrid: itemHrid,
    upgradeLevel: level,
    // An empty slot: nothing is sold, so the net is the purchase alone
    removedItems: [],
});

describe('self-enhanced upgrade pricing', () => {
    beforeEach(() => {
        state.items = [];
        state.sweeps = [];
        state.shops = {};
    });

    test('best copy at +6 and second at +3: a +5 row ladders the +3 up, never the ask', () => {
        state.items = [stack(CAPE, 6, '/item_locations/back'), stack(CAPE, 3)];

        const candidate = tier(CAPE, 5);
        expect(calculateUpgradeCost(candidate, gameData)).toBe(2_000_000);
        const detail = explainUpgradeCost(candidate, gameData);
        expect(detail.buys[0]).toMatchObject({ price: 2_000_000, source: 'enhance' });
        expect(detail.ladder).toMatchObject({ fromLevel: 3, toLevel: 5, fresh: false, alreadyHeld: false });
        expect(state.sweeps).toContainEqual({ itemHrid: CAPE, from: 3, to: 5 });
    });

    test('a worn +4 with no count field is one copy, not a fresh +0 base', () => {
        const worn = stack(CAPE, 4, '/item_locations/back');
        delete worn.count;
        state.items = [worn];
        const detail = explainUpgradeCost(tier(CAPE, 7), gameData);
        expect(detail.ladder).toMatchObject({ fromLevel: 4, toLevel: 7, fresh: false, isSelf: true });
        expect(detail.net).toBe(3_000_000);
    });

    test('an explicit zero count is still a consumed stack', () => {
        state.items = [stack(CAPE, 4, '/item_locations/inventory', 0)];
        expect(explainUpgradeCost(tier(CAPE, 7), gameData).ladder).toMatchObject({ fresh: true });
    });

    test('best copy at +4: the ladder runs from the +4 itself', () => {
        state.items = [stack(CAPE, 4), stack(CAPE, 1)];
        const detail = explainUpgradeCost(tier(CAPE, 7), gameData);
        expect(detail.ladder).toMatchObject({ fromLevel: 4, toLevel: 7 });
        expect(detail.net).toBe(3_000_000);
    });

    test('no copy held: a fresh +0 base from the ordinary base path, plus the whole enhance', () => {
        const detail = explainUpgradeCost(tier(CAPE, 5), gameData);
        expect(detail.ladder).toMatchObject({ fromLevel: 0, fresh: true, baseCost: 5_000_000 });
        expect(detail.net).toBe(5_000_000 + 5_000_000);
    });

    test('no copy held: a cape sold only for task tokens is priced from the token shop, not the estimate', () => {
        // 10 tokens at an ask of 999M each would be absurd; the token is valued by its own shop's best line
        state.shops = {
            taskShopItemDetailMap: {
                a: { itemHrid: CAPE, costs: [{ itemHrid: '/items/task_token', count: 100 }] },
            },
        };
        const detail = explainUpgradeCost(tier(CAPE, 5), gameData);
        expect(detail.ladder.fresh).toBe(true);
        expect(detail.ladder.baseCost).not.toBe(5_000_000);
        expect(detail.ladder.baseCost).toBe(100 * 999_000_000);
    });

    test('a stack of two +6 copies ladders the second +6, which already meets +5', () => {
        state.items = [stack(CAPE, 6, '/item_locations/inventory', 2)];
        const detail = explainUpgradeCost(tier(CAPE, 5), gameData);
        expect(detail.ladder).toMatchObject({ fromLevel: 6, alreadyHeld: true });
        expect(detail.net).toBe(0);
    });

    test('an enhancement row on a worn +6 cape ladders the spare +3, not the worn one', () => {
        state.items = [stack(CAPE, 6, '/item_locations/back'), stack(CAPE, 3)];
        const candidate = {
            type: 'enhancement',
            currentHrid: CAPE,
            currentLevel: 6,
            upgradeHrid: CAPE,
            upgradeLevel: 7,
        };
        expect(calculateUpgradeCost(candidate, gameData)).toBe(4_000_000);
        const detail = explainUpgradeCost(candidate, gameData);
        expect(detail).toMatchObject({ net: 4_000_000, source: 'enhance', targetAsk: null, enhancementPath: true });
        expect(detail.ladder).toMatchObject({ fromLevel: 3, toLevel: 7 });
    });

    test('another player’s row never reads the live inventory', () => {
        state.items = [stack(CAPE, 4)];
        const candidate = {
            type: 'enhancement',
            currentHrid: CAPE,
            currentLevel: 2,
            upgradeHrid: CAPE,
            upgradeLevel: 4,
        };
        expect(calculateUpgradeCost(candidate, gameData, false)).toBe(2_000_000);
        expect(explainUpgradeCost(candidate, gameData, false).ladder).toMatchObject({ fromLevel: 2 });
    });

    test('a tradable item still prices at its target-level ask', () => {
        state.items = [stack(SWORD, 3)];
        const detail = explainUpgradeCost(tier(SWORD, 5), gameData);
        expect(detail.buys[0]).toMatchObject({ price: 999_000_000, source: 'market' });
        expect(detail.ladder).toBeNull();
        expect(state.sweeps).toEqual([]);
    });
});

describe('lab upgrade analysis prices the selected player, not the logged-in character', () => {
    const CAPE_SLOT = '/equipment_types/back';

    /** A lab run whose one candidate is "+0 -> +5 on the worn cape" for the player at `selfHrid`'s side of the selector */
    async function labCapeRow(selfHrid) {
        buildGameDataPayload.mockReturnValue({ actionDetailMap: {}, itemDetailMap: ITEM_DETAIL_MAP });
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });
        const candidate = {
            type: 'enhancement',
            slot: CAPE_SLOT,
            currentHrid: CAPE,
            currentLevel: 0,
            upgradeHrid: CAPE,
            upgradeLevel: 5,
            removedItems: [{ hrid: CAPE, enhancementLevel: 0 }],
            description: 'Sinister Cape +5',
        };
        const params = {
            playerDTOs: [
                {
                    hrid: 'party-member',
                    equipment: { [CAPE_SLOT]: { hrid: CAPE, enhancementLevel: 0 } },
                    abilities: [],
                    staminaLevel: 50,
                },
            ],
            playerIndex: 0,
            monsterHrid: '/monsters/goblin',
            roomLevel: 100,
            crates: [],
            hours: 1,
            communityBuffs: {},
            labyrinthCombatBuffs: [],
            upgradeMode: 'ability_swap',
            extraCandidates: [candidate],
        };
        if (selfHrid !== undefined) params.selfHrid = selfHrid;
        const { results } = await runLabyrinthUpgradeAnalysis(params, null, {});
        return results.find((r) => r.candidate.type === 'enhancement');
    }

    beforeEach(() => {
        state.items = [stack(CAPE, 4)];
        state.sweeps = [];
    });

    test('a party member is laddered from their worn cape, not the logged-in character’s +4 copy', async () => {
        const row = await labCapeRow('my-character');
        expect(state.sweeps).toContainEqual({ itemHrid: CAPE, from: 0, to: 5 });
        expect(state.sweeps).not.toContainEqual({ itemHrid: CAPE, from: 4, to: 5 });
        expect(row.candidate.cost).toBe(5_000_000);
        expect(row.costDetail.ladder).toMatchObject({ fromLevel: 0, toLevel: 5 });
    });

    test('the logged-in character still ladders from the copy they hold', async () => {
        const row = await labCapeRow('party-member');
        expect(row.candidate.cost).toBe(1_000_000);
        expect(row.costDetail.ladder).toMatchObject({ fromLevel: 4, toLevel: 5 });
    });
});
