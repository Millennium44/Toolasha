/**
 * Party Finder arithmetic: which parties are planned, how they are built, and how a finished sim is read and
 * ranked for you alone.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const pricing = vi.hoisted(() => ({ throwFor: null, unpriced: [], capped: null }));

vi.mock('./combat-sim-adapter.js', () => ({
    // Profit read from a test-only `__profit` map, keyed by the player asked for
    calculateSimRevenue: (simResult, _gameData, playerHrid, hours) => {
        if (pricing.throwFor && simResult === pricing.throwFor) throw new Error('no market');
        return {
            netPerHour: (simResult.__profit?.[playerHrid] ?? 0) / hours,
            dropEntries: [{ itemHrid: '/items/x', name: 'X', countPerHour: 1 }],
            unpricedDrops: pricing.unpriced,
            unpricedConsumables: [],
            unpricedKeys: [],
        };
    },
    // Highest combat level takes no penalty; everyone below takes 0.1 per member above them, enough to tell
    recomputeLevelGapDebuffs: (players) => {
        const top = Math.max(...players.map((p) => p.magicLevel));
        for (const p of players) p.debuffOnLevelGap = p.magicLevel < top ? 0.1 : 0;
    },
}));
vi.mock('../../utils/liquidity-cap.js', () => ({
    capProfitRateCached: ({ goldPerHour }) =>
        pricing.capped != null && goldPerHour > pricing.capped
            ? { goldPerHour: pricing.capped, capped: true, limit: { note: 'vol' } }
            : { goldPerHour, capped: false, limit: null },
}));
vi.mock('../../core/storage.js', () => ({ default: {} }));

const {
    planSweep,
    enumerateCompositions,
    narrowRoster,
    countCompositionsUpperBound,
    buildCompositionParty,
    readResult,
    repriceMetrics,
    soloDelta,
    sortRows,
    pickRerunRows,
    partyLabel,
    csvRow,
    stoppedSweepText,
    MAX_QUICK_RUNS,
} = await import('./party-finder.js');

const HOUR = 3600 * 1e9;

function dto(magicLevel = 90, weapon = '/items/rippling_trident') {
    return {
        staminaLevel: 90,
        intelligenceLevel: 90,
        attackLevel: 90,
        meleeLevel: 90,
        defenseLevel: 90,
        rangedLevel: 1,
        magicLevel,
        equipment: { '/equipment_types/main_hand': { hrid: weapon, enhancementLevel: 5 } },
        food: [null, null, null],
        drinks: [null, null, null],
        abilities: [null, null, null, null, null],
    };
}

const mate = (id, name, build = dto(80 + id.length)) => ({ id, name, dto: build });

const ZONE = { zoneHrid: '/actions/combat/swamp_planet', difficultyTier: 1, isDungeon: false, name: 'Swamp Planet' };
const DUNGEON = { zoneHrid: '/actions/combat/chimerical_den', difficultyTier: 0, isDungeon: true, name: 'Den' };

beforeEach(() => {
    pricing.throwFor = null;
    pricing.unpriced = [];
    pricing.capped = null;
});

describe('planSweep', () => {
    const four = [mate('a', 'Ann'), mate('bb', 'Bob'), mate('ccc', 'Cy'), mate('dddd', 'Di')];

    test('a 3-player zone tries solo, every single and every pair; a dungeon goes up to four teammates', () => {
        const zone = planSweep({ zones: [ZONE], roster: four });
        // 1 + 4 + 6
        expect(zone.total).toBe(11);
        expect(Math.max(...zone.tasks.map((t) => t.comp.members.length))).toBe(2);

        const dungeon = planSweep({ zones: [DUNGEON], roster: four });
        // 1 + 4 + 6 + 4 + 1
        expect(dungeon.total).toBe(16);
        expect(Math.max(...dungeon.tasks.map((t) => t.comp.members.length))).toBe(4);
    });

    test('solo baselines of every zone come first, so a stop still leaves them', () => {
        const plan = planSweep({ zones: [ZONE, DUNGEON], roster: four });
        expect(plan.tasks.slice(0, 2).every((t) => t.comp.isBaseline)).toBe(true);
        expect(plan.tasks.slice(2).some((t) => t.comp.isBaseline)).toBe(false);
    });

    test('the max party size narrows every zone, never past its own cap', () => {
        const plan = planSweep({ zones: [ZONE, DUNGEON], roster: four, maxPartySize: 2 });
        expect(plan.total).toBe(10);
        expect(Math.max(...plan.tasks.map((t) => t.comp.members.length))).toBe(1);
    });

    test('must-include and exclude', () => {
        const plan = planSweep({ zones: [ZONE], roster: four, choices: { a: 'always', dddd: 'never' } });
        const parties = plan.tasks.filter((t) => !t.comp.isBaseline).map((t) => partyLabel(t.comp));
        expect(parties).toEqual(['Ann', 'Ann + Bob', 'Ann + Cy']);
        expect(plan.tasks[0].comp.isBaseline).toBe(true);
    });

    test('more must-includes than a zone can hold: that zone runs nothing and says why', () => {
        const plan = planSweep({
            zones: [ZONE, DUNGEON],
            roster: four,
            choices: { a: 'always', bb: 'always', ccc: 'always' },
        });
        const zoneEntry = plan.perZone.find((z) => z.zone === ZONE);
        expect(zoneEntry.count).toBe(0);
        expect(zoneEntry.note).toMatch(/Ann, Bob, Cy cannot all fit in a 3-player party/);
        expect(plan.tasks.every((t) => t.zone === DUNGEON)).toBe(true);
    });

    test('an empty roster plans nothing and says so', () => {
        const plan = planSweep({ zones: [ZONE], roster: [] });
        expect(plan.total).toBe(0);
        expect(plan.perZone[0].note).toBe('no teammates to try');
    });

    test('zero zones plans nothing', () => {
        expect(planSweep({ zones: [], roster: four }).total).toBe(0);
    });

    test('the same zone/tier picked twice is planned once', () => {
        expect(planSweep({ zones: [ZONE, { ...ZONE }], roster: four }).total).toBe(11);
    });

    test('a sweep over the limit is refused, before enumerating a huge one', () => {
        const forty = Array.from({ length: 40 }, (_, i) => mate(`m${i}`, `M${i}`, dto(60 + i)));
        const plan = planSweep({ zones: [DUNGEON], roster: forty });
        expect(plan.refused).toMatch(/over the 1,500 limit/);
        expect(plan.tasks).toEqual([]);

        // 1 + 40 + 780 per zone, two zones: over the limit after enumerating
        const two = planSweep({ zones: [ZONE, { ...ZONE, difficultyTier: 2 }], roster: forty });
        expect(two.total).toBe(1642);
        expect(two.total).toBeGreaterThan(MAX_QUICK_RUNS);
        expect(two.refused).toMatch(/1,642/);
    });
});

describe('enumerateCompositions', () => {
    test('the same build saved twice, under the same name or not, is one party with an alias', () => {
        const same = dto(99);
        const { pool, mustInclude } = narrowRoster([
            mate('a', 'Bob', same),
            mate('b', 'Bob', structuredClone(same)),
            mate('c', 'Cy', dto(70)),
        ]);
        const comps = enumerateCompositions(pool, mustInclude, 2);
        const labels = comps.map(partyLabel);
        // Solo, Bob, Cy, Bob+Bob (two copies is a real party), Bob+Cy
        expect(labels).toEqual(['Solo', 'Bob', 'Cy', 'Bob + Bob', 'Bob + Cy']);
        expect(comps.find((c) => partyLabel(c) === 'Bob').aliases).toEqual([['Bob']]);
    });

    test('the cheap upper bound matches the count with distinct builds', () => {
        const roster = Array.from({ length: 6 }, (_, i) => mate(`m${i}`, `M${i}`, dto(60 + i)));
        const { pool, mustInclude } = narrowRoster(roster);
        expect(enumerateCompositions(pool, mustInclude, 4)).toHaveLength(countCompositionsUpperBound(6, 0, 4));
        const narrowed = narrowRoster(roster, { m0: 'always' });
        expect(enumerateCompositions(narrowed.pool, narrowed.mustInclude, 2)).toHaveLength(
            countCompositionsUpperBound(6, 1, 2)
        );
    });
});

describe('buildCompositionParty', () => {
    test('you are player1, teammates follow, each a copy with this party’s level gaps', () => {
        const self = { ...dto(90), hrid: 'player3', debuffOnLevelGap: 0.3 };
        const high = mate('a', 'High', dto(120));
        const party = buildCompositionParty(self, [high, mate('b', 'Low', dto(70))]);
        expect(party.map((p) => p.hrid)).toEqual(['player1', 'player2', 'player3']);
        expect(party.map((p) => p.debuffOnLevelGap)).toEqual([0.1, 0, 0.1]);
        // Copies: the roster's own build is untouched
        party[1].magicLevel = 1;
        expect(high.dto.magicLevel).toBe(120);
        expect(self.hrid).toBe('player3');
    });

    test('alone there is no level-gap penalty', () => {
        const [solo] = buildCompositionParty({ ...dto(), debuffOnLevelGap: 0.4 }, []);
        expect(solo.debuffOnLevelGap).toBe(0);
    });
});

describe('readResult', () => {
    const sim = (xp, profit, deaths = 0, hours = 2) => ({
        simulatedTime: hours * HOUR,
        experienceGained: { player1: { magic: xp }, player2: { magic: 99999 } },
        deaths: { player1: deaths, player2: 50 },
        __profit: { player1: profit, player2: 99999 },
    });

    test('reads you, never the party', () => {
        const m = readResult(sim(2000, 400, 1), {}, 2);
        expect(m.xpPerHour).toBe(1000);
        expect(m.profitPerHour).toBe(200);
        expect(m.deathsPerHour).toBe(0.5);
    });

    test('a failed sim is a failed row', () => {
        expect(readResult(null, {}, 2)).toEqual({ failed: true });
    });

    test('pricing that throws leaves profit null, not 0', () => {
        const s = sim(100, 100);
        pricing.throwFor = s;
        expect(readResult(s, {}, 2).profitPerHour).toBeNull();
    });

    test('unpriced loot is named on the row', () => {
        pricing.unpriced = ['/items/mystery_box'];
        expect(readResult(sim(100, 100), {}, 2).unpriced).toEqual(['/items/mystery_box']);
    });

    test('a volume cap bounds the shown profit and keeps the raw one', () => {
        pricing.capped = 50;
        const m = readResult(sim(100, 400), {}, 2);
        expect(m.profitPerHour).toBe(50);
        expect(m.uncappedProfit).toBe(200);
    });

    test('repricing keeps the sim and re-reads the price', () => {
        const m = readResult(sim(100, 400), {}, 2);
        pricing.capped = 10;
        expect(repriceMetrics(m, {}).profitPerHour).toBe(10);
        expect(repriceMetrics(m, {}).xpPerHour).toBe(m.xpPerHour);
    });
});

describe('ranking against solo', () => {
    const metrics = (xpPerHour, profitPerHour, hours = 2) => ({
        failed: false,
        hours,
        xpPerHour,
        profitPerHour,
        deathsPerHour: 0,
        unpriced: [],
    });
    const row = (key, quick, full = null, isBaseline = false) => ({
        id: key,
        zoneKey: 'z',
        zone: ZONE,
        isBaseline,
        comp: isBaseline ? { isBaseline: true, members: [] } : { members: [{ name: key }] },
        quick,
        full,
    });

    test('a party worse than solo has a negative delta', () => {
        const base = row('solo', metrics(1000, 100), null, true);
        const worse = row('Bob', metrics(800, 50));
        expect(soloDelta(worse, base)).toEqual({ xpPct: -20, profitDelta: -50, stage: 'quick' });
    });

    test('like against like: full re-runs compare with the full baseline, else both quick', () => {
        const base = row('solo', metrics(1000, 100), metrics(900, 90, 10), true);
        const party = row('Bob', metrics(1100, 120), metrics(990, 99, 10));
        expect(soloDelta(party, base).stage).toBe('full');
        expect(soloDelta(party, base).xpPct).toBeCloseTo(10);

        const baseQuickOnly = row('solo', metrics(1000, 100), null, true);
        expect(soloDelta(party, baseQuickOnly)).toEqual({ xpPct: 10, profitDelta: 20, stage: 'quick' });
    });

    test('unpriced profit sinks to the bottom of a profit sort either way round', () => {
        const base = row('solo', metrics(1000, 100), null, true);
        const rows = [row('A', metrics(1, null)), row('B', metrics(1, 300)), base];
        const baselines = new Map([['z', base]]);
        expect(sortRows(rows, baselines, 'profit').map((r) => r.id)).toEqual(['B', 'solo', 'A']);
        expect(sortRows(rows, baselines, 'profit', true).map((r) => r.id)).toEqual(['solo', 'B', 'A']);
    });

    test('the re-run picks the top K parties and their baselines, baselines first', () => {
        const base = row('solo', metrics(1000, 100), null, true);
        const rows = [base, row('A', metrics(1500, 0)), row('B', metrics(1200, 0)), row('C', metrics(1100, 0))];
        const picked = pickRerunRows(rows, new Map([['z', base]]), 'xp', 2);
        expect(picked.map((r) => r.id)).toEqual(['solo', 'A', 'B']);
        expect(pickRerunRows(rows, new Map([['z', base]]), 'xp', 0)).toEqual([]);
    });

    test('a failed row is never re-run and has no figures in the CSV', () => {
        const base = row('solo', metrics(1000, 100), null, true);
        const failed = row('F', { failed: true });
        expect(pickRerunRows([base, failed], new Map([['z', base]]), 'xp', 5)).toEqual([]);
        expect(csvRow(failed, base)).toMatchObject({ xpPerHour: '', note: 'sim failed' });
    });

    test('the CSV row', () => {
        const base = row('solo', metrics(1000, 100), null, true);
        expect(csvRow(row('Bob', metrics(1200, 150)), base)).toMatchObject({
            zone: 'Swamp Planet',
            tier: 1,
            party: 'Bob',
            size: 2,
            xpPerHour: 1200,
            profitPerHour: 150,
            xpVsSoloPct: 20,
            profitVsSolo: 50,
            comparedAt: 'quick pass',
        });
    });

    test('stopped text', () => {
        expect(stoppedSweepText(3, 12)).toBe('stopped early — 3 of 12 sims');
    });
});
