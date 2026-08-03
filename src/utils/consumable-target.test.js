/**
 * How long the stock is supposed to last.
 *
 * One setting read by two things in two bundles — the panel that measures
 * shortfalls against it and the tile that colours against it. A stored value
 * that never comes back does not merely lose a preference: the panel shows a
 * day's shortfall when you asked for a week's, and looks right doing it.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {} }));

vi.mock('../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        getJSON: async (key, _name, fallback) => store.data[key] ?? fallback,
        setJSON: async (key, value) => {
            store.data[key] = value;
        },
    },
}));

const { TARGETS, currentTarget, cycleTarget, loadTarget } = await import('./consumable-target.js');

/**
 * Put the in-memory selection back to the default between tests.
 *
 * By storing the default and reading it, rather than by clearing storage:
 * nothing stored means nothing to apply, so a bare clear would leave whatever
 * the previous test had chosen sitting in memory.
 */
const reset = async () => {
    store.data = { consumablesSettings: { targetSeconds: 86400 } };
    await loadTarget();
    store.data = {};
};

beforeEach(reset);

describe('picking a target', () => {
    test('the default is a day', () => {
        expect(currentTarget().label).toBe('1 day');
    });

    test('cycling walks the list and wraps', () => {
        const seen = TARGETS.map(() => cycleTarget().label);
        expect(seen).toEqual(['3 days', '1 week', '8 hours', '1 day']);
    });

    test('and is written down as it goes', async () => {
        cycleTarget();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(store.data.consumablesSettings).toEqual({ targetSeconds: 3 * 86400 });
    });
});

describe('reading it back', () => {
    test('a stored target is what the panel opens on', async () => {
        store.data.consumablesSettings = { targetSeconds: 7 * 86400 };
        await loadTarget();

        expect(currentTarget().label).toBe('1 week');
    });

    test('nothing stored leaves the default alone', async () => {
        await loadTarget();

        expect(currentTarget().label).toBe('1 day');
    });

    test('a target the list no longer offers does not blank it', async () => {
        // The list is code; a value stored by an older one must not win
        store.data.consumablesSettings = { targetSeconds: 999 };
        await loadTarget();

        expect(currentTarget().label).toBe('1 day');
    });

    test('whatever drew against the default is told to draw again', async () => {
        store.data.consumablesSettings = { targetSeconds: 8 * 3600 };
        const redraw = vi.fn();

        await loadTarget(redraw);

        expect(redraw).toHaveBeenCalledWith(expect.objectContaining({ label: '8 hours' }));
    });
});
