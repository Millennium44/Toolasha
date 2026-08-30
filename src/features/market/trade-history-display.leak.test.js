/**
 * @vitest-environment happy-dom
 *
 * Trade History Display — setting-change listener lifecycle.
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

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        onSettingChange: (key, callback) => {
            (settingListeners[key] ??= []).push(callback);
            return () => {
                settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        },
    },
}));

vi.mock('./trade-history.js', () => ({
    default: { getHistory: () => null },
}));

const tradeHistoryDisplay = (await import('./trade-history-display.js')).default;

describe('disable unregisters the setting-change listener it registered', () => {
    afterEach(() => {
        tradeHistoryDisplay.disable();
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];
    });

    test('a character-switch cycle does not accumulate listeners', () => {
        tradeHistoryDisplay.initialize();
        for (let i = 0; i < 3; i++) {
            tradeHistoryDisplay.disable();
            tradeHistoryDisplay.initialize();
        }

        expect(settingListeners.market_tradeHistoryComparisonMode).toHaveLength(1);
    });
});
