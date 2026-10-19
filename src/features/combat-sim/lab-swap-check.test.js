/**
 * Check a swap: the candidates a hand-picked swap becomes, who they reach, and
 * what they cost.
 *
 * The point of the feature is that a checked swap behaves exactly like a
 * generated row for the same target, so these tests run the real advisor
 * (`generateCandidates`, `calculateUpgradeCost`, `candidateAppliesToDTO`,
 * `applyCandidateToDTO`) and compare against it, with only the market and the
 * enhancing sweep stood in for.
 */

import { describe, test, expect, vi, beforeEach, beforeAll } from 'vitest';

// The advisor's mirror and base prices go through the shared enhancement input rule; here they read the
// same mocked resolver every other price in this file does, so each test keeps saying what they cost
vi.mock('../../utils/enhancement-input-pricing.js', async () => {
    const { resolveItemPrice } = await import('../../utils/profit-helpers.js');
    const { getItemPrices } = await import('../../utils/market-data.js');
    const via = (hrid) => {
        const price = resolveItemPrice(hrid, { side: 'buy', enhancementLevel: 0 })?.price;
        return price > 0
            ? { price, unpriced: false, estimated: false }
            : { price: null, unpriced: true, estimated: false };
    };
    return {
        priceMirror: () => via('/items/philosophers_mirror'),
        priceBase: (hrid) => via(hrid),
        priceAtLevel: (hrid, level) => {
            if (!(level > 0)) return via(hrid);
            const ask = getItemPrices(hrid, level)?.ask;
            return ask > 0
                ? { price: ask, unpriced: false, estimated: false }
                : { price: null, unpriced: true, estimated: false };
        },
        getCheapestProtectionPrice: () => ({ price: null, itemHrid: null }),
        perAttemptMaterialCost: () => ({ cost: 0, hasCost: false, hasMissingPrices: true }),
    };
});

const state = vi.hoisted(() => ({ items: [] }));

const CAPE = '/items/sinister_cape';
const QUIVER = '/items/chimerical_quiver';
const SWORD = '/items/cheese_sword';
const MACE = '/items/cheese_mace';
const STAFF = '/items/holy_staff';
const BOW = '/items/cheese_bow';
const MILKING_TOOL = '/items/celestial_milking_tool';
const CHISEL = '/items/celestial_crafting_tool';
const CHAR = 161296;

// Real equipment types: a cape is `/equipment_types/back`, never `back`
const BACK = '/equipment_types/back';
const MAIN = '/equipment_types/main_hand';
const TWO = '/equipment_types/two_hand';

