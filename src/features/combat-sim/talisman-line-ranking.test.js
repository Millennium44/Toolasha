import { describe, test, expect, vi, beforeEach } from 'vitest';
import { BELT_ITEMS, MODIFIER_DETAILS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';
import { COMBAT_MODIFIER_DETAILS } from '../../__fixtures__/talisman-combat-modifiers.js';
import { FULL_MODIFIER_DETAILS } from '../../__fixtures__/talisman-full-modifiers.js';

const server = vi.hoisted(() => ({ test: true, sharedSeed: true }));
vi.mock('../../utils/game-server.js', () => ({ isTestServer: () => server.test }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key === 'combatSim_sharedSeed' ? server.sharedSeed : fallback),
        getSetting: () => undefined,
    },
}));

const {
    arrangeTalismans,
    buildRecommendedSet,
    checkCombatLines,
    combatRankingReadiness,
    estimateCombatRankingSims,
    runCombatLineRanking,
    runSkillingLineRanking,
    scaleAcrossGrades,
    splitSkillingLines,
    talismanCloseCalls,
    talismanLines,
    toRerollTargets,
} = await import('./talisman-line-ranking.js');
const { balancedScore, normalizeBalanceWeights } = await import('./talisman-line-ranking.js');
const { BELT_LOCATION, talismanBonusesOf } = await import('../../utils/talisman-bonuses.js');

const LARGE_10 = { hrid: '/items/large_talisman_belt', enhancementLevel: 10 };
const POWER = 0.258;

/** A payload with the real 48 combat lines, the real belts and the real enhancement table */
function gameData(overrides = {}) {
    return {
        talismansEnabled: true,
        talismanModifierDetailMap: FULL_MODIFIER_DETAILS,
        itemDetailMap: BELT_ITEMS,
        enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
        talismanInfo: { maxGrade: 6, maxModifierCount: 4, maxSlotCount: 3 },
        actionDetailMap: {
            '/actions/combat/golem_cave': {
                hrid: '/actions/combat/golem_cave',
                type: '/action_types/combat',
                name: 'Golem Cave',
            },
            '/actions/milking/cow': {
                hrid: '/actions/milking/cow',
                type: '/action_types/milking',
                name: 'Cow',
            },
            '/actions/alchemy/coinify': {
                hrid: '/actions/alchemy/coinify',
                type: '/action_types/alchemy',
                name: 'Coinify',
            },
        },
        ...overrides,
    };
}

beforeEach(() => {
    server.test = true;
    server.sharedSeed = true;
});

describe('arrangeTalismans', () => {
    test('three copies of a line over three slots land on three talismans, never twice on one', () => {
        const picks = [
            ...Array(3).fill({ hrid: 'a', grade: 6 }),
            ...Array(3).fill({ hrid: 'b', grade: 6 }),
            ...Array(3).fill({ hrid: 'c', grade: 6 }),
            ...Array(3).fill({ hrid: 'd', grade: 6 }),
        ];
        const talismans = arrangeTalismans(picks, 3, 4);
        expect(talismans.map((t) => t.slotIndex)).toEqual([1, 2, 3]);
        for (const t of talismans) {
            expect(t.modifiers).toHaveLength(4);
            expect(new Set(t.modifiers.map((m) => m.hrid)).size).toBe(4);
        }
    });

    test('a short list fills the first talismans and leaves empty ones out', () => {
        const talismans = arrangeTalismans([{ hrid: 'a', grade: 3 }], 3, 4);
        expect(talismans).toEqual([{ slotIndex: 1, modifiers: [{ hrid: 'a', grade: 3 }] }]);
    });
});

