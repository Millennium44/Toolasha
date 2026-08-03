/**
 * Remembering where a panel was, and whether it was anywhere.
 *
 * The open flag lives in the same record as the geometry, which is the whole
 * reason these are tested together: writing one must not lose the other. A panel
 * that reopened at the top-left corner every time would be worse than one that
 * did not reopen at all.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {} }));

vi.mock('../core/storage.js', () => ({
    default: {
        getJSON: async (_key, _name, fallback) => store.data.panelGeometry ?? fallback,
        setJSON: async (_key, value) => {
            store.data.panelGeometry = value;
        },
    },
}));

const { saveGeometry, saveOpenState, wasOpen, allGeometry } = await import('./panel-geometry.js');

beforeEach(() => {
    store.data = {};
});

describe('whether a panel was open', () => {
    test('nothing stored means it was not', () => {
        return expect(wasOpen('dps')).resolves.toBe(false);
    });

    test('a round trip in both directions', async () => {
        await saveOpenState('dps', true);
        await expect(wasOpen('dps')).resolves.toBe(true);

        await saveOpenState('dps', false);
        await expect(wasOpen('dps')).resolves.toBe(false);
    });

    test('panels do not read each other’s state', async () => {
        await saveOpenState('dps', true);

        await expect(wasOpen('partyLoot')).resolves.toBe(false);
    });
});

describe('the two halves of one record', () => {
    test('saving the open flag keeps the geometry', async () => {
        // They share a record, so a careless write would drop the other half and
        // the panel would reopen in the corner
        await saveGeometry('dps', { left: 120, top: 80, width: 400, height: 300 });
        await saveOpenState('dps', true);

        const all = await allGeometry();
        expect(all.dps).toMatchObject({ left: 120, top: 80, width: 400, height: 300, open: true });
    });

    test('and saving the geometry keeps the open flag', async () => {
        await saveOpenState('dps', true);
        await saveGeometry('dps', { left: 10, top: 10 });

        await expect(wasOpen('dps')).resolves.toBe(true);
    });
});
