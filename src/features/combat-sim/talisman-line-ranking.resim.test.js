/**
 * The ranking's close calls run through the upgrade advisor's own re-sim (`resimCloseCallRows`): rounds at 2x then
 * 4x the hours against a baseline of the same length, until the lines near the set's cut separate.
 */
import { describe, test, expect, vi } from 'vitest';
import { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../../__fixtures__/talisman-full-modifiers.js';

vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => true,
}));

const { runCombatLineRanking, noiseSummary } = await import('./talisman-line-ranking.js');
const { resimCloseCallRows } = await import('./upgrade-advisor.js');

const LARGE_10 = { hrid: '/items/large_talisman_belt', enhancementLevel: 10 };
const data = {
    talismansEnabled: true,
    talismanModifierDetailMap: FULL_MODIFIER_DETAILS,
    itemDetailMap: BELT_ITEMS,
    enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
    talismanInfo: { maxGrade: 6, maxModifierCount: 4 },
    actionDetailMap: { '/actions/combat/z': { hrid: '/actions/combat/z', type: '/action_types/combat', name: 'Z' } },
};
// Gains in DPS on a 1000 baseline: two clear lines, then a crowd near the cut
const GAINS = {
    '/talisman_modifiers/critical_damage': 60,
    '/talisman_modifiers/smite': 40,
    '/talisman_modifiers/ability_damage': 12,
    '/talisman_modifiers/attack_speed': 11,
    '/talisman_modifiers/cast_speed': 10,
    '/talisman_modifiers/auto_attack_damage': 9,
};

function deps(calls) {
    return {
        buildGameDataPayload: () => data,
        runSimulation: async (params) => {
            calls.push(params.hours);
            let dps = 1000;
            for (const t of params.playerDTOs[0].talismans) for (const m of t.modifiers) dps += GAINS[m.hrid] || 0;
            return { dps, hours: params.hours, encounters: params.hours * 10, deaths: {} };
        },
        computeMetrics: (r) => ({
            dps: r.dps,
            xpPerHour: 0,
            profitPerHour: 0,
            encountersPerHour: 10,
            deathsPerHour: 0,
        }),
        computeDeltas: (b, u) => ({ dps: ((u.dps - b.dps) / b.dps) * 100, xp: 0, profit: 0, encounters: 0, deaths: 0 }),
        // The error bar shrinks with the hours, as the advisor's 1/sqrt(encounters) does
        rateDeltaNoisePct: (b, u) => {
            const e = 2 / Math.sqrt(u.hours);
            return { dps: e, xp: e, profit: e, encounters: e, deaths: e };
        },
        significantDeltas: (d, n) => Object.fromEntries(Object.keys(d).map((k) => [k, Math.abs(d[k]) > 1.96 * n[k]])),
        seedSimPriceCache: (c) => c,
        saleTaxRateOf: () => null,
        concurrency: () => 2,
        resimCloseCallRows,
    };
}

const params = (resimCloseCalls) => ({
    playerDTOs: [{ hrid: '/players/1', equipment: { '/equipment_types/belt': LARGE_10 }, talismans: [] }],
    playerIndex: 0,
    selfHrid: '/players/1',
    zoneHrid: '/actions/combat/z',
    difficultyTier: 0,
    hours: 1,
    communityBuffs: {},
    grade: 6,
    metricKey: 'dps',
    resimCloseCalls,
});

describe('close-call re-sims', () => {
    test('re-measure the lines near the cut at longer hours, and they come back firmer', async () => {
        const calls = [];
        const result = await runCombatLineRanking(params(true), null, deps(calls));
        expect(result.status).toBe('done');
        expect(result.resim.rounds).toBeGreaterThanOrEqual(1);
        expect(calls).toContain(2);
        const resimmed = result.rows.filter((r) => r.resim);
        expect(resimmed.length).toBeGreaterThan(0);
        // The clear leader was never in doubt
        expect(result.rows.find((r) => r.hrid === '/talisman_modifiers/critical_damage').resim).toBeUndefined();
        for (const r of resimmed) expect(r.errPct).toBeLessThan(1.96 * 2);
        expect(result.sims).toBe(calls.length);
    });

    test('off: one pass only', async () => {
        const calls = [];
        const result = await runCombatLineRanking(params(false), null, deps(calls));
        expect(result.resim).toBeNull();
        expect(calls.every((h) => h === 1)).toBe(true);
    });

    test('a ranking mostly within noise says so', () => {
        const rows = [
            { significant: true, noEffect: false },
            { significant: false, noEffect: false },
            { significant: false, noEffect: false },
            { significant: false, noEffect: true },
        ];
        expect(noiseSummary(rows)).toEqual({ measured: 3, withinNoise: 2, mostlyNoise: true });
    });
});