describe('buildRecommendedSet', () => {
    test('one slot: the four best distinct lines that add something', () => {
        const rows = [
            { hrid: 'a', name: 'A', value: 5, significant: true },
            { hrid: 'b', name: 'B', value: 4, significant: true },
            { hrid: 'c', name: 'C', value: 3, significant: true },
            { hrid: 'd', name: 'D', value: 2, significant: true },
            { hrid: 'e', name: 'E', value: 1, significant: true },
            { hrid: 'f', name: 'F', value: -1, significant: true },
        ];
        const set = buildRecommendedSet(rows, { slots: 1, grade: 6 });
        expect(set.talismans).toHaveLength(1);
        expect(set.talismans[0].modifiers.map((m) => m.hrid)).toEqual(['a', 'b', 'c', 'd']);
        expect(set.predicted).toBe(14);
    });

    test('diminishing copies: a line measured at ×3 is repeated only while each copy beats the alternatives', () => {
        const rows = [
            // ×3 adds 5 + 2 + 2: later copies worth 2 each
            { hrid: 'crit', name: 'Crit', value: 5, copiesValue: 9, significant: true },
            { hrid: 'b', name: 'B', value: 3, significant: true },
            { hrid: 'c', name: 'C', value: 2.5, significant: true },
        ];
        const set = buildRecommendedSet(rows, { slots: 3, grade: 6 });
        const crit = set.members.find((m) => m.hrid === 'crit');
        expect(crit.copies).toBe(3);
        // B and C, never measured at ×3, are assumed linear: three copies each, marked
        const b = set.members.find((m) => m.hrid === 'b');
        expect(b.copies).toBe(3);
        expect(b.assumedLinear).toBe(true);
        expect(set.lineCount).toBe(9);
        for (const t of set.talismans) expect(new Set(t.modifiers.map((m) => m.hrid)).size).toBe(t.modifiers.length);
    });

    test('a line whose later copies add nothing gets one copy', () => {
        const rows = [{ hrid: 'cap', name: 'Cap', value: 4, copiesValue: 4, significant: true }];
        const set = buildRecommendedSet(rows, { slots: 3, grade: 6 });
        expect(set.members).toEqual([expect.objectContaining({ hrid: 'cap', copies: 1 })]);
    });

    test('measured lines come before lines within noise, and noise lines are marked', () => {
        const rows = [
            { hrid: 'lucky', name: 'Lucky', value: 10, significant: false },
            ...['a', 'b', 'c', 'd'].map((hrid, i) => ({ hrid, name: hrid, value: 4 - i, significant: true })),
        ];
        const set = buildRecommendedSet(rows, { slots: 1, grade: 6 });
        expect(set.talismans[0].modifiers.map((m) => m.hrid)).toEqual(['a', 'b', 'c', 'd']);
        const withRoom = buildRecommendedSet(rows.slice(0, 3), { slots: 1, grade: 6 });
        expect(withRoom.members.find((m) => m.hrid === 'lucky').significant).toBe(false);
    });

    test('nothing worth taking, or no slot, is no set', () => {
        expect(buildRecommendedSet([{ hrid: 'a', value: 0 }], { slots: 3, grade: 6 })).toBeNull();
        expect(buildRecommendedSet([{ hrid: 'a', value: 2 }], { slots: 0, grade: 6 })).toBeNull();
    });

    test('reroll targets carry {hrid, minGrade} per talisman', () => {
        const set = buildRecommendedSet([{ hrid: 'a', name: 'A', value: 1, significant: true }], {
            slots: 2,
            grade: 5,
        });
        expect(toRerollTargets(set)).toEqual([[{ hrid: 'a', minGrade: 5 }], [{ hrid: 'a', minGrade: 5 }]]);
    });
});

describe('scaleAcrossGrades', () => {
    test('carries a value measured at G6 to every grade by the grade values', () => {
        const detail = COMBAT_MODIFIER_DETAILS['/talisman_modifiers/ability_damage'];
        expect(scaleAcrossGrades(4, detail, 6)).toEqual([1, 1.5, 2, 2.5, 3, 4]);
    });
});

describe('checkCombatLines', () => {
    test('every one of the 48 combat lines is read by the engine at gradeValue × (1 + power) on a Large +10', () => {
        const data = gameData();
        const lines = talismanLines(data.talismanModifierDetailMap, '/talisman_types/combat');
        expect(lines).toHaveLength(48);
        const { valued, notValued, power } = checkCombatLines(lines, LARGE_10, data, 6);
        expect(power).toBeCloseTo(POWER, 10);
        expect(notValued).toEqual([]);
        expect(valued).toHaveLength(48);
    });

    test('a line on a stat the engine does not model is not valued (never shown as zero)', () => {
        const data = gameData();
        const odd = {
            hrid: '/talisman_modifiers/odd',
            name: 'Odd',
            talismanTypeHrid: '/talisman_types/combat',
            targetHrid: '/talisman_modifier_targets/combat_stat',
            keys: ['NotAStat'],
            gradeValues: [1, 2, 3, 4, 5, 6],
        };
        const { valued, notValued } = checkCombatLines([odd], LARGE_10, data, 6);
        expect(valued).toEqual([]);
        expect(notValued[0].detail.hrid).toBe(odd.hrid);
    });

    test('with talismans off in the payload nothing is valued', () => {
        const data = gameData({ talismansEnabled: false });
        const lines = talismanLines(data.talismanModifierDetailMap, '/talisman_types/combat');
        expect(checkCombatLines(lines, LARGE_10, data, 6).valued).toEqual([]);
    });
});

