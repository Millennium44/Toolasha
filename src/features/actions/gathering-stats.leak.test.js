/**
 * @vitest-environment happy-dom
 *
 * Gathering Stats — setting-change listener lifecycle.
 *
 * Every character switch runs `cleanup()` then `initialize()` again
 * (feature-registry.js). initialize() registers three `config.onSettingChange`
 * callbacks and discarded the unregister functions, so each switch left one
 * more copy of the same callback on config's per-key list — the same shape
 * fixed in combat-text.js (c8b7842f).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));
// Real subscribe/unsubscribe bookkeeping, unlike a no-op stub, so a test can
// prove a cleanup+initialize cycle does not accumulate listeners.
const settingListeners = vi.hoisted(() => ({}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: () => null,
        getInventory: () => [],
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? true,
        onSettingChange: (key, callback) => {
            (settingListeners[key] ??= []).push(callback);
            return () => {
                settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        },
        offSettingChange: (key, callback) => {
            settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
        },
    },
}));

const sortCalls = vi.hoisted(() => ({ cleared: 0, unregistered: [] }));

vi.mock('./action-panel-sort.js', () => ({
    default: {
        initialize: async () => {},
        clearAllPanels: () => {
            sortCalls.cleared++;
        },
        unregisterPanel: (panel) => sortCalls.unregistered.push(panel),
    },
}));

vi.mock('./action-filter.js', () => ({ default: {} }));
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../../utils/experience-calculator.js', () => ({ calculateExpPerHour: () => null }));
vi.mock('../../utils/action-panel-helper.js', () => ({
    onActionTile: () => () => {},
    resolveActionTile: () => null,
}));

const gatheringStats = (await import('./gathering-stats.js')).default;

describe('cleanup unregisters the setting-change listeners it registered', () => {
    beforeEach(() => {
        settings.values = {};
    });

    afterEach(() => {
        gatheringStats.disable();
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];
    });

    test('a character-switch cycle does not accumulate listeners', async () => {
        await gatheringStats.initialize();
        for (let i = 0; i < 3; i++) {
            gatheringStats.disable();
            await gatheringStats.initialize();
        }

        expect(settingListeners.profitCalc_pricingMode).toHaveLength(1);
        expect(settingListeners.actionPanel_showProfitPerHour_gathering).toHaveLength(1);
        expect(settingListeners.actionPanel_showExpPerHour_gathering).toHaveLength(1);
    });
});

describe('switching gathering stats off leaves other features’ sort panels alone', () => {
    test('disable unregisters only its own panels, never the shared manager’s whole list', async () => {
        sortCalls.cleared = 0;
        sortCalls.unregistered = [];
        await gatheringStats.initialize();
        const ownPanel = document.createElement('div');
        gatheringStats.actionElements.set(ownPanel, { displayElement: document.createElement('span') });

        gatheringStats.disable();

        expect(sortCalls.unregistered).toEqual([ownPanel]);
        // clearAllPanels would also drop max-produceable's production tiles
        expect(sortCalls.cleared).toBe(0);
    });
});
