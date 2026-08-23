import { describe, test, expect } from 'vitest';
import { planBestiaryRoute, rescaleDungeonRates, formatPlanHours, formatPlanText } from './bestiary-plan.js';
import { pointsFromCount } from './bestiary.js';

const zone = (zoneHrid, killsPerHour, name = zoneHrid) => ({ zoneHrid, name, killsPerHour });

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
            { zoneHrid: 'a', name: 'a', killsPerHour: { fly: 10 }, encountersPerHour: 120 },
            { zoneHrid: 'b', name: 'b', killsPerHour: { bee: 10 } },
        ];
        const plan = planBestiaryRoute({ zones, counts: { fly: 0, bee: 0 }, hours: 1 });
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
        const scaled = rescaleDungeonRates({ killsPerHour: sim, simClearsPerHour: 6, runs, tier: 1 });
        expect(scaled.source).toBe('measured');
        expect(scaled.runs).toBe(2);
        expect(scaled.clearSeconds).toBe(1200);
        expect(scaled.clearsPerHour).toBeCloseTo(3, 9);
        expect(scaled.killsPerHour['/monsters/goblin']).toBeCloseTo(30, 9);
        expect(scaled.killsPerHour['/monsters/king']).toBeCloseTo(3, 9);
    });

    test('a tier with no runs falls back to the dungeon median, and says so', () => {
        const runs = [
            { tier: 0, duration: 1_200_000 },
            { tier: 0, totalTime: 1_200_000 },
        ];
        const scaled = rescaleDungeonRates({ killsPerHour: sim, simClearsPerHour: 6, runs, tier: 2 });
        expect(scaled.source).toBe('measured-all-tiers');
        expect(scaled.runs).toBe(2);
        expect(scaled.clearsPerHour).toBeCloseTo(3, 9);
    });

    test('with no runs at all the sim clear time stands, unchanged', () => {
        const scaled = rescaleDungeonRates({ killsPerHour: sim, simClearsPerHour: 6, runs: [], tier: 1 });
        expect(scaled.source).toBe('sim');
        expect(scaled.runs).toBe(0);
        expect(scaled.clearSeconds).toBeCloseTo(600, 9);
        expect(scaled.killsPerHour['/monsters/goblin']).toBeCloseTo(60, 9);
        expect(scaled.killsPerHour['/monsters/king']).toBeCloseTo(6, 9);
    });

    test('a dungeon the sim never cleared, or one that killed nothing, has no rate to rescale', () => {
        expect(rescaleDungeonRates({ killsPerHour: sim, simClearsPerHour: 0, runs: [] })).toBeNull();
        expect(rescaleDungeonRates({ killsPerHour: {}, simClearsPerHour: 6, runs: [] })).toBeNull();
        expect(rescaleDungeonRates()).toBeNull();
    });

    test('runs without a usable duration are ignored rather than counted as instant', () => {
        const runs = [{ tier: 1, duration: 0 }, { tier: 1 }, { tier: 1, duration: 1_800_000 }];
        const scaled = rescaleDungeonRates({ killsPerHour: sim, simClearsPerHour: 6, runs, tier: 1 });
        expect(scaled.runs).toBe(1);
        expect(scaled.clearsPerHour).toBeCloseTo(2, 9);
    });

    test('a dungeon segment is quoted in clears, not fights', () => {
        const plan = planBestiaryRoute({
            zones: [
                {
                    zoneHrid: 'd|T1',
                    name: '[D] Den T1',
                    killsPerHour: { '/monsters/goblin': 30 },
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