describe('combatRankingReadiness', () => {
    const dto = (belt) => ({ hrid: '/players/1', equipment: belt ? { '/equipment_types/belt': belt } : {} });
    const zone = '/actions/combat/golem_cave';

    test('no belt refuses', () => {
        expect(combatRankingReadiness({ gameData: gameData(), playerDTO: dto(null), zoneHrid: zone })).toMatchObject({
            ok: false,
            reason: 'no_belt',
        });
    });

    test('no zone refuses', () => {
        expect(combatRankingReadiness({ gameData: gameData(), playerDTO: dto(LARGE_10), zoneHrid: '' }).reason).toBe(
            'no_zone'
        );
    });

    test('live server refuses', () => {
        server.test = false;
        expect(combatRankingReadiness({ gameData: gameData(), playerDTO: dto(LARGE_10), zoneHrid: zone }).reason).toBe(
            'live'
        );
    });

    test('a Small belt gives one slot, a Large +10 three at power 0.258', () => {
        const small = combatRankingReadiness({
            gameData: gameData(),
            playerDTO: dto({ hrid: '/items/small_talisman_belt', enhancementLevel: 0 }),
            zoneHrid: zone,
        });
        expect(small).toMatchObject({ ok: true, slots: 1 });
        expect(small.power).toBeCloseTo(0.1, 10);
        const large = combatRankingReadiness({ gameData: gameData(), playerDTO: dto(LARGE_10), zoneHrid: zone });
        expect(large).toMatchObject({ ok: true, slots: 3 });
        expect(large.power).toBeCloseTo(POWER, 10);
    });
});

/**
 * Fake machinery: a "sim" whose DPS is 1000 plus a fixed gain per line copy (diminishing after the first), so the
 * test can check what each sim was handed and what the ranking made of it.
 */
function fakeDeps(data, { gains, abortAfter = Infinity, abort } = {}) {
    const calls = [];
    const runSimulation = vi.fn(async (params) => {
        calls.push(params);
        if (calls.length > abortAfter) {
            abort.flag = true;
            throw new Error('Cancelled');
        }
        const me = params.playerDTOs[0];
        let dps = 1000;
        const seen = {};
        for (const t of me.talismans || []) {
            for (const m of t.modifiers) {
                seen[m.hrid] = (seen[m.hrid] || 0) + 1;
                const gain = gains[m.hrid] || 0;
                dps += seen[m.hrid] === 1 ? gain : gain / 2;
            }
        }
        return { dps, encounters: 1000, deaths: {} };
    });
    return {
        calls,
        deps: {
            buildGameDataPayload: () => data,
            runSimulation,
            computeMetrics: (r) => ({
                dps: r.dps,
                xpPerHour: 0,
                profitPerHour: 0,
                encountersPerHour: 10,
                deathsPerHour: 0,
            }),
            computeDeltas: (b, u) => ({
                dps: ((u.dps - b.dps) / b.dps) * 100,
                xp: 0,
                profit: 0,
                encounters: 0,
                deaths: 0,
            }),
            rateDeltaNoisePct: () => ({ dps: 0.1, xp: 0.1, profit: 0.1, encounters: 0.1, deaths: 0.1 }),
            significantDeltas: (d, n) =>
                Object.fromEntries(Object.keys(d).map((k) => [k, Math.abs(d[k]) > 1.96 * n[k]])),
            seedSimPriceCache: (cache) => cache,
            saleTaxRateOf: () => null,
            concurrency: () => 2,
        },
    };
}

