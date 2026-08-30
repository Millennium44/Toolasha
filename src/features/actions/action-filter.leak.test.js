/** @vitest-environment happy-dom */

/**
 * Action Filter — setting-change/settings-loaded listener lifecycle.
 *
 * panel-observer.js's own cleanup() calls `actionFilter.cleanup()` on every
 * character switch, right alongside every other feature's teardown
 * (feature-registry.js). A stale in-file comment claimed Action Filter "never
 * re-initializes"; it does, every switch, exactly like the rest. initialize()
 * registered three config listeners (two onSettingChange, one
 * onSettingsLoaded) and discarded all three unregister functions, so each
 * switch left one more copy of each callback on config's lists — the same
 * shape fixed in combat-text.js (c8b7842f).
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

// Real subscribe/unsubscribe bookkeeping, unlike a no-op `vi.fn()`, so a test
// can prove a cleanup+initialize cycle does not accumulate listeners.
const settingListeners = vi.hoisted(() => ({}));
const settingsLoadedListeners = vi.hoisted(() => []);

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#abc',
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        getPricingModeLabel: (mode) => mode,
        onSettingChange: (key, callback) => {
            (settingListeners[key] ??= []).push(callback);
            return () => {
                settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        },
        onSettingsLoaded: (callback) => {
            settingsLoadedListeners.push(callback);
            return () => {
                const index = settingsLoadedListeners.indexOf(callback);
                if (index !== -1) settingsLoadedListeners.splice(index, 1);
            };
        },
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { fetch: async () => true },
}));

vi.mock('./action-panel-sort.js', () => ({
    default: {
        onSortModeChange: () => () => {},
        getSortMode: () => 'default',
        setSortMode: () => {},
        sortPanelsByProfit: () => {},
    },
}));

vi.mock('./profit-display.js', () => ({
    displayGatheringProfit: async () => {},
    displayProductionProfit: async () => {},
}));

const { default: actionFilter } = await import('./action-filter.js');

describe('cleanup unregisters the config listeners it registered', () => {
    afterEach(() => {
        actionFilter.cleanup();
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];
        settingsLoadedListeners.length = 0;
    });

    test('a character-switch cycle does not accumulate listeners', async () => {
        // Mirrors what panel-observer.js's cleanup() + initialize() actually
        // does to Action Filter on every character switch.
        await actionFilter.initialize();
        for (let i = 0; i < 3; i++) {
            actionFilter.cleanup();
            await actionFilter.initialize();
        }

        expect(settingListeners.profitCalc_pricingMode).toHaveLength(1);
        expect(settingListeners.profitCalc_craftUpgradeItems).toHaveLength(1);
        expect(settingsLoadedListeners).toHaveLength(1);
    });
});
