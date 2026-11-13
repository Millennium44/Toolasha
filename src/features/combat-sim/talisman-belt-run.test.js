import { describe, test, expect, vi, beforeEach } from 'vitest';
import { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../../__fixtures__/talisman-full-modifiers.js';

const mocks = vi.hoisted(() => ({ test: true, sharedSeed: true }));
vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => mocks.test,
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key === 'combatSim_sharedSeed' ? mocks.sharedSeed : fallback),
        getSetting: () => undefined,
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
}));

const { runCombatBeltAdvisor, hasCombatLines, estimateBeltSims } = await import('./talisman-belt-run.js');
const { computeTalismanCombat } = await import('./engine/talisman-combat.js');
const { TALISMAN_MODELED_STATS } = await import('./engine/player.js');
const { sortBeltRows, rateRow } = await import('../talismans/talisman-belt-advisor.js');

const SMALL = '/items/small_talisman_belt';
const MEDIUM = '/items/medium_talisman_belt';
const LARGE = '/items/large_talisman_belt';
const ZONE = '/actions/combat/z';
const data = {
    talismansEnabled: true,
    talismanModifierDetailMap: FULL_MODIFIER_DETAILS,
    itemDetailMap: BELT_ITEMS,
    enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
    talismanInfo: { maxGrade: 6, maxModifierCount: 4 },
    actionDetailMap: { [ZONE]: { hrid: ZONE, type: '/action_types/combat', name: 'Z' } },
};
const crit = (grade) => ({ hrid: '/talisman_modifiers/critical_damage', grade });
const milking = (grade) => ({ hrid: '/talisman_modifiers/milking_speed', grade });

/** Stat totals the sim engine would read for a DTO, as a DPS multiplier on a base of 1000 */
function dpsOf(dto) {
    const out = computeTalismanCombat({
        talismans: dto.talismans,
        belt: dto.equipment['/equipment_types/belt'],
        gameData: data,
        modeledStats: TALISMAN_MODELED_STATS,
    });
    return 1000 * (1 + Object.values(out.stats).reduce((a, b) => a + b, 0));
}

function makeDeps(sims, extra = {}) {
    return {
        buildGameDataPayload: () => data,
        runSimulation: async (params) => {
            const dto = params.playerDTOs[0];
            sims.push({
                belt: { ...dto.equipment['/equipment_types/belt'] },
                talismans: JSON.parse(JSON.stringify(dto.talismans)),
                seed: params.seed,
            });
            return { dps: dpsOf(dto), hours: params.hours, deaths: {} };
        },
        computeMetrics: (r) => ({
            dps: r.dps,
            xpPerHour: 0,
            profitPerHour: 0,
            encountersPerHour: 1,
            deathsPerHour: 0,
        }),
        computeDeltas: (b, u) => ({ dps: ((u.dps - b.dps) / b.dps) * 100, xp: 0, profit: 0, encounters: 0, deaths: 0 }),
        rateDeltaNoisePct: () => ({ dps: 0.01, xp: 0, profit: 0, encounters: 0, deaths: 0 }),
        significantDeltas: (d, n) => Object.fromEntries(Object.keys(d).map((k) => [k, Math.abs(d[k]) > 1.96 * n[k]])),
        seedSimPriceCache: (cache) => cache,
        saleTaxRateOf: () => null,
        concurrency: () => 2,
        costDeps: { priceInfo: () => ({ price: null, source: null }), testerOn: () => false, enhanceCost: () => null },
        ...extra,
    };
}

const dtoWith = (belt, talismans, extra = {}) => ({
    hrid: '/players/1',
    equipment: belt ? { '/equipment_types/belt': belt } : {},
    talismans,
    ...extra,
});
const params = (dtos, extra = {}) => ({
    playerDTOs: dtos,
    playerIndex: 0,
    selfHrid: '/players/1',
    zoneHrid: ZONE,
    difficultyTier: 0,
    hours: 1,
    communityBuffs: {},
    metricKey: 'dps',
    ...extra,
});

beforeEach(() => {
    mocks.test = true;
    mocks.sharedSeed = true;
});

