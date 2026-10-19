import { describe, test, expect } from 'vitest';
import { alchemyLevelRequirement } from './alchemy-level.js';

const alchemy = { type: '/action_types/alchemy' };
const map = { '/items/low': { itemLevel: 10 }, '/items/zero': {} };

describe('alchemyLevelRequirement', () => {
    test('reads the item level out of both hash formats, ignoring the enhancement level', () => {
        expect(
            alchemyLevelRequirement(alchemy, { primaryItemHash: '/item_locations/inventory::/items/low::7' }, map)
        ).toBe(10);
        expect(
            alchemyLevelRequirement(alchemy, { primaryItemHash: '1::/item_locations/inventory::/items/low::0' }, map)
        ).toBe(10);
    });

    test('falls back to the lookup when the map lacks the item', () => {
        const hash = { primaryItemHash: '/item_locations/inventory::/items/other::0' };
        expect(alchemyLevelRequirement(alchemy, hash, map, () => ({ itemLevel: 55 }))).toBe(55);
    });

    test('is undefined for non-alchemy actions, no item, or an item with no level', () => {
        const hash = { primaryItemHash: '/item_locations/inventory::/items/low::0' };
        expect(alchemyLevelRequirement({ type: '/action_types/milking' }, hash, map)).toBeUndefined();
        expect(alchemyLevelRequirement(alchemy, {}, map)).toBeUndefined();
        expect(alchemyLevelRequirement(alchemy, null, map)).toBeUndefined();
        expect(
            alchemyLevelRequirement(alchemy, { primaryItemHash: '/item_locations/inventory::/items/zero::0' }, map)
        ).toBeUndefined();
        expect(alchemyLevelRequirement(alchemy, { primaryItemHash: 'junk' }, map)).toBeUndefined();
    });
});
