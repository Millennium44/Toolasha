/**
 * How long the stock is supposed to last.
 *
 * One setting read by two things in two bundles — the panel that measures
 * shortfalls against it and the tile that colours against it. A stored value
 * that never comes back does not merely lose a preference: the panel shows a
 * day's shortfall when you asked for a week's, and looks right doing it.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {}, networth: {} }));
const character = vi.hoisted(() => ({ id: 'market123', mode: 'standard' }));

// Adoption is consent-gated now; these suites test the data plumbing,
// so the decision is treated as already made for the main character.
vi.mock('./adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => character.id,
        getCurrentCharacterGameMode: () => character.mode,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        getJSON: async (key, _name, fallback) => store.data[key] ?? fallback,
        setJSON: async (key, value) => {
            store.data[key] = value;
        },
        get: async (key, name = 'settings', fallback = null) =>
            (name === 'networthHistory' ? store.networth[key] : store.data[key]) ?? fallback,
        set: async (key, value) => {
            store.data[key] = value;
            return true;
        },
        delete: async (key) => {
            delete store.data[key];
            return true;
        },
        getAllKeys: async (name = 'settings') => Object.keys(name === 'networthHistory' ? store.networth : store.data),
    },
}));

const { TARGETS, currentTarget, cycleTarget, loadTarget } = await import('./consumable-target.js');
const { _resetAdoptionCache } = await import('./character-key.js');

/** Where this character's answer lives */
const KEY = 'consumablesSettings_market123';

/**
 * Put the in-memory selection back to the default between tests.
 *
 * By storing the default and reading it, rather than by clearing storage:
 * nothing stored means nothing to apply, so a bare clear would leave whatever
 * the previous test had chosen sitting in memory.
 */
const reset = async () => {
    character.id = 'market123';
    character.mode = 'standard';
    _resetAdoptionCache();
    store.networth = {};
    store.data = { [KEY]: { targetSeconds: 86400 } };
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

        expect(store.data[KEY]).toEqual({ targetSeconds: 3 * 86400 });
    });
});

describe('reading it back', () => {
    test('a stored target is what the panel opens on', async () => {
        store.data[KEY] = { targetSeconds: 7 * 86400 };
        await loadTarget();

        expect(currentTarget().label).toBe('1 week');
    });

    test('nothing stored leaves the default alone', async () => {
        await loadTarget();

        expect(currentTarget().label).toBe('1 day');
    });

    test('a target the list no longer offers does not blank it', async () => {
        // The list is code; a value stored by an older one must not win
        store.data[KEY] = { targetSeconds: 999 };
        await loadTarget();

        expect(currentTarget().label).toBe('1 day');
    });

    test('whatever drew against the default is told to draw again', async () => {
        store.data[KEY] = { targetSeconds: 8 * 3600 };
        const redraw = vi.fn();

        await loadTarget(redraw);

        expect(redraw).toHaveBeenCalledWith(expect.objectContaining({ label: '8 hours' }));
    });
});

describe('one answer per character', () => {
    test('a target saved before the split is claimed by the market character', async () => {
        store.data = { consumablesSettings: { targetSeconds: 7 * 86400 } };
        await loadTarget();

        expect(currentTarget().label).toBe('1 week');
        expect(store.data[KEY]).toEqual({ targetSeconds: 7 * 86400 });
        expect(store.data.consumablesSettings).toBeUndefined();
    });

    test('an iron cow starts from the default and leaves the old value alone', async () => {
        character.id = 'iron456';
        character.mode = 'ironcow';
        store.data = { consumablesSettings: { targetSeconds: 7 * 86400 } };
        await loadTarget();

        expect(currentTarget().label).toBe('1 day');
        expect(store.data.consumablesSettings).toEqual({ targetSeconds: 7 * 86400 });
        expect(store.data['consumablesSettings_iron456']).toBeUndefined();
    });

    test('each character keeps its own', async () => {
        store.data = { consumablesSettings_market123: { targetSeconds: 7 * 86400 } };
        await loadTarget();
        expect(currentTarget().label).toBe('1 week');

        character.id = 'iron456';
        character.mode = 'ironcow';
        await loadTarget();
        expect(currentTarget().label).toBe('1 day');

        cycleTarget();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.data['consumablesSettings_iron456']).toEqual({ targetSeconds: 3 * 86400 });
        expect(store.data.consumablesSettings_market123).toEqual({ targetSeconds: 7 * 86400 });
    });
});