describe('runCombatLineRanking', () => {
    const worn = [{ slotIndex: 2, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 1 }] }];
    const params = (data, overrides = {}) => ({
        playerDTOs: [
            {
                hrid: '/players/1',
                equipment: { '/equipment_types/belt': LARGE_10 },
                talismans: worn,
            },
        ],
        playerIndex: 0,
        selfHrid: '/players/1',
        zoneHrid: '/actions/combat/golem_cave',
        difficultyTier: 1,
        hours: 10,
        communityBuffs: {},
        grade: 6,
        metricKey: 'dps',
        ...overrides,
    });
    const gains = {
        '/talisman_modifiers/critical_damage': 40,
        '/talisman_modifiers/smite': 30,
        '/talisman_modifiers/ability_damage': 20,
        '/talisman_modifiers/attack_speed': 10,
        '/talisman_modifiers/armor': 1,
    };

    test('measures every line against the build with its talismans off, then checks the set and the worn ones', async () => {
        const data = gameData();
        const { calls, deps } = fakeDeps(data, { gains });
        const result = await runCombatLineRanking(params(data), null, deps);
        expect(result.status).toBe('done');

        // Baseline: the talismans replaced by none, the belt untouched
        expect(calls[0].playerDTOs[0].talismans).toEqual([]);
        expect(calls[0].playerDTOs[0].equipment['/equipment_types/belt']).toEqual(LARGE_10);
        // Single lines: one record in slot 1, never appended to the worn talismans
        const single = calls.find(
            (c) => c.playerDTOs[0].talismans[0]?.modifiers[0].hrid === '/talisman_modifiers/smite'
        );
        expect(single.playerDTOs[0].talismans).toEqual([
            { slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/smite', grade: 6 }] },
        ]);
        // Copies: one record per slot, distinct 1-based slots
        const copies = calls.find(
            (c) =>
                c.playerDTOs[0].talismans.length === 3 &&
                c.playerDTOs[0].talismans.every((t) => t.modifiers[0].hrid === '/talisman_modifiers/critical_damage')
        );
        expect(copies.playerDTOs[0].talismans.map((t) => t.slotIndex)).toEqual([1, 2, 3]);
        // The caller's roster is never changed
        expect(params(data).playerDTOs[0].talismans).toEqual(worn);

        expect(result.rows[0].hrid).toBe('/talisman_modifiers/critical_damage');
        expect(result.rows.find((r) => r.hrid === '/talisman_modifiers/smite').mechanic).toBe(true);
        // A line the fake sim ignores reads exactly zero with a shared seed: no effect
        expect(result.rows.find((r) => r.hrid === '/talisman_modifiers/threat').noEffect).toBe(true);

        expect(result.set.lineCount).toBeLessThanOrEqual(12);
        for (const t of result.set.talismans) {
            expect(t.slotIndex).toBeGreaterThanOrEqual(1);
            expect(t.slotIndex).toBeLessThanOrEqual(3);
            expect(new Set(t.modifiers.map((m) => m.hrid)).size).toBe(t.modifiers.length);
        }
        expect(result.combined.value).toBeGreaterThan(0);
        expect(result.current.talismans).toEqual(worn);
        // The estimate the section shows before it starts is a ceiling: only 5 lines gain, so 5 copy sims, not 6
        expect(result.sims).toBe(calls.length);
        expect(calls.length).toBe(estimateCombatRankingSims({ lineCount: 48, slots: 3, hasCurrent: true }) - 1);
        // Practical by default: capped at G3, at most one Special per talisman
        expect(result.setMode).toBe('practical');
        expect(result.rerollTargets.flat().every((t) => t.minGrade === 3)).toBe(true);
        for (const t of result.set.talismans) {
            expect(
                t.modifiers.filter((m) => FULL_MODIFIER_DETAILS[m.hrid].groupHrid.endsWith('/special')).length
            ).toBeLessThanOrEqual(1);
        }
    });

    test('Profit/hr near break-even: the error bar is in percent of net profit, so it widens and reaches the re-sim', async () => {
        const data = gameData();
        const { deps } = fakeDeps(data, { gains });
        // Net 100 gold/h on 10,000 revenue and 9,900 cost: noise is 1% of the 10,000 scale (100 gold), which is 100%
        // of the net profit the delta is taken on
        deps.computeMetrics = (r) => ({
            dps: r.dps,
            xpPerHour: 0,
            profitPerHour: 100 + (r.dps - 1000),
            revenuePerHour: 10000,
            costPerHour: 9900,
            encountersPerHour: 10,
            deathsPerHour: 0,
        });
        deps.computeDeltas = (b, u) => ({
            dps: 0,
            xp: 0,
            profit: ((u.profitPerHour - b.profitPerHour) / Math.abs(b.profitPerHour)) * 100,
            encounters: 0,
            deaths: 0,
        });
        deps.rateDeltaNoisePct = () => ({ dps: 0, xp: 0, profit: 1, encounters: 0, deaths: 0 });
        const result = await runCombatLineRanking(params(data, { metricKey: 'profit' }), null, deps);
        const crit = result.rows.find((r) => r.hrid === '/talisman_modifiers/critical_damage');
        const smite = result.rows.find((r) => r.hrid === '/talisman_modifiers/smite');
        // +40 gold on 100 net is +40%; the 1%-of-scale noise (100 gold) is 100% of net, so the bar is Z * 100
        expect(crit.valuePct).toBeCloseTo(40, 6);
        expect(crit.errPct).toBeGreaterThan(190);
        expect(crit.errPct).toBeLessThan(200);
        const close = talismanCloseCalls([crit, smite], { slots: 1, grade: 6 }).map((r) => r.hrid);
        expect(close).toEqual(expect.arrayContaining([crit.hrid, smite.hrid]));
    });

    test('Profit/hr from a zero net baseline: the error bar stays finite and spans the 0/100 delta', async () => {
        const { profitNoiseOfNetPct } = await import('./talisman-line-ranking.js');
        expect(profitNoiseOfNetPct(1, { profitPerHour: 0, revenuePerHour: 5000, costPerHour: 5000 })).toBe(100);
        expect(profitNoiseOfNetPct(2, { profitPerHour: 50, revenuePerHour: 5000, costPerHour: 4950 })).toBeCloseTo(
            200,
            6
        );
        // Net profit as large as the scale: no rescaling
        expect(profitNoiseOfNetPct(2, { profitPerHour: 9000, revenuePerHour: 100, costPerHour: 100 })).toBe(2);
    });

    test('a Small belt: no copy sims, one talisman of four lines', async () => {
        const data = gameData();
        const { calls, deps } = fakeDeps(data, { gains });
        const p = params(data);
        p.playerDTOs[0].equipment['/equipment_types/belt'] = {
            hrid: '/items/small_talisman_belt',
            enhancementLevel: 0,
        };
        const result = await runCombatLineRanking(p, null, deps);
        expect(result.slots).toBe(1);
        expect(result.set.talismans).toHaveLength(1);
        expect(result.set.talismans[0].modifiers).toHaveLength(4);
        // The worn talisman sits in slot 2, which a Small belt does not have: nothing worn counts
        expect(result.current).toBeNull();
        expect(calls.length).toBe(estimateCombatRankingSims({ lineCount: 48, slots: 1, hasCurrent: false }));
    });

    test('no belt: refused, nothing simulated', async () => {
        const data = gameData();
        const { calls, deps } = fakeDeps(data, { gains });
        const p = params(data);
        p.playerDTOs[0].equipment = {};
        const result = await runCombatLineRanking(p, null, deps);
        expect(result).toMatchObject({ status: 'refused', reason: 'no_belt' });
        expect(calls).toHaveLength(0);
    });

    test('no zone and the live server: refused, nothing simulated', async () => {
        const data = gameData();
        const { calls, deps } = fakeDeps(data, { gains });
        expect((await runCombatLineRanking(params(data, { zoneHrid: null }), null, deps)).reason).toBe('no_zone');
        server.test = false;
        expect((await runCombatLineRanking(params(data), null, deps)).reason).toBe('live');
        expect(calls).toHaveLength(0);
    });

    test('Stop part-way keeps the measured lines and builds no set', async () => {
        const data = gameData();
        const abort = { flag: false };
        const { deps } = fakeDeps(data, { gains, abortAfter: 10, abort });
        const result = await runCombatLineRanking(params(data), null, deps, { abortSignal: () => abort.flag });
        expect(result.status).toBe('stopped');
        expect(result.set).toBeUndefined();
        expect(result.rows.length).toBeGreaterThan(0);
        expect(result.rows.length).toBeLessThan(48);
        expect(result.of).toBe(48);
    });

    test('Stop during the baseline still carries the belt, power and slots', async () => {
        const data = gameData();
        const abort = { flag: false };
        const { deps } = fakeDeps(data, { gains, abortAfter: 0, abort });
        const result = await runCombatLineRanking(params(data), null, deps, { abortSignal: () => abort.flag });
        expect(result).toMatchObject({ status: 'stopped', slots: 3, measured: 0, of: 48 });
        expect(result.power).toBeCloseTo(POWER, 10);
        expect(result.belt).toEqual(LARGE_10);
    });

    test('a cancel from elsewhere is a stop, not a failure', async () => {
        const data = gameData();
        const abort = { flag: false };
        const { deps } = fakeDeps(data, { gains, abortAfter: 3, abort });
        // No abort signal of ours: the 'Cancelled' rejection came from another caller
        const result = await runCombatLineRanking(params(data), null, deps);
        expect(result).toMatchObject({ status: 'stopped', cancelledElsewhere: true });
        expect(result.rows.length).toBeGreaterThan(0);
    });

    test('shared seed off: an untouched line is within noise, not "no effect"', async () => {
        server.sharedSeed = false;
        const data = gameData();
        const { deps } = fakeDeps(data, { gains });
        const result = await runCombatLineRanking(params(data), null, deps);
        expect(result.paired).toBe(false);
        expect(result.rows.find((r) => r.hrid === '/talisman_modifiers/threat').noEffect).toBe(false);
    });
});

