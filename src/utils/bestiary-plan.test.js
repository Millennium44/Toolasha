import { describe, test, expect } from 'vitest';
import { planBestiaryRoute, rescaleDungeonRates, formatPlanHours, formatPlanText } from './bestiary-plan.js';
import { pointsFromCount, monsterCreditsPerHour, resolvePartySize } from './bestiary.js';
import { fightsForKillConfidence } from './fight-confidence.js';

const zone = (zoneHrid, creditsPerHour, name = zoneHrid) => ({ zoneHrid, name, creditsPerHour });

describe('planning a Bestiary route', () => {
    test('nothing to plan: no zones, no budget, or zones that kill nothing', () => {
        const empty = planBestiaryRoute({ zones: [], counts: {}, hours: 24 });
        expect(empty.segments).toEqual([]);
        expect(empty.totalPoints).toBe(0);
        expect(empty.bestSingle).toBeNull();
        expect(empty.hoursUsed).toBe(0);

        expect(
            planBestiaryRoute({ zones: [zone('a', { '/monsters/fly': 10 })], counts: {}, hours: 0 }).segments
        ).toEqual([]);
        expect(
            planBestiaryRoute({ zones: [zone('a', { '/monsters/fly': 0 })], counts: {}, hours: 5 }).segments
        ).toEqual([]);
        expect(planBestiaryRoute().segments).toEqual([]);
    });

    test('hops to whichever zone has the nearest threshold, and merges a zone held twice', () => {
        // Fly is at 8 kills: two more to the 10 threshold at 10/hr → 12 min.
        // Rat is unmet: one kill at 2/hr → 30 min. Both in zone a; zone b has
        // a slow bee, unmet, 1/hr → 1 h.
        const plan = planBestiaryRoute({
            zones: [zone('a', { '/monsters/fly': 10, '/monsters/rat': 2 }), zone('b', { '/monsters/bee': 1 })],
            counts: { '/monsters/fly': 8 },
            hours: 1,
        });

        // a (fly → 10, 0.2 h), then a again (rat → 1, needs 0.5 h total, 0.3 h more): merged
        expect(plan.segments[0].zoneHrid).toBe('a');
        expect(plan.segments[0].hours).toBeCloseTo(0.5, 9);
        expect(plan.segments[0].points).toBe(2 + 1);
        expect(plan.segments[0].partial).toBe(false);
        const crossed = plan.segments[0].monsters.filter((m) => m.reached).map((m) => [m.monsterHrid, m.from, m.to]);
        expect(crossed).toEqual([
            ['/monsters/fly', 8, 10],
            ['/monsters/rat', 0, 1],
        ]);
        // Then b for the bee (1 h from 0, but only 0.5 h left): truncated, partial
        expect(plan.segments[1].zoneHrid).toBe('b');
        expect(plan.segments[1].hours).toBeCloseTo(0.5, 9);
        expect(plan.segments[1].partial).toBe(true);
        expect(plan.segments[1].points).toBe(0);
        expect(plan.segments[1].monsters[0]).toMatchObject({ monsterHrid: '/monsters/bee', reached: false, to: 1 });
        expect(plan.segments[1].monsters[0].count).toBeCloseTo(0.5, 9);

        expect(plan.totalPoints).toBe(3);
        expect(plan.pointsByZone).toEqual({ a: 3, b: 0 });
        expect(plan.hoursUsed).toBeCloseTo(1, 9);
    });

    test('the budget is respected and the last segment is truncated proportionally', () => {
        const plan = planBestiaryRoute({
            zones: [zone('a', { '/monsters/fly': 4 })],
            counts: { '/monsters/fly': 1 },
            hours: 1,
        });
        // 9 kills to 10 at 4/hr is 2.25 h; one hour gets 4 of them
        expect(plan.segments).toHaveLength(1);
        expect(plan.segments[0].partial).toBe(true);
        expect(plan.segments[0].hours).toBe(1);
        expect(plan.segments[0].monsters[0].count).toBeCloseTo(5, 9);
        expect(plan.counts['/monsters/fly']).toBeCloseTo(5, 9);
        expect(plan.totalPoints).toBe(0);
        expect(plan.segments.reduce((s, seg) => s + seg.hours, 0)).toBeLessThanOrEqual(1 + 1e-9);
    });

    test('ties go to the earlier zone', () => {
        const plan = planBestiaryRoute({
            zones: [zone('second', { '/monsters/x': 1 }), zone('first', { '/monsters/y': 1 })],
            counts: {},
            hours: 1,
        });
        expect(plan.segments[0].zoneHrid).toBe('second');
        // Same again with the order swapped
        const swapped = planBestiaryRoute({
            zones: [zone('first', { '/monsters/y': 1 }), zone('second', { '/monsters/x': 1 })],
            counts: {},
            hours: 1,
        });
        expect(swapped.segments[0].zoneHrid).toBe('first');
    });

    test('points never decrease along the route and match the point formula', () => {
        const zones = [
            zone('a', { '/monsters/fly': 30, '/monsters/rat': 7 }),
            zone('b', { '/monsters/bee': 12, '/monsters/fly': 3 }),
            zone('c', { '/monsters/wolf': 0.5 }),
        ];
        const counts = { '/monsters/fly': 95, '/monsters/rat': 3, '/monsters/bee': 0, '/monsters/wolf': 9 };
        let previous = -1;
        for (const hours of [0.5, 1, 2, 4, 8, 24, 72]) {
            const plan = planBestiaryRoute({ zones, counts, hours });
            expect(plan.totalPoints).toBeGreaterThanOrEqual(previous);
            previous = plan.totalPoints;
            expect(plan.hoursUsed).toBeLessThanOrEqual(hours + 1e-9);
            // The total is exactly what the final counts are worth over the starting ones
            const worth = Object.keys(plan.counts).reduce(
                (sum, hrid) => sum + pointsFromCount(plan.counts[hrid]) - pointsFromCount(counts[hrid] || 0),
                0
            );
            expect(plan.totalPoints).toBe(worth);
            expect(plan.segments.reduce((s, seg) => s + seg.points, 0)).toBe(plan.totalPoints);
            // Each segment was earned by the zone it names
            expect(Object.values(plan.pointsByZone).reduce((s, v) => s + v, 0)).toBe(plan.totalPoints);
            // No two neighbours name the same zone
            for (let i = 1; i < plan.segments.length; i += 1) {
                expect(plan.segments[i].zoneHrid).not.toBe(plan.segments[i - 1].zoneHrid);
            }
        }
    });

    test('a single zone held for the budget is the comparison, and the route does at least as well', () => {
        const plan = planBestiaryRoute({
            zones: [
                zone('a', { '/monsters/fly': 10 }, 'Farm'),
                zone('b', { '/monsters/bee': 10, '/monsters/wasp': 10 }),
            ],
            counts: { '/monsters/fly': 0, '/monsters/bee': 9, '/monsters/wasp': 99 },
            hours: 0.5,
        });
        // b alone: bee 9→14 (+2), wasp 99→104 (+3) = 5; a alone: fly 0→5 (+1)
        expect(plan.bestSingle).toEqual({ zoneHrid: 'b', name: 'b', points: 5, encounters: null });
        // The route: fly (0.1 h), bee (0.1 h), wasp (0.1 h), then fly again … ≥ 6
        expect(plan.totalPoints).toBeGreaterThanOrEqual(plan.bestSingle.points);
    });

    test('the single-zone comparison keeps the fractional starting count, not a floored one', () => {
        // Counts are Bestiary credits, not kills, and a party split leaves them
        // openly fractional (see bestiary.js). 9.9 credits plus the tenth of a
        // credit this stay earns (0.01 h at 10/hr) lands exactly on 10 and
        // crosses both the 1 and 10 thresholds — a floored 9 would need a
        // whole hour more to get there and crosses nothing in this stay.
        const fractional = planBestiaryRoute({
            zones: [zone('b', { '/monsters/bee': 10 })],
            counts: { '/monsters/bee': 9.9 },
            hours: 0.01,
        });
        const whole = planBestiaryRoute({
            zones: [zone('b', { '/monsters/bee': 10 })],
            counts: { '/monsters/bee': 9 },
            hours: 0.01,
        });

        expect(fractional.bestSingle.points).toBe(2);
        expect(whole.bestSingle.points).toBe(0);
        expect(fractional.bestSingle.points).not.toBe(whole.bestSingle.points);
    });

    test('a negative or non-finite starting count still clamps to 0', () => {
        const plan = planBestiaryRoute({
            zones: [zone('a', { '/monsters/fly': 10 })],
            counts: { '/monsters/fly': -5, '/monsters/rat': NaN, '/monsters/wolf': Infinity },
            hours: 0.1,
        });
        // -5 clamps to 0, so one hop of ten kills/hour for 0.1 h reaches 1 kill
        // (the first point) rather than being credited from a negative start
        expect(plan.segments[0].monsters.find((m) => m.monsterHrid === '/monsters/fly')).toMatchObject({
            from: 0,
            reached: true,
        });
    });

    test('the single-zone comparison is not measured from the counts the route already advanced', () => {
        // The route spends the whole budget raising these counts; the
        // comparison must still be measured from where everything started
        const plan = planBestiaryRoute({
            zones: [zone('a', { '/monsters/fly': 10 }, 'Farm'), zone('b', { '/monsters/bee': 60 })],
            counts: { '/monsters/fly': 0, '/monsters/bee': 0 },
            hours: 2,
        });

        // What b earns held alone, measured on its own with nothing to share
        // the budget with
        const bAlone = planBestiaryRoute({
            zones: [zone('b', { '/monsters/bee': 60 })],
            counts: { '/monsters/bee': 0 },
            hours: 2,
        });
        expect(plan.bestSingle.zoneHrid).toBe('b');
        expect(plan.bestSingle.points).toBe(bAlone.totalPoints);
        expect(plan.totalPoints).toBeGreaterThanOrEqual(plan.bestSingle.points);
    });

    test('zones with no kill rates are skipped without affecting the order', () => {
        const plan = planBestiaryRoute({
            zones: [zone('none', {}), zone('a', { '/monsters/fly': 1 })],
            counts: {},
            hours: 2,
        });
        expect(plan.segments[0].zoneHrid).toBe('a');
        expect(plan.pointsByZone.none).toBeUndefined();
    });
});

