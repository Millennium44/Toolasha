/**
 * Reading the game's `::`-joined item hashes.
 *
 * The cases are the ones the two callers each defended against separately
 * before this was one function: the long form with a leading item id, the short
 * form without it, a bare hrid, and the malformed input that used to throw in
 * one copy and return nulls in the other.
 */

import { describe, test, expect } from 'vitest';
import { parseItemHash } from './item-hash.js';

const TOP = '/items/enhancers_top';

describe('parseItemHash', () => {
    test('reads the item and its level out of the long form', () => {
        expect(parseItemHash(`161296::/item_locations/inventory::${TOP}::5`)).toEqual({ itemHrid: TOP, level: 5 });
    });

    test('reads the short form, which has no leading item id', () => {
        expect(parseItemHash(`/item_locations/inventory::${TOP}::0`)).toEqual({ itemHrid: TOP, level: 0 });
    });

    test('a bare hrid is level zero of that item', () => {
        expect(parseItemHash(TOP)).toEqual({ itemHrid: TOP, level: 0 });
    });

    test('a hash with no level segment is level zero', () => {
        expect(parseItemHash(`/item_locations/inventory::${TOP}`)).toEqual({ itemHrid: TOP, level: 0 });
    });

    test('a hash naming no item yields no item, rather than level zero of nothing', () => {
        expect(parseItemHash('161296::/item_locations/inventory::3').itemHrid).toBeNull();
        expect(parseItemHash('').itemHrid).toBeNull();
    });

    test('anything that is not a string is not a hash', () => {
        // The copy that split first threw here; the copy that type-checked did
        // not, and the union of the two guards is what callers now get
        for (const input of [undefined, null, 0, 12345, {}, ['/items/coin']]) {
            expect(parseItemHash(input)).toEqual({ itemHrid: null, level: 0 });
        }
    });

    test('a trailing hrid is not read as a level', () => {
        expect(parseItemHash(`${TOP}::/item_locations/inventory`)).toEqual({ itemHrid: TOP, level: 0 });
    });
});
