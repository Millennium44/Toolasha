/**
 * A day's item flow row is rewritten all day, so two devices each hold their
 * own copy of it. A sync pull folds two copies of a chunk by union, and the
 * union — deep equality, the chunked store's default identity — keeps both
 * versions of the one row. Every reader then summed them.
 *
 * Driven through the real chunked store's registered sync merge, so what is
 * pinned is what a pull actually writes, and that the recorder reads it back
 * as one row.
 */

import { describe, test, expect, vi } from 'vitest';
import { mergeForKey } from '../../utils/sync-merge-registry.js';
import { gatheringByDay } from './gold-sources.js';
import { mergeDayRows, mergeDayRow } from './item-flow-recorder.js';

vi.mock('../../core/storage.js', () => ({
    default: {
        isQuotaExceeded: () => false,
        get: async () => null,
        set: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));

vi.mock('../../core/data-manager.js', () => ({
    default: { on: () => {}, off: () => {}, getCurrentCharacterId: () => 'me' },
}));

const DAY = '2026-09-27';
const RUN = '24022273';
const COW = '/actions/milking/cow';
const t0 = Date.parse('2026-09-27T10:00:00');
const min = 60 * 1000;

/** The row as device A last pushed it: one watched stretch, 100 milk */
const deviceA = {
    d: DAY,
    gathering: { [RUN]: { a: COW, stretches: [{ from: t0, to: t0 + 30 * min, gained: { '/items/milk': 100 } }] } },
    drinks: { '/items/milking_tea': 3 },
};

/** Device B pulled that, kept milking the same run, and extended the same stretch */
const deviceB = {
    d: DAY,
    gathering: { [RUN]: { a: COW, stretches: [{ from: t0, to: t0 + 50 * min, gained: { '/items/milk': 170 } }] } },
    drinks: { '/items/milking_tea': 5 },
};

describe('two devices’ copies of one day', () => {
    test('a sync pull keeps both versions of the row side by side', () => {
        const registration = mergeForKey('networthHistory', `itemFlowRec_me_${DAY}`);
        expect(registration).toBeTruthy();

        const pulled = registration.merge([deviceA], [deviceB]);
        expect(pulled.filter((row) => row.d === DAY)).toHaveLength(2);

        // Read as stored, the pulled copy's milk is counted twice
        const price = () => 10;
        const unfolded = gatheringByDay({ liveDays: pulled, price }).byDay.get(DAY);
        expect(unfolded).toBe((100 + 170) * 10);

        // Folded on load, it is the one run it was
        const { rows, folded } = mergeDayRows(pulled);
        expect(rows).toHaveLength(1);
        expect(folded).toEqual([DAY]);
        expect(gatheringByDay({ liveDays: rows, price }).byDay.get(DAY)).toBe(170 * 10);
        expect(rows[0].drinks).toEqual({ '/items/milking_tea': 5 });
    });
});

describe('mergeDayRow', () => {
    test('different stretches of a run, and different runs, are all kept', () => {
        const other = {
            d: DAY,
            gathering: {
                [RUN]: {
                    a: COW,
                    stretches: [{ from: t0 + 120 * min, to: t0 + 150 * min, gained: { '/items/milk': 90 } }],
                },
                99: { a: '/actions/foraging/farmland', stretches: [{ from: t0, to: t0, gained: { '/items/egg': 2 } }] },
            },
            keys: { '/items/chimerical_entry_key': 1 },
        };
        const merged = mergeDayRow(deviceA, other);

        expect(merged.gathering[RUN].stretches.map((stretch) => stretch.from)).toEqual([t0, t0 + 120 * min]);
        expect(merged.gathering[99].stretches).toHaveLength(1);
        expect(merged.keys).toEqual({ '/items/chimerical_entry_key': 1 });
        expect(merged.drinks).toEqual({ '/items/milking_tea': 3 });
    });

    test('combat consumable stretches merge by start and run', () => {
        const a = { d: DAY, combatConsumables: { stretches: [{ from: t0, to: t0 + min, r: 'x', used: { f: 1 } }] } };
        const b = {
            d: DAY,
            combatConsumables: {
                stretches: [
                    { from: t0, to: t0 + 5 * min, r: 'x', used: { f: 4 } },
                    { from: t0 + 60 * min, to: t0 + 61 * min, r: 'y', used: { f: 1 } },
                ],
            },
        };
        const merged = mergeDayRow(a, b);
        expect(merged.combatConsumables.stretches).toEqual(b.combatConsumables.stretches);
    });

    test('rows with no duplicates pass through untouched', () => {
        const rows = [deviceA, { ...deviceB, d: '2026-09-28' }];
        const { rows: out, folded } = mergeDayRows(rows);
        expect(out[0]).toBe(rows[0]);
        expect(out[1]).toBe(rows[1]);
        expect(folded).toEqual([]);
    });
});
