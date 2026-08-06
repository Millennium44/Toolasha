/**
 * The dungeon entry-key forecast: which key, how many are held, how fast they go.
 *
 * All arithmetic and lookups, so it runs in node. The panel that draws the row
 * is exercised in `features/ui/consumables-panel.test.js`.
 */

import { describe, test, expect } from 'vitest';
import { dungeonEntryKey, heldInInventory, keyConsumableEntry } from './dungeon-key-forecast.js';
import { forecast } from './consumable-forecast.js';

const DEN = '/actions/combat/chimerical_den';
const KEY = '/items/chimerical_entry_key';

describe('dungeonEntryKey', () => {
    test('reads the key the game data names', () => {
        const detail = { combatZoneInfo: { isDungeon: true, dungeonInfo: { keyItemHrid: '/items/custom_key' } } };
        expect(dungeonEntryKey(DEN, detail)).toBe('/items/custom_key');
    });

    test('falls back to the known dungeon table when the data names none', () => {
        const detail = { combatZoneInfo: { isDungeon: true, dungeonInfo: { maxWaves: 50 } } };
        expect(dungeonEntryKey(DEN, detail)).toBe(KEY);
    });

    test('a malformed hrid in the data is not trusted', () => {
        const detail = { combatZoneInfo: { isDungeon: true, dungeonInfo: { keyItemHrid: 'chimerical key' } } };
        expect(dungeonEntryKey(DEN, detail)).toBe(KEY);
    });

    test('a zone is not a dungeon, whatever else it carries', () => {
        const detail = { combatZoneInfo: { isDungeon: false, dungeonInfo: { keyItemHrid: KEY } } };
        expect(dungeonEntryKey('/actions/combat/aqua_planet', detail)).toBeNull();
    });

    test('missing detail, missing action: no key, no throw', () => {
        expect(dungeonEntryKey(DEN, null)).toBeNull();
        expect(dungeonEntryKey(DEN, {})).toBeNull();
        expect(dungeonEntryKey(null, { combatZoneInfo: { isDungeon: true } })).toBeNull();
    });

    test('an unknown dungeon with no field in the data has no answer', () => {
        const detail = { combatZoneInfo: { isDungeon: true, dungeonInfo: {} } };
        expect(dungeonEntryKey('/actions/combat/brand_new_dungeon', detail)).toBeNull();
    });
});

describe('heldInInventory', () => {
    test('counts only the inventory pile', () => {
        const items = [
            { itemHrid: KEY, count: 40, itemLocationHrid: '/item_locations/inventory' },
            // Listed on the market: cannot be spent on the next run
            { itemHrid: KEY, count: 10, itemLocationHrid: '/item_locations/market_listing' },
            { itemHrid: '/items/coin', count: 999, itemLocationHrid: '/item_locations/inventory' },
        ];
        expect(heldInInventory(items, KEY)).toBe(40);
    });

    test('a row with no location is assumed to be inventory', () => {
        expect(heldInInventory([{ itemHrid: KEY, count: 7 }], KEY)).toBe(7);
    });

    test('no inventory at all is zero, not a throw', () => {
        expect(heldInInventory(null, KEY)).toBe(0);
        expect(heldInInventory([], KEY)).toBe(0);
        expect(heldInInventory([{ itemHrid: KEY, count: 'soon' }], KEY)).toBe(0);
    });
});

describe('keyConsumableEntry', () => {
    test('the rate is the session measurement: chests over duration', () => {
        const entry = keyConsumableEntry({
            itemHrid: KEY,
            itemName: 'Chimerical Entry Key',
            held: 40,
            keyBreakdown: [{ itemHrid: KEY, itemName: 'Chimerical Entry Key', count: 4, pricePerItem: 90000 }],
            durationSeconds: 3600,
        });

        expect(entry.consumptionRate).toBeCloseTo(4 / 3600);
        expect(entry.consumedPerDay).toBe(96);
        expect(entry.pricePerItem).toBe(90000);
    });

    test('no chests yet means no rate, honestly, with the held count intact', () => {
        const entry = keyConsumableEntry({
            itemHrid: KEY,
            held: 40,
            keyBreakdown: [],
            durationSeconds: 3600,
            fallbackPrice: 85000,
        });

        expect(entry.consumptionRate).toBe(0);
        expect(entry.consumedPerDay).toBe(0);
        expect(entry.inventoryAmount).toBe(40);
        // The market stands in only when no run has priced the key
        expect(entry.pricePerItem).toBe(85000);
    });

    test('the breakdown price beats the market fallback', () => {
        const entry = keyConsumableEntry({
            itemHrid: KEY,
            held: 1,
            keyBreakdown: [{ itemHrid: KEY, count: 2, pricePerItem: 70000 }],
            durationSeconds: 1800,
            fallbackPrice: 90000,
        });
        expect(entry.pricePerItem).toBe(70000);
    });

    test('a chest-key row for the same dungeon is not the entry key', () => {
        const entry = keyConsumableEntry({
            itemHrid: KEY,
            held: 5,
            keyBreakdown: [{ itemHrid: '/items/chimerical_chest_key', count: 4, pricePerItem: 12000 }],
            durationSeconds: 3600,
        });
        expect(entry.consumptionRate).toBe(0);
    });

    test('feeds the forecast arithmetic like any other consumable', () => {
        const seed = keyConsumableEntry({
            itemHrid: KEY,
            itemName: 'Chimerical Entry Key',
            held: 48,
            keyBreakdown: [{ itemHrid: KEY, count: 4, pricePerItem: 90000 }],
            durationSeconds: 3600,
        });
        const result = forecast(seed);

        // 48 keys at 4 an hour is 12 hours, which is a finite countdown the
        // panel's limiting-consumable highlight can compare against the drinks
        expect(result.secondsLeft).toBeCloseTo(12 * 3600);
        expect(result.perDay).toBe(96);
        expect(result.costPerDay).toBeCloseTo(96 * 90000);
    });
});