describe('tie-breaking near-equal bestiary pace by score', () => {
    test('two zones tied on bestiary pace: the higher score wins (Aqua Planet T0 vs T3)', () => {
        // Both reach their next point in exactly the same time — the live
        // all-zones table case: 29.0 pts/day either way, but T3 has roughly
        // double the XP/hr and profit/day, which shows up only as `score`
        const plan = planBestiaryRoute({
            zones: [
                { zoneHrid: 'aqua-t0', name: 'Aqua Planet T0', creditsPerHour: { '/monsters/fish': 10 }, score: 20 },
                { zoneHrid: 'aqua-t3', name: 'Aqua Planet T3', creditsPerHour: { '/monsters/shark': 10 }, score: 70 },
            ],
            counts: {},
            hours: 0.5,
            tolerancePercent: 10,
        });
        expect(plan.segments[0].zoneHrid).toBe('aqua-t3');
    });

    test('a row 5% slower but with a much higher score wins at tolerance 10, and loses at tolerance 0', () => {
        // fast: a point at 1 kill / 1 per hour = 1 h. slow: same point at
        // 1/1.05 per hour = 1.05 h — five percent slower, on the nose
        const zones = [
            { zoneHrid: 'fast', name: 'Fast', creditsPerHour: { '/monsters/a': 1 }, score: 10 },
            { zoneHrid: 'slow', name: 'Slow', creditsPerHour: { '/monsters/b': 1 / 1.05 }, score: 90 },
        ];

        const within = planBestiaryRoute({ zones, counts: {}, hours: 2, tolerancePercent: 10 });
        expect(within.segments[0].zoneHrid).toBe('slow');
        expect(within.segments[0].viaScore).toBe(true);

        const strict = planBestiaryRoute({ zones, counts: {}, hours: 2, tolerancePercent: 0 });
        expect(strict.segments[0].zoneHrid).toBe('fast');
        expect(strict.segments[0].viaScore).toBe(false);
    });

    test('tolerance 0 ignores score entirely and reproduces the old, speed-only route', () => {
        const zones = [
            { zoneHrid: 'fast', name: 'Fast', creditsPerHour: { '/monsters/a': 1 }, score: 1 },
            { zoneHrid: 'slow', name: 'Slow', creditsPerHour: { '/monsters/b': 0.5 }, score: 99 },
        ];
        const explicit = planBestiaryRoute({ zones, counts: {}, hours: 5, tolerancePercent: 0 });
        expect(explicit.segments[0].zoneHrid).toBe('fast');
        expect(explicit.segments[0].viaScore).toBe(false);
        // Not passing tolerancePercent at all defaults to the same thing
        const implicit = planBestiaryRoute({ zones, counts: {}, hours: 5 });
        expect(implicit).toEqual(explicit);
    });

    test('identical rows resolve to the earlier one, deterministically across runs', () => {
        const zones = [
            { zoneHrid: 'x', name: 'X', creditsPerHour: { '/monsters/a': 1 }, score: 50 },
            { zoneHrid: 'y', name: 'Y', creditsPerHour: { '/monsters/b': 1 }, score: 50 },
        ];
        for (let i = 0; i < 5; i += 1) {
            const plan = planBestiaryRoute({ zones, counts: {}, hours: 1, tolerancePercent: 10 });
            expect(plan.segments[0].zoneHrid).toBe('x');
        }
    });

    test('the route total reflects the rows the tie-break actually chose, not the fastest ones', () => {
        const zones = [
            { zoneHrid: 'fast', name: 'Fast', creditsPerHour: { '/monsters/a': 1 }, score: 10 },
            { zoneHrid: 'slow', name: 'Slow', creditsPerHour: { '/monsters/b': 1 / 1.05 }, score: 90 },
        ];
        const plan = planBestiaryRoute({ zones, counts: {}, hours: 2, tolerancePercent: 10 });
        expect(plan.segments[0].zoneHrid).toBe('slow');
        // Same truthfulness check the untouched route uses: the total is
        // exactly what the final counts are worth over the starting ones
        const worth = Object.keys(plan.counts).reduce(
            (sum, hrid) => sum + pointsFromCount(plan.counts[hrid]) - pointsFromCount(0),
            0
        );
        expect(plan.totalPoints).toBe(worth);
        expect(plan.segments.reduce((s, seg) => s + seg.points, 0)).toBe(plan.totalPoints);
    });
});

