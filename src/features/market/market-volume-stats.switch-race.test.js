/** @vitest-environment happy-dom
 *
 * A character switch tearing Market Volume Stats down while its `initialize()`
 * is parked on the column-preferences storage read.
 *
 * `initialize()` awaits `loadColumnPrefs()` before registering the order-book
 * class observer. Without an ownership ticket, a `disable()` landing inside
 * that await would still let the resumed tail call `setupObserver()` — wiring
 * a fresh `domObserver.onClass` registration into a `cleanupRegistry` the
 * teardown had just emptied, one live, unremovable registration per switch.
 * `src/utils/init-ownership-coverage.test.js` catches the shape by source-text
 * scan; this proves the actual fix behaves under a real suspended read.
 */

import { describe, test, expect, vi } from 'vitest';

const gate = vi.hoisted(() => ({ promise: null, resolve: null }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => () => {} },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: vi.fn(async () => {
            await gate.promise;
            return null;
        }),
        setJSON: vi.fn(async () => true),
    },
}));

const observerRegistrations = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => {
            observerRegistrations.count += 1;
            return () => {};
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'char1' },
}));

const { default: marketVolumeStats } = await import('./market-volume-stats.js');

describe('character-switch race in initialize()', () => {
    test('a disable() landing inside the storage read leaves no observer registered when it resumes', async () => {
        gate.promise = new Promise((resolve) => {
            gate.resolve = resolve;
        });
        observerRegistrations.count = 0;

        const initializing = marketVolumeStats.initialize();

        // The switch tears the feature down while the read is still in flight
        marketVolumeStats.disable();

        // The parked storage read now resolves, letting initialize()'s tail run
        gate.resolve();
        await initializing;

        expect(observerRegistrations.count).toBe(0);
        expect(marketVolumeStats.isInitialized).toBe(false);
    });

    test('an uninterrupted initialize() does register normally', async () => {
        gate.promise = Promise.resolve();
        observerRegistrations.count = 0;

        await marketVolumeStats.initialize();

        expect(observerRegistrations.count).toBe(1);
        expect(marketVolumeStats.isInitialized).toBe(true);

        marketVolumeStats.disable();
    });
});
