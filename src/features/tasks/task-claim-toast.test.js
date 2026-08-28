/**
 * The claim toast's message building.
 *
 * `describeItems` and `formatClaimMessage` are tested directly rather than
 * through the class: the class is wiring (subscribe to the tracker, hand the
 * result to `showToast`), and the only thing worth getting wrong is what the
 * message says.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => {
            const names = {
                '/items/cheese': 'Cheese',
                '/items/milk': 'Milk',
            };
            return names[hrid] ? { name: names[hrid] } : null;
        },
    },
}));

import { describeItems, formatClaimMessage } from './task-claim-toast.js';

describe('describeItems', () => {
    test('no items is no text', () => {
        expect(describeItems([])).toBe('');
        expect(describeItems(undefined)).toBe('');
    });

    test('one item, resolved to its game name', () => {
        expect(describeItems([{ itemHrid: '/items/cheese', count: 1 }])).toBe('Cheese');
    });

    test('a count above one is prefixed', () => {
        expect(describeItems([{ itemHrid: '/items/cheese', count: 5 }])).toBe('5x Cheese');
    });

    test('an item with no game name falls back to its hrid', () => {
        expect(describeItems([{ itemHrid: '/items/unknown_widget', count: 1 }])).toBe('unknown widget');
    });

    test('up to three items are all listed', () => {
        const items = [
            { itemHrid: '/items/cheese', count: 1 },
            { itemHrid: '/items/milk', count: 2 },
            { itemHrid: '/items/unknown_widget', count: 1 },
        ];
        expect(describeItems(items)).toBe('Cheese, 2x Milk, unknown widget');
    });

    test('a fourth item collapses into a "+N more"', () => {
        const items = [
            { itemHrid: '/items/cheese', count: 1 },
            { itemHrid: '/items/milk', count: 1 },
            { itemHrid: '/items/unknown_a', count: 1 },
            { itemHrid: '/items/unknown_b', count: 1 },
        ];
        expect(describeItems(items)).toBe('Cheese, Milk, unknown a +1 more');
    });
});

describe('formatClaimMessage', () => {
    test('coins and tokens, no items', () => {
        const entry = { name: 'Milk the Cow', coins: 3787, tokens: 4, items: [] };
        expect(formatClaimMessage(entry)).toBe('Claimed: Milk the Cow — 3.8K coins, 4 tokens');
    });

    test('a single token is not pluralized', () => {
        const entry = { name: 'Cow', coins: 0, tokens: 1, items: [] };
        expect(formatClaimMessage(entry)).toBe('Claimed: Cow — 1 token');
    });

    test('items ride along with coins and tokens', () => {
        const entry = {
            name: 'Milk the Cow',
            coins: 1000,
            tokens: 2,
            items: [{ itemHrid: '/items/cheese', count: 3 }],
        };
        expect(formatClaimMessage(entry)).toBe('Claimed: Milk the Cow — 1.0K coins, 2 tokens, 3x Cheese');
    });

    test('a task that paid nothing at all still says so', () => {
        const entry = { name: 'Cow', coins: 0, tokens: 0, items: [] };
        expect(formatClaimMessage(entry)).toBe('Claimed: Cow — nothing');
    });

    test('a missing name falls back to "Task"', () => {
        const entry = { coins: 100, tokens: 0, items: [] };
        expect(formatClaimMessage(entry)).toBe('Claimed: Task — 100 coins');
    });
});
