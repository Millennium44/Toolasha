/**
 * The key ledger.
 *
 * The case this exists for is buying keys mid-run, which defeats the obvious
 * measurement — a count at the start against a count at the end. Every test
 * here is some version of "the number moved twice".
 */

import { describe, test, expect } from 'vitest';
import { newKeyLedger, noteItems, sample, keyFlow, entryKeyFor, TRACKED_KEYS } from './key-ledger.js';

const KEY = '/items/chimerical_entry_key';
const rows = (count, itemHrid = KEY) => [{ itemHrid, count, itemLocationHrid: '/item_locations/inventory', id: 'row' }];

describe('watching a key count change', () => {
    test('what they were already holding is not a purchase', () => {
        const ledger = noteItems(newKeyLedger(), rows(200));

        expect(keyFlow(ledger, KEY)).toEqual({ spent: 0, gained: 0 });
    });

    test('a fall is spending', () => {
        let ledger = noteItems(newKeyLedger(), rows(10));
        ledger = noteItems(ledger, rows(9));
        ledger = noteItems(ledger, rows(7));

        expect(keyFlow(ledger, KEY).spent).toBe(3);
    });

    test('buying mid-run does not read as a refund', () => {
        // The whole point. Start at 10, spend 3, buy 20: two samples say they
        // gained 17, and the truth is 3 spent and 20 gained.
        let ledger = noteItems(newKeyLedger(), rows(10));
        ledger = noteItems(ledger, rows(9));
        ledger = noteItems(ledger, rows(8));
        ledger = noteItems(ledger, rows(7));
        ledger = noteItems(ledger, rows(27));

        expect(keyFlow(ledger, KEY)).toEqual({ spent: 3, gained: 20 });
    });

    test('and spending after buying keeps counting', () => {
        let ledger = noteItems(newKeyLedger(), rows(5));
        ledger = noteItems(ledger, rows(25));
        ledger = noteItems(ledger, rows(24));

        expect(keyFlow(ledger, KEY)).toEqual({ spent: 1, gained: 20 });
    });

    test('keys somewhere other than the inventory are a different pile', () => {
        let ledger = noteItems(newKeyLedger(), rows(10));
        ledger = noteItems(ledger, [{ itemHrid: KEY, count: 1, itemLocationHrid: '/item_locations/market_listing' }]);

        expect(keyFlow(ledger, KEY).spent).toBe(0);
    });

    test('other items are not keys', () => {
        const ledger = newKeyLedger();
        noteItems(ledger, rows(10, '/items/coin'));
        noteItems(ledger, rows(1, '/items/coin'));

        expect(ledger.spent['/items/coin']).toBeUndefined();
    });

    test('nonsense rows are skipped rather than counted', () => {
        let ledger = noteItems(newKeyLedger(), rows(10));
        ledger = noteItems(ledger, rows(NaN));
        ledger = noteItems(ledger, null);

        expect(ledger.counts[KEY]).toBe(10);
    });

    test('chest keys are tracked as well as entry keys', () => {
        expect(TRACKED_KEYS.has('/items/enchanted_chest_key')).toBe(true);
        expect(entryKeyFor('/actions/combat/pirate_cove')).toBe('/items/pirate_entry_key');
        expect(entryKeyFor('/actions/combat/aqua_planet')).toBeNull();
    });
});

describe('somebody else, seen only twice a run', () => {
    test('the first sighting starts the count', () => {
        const ledger = sample(newKeyLedger(), 'Them', 50);

        expect(ledger.samples.Them).toMatchObject({ seen: 50, spent: 0, runs: 0 });
    });

    test('a fall between runs is what they spent', () => {
        let ledger = sample(newKeyLedger(), 'Them', 50);
        ledger = sample(ledger, 'Them', 47);
        ledger = sample(ledger, 'Them', 44);

        expect(ledger.samples.Them.spent).toBe(6);
        expect(ledger.samples.Them.runs).toBe(2);
    });

    test('a rise is marked unusable rather than counted as nothing spent', () => {
        // Counting it as zero would drag the average down every time somebody
        // restocked, which looks exactly like a party that got cheaper
        let ledger = sample(newKeyLedger(), 'Them', 50);
        ledger = sample(ledger, 'Them', 90);

        expect(ledger.samples.Them.unmeasurable).toBe(1);
        expect(ledger.samples.Them.runs).toBe(0);
        expect(ledger.samples.Them.spent).toBe(0);
    });

    test('and the runs either side of a restock still count', () => {
        let ledger = sample(newKeyLedger(), 'Them', 50);
        ledger = sample(ledger, 'Them', 47);
        ledger = sample(ledger, 'Them', 90);
        ledger = sample(ledger, 'Them', 87);

        expect(ledger.samples.Them.spent).toBe(6);
        expect(ledger.samples.Them.runs).toBe(2);
        expect(ledger.samples.Them.unmeasurable).toBe(1);
    });

    test('nobody and nonsense are ignored', () => {
        const ledger = sample(sample(newKeyLedger(), '', 5), 'Them', -1);

        expect(ledger.samples).toEqual({});
    });
});
