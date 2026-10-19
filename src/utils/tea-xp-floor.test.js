/**
 * XP-floor tea choice (issue #552): for one action, the best-gold tea setup that keeps at least a
 * set share of the top XP/hr. The picker is tested directly on synthetic candidates (boundaries,
 * ties, unpriced); the scoring join is tested against a brute-force pass over findOptimalTeas.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameData: null, skills: [], equipment: new Map() }));
const prices = vi.hoisted(() => ({ byHrid: {}, estimated: new Set() }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
        getSkills: () => state.skills,
        getEquipment: () => state.equipment,
        getHouseRooms: () => new Map(),
        getCurrentActions: () => [],
        getCommunityBuffLevel: () => 0,
        getAchievementBuffFlatBoost: () => 0,
        getPersonalBuffFlatBoost: () => 0,
        characterData: {},
    },
}));
vi.mock('./experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalWisdom: 0, breakdown: { consumableWisdom: 0 }, charmExperience: 0 }),
}));
vi.mock('../features/market/alchemy-profit-calculator.js', () => ({ default: {} }));
vi.mock('./market-data.js', () => ({
    getItemPrice: (hrid) => (hrid in prices.byHrid ? prices.byHrid[hrid] : null),
    getItemPriceInfo: (hrid) => {
        if (!(hrid in prices.byHrid)) return { price: null, source: null, estimated: false };
        const estimated = prices.estimated.has(hrid);
        return { price: prices.byHrid[hrid], source: estimated ? 'value' : 'book', estimated };
    },
}));

const { findOptimalTeas, findXpFloorChoice, pickXpFloorChoice, normalizeXpFloorPercent } =
    await import('./tea-optimizer.js');

const ACTION = 'Pincer Gloves';
const tea = (buffs) => ({
    consumableDetail: { usableInActionTypeMap: { '/action_types/cheesesmithing': true }, buffs },
});

function setWorld({ outputPrice = 400, teaPrices = {} } = {}) {
    state.gameData = {
        itemDetailMap: {
            '/items/giant_pouch': { equipmentDetail: { combatStats: { drinkSlots: 2 } } },
            '/items/crab_pincer': { name: 'Crab Pincer' },
            '/items/pincer_gloves': { name: 'Pincer Gloves' },
            '/items/efficiency_tea': {
                name: 'Efficiency Tea',
                ...tea([
                    { uniqueHrid: '/buff_uniques/efficiency_tea', typeHrid: '/buff_types/efficiency', flatBoost: 0.1 },
                ]),
            },
            '/items/wisdom_tea': {
                name: 'Wisdom Tea',
                ...tea([{ uniqueHrid: '/buff_uniques/wisdom_tea', typeHrid: '/buff_types/wisdom', flatBoost: 0.12 }]),
            },
            '/items/artisan_tea': {
                name: 'Artisan Tea',
                ...tea([{ uniqueHrid: '/buff_uniques/artisan_tea', typeHrid: '/buff_types/artisan', flatBoost: 0.1 }]),
            },
        },
        actionDetailMap: {
            '/actions/cheesesmithing/pincer_gloves': {
                type: '/action_types/cheesesmithing',
                function: '/action_functions/production',
                category: '/action_categories/cheesesmithing/hands',
                name: ACTION,
                baseTimeCost: 60e9,
                levelRequirement: { skillHrid: '/skills/cheesesmithing', level: 1 },
                experienceGain: { skillHrid: '/skills/cheesesmithing', value: 1600 },
                inputItems: [{ itemHrid: '/items/crab_pincer', count: 2 }],
                outputItems: [{ itemHrid: '/items/pincer_gloves', count: 1 }],
            },
        },
    };
    state.skills = [{ skillHrid: '/skills/cheesesmithing', level: 100 }];
    state.equipment = new Map([['/item_locations/pouch', { itemHrid: '/items/giant_pouch', enhancementLevel: 0 }]]);
    prices.byHrid = {
        '/items/crab_pincer': 50,
        '/items/pincer_gloves': outputPrice,
        '/items/efficiency_tea': 200,
        '/items/wisdom_tea': 200,
        '/items/artisan_tea': 200,
        ...teaPrices,
    };
    prices.estimated = new Set();
}

beforeEach(() => setWorld());

const cand = (name, xp, gold, extra = {}) => ({ teas: [`/items/${name}`], names: [name], xp, gold, ...extra });

describe('pickXpFloorChoice', () => {
    const A = cand('a', 100, -100);
    const B = cand('b', 96, 20);
    const C = cand('c', 94, 200);

    test('the issue example: B wins at a 95% floor, A wins at 100%', () => {
        const at95 = pickXpFloorChoice([A, B, C], 95);
        expect(at95.status).toBe('ok');
        expect(at95.pick.names).toEqual(['b']);
        expect(at95.baseline.names).toEqual(['a']);
        expect(at95.xpRetainedPercent).toBeCloseTo(96, 9);
        expect(at95.goldDelta).toBe(120);

        const at100 = pickXpFloorChoice([A, B, C], 100);
        expect(at100.status).toBe('same');
        expect(at100.pick.names).toEqual(['a']);
    });

    test('a combo exactly on the floor qualifies; one just under does not', () => {
        expect(pickXpFloorChoice([A, C], 94).pick.names).toEqual(['c']);
        expect(pickXpFloorChoice([A, cand('c', 94.999, 200)], 95).status).toBe('same');
        expect(pickXpFloorChoice([A, cand('c', 95, 200)], 95).pick.names).toEqual(['c']);
    });

    test('a winner outside the single-objective top five is still found', () => {
        const many = [
            cand('x1', 100, 0),
            cand('x2', 99.9, 1),
            cand('x3', 99.8, 2),
            cand('x4', 99.7, 3),
            cand('x5', 99.6, 4),
            cand('hidden', 97, 500),
        ];
        expect(pickXpFloorChoice(many, 95).pick.names).toEqual(['hidden']);
    });

    test('keeps a loss as a loss: the least-loss qualifying combo wins', () => {
        const r = pickXpFloorChoice([cand('a', 100, -500), cand('b', 98, -300), cand('c', 80, -10)], 95);
        expect(r.pick.names).toEqual(['b']);
        expect(r.goldDelta).toBe(200);
    });

    test('ties on gold go to more XP, then fewer teas, then key order', () => {
        const r = pickXpFloorChoice([cand('top', 100, 5), cand('p', 98, 50), cand('q', 99, 50)], 95);
        expect(r.pick.names).toEqual(['q']);
        const two = { teas: ['/items/m', '/items/n'], names: ['m', 'n'], xp: 99, gold: 50 };
        expect(pickXpFloorChoice([cand('top', 100, 5), two, cand('z', 99, 50)], 95).pick.names).toEqual(['z']);
    });

    test('an unpriced combo is not chosen while a priced one qualifies, and is flagged otherwise', () => {
        const cheapLooking = cand('free', 98, 900, { unpriced: true });
        const r = pickXpFloorChoice([cand('top', 100, 0), cheapLooking, cand('real', 96, 100)], 95);
        expect(r.pick.names).toEqual(['real']);

        const allUnpriced = pickXpFloorChoice(
            [cand('top', 100, 0, { unpriced: true }), cand('free', 98, 900, { unpriced: true })],
            95
        );
        expect(allUnpriced.pick.names).toEqual(['free']);
        expect(allUnpriced.pick.unpriced).toBe(true);
    });

    test('a gold figure that is not a number is never valued at 0', () => {
        expect(pickXpFloorChoice([cand('top', 100, NaN), cand('b', 99, NaN)], 95).status).toBe('no-gold');
        const mixed = pickXpFloorChoice([cand('top', 100, NaN), cand('b', 99, -40)], 95);
        expect(mixed.pick.names).toEqual(['b']);
        expect(mixed.goldDelta).toBeNull();
    });

    test('no candidates, and no XP at all', () => {
        expect(pickXpFloorChoice([], 95).status).toBe('none');
        expect(pickXpFloorChoice(undefined, 95).status).toBe('none');
        expect(pickXpFloorChoice([cand('a', 0, 50), cand('b', 0, 60)], 95).status).toBe('no-xp');
    });

    test('the floor is clamped to its range and falls back to 95 when unusable', () => {
        expect(normalizeXpFloorPercent(10)).toBe(50);
        expect(normalizeXpFloorPercent(500)).toBe(100);
        expect(normalizeXpFloorPercent('80')).toBe(80);
        expect(normalizeXpFloorPercent(undefined)).toBe(95);
        expect(normalizeXpFloorPercent('abc')).toBe(95);
        expect(pickXpFloorChoice([A, B, C], 'abc').floorPercent).toBe(95);
    });
});

describe('findXpFloorChoice', () => {
    const run = (extra = {}) => findXpFloorChoice('cheesesmithing', { actionName: ACTION, floorPercent: 95, ...extra });
    const key = (teas) => [...teas].sort().join('|');
    const allScored = () => {
        const pass = (goal) =>
            findOptimalTeas('cheesesmithing', goal, null, ACTION, null, null, null, null, null, {
                collectAll: true,
                teaSetGoal: 'gold',
            }).evaluatedAll;
        const gold = new Map(pass('gold').map((r) => [key(r.teas), r]));
        return pass('xp').map((r) => ({ ...r, xp: r.score, gold: gold.get(key(r.teas)).score }));
    };

    test('matches an exhaustive pass over every combination', () => {
        const all = allScored();
        const best = Math.max(...all.map((c) => c.xp));
        for (const floor of [50, 90, 95, 99, 100]) {
            const expected = all
                .filter((c) => c.xp >= best * (floor / 100) * (1 - 1e-9))
                .sort((a, b) => b.gold - a.gold || b.xp - a.xp)[0];
            const got = run({ floorPercent: floor });
            expect(key(got.pick.teas)).toBe(key(expected.teas));
            expect(got.baseline.xp).toBe(best);
        }
    });

    test('the percent alone changes the outcome, with an exact boundary', () => {
        expect(run({ floorPercent: 96 }).status).toBe('same');
        const loose = run({ floorPercent: 95 });
        expect(loose.status).toBe('ok');
        expect(loose.pick.names).toEqual(['Wisdom Tea']);
        expect(loose.goldDelta).toBeGreaterThan(0);
        // Wisdom Tea alone keeps 95.2154% of the top XP
        expect(run({ floorPercent: 95.22 }).status).toBe('same');
        expect(run({ floorPercent: 95.2 }).status).toBe('ok');
    });

    test('pinned and banned teas shape both the XP reference and the eligible set', () => {
        const pinned = run({ constraints: { pinned: new Set(['/items/artisan_tea']), banned: new Set() } });
        expect(pinned.baseline.teas).toContain('/items/artisan_tea');
        expect(pinned.pick.teas).toContain('/items/artisan_tea');

        const banned = run({ constraints: { pinned: new Set(), banned: new Set(['/items/efficiency_tea']) } });
        expect(banned.baseline.teas).not.toContain('/items/efficiency_tea');
        expect(banned.pick.teas).not.toContain('/items/efficiency_tea');
        expect(banned.baseline.xp).toBeLessThan(run().baseline.xp);
    });

    test('conflicting constraints leave no legal combination', () => {
        const wisdom = '/items/wisdom_tea';
        expect(run({ constraints: { pinned: new Set([wisdom]), banned: new Set([wisdom]) } }).status).toBe('none');
    });

    test('an unpriced tea is flagged and never counted as a free winner', () => {
        delete prices.byHrid['/items/efficiency_tea'];
        const r = run();
        expect(r.baseline.unpriced).toBe(true);
        expect(r.pick.unpriced).toBe(false);
        expect(r.pick.teas).not.toContain('/items/efficiency_tea');
    });

    test('an unpriced action input flags every candidate rather than hiding it', () => {
        delete prices.byHrid['/items/crab_pincer'];
        const r = run();
        expect(r.status).toMatch(/ok|same/);
        expect(r.pick.unpriced).toBe(true);
        expect(r.baseline.unpriced).toBe(true);
    });

    test('a losing action still gets a least-loss pick', () => {
        setWorld({ outputPrice: 50 });
        const r = run();
        expect(r.baseline.gold).toBeLessThan(0);
        expect(r.pick.gold).toBeLessThan(0);
        expect(r.pick.gold).toBeGreaterThanOrEqual(r.baseline.gold);
    });

    test('an action that gives no XP says so', () => {
        state.gameData.actionDetailMap['/actions/cheesesmithing/pincer_gloves'].experienceGain.value = 0;
        expect(run().status).toBe('no-xp');
    });

    test('needs one action: no action name is not a single action, an unknown skill is an error', () => {
        expect(findXpFloorChoice('cheesesmithing', { floorPercent: 95 }).status).toBe('not-single-action');
        expect(findXpFloorChoice('nonsense', { actionName: ACTION }).status).toBe('error');
    });
});