describe('plan text', () => {
    test('hours read as h:mm', () => {
        expect(formatPlanHours(0)).toBe('0:00');
        expect(formatPlanHours(0.5)).toBe('0:30');
        expect(formatPlanHours(25.25)).toBe('25:15');
        expect(formatPlanHours(1 / 120)).toBe('0:01');
    });

    test('the plain-text version lists the steps, the crossings, and the single-zone comparison', () => {
        const plan = planBestiaryRoute({
            zones: [zone('a', { '/monsters/fly': 10 }, 'Farm T0'), zone('b', { '/monsters/bee': 1 }, 'Hive T1')],
            counts: { '/monsters/fly': 8 },
            hours: 1,
        });
        const text = formatPlanText(plan, { monsterName: (hrid) => hrid.replace('/monsters/', '') });
        expect(text.split('\n')[0]).toBe('Bestiary plan — 1:00 h, 2 points');
        expect(text).toContain('1. Farm T0 — 0:12 — +2 — fly 8→10');
        expect(text).toContain('2. Hive T1 — 0:48 — +0 — (partial: bee 0/1)');
        expect(text).toContain('Best single zone: Farm T0 — 2 points');
        expect(formatPlanText(null)).toBe('');
    });
});

describe('fights per stay', () => {
    test('a zone with a fight rate quotes each stay in fights, merged stays add up, unknown rates read null', () => {
        const zones = [
            { zoneHrid: 'a', name: 'a', creditsPerHour: { fly: 10 }, encountersPerHour: 120 },
            { zoneHrid: 'b', name: 'b', creditsPerHour: { bee: 10 } },
        ];
        // Padding off, so this stays a test of the raw rate arithmetic; the
        // confidence padding has its own describe below.
        const plan = planBestiaryRoute({
            zones,
            counts: { fly: 0, bee: 0 },
            hours: 1,
            confidencePercent: 0,
            bufferPercent: 0,
            isBossMonster: () => false,
        });
        const a = plan.segments.filter((seg) => seg.zoneHrid === 'a');
        const b = plan.segments.filter((seg) => seg.zoneHrid === 'b');
        expect(a.length).toBeGreaterThan(0);
        for (const seg of a) expect(seg.encounters).toBeCloseTo(120 * seg.hours, 6);
        for (const seg of b) expect(seg.encounters).toBeNull();
        expect(plan.bestSingle.encounters === null || plan.bestSingle.encounters > 0).toBe(true);
        const text = formatPlanText(plan);
        expect(text).toMatch(/≈\d+ fights/);
    });
});

