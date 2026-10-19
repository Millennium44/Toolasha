/**
 * Check a swap, for abilities: a typed ability becomes one candidate per way it
 * could go onto a bar, and the rows fold back into one row with the best option
 * per loadout.
 *
 * Runs the real advisor (`candidateAppliesToDTO`, `applyCandidateToDTO`,
 * `calculateUpgradeCost`, `runLabyrinthAllFightsAnalysis`) with only the market,
 * the ability book prices and the simulator stood in for.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

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

const state = vi.hoisted(() => ({
    abilities: [],
    sim: null,
}));

const CRIT_AURA = '/abilities/critical_aura';
const FIERCE_AURA = '/abilities/fierce_aura';
const SMACK = '/abilities/smack';
const POKE = '/abilities/poke';
const TOUGHNESS = '/abilities/toughness';
const QUICK_STRIKE = '/abilities/quick_strike';
const FIREBALL = '/abilities/fireball';
const SWORD = '/items/cheese_sword';
const MAIN = '/equipment_types/main_hand';
const CAPE = '/items/sinister_cape';
const CHAR = 161296;

const ITEM_DETAIL_MAP = {
    [SWORD]: {
        hrid: SWORD,
        name: 'Cheese Sword',
        itemLevel: 10,
        equipmentDetail: { type: MAIN, combatStats: { slashDamage: 20 } },
    },
    [CAPE]: {
        hrid: CAPE,
        name: 'Sinister Cape',
        itemLevel: 80,
        equipmentDetail: { type: '/equipment_types/back', combatStats: { slashDamage: 0.1 } },
    },
};

const ABILITY_DETAIL_MAP = {
    [CRIT_AURA]: { hrid: CRIT_AURA, name: 'Critical Aura', isSpecialAbility: true, abilityEffects: [] },
    [FIERCE_AURA]: { hrid: FIERCE_AURA, name: 'Fierce Aura', isSpecialAbility: true, abilityEffects: [] },
    [SMACK]: { hrid: SMACK, name: 'Smack', cooldownDuration: 5e9, abilityEffects: [] },
    [POKE]: { hrid: POKE, name: 'Poke', cooldownDuration: 5e9, abilityEffects: [] },
    [FIREBALL]: { hrid: FIREBALL, name: 'Fireball', cooldownDuration: 0, abilityEffects: [] },
    [TOUGHNESS]: { hrid: TOUGHNESS, name: 'Toughness', cooldownDuration: 5e9, abilityEffects: [] },
    [QUICK_STRIKE]: { hrid: QUICK_STRIKE, name: 'Quick Strike', cooldownDuration: 5e9, abilityEffects: [] },
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: ITEM_DETAIL_MAP }),
        getCurrentCharacterId: () => CHAR,
        getGuildBuildingLevel: () => 0,
        getSkills: () => [],
        get characterData() {
            return { characterAbilities: state.abilities };
        },
    },
}));
vi.mock('./combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,

    buildGameDataPayload: vi.fn(() => ({
        itemDetailMap: ITEM_DETAIL_MAP,
        abilityDetailMap: ABILITY_DETAIL_MAP,
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
vi.mock('../combat/labyrinth-clear-rate.js', () => ({ default: {} }));
vi.mock('./labyrinth-level-finder.js', () => ({ findMaxLabyrinthLevel: vi.fn(), defaultThreshold: () => 0.7 }));
vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false, testerGearPrice: () => null }));
vi.mock('./direct-enhancement-cost.js', () => ({
    calculateDirectEnhancementCost: () => 0,
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
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: vi.fn(() => ({ ask: 5_000_000, bid: 1_000_000 })) }));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));
// One book per level above the starting one, a thousand coins each
vi.mock('../../utils/ability-cost-calculator.js', () => ({
    explainAbilityLevelUpCost: vi.fn((hrid, fromLevel, _xp, toLevel) => {
        const books = Math.max(0, toLevel - fromLevel);
        return { books, total: books * 1000, bookName: hrid };
    }),
}));

const advisor = await import('./upgrade-advisor.js');
const orderApi = await import('./lab-swap-check.js');
const { explainAbilityLevelUpCost } = await import('../../utils/ability-cost-calculator.js');
const {
    buildCombatAbilityCandidates,
    clampLevelFor,
    describeCheckedSwap,
    mergeCheckedAbilityRows,
    resolveAbilityHrid,
    resolveSwapHrid,
    sanitizeSwapQueues,
} = await import('./lab-swap-check.js');

const gameData = { itemDetailMap: ITEM_DETAIL_MAP, abilityDetailMap: ABILITY_DETAIL_MAP, actionDetailMap: {} };
const ability = (hrid, level) => ({ hrid, level, triggers: null });
// Slot 0 is the special slot; the rest are ordinary
const loadout = (abilities) => ({
    equipment: { [MAIN]: { hrid: SWORD, enhancementLevel: 0 } },
    abilities,
});
const fourAbilities = () =>
    loadout([ability(FIERCE_AURA, 10), ability(SMACK, 12), ability(POKE, 14), ability(TOUGHNESS, 16)]);

beforeEach(() => {
    state.abilities = [];
    state.sim = null;
    vi.mocked(explainAbilityLevelUpCost).mockClear();
});

describe('naming an ability', () => {
    test('resolves by game name in any case, by hrid tail, or by full hrid', () => {
        expect(resolveAbilityHrid(gameData, 'Critical Aura')).toBe(CRIT_AURA);
        expect(resolveAbilityHrid(gameData, 'critical aura')).toBe(CRIT_AURA);
        expect(resolveAbilityHrid(gameData, 'critical_aura')).toBe(CRIT_AURA);
        expect(resolveAbilityHrid(gameData, CRIT_AURA)).toBe(CRIT_AURA);
        expect(resolveAbilityHrid(gameData, 'quick')).toBe(QUICK_STRIKE);
    });

    test('text naming several abilities, or none, resolves to nothing', () => {
        expect(resolveAbilityHrid(gameData, 'aura')).toBeNull();
        expect(resolveAbilityHrid(gameData, 'nonsense')).toBeNull();
        expect(resolveSwapHrid(gameData, 'aura')).toBeNull();
    });

    test('equipment still wins its own names, and the chip reads "Critical Aura 7"', () => {
        expect(resolveSwapHrid(gameData, 'sinister cape')).toBe(CAPE);
        expect(resolveSwapHrid(gameData, 'critical aura')).toBe(CRIT_AURA);
        expect(describeCheckedSwap({ hrid: CRIT_AURA, level: 7 }, gameData)).toBe('Critical Aura 7');
        expect(describeCheckedSwap({ hrid: CAPE, level: 7 }, gameData)).toBe('Sinister Cape +7');
    });

    test('an ability level is 1 to 200, and abilities are remembered on the combat queue only', () => {
        expect(clampLevelFor(CRIT_AURA, 7.9)).toBe(7);
        expect(clampLevelFor(CRIT_AURA, 0)).toBe(1);
        expect(clampLevelFor(CRIT_AURA, 999)).toBe(200);
        expect(clampLevelFor(CAPE, 999)).toBe(20);
        const queues = sanitizeSwapQueues({
            combat: [{ hrid: CRIT_AURA, level: 7 }],
            skilling: [{ hrid: CRIT_AURA, level: 7 }],
        });
        expect(queues.combat).toEqual([{ hrid: CRIT_AURA, level: 7 }]);
        expect(queues.skilling).toEqual([]);
    });
});

describe('the slot options of a checked ability', () => {
    test('an aura is tried in the special slot only; an ordinary ability in each ordinary slot', () => {
        const dto = fourAbilities();
        const aura = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [dto], gameData);
        expect(aura.candidates.map((option) => option.optionLabel)).toEqual(['Fierce Aura']);
        expect(aura.reach).toBe(1);

        const ordinary = buildCombatAbilityCandidates({ hrid: QUICK_STRIKE, level: 7 }, [dto], gameData);
        expect(ordinary.candidates.map((option) => option.optionLabel).sort()).toEqual(['Poke', 'Smack', 'Toughness']);
    });

    test('options are applied at the level asked for, into the right slot, with default triggers', () => {
        const dto = fourAbilities();
        const { candidates } = buildCombatAbilityCandidates({ hrid: QUICK_STRIKE, level: 7 }, [dto], gameData);
        const poke = candidates.find((option) => option.replacesHrid === POKE);
        expect(advisor.candidateAppliesToDTO(poke, dto, gameData)).toBe(true);
        const after = advisor.applyCandidateToDTO(dto, poke);
        expect(after.abilities[2]).toEqual({ hrid: QUICK_STRIKE, level: 7, triggers: null });
        expect(after.abilities[0].hrid).toBe(FIERCE_AURA);
        // the source loadout is untouched
        expect(dto.abilities[2].hrid).toBe(POKE);
    });

    test('a free slot is an option only for a bar that has one, of the right kind', () => {
        const free = loadout([ability(FIERCE_AURA, 10), ability(SMACK, 12), null, null]);
        const full = fourAbilities();
        const auraBarFree = loadout([null, ability(SMACK, 12), ability(POKE, 14), ability(TOUGHNESS, 16)]);

        const ordinary = buildCombatAbilityCandidates({ hrid: QUICK_STRIKE, level: 7 }, [free, full], gameData);
        const fill = ordinary.candidates.find((option) => option.fillsFreeSlot);
        expect(advisor.candidateAppliesToDTO(fill, free, gameData)).toBe(true);
        expect(advisor.candidateAppliesToDTO(fill, full, gameData)).toBe(false);
        expect(advisor.applyCandidateToDTO(free, fill).abilities[2].hrid).toBe(QUICK_STRIKE);

        // the free special slot takes an aura, not an ordinary ability
        const aura = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [auraBarFree, free], gameData);
        const auraFill = aura.candidates.find((option) => option.fillsFreeSlot);
        expect(advisor.candidateAppliesToDTO(auraFill, auraBarFree, gameData)).toBe(true);
        expect(advisor.applyCandidateToDTO(auraBarFree, auraFill).abilities[0].hrid).toBe(CRIT_AURA);
        const ordinaryOnAuraBar = buildCombatAbilityCandidates(
            { hrid: QUICK_STRIKE, level: 7 },
            [auraBarFree],
            gameData
        );
        expect(ordinaryOnAuraBar.candidates.some((option) => option.fillsFreeSlot)).toBe(false);
    });
});

describe('always-ready abilities go last', () => {
    const names = (dto) => dto.abilities.map((entry) => entry && ABILITY_DETAIL_MAP[entry.hrid].name);

    test('a zero-cooldown newcomer replacing a middle ability is moved to the end', () => {
        const dto = fourAbilities();
        const { candidates } = buildCombatAbilityCandidates({ hrid: FIREBALL, level: 7 }, [dto], gameData);
        const smack = candidates.find((option) => option.replacesHrid === SMACK);
        expect(names(advisor.applyCandidateToDTO(dto, smack))).toEqual([
            'Fierce Aura',
            'Poke',
            'Toughness',
            'Fireball',
        ]);
    });

    test('a cooldown newcomer replacing the ability before a zero-cooldown one stays ahead of it', () => {
        const dto = loadout([ability(FIERCE_AURA, 10), ability(SMACK, 12), ability(POKE, 14), ability(FIREBALL, 16)]);
        const { candidates } = buildCombatAbilityCandidates({ hrid: QUICK_STRIKE, level: 7 }, [dto], gameData);
        // Replacing the always-ready ability leaves the newcomer last, but nothing may sit after a zero-cooldown one
        const fire = candidates.find((option) => option.replacesHrid === FIREBALL);
        expect(names(advisor.applyCandidateToDTO(dto, fire))).toEqual(['Fierce Aura', 'Smack', 'Poke', 'Quick Strike']);
        const free = loadout([ability(FIERCE_AURA, 10), ability(SMACK, 12), ability(FIREBALL, 16), null]);
        const fill = buildCombatAbilityCandidates({ hrid: QUICK_STRIKE, level: 7 }, [free], gameData).candidates.find(
            (option) => option.fillsFreeSlot
        );
        expect(names(advisor.applyCandidateToDTO(free, fill))).toEqual([
            'Fierce Aura',
            'Smack',
            'Quick Strike',
            'Fireball',
        ]);
    });

    test('an aura is never moved out of the special slot, and an ordinary ability never enters it', () => {
        const dto = fourAbilities();
        const aura = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [dto], gameData).candidates[0];
        expect(names(advisor.applyCandidateToDTO(dto, aura))[0]).toBe('Critical Aura');
        const ordinary = buildCombatAbilityCandidates({ hrid: SMACK, level: 7 }, [dto], gameData).candidates;
        expect(ordinary.every((option) => option.replacesHrid !== FIERCE_AURA)).toBe(true);
    });
});

describe('already equipped', () => {
    test('a loadout casting it at the level asked or higher is a no-op, reported as such', () => {
        const casting = loadout([
            ability(CRIT_AURA, 10),
            ability(SMACK, 12),
            ability(POKE, 14),
            ability(TOUGHNESS, 16),
        ]);
        const built = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [casting], gameData);
        expect(built.candidates).toEqual([]);
        expect(built.reach).toBe(0);
        expect(built.alreadyEquipped).toBe(1);
    });

    test('one below the level asked is a level-up of that copy, keeping its triggers', () => {
        const triggers = [{ condition: 'x' }];
        const casting = loadout([
            { hrid: CRIT_AURA, level: 5, triggers },
            ability(SMACK, 12),
            ability(POKE, 14),
            ability(TOUGHNESS, 16),
        ]);
        const built = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [casting], gameData);
        expect(built.candidates).toHaveLength(1);
        expect(built.candidates[0].levelUp).toBe(true);
        const after = advisor.applyCandidateToDTO(casting, built.candidates[0]);
        expect(after.abilities[0]).toEqual({ hrid: CRIT_AURA, level: 7, triggers });
        expect(built.alreadyEquipped).toBe(0);
    });
});

describe('what it costs', () => {
    test('is the ability books from the level the character has now', () => {
        state.abilities = [{ abilityHrid: CRIT_AURA, level: 5, experience: 1234 }];
        const built = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [fourAbilities()], gameData);
        expect(explainAbilityLevelUpCost).toHaveBeenCalledWith(CRIT_AURA, 5, expect.any(Number), 7);
        expect(built.candidates[0].cost).toBe(2000);
    });

    test('is the whole path for an ability never read, and nothing when already at the level', () => {
        const fresh = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [fourAbilities()], gameData);
        expect(fresh.candidates[0].cost).toBe(7000);

        state.abilities = [{ abilityHrid: CRIT_AURA, level: 9, experience: 0 }];
        const owned = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [fourAbilities()], gameData);
        expect(owned.candidates[0].cost).toBe(0);
    });
});

describe('the whole run: best replacement per loadout', () => {
    const fight = (name, dto) => ({
        monsterHrid: `/monsters/${name}`,
        monsterName: name,
        roomLevel: 50,
        dto,
        loadoutName: `${name} loadout`,
    });

    // The aura helps most when it takes Fierce Aura's place in one loadout and
    // Smack's... but an aura only goes in slot 0, so the ordinary ability under
    // test is what shows a different best replacement per loadout
    test('picks the best replaced ability in each loadout and names it', async () => {
        state.sim = async ({ playerDTOs }) => {
            const abilities = playerDTOs[0].abilities.filter(Boolean);
            const has = (hrid) => abilities.some((entry) => entry.hrid === hrid);
            let win = 0.5;
            if (has(QUICK_STRIKE)) {
                // Losing Toughness hurts the first loadout, losing Smack hurts the second
                if (!has(TOUGHNESS)) win = 0.52;
                else if (!has(SMACK)) win = 0.72;
                else win = 0.62;
                if (!has(POKE)) win = Math.max(win, 0.56);
            }
            return { encounters: win * 1000, labyAttemptCount: 1000, experienceGained: {}, simulatedTime: 1 };
        };
        const first = fourAbilities();
        const second = loadout([
            ability(FIERCE_AURA, 10),
            ability(SMACK, 20),
            ability(POKE, 14),
            ability(TOUGHNESS, 16),
        ]);
        const fights = [fight('mimic', first), fight('cyclops', second)];
        const built = buildCombatAbilityCandidates({ hrid: QUICK_STRIKE, level: 7 }, [first, second], gameData);
        expect(built.candidates.length).toBeGreaterThan(1);

        const raw = await advisor.runLabyrinthAllFightsAnalysis(
            {
                fights,
                crates: [],
                hours: 1,
                precision: null,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: [],
                extraCandidates: built.candidates,
            },
            () => {}
        );
        // every option is a row before the fold
        expect(raw.results.length).toBe(built.candidates.length);

        const merged = mergeCheckedAbilityRows(raw, gameData);
        expect(merged.results).toHaveLength(1);
        const row = merged.results[0];
        expect(row.candidate.description).toMatch(/^Quick Strike 7 \(replaces /);
        expect(row.appliedFights).toBe(2);
        expect(row.cost).toBe(7000);
        // Replacing Toughness (0.72 in the sim above) is the best in both loadouts
        expect(row.fights.map((entry) => entry.replaced)).toEqual(['Smack', 'Smack']);
        expect(row.fights[0].winRate).toBeCloseTo(0.72, 5);
        expect(row.attemptsDelta).toBeLessThan(0);
    });

    test('fights sharing a saved loadout all take the one option that minimizes its summed attempts', async () => {
        // Replacing Smack is far better against the mimic and slightly worse against the cyclops
        // than replacing Poke, but Smack wins on summed attempts, so both fights must use it
        const winRates = {
            '/monsters/mimic': { [SMACK]: 0.9, [POKE]: 0.5 },
            '/monsters/cyclops': { [SMACK]: 0.3, [POKE]: 0.35 },
        };
        state.sim = async ({ playerDTOs, monsterHrid }) => {
            const abilities = playerDTOs[0].abilities.filter(Boolean);
            const has = (hrid) => abilities.some((entry) => entry.hrid === hrid);
            let win = 0.2;
            if (!has(QUICK_STRIKE)) win = 0.1;
            else if (!has(SMACK)) win = winRates[monsterHrid][SMACK];
            else if (!has(POKE)) win = winRates[monsterHrid][POKE];
            return { encounters: win * 1000, labyAttemptCount: 1000, experienceGained: {}, simulatedTime: 1 };
        };
        const shared = fourAbilities();
        const fights = [
            { ...fight('mimic', shared), loadoutId: 5 },
            { ...fight('cyclops', fourAbilities()), loadoutId: 5 },
        ];
        const built = buildCombatAbilityCandidates({ hrid: QUICK_STRIKE, level: 7 }, [shared], gameData);
        const raw = await advisor.runLabyrinthAllFightsAnalysis(
            {
                fights,
                crates: [],
                hours: 1,
                precision: null,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: [],
                extraCandidates: built.candidates,
            },
            () => {}
        );
        const row = mergeCheckedAbilityRows(raw, gameData).results[0];
        expect(row.fights.map((entry) => entry.replaced)).toEqual(['Smack', 'Smack']);
        expect(row.fights.map((entry) => entry.winRate)).toEqual([0.9, 0.3]);
        expect(row.expectedAttempts).toBeCloseTo(1 / 0.9 + 1 / 0.3, 5);
        expect(row.candidate.description).toMatch(/\(replaces Smack\)$/);
    });

    test('fights on the worn gear (loadoutId 0) share one choice too', async () => {
        // Replacing Smack is far better against the mimic and slightly worse against the cyclops
        // than replacing Poke, but Smack wins on summed attempts, so both fights must use it
        const winRates = {
            '/monsters/mimic': { [SMACK]: 0.9, [POKE]: 0.5 },
            '/monsters/cyclops': { [SMACK]: 0.3, [POKE]: 0.35 },
        };
        state.sim = async ({ playerDTOs, monsterHrid }) => {
            const abilities = playerDTOs[0].abilities.filter(Boolean);
            const has = (hrid) => abilities.some((entry) => entry.hrid === hrid);
            let win = 0.2;
            if (!has(QUICK_STRIKE)) win = 0.1;
            else if (!has(SMACK)) win = winRates[monsterHrid][SMACK];
            else if (!has(POKE)) win = winRates[monsterHrid][POKE];
            return { encounters: win * 1000, labyAttemptCount: 1000, experienceGained: {}, simulatedTime: 1 };
        };
        const shared = fourAbilities();
        const fights = [
            { ...fight('mimic', shared), loadoutId: 0 },
            { ...fight('cyclops', fourAbilities()), loadoutId: 0 },
        ];
        const built = buildCombatAbilityCandidates({ hrid: QUICK_STRIKE, level: 7 }, [shared], gameData);
        const raw = await advisor.runLabyrinthAllFightsAnalysis(
            {
                fights,
                crates: [],
                hours: 1,
                precision: null,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: [],
                extraCandidates: built.candidates,
            },
            () => {}
        );
        const row = mergeCheckedAbilityRows(raw, gameData).results[0];
        expect(row.fights.map((entry) => entry.replaced)).toEqual(['Smack', 'Smack']);
        expect(row.fights.map((entry) => entry.winRate)).toEqual([0.9, 0.3]);
        expect(row.expectedAttempts).toBeCloseTo(1 / 0.9 + 1 / 0.3, 5);
        expect(row.candidate.description).toMatch(/\(replaces Smack\)$/);
    });

    test('a loadout already casting the ability keeps its baseline and says why', async () => {
        state.sim = async () => ({ encounters: 500, labyAttemptCount: 1000, experienceGained: {}, simulatedTime: 1 });
        const casting = loadout([
            ability(CRIT_AURA, 10),
            ability(SMACK, 12),
            ability(POKE, 14),
            ability(TOUGHNESS, 16),
        ]);
        const other = fourAbilities();
        const fights = [fight('mimic', casting), fight('cyclops', other)];
        const built = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [casting, other], gameData);
        expect(built.alreadyEquipped).toBe(1);

        const raw = await advisor.runLabyrinthAllFightsAnalysis(
            {
                fights,
                crates: [],
                hours: 1,
                precision: null,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: [],
                extraCandidates: built.candidates,
            },
            () => {}
        );
        const row = mergeCheckedAbilityRows(raw, gameData).results[0];
        expect(row.fights[0].applied).toBe(false);
        expect(row.fights[0].skipReason).toBe('already equipped at 10');
        expect(row.fights[1].applied).toBe(true);
        expect(row.fights[1].replaced).toBe('Fierce Aura');
    });
});

describe('the ability order check', () => {
    const { buildCombatAbilityOrderCandidates, consistentAbilityOrders, ABILITY_ORDER_HRID } = orderApi;
    const names = (dto) => dto.abilities.map((entry) => entry && ABILITY_DETAIL_MAP[entry.hrid].name);

    test('the order check is not a Check a swap entry any more: typing "order" resolves to nothing and a saved queue drops it', () => {
        expect(resolveSwapHrid(gameData, 'order')).not.toBe(ABILITY_ORDER_HRID);
        expect(
            sanitizeSwapQueues({
                combat: [
                    { hrid: ABILITY_ORDER_HRID, level: 0 },
                    { hrid: '/items/sinister_cape', level: 3 },
                ],
            }).combat
        ).toEqual([{ hrid: '/items/sinister_cape', level: 3 }]);
        expect(clampLevelFor(ABILITY_ORDER_HRID, 5)).toBe(5);
    });

    test('three ordinary abilities have 5 other orders; always-ready ones stay last', () => {
        expect(consistentAbilityOrders([SMACK, POKE, TOUGHNESS], [])).toHaveLength(6);
        const orders = consistentAbilityOrders([SMACK, FIREBALL, POKE, TOUGHNESS], [FIREBALL]);
        expect(orders).toHaveLength(6);
        expect(orders.every((order) => order[3] === FIREBALL)).toBe(true);
    });

    test('four ordinary abilities give 23 alternatives and a keep option, with the special slot untouched', () => {
        const dto = loadout([
            ability(FIERCE_AURA, 10),
            ability(SMACK, 12),
            ability(POKE, 14),
            ability(TOUGHNESS, 16),
            ability(QUICK_STRIKE, 18),
        ]);
        const built = buildCombatAbilityOrderCandidates([dto], gameData);
        expect(built.candidates).toHaveLength(24);
        expect(built.candidates.filter((option) => option.keepCurrent)).toHaveLength(1);
        for (const option of built.candidates) {
            expect(advisor.candidateAppliesToDTO(option, dto, gameData)).toBe(true);
            expect(advisor.applyCandidateToDTO(dto, option).abilities[0].hrid).toBe(FIERCE_AURA);
        }
        // a loadout with a different set is not reached by them
        const other = loadout([ability(FIERCE_AURA, 10), ability(SMACK, 12), ability(POKE, 14), null, null]);
        expect(advisor.candidateAppliesToDTO(built.candidates[0], other, gameData)).toBe(false);
    });

    test('finds the better order with a stubbed sim and reports cost 0', async () => {
        // Poke first is what wins
        state.sim = async ({ playerDTOs }) => {
            const first = playerDTOs[0].abilities[1].hrid;
            const win = first === POKE ? 0.7 : 0.5;
            return { encounters: win * 1000, labyAttemptCount: 1000, experienceGained: {}, simulatedTime: 1 };
        };
        const dto = loadout([ability(FIERCE_AURA, 10), ability(SMACK, 12), ability(POKE, 14), ability(FIREBALL, 16)]);
        const built = buildCombatAbilityOrderCandidates([dto], gameData);
        expect(built.candidates).toHaveLength(2);
        const raw = await advisor.runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    {
                        monsterHrid: '/monsters/mimic',
                        monsterName: 'mimic',
                        roomLevel: 50,
                        dto,
                        loadoutName: 'mimic loadout',
                    },
                ],
                crates: [],
                hours: 1,
                precision: null,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: [],
                extraCandidates: built.candidates,
            },
            () => {}
        );
        const row = mergeCheckedAbilityRows(raw, gameData).results[0];
        expect(row.cost).toBe(0);
        expect(row.candidate.description).toBe('Ability order (Order: Poke → Smack → Fireball)');
        expect(row.fights[0].note).toBe('Order: Poke → Smack → Fireball');
        expect(row.attemptsDelta).toBeLessThan(0);
        expect(row.appliedFights).toBe(1);
        expect(names(advisor.applyCandidateToDTO(dto, built.candidates[0]))).toEqual([
            'Fierce Aura',
            'Poke',
            'Smack',
            'Fireball',
        ]);
    });
});

describe('the ability order check keeps the current order when it is best', () => {
    const runOrder = async (dto, win) => {
        state.sim = async ({ playerDTOs }) => ({
            encounters: win(playerDTOs[0].abilities[1].hrid) * 1000,
            labyAttemptCount: 1000,
            experienceGained: {},
            simulatedTime: 1,
        });
        const built = orderApi.buildCombatAbilityOrderCandidates([dto], gameData);
        const raw = await advisor.runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    { monsterHrid: '/monsters/mimic', monsterName: 'mimic', roomLevel: 50, dto, loadoutName: 'mimic' },
                ],
                crates: [],
                hours: 1,
                precision: null,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: [],
                extraCandidates: built.candidates,
            },
            () => {}
        );
        return { built, row: mergeCheckedAbilityRows(raw, gameData).results[0] };
    };

    test('the current order stays when no alternative beats it', async () => {
        const dto = loadout([ability(FIERCE_AURA, 10), ability(SMACK, 12), ability(POKE, 14), ability(FIREBALL, 16)]);
        // Smack first is the current order and is best; the alternative is worse
        const { row } = await runOrder(dto, (first) => (first === SMACK ? 0.7 : 0.4));
        expect(row.candidate.description).toBe('Ability order (Order: current order is best)');
        expect(row.fights[0].note).toBe('Order: current order is best');
        expect(row.fights[0].winRateDelta).toBe(0);
        expect(row.attemptsDelta).toBe(0);
        expect(row.appliedFights).toBe(1);
    });

    test('a loadout with one legal order is reached and reports the current order', async () => {
        const dto = loadout([ability(FIERCE_AURA, 10), ability(SMACK, 12), ability(FIREBALL, 16)]);
        const { built, row } = await runOrder(dto, () => 0.5);
        expect(built.candidates.length).toBeGreaterThan(0);
        expect(row.candidate.description).toBe('Ability order (Order: current order is best)');
        expect(row.attemptsDelta).toBe(0);
    });
});

describe('a character who already holds the ability higher', () => {
    test('the sim uses their level, labeled, and the books are free', () => {
        state.abilities = [{ abilityHrid: CRIT_AURA, level: 200, experience: 0 }];
        const dto = loadout([ability(FIERCE_AURA, 200), ability(SMACK, 12), ability(POKE, 14), ability(TOUGHNESS, 16)]);
        const built = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [dto], gameData);
        const option = built.candidates[0];
        expect(option.upgradeLevel).toBe(200);
        expect(option.description).toBe('Critical Aura 200, you have it at 200');
        expect(option.cost).toBe(0);
        expect(advisor.applyCandidateToDTO(dto, option).abilities[0]).toEqual({
            hrid: CRIT_AURA,
            level: 200,
            triggers: null,
        });
    });

    test('a typed level above theirs is still what is simulated and bought', () => {
        state.abilities = [{ abilityHrid: CRIT_AURA, level: 5, experience: 0 }];
        const built = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [fourAbilities()], gameData);
        expect(built.candidates[0].upgradeLevel).toBe(7);
        expect(built.candidates[0].description).toBe('Critical Aura 7');
        expect(built.candidates[0].cost).toBe(2000);
    });

    test('a loadout casting it below their level is levelled up to their level', () => {
        state.abilities = [{ abilityHrid: CRIT_AURA, level: 200, experience: 0 }];
        const casting = loadout([
            ability(CRIT_AURA, 150),
            ability(SMACK, 12),
            ability(POKE, 14),
            ability(TOUGHNESS, 16),
        ]);
        const built = buildCombatAbilityCandidates({ hrid: CRIT_AURA, level: 7 }, [casting], gameData);
        expect(built.candidates[0].levelUp).toBe(true);
        expect(advisor.applyCandidateToDTO(casting, built.candidates[0]).abilities[0].level).toBe(200);
    });
});

describe('row actions for a checked ability', () => {
    const row = (cost) => ({
        cost,
        costDetail: { books: { books: cost > 0 ? 3 : 0 } },
        candidate: {
            type: 'ability_swap',
            checkedAbility: true,
            slot: 'ability_0',
            upgradeHrid: CRIT_AURA,
            upgradeLevel: 7,
        },
    });

    test('no buttons at cost 0; Watch and Market but no Save when books are needed', async () => {
        const { upgradeRowActionsHtml } = await import('./combat-sim-ui.js');
        expect(upgradeRowActionsHtml(row(0))).toBe('');
        const html = upgradeRowActionsHtml(row(3000));
        expect(html).not.toContain('Save for this');
        expect(html).toContain('Watch');
        expect(html).toContain('Market');
    });
});

describe('the ability order section is ranked apart from the paid swaps', () => {
    const { extractAbilityOrderSection, buildCombatAbilityOrderCandidates } = orderApi;
    const fight = (dto, loadoutId, loadoutName) => ({
        monsterHrid: '/monsters/mimic',
        monsterName: 'mimic',
        roomLevel: 50,
        dto,
        loadoutId,
        loadoutName,
    });
    const run = async (fights, win) => {
        state.sim = async ({ playerDTOs }) => ({
            encounters: win(playerDTOs[0].abilities.slice(1).map((a) => a.hrid)) * 1000,
            labyAttemptCount: 1000,
            experienceGained: {},
            simulatedTime: 1,
        });
        const candidates = buildCombatAbilityOrderCandidates(
            fights.map((f) => f.dto),
            gameData
        ).candidates;
        return advisor.runLabyrinthAllFightsAnalysis(
            {
                fights,
                crates: [],
                hours: 1,
                precision: null,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: [],
                extraCandidates: candidates,
            },
            () => {}
        );
    };

    test('the order rows leave the results and come back ranked by expected attempts, current as the baseline', async () => {
        const dto = fourAbilities();
        const raw = await run([fight(dto, 1, 'Mimic Lab')], (order) =>
            order[0] === POKE ? 0.7 : order[0] === SMACK ? 0.5 : 0.4
        );
        const { analysis, section } = extractAbilityOrderSection(raw, gameData);
        expect(analysis.results.some((row) => row.candidate.abilityOrder)).toBe(false);
        expect(section.groups).toHaveLength(1);
        const group = section.groups[0];
        expect(group.loadoutName).toBe('Mimic Lab');
        expect(group.currentName).toBe('Smack → Poke → Toughness');
        // 3 abilities: 6 orders, one of them the current one
        expect(group.orders).toHaveLength(5);
        const deltas = group.orders.map((o) => o.attemptsDelta);
        expect(deltas).toEqual([...deltas].sort((a, b) => a - b));
        expect(group.orders[0].order[0]).toBe(POKE);
        expect(group.orders[0].attemptsDelta).toBeLessThan(0);
        expect(group.orders[0].runClearDelta).toBeGreaterThan(0);
        expect(group.orders[0].attemptsDeltaNoise).toBeGreaterThan(0);
        expect(group.orders.every((o) => o.name.includes(' → '))).toBe(true);
    });

    test('equal orders are all within noise', async () => {
        const raw = await run([fight(fourAbilities(), 1, 'Mimic Lab')], () => 0.5);
        const { section } = extractAbilityOrderSection(raw, gameData);
        expect(section.groups[0].orders.every((o) => !o.significant)).toBe(true);
    });

    test('two loadouts with different ability sets are two groups, each ranked on its own fights', async () => {
        const a = fourAbilities();
        const b = loadout([ability(FIERCE_AURA, 10), ability(SMACK, 12), ability(POKE, 14), ability(FIREBALL, 16)]);
        const raw = await run([fight(a, 1, 'A'), fight(b, 2, 'B')], (order) => (order[0] === POKE ? 0.7 : 0.4));
        const { section } = extractAbilityOrderSection(raw, gameData);
        expect(section.groups.map((g) => g.loadoutName)).toEqual(['A', 'B']);
        expect(section.groups[0].orders.length).toBe(5);
        expect(section.groups[1].orders.length).toBe(1);
        expect(section.groups[1].orders[0].order[0]).toBe(POKE);
    });

    test('a loadout with a single ordinary ability has no group; a run with no order rows has no section', async () => {
        const one = loadout([ability(FIERCE_AURA, 10), ability(SMACK, 12)]);
        const raw = await run([fight(fourAbilities(), 1, 'A'), fight(one, 2, 'One')], () => 0.5);
        const { section } = extractAbilityOrderSection(raw, gameData);
        expect(section.groups.map((g) => g.loadoutName)).toEqual(['A']);
        const bare = { baseline: raw.baseline, results: [], context: raw.context };
        expect(extractAbilityOrderSection(bare, gameData).section).toBeNull();
    });

    test('a paid swap in the same run stays in the results untouched', async () => {
        const raw = await run([fight(fourAbilities(), 1, 'A')], (order) => (order[0] === POKE ? 0.9 : 0.4));
        const paid = { candidate: { description: 'Paid', type: 'enhancement' }, fights: [], attemptsDelta: -1 };
        const { analysis } = extractAbilityOrderSection({ ...raw, results: [...raw.results, paid] }, gameData);
        expect(analysis.results).toEqual([paid]);
    });
});