describe('runSkillingLineRanking', () => {
    const milkingBelt = {
        itemHrid: '/items/large_talisman_belt',
        itemLocationHrid: BELT_LOCATION,
        enhancementLevel: 10,
    };
    /** A "calculator" that reads the talisman share off the equipment Map, the way the real parsers do */
    const evaluate = vi.fn(async (_hrid, { equipment }) => {
        const s = talismanBonusesOf(equipment).noncombat;
        const speed = (s.milkingSpeed || 0) + (s.skillingSpeed || 0);
        const eff = (s.milkingEfficiency || 0) + (s.skillingEfficiency || 0);
        const rate = 100 * (1 + speed) * (1 + eff);
        return {
            profitPerHour: rate * 10,
            xpPerHour: rate * (1 + (s.milkingExperience || 0)),
            hasMissingPrices: false,
        };
    });
    const deps = (equipment) => ({
        getGameData: () => gameData(),
        resolveContext: () => ({ equipment, drinks: [] }),
        evaluate,
        yieldNow: async () => {},
    });

    test('values each applicable line exactly at every grade, scaled by the action gear belt', async () => {
        const equipment = new Map([[BELT_LOCATION, milkingBelt]]);
        const result = await runSkillingLineRanking(
            { actionHrid: '/actions/milking/cow', grade: 6, metricKey: 'profit' },
            deps(equipment)
        );
        expect(result.status).toBe('done');
        expect(result.power).toBeCloseTo(POWER, 10);
        const speed = result.rows.find((r) => r.hrid === '/talisman_modifiers/milking_speed');
        // Milking Speed G2 = 0.045 × 1.258: profit 1000 × (1 + 0.05661)
        expect(speed.byGrade[1]).toBeCloseTo(1000 * 0.045 * 1.258, 6);
        // An Alchemy line does not apply to milking
        expect(result.otherLines.map((d) => d.hrid)).toContain('/talisman_modifiers/alchemy_essence_find');
        // Gathering quantity is read by gathering but the fake calculator ignores it: no effect, listed apart
        expect(result.rows.find((r) => r.hrid === '/talisman_modifiers/gathering_quantity').noEffect).toBe(true);
        // The set never puts a line twice on one talisman and stays within three talismans of four lines
        expect(result.set.talismans.length).toBeLessThanOrEqual(3);
        for (const t of result.set.talismans) {
            expect(t.modifiers.length).toBeLessThanOrEqual(4);
            expect(new Set(t.modifiers.map((m) => m.hrid)).size).toBe(t.modifiers.length);
        }
        expect(result.combined.value).toBeGreaterThan(0);
        // No talismans on the gear now: worth nothing over bare
        expect(result.current.value).toBe(0);
    });

    test('no belt on the action gear: refused', async () => {
        const result = await runSkillingLineRanking(
            { actionHrid: '/actions/milking/cow', grade: 6, metricKey: 'profit' },
            deps(new Map())
        );
        expect(result).toMatchObject({ status: 'refused', reason: 'no_belt' });
    });

    test('Alchemy is not ranked, and the live server is refused', async () => {
        const equipment = new Map([[BELT_LOCATION, milkingBelt]]);
        const alchemy = await runSkillingLineRanking(
            { actionHrid: '/actions/alchemy/coinify', grade: 6, metricKey: 'profit' },
            deps(equipment)
        );
        expect(alchemy.reason).toBe('unsupported');
        server.test = false;
        const live = await runSkillingLineRanking(
            { actionHrid: '/actions/milking/cow', grade: 6, metricKey: 'profit' },
            deps(equipment)
        );
        expect(live.reason).toBe('live');
    });

    test('an action no line applies to says so', async () => {
        const equipment = new Map([[BELT_LOCATION, milkingBelt]]);
        const data = gameData();
        // Only the Alchemy line is in this payload's skilling table
        data.talismanModifierDetailMap = {
            '/talisman_modifiers/alchemy_essence_find': MODIFIER_DETAILS['/talisman_modifiers/alchemy_essence_find'],
        };
        const result = await runSkillingLineRanking(
            { actionHrid: '/actions/milking/cow', grade: 6, metricKey: 'profit' },
            { ...deps(equipment), getGameData: () => data }
        );
        expect(result.reason).toBe('no_lines');
    });
});