describe('planning to a points target', () => {
    test('stops at the first crossing that reaches the target, and reports how long it took', () => {
        // Fly 10/hr from 0: a point at 1 kill (0.1 h), the next at 10 (0.9 h more).
        // Bee 5/hr from 0: a point at 1 kill (0.2 h).
        const plan = planBestiaryRoute({
            zones: [zone('a', { '/monsters/fly': 10 }), zone('b', { '/monsters/bee': 5 })],
            counts: {},
            targetPoints: 2,
        });
        expect(plan.mode).toBe('points');
        expect(plan.targetPoints).toBe(2);
        expect(plan.unreachable).toBe(false);
        // a for the fly's first kill (+1, 0.1 h), then b for the bee's (+1, 0.2 h)
        // — and nothing after, because the second point is the target
        expect(plan.totalPoints).toBe(2);
        expect(plan.segments.map((s) => s.zoneHrid)).toEqual(['a', 'b']);
        expect(plan.hoursUsed).toBeCloseTo(0.3, 9);
        expect(plan.hours).toBeCloseTo(plan.hoursUsed, 9);
        // Nothing is planned past the crossing that got there
        expect(plan.segments[plan.segments.length - 1].partial).toBe(false);
    });

    test('a target the route overshoots is reported at the crossing that took it past', () => {
        // Wasp at 99 crossing 100 is worth +3 on its own
        const plan = planBestiaryRoute({
            zones: [zone('a', { '/monsters/wasp': 10 })],
            counts: { '/monsters/wasp': 99 },
            targetPoints: 2,
        });
        expect(plan.totalPoints).toBe(3);
        expect(plan.totalPoints).toBeGreaterThanOrEqual(plan.targetPoints);
        expect(plan.segments).toHaveLength(1);
        expect(plan.hoursUsed).toBeCloseTo(0.1, 9);
        expect(plan.unreachable).toBe(false);
    });

    test('a target reached exactly stops there', () => {
        const plan = planBestiaryRoute({
            zones: [zone('a', { '/monsters/fly': 1 })],
            counts: {},
            targetPoints: 1,
        });
        expect(plan.totalPoints).toBe(1);
        expect(plan.hoursUsed).toBeCloseTo(1, 9);
        expect(plan.segments).toHaveLength(1);
    });

    test('no zone that kills anything means the target is unreachable, with what was reached', () => {
        const plan = planBestiaryRoute({ zones: [zone('a', { '/monsters/fly': 0 })], counts: {}, targetPoints: 5 });
        expect(plan.unreachable).toBe(true);
        expect(plan.totalPoints).toBe(0);
        expect(plan.segments).toEqual([]);
        expect(plan.bestSingle).toBeNull();
    });

    test('a target beyond patience is unreachable, and the single-zone time is null', () => {
        // One kill a century: the first point lands, the tenth kill never does
        const plan = planBestiaryRoute({
            zones: [zone('slow', { '/monsters/snail': 1e-6 })],
            counts: {},
            targetPoints: 4,
        });
        expect(plan.unreachable).toBe(true);
        expect(plan.cappedOut).toBe(true);
        expect(plan.totalPoints).toBe(1);
        expect(plan.bestSingle.hours).toBeNull();
        const text = formatPlanText(plan);
        expect(text).toContain('Best single zone: none reaches 4 points');
    });

    test('the single-zone comparison is the soonest one zone gets there alone', () => {
        const plan = planBestiaryRoute({
            zones: [zone('slow', { '/monsters/bee': 1 }, 'Hive'), zone('fast', { '/monsters/fly': 10 }, 'Farm')],
            counts: {},
            targetPoints: 3,
        });
        // Farm alone: fly 0 to 1 (+1) at 0.1 h, 1 to 10 (+2) at 1 h = 3 points in 1 h.
        // Hive alone: bee 0 to 1 (+1) at 1 h, 1 to 10 (+2) at 10 h = 3 points in 10 h.
        expect(plan.bestSingle.name).toBe('Farm');
        expect(plan.bestSingle.hours).toBeCloseTo(1, 9);
        expect(plan.bestSingle.points).toBe(3);
        const text = formatPlanText(plan);
        expect(text.split('\n')[0]).toMatch(/^Bestiary plan — 3 points in /);
        expect(text).toContain('Best single zone: Farm — reaches 3 in 1:00 h');
    });

    test('a points target ignores the hours budget entirely', () => {
        const withHours = planBestiaryRoute({
            zones: [zone('a', { '/monsters/bee': 1 })],
            counts: {},
            hours: 0.1,
            targetPoints: 1,
        });
        expect(withHours.hoursUsed).toBeCloseTo(1, 9);
        expect(withHours.totalPoints).toBe(1);
    });

    test('hours mode is untouched by the new fields', () => {
        const plan = planBestiaryRoute({ zones: [zone('a', { '/monsters/fly': 10 })], counts: {}, hours: 1 });
        expect(plan.mode).toBe('hours');
        expect(plan.targetPoints).toBeNull();
        expect(plan.unreachable).toBe(false);
        expect(plan.hours).toBe(1);
    });
});

