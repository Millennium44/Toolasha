/**
 * @vitest-environment happy-dom
 *
 * A forced reprice (value source change, the game's value refresh) rewrites every tile's value.
 * The native category pass skips a `toolasha-ct-active` inventory, so the custom-tab layout — the
 * section totals and the value-sorted tile order — has to redo itself when the badge manager says
 * it has repriced, and stop listening when the feature is torn down.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const repriced = vi.hoisted(() => ({ listeners: new Set() }));

const storageMock = vi.hoisted(() => ({
    get: vi.fn(async (_key, _store, fallback = null) => fallback),
    tryGet: vi.fn(async () => ({ found: false, value: null })),
    set: vi.fn(async () => true),
    delete: vi.fn(async () => true),
    getAllKeys: vi.fn(async () => []),
}));

const dm = vi.hoisted(() => ({
    getCurrentCharacterId: () => 'char',
    getCurrentCharacterGameMode: () => 'standard',
    getInitClientData: () => ({}),
    characterItems: [],
    on: () => {},
    off: () => {},
}));

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({ default: dm }));
vi.mock('../../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));
vi.mock('../inventory-sort.js', () => ({ default: { onModeChange: () => () => {} } }));
vi.mock('../inventory-badge-manager.js', () => ({
    default: {
        currentInventoryElem: null,
        renderAllBadges: vi.fn(async () => {}),
        onRepriced: (fn) => {
            repriced.listeners.add(fn);
            return () => repriced.listeners.delete(fn);
        },
    },
}));
vi.mock('../../combat/loadout-snapshot.js', () => ({
    default: { snapshots: {}, onUpdate: vi.fn(), offUpdate: vi.fn(), updateEnhancementLevel: vi.fn() },
}));
vi.mock('../../../utils/bundle-bridge.js', () => ({ guildMemberSkills: () => null, loadoutSnapshot: () => null }));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async (id) => id,
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { default: CustomTabsUI } = await import('./custom-tabs-ui.js');

let ui;

beforeEach(() => {
    repriced.listeners.clear();
});

afterEach(() => {
    ui?.cleanup();
    ui = null;
});

describe('custom-tab layout after a forced reprice', () => {
    test('reruns the layout while custom tabs are active', async () => {
        ui = new CustomTabsUI();
        await ui.initialize();
        const layout = vi.spyOn(ui, '_applyLayout').mockResolvedValue();
        ui._isActive = true;

        expect(repriced.listeners.size).toBe(1);
        for (const fn of repriced.listeners) fn();

        expect(layout).toHaveBeenCalledTimes(1);
    });

    test('does nothing while custom tabs are inactive', async () => {
        ui = new CustomTabsUI();
        await ui.initialize();
        const layout = vi.spyOn(ui, '_applyLayout').mockResolvedValue();
        ui._isActive = false;

        for (const fn of repriced.listeners) fn();

        expect(layout).not.toHaveBeenCalled();
    });

    test('unsubscribes on cleanup', async () => {
        ui = new CustomTabsUI();
        await ui.initialize();
        expect(repriced.listeners.size).toBe(1);

        ui.cleanup();
        ui = null;

        expect(repriced.listeners.size).toBe(0);
    });
});
