/**
 * What a guild shrine row costs, and whose shrine buildings cap it.
 *
 * The worst failure here is a shrine row ranked cheaper than it is with nothing on screen saying so, so
 * these tests are about the price's *ending*: every way the guild token half can come back (a client rate,
 * a capture, the game's per-color table, the setting's guess, nothing at all), an unpriced credit, a hole in
 * the game's own level table, and a party member or imported profile whose guild is not the local one.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const guild = vi.hoisted(() => ({
    detailMap: {},
    /** shrineHrid → the level the LOCAL guild has built it to */
    shrineLevels: {},
}));

/** What the token valuation the advisor asks for comes back as, and what it was asked with */
const token = vi.hoisted(() => ({ valuation: null, hydrated: 0, askedWith: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getGuildBuildingLevel: (hrid) => guild.shrineLevels[hrid] || 0,
        getInventory: () => [],
        getSkills: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        characterData: { characterAbilities: [] },
    },
}));
vi.mock('./combat-sim-adapter.js', () => ({
    seedSimPriceCache: vi.fn((cache) => cache),
    recomputeLevelGapDebuffs: vi.fn(),
    buildGameDataPayload: vi.fn(),
    calculateSimRevenue: vi.fn(),
    getGuildBuffDetailMap: () => guild.detailMap,
    // The adapter's own rule: the highest level the cost table lists
    guildBuffMaxLevel: (detail) =>
        Math.max(
            0,
            ...Object.keys(detail?.levelCosts || {})
                .map(Number)
                .filter(Number.isFinite)
        ),
    applyGuildBuffLevel: (buffs, detail, level) => [{ typeHrid: detail.buffs[0].typeHrid, level }],
}));
vi.mock('../../utils/guild-credit-pricing.js', () => ({
    buildGoldPerCredit: vi.fn(() => ({})),
    priceGuildCreditCosts: vi.fn((costs) => {
        const lines = (costs || []).map(({ itemHrid, count }) => ({
            itemHrid,
            name: itemHrid,
            count,
            goldEach: itemHrid === '/items/unpriced_credit' ? null : 100,
            gold: itemHrid === '/items/unpriced_credit' ? null : 100 * count,
        }));
        const unpriced = lines.filter((line) => line.gold === null).map((line) => line.name);
        return {
            lines,
            total: unpriced.length > 0 ? null : lines.reduce((sum, line) => sum + line.gold, 0),
            unpriced,
        };
    }),
}));
vi.mock('../guild/guild-token-value.js', () => ({
    explainGuildTokenValue: vi.fn((mode, options) => {
        token.askedWith.push(options);
        return token.valuation;
    }),
    hydrateTokenExchangeCaptures: vi.fn(async () => {
        token.hydrated += 1;
    }),
    describeGuildTokenGold: vi.fn((tokens, _mode, options = {}) => {
        const rate = options.valuation?.gold;
        if (!(tokens > 0) || !(rate > 0)) return null;
        return {
            gold: tokens * rate,
            text: `≈${tokens * rate}g via credit exchange`,
            title: '',
            valuation: options.valuation,
        };
    }),
}));

const {
    generateCandidates,
    generateGuildShrineCandidates,
    explainUpgradeCost,
    calculateUpgradeCost,
    planWithinBudget,
    runUpgradeAnalysis,
    runLabyrinthUpgradeAnalysis,
    runLabyrinthAllFightsAnalysis,
    runSkillingUpgradeAnalysis,
} = await import('./upgrade-advisor.js');