describe('splitSkillingLines', () => {
    test('Gourmet applies to production, Processing and gathering quantity to gathering', () => {
        const lines = talismanLines(MODIFIER_DETAILS, '/talisman_types/skilling');
        const milking = splitSkillingLines(lines, '/action_types/milking').applicable.map((d) => d.hrid);
        const cooking = splitSkillingLines(lines, '/action_types/cooking').applicable.map((d) => d.hrid);
        expect(milking).toContain('/talisman_modifiers/processing');
        expect(milking).toContain('/talisman_modifiers/gathering_quantity');
        expect(milking).not.toContain('/talisman_modifiers/gourmet');
        expect(cooking).toContain('/talisman_modifiers/gourmet');
        expect(cooking).not.toContain('/talisman_modifiers/milking_speed');
        expect(cooking).toContain('/talisman_modifiers/skilling_speed');
    });
});

describe('skilling: missing prices and the gear snapshot', () => {
    const milkingBelt = {
        itemHrid: '/items/large_talisman_belt',
        itemLocationHrid: BELT_LOCATION,
        enhancementLevel: 10,
    };
    const figures = (equipment, missing) => {
        const s = talismanBonusesOf(equipment).noncombat;
        const rate = 100 * (1 + (s.milkingSpeed || 0) + (s.skillingSpeed || 0));
        return { profitPerHour: rate * 10, revenuePerHour: rate * 10, xpPerHour: rate, hasMissingPrices: missing };
    };

    test('a price missing only in the set trials still marks the result and the set as floors', async () => {
        // Bare and single lines priced; any trial with two distinct stats reads a missing price
        const evaluate = async (_hrid, { equipment }) =>
            figures(equipment, Object.keys(talismanBonusesOf(equipment).noncombat).length >= 2);
        const result = await runSkillingLineRanking(
            { actionHrid: '/actions/milking/cow', grade: 6, metricKey: 'profit' },
            {
                getGameData: () => gameData(),
                resolveContext: () => ({ equipment: new Map([[BELT_LOCATION, milkingBelt]]), drinks: [] }),
                evaluate,
                yieldNow: async () => {},
            }
        );
        expect(result.status).toBe('done');
        expect(result.hasMissingPrices).toBe(true);
        expect(result.set.hasMissingPrices).toBe(true);
    });

    test('the gear is read once: a change to it mid-run does not move the lines', async () => {
        const TOOL = '/item_locations/milking_tool';
        const live = new Map([
            [BELT_LOCATION, milkingBelt],
            [TOOL, { itemHrid: '/items/brush' }],
        ]);
        let calls = 0;
        const evaluate = async (_hrid, { equipment }) => {
            // After the baseline the player takes the tool off; a tool is worth +100 profit/hr here
            if (++calls === 1) live.delete(TOOL);
            const out = figures(equipment, false);
            return { ...out, profitPerHour: out.profitPerHour + (equipment.has(TOOL) ? 100 : 0) };
        };
        const result = await runSkillingLineRanking(
            { actionHrid: '/actions/milking/cow', grade: 6, metricKey: 'profit' },
            {
                getGameData: () => gameData(),
                resolveContext: () => ({ equipment: live, drinks: [] }),
                evaluate,
                yieldNow: async () => {},
            }
        );
        const speed = result.rows.find((r) => r.hrid === '/talisman_modifiers/milking_speed');
        expect(speed.value).toBeCloseTo(1000 * 0.12 * 1.258, 6);
    });
});

