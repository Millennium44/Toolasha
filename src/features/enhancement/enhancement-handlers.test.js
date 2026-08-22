/**
 * The tracker's websocket handlers: a run that is already going when the
 * script comes up (a page load mid-run) must still get a session — the
 * count-1 attempt was never seen, and nothing flagged a pending start.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
    handlers: {},
    current: null,
    calls: [],
}));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, fn) => {
            state.handlers[type] = fn;
        },
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/enchanted_cloak_refined': { name: 'Enchanted Cloak ★', enhancementCosts: [] },
            },
        }),
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('./enhancement-xp.js', () => ({
    calculateSuccessXP: () => 0,
    calculateFailureXP: () => 0,
    calculateAdjustedAttemptCount: () => 1,
}));
vi.mock('./tooltip-enhancement.js', () => ({ getEnhancementMaterialPrice: () => 0 }));
vi.mock('./enhancement-ui.js', () => ({ default: { switchToSession: () => {}, scheduleUpdate: () => {} } }));
vi.mock('./enhancement-tracker.js', () => ({
    default: {
        isInitialized: true,
        pendingSessionStart: false,
        getCurrentSession: () => state.current,
        findExtendableSession: () => null,
        startSession: vi.fn(async (itemHrid, startLevel, targetLevel, protectFrom) => {
            state.calls.push(['start', itemHrid, startLevel, targetLevel, protectFrom]);
            state.current = { id: 's1', itemHrid, startLevel, targetLevel, protectFrom, totalXP: 0, lastAttempt: null };
            return 's1';
        }),
        recordSuccess: vi.fn(async (...a) => state.calls.push(['success', ...a])),
        recordFailure: vi.fn(async (...a) => state.calls.push(['failure', ...a])),
        trackCoinCost: async () => {},
        trackMaterialCost: async () => {},
        trackProtectionCost: async () => {},
        finalizeCurrentSession: async () => {},
    },
}));

const { setupEnhancementHandlers } = await import('./enhancement-handlers.js');

const attempt = (level, currentCount) => ({
    endCharacterAction: {
        actionHrid: '/actions/enhancing/enhance',
        currentCount,
        primaryItemHash: `30404::/item_locations/inventory::/items/enchanted_cloak_refined::${level}`,
        secondaryItemHash: '30404::/item_locations/inventory::/items/mirror_of_protection::0',
        enhancingMaxLevel: 15,
        enhancingProtectionMinLevel: 2,
    },
});

beforeEach(() => {
    state.handlers = {};
    state.current = null;
    state.calls = [];
    setupEnhancementHandlers();
});

describe('a run already going when the script comes up', () => {
    test('gets a session from the attempt in hand, and records from the next one on', async () => {
        // Count 78 with no session and no pending start: the page loaded mid-run
        await state.handlers.action_completed(attempt(5, 78));
        expect(state.calls).toEqual([['start', '/items/enchanted_cloak_refined', 5, 15, 2]]);

        // The next attempt has a baseline and is recorded
        await state.handlers.action_completed(attempt(6, 79));
        expect(state.calls.at(-1)).toEqual(['success', 5, 6, false]);
    });
});
