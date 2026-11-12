import { describe, test, expect } from 'vitest';
import {
    FOLD_KEEP,
    clearsNoiseAsImprovement,
    foldGroupOf,
    isCheaperSwap,
    orderEntriesToShow,
    planFold,
} from './upgrade-fold.js';

const ALL_NOISY = { dps: false, xp: false, profit: false, encounters: false, deaths: false };

/** A drink swap row in slot `slot`; `sig` marks which deltas cleared their error bar */
const swap = (
    name,
    { slot = 0, current = '/items/ultra_melee_coffee', deltas = {}, sig = {}, gain = 0, extra = {} } = {}
) => ({
    candidate: { type: 'drink', description: `Ultra Melee Coffee → ${name}`, drinkIndex: slot, currentHrid: current },
    deltas: { dps: 0, xp: 0, profit: 0, deaths: 0, encounters: 0, ...deltas },
    significantBy: { ...ALL_NOISY, ...sig },
    economics: { profitGainPerHour: gain },
    ...extra,
});

describe('isCheaperSwap', () => {
    test('loses DPS beyond the noise, gains profit, improves nothing: a cheaper swap', () => {
        const row = swap('Defense Coffee', {
            deltas: { dps: -17, profit: 2 },
            sig: { dps: true, profit: true },
            gain: 80_000,
        });
        expect(isCheaperSwap(row)).toBe(true);
    });

    test('a swap that also lifts EXP beyond the noise is a real trade, not a cheaper swap', () => {
        const row = swap('Wisdom Coffee', {
            deltas: { dps: -17, xp: 5, profit: 0.4 },
            sig: { dps: true, xp: true },
            gain: 1000,
        });
        expect(isCheaperSwap(row)).toBe(false);
    });

    test('a DPS loss inside the noise is not a loss, so the profit gain stands', () => {
        const row = swap('Critical Coffee', {
            deltas: { dps: -0.2, profit: 1.9 },
            sig: { profit: true },
            gain: 74_000,
        });
        expect(isCheaperSwap(row)).toBe(false);
    });

    test('needs a profit gain: a swap that loses DPS and profit is just worse', () => {
        const row = swap('Ultra Magic Coffee', {
            deltas: { dps: -17, profit: -3 },
            sig: { dps: true, profit: true },
            gain: -131_000,
        });
        expect(isCheaperSwap(row)).toBe(false);
    });

    test('a drink whose replaced coffee had no price never reads as a saving', () => {
        const row = swap('Lucky Coffee', {
            deltas: { dps: -17, profit: 2 },
            sig: { dps: true },
            gain: 5000,
            extra: { costUnpricedBaseline: ['Ultra Melee Coffee'] },
        });
        expect(isCheaperSwap(row)).toBe(false);
    });

    test('an addition to a free slot, other row types and rows without a verdict are never cheaper swaps', () => {
        const base = swap('X', { deltas: { dps: -17, profit: 2 }, sig: { dps: true }, gain: 1 });
        const addition = { type: 'drink', description: 'Add X', fillsFreeDrinkSlot: true };
        expect(isCheaperSwap({ ...base, candidate: addition })).toBe(false);
        expect(isCheaperSwap({ ...base, candidate: { type: 'house', description: 'Room' } })).toBe(false);
        expect(isCheaperSwap({ ...base, significantBy: undefined })).toBe(false);
    });
});

describe('clearsNoiseAsImprovement', () => {
    test('a cheaper swap folds even when its profit clears the noise: only real improvements are exempt', () => {
        const cheaper = swap('A', { deltas: { dps: -17, profit: 2 }, sig: { dps: true, profit: true }, gain: 5 });
        expect(isCheaperSwap(cheaper)).toBe(true);
        expect(clearsNoiseAsImprovement(cheaper)).toBe(false);
        // and so does the same swap with its profit inside the noise
        const noisy = swap('A2', { deltas: { dps: -17, profit: 2 }, sig: { dps: true }, gain: 5 });
        expect(clearsNoiseAsImprovement(noisy)).toBe(false);
        expect(clearsNoiseAsImprovement(swap('B', { deltas: { dps: 1 }, sig: { dps: true } }))).toBe(true);
        expect(clearsNoiseAsImprovement(swap('C', { deltas: { xp: 5, dps: -17 }, sig: { xp: true, dps: true } }))).toBe(
            true
        );
        expect(clearsNoiseAsImprovement(swap('D', { deltas: { deaths: -50 }, sig: { deaths: true } }))).toBe(true);
        expect(clearsNoiseAsImprovement(swap('E', { deltas: { deaths: -50 }, sig: { deaths: false } }))).toBe(false);
        expect(clearsNoiseAsImprovement(swap('F', { deltas: { dps: -3 }, sig: { dps: true } }))).toBe(false);
    });

    test('a profit gain on a row that is not a cheaper swap counts', () => {
        const row = {
            candidate: { type: 'house' },
            deltas: { profit: 1 },
            significantBy: { ...ALL_NOISY, profit: true },
        };
        expect(clearsNoiseAsImprovement(row)).toBe(true);
    });
});