describe('talismanCloseCalls', () => {
    const row = (hrid, valuePct, errPct) => ({
        hrid,
        name: hrid,
        value: valuePct,
        valuePct,
        errPct,
        significant: Math.abs(valuePct) > errPct,
    });

    test('picks the set members and the outsiders whose error bar reaches the cut line', () => {
        // One slot, four lines: a b c d in, e first out. Cut = (2 + 1.8) / 2 = 1.9
        const rows = [
            row('a', 20, 2),
            row('b', 10, 2),
            row('c', 5, 2),
            row('d', 2, 2),
            row('e', 1.8, 2),
            row('f', -3, 1),
        ];
        const close = talismanCloseCalls(rows, { slots: 1, grade: 6 }).map((r) => r.hrid);
        expect(close).toEqual(expect.arrayContaining(['d', 'e']));
        expect(close).not.toContain('a');
        expect(close).not.toContain('b');
        expect(close).not.toContain('f');
    });

    test('nothing close once every bar clears the cut', () => {
        const rows = [row('a', 20, 1), row('b', 10, 1), row('c', 8, 1), row('d', 6, 1), row('e', 1, 0.5)];
        expect(talismanCloseCalls(rows, { slots: 1, grade: 6 })).toEqual([]);
    });
});

describe('Balanced', () => {
    const base = { profitPerHour: 1000, revenuePerHour: 5000, costPerHour: 4000 };
    const noise = { xp: 1, profit: 1, dps: 2, encounters: 1, deaths: 10 };

    test('weighted average of the % gains, profit on the gold moving through the fight', () => {
        // Profit +250/hr on a 5,000/hr scale is +5%
        const score = balancedScore(
            { deltas: { xp: 3, dps: 6, deaths: 0 }, noise, change: { profit: 250 }, baseline: base, significantBy: {} },
            { xp: 1, profit: 1, dps: 1 }
        );
        expect(score.valuePct).toBeCloseTo((3 + 5 + 6) / 3, 9);
        // Errors added as if fully correlated: never narrower than the truth
        expect(score.errPct).toBeCloseTo((1.96 * (1 + 1 + 2)) / 3, 9);
        expect(score.deathsRise).toBe(false);
    });

    test('a significant rise in deaths/hr comes off the score and flags the line; one within noise does not', () => {
        const parts = { deltas: { xp: 0, dps: 9, deaths: 30 }, noise, change: { profit: 0 }, baseline: base };
        const flagged = balancedScore({ ...parts, significantBy: { deaths: true } }, { xp: 0, profit: 0, dps: 1 });
        expect(flagged.deathsRise).toBe(true);
        expect(flagged.valuePct).toBeCloseTo(9 - 30 / 3, 9);
        const quiet = balancedScore({ ...parts, significantBy: { deaths: false } }, { xp: 0, profit: 0, dps: 1 });
        expect(quiet.deathsRise).toBe(false);
        expect(quiet.valuePct).toBeCloseTo(9, 9);
    });

    test('weights: negative or missing count as zero, all zero falls back to equal', () => {
        expect(normalizeBalanceWeights({ xp: -1, profit: 2 })).toEqual({ xp: 0, profit: 2, dps: 0 });
        expect(normalizeBalanceWeights({ xp: 0, profit: 0, dps: 0 })).toEqual({ xp: 1, profit: 1, dps: 1 });
    });
});

