import { describe, test, expect } from 'vitest';
import { planBestiaryRoute, formatPlanHours, formatPlanText } from './bestiary-plan.js';
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