const FORCE_HRID = '/guild_buffs/force_combat';
const FORCE = {
    hrid: FORCE_HRID,
    shrineHrid: '/guild_shrines/force',
    isCombat: true,
    buffs: [{ typeHrid: '/buff_types/damage', ratioBoost: 0.003, ratioBoostLevelBonus: 0.003 }],
    levelCosts: {
        1: { guildTokenCost: 100, creditCosts: [{ itemHrid: '/items/brown_guild_credit', count: 10 }] },
        2: { guildTokenCost: 200, creditCosts: [{ itemHrid: '/items/brown_guild_credit', count: 20 }] },
        3: { guildTokenCost: 300, creditCosts: [{ itemHrid: '/items/brown_guild_credit', count: 30 }] },
    },
};
const SKILLING = {
    hrid: '/guild_buffs/rarity_skilling',
    shrineHrid: '/guild_shrines/rarity',
    isCombat: false,
    buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.002, flatBoostLevelBonus: 0.002 }],
    levelCosts: { 1: { guildTokenCost: 10, creditCosts: [] }, 2: { guildTokenCost: 20, creditCosts: [] } },
};

/** A rate the token valuation comes back with, shaped as `explainGuildTokenValue` returns it */
function rate(gold, source = 'client', assumed = false) {
    return {
        gold,
        creditsPerToken: 1,
        creditItemHrid: '/items/purple_guild_credit',
        goldPerCredit: gold,
        source,
        assumed,
        note: '',
    };
}
const NO_RATE = {
    gold: null,
    creditsPerToken: null,
    creditItemHrid: null,
    goldPerCredit: null,
    source: 'unknown',
    assumed: false,
    note: null,
};

/** The one row 0 -> 1 of Force, priced */
function forceRow(over = {}) {
    guild.detailMap = { [FORCE_HRID]: { ...FORCE, ...over } };
    const [candidate] = generateGuildShrineCandidates({ guildShrineLevels: { [FORCE_HRID]: 0 } }, { targetLevel: 1 });
    return candidate;
}

beforeEach(() => {
    guild.detailMap = { [FORCE_HRID]: FORCE, '/guild_buffs/rarity_skilling': SKILLING };
    guild.shrineLevels = {};
    token.valuation = rate(10);
    token.hydrated = 0;
    token.askedWith = [];
});

describe('the token half of a shrine price, every way it can end', () => {
    test('a rate from the client prices the tokens and the row is whole', () => {
        token.valuation = rate(10, 'client');
        const explained = explainUpgradeCost(forceRow(), {});

        // 10 credits at 100 + 100 tokens at 10
        expect(explained.net).toBe(2000);
        expect(explained.partialCost).toBeUndefined();
        expect(explained.guild.tokenSource).toBe('client');
    });

    test('a rate from a capture or from the per-color table is whole too: not a guess', () => {
        for (const source of ['captured', 'default']) {
            token.valuation = rate(10, source);
            const explained = explainUpgradeCost(forceRow(), {});

            expect(explained.net).toBe(2000);
            expect(explained.partialCost).toBeUndefined();
        }
    });

    test('the advisor asks for the per-color table before the setting', () => {
        explainUpgradeCost(forceRow(), {});

        expect(token.askedWith.at(-1)).toEqual({ context: 'profit', defaultRates: true });
    });

    test("the setting's guess ranks the row but marks it assumed, in the row and in its breakdown", () => {
        token.valuation = rate(10, 'setting', true);
        const row = forceRow();
        const explained = explainUpgradeCost(row, {});

        expect(explained.net).toBe(2000);
        expect(explained.partialCostKind).toBe('assumed');
        expect(explained.partialCost).toMatch(/assumed/);
        expect(explained.guild.rankedNote).toMatch(/guess/);
        expect(calculateUpgradeCost(row, {})).toBe(2000);
    });

    test('no rate at all leaves the credits as a floor and says so', () => {
        token.valuation = NO_RATE;
        const explained = explainUpgradeCost(forceRow(), {});

        expect(explained.net).toBe(1000);
        expect(explained.partialCost).toBe('guild tokens not priced');
        expect(explained.partialCostKind).toBe('floor');
    });

    test('no rate and no credits is no price, never a free level', () => {
        token.valuation = NO_RATE;
        const explained = explainUpgradeCost(
            forceRow({ levelCosts: { 1: { guildTokenCost: 100, creditCosts: [] } } }),
            {}
        );

        expect(explained.net).toBeNull();
        expect(explained.partialCost).toBeUndefined();
    });

    test('an unpriced credit makes the whole price unknown, not a partial one', () => {
        token.valuation = rate(10);
        const explained = explainUpgradeCost(
            forceRow({
                levelCosts: {
                    1: { guildTokenCost: 100, creditCosts: [{ itemHrid: '/items/unpriced_credit', count: 5 }] },
                },
            }),
            {}
        );

        expect(explained.net).toBeNull();
        expect(explained.partialCost).toBeUndefined();
        expect(explained.unpriced).toEqual(['/items/unpriced_credit']);
    });

    test('a level with no tokens needs no rate to be whole', () => {
        token.valuation = NO_RATE;
        const explained = explainUpgradeCost(
            forceRow({
                levelCosts: {
                    1: { guildTokenCost: 0, creditCosts: [{ itemHrid: '/items/brown_guild_credit', count: 10 }] },
                },
            }),
            {}
        );

        expect(explained.net).toBe(1000);
        expect(explained.partialCost).toBeUndefined();
    });

    test('a hole in the level table makes the cost unknown, and is named', () => {
        // Level 2 is missing between 1 and 3; the table's top (3) is what the target was cut down to
        const row = forceRow({ levelCosts: { 1: FORCE.levelCosts[1], 3: FORCE.levelCosts[3] } });
        guild.detailMap = {
            [FORCE_HRID]: { ...FORCE, levelCosts: { 1: FORCE.levelCosts[1], 3: FORCE.levelCosts[3] } },
        };
        const [toThree] = generateGuildShrineCandidates({ guildShrineLevels: { [FORCE_HRID]: 0 } }, { targetLevel: 3 });

        expect(row.missingCostLevels).toEqual([]);
        expect(toThree.missingCostLevels).toEqual([2]);
        const explained = explainUpgradeCost(toThree, {});
        expect(explained.net).toBeNull();
        expect(explained.guild.rankedNote).toMatch(/level 2/);
        expect(calculateUpgradeCost(toThree, {})).toBeNull();
    });

    test('a level the game lists at zero cost is free, which is not a hole', () => {
        token.valuation = NO_RATE;
        const row = forceRow({ levelCosts: { 1: { guildTokenCost: 0, creditCosts: [] } } });

        expect(row.missingCostLevels).toEqual([]);
        expect(explainUpgradeCost(row, {}).net).toBe(0);
    });
});