describe('whose build a combat ranking is for', () => {
    test('a party member: not self, with their hrid', async () => {
        const data = gameData();
        const { deps } = fakeDeps(data, { gains: { '/talisman_modifiers/critical_damage': 40 } });
        const result = await runCombatLineRanking(
            {
                playerDTOs: [{ hrid: '/players/2', equipment: { '/equipment_types/belt': LARGE_10 }, talismans: [] }],
                playerIndex: 0,
                selfHrid: '/players/1',
                zoneHrid: '/actions/combat/golem_cave',
                difficultyTier: 1,
                hours: 10,
                communityBuffs: {},
                grade: 6,
                metricKey: 'dps',
            },
            null,
            deps
        );
        expect(result).toMatchObject({ isSelf: false, playerHrid: '/players/2' });
    });
});

describe('runCombatLineRanking: unpriced running costs', () => {
    const worn = [];
    const data = gameData();
    const gains = {
        '/talisman_modifiers/critical_damage': 40,
        '/talisman_modifiers/smite': 30,
        '/talisman_modifiers/ability_damage': 20,
    };
    // Profit rises with dps, but a line adding 30+ dps also eats an item nothing prices (counted as free)
    const profitDeps = () => {
        const { deps } = fakeDeps(data, { gains });
        let baselineDps = null;
        return {
            ...deps,
            computeMetrics: (r) => {
                if (baselineDps === null) baselineDps = r.dps;
                const extra = r.dps - baselineDps;
                return {
                    dps: r.dps,
                    xpPerHour: 0,
                    profitPerHour: r.dps * 100,
                    encountersPerHour: 10,
                    deathsPerHour: 0,
                    unpricedCost: extra >= 30 ? ['/items/mystery_coffee'] : [],
                    unpricedCostRates: extra >= 30 ? { '/items/mystery_coffee': 5 } : {},
                };
            },
            computeDeltas: (b, u) => ({
                dps: ((u.dps - b.dps) / (b.dps || 1)) * 100,
                xp: 0,
                profit: ((u.profitPerHour - b.profitPerHour) / (b.profitPerHour || 1)) * 100,
                encounters: 0,
                deaths: 0,
            }),
        };
    };
    const run = (metricKey, balanceWeights) =>
        runCombatLineRanking(
            {
                playerDTOs: [{ hrid: '/players/1', equipment: { '/equipment_types/belt': LARGE_10 }, talismans: worn }],
                playerIndex: 0,
                selfHrid: '/players/1',
                zoneHrid: '/actions/combat/golem_cave',
                difficultyTier: 1,
                hours: 10,
                communityBuffs: {},
                grade: 6,
                metricKey,
                ...(balanceWeights ? { balanceWeights } : {}),
            },
            null,
            profitDeps()
        );

    test('a profit gain that rests on an unpriced extra cost is marked, not significant, and marked in the set', async () => {
        const result = await run('profit');
        const smite = result.rows.find((r) => r.hrid === '/talisman_modifiers/smite');
        const ability = result.rows.find((r) => r.hrid === '/talisman_modifiers/ability_damage');
        expect(smite.costUnpriced).toEqual(['/items/mystery_coffee']);
        expect(smite.significant).toBe(false);
        expect(ability.costUnpriced).toBeUndefined();
        expect(ability.significant).toBe(true);
        const member = result.set.members.find((m) => m.hrid === '/talisman_modifiers/smite');
        expect(member?.costUnpriced).toEqual(['/items/mystery_coffee']);
        expect(
            result.set.members.find((m) => m.hrid === '/talisman_modifiers/ability_damage').costUnpriced
        ).toBeUndefined();
    });

    test('Balanced with a profit weight marks it too; a DPS-only ranking does not', async () => {
        const balanced = await run('balanced', { xp: 1, profit: 1, dps: 1 });
        expect(balanced.rows.find((r) => r.hrid === '/talisman_modifiers/smite').significant).toBe(false);
        const noProfit = await run('balanced', { xp: 0, profit: 0, dps: 1 });
        expect(noProfit.rows.find((r) => r.hrid === '/talisman_modifiers/smite').costUnpriced).toBeDefined();
        const dps = await run('dps');
        expect(dps.rows.find((r) => r.hrid === '/talisman_modifiers/smite').significant).toBe(true);
    });
});