describe('a dungeon at your own clear time', () => {
    // 6 clears an hour: 10 goblins and 1 king to a clear
    const sim = { '/monsters/goblin': 60, '/monsters/king': 6 };

    test('measured runs for the tier rescale the sim rates to your pace', () => {
        // Twenty minutes a clear is three an hour, half the sim's six
        const runs = [
            { tier: 1, duration: 1_200_000 },
            { tier: 1, duration: 1_200_000 },
            { tier: 0, duration: 60_000 },
        ];
        const scaled = rescaleDungeonRates({ creditsPerHour: sim, simClearsPerHour: 6, runs, tier: 1 });
        expect(scaled.source).toBe('measured');
        expect(scaled.runs).toBe(2);
        expect(scaled.clearSeconds).toBe(1200);
        expect(scaled.clearsPerHour).toBeCloseTo(3, 9);
        expect(scaled.creditsPerHour['/monsters/goblin']).toBeCloseTo(30, 9);
        expect(scaled.creditsPerHour['/monsters/king']).toBeCloseTo(3, 9);
    });

    test('a tier with no runs falls back to the dungeon median, and says so', () => {
        const runs = [
            { tier: 0, duration: 1_200_000 },
            { tier: 0, totalTime: 1_200_000 },
        ];
        const scaled = rescaleDungeonRates({ creditsPerHour: sim, simClearsPerHour: 6, runs, tier: 2 });
        expect(scaled.source).toBe('measured-all-tiers');
        expect(scaled.runs).toBe(2);
        expect(scaled.clearsPerHour).toBeCloseTo(3, 9);
    });

    test('with no runs at all the sim clear time stands, unchanged', () => {
        const scaled = rescaleDungeonRates({ creditsPerHour: sim, simClearsPerHour: 6, runs: [], tier: 1 });
        expect(scaled.source).toBe('sim');
        expect(scaled.runs).toBe(0);
        expect(scaled.clearSeconds).toBeCloseTo(600, 9);
        expect(scaled.creditsPerHour['/monsters/goblin']).toBeCloseTo(60, 9);
        expect(scaled.creditsPerHour['/monsters/king']).toBeCloseTo(6, 9);
    });

    test('a dungeon the sim never cleared, or one that killed nothing, has no rate to rescale', () => {
        expect(rescaleDungeonRates({ creditsPerHour: sim, simClearsPerHour: 0, runs: [] })).toBeNull();
        expect(rescaleDungeonRates({ creditsPerHour: {}, simClearsPerHour: 6, runs: [] })).toBeNull();
        expect(rescaleDungeonRates()).toBeNull();
    });

    test('runs without a usable duration are ignored rather than counted as instant', () => {
        const runs = [{ tier: 1, duration: 0 }, { tier: 1 }, { tier: 1, duration: 1_800_000 }];
        const scaled = rescaleDungeonRates({ creditsPerHour: sim, simClearsPerHour: 6, runs, tier: 1 });
        expect(scaled.runs).toBe(1);
        expect(scaled.clearsPerHour).toBeCloseTo(2, 9);
    });

    test('a dungeon segment is quoted in clears, not fights', () => {
        const plan = planBestiaryRoute({
            zones: [
                {
                    zoneHrid: 'd|T1',
                    name: '[D] Den T1',
                    creditsPerHour: { '/monsters/goblin': 30 },
                    encountersPerHour: 3,
                    isDungeon: true,
                    note: 'measured (2 runs)',
                },
            ],
            counts: {},
            hours: 1,
        });
        expect(plan.segments[0].isDungeon).toBe(true);
        expect(plan.segments[0].note).toBe('measured (2 runs)');
        expect(formatPlanText(plan)).toMatch(/≈\d+ clears/);
    });
});

