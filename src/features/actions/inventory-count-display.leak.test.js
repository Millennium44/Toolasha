/**
 * @vitest-environment happy-dom
 *
 * Inventory Count Display — setting-change listener lifecycle.
 *
 * Every character switch runs `cleanup()` then `initialize()` again
 * (feature-registry.js). initialize() registered a single
 * `config.onSettingChange` callback and discarded the unregister function, so
 * each switch left one more copy of the same callback on config's per-key
 * list — the same shape fixed in combat-text.js (c8b7842f).
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

// Real subscribe/unsubscribe bookkeeping, unlike a no-op stub, so a test can
// prove a cleanup+initialize cycle does not accumulate listeners.
const settingListeners = vi.hoisted(() => ({}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [],
        getActionDetails: () => null,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        COLOR_INV_COUNT: '#0f0',
        onSettingChange: (key, callback) => {
            (settingListeners[key] ??= []).push(callback);
            return () => {
                settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        },
    },
}));

vi.mock('../../utils/action-panel-helper.js', () => ({
    onActionTile: () => () => {},
    resolveActionTile: () => null,
}));

const inventoryCountDisplay = (await import('./inventory-count-display.js')).default;

describe('cleanup unregisters the setting-change listener it registered', () => {
    afterEach(() => {
        inventoryCountDisplay.cleanup();
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];
    });

    test('a character-switch cycle does not accumulate listeners', () => {
        inventoryCountDisplay.initialize();
        for (let i = 0; i < 3; i++) {
            inventoryCountDisplay.cleanup();
            inventoryCountDisplay.initialize();
        }

        expect(settingListeners.inventoryCountDisplay).toHaveLength(1);
    });
});
