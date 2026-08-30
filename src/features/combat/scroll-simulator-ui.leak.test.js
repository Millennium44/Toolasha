/**
 * @vitest-environment happy-dom
 *
 * Scroll Simulator UI — setting-change listener lifecycle.
 *
 * Every character switch runs `disable()` then `initialize()` again
 * (feature-registry.js). initialize() registered a single
 * `config.onSettingChange` callback and discarded the unregister function, so
 * each switch left one more copy of the same callback on config's per-key
 * list — the same shape fixed in combat-text.js (c8b7842f).
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

// Real subscribe/unsubscribe bookkeeping, unlike a no-op stub, so a test can
// prove a disable+initialize cycle does not accumulate listeners.
const settingListeners = vi.hoisted(() => ({}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        Z_FLOATING_PANEL: 1000,
        onSettingChange: (key, callback) => {
            (settingListeners[key] ??= []).push(callback);
            return () => {
                settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        },
    },
}));

vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

vi.mock('./scroll-simulator.js', () => ({ default: {} }));
vi.mock('./loadout-snapshot.js', () => ({ default: { getAllSnapshots: () => [] } }));

const scrollSimulatorUI = (await import('./scroll-simulator-ui.js')).default;

describe('disable unregisters the setting-change listener it registered', () => {
    afterEach(() => {
        scrollSimulatorUI.disable();
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];
    });

    test('a character-switch cycle does not accumulate listeners', () => {
        scrollSimulatorUI.initialize();
        for (let i = 0; i < 3; i++) {
            scrollSimulatorUI.disable();
            scrollSimulatorUI.initialize();
        }

        expect(settingListeners.simulateScrollEffects).toHaveLength(1);
    });
});