describe('rows without a verdict, and profit slivers', () => {
    test('a cheaper swap needs its profit gain to clear the noise before it is labeled', () => {
        const sliver = swap('Defense Coffee', { deltas: { dps: -17, profit: 0.2 }, sig: { dps: true }, gain: 900 });
        expect(isCheaperSwap(sliver)).toBe(false);
        const real = swap('Defense Coffee', {
            deltas: { dps: -17, profit: 2 },
            sig: { dps: true, profit: true },
            gain: 9e4,
        });
        expect(isCheaperSwap(real)).toBe(true);
    });

    test('a row from a run before verdicts existed is never folded', () => {
        const rows = Array.from({ length: 6 }, (_, i) => {
            const r = swap(`Old ${i}`, { deltas: { dps: -10 } });
            delete r.significantBy;
            return r;
        });
        expect(clearsNoiseAsImprovement(rows[0])).toBe(true);
        expect(planFold(rows).folded.size).toBe(0);
    });
});

describe('planFold', () => {
    const slotRows = (slot, n) =>
        Array.from({ length: n }, (_, i) => swap(`S${slot}-${i}`, { slot, deltas: { dps: -10 }, sig: { dps: true } }));

    test('keeps the first three of a slot in the table order and folds the rest', () => {
        const rows = slotRows(0, 8);
        const { folded, groups } = planFold(rows);
        expect(rows.filter((r) => !folded.has(r))).toEqual(rows.slice(0, FOLD_KEEP));
        expect([...groups.values()][0].folded).toHaveLength(5);
    });

    test('a replacement that clears the noise ranked 4th in its slot stays visible', () => {
        const rows = slotRows(0, 8);
        rows[3] = swap('Real gain', { deltas: { dps: 2 }, sig: { dps: true } });
        const { folded } = planFold(rows);
        expect(folded.has(rows[3])).toBe(false);
        expect(folded.has(rows[4])).toBe(true);
        expect(folded.has(rows[2])).toBe(false);
    });

    test('slots fold independently, and additions are their own group', () => {
        const add = (i) => ({
            candidate: { type: 'drink', description: `Add C${i}`, fillsFreeDrinkSlot: true, drinkIndex: 2 },
            deltas: { dps: -1 },
            significantBy: ALL_NOISY,
        });
        const rows = [...slotRows(0, 5), ...slotRows(1, 2), ...[0, 1, 2, 3, 4].map(add)];
        const { folded, groups } = planFold(rows);
        expect(groups.size).toBe(3);
        expect(rows.filter((r) => folded.has(r))).toHaveLength(4);
    });

    test('ties keep their incoming order rather than being reshuffled', () => {
        const rows = slotRows(0, 5);
        const { folded } = planFold(rows);
        expect(rows.map((r) => folded.has(r))).toEqual([false, false, false, true, true]);
    });

    test('pinned, excluded or verified rows are protected from folding', () => {
        const rows = slotRows(0, 8);
        const { folded } = planFold(rows, { isProtected: (r) => r === rows[6] });
        expect(folded.has(rows[6])).toBe(false);
        expect(folded.has(rows[5])).toBe(true);
    });

    test('rows that never fold: other types, and nothing when three or fewer share a slot', () => {
        const house = { candidate: { type: 'house', description: 'Room' }, deltas: {} };
        expect(foldGroupOf(house)).toBeNull();
        const { folded } = planFold([house, ...slotRows(0, 3)]);
        expect(folded.size).toBe(0);
    });
});

describe('orderEntriesToShow', () => {
    const entry = (name, gain, within) => ({ r: { name }, gain, within });

    test('shows only orders that clear the noise as an improvement', () => {
        const measured = [entry('a', 5, false), entry('b', 4, true), entry('c', 3, false), entry('d', -1, false)];
        expect([...orderEntriesToShow(measured)].map((e) => e.r.name)).toEqual(['a', 'c']);
    });

    test('when none clears the noise, the top three by the ranked metric', () => {
        const measured = [5, 4, 3, 2, 1].map((g) => entry(`o${g}`, g, true));
        expect([...orderEntriesToShow(measured)].map((e) => e.r.name)).toEqual(['o5', 'o4', 'o3']);
    });

    test('orders that only lose are not improvements: the top three show', () => {
        const measured = [entry('a', -2, false), entry('b', -3, false), entry('c', -4, false), entry('d', -5, false)];
        expect([...orderEntriesToShow(measured)].map((e) => e.r.name)).toEqual(['a', 'b', 'c']);
    });

    test('a confirmed order stays visible', () => {
        const measured = [entry('a', 5, false), entry('b', 0.1, true)];
        const shown = orderEntriesToShow(measured, { isConfirmed: (r) => r.name === 'b' });
        expect(shown.size).toBe(2);
    });

    test('nothing measured shows nothing', () => {
        expect(orderEntriesToShow([]).size).toBe(0);
    });
});