const ITEM_DETAIL_MAP = {
    [CAPE]: {
        hrid: CAPE,
        name: 'Sinister Cape',
        itemLevel: 80,
        equipmentDetail: { type: BACK, combatStats: { slashDamage: 0.1, stabDamage: 0.1, smashDamage: 0.1 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
    },
    [QUIVER]: {
        hrid: QUIVER,
        name: 'Chimerical Quiver',
        itemLevel: 80,
        equipmentDetail: {
            type: BACK,
            combatStats: { criticalRate: 0.05, rangedDamage: 0.1, rangedAccuracy: 0.1, evasions: 0.1 },
        },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
    },
    [SWORD]: {
        hrid: SWORD,
        name: 'Cheese Sword',
        isTradable: true,
        itemLevel: 10,
        equipmentDetail: { type: MAIN, combatStats: { slashDamage: 20 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
    [MACE]: {
        hrid: MACE,
        name: 'Cheese Mace',
        isTradable: true,
        itemLevel: 10,
        equipmentDetail: { type: MAIN, combatStats: { smashDamage: 20 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
    [STAFF]: {
        hrid: STAFF,
        name: 'Holy Staff',
        isTradable: true,
        itemLevel: 10,
        equipmentDetail: { type: TWO, combatStats: { magicDamage: 30 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
    [BOW]: {
        hrid: BOW,
        name: 'Cheese Bow',
        isTradable: true,
        itemLevel: 10,
        equipmentDetail: { type: TWO, combatStats: { rangedDamage: 30 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
    [MILKING_TOOL]: {
        hrid: MILKING_TOOL,
        name: 'Celestial Milking Tool',
        isTradable: true,
        itemLevel: 90,
        equipmentDetail: { type: '/equipment_types/milking_tool', noncombatStats: { milkingSpeed: 0.5 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 100 }],
    },
    [CHISEL]: {
        hrid: CHISEL,
        name: 'Celestial Crafting Tool',
        isTradable: true,
        itemLevel: 90,
        equipmentDetail: { type: '/equipment_types/crafting_tool', noncombatStats: { craftingSpeed: 0.5 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 100 }],
    },
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [...state.items],
        getInitClientData: () => ({ itemDetailMap: ITEM_DETAIL_MAP }),
        getCurrentCharacterId: () => CHAR,
        getGuildBuildingLevel: () => 0,
        getSkills: () => [],
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
vi.mock('./direct-enhancement-cost.js', () => ({
    calculateDirectEnhancementCost: (_itemHrid, from, to) => (to - from) * 1_000_000,
    enhancementSweepParams: () => ({}),
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ describeEnhancementSource: () => null }));
vi.mock('../../utils/profit-helpers.js', () => ({
    // Untaxed, as for an Iron Cow character: this suite is about which route a row is priced by, and its
    // figures are gross. The market sell tax on a resale is tested in upgrade-advisor.test.js
    calculatePriceAfterTax: (price) => price,
    outputTaxRate: () => 0,

    resolveItemPrice: vi.fn(() => ({ price: 2_000_000 })),
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: vi.fn(() => ({ ask: 50_000_000, bid: 10_000_000 })),
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));

const advisor = await import('./upgrade-advisor.js');
const {
    MAX_QUEUED_SWAPS,
    buildCombatSwapCandidate,
    buildSkillingSwapCandidate,
    checkedSwapKey,
    clampSwapLevel,
    describeCheckedSwap,
    evaluateSkillingSwaps,
    resolveEquipmentHrid,
    sanitizeSwapOptions,
    sanitizeSwapQueues,
    searchEquipmentItems,
    groupFightsByLoadout,
} = await import('./lab-swap-check.js');
const { applySkillingCandidate } = await import('./lab-skilling-goals.js');

const gameData = { itemDetailMap: ITEM_DETAIL_MAP, actionDetailMap: {} };
const wearing = (equipment) => ({ equipment, abilities: [] });
const piece = (hrid, enhancementLevel = 0) => ({ hrid, enhancementLevel });

beforeEach(() => {
    state.items = [];
});

describe('groupFightsByLoadout', () => {
    test('fights share a saved loadout, worn gear is one group, and a fight that says nothing stands alone', () => {
        const baseline = { fights: [{}, {}, {}, {}, {}] };
        const contextFights = [{ loadoutId: 7 }, { loadoutId: 0 }, { loadoutId: 7 }, {}, { loadoutId: null }];
        const groups = groupFightsByLoadout(baseline, contextFights);
        expect([...groups.entries()]).toEqual([
            ['loadout:7', [0, 2]],
            ['current-gear', [1]],
            ['fight:3', [3]],
            ['fight:4', [4]],
        ]);
    });
});

describe('picking an item', () => {
    test('a name resolves to its item, exactly or when it is the only match', () => {
        expect(resolveEquipmentHrid(gameData, 'Sinister Cape')).toBe(CAPE);
        expect(resolveEquipmentHrid(gameData, 'sinister')).toBe(CAPE);
        expect(resolveEquipmentHrid(gameData, CAPE)).toBe(CAPE);
    });

    test('text matching several items, or none, resolves to nothing', () => {
        expect(resolveEquipmentHrid(gameData, 'cheese')).toBeNull();
        expect(resolveEquipmentHrid(gameData, 'nonsense')).toBeNull();
        expect(resolveEquipmentHrid(gameData, '')).toBeNull();
    });

    test('the search lists names that start with the text before ones that only contain it', () => {
        const names = searchEquipmentItems(gameData, 'ce').map((item) => item.name);
        expect(names.slice(0, 2)).toEqual(['Celestial Crafting Tool', 'Celestial Milking Tool']);
        expect(searchEquipmentItems(gameData, 'cape').map((item) => item.name)).toEqual(['Sinister Cape']);
    });
});

describe('the remembered queue', () => {
    test('survives a round trip and is brought back into shape', () => {
        const queues = sanitizeSwapQueues({
            combat: [
                { hrid: CAPE, level: 7 },
                { hrid: CAPE, level: 7 },
                { hrid: QUIVER, level: 99 },
                { hrid: 'cape', level: 3 },
                null,
            ],
            skilling: 'garbage',
        });
        expect(queues.combat).toEqual([
            { hrid: CAPE, level: 7 },
            { hrid: QUIVER, level: 20 },
        ]);
        expect(queues.skilling).toEqual([]);
        expect(sanitizeSwapQueues(JSON.parse(JSON.stringify(queues)))).toEqual(queues);
    });

    test('is capped, and levels are whole numbers in range', () => {
        const many = Array.from({ length: MAX_QUEUED_SWAPS + 5 }, (_, i) => ({ hrid: `/items/item_${i}`, level: 1 }));
        expect(sanitizeSwapQueues({ combat: many }).combat).toHaveLength(MAX_QUEUED_SWAPS);
        expect(clampSwapLevel('7.9')).toBe(7);
        expect(clampSwapLevel(-3)).toBe(0);
        expect(clampSwapLevel('')).toBe(0);
        expect(clampSwapLevel(40)).toBe(20);
    });

    test('a chip reads as the item and its level', () => {
        expect(describeCheckedSwap({ hrid: CAPE, level: 7 }, gameData)).toBe('Sinister Cape +7');
        expect(checkedSwapKey({ hrid: CAPE, level: 7 })).toBe(`${CAPE}@7`);
    });
});

describe('combat: who a checked swap reaches', () => {
    test('a cape goes in every loadout that has the slot to use, and not where it is already that high', () => {
        const wornLow = wearing({ [BACK]: piece(CAPE, 5) });
        const bare = wearing({ [MAIN]: piece(SWORD) });
        const wornHigh = wearing({ [BACK]: piece(CAPE, 7) });
        const otherCape = wearing({ [BACK]: piece('/items/other_cape', 3) });
        ITEM_DETAIL_MAP['/items/other_cape'] = {
            hrid: '/items/other_cape',
            name: 'Other Cape',
            equipmentDetail: { type: BACK, combatStats: { slashDamage: 0.05 } },
        };

        const candidate = buildCombatSwapCandidate(
            { hrid: CAPE, level: 7 },
            [wornLow, bare, wornHigh, otherCape],
            gameData
        );
        const reached = [wornLow, bare, wornHigh, otherCape].map((dto) =>
            advisor.candidateAppliesToDTO(candidate, dto, gameData)
        );

        expect(reached).toEqual([true, true, false, true]);
        expect(candidate.reach).toBe(3);
        expect(candidate.slot).toBe(BACK);

        // Applied, it lands in the slot of the loadouts it reaches and nowhere else
        const after = advisor.applyCandidateToDTO(wornLow, candidate);
        expect(after.equipment[BACK]).toEqual({ hrid: CAPE, enhancementLevel: 7 });
        expect(after.equipment[MAIN]).toBeUndefined();
        expect(wornLow.equipment[BACK].enhancementLevel).toBe(5);
        delete ITEM_DETAIL_MAP['/items/other_cape'];
    });

    test('hand slots keep their rules: a two-hander does not go beside a main hand, nor a sword in a staff loadout', () => {
        const swordLoadout = wearing({ [MAIN]: piece(MACE, 3) });
        const staffLoadout = wearing({ [TWO]: piece(STAFF, 3) });
        const bowLoadout = wearing({ [TWO]: piece(BOW, 3) });
        const loadouts = [swordLoadout, staffLoadout, bowLoadout];

        const sword = buildCombatSwapCandidate({ hrid: SWORD, level: 5 }, loadouts, gameData);
        // Mace to sword is a melee-for-melee swap; a two-hander loadout has no main hand to put it in
        expect(loadouts.map((dto) => advisor.candidateAppliesToDTO(sword, dto, gameData))).toEqual([
            true,
            false,
            false,
        ]);

        const bow = buildCombatSwapCandidate({ hrid: BOW, level: 5 }, loadouts, gameData);
        // A bow replaces a bow; it is not a staff and it cannot sit beside a main hand
        expect(loadouts.map((dto) => advisor.candidateAppliesToDTO(bow, dto, gameData))).toEqual([false, false, true]);
    });

    test('a quiver is for the loadouts that fight with ranged, not the melee ones', () => {
        const ranged = wearing({ [TWO]: piece(BOW, 3), [BACK]: piece(CAPE, 5) });
        const melee = wearing({ [MAIN]: piece(SWORD, 3), [BACK]: piece(CAPE, 5) });
        // Both wear a melee cape today; it is the weapon that decides
        const quiver = buildCombatSwapCandidate({ hrid: QUIVER, level: 5 }, [ranged, melee], gameData);
        expect([ranged, melee].map((dto) => advisor.candidateAppliesToDTO(quiver, dto, gameData))).toEqual([
            true,
            false,
        ]);
        expect(quiver.reach).toBe(1);
    });

    describe('relevance by the item own offensive stats (live shapes)', () => {
        const HEAD = '/equipment_types/head';
        const HAT = '/items/magicians_hat';
        const HELMET = '/items/corsair_helmet_refined';
        const PLAIN = '/items/plain_hood';
        beforeAll(() => {
            ITEM_DETAIL_MAP[HAT] = {
                hrid: HAT,
                name: 'Magician Hat',
                equipmentDetail: {
                    type: HEAD,
                    combatStats: {
                        abilityDamage: 0.1,
                        abilityHaste: 5,
                        magicAccuracy: 0.05,
                        magicDamage: 0.05,
                        evasions: 1,
                    },
                },
            };
            ITEM_DETAIL_MAP[HELMET] = {
                hrid: HELMET,
                name: 'Corsair Helmet',
                equipmentDetail: { type: HEAD, combatStats: { slashDamage: 0.1 } },
            };
            ITEM_DETAIL_MAP[PLAIN] = {
                hrid: PLAIN,
                name: 'Plain Hood',
                equipmentDetail: { type: HEAD, combatStats: { armor: 3, stabEvasion: 3 } },
            };
        });
        const melee = () => wearing({ [HEAD]: piece(HELMET, 20), [MAIN]: piece(SWORD, 20), [BACK]: piece(CAPE, 5) });
        const ranged = () => wearing({ [TWO]: piece(BOW, 3), [BACK]: piece(CAPE, 5) });
        const magic = () => wearing({ [TWO]: piece(STAFF, 3) });
        const reach = (hrid, dtos, options) =>
            dtos.map((dto) =>
                advisor.candidateAppliesToDTO(
                    buildCombatSwapCandidate({ hrid, level: 10 }, dtos, gameData, true, options),
                    dto,
                    gameData
                )
            );

        test('a Magician Hat is not in a melee loadout by default, and is with All loadouts on', () => {
            const loadouts = [melee(), magic(), ranged()];
            expect(reach(HAT, loadouts)).toEqual([false, true, false]);
            expect(buildCombatSwapCandidate({ hrid: HAT, level: 10 }, [melee()], gameData).reach).toBe(0);

            const forced = buildCombatSwapCandidate({ hrid: HAT, level: 10 }, [melee()], gameData, true, {
                allLoadouts: true,
            });
            expect(forced.reach).toBe(1);
            // A downgrade, shown because it was asked for
            expect(advisor.applyCandidateToDTO(melee(), forced).equipment[HEAD]).toEqual({
                hrid: HAT,
                enhancementLevel: 10,
            });
        });

        test('a quiver is ranged, a Sinister Cape is melee, armor with no style stats goes everywhere', () => {
            const loadouts = [melee(), magic(), ranged()];
            expect(reach(QUIVER, loadouts)).toEqual([false, false, true]);
            // The ranged loadout already wears the cape, and enhancing a worn piece is always in order
            expect(reach(CAPE, loadouts)).toEqual([true, false, true]);
            expect(reach(PLAIN, loadouts)).toEqual([true, true, true]);
        });

        test('a two-hander needs both hands free: an occupied off hand is a conflict too', () => {
            const OFF = '/equipment_types/off_hand';
            ITEM_DETAIL_MAP['/items/cheese_shield'] = {
                hrid: '/items/cheese_shield',
                name: 'Cheese Shield',
                equipmentDetail: { type: OFF, combatStats: { armor: 5 } },
            };
            const shieldOnly = wearing({ [OFF]: piece('/items/cheese_shield', 3) });
            const mainOnly = wearing({ [MAIN]: piece(SWORD, 3) });
            const bare = wearing({});
            const dtos = [shieldOnly, mainOnly, bare];
            expect(reach(STAFF, dtos)).toEqual([false, false, true]);
            expect(reach(STAFF, dtos, { allLoadouts: true })).toEqual([false, false, true]);
        });

        test('an all-style piece (Philosopher Necklace) reaches ranged and magic loadouts with the override off', () => {
            const NECK = '/equipment_types/neck';
            const allStyles = {
                stabDamage: 0.05,
                slashDamage: 0.05,
                smashDamage: 0.05,
                rangedDamage: 0.05,
                magicDamage: 0.05,
            };
            ITEM_DETAIL_MAP['/items/philosophers_necklace'] = {
                hrid: '/items/philosophers_necklace',
                name: 'Philosopher Necklace',
                equipmentDetail: { type: NECK, combatStats: { ...allStyles, rangedAccuracy: 0.05 } },
            };
            // The same stats on a piece that is not exempt by name: reached through the family set
            ITEM_DETAIL_MAP['/items/all_style_ring'] = {
                hrid: '/items/all_style_ring',
                name: 'All Style Ring',
                equipmentDetail: { type: '/equipment_types/ring', combatStats: allStyles },
            };
            const loadouts = [melee(), ranged(), magic()];
            expect(reach('/items/philosophers_necklace', loadouts)).toEqual([true, true, true]);
            expect(reach('/items/all_style_ring', loadouts)).toEqual([true, true, true]);
            // A trace of another style is noise, not a second style
            ITEM_DETAIL_MAP['/items/mostly_melee_ring'] = {
                hrid: '/items/mostly_melee_ring',
                name: 'Mostly Melee Ring',
                equipmentDetail: { type: '/equipment_types/ring', combatStats: { slashDamage: 1, rangedDamage: 0.01 } },
            };
            expect(reach('/items/mostly_melee_ring', loadouts)).toEqual([true, false, false]);
        });

        test('All loadouts does not override the hand rules or an item with no combat stats', () => {
            const bowLoadout = wearing({ [TWO]: piece(BOW, 3) });
            const options = { allLoadouts: true };
            expect(
                buildCombatSwapCandidate({ hrid: SWORD, level: 3 }, [bowLoadout], gameData, true, options).reach
            ).toBe(0);
            expect(
                buildCombatSwapCandidate({ hrid: MILKING_TOOL, level: 3 }, [melee()], gameData, true, options).reach
            ).toBe(0);
        });

        test('a higher level of a worn non-combat tool is still in no loadout', () => {
            // The same-item shortcut used to skip the combat-stats check
            const tool = '/equipment_types/milking_tool';
            const wearingTool = wearing({ [tool]: piece(MILKING_TOOL, 3) });
            const candidate = buildCombatSwapCandidate({ hrid: MILKING_TOOL, level: 10 }, [wearingTool], gameData);
            expect(candidate.reach).toBe(0);
            expect(advisor.candidateAppliesToDTO(candidate, wearingTool, gameData)).toBe(false);
        });
    });

    describe('a copy already worn at the target level is owned', () => {
        test('combat: priced at nothing when another loadout wears it that high', () => {
            const low = wearing({ [BACK]: piece(CAPE, 5) });
            const high = wearing({ [BACK]: piece(CAPE, 7) });
            const alone = buildCombatSwapCandidate({ hrid: CAPE, level: 7 }, [low], gameData);
            const withOwned = buildCombatSwapCandidate({ hrid: CAPE, level: 7 }, [low, high], gameData);

            expect(alone.cost).toBeGreaterThan(0);
            expect(withOwned.cost).toBe(0);
            expect(withOwned.pricingNote).toContain('already wear a copy');
            // It is still only applied where it is needed
            expect(withOwned.reach).toBe(1);
            // Nothing to buy: the row offers no acquisition actions, a bought one does
            expect(withOwned.noPurchase).toBe(true);
            expect(alone.noPurchase).toBeFalsy();
        });

        test('the pricing context is a note, not a task caveat', () => {
            const candidate = buildCombatSwapCandidate(
                { hrid: CAPE, level: 7 },
                [wearing({ [BACK]: piece(CAPE, 5) })],
                gameData
            );
            expect(candidate.caveat).toBeUndefined();
            expect(candidate.pricingNote).toContain('Checked by hand');
            const skilling = buildSkillingSwapCandidate(
                { hrid: MILKING_TOOL, level: 7 },
                { dto: { equipment: {} }, skillEquipmentMap: {}, skills: ['/skills/milking'] },
                gameData
            );
            expect(skilling.caveat).toBeUndefined();
            expect(skilling.pricingNote).toContain('Checked by hand');
        });

        test('a party member’s checked swap is priced and explained without the live character’s spare copy', () => {
            // The live character holds a spare Sinister Cape +4 in the bag, which a ladder starts from
            state.items = [
                {
                    id: 2,
                    characterID: CHAR,
                    itemLocationHrid: '/item_locations/inventory',
                    itemHrid: CAPE,
                    enhancementLevel: 4,
                    count: 1,
                },
            ];
            const dto = wearing({ [BACK]: piece(CAPE, 5) });
            const mine = buildCombatSwapCandidate({ hrid: CAPE, level: 7 }, [dto], gameData, true);
            const theirs = buildCombatSwapCandidate({ hrid: CAPE, level: 7 }, [dto], gameData, false);

            expect(theirs.cost).toBeGreaterThan(mine.cost);
            expect(theirs.isSelf).toBe(false);
            // The breakdown the all-fights run builds reads the same inventory as the Cost cell
            expect(advisor.explainLabCandidateCost(theirs, gameData, theirs.isSelf).net).toBe(theirs.cost);
            expect(advisor.explainLabCandidateCost(theirs, gameData).net).not.toBe(theirs.cost);
        });

        test('combat: a copy worn higher than the level asked for is not reused', () => {
            const low = wearing({ [BACK]: piece(CAPE, 5) });
            const higher = wearing({ [BACK]: piece(CAPE, 8) });
            const alone = buildCombatSwapCandidate({ hrid: CAPE, level: 7 }, [low], gameData);
            const withHigher = buildCombatSwapCandidate({ hrid: CAPE, level: 7 }, [low, higher], gameData);

            expect(withHigher.cost).toBe(alone.cost);
            expect(withHigher.cost).toBeGreaterThan(0);
            expect(withHigher.pricingNote).not.toContain('already wear a copy');
        });

        test('skilling: a kit already wearing it makes the others free', () => {
            const TOOL = '/equipment_types/milking_tool';
            const context = {
                dto: { equipment: {} },
                skillEquipmentMap: {
                    '/skills/milking': { [TOOL]: piece(MILKING_TOOL, 2) },
                    '/skills/foraging': { [TOOL]: piece(MILKING_TOOL, 7) },
                },
                skills: ['/skills/milking', '/skills/foraging'],
            };
            const candidate = buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, context, gameData);
            expect(candidate.skillKeys).toEqual(['/skills/milking']);
            expect(candidate.cost).toBe(0);
            expect(candidate.noPurchase).toBe(true);
            const bought = buildSkillingSwapCandidate(
                { hrid: MILKING_TOOL, level: 7 },
                { ...context, skillEquipmentMap: { '/skills/milking': context.skillEquipmentMap['/skills/milking'] } },
                gameData
            );
            expect(bought.cost).toBeGreaterThan(0);
            expect(bought.noPurchase).toBeFalsy();

            // A kit wearing it higher is left alone but is not a copy to reuse
            context.skillEquipmentMap['/skills/foraging'][TOOL] = piece(MILKING_TOOL, 9);
            const higher = buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, context, gameData);
            expect(higher.skillKeys).toEqual(['/skills/milking']);
            expect(higher.cost).toBeGreaterThan(0);
        });
    });

    describe('a replaced piece still worn outside the swap reach is kept, not sold', () => {
        const PLAIN_CAPE = '/items/plain_cape';
        beforeAll(() => {
            ITEM_DETAIL_MAP[PLAIN_CAPE] = {
                hrid: PLAIN_CAPE,
                name: 'Plain Cape',
                isTradable: true,
                equipmentDetail: { type: BACK, combatStats: { armor: 2 } },
            };
        });

        test('combat: a melee-only cape check does not credit selling a cape the magic loadout keeps', () => {
            const melee = wearing({ [MAIN]: piece(SWORD, 3), [BACK]: piece(PLAIN_CAPE, 3) });
            const magic = wearing({ [TWO]: piece(STAFF, 3), [BACK]: piece(PLAIN_CAPE, 3) });

            const meleeOnly = buildCombatSwapCandidate({ hrid: CAPE, level: 7 }, [melee], gameData);
            const both = buildCombatSwapCandidate({ hrid: CAPE, level: 7 }, [melee, magic], gameData);

            expect(both.reach).toBe(1);
            expect(meleeOnly.keptItems).toBeUndefined();
            expect(both.keptItems).toEqual([{ hrid: PLAIN_CAPE, enhancementLevel: 3 }]);
            expect(both.removedItems).toEqual([]);
            expect(both.pricingNote).toContain('still worn by a loadout this swap does not reach');
            // No resale credit: it costs more than when the cape could be sold
            expect(both.cost).toBeGreaterThan(meleeOnly.cost);
        });

        test('combat: every distinct piece replaced in a reached loadout is credited once; one an unreached loadout wears is not', () => {
            const OTHER = '/items/other_plain_cape';
            ITEM_DETAIL_MAP[OTHER] = {
                hrid: OTHER,
                name: 'Other Plain Cape',
                isTradable: true,
                equipmentDetail: { type: BACK, combatStats: { armor: 1 } },
            };
            const meleeA = wearing({ [MAIN]: piece(SWORD, 3), [BACK]: piece(PLAIN_CAPE, 3) });
            const meleeB = wearing({ [MAIN]: piece(MACE, 3), [BACK]: piece(OTHER, 2) });
            const meleeC = wearing({ [MAIN]: piece(SWORD, 9), [BACK]: piece(PLAIN_CAPE, 3) });
            const magicLoadout = wearing({ [TWO]: piece(STAFF, 3), [BACK]: piece(OTHER, 2) });
            const swap = { hrid: CAPE, level: 7 };
            const entry = (hrid, enhancementLevel) => ({ hrid, enhancementLevel });
            const price = (removedItems) =>
                advisor.calculateUpgradeCost(
                    {
                        type: 'tier',
                        slot: BACK,
                        currentHrid: PLAIN_CAPE,
                        currentLevel: 3,
                        upgradeHrid: CAPE,
                        upgradeLevel: 7,
                        removedItems,
                    },
                    gameData
                );

            // Two reached loadouts, two different capes, one cape replaces both
            const both = buildCombatSwapCandidate(swap, [meleeA, meleeB, meleeC], gameData);
            expect(both.reach).toBe(3);
            expect(both.removedItems).toEqual([entry(PLAIN_CAPE, 3), entry(OTHER, 2)]);
            expect(both.keptItems).toBeUndefined();
            expect(both.cost).toBe(price([entry(PLAIN_CAPE, 3), entry(OTHER, 2)]));
            expect(both.cost).toBeLessThan(price([entry(PLAIN_CAPE, 3)]));

            // The magic loadout is not reached and still wears the Other cape: kept, not sold
            const withUnreached = buildCombatSwapCandidate(swap, [meleeA, meleeB, magicLoadout], gameData);
            expect(withUnreached.removedItems).toEqual([entry(PLAIN_CAPE, 3)]);
            expect(withUnreached.keptItems).toEqual([entry(OTHER, 2)]);
            expect(withUnreached.cost).toBe(price([entry(PLAIN_CAPE, 3)]));
        });

        test('combat: ownership reads every loadout the character has, not only the simulated fights', () => {
            const chosen = wearing({ [MAIN]: piece(SWORD, 3), [BACK]: piece(PLAIN_CAPE, 3) });
            const notChosen = wearing({ [MAIN]: piece(MACE, 3), [BACK]: piece(CAPE, 7) });
            const sameWornElsewhere = wearing({ [MAIN]: piece(MACE, 3), [BACK]: piece(PLAIN_CAPE, 3) });
            const swap = { hrid: CAPE, level: 7 };

            // Worn in a loadout that was not chosen: owned, not bought
            const bought = buildCombatSwapCandidate(swap, [chosen], gameData);
            const owned = buildCombatSwapCandidate(swap, [chosen], gameData, true, {
                ownershipDtos: [chosen, notChosen],
            });
            expect(bought.cost).toBeGreaterThan(0);
            expect(owned.cost).toBe(0);
            expect(owned.noPurchase).toBe(true);
            // The swap still reaches only the chosen fights
            expect(owned.reach).toBe(1);

            // A piece replaced in the chosen fights but worn in a non-chosen loadout is kept, not sold
            const resold = buildCombatSwapCandidate(swap, [chosen], gameData);
            const kept = buildCombatSwapCandidate(swap, [chosen], gameData, true, {
                ownershipDtos: [chosen, sameWornElsewhere],
            });
            expect(resold.removedItems).toEqual([{ hrid: PLAIN_CAPE, enhancementLevel: 3 }]);
            expect(kept.removedItems).toEqual([]);
            expect(kept.keptItems).toEqual([{ hrid: PLAIN_CAPE, enhancementLevel: 3 }]);
            expect(kept.cost).toBeGreaterThan(resold.cost);
        });

        test('skilling: every distinct piece replaced across the reached kits is credited once', () => {
            const TOOL = '/equipment_types/milking_tool';
            ITEM_DETAIL_MAP['/items/tool_a'] = {
                hrid: '/items/tool_a',
                name: 'Tool A',
                isTradable: true,
                equipmentDetail: { type: TOOL, noncombatStats: { milkingSpeed: 0.1 } },
            };
            ITEM_DETAIL_MAP['/items/tool_b'] = {
                hrid: '/items/tool_b',
                name: 'Tool B',
                isTradable: true,
                equipmentDetail: { type: TOOL, noncombatStats: { milkingSpeed: 0.2 } },
            };
            const context = {
                dto: { equipment: {} },
                skillEquipmentMap: {
                    '/skills/milking': { [TOOL]: piece('/items/tool_a', 3) },
                    '/skills/foraging': { [TOOL]: piece('/items/tool_b', 2) },
                },
                skills: ['/skills/milking', '/skills/foraging'],
            };
            const candidate = buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, context, gameData, true, {
                allLoadouts: true,
            });
            expect(candidate.skillKeys).toEqual(['/skills/milking', '/skills/foraging']);
            expect(candidate.removedItems).toEqual([
                { hrid: '/items/tool_a', enhancementLevel: 3 },
                { hrid: '/items/tool_b', enhancementLevel: 2 },
            ]);
            expect(candidate.keptItems).toBeUndefined();
        });

        test('combat: a different piece in the unreached loadout leaves the credit alone', () => {
            const melee = wearing({ [MAIN]: piece(SWORD, 3), [BACK]: piece(PLAIN_CAPE, 3) });
            const magic = wearing({ [TWO]: piece(STAFF, 3), [BACK]: piece(PLAIN_CAPE, 4) });
            const both = buildCombatSwapCandidate({ hrid: CAPE, level: 7 }, [melee, magic], gameData);
            expect(both.keptItems).toBeUndefined();
        });

        test('skilling: a kit outside the run scope still wears a replaced piece', () => {
            const TOOL = '/equipment_types/milking_tool';
            ITEM_DETAIL_MAP['/items/old_milking_tool'] = {
                hrid: '/items/old_milking_tool',
                name: 'Old Milking Tool',
                isTradable: true,
                equipmentDetail: { type: TOOL, noncombatStats: { milkingSpeed: 0.1 } },
            };
            const worn = piece('/items/old_milking_tool', 3);
            // The skill filter is on milking: foraging is outside the run but its kit is real
            const scoped = (foragingTool) => ({
                dto: { equipment: {} },
                skillEquipmentMap: {
                    '/skills/milking': { [TOOL]: worn },
                    '/skills/foraging': { [TOOL]: foragingTool },
                },
                skills: ['/skills/milking'],
            });

            // Foraging wears the old tool too, so replacing it in milking frees nothing to sell
            const kept = buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, scoped(worn), gameData);
            expect(kept.skillKeys).toEqual(['/skills/milking']);
            expect(kept.removedItems).toEqual([]);
            expect(kept.keptItems).toEqual([{ hrid: '/items/old_milking_tool', enhancementLevel: 3 }]);
            expect(kept.keptUnreached).toBe(true);
        });

        test('skilling: a copy worn by a kit outside the run scope is owned, nothing is bought', () => {
            const TOOL = '/equipment_types/milking_tool';
            // The skill filter is on milking; the foraging kit wears the very piece asked for
            const context = {
                dto: { equipment: {} },
                skillEquipmentMap: {
                    '/skills/milking': { [TOOL]: piece(MILKING_TOOL, 2) },
                    '/skills/foraging': { [TOOL]: piece(MILKING_TOOL, 7) },
                },
                skills: ['/skills/milking'],
            };
            const owned = buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, context, gameData);
            expect(owned.skillKeys).toEqual(['/skills/milking']);
            expect(owned.cost).toBe(0);
            expect(owned.noPurchase).toBe(true);
        });

        test('skilling: a kit left out that wears the replaced piece keeps it', () => {
            const TOOL = '/equipment_types/milking_tool';
            ITEM_DETAIL_MAP['/items/old_milking_tool'] = {
                hrid: '/items/old_milking_tool',
                name: 'Old Milking Tool',
                isTradable: true,
                equipmentDetail: { type: TOOL, noncombatStats: { milkingSpeed: 0.1 } },
            };
            const worn = piece('/items/old_milking_tool', 3);
            const context = {
                dto: { equipment: {} },
                skillEquipmentMap: {
                    '/skills/milking': { [TOOL]: worn },
                    '/skills/foraging': { [TOOL]: worn },
                },
                skills: ['/skills/milking', '/skills/foraging'],
            };
            // Only milking can feel a milking tool; foraging keeps wearing the old one
            const candidate = buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, context, gameData);
            expect(candidate.skillKeys).toEqual(['/skills/milking']);
            expect(candidate.keptItems).toEqual([{ hrid: '/items/old_milking_tool', enhancementLevel: 3 }]);
        });
    });

    describe('an enhance frees the different pieces the other reached loadouts wear', () => {
        const entry = (hrid, enhancementLevel) => ({ hrid, enhancementLevel });
        const swap = { hrid: SWORD, level: 5 };

        test('combat: the mace a second loadout wears is sold once the sword is enhanced for both', () => {
            const sworded = wearing({ [MAIN]: piece(SWORD, 3) });
            const maced = wearing({ [MAIN]: piece(MACE, 3) });
            const alone = buildCombatSwapCandidate(swap, [sworded], gameData);
            const both = buildCombatSwapCandidate(swap, [sworded, maced], gameData);

            expect(both.type).toBe('enhancement');
            expect(both.reach).toBe(2);
            expect(both.freedItems).toEqual([entry(MACE, 3)]);
            expect(both.keptItems).toBeUndefined();
            expect(alone.freedItems).toEqual([]);
            // The mace sells for 2M (the stubbed price) against the enhance of 40M
            expect(both.cost).toBe(alone.cost - 2_000_000);
            const detail = advisor.explainUpgradeCost(both, gameData);
            expect(detail.net).toBe(both.cost);
            expect(detail.credits).toContainEqual(expect.objectContaining({ hrid: MACE, enhancementLevel: 3 }));
        });

        test('combat: a mace a loadout outside the reach still wears is kept, not sold', () => {
            const sworded = wearing({ [MAIN]: piece(SWORD, 3) });
            const maced = wearing({ [MAIN]: piece(MACE, 3) });
            const elsewhere = wearing({ [MAIN]: piece(MACE, 3) });
            const result = buildCombatSwapCandidate(swap, [sworded, maced], gameData, true, {
                ownershipDtos: [sworded, maced, elsewhere],
            });
            expect(result.reach).toBe(2);
            expect(result.freedItems).toEqual([]);
            expect(result.keptItems).toEqual([entry(MACE, 3)]);
            expect(result.pricingNote).toContain('still worn by a loadout this swap does not reach');
        });

        test('combat: two loadouts wearing the same mace credit it once, and a different level is its own piece', () => {
            const sworded = wearing({ [MAIN]: piece(SWORD, 3) });
            const result = buildCombatSwapCandidate(
                swap,
                [
                    sworded,
                    wearing({ [MAIN]: piece(MACE, 3) }),
                    wearing({ [MAIN]: piece(MACE, 3) }),
                    wearing({ [MAIN]: piece(MACE, 4) }),
                ],
                gameData
            );
            expect(result.freedItems).toEqual([entry(MACE, 3), entry(MACE, 4)]);
        });

        test('combat: nothing else worn in the slot is no credit, and the cost is the plain enhance', () => {
            const sworded = wearing({ [MAIN]: piece(SWORD, 3) });
            const bare = wearing({});
            const result = buildCombatSwapCandidate(swap, [sworded, bare], gameData);
            expect(result.freedItems).toEqual([]);
            expect(result.cost).toBe(buildCombatSwapCandidate(swap, [sworded], gameData).cost);
        });

        test('skilling: the tool another kit wears is credited beside the enhance', () => {
            const TOOL = '/equipment_types/milking_tool';
            ITEM_DETAIL_MAP['/items/tool_c'] = {
                hrid: '/items/tool_c',
                name: 'Tool C',
                isTradable: true,
                equipmentDetail: { type: TOOL, noncombatStats: { milkingSpeed: 0.1 } },
            };
            const context = (second) => ({
                dto: { equipment: {} },
                skillEquipmentMap: {
                    '/skills/milking': { [TOOL]: piece(MILKING_TOOL, 3) },
                    '/skills/foraging': { [TOOL]: second },
                },
                skills: ['/skills/milking', '/skills/foraging'],
            });
            const target = { hrid: MILKING_TOOL, level: 7 };
            const opts = { allLoadouts: true };
            const alone = buildSkillingSwapCandidate(target, context(null), gameData, true, opts);
            const withTool = buildSkillingSwapCandidate(
                target,
                context(piece('/items/tool_c', 2)),
                gameData,
                true,
                opts
            );
            expect(withTool.type).toBe('enhancement');
            expect(withTool.freedItems).toEqual([entry('/items/tool_c', 2)]);
            expect(withTool.cost).toBe(alone.cost - 2_000_000);
            expect(withTool.costDetail.credits).toContainEqual(expect.objectContaining({ hrid: '/items/tool_c' }));
        });
    });

    describe('skilling: the item must have skilling stats, All loadouts or not', () => {
        test('a combat cape reaches no kit even with All loadouts, a tool for another skill does with it', () => {
            const TOOL = '/equipment_types/milking_tool';
            const context = {
                dto: { equipment: {} },
                skillEquipmentMap: { '/skills/foraging': {} },
                skills: ['/skills/foraging'],
            };
            expect(
                buildSkillingSwapCandidate({ hrid: CAPE, level: 5 }, context, gameData, true, { allLoadouts: true })
            ).toBeNull();
            expect(buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 5 }, context, gameData)).toBeNull();
            const forced = buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 5 }, context, gameData, true, {
                allLoadouts: true,
            });
            expect(forced.skillKeys).toEqual(['/skills/foraging']);
            expect(forced.members[0].slot).toBe(TOOL);
        });
    });

    test('the minimized tab sections come back as only the true flags of short keys', () => {
        expect(
            sanitizeSwapOptions({
                sectionsCollapsed: {
                    'lab:single-results': true,
                    'lab:x': false,
                    'lab:y': 'yes',
                    ['k'.repeat(61)]: true,
                },
            }).sectionsCollapsed
        ).toEqual({ 'lab:single-results': true });
        expect(sanitizeSwapOptions({ sectionsCollapsed: 'nope' }).sectionsCollapsed).toEqual({});
    });

    test('the remembered options come back in shape', () => {
        expect(sanitizeSwapOptions(null)).toEqual({
            all: { combat: false, skilling: false },
            open: { combat: null, skilling: null },
            upgradesOpen: { combat: true, skilling: true },
            checkedOpen: { combat: true, skilling: true },
            orderCollapsed: false,
            orderShowAll: false,
            triggerCollapsed: false,
            sectionsCollapsed: {},
        });
        expect(
            sanitizeSwapOptions({ all: { combat: true, skilling: 'x' }, open: { combat: false, skilling: 3 } })
        ).toEqual({
            all: { combat: true, skilling: false },
            open: { combat: false, skilling: null },
            upgradesOpen: { combat: true, skilling: true },
            checkedOpen: { combat: true, skilling: true },
            orderCollapsed: false,
            orderShowAll: false,
            triggerCollapsed: false,
            sectionsCollapsed: {},
        });
        expect(sanitizeSwapOptions({ checkedOpen: { combat: false, skilling: 'x' } }).checkedOpen).toEqual({
            combat: false,
            skilling: true,
        });
        expect(sanitizeSwapOptions({ upgradesOpen: { combat: false, skilling: 'x' } }).upgradesOpen).toEqual({
            combat: false,
            skilling: true,
        });
    });

    test('a piece with no combat stats is in no loadout', () => {
        const candidate = buildCombatSwapCandidate(
            { hrid: MILKING_TOOL, level: 5 },
            [wearing({ [MAIN]: piece(SWORD) })],
            gameData
        );
        expect(candidate.reach).toBe(0);
    });

    test('an item with no equipment slot builds nothing', () => {
        expect(buildCombatSwapCandidate({ hrid: '/items/coin', level: 0 }, [], gameData)).toBeNull();
    });
});

describe('combat: what a checked swap costs', () => {
    test('matches the generated row for the same target', () => {
        state.items = [
            {
                id: 1,
                characterID: CHAR,
                itemLocationHrid: '/item_locations/back',
                itemHrid: CAPE,
                enhancementLevel: 5,
                count: 1,
            },
        ];
        const dto = wearing({ [BACK]: piece(CAPE, 5) });
        const generated = advisor
            .generateCandidates(dto, gameData, 'equipment')
            .find((candidate) => candidate.type === 'enhancement' && candidate.upgradeHrid === CAPE);
        expect(generated).toBeTruthy();

        const checked = buildCombatSwapCandidate({ hrid: CAPE, level: generated.upgradeLevel }, [dto], gameData);

        expect(checked.type).toBe('enhancement');
        expect(checked.currentLevel).toBe(5);
        expect(checked.description).toBe(generated.description);
        expect(checked.cost).toBe(advisor.calculateUpgradeCost(generated, gameData));
        // Through the self-enhance ladder, not at a market ask: the 50M ask never shows
        expect(checked.cost).toBeLessThan(50_000_000);
    });

    test('a swap into a different piece is priced as the purchase less the resale of what it replaces', () => {
        const dto = wearing({ [MAIN]: piece(MACE, 3) });
        const checked = buildCombatSwapCandidate({ hrid: SWORD, level: 3 }, [dto], gameData);
        const same = {
            type: 'tier',
            slot: MAIN,
            currentHrid: MACE,
            currentLevel: 3,
            upgradeHrid: SWORD,
            upgradeLevel: 3,
        };

        expect(checked.type).toBe('tier');
        expect(checked.description).toBe('Cheese Mace +3 → Cheese Sword +3');
        expect(checked.cost).toBe(advisor.calculateUpgradeCost(same, gameData));
    });

    test('a fill of a bare slot sells nothing', () => {
        const dto = wearing({ [MAIN]: piece(SWORD) });
        const checked = buildCombatSwapCandidate({ hrid: CAPE, level: 3 }, [dto], gameData);
        expect(checked.description).toBe('Sinister Cape +3');
        expect(checked.cost).toBe(advisor.calculateUpgradeCost({ ...checked }, gameData));
    });
});

describe('skilling: which kits a checked swap reaches', () => {
    const MILKING = '/skills/milking';
    const FORAGING = '/skills/foraging';
    const CRAFTING = '/skills/crafting';
    const TOOL = '/equipment_types/milking_tool';

    const kits = () => ({
        dto: { equipment: { [BACK]: piece(CAPE, 5) } },
        skillEquipmentMap: {
            [MILKING]: { [TOOL]: piece(MILKING_TOOL, 2), [BACK]: piece(CAPE, 5) },
            [FORAGING]: { [BACK]: piece(CAPE, 5) },
        },
        skills: [MILKING, FORAGING, CRAFTING],
    });

    test('a milking tool is written into the milking kit and no other', () => {
        const context = kits();
        const candidate = buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, context, gameData);

        expect(candidate.skillKeys).toEqual([MILKING]);
        expect(candidate.members).toHaveLength(1);
        expect(candidate.type).toBe('enhancement');
        expect(candidate.description).toBe('Celestial Milking Tool +2 → +7 (milking)');

        const after = applySkillingCandidate(
            { dto: context.dto, skillEquipmentMap: context.skillEquipmentMap },
            candidate
        );
        expect(after.skillEquipmentMap[MILKING][TOOL]).toEqual({ hrid: MILKING_TOOL, enhancementLevel: 7 });
        expect(after.skillEquipmentMap[FORAGING][TOOL]).toBeUndefined();
        expect(after.dto.equipment[TOOL]).toBeUndefined();
        // The setup it was applied to is untouched
        expect(context.skillEquipmentMap[MILKING][TOOL].enhancementLevel).toBe(2);
    });

    test('a kit already wearing it that high is left out, and a swap nobody can feel is reported', () => {
        const context = kits();
        context.skillEquipmentMap[MILKING][TOOL] = piece(MILKING_TOOL, 9);
        expect(buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, context, gameData)).toBeNull();
        // A combat cape moves no skilling room
        expect(buildSkillingSwapCandidate({ hrid: CAPE, level: 9 }, kits(), gameData)).toBeNull();
        // Nor does a tool for a skill that is not in the run
        const narrowed = { ...kits(), skills: [FORAGING] };
        expect(buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, narrowed, gameData)).toBeNull();
    });

    test('a skill running in the base kit gets a kit of its own rather than changing everyone', () => {
        const context = {
            dto: { equipment: { [BACK]: piece(CAPE, 5) } },
            skillEquipmentMap: {},
            skills: [MILKING, CRAFTING],
        };
        const candidate = buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 5 }, context, gameData);
        const after = applySkillingCandidate({ dto: context.dto, skillEquipmentMap: {} }, candidate);

        expect(after.skillEquipmentMap[MILKING][TOOL]).toEqual({ hrid: MILKING_TOOL, enhancementLevel: 5 });
        expect(after.skillEquipmentMap[CRAFTING]).toBeUndefined();
        expect(after.dto.equipment[TOOL]).toBeUndefined();
    });

    test('rows are measured against the baseline in the shape the Skilling table draws', async () => {
        const context = kits();
        // A stand-in evaluator: clearing is likelier the higher the milking tool
        const evaluate = (setup) => {
            const level = setup.skillEquipmentMap[MILKING]?.[TOOL]?.enhancementLevel ?? 0;
            return { clearRate: 0.5 + level * 0.01, xpPerRoom: 100 };
        };
        const progress = [];

        const out = await evaluateSkillingSwaps({
            swaps: [
                { hrid: MILKING_TOOL, level: 7 },
                { hrid: CAPE, level: 9 },
            ],
            baseSetup: { dto: context.dto, skillEquipmentMap: context.skillEquipmentMap },
            evaluate,
            applySetup: (setup, candidate) => applySkillingCandidate(setup, candidate),
            roomLevel: 100,
            skills: context.skills,
            gameData,
            yieldFn: async () => {},
            onProgress: (p) => progress.push(p.description),
        });

        expect(out.baseline.clearRate).toBeCloseTo(0.52);
        expect(out.rows).toHaveLength(1);
        expect(out.rows[0]).toMatchObject({ costType: 'gold', metricType: 'clearRate' });
        expect(out.rows[0].clearRateDelta).toBeCloseTo(0.05);
        expect(out.rows[0].cost).toBe(advisor.calculateUpgradeCost(out.rows[0].candidate, gameData));
        expect(out.rows[0].goldPerClearRate).toBeCloseTo(out.rows[0].cost / 5);
        expect(out.unreached).toEqual([{ hrid: CAPE, level: 9 }]);
        expect(progress).toEqual(['Celestial Milking Tool +7', 'Sinister Cape +9']);
    });

    test('Stop ends it between swaps', async () => {
        const context = kits();
        let calls = 0;
        const out = await evaluateSkillingSwaps({
            swaps: [
                { hrid: MILKING_TOOL, level: 7 },
                { hrid: MILKING_TOOL, level: 8 },
            ],
            baseSetup: { dto: context.dto, skillEquipmentMap: context.skillEquipmentMap },
            evaluate: () => ({ clearRate: 0.5 }),
            applySetup: (setup) => setup,
            roomLevel: 100,
            skills: context.skills,
            gameData,
            abortSignal: () => ++calls > 1,
            yieldFn: async () => {},
        });
        expect(out.rows).toHaveLength(1);
    });
});