describe('runCombatBeltAdvisor', () => {
    const medium4 = { hrid: MEDIUM, enhancementLevel: 4 };
    // The slot-3 record sits in a slot a Medium does not have: not worn, and a Large must not wake it
    const talismans = [
        { slotIndex: 1, modifiers: [crit(6)] },
        { slotIndex: 2, modifiers: [crit(4)] },
        { slotIndex: 3, modifiers: [crit(6)] },
    ];

    test('every candidate is its own sim: the belt swapped, the talismans worn now unchanged, one shared seed', async () => {
        const sims = [];
        const result = await runCombatBeltAdvisor(params([dtoWith(medium4, talismans)]), vi.fn(), makeDeps(sims));
        expect(result.status).toBe('done');
        expect(result.rows).toHaveLength(8);
        expect(sims).toHaveLength(1 + 8);
        expect(sims[0].belt).toEqual(medium4);
        // Only the two worn talismans ever ride, on every belt
        for (const sim of sims) expect(sim.talismans.map((t) => t.slotIndex)).toEqual([1, 2]);
        expect(new Set(sims.map((s) => s.seed)).size).toBe(1);
        expect(sims[0].seed).not.toBeNull();
        // Each row's sim wore its own belt
        const worn = sims.slice(1).map((s) => `${s.belt.hrid}@${s.belt.enhancementLevel}`);
        expect([...worn].sort()).toEqual(result.rows.map((r) => r.key).sort());
    });

    test('the gain is what the sim gives with the candidate belt, not a scaling of the current gain', async () => {
        const sims = [];
        const dto = dtoWith(medium4, talismans);
        const result = await runCombatBeltAdvisor(params([dto]), vi.fn(), makeDeps(sims));
        const base = dpsOf({ ...dto, talismans: talismans.slice(0, 2) });
        for (const row of result.rows) {
            const swapped = {
                ...dto,
                talismans: talismans.slice(0, 2),
                equipment: { '/equipment_types/belt': { hrid: row.hrid, enhancementLevel: row.level } },
            };
            expect(row.value).toBeCloseTo(dpsOf(swapped) - base, 6);
        }
        const large = result.rows.find((r) => r.key === `${LARGE}@0`);
        expect(large.emptySlots).toBe(1);
        expect(result.rows.find((r) => r.key === `${MEDIUM}@5`).emptySlots).toBe(0);
    });

    test('a belt with a weaker Talisman Power than the one worn is a loss, kept as a row', async () => {
        const sims = [];
        const result = await runCombatBeltAdvisor(
            params([dtoWith({ hrid: SMALL, enhancementLevel: 20 }, [{ slotIndex: 1, modifiers: [crit(6)] }])]),
            vi.fn(),
            makeDeps(sims)
        );
        // A Medium +0 (power 0.15) is below a Small +20 (power 0.1 + 0.002 * 50 = 0.2)
        const medium = result.rows.find((r) => r.key === `${MEDIUM}@0`);
        expect(medium.value).toBeLessThan(0);
        expect(medium.emptySlots).toBe(1);
        // A loss never gets a gain per cost, priced or not
        const priced = { ...medium, costs: { market: { price: 1 } } };
        expect(rateRow(priced, 'market').kind).toBe('none');
    });

    test('unpriced belts: gains stand, costs are absent (not zero), and they sort last', async () => {
        const sims = [];
        const prices = { [`${MEDIUM}@5`]: 1_000_000_000 };
        const result = await runCombatBeltAdvisor(
            params([dtoWith(medium4, talismans)]),
            vi.fn(),
            makeDeps(sims, {
                costDeps: {
                    priceInfo: (hrid, o) => {
                        const price = prices[`${hrid}@${o.enhancementLevel}`];
                        return price ? { price, source: 'book' } : { price: null, source: null };
                    },
                    afterTax: (p) => p,
                    testerOn: () => false,
                    enhanceCost: () => null,
                },
            })
        );
        const sorted = sortBeltRows(result.rows, 'market');
        expect(sorted[0].key).toBe(`${MEDIUM}@5`);
        for (const row of sorted.slice(1)) {
            expect(row.costs.market.price).toBeNull();
            expect(rateRow(row, 'market').kind).toBe('unpriced');
        }
    });

    test('progress counts the baseline and every candidate', async () => {
        const sims = [];
        const progress = vi.fn();
        await runCombatBeltAdvisor(params([dtoWith(medium4, talismans)]), progress, makeDeps(sims));
        const last = progress.mock.calls.at(-1)[0];
        expect(last.total).toBe(estimateBeltSims(8));
        expect(progress.mock.calls[0][0].description).toMatch(/baseline/);
    });

    test('the roster handed in is not changed, and two runs share nothing', async () => {
        const dto = dtoWith(medium4, talismans);
        const before = JSON.stringify([dto]);
        const a = await runCombatBeltAdvisor(params([dto]), vi.fn(), makeDeps([]));
        expect(JSON.stringify([dto])).toBe(before);
        const b = await runCombatBeltAdvisor(
            params([dtoWith({ hrid: LARGE, enhancementLevel: 18 }, [{ slotIndex: 1, modifiers: [crit(6)] }])]),
            vi.fn(),
            makeDeps([])
        );
        expect(a.rows).toHaveLength(8);
        expect(b.rows.map((r) => r.level)).toEqual([19, 20]);
        expect(b.belt).toEqual({ hrid: LARGE, enhancementLevel: 18 });
    });

    test('the largest belt at +20 has nothing to compare: done, no rows, no sims', async () => {
        const sims = [];
        const result = await runCombatBeltAdvisor(
            params([dtoWith({ hrid: LARGE, enhancementLevel: 20 }, [{ slotIndex: 1, modifiers: [crit(6)] }])]),
            vi.fn(),
            makeDeps(sims)
        );
        expect(result).toMatchObject({ status: 'done', rows: [] });
        expect(sims).toHaveLength(0);
    });

    test('refuses with no belt, no talismans, only skilling lines, a live server, no zone', async () => {
        const deps = () => makeDeps([]);
        const noBelt = await runCombatBeltAdvisor(params([dtoWith(null, talismans)]), vi.fn(), deps());
        expect(noBelt).toMatchObject({ status: 'refused', reason: 'no_belt' });
        const none = await runCombatBeltAdvisor(params([dtoWith(medium4, [])]), vi.fn(), deps());
        expect(none).toMatchObject({ status: 'refused', reason: 'no_talismans' });
        // Worn on a slot the belt lacks: nothing is worn
        const offBelt = await runCombatBeltAdvisor(
            params([dtoWith({ hrid: SMALL, enhancementLevel: 0 }, [{ slotIndex: 2, modifiers: [crit(6)] }])]),
            vi.fn(),
            deps()
        );
        expect(offBelt).toMatchObject({ status: 'refused', reason: 'no_talismans' });
        const skillingOnly = await runCombatBeltAdvisor(
            params([dtoWith(medium4, [{ slotIndex: 1, modifiers: [milking(6)] }])]),
            vi.fn(),
            deps()
        );
        expect(skillingOnly).toMatchObject({ status: 'refused', reason: 'no_combat_lines' });
        const noZone = await runCombatBeltAdvisor(
            params([dtoWith(medium4, talismans)], { zoneHrid: null }),
            vi.fn(),
            deps()
        );
        expect(noZone.status).toBe('refused');
        mocks.test = false;
        const live = await runCombatBeltAdvisor(params([dtoWith(medium4, talismans)]), vi.fn(), deps());
        expect(live).toMatchObject({ status: 'refused', reason: 'live' });
    });

    test('Stop keeps the belts already valued and never runs the rest', async () => {
        const sims = [];
        let stop = false;
        const deps = makeDeps(sims, {
            concurrency: () => 1,
            runSimulation: async (p) => {
                sims.push(1);
                if (sims.length === 4) stop = true;
                return { dps: dpsOf(p.playerDTOs[0]) };
            },
        });
        const result = await runCombatBeltAdvisor(params([dtoWith(medium4, talismans)]), vi.fn(), deps, {
            abortSignal: () => stop,
        });
        expect(result.status).toBe('stopped');
        expect(result.measured).toBe(result.rows.length);
        expect(result.rows.length).toBeLessThan(8);
        expect(sims.length).toBeLessThan(9);
    });

    test('a cancel from elsewhere ends the run as stopped and says so', async () => {
        let calls = 0;
        const deps = makeDeps([], {
            concurrency: () => 1,
            runSimulation: async (p) => {
                if (++calls === 3) throw new Error('Cancelled');
                return { dps: dpsOf(p.playerDTOs[0]) };
            },
        });
        const result = await runCombatBeltAdvisor(params([dtoWith(medium4, talismans)]), vi.fn(), deps);
        expect(result.status).toBe('stopped');
        expect(result.cancelledElsewhere).toBe(true);
    });

    test('a sim failure that is not a cancel is thrown, not swallowed', async () => {
        const deps = makeDeps([], {
            runSimulation: async () => {
                throw new Error('worker crashed');
            },
        });
        await expect(runCombatBeltAdvisor(params([dtoWith(medium4, talismans)]), vi.fn(), deps)).rejects.toThrow(
            'worker crashed'
        );
    });

    test('the first baseline sim cancelled is stopped with no rows', async () => {
        const result = await runCombatBeltAdvisor(params([dtoWith(medium4, talismans)]), vi.fn(), makeDeps([]), {
            abortSignal: () => true,
        });
        expect(result).toMatchObject({ status: 'stopped', rows: [], measured: 0 });
    });
});

describe('hasCombatLines', () => {
    test('is true only when a worn line changes a combat stat', () => {
        expect(hasCombatLines([{ modifiers: [crit(1)] }], FULL_MODIFIER_DETAILS)).toBe(true);
        expect(hasCombatLines([{ modifiers: [milking(1)] }], FULL_MODIFIER_DETAILS)).toBe(false);
        expect(hasCombatLines([], FULL_MODIFIER_DETAILS)).toBe(false);
    });
});
