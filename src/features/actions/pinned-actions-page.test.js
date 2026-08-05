/**
 * The pinned list once combat zones are in it.
 *
 * A pinned action's numbers are computed live; a combat zone's come from a
 * simulation that finished at some point, in gear that may since have changed.
 * These tests are about the row shape that lets the two sit in one sorted table
 * without the older one quietly passing for the fresher one.
 */

import { describe, test, expect, vi } from 'vitest';

// The snapshot readers live on the combat sim panel, which brings a floating
// panel and two inventory panels with it — none of which this file is about
vi.mock('../combat-sim/combat-sim-ui.js', () => ({
    default: {
        loadAllZonesSnapshot: async () => null,
        currentGearFingerprint: async () => null,
    },
}));

const { default: page, combatZoneRows, formatAge } = await import('./pinned-actions-page.js');

const SNAPSHOT = {
    version: 1,
    savedAt: 1700000000000,
    hours: 10,
    fingerprint: 'gear-a',
    zones: [
        {
            zoneHrid: '/actions/combat/fly',
            zoneName: 'Fly',
            difficultyTier: 0,
            profitPerHour: 5000,
            xpPerHour: 12000,
        },
        {
            zoneHrid: '/actions/combat/jungle',
            zoneName: 'Jungle',
            difficultyTier: 2,
            profitPerHour: null,
            xpPerHour: 30000,
        },
    ],
};

describe('combatZoneRows', () => {
    test('a zone reads like a pinned action, with its tier in the name and key', () => {
        const [fly, jungle] = combatZoneRows(SNAPSHOT, 'gear-a');

        expect(fly).toMatchObject({
            actionHrid: '/actions/combat/fly|T0',
            baseActionHrid: '/actions/combat/fly',
            name: 'Fly T0',
            skill: 'Combat',
            profitPerHour: 5000,
            expPerHour: 12000,
            source: 'combat-sim',
            simulatedAt: 1700000000000,
        });
        expect(jungle.actionHrid).toBe('/actions/combat/jungle|T2');
        expect(jungle.name).toBe('Jungle T2');
    });

    test('an unpriced zone carries null rather than a zero it did not measure', () => {
        expect(combatZoneRows(SNAPSHOT, 'gear-a')[1].profitPerHour).toBeNull();
    });

    test('gear matching the run is not flagged', () => {
        expect(combatZoneRows(SNAPSHOT, 'gear-a').every((row) => row.gearChanged === false)).toBe(true);
    });

    test('gear that has moved since flags every row from that run', () => {
        expect(combatZoneRows(SNAPSHOT, 'gear-b').every((row) => row.gearChanged === true)).toBe(true);
    });

    test('an unknown fingerprint on either side is not evidence of a change', () => {
        expect(combatZoneRows(SNAPSHOT, null)[0].gearChanged).toBe(false);
        expect(combatZoneRows({ ...SNAPSHOT, fingerprint: null }, 'gear-b')[0].gearChanged).toBe(false);
    });

    test('nothing stored is no rows rather than a throw', () => {
        expect(combatZoneRows(null, 'gear-a')).toEqual([]);
        expect(combatZoneRows({}, 'gear-a')).toEqual([]);
    });
});

describe('the merged table', () => {
    test('sorts simulated zones against live actions on the same column', () => {
        const milking = {
            actionHrid: '/actions/milking/cow',
            name: 'Milk Cow',
            skill: 'Milking',
            type: '/action_types/milking',
            level: 1,
            profitPerHour: 6000,
            expPerHour: 100,
        };

        page.allActions = [milking, ...combatZoneRows(SNAPSHOT, 'gear-a')];
        page.selectedSkills = [];
        page.sortColumn = 'profitPerHour';
        page.sortDirection = 'desc';

        const sorted = page.getFilteredSorted();

        expect(sorted.map((row) => row.name)).toEqual(['Milk Cow', 'Fly T0', 'Jungle T2']);
        // The unpriced zone sorts last either way rather than reading as free
        page.sortDirection = 'asc';
        expect(page.getFilteredSorted().at(-1).name).toBe('Jungle T2');

        page.allActions = [];
    });

    test('the skill filter can single out the simulated rows', () => {
        page.allActions = [
            { actionHrid: '/actions/milking/cow', name: 'Milk Cow', skill: 'Milking', profitPerHour: 1, expPerHour: 1 },
            ...combatZoneRows(SNAPSHOT, 'gear-a'),
        ];
        page.selectedSkills = ['Combat'];
        page.sortColumn = 'name';
        page.sortDirection = 'asc';

        expect(page.getFilteredSorted().map((row) => row.name)).toEqual(['Fly T0', 'Jungle T2']);

        page.selectedSkills = [];
        page.allActions = [];
    });
});

describe('formatAge', () => {
    const NOW = 1700000000000;

    test('says how stale a run is in terms worth acting on', () => {
        expect(formatAge(NOW - 5 * 60_000, NOW)).toBe('5m ago');
        expect(formatAge(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
        expect(formatAge(NOW - 5 * 24 * 3600_000, NOW)).toBe('5d ago');
    });

    test('no timestamp says nothing rather than 1970', () => {
        expect(formatAge(null, NOW)).toBe('');
    });
});
