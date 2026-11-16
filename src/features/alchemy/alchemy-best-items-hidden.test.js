import { describe, test, expect } from 'vitest';
import { mergeForKey } from '../../utils/sync-merge-registry.js';
import { mergeHiddenRecords, applyHiddenChange, EVENTS_FIELD } from './alchemy-best-items-hidden.js';

const A = '/items/holy_sword';
const B = '/items/cheese';
const C = '/items/milk';
const ev = (t, h) => ({ t, h });
const rec = (lists, events) => ({ ...lists, ...(events ? { [EVENTS_FIELD]: events } : {}) });
const sorted = (list) => [...list].sort();

describe('mergeHiddenRecords', () => {
    test('a hide of one item on each device keeps both', () => {
        const a = rec({ coinify: [A] }, { coinify: { [A]: ev(100, 1) } });
        const b = rec({ coinify: [B] }, { coinify: { [B]: ev(200, 1) } });
        expect(sorted(mergeHiddenRecords(a, b).coinify)).toEqual(sorted([A, B]));
        expect(sorted(mergeHiddenRecords(b, a).coinify)).toEqual(sorted([A, B]));
    });

    test('an unhide newer than the other device hide wins, in either direction', () => {
        const hideOnB = rec({ coinify: [A] }, { coinify: { [A]: ev(100, 1) } });
        const unhideOnA = rec({ coinify: [] }, { coinify: { [A]: ev(200, 0) } });
        for (const [x, y] of [
            [unhideOnA, hideOnB],
            [hideOnB, unhideOnA],
        ]) {
            const merged = mergeHiddenRecords(x, y);
            expect(merged.coinify).toEqual([]);
            expect(merged[EVENTS_FIELD].coinify[A]).toEqual(ev(200, 0));
        }
    });

    test('a hide newer than the other device unhide wins, in either direction', () => {
        const unhideOnA = rec({ coinify: [] }, { coinify: { [A]: ev(100, 0) } });
        const hideOnB = rec({ coinify: [A] }, { coinify: { [A]: ev(200, 1) } });
        expect(mergeHiddenRecords(unhideOnA, hideOnB).coinify).toEqual([A]);
        expect(mergeHiddenRecords(hideOnB, unhideOnA).coinify).toEqual([A]);
    });

    test('a tie keeps the item hidden', () => {
        const unhide = rec({ coinify: [] }, { coinify: { [A]: ev(100, 0) } });
        const hide = rec({ coinify: [A] }, { coinify: { [A]: ev(100, 1) } });
        expect(mergeHiddenRecords(unhide, hide).coinify).toEqual([A]);
        expect(mergeHiddenRecords(hide, unhide).coinify).toEqual([A]);
    });

    test('an old-shape list on one side is read without loss, on either side', () => {
        const oldShape = { coinify: [A, B], decompose: [C] };
        const newShape = rec({ coinify: [C] }, { coinify: { [C]: ev(500, 1) } });
        for (const merged of [mergeHiddenRecords(oldShape, newShape), mergeHiddenRecords(newShape, oldShape)]) {
            expect(sorted(merged.coinify)).toEqual(sorted([A, B, C]));
            expect(merged.decompose).toEqual([C]);
        }
    });

    test('a recorded unhide beats an old-shape list that still holds the item', () => {
        const oldShape = { coinify: [A, B] };
        const newShape = rec({ coinify: [] }, { coinify: { [A]: ev(500, 0) } });
        expect(mergeHiddenRecords(oldShape, newShape).coinify).toEqual([B]);
        expect(mergeHiddenRecords(newShape, oldShape).coinify).toEqual([B]);
    });

    test('two old-shape lists union, and the result stays readable by an old build', () => {
        const merged = mergeHiddenRecords({ coinify: [A] }, { coinify: [B], transmute: [C] });
        expect(sorted(merged.coinify)).toEqual(sorted([A, B]));
        expect(merged.transmute).toEqual([C]);
        // No events were recorded by anyone, so none are invented
        expect(EVENTS_FIELD in merged).toBe(false);
    });

    test('duplicates in a list collapse and never survive a fold', () => {
        const merged = mergeHiddenRecords({ coinify: [A, A, B] }, { coinify: [B, B, A] });
        expect(sorted(merged.coinify)).toEqual(sorted([A, B]));
    });

    test('an empty list is not an unhide: a side with nothing says nothing', () => {
        const withHides = rec({ coinify: [A, B] }, { coinify: { [A]: ev(100, 1) } });
        expect(sorted(mergeHiddenRecords(withHides, { coinify: [] }).coinify)).toEqual(sorted([A, B]));
        expect(sorted(mergeHiddenRecords({}, withHides).coinify)).toEqual(sorted([A, B]));
        expect(sorted(mergeHiddenRecords(withHides, {}).coinify)).toEqual(sorted([A, B]));
    });

    test('a missing or unreadable side never hides or unhides anything', () => {
        const withHides = rec({ coinify: [A] }, { coinify: { [A]: ev(100, 1) } });
        for (const bad of [undefined, null, 'x', 5, ['a']]) {
            expect(mergeHiddenRecords(withHides, bad)).toBe(withHides);
            expect(mergeHiddenRecords(bad, withHides)).toBe(withHides);
        }
        expect(mergeHiddenRecords(undefined, undefined)).toBeUndefined();
    });

    test('malformed events and lists are ignored rather than thrown on', () => {
        const junk = {
            coinify: [A, 7, null, { x: 1 }],
            [EVENTS_FIELD]: { coinify: { [A]: ev(-5, 0), [B]: 'x' }, x: 3 },
        };
        const merged = mergeHiddenRecords(junk, { coinify: [C] });
        expect(sorted(merged.coinify)).toEqual(sorted([A, C]));
        expect(mergeHiddenRecords({ coinify: [A], [EVENTS_FIELD]: 'oops' }, { coinify: [B] }).coinify.length).toBe(2);
    });

    test('lists for types this build does not know, and their events, survive', () => {
        const a = rec({ future: [A], coinify: [] }, { future: { [A]: ev(100, 1) } });
        const merged = mergeHiddenRecords(a, rec({ future: [] }, { future: { [B]: ev(150, 0) } }));
        expect(merged.future).toEqual([A]);
        expect(merged[EVENTS_FIELD].future[B]).toEqual(ev(150, 0));
        expect(merged.coinify).toEqual([]);
    });

    test('types stay independent: the same item hidden in one tab and unhidden in another', () => {
        const a = rec(
            { coinify: [A], decompose: [] },
            { coinify: { [A]: ev(100, 1) }, decompose: { [A]: ev(300, 0) } }
        );
        const b = rec(
            { coinify: [], decompose: [A] },
            { coinify: { [A]: ev(200, 0) }, decompose: { [A]: ev(250, 1) } }
        );
        const merged = mergeHiddenRecords(a, b);
        expect(merged.coinify).toEqual([]);
        expect(merged.decompose).toEqual([]);
    });

    test('the fold is the same whichever copy is local (convergence)', () => {
        const a = rec({ coinify: [A, C] }, { coinify: { [A]: ev(100, 1), [B]: ev(300, 0) } });
        const b = rec({ coinify: [B] }, { coinify: { [B]: ev(200, 1), [C]: ev(400, 0) } });
        const ab = mergeHiddenRecords(a, b);
        const ba = mergeHiddenRecords(b, a);
        expect(sorted(ab.coinify)).toEqual(sorted(ba.coinify));
        expect(ab[EVENTS_FIELD]).toEqual(ba[EVENTS_FIELD]);
        expect(sorted(ab.coinify)).toEqual([A]);
        // Folding again changes nothing
        expect(mergeHiddenRecords(ab, a)).toEqual(ab);
    });

    test('is registered for every per-character key of the record, and only the record', () => {
        expect(
            sorted(
                mergeForKey('settings', 'alchemyBestItems_hidden_123').merge({ coinify: [A] }, { coinify: [B] }).coinify
            )
        ).toEqual(sorted([A, B]));
        expect(mergeForKey('settings', 'alchemyBestItems_lastType_123')).toBeFalsy();
    });
});