describe('fight-count confidence padding', () => {
    // One zone, one monster six kills short of its next threshold: the exact
    // shape of the maintainer's Crystal Colossus row.
    const sixShort = (creditsPerHour = 10, encountersPerHour = 100) => ({
        zones: [{ zoneHrid: 'z', name: 'z', creditsPerHour: { colossus: creditsPerHour }, encountersPerHour }],
        counts: { colossus: 94 },
        hours: 0.6,
    });

    test('a boss threshold pads nothing — not the quantile, not the flat floor', () => {
        const plan = planBestiaryRoute({
            ...sixShort(),
            confidencePercent: 90,
            bufferPercent: 5,
            isBossMonster: () => true,
        });
        const [segment] = plan.segments;
        expect(segment.monsters.find((m) => m.monsterHrid === 'colossus')).toMatchObject({ from: 94, to: 100 });
        // 6 kills at 0.1 per fight is 60 fights, exactly and always.
        expect(segment.encounters).toBeCloseTo(60, 6);
        expect(segment.encountersUnpadded).toBeCloseTo(60, 6);
        expect(segment.fightPadding).toBeNull();
    });

    test('the same row from the spawn table pads to the confidence quantile', () => {
        const plan = planBestiaryRoute({
            ...sixShort(),
            confidencePercent: 90,
            bufferPercent: 5,
            isBossMonster: () => false,
        });
        const [segment] = plan.segments;
        expect(segment.encountersUnpadded).toBeCloseTo(60, 6);
        expect(segment.encounters).toBe(91);
        expect(segment.fightPadding).toBe('confidence');
    });

    test('a small target pads proportionally far harder than a large one', () => {
        const small = planBestiaryRoute({
            ...sixShort(),
            confidencePercent: 90,
            bufferPercent: 0,
            isBossMonster: () => false,
        }).segments[0];
        // Black Bear 6167 -> 10000: 3833 kills in an hour at 13,832 fights.
        const large = planBestiaryRoute({
            zones: [{ zoneHrid: 'z', name: 'z', creditsPerHour: { bear: 3833 }, encountersPerHour: 13_832 }],
            counts: { bear: 6167 },
            hours: 1,
            confidencePercent: 90,
            bufferPercent: 0,
            isBossMonster: () => false,
        }).segments[0];

        expect(large.encounters).toBe(14_076);
        expect(small.encounters / small.encountersUnpadded).toBeGreaterThan(1.5);
        expect(large.encounters / large.encountersUnpadded).toBeLessThan(1.02);
    });

    test('a stay crossing several thresholds is sized by the hungriest one', () => {
        // `a` crosses 94 -> 100 (6 kills at 0.01/fight); `b` crosses
        // 900 -> 1000 (100 kills at 0.1/fight), both inside one merged stay.
        const plan = planBestiaryRoute({
            zones: [{ zoneHrid: 'z', name: 'z', creditsPerHour: { a: 10, b: 100 }, encountersPerHour: 1000 }],
            counts: { a: 94, b: 900 },
            hours: 1,
            confidencePercent: 90,
            bufferPercent: 0,
            isBossMonster: () => false,
        });
        const segment = plan.segments[0];
        expect(plan.segments).toHaveLength(1);
        expect(segment.monsters.filter((m) => m.reached)).toHaveLength(2);
        expect(segment.encountersUnpadded).toBeCloseTo(1000, 6);

        const each = [
            fightsForKillConfidence({ killsNeeded: 6, killsPerFight: 0.01, confidencePercent: 90 }),
            fightsForKillConfidence({ killsNeeded: 100, killsPerFight: 0.1, confidencePercent: 90 }),
        ];
        expect(segment.encounters).toBe(Math.max(...each));
        expect(segment.encounters).toBeGreaterThan(1000);
    });

    test('confidence off leaves the flat buffer as the floor', () => {
        const segment = planBestiaryRoute({
            ...sixShort(),
            confidencePercent: 0,
            bufferPercent: 5,
            isBossMonster: () => false,
        }).segments[0];
        expect(segment.encounters).toBe(63);
        expect(segment.fightPadding).toBe('flat');
    });

    test('both off leaves the raw prediction untouched, fractions and all', () => {
        const segment = planBestiaryRoute({
            ...sixShort(),
            confidencePercent: 0,
            bufferPercent: 0,
            isBossMonster: () => false,
        }).segments[0];
        expect(segment.encounters).toBeCloseTo(60, 6);
        expect(segment.fightPadding).toBeNull();
    });

    test('a zone with no fight rate is left alone rather than guessed at', () => {
        const segment = planBestiaryRoute({
            zones: [{ zoneHrid: 'z', name: 'z', creditsPerHour: { colossus: 10 } }],
            counts: { colossus: 94 },
            hours: 0.6,
            confidencePercent: 90,
            bufferPercent: 5,
            isBossMonster: () => false,
        }).segments[0];
        expect(segment.encounters).toBeNull();
        expect(segment.fightPadding).toBeNull();
    });
});