describe('a plan total says what it leaves out or guesses', () => {
    const pick = (description, cost, extra = {}) => ({
        candidate: {
            type: 'guild_shrine',
            slot: `guild_shrine|${description}`,
            buffHrid: `/guild_buffs/${description}`,
            upgradeLevel: 1,
            description,
        },
        cost,
        attemptsDelta: -2,
        significant: true,
        ...extra,
    });

    test('each distinct reason once, with whether it is a floor or a guess', () => {
        const plan = planWithinBudget(
            [
                pick('Force Shrine Lv0 → Lv1', 1000, {
                    partialCost: 'guild tokens not priced',
                    partialCostKind: 'floor',
                }),
                pick('Tempo Shrine Lv0 → Lv1', 2000, {
                    partialCost: 'guild tokens not priced',
                    partialCostKind: 'floor',
                }),
                pick('Wisdom Shrine Lv0 → Lv1', 3000, {
                    costDetail: {
                        partialCost: 'guild tokens valued at an assumed exchange rate',
                        partialCostKind: 'assumed',
                    },
                }),
            ],
            10_000
        );

        expect(plan.partialCostPicks).toHaveLength(3);
        expect(plan.partialCostNotes).toEqual([
            { reason: 'guild tokens not priced', kind: 'floor' },
            { reason: 'guild tokens valued at an assumed exchange rate', kind: 'assumed' },
        ]);
    });

    test('a plan of whole prices carries no note', () => {
        const plan = planWithinBudget([pick('Force Shrine Lv0 → Lv1', 1000)], 10_000);

        expect(plan.partialCostPicks).toEqual([]);
        expect(plan.partialCostNotes).toEqual([]);
    });
});

