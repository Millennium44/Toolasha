/**
 * Tests for Feature Registry
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    isCharacterSwitching: false,
    enabledFeatures: new Set(),
    currentCharacterId: null,
    handlers: {},
    calls: [],
}));

vi.mock('./config.js', () => ({
    default: {
        isFeatureEnabled: (key) => state.enabledFeatures.has(key),
        clearSettingsCache: () => state.calls.push('clearCache'),
        loadSettings: async () => state.calls.push('loadSettings'),
        applyColorSettings: () => state.calls.push('applyColors'),
    },
}));

vi.mock('./data-manager.js', () => ({
    default: {
        getIsCharacterSwitching: () => state.isCharacterSwitching,
        getCurrentCharacterId: () => state.currentCharacterId,
        on: (event, handler) => {
            state.handlers[event] = handler;
        },
    },
}));

vi.mock('../utils/performance-monitor.js', () => ({
    default: {
        mark: vi.fn(),
        sinceBoot: () => 0,
        snapshot: vi.fn(),
    },
}));

const featureRegistry = (await import('./feature-registry.js')).default;

beforeEach(() => {
    state.isCharacterSwitching = false;
    state.enabledFeatures = new Set();
    state.currentCharacterId = null;
    state.handlers = {};
    state.calls = [];
    featureRegistry.replaceFeatures([]);
});

describe('initializeFeatures', () => {
    test('returns [] immediately during a character switch', async () => {
        state.isCharacterSwitching = true;
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: vi.fn() }]);
        const errors = await featureRegistry.initializeFeatures();
        expect(errors).toEqual([]);
        expect(featureRegistry.getFeature('a').initialize).not.toHaveBeenCalled();
    });

    test('skips features that are not enabled', async () => {
        const initialize = vi.fn();
        featureRegistry.replaceFeatures([{ key: 'disabled', name: 'Disabled', initialize }]);
        await featureRegistry.initializeFeatures();
        expect(initialize).not.toHaveBeenCalled();
    });

    test('initializes enabled features', async () => {
        state.enabledFeatures.add('enabled');
        const initialize = vi.fn();
        featureRegistry.replaceFeatures([{ key: 'enabled', name: 'Enabled', initialize }]);
        await featureRegistry.initializeFeatures();
        expect(initialize).toHaveBeenCalledTimes(1);
    });

    test('uses customCheck instead of config when provided', async () => {
        const initialize = vi.fn();
        featureRegistry.replaceFeatures([{ key: 'custom', name: 'Custom', initialize, customCheck: () => true }]);
        await featureRegistry.initializeFeatures();
        expect(initialize).toHaveBeenCalledTimes(1);
    });

    test('collects an error entry when a feature initializer throws, and continues to the next feature', async () => {
        state.enabledFeatures.add('broken');
        state.enabledFeatures.add('fine');
        const fineInit = vi.fn();
        featureRegistry.replaceFeatures([
            {
                key: 'broken',
                name: 'Broken',
                initialize: () => {
                    throw new Error('init failed');
                },
            },
            { key: 'fine', name: 'Fine', initialize: fineInit },
        ]);

        const errors = await featureRegistry.initializeFeatures();

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({ key: 'broken', name: 'Broken', reason: 'Initialization threw: init failed' });
        expect(fineInit).toHaveBeenCalledTimes(1);
    });

    test('awaits a rejecting async initializer and reports it as failed', async () => {
        state.enabledFeatures.add('rejects');
        featureRegistry.replaceFeatures([
            {
                key: 'rejects',
                name: 'Rejects',
                initialize: async () => {
                    throw new Error('async fail');
                },
            },
        ]);

        const errors = await featureRegistry.initializeFeatures();
        expect(errors[0].reason).toBe('Initialization threw: async fail');
    });
});

describe('getFeature / getAllFeatures / getFeaturesByCategory', () => {
    test('getFeature returns null for an unknown key', () => {
        expect(featureRegistry.getFeature('nonexistent')).toBeNull();
    });

    test('getFeature finds a registered feature by key', () => {
        featureRegistry.replaceFeatures([{ key: 'x', name: 'X', initialize: () => {} }]);
        expect(featureRegistry.getFeature('x').name).toBe('X');
    });

    test('getAllFeatures returns a copy, not the live array', () => {
        featureRegistry.replaceFeatures([{ key: 'x', name: 'X', initialize: () => {} }]);
        const list = featureRegistry.getAllFeatures();
        list.push({ key: 'y' });
        expect(featureRegistry.getAllFeatures()).toHaveLength(1);
    });

    test('getFeaturesByCategory filters by category', () => {
        featureRegistry.replaceFeatures([
            { key: 'a', name: 'A', category: 'market', initialize: () => {} },
            { key: 'b', name: 'B', category: 'combat', initialize: () => {} },
        ]);
        expect(featureRegistry.getFeaturesByCategory('market')).toHaveLength(1);
        expect(featureRegistry.getFeaturesByCategory('market')[0].key).toBe('a');
    });
});

describe('checkFeatureHealth', () => {
    test('skips features with no healthCheck', () => {
        state.enabledFeatures.add('a');
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: () => {} }]);
        expect(featureRegistry.checkFeatureHealth()).toEqual([]);
    });

    test('skips disabled features even if they define healthCheck', () => {
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: () => {}, healthCheck: () => false }]);
        expect(featureRegistry.checkFeatureHealth()).toEqual([]);
    });

    test('reports a feature whose healthCheck returns false', () => {
        state.enabledFeatures.add('a');
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: () => {}, healthCheck: () => false }]);
        const failed = featureRegistry.checkFeatureHealth();
        expect(failed).toEqual([{ key: 'a', name: 'A', reason: 'Health check returned false' }]);
    });

    test('does not report a feature whose healthCheck returns true or null', () => {
        state.enabledFeatures.add('a');
        state.enabledFeatures.add('b');
        featureRegistry.replaceFeatures([
            { key: 'a', name: 'A', initialize: () => {}, healthCheck: () => true },
            { key: 'b', name: 'B', initialize: () => {}, healthCheck: () => null },
        ]);
        expect(featureRegistry.checkFeatureHealth()).toEqual([]);
    });

    test('reports a feature whose healthCheck throws', () => {
        state.enabledFeatures.add('a');
        featureRegistry.replaceFeatures([
            {
                key: 'a',
                name: 'A',
                initialize: () => {},
                healthCheck: () => {
                    throw new Error('check failed');
                },
            },
        ]);
        const failed = featureRegistry.checkFeatureHealth();
        expect(failed[0].reason).toBe('Health check error: check failed');
    });
});

describe('retryFailedFeatures', () => {
    test('re-runs initialize and reports still-failing features via a false health check', async () => {
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: vi.fn(), healthCheck: () => false }]);
        const stillFailed = await featureRegistry.retryFailedFeatures([{ key: 'a', name: 'A' }]);
        expect(stillFailed).toEqual([{ key: 'a', name: 'A', reason: 'Retried, but its health check still fails' }]);
    });

    test('does not report a feature that recovers on retry', async () => {
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: vi.fn(), healthCheck: () => true }]);
        const stillFailed = await featureRegistry.retryFailedFeatures([{ key: 'a', name: 'A' }]);
        expect(stillFailed).toEqual([]);
    });

    test('reports a feature whose retry itself throws', async () => {
        featureRegistry.replaceFeatures([
            {
                key: 'a',
                name: 'A',
                initialize: () => {
                    throw new Error('still broken');
                },
            },
        ]);
        const stillFailed = await featureRegistry.retryFailedFeatures([{ key: 'a', name: 'A' }]);
        expect(stillFailed[0].reason).toBe('Retry threw: still broken');
    });

    test('skips a failed feature that is no longer in the registry', async () => {
        featureRegistry.replaceFeatures([]);
        const stillFailed = await featureRegistry.retryFailedFeatures([{ key: 'gone', name: 'Gone' }]);
        expect(stillFailed).toEqual([]);
    });
});

describe('replaceFeatures', () => {
    test('replaces the registry contents entirely', () => {
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: () => {} }]);
        featureRegistry.replaceFeatures([{ key: 'b', name: 'B', initialize: () => {} }]);
        expect(featureRegistry.getAllFeatures().map((f) => f.key)).toEqual(['b']);
    });
});

describe('setupCharacterSwitchHandler — serialized lifecycle', () => {
    /** Register one enabled feature that logs its disable/initialize into state.calls */
    function oneFeature() {
        state.enabledFeatures = new Set(['x']);
        const initialize = vi.fn(() => state.calls.push('init:x'));
        const disable = vi.fn(() => state.calls.push('disable:x'));
        featureRegistry.replaceFeatures([{ key: 'x', name: 'X', initialize, disable }]);
        return { initialize, disable };
    }

    test('clears the cache, tears down, reloads settings, then re-inits — in that order', async () => {
        vi.useFakeTimers();
        state.currentCharacterId = 'B';
        oneFeature();

        featureRegistry.setupCharacterSwitchHandler();
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'B' });
        await vi.advanceTimersByTimeAsync(100);

        // Cleanup finished before reinit started — no overlap
        expect(state.calls).toEqual(['clearCache', 'disable:x', 'loadSettings', 'applyColors', 'init:x']);
        vi.useRealTimers();
    });

    test('a reinit a newer switch has superseded does not re-initialize', async () => {
        // The current character is B, but this character_switched is for A — a
        // stale event a newer switch overtook. Without the target-id check the old
        // handler would init A over B; now it aborts.
        vi.useFakeTimers();
        state.currentCharacterId = 'B';
        const { initialize } = oneFeature();

        featureRegistry.setupCharacterSwitchHandler();
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'A' });
        await vi.advanceTimersByTimeAsync(100);

        expect(initialize).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    test('a second switch in flight is not dropped', async () => {
        // The old boolean guard returned early on the second character_switched
        // while the first reinit was still running, dropping it. Serialized, both
        // run.
        vi.useFakeTimers();
        state.currentCharacterId = 'B';
        const { initialize } = oneFeature();

        featureRegistry.setupCharacterSwitchHandler();
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'B' });
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'B' });
        await vi.advanceTimersByTimeAsync(200);

        expect(initialize).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });
});
