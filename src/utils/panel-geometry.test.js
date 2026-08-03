/** @vitest-environment happy-dom
 *
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

const { saveGeometry, saveOpenState, wasOpen, allGeometry, reopenIfLeftOpen, clearPosition, restoreGeometry } =
    await import('./panel-geometry.js');

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

describe('forgetting where a panel was but not how big', () => {
    test('the position goes and the size stays', () => {
        // The Treasure popup places itself beside the chest dialog and is only
        // pinned by being moved. Unpinning has to drop the position; dropping
        // the size with it would be a second change nobody asked for.
        return (async () => {
            await saveGeometry('popup', { left: 400, top: 90, width: 320, height: 500 });
            await clearPosition('popup');

            const all = await allGeometry();
            expect(all.popup).toEqual({ width: 320, height: 500 });
        })();
    });

    test('and the open flag survives it', async () => {
        await saveOpenState('popup', true);
        await saveGeometry('popup', { left: 10, top: 10 });
        await clearPosition('popup');

        await expect(wasOpen('popup')).resolves.toBe(true);
    });

    test('a panel with nothing stored is not a problem', () => {
        return expect(clearPosition('never-seen')).resolves.toBeUndefined();
    });
});

describe('reopening at start-up', () => {
    test('a panel left open is reopened', async () => {
        await saveOpenState('dps', true);

        const reopen = vi.fn();
        await reopenIfLeftOpen('dps', reopen);

        expect(reopen).toHaveBeenCalled();
    });

    test('a panel left closed is not', async () => {
        const reopen = vi.fn();
        await reopenIfLeftOpen('neverOpened', reopen);

        expect(reopen).not.toHaveBeenCalled();
    });

    test('a panel that throws on reopening does not take the others with it', async () => {
        // These are all fired off at module scope, one after another
        await saveOpenState('dps', true);

        await expect(
            reopenIfLeftOpen('dps', () => {
                throw new Error('no body yet');
            })
        ).resolves.toBeUndefined();
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

describe('putting a panel back', () => {
    const panel = () => {
        document.body.innerHTML = '<div id="panel"></div>';
        return document.getElementById('panel');
    };

    test('size and position both, normally', async () => {
        await saveGeometry('dps', { left: 120, top: 80, width: 400, height: 300 });
        const element = panel();

        await restoreGeometry(element, 'dps');

        expect(element.style.width).toBe('400px');
        expect(element.style.left).toBe('120px');
    });

    test('size only, for a panel that places itself', async () => {
        // The Treasure popup opens beside the chest dialog. Reapplying a
        // remembered position on every opening is what stopped it doing that —
        // and if the dialog was not found in time it simply stayed there.
        await saveGeometry('popup', { left: 900, top: 600, width: 320, height: 500 });
        const element = panel();

        await restoreGeometry(element, 'popup', undefined, { position: false });

        expect(element.style.width).toBe('320px');
        expect(element.style.left).toBe('');
    });
});