describe("another player's guild is not the local guild", () => {
    const options = (extra) => ({ combat: true, targetLevel: 3, capToGuildLevel: true, ...extra });
    const dto = { guildShrineLevels: { [FORCE_HRID]: 0 } };

    beforeEach(() => {
        // The LOCAL guild has built its Force shrine to level 1
        guild.shrineLevels = { '/guild_shrines/force': 1 };
    });

    test("the local character is capped by, and annotated against, its own guild's building", () => {
        const [row] = generateGuildShrineCandidates(dto, options());

        expect(row.upgradeLevel).toBe(1);
        expect(row.shrineLevel).toBe(1);
        expect(row.shrineLevelKnown).toBe(true);
    });

    test('a party member or imported profile is neither capped nor annotated with the local building', () => {
        const [row] = generateGuildShrineCandidates(dto, options({ isSelf: false }));

        expect(row.upgradeLevel).toBe(3);
        expect(row.shrineLevelKnown).toBe(false);
        expect(row.needsShrineLevel).toBeNull();
    });

    test('without the cap the local note still reads the local building, and a stranger gets none', () => {
        const [own] = generateGuildShrineCandidates(dto, { targetLevel: 3 });
        const [other] = generateGuildShrineCandidates(dto, { targetLevel: 3, isSelf: false });

        expect(own.needsShrineLevel).toBe(3);
        expect(other.needsShrineLevel).toBeNull();
        expect(other.shrineLevel).toBe(0);
    });

    test('generateCandidates carries isSelf through to the shrine generator', () => {
        const run = (isSelf) =>
            generateCandidates(dto, {}, 'guild_shrine', 0, 'increment', false, null, null, 0, null, null, 3, {
                guildShrineCapToGuild: true,
                isSelf,
            });

        expect(run(true)[0].upgradeLevel).toBe(1);
        expect(run(false)[0].upgradeLevel).toBe(3);
    });

    test('a profile with no level map at all offers nothing, where a guildless character with {} still can', () => {
        expect(generateGuildShrineCandidates({}, { isSelf: false })).toEqual([]);
        expect(generateGuildShrineCandidates({ guildShrineLevels: undefined }, {})).toEqual([]);
        expect(generateGuildShrineCandidates({ guildShrineLevels: {} }, {})).not.toEqual([]);
    });

    test('the skilling generator takes the same cap and stranger rule', () => {
        guild.shrineLevels = { '/guild_shrines/rarity': 1 };
        const levels = { guildShrineLevels: { '/guild_buffs/rarity_skilling': 0 } };

        const [own] = generateGuildShrineCandidates(levels, { combat: false, capToGuildLevel: true, steps: 2 });
        const rows = generateGuildShrineCandidates(levels, {
            combat: false,
            capToGuildLevel: true,
            steps: 2,
            isSelf: false,
        });

        expect(own.upgradeLevel).toBe(1);
        expect(rows.map((row) => row.upgradeLevel)).toEqual([1, 2]);
    });
});

describe('the analyses load the stored exchange readings first', () => {
    test.each([
        ['runUpgradeAnalysis', runUpgradeAnalysis],
        ['runLabyrinthUpgradeAnalysis', runLabyrinthUpgradeAnalysis],
        ['runLabyrinthAllFightsAnalysis', runLabyrinthAllFightsAnalysis],
        ['runSkillingUpgradeAnalysis', runSkillingUpgradeAnalysis],
    ])('%s awaits the hydration before anything is priced', async (_name, run) => {
        // buildGameDataPayload is mocked to nothing, so each run ends at "No game data" right after the await
        await expect(run({}, () => {}, {})).rejects.toThrow();

        expect(token.hydrated).toBe(1);
    });

    test('the skilling run forwards the Upgrade tab cap and the local-character flag to the generator', () => {
        const source = readFileSync(new URL('./upgrade-advisor.js', import.meta.url), 'utf8');
        const call = source.slice(source.indexOf('generateGuildShrineCandidates(editorDTO, {'));

        expect(call.slice(0, 260)).toMatch(
            /combat: false,\s+capToGuildLevel: Boolean\(guildShrineCapToGuild\),\s+isSelf,/
        );
    });
});