describe('applyHiddenChange', () => {
    test('hides into an old-shape record, keeping its other lists', () => {
        const next = applyHiddenChange({ coinify: [B], unrefine: [C] }, 'coinify', A, true, 1000);
        expect(next.coinify).toEqual([B, A]);
        expect(next.unrefine).toEqual([C]);
        expect(next[EVENTS_FIELD].coinify[A]).toEqual(ev(1000, 1));
    });

    test('an unhide leaves a tombstone and does not touch other items events', () => {
        const stored = rec({ coinify: [A, B] }, { coinify: { [B]: ev(50, 1) } });
        const next = applyHiddenChange(stored, 'coinify', A, false, 1000);
        expect(next.coinify).toEqual([B]);
        expect(next[EVENTS_FIELD].coinify).toEqual({ [A]: ev(1000, 0), [B]: ev(50, 1) });
        // The stored object is not mutated
        expect(stored.coinify).toEqual([A, B]);
    });

    test('a clock behind an event already stored still moves past it', () => {
        const stored = rec({ coinify: [] }, { coinify: { [A]: ev(5000, 0) } });
        const next = applyHiddenChange(stored, 'coinify', A, true, 1000);
        expect(next[EVENTS_FIELD].coinify[A]).toEqual(ev(5001, 1));
    });

    test('a missing or corrupt stored record starts from empty', () => {
        for (const stored of [undefined, null, 'x', ['a']]) {
            expect(applyHiddenChange(stored, 'coinify', A, true, 10).coinify).toEqual([A]);
        }
    });

    test('a hide on one device and an older unhide on the other merge to hidden, via the real fold', () => {
        const deviceA = applyHiddenChange(applyHiddenChange({}, 'coinify', A, true, 100), 'coinify', A, false, 200);
        const deviceB = applyHiddenChange({ coinify: [A] }, 'coinify', A, true, 300);
        expect(mergeHiddenRecords(deviceA, deviceB).coinify).toEqual([A]);
    });
});