/**
 * A dungeon segment is quoted in clears, and a clear hands out many kills of
 * the same monster. Whether that count is random is a fact about the dungeon's
 * spawn tables — drawn from `randomSpawnInfoMap`, or written into a
 * `fixedSpawnsMap` roster — and never an inference from the rate, which is why
 * the shape is injected here the same way the boss test is.
 */
describe('a dungeon segment quoted in clears', () => {
    /** A 15-clear stay in a dungeon that hands out 12 imps and 1 boss a clear. */
    const denPlan = (spawnShape) =>
        planBestiaryRoute({
            zones: [
                {
                    zoneHrid: '/actions/combat/den|T0',
                    name: 'Den T0',
                    creditsPerHour: { '/monsters/imp': 120, '/monsters/boss': 10 },
                    encountersPerHour: 10,
                    isDungeon: true,
                },
            ],
            counts: { '/monsters/imp': 940, '/monsters/boss': 0 },
            hours: 0.5,
            confidencePercent: 90,
            bufferPercent: 0,
            isBossMonster: () => false,
            spawnShape,
        }).segments[0];

    test('a monster drawn from the wave tables is padded like any other', () => {
        const segment = denPlan(() => ({ slotsPerFight: 200, fixedOnly: new Set() }));
        expect(segment.encountersUnpadded).toBeCloseTo(5, 6);
        expect(segment.fightPadding).toBe('confidence');
        expect(segment.encounters).toBe(
            fightsForKillConfidence({
                killsNeeded: 60,
                killsPerFight: 12,
                slotsPerFight: 200,
                confidencePercent: 90,
            })
        );
        // Pre-fix: 5 clears, which crosses the threshold about half the time.
        expect(segment.encounters).toBeGreaterThan(5);
    });

    test('a monster written into a fixed wave keeps zero padding', () => {
        // The same stay, but the imp is the dungeon's fixed roster: twelve
        // every clear, always, so five clears is arithmetic.
        const segment = denPlan(() => ({
            slotsPerFight: 200,
            fixedOnly: new Set(['/monsters/imp', '/monsters/boss']),
        }));
        expect(segment.encounters).toBeCloseTo(5, 6);
        expect(segment.fightPadding).toBeNull();
    });

    test('spawn tables the game has not loaded pad rather than assume certainty', () => {
        const segment = denPlan(() => null);
        expect(segment.fightPadding).toBe('confidence');
        expect(segment.encounters).toBeGreaterThan(5);
    });
});

