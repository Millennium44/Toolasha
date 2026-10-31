/** @vitest-environment happy-dom */

/**
 * The drop-luck percentile cache: a list longer than the old 200-entry wipe threshold must keep its
 * figures between redraws instead of recomputing every row each time.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/websocket.js', () => ({
    default: { on: vi.fn(), off: vi.fn(), onSocketEvent: vi.fn(), offSocketEvent: vi.fn() },
}));
vi.mock('../../utils/gathering-drop-model.js', async (importOriginal) => ({
    ...(await importOriginal()),
    gatheringSessionLuck: vi.fn((session, income) => ({ percentile: income % 100 })),
}));

import { gatheringSessionLuck } from '../../utils/gathering-drop-model.js';
import { LootLogStats } from './loot-log-stats.js';

const entry = (i) => [
    { session: { id: i }, income: 1000 + i, gatheringQuantity: 0.2 },
    { actionHrid: '/actions/foraging/farmland', actionCount: 500 },
];

describe('LootLogStats.luckPercentileFor cache', () => {
    beforeEach(() => {
        gatheringSessionLuck.mockClear();
    });

    test('a 300-row list is computed once, then every redraw is served from the cache', () => {
        const stats = new LootLogStats();
        for (let pass = 0; pass < 3; pass++) {
            for (let i = 0; i < 300; i++) stats.luckPercentileFor(...entry(i));
        }
        expect(gatheringSessionLuck).toHaveBeenCalledTimes(300);
    });

    test('past the cap the least recently used row is the one dropped, and a hit refreshes its place', () => {
        const stats = new LootLogStats();
        for (let i = 0; i < 1000; i++) stats.luckPercentileFor(...entry(i));
        stats.luckPercentileFor(...entry(0)); // row 0 becomes the newest
        stats.luckPercentileFor(...entry(1000)); // evicts row 1, not row 0
        gatheringSessionLuck.mockClear();
        stats.luckPercentileFor(...entry(0));
        expect(gatheringSessionLuck).not.toHaveBeenCalled();
        stats.luckPercentileFor(...entry(1));
        expect(gatheringSessionLuck).toHaveBeenCalledTimes(1);
        expect(stats.luckCache.size).toBe(1000);
    });
});