describe('the route is planned in credits, not bodies', () => {
    // One zone, one monster, 120 bodies over a 2 h sim = 60 kills/hr. The
    // Bestiary already holds 100 credits for it, so the next point is at 1,000.
    const sim = { deaths: { '/monsters/fly': 120, player1: 3 } };
    const simHours = 2;
    const counts = { '/monsters/fly': 100 };

    const planWith = (options, extra) =>
        planBestiaryRoute({
            zones: [
                {
                    zoneHrid: 'fly|T0',
                    name: 'fly',
                    creditsPerHour: monsterCreditsPerHour(sim, simHours, options),
                    encountersPerHour: 60,
                },
            ],
            counts,
            hours: 24,
            confidencePercent: 0,
            bufferPercent: 0,
            isBossMonster: () => false,
            spawnShape: () => null,
            ...extra,
        });

    /** How long the next point takes, with no clock in the way */
    const toNextPoint = (options) => planWith(options, { targetPoints: 1 });

    test('a solo T0 route is what the raw kill rate always produced, unchanged', () => {
        // The pre-fix input: deaths / hours, with no weighting of any kind
        const raw = planBestiaryRoute({
            zones: [
                {
                    zoneHrid: 'fly|T0',
                    name: 'fly',
                    creditsPerHour: { '/monsters/fly': 60 },
                    encountersPerHour: 60,
                },
            ],
            counts,
            hours: 24,
            confidencePercent: 0,
            bufferPercent: 0,
            isBossMonster: () => false,
            spawnShape: () => null,
        });
        expect(planWith({ difficultyTier: 0, partySize: 1 })).toEqual(raw);
    });

    test('the same fight at T2 reaches the point in a third of the time, and a third of the fights', () => {
        const t0 = toNextPoint({ difficultyTier: 0, partySize: 1 });
        const t2 = toNextPoint({ difficultyTier: 2, partySize: 1 });
        // 900 credits still wanted, but each kill pays three of them
        expect(t0.hoursUsed).toBeCloseTo(900 / 60, 9);
        expect(t2.hoursUsed).toBeCloseTo(900 / 180, 9);
        expect(t0.segments[0].encounters / t2.segments[0].encounters).toBeCloseTo(3, 6);
    });

    test('a party of three earns a third of the credit, so the route takes three times as long', () => {
        const solo = toNextPoint({ difficultyTier: 0, partySize: 1 });
        const party = toNextPoint({ difficultyTier: 0, partySize: 3 });
        expect(party.hoursUsed / solo.hoursUsed).toBeCloseTo(3, 9);
        // A party of three at T2 lands exactly back on the solo T0 pace
        expect(toNextPoint({ difficultyTier: 2, partySize: 3 }).hoursUsed).toBeCloseTo(solo.hoursUsed, 9);
    });

    test('a run that recorded no party size falls back to the setting, and never overrides one it did record', () => {
        const solo = toNextPoint({ difficultyTier: 0, partySize: 1 });
        // A recorded 3 wins over a configured fallback of 2
        const recorded = toNextPoint({ difficultyTier: 0, partySize: resolvePartySize(3, 2) });
        expect(recorded.hoursUsed / solo.hoursUsed).toBeCloseTo(3, 9);
        // Nothing recorded: the fallback of 2 is what answers
        const fallback = toNextPoint({ difficultyTier: 0, partySize: resolvePartySize(null, 2) });
        expect(fallback.hoursUsed / solo.hoursUsed).toBeCloseTo(2, 9);
    });
});
