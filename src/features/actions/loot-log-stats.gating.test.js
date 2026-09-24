/**
 * @vitest-environment happy-dom
 *
 * Regression coverage for the lootLogStats / lootLogHistory decoupling.
 *
 * initialize() used to return before even reading lootLogHistory unless
 * lootLogStats ("Loot Log Statistics") was on, so lootLogHistory ("Loot Log:
 * Persist and display historical entries") could never work on its own. This
 * proves history recording/display wires up with lootLogHistory as the only
 * setting on, and that it does not also wire the per-row statistics watcher.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { LootLogStats } from './loot-log-stats.js';
import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import lootLogHistory from './loot-log-history.js';

vi.mock('../../utils/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(),
        getSettingValue: vi.fn(),
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_GOLD: '#ff0',
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: vi.fn(() => () => {}) } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getActionDetails: vi.fn(), getItemDetails: vi.fn() },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: vi.fn() }));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: { isInitialized: false, calculateExpectedValue: vi.fn() },
}));
vi.mock('./loot-log-history.js', () => ({
    default: {
        mergeAndSave: vi.fn(),
        getHistoricalEntries: vi.fn(async () => []),
        deleteEntry: vi.fn(async () => undefined),
        _charId: vi.fn(() => 'char-1'),
        _load: vi.fn(async () => []),
        _save: vi.fn(),
    },
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getEnhancementMaterialPrice: () => 0,
    getCheapestProtectionPrice: () => ({ price: 0 }),
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    enhancementCalculator: () => null,
    enhancementConfig: () => null,
}));

describe('entrypoint.js registry gate for lootLogStats', () => {
    test("the 'lootLogStats' entry's customCheck includes lootLogHistory", () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const entrypointSrc = readFileSync(path.join(here, '..', '..', 'entrypoint.js'), 'utf8');

        const keyIndex = entrypointSrc.indexOf("key: 'lootLogStats',");
        expect(keyIndex).toBeGreaterThan(-1);
        const entryText = entrypointSrc.slice(keyIndex, keyIndex + 500);
        expect(entryText).toContain("config.getSetting('lootLogStats')");
        expect(entryText).toContain("config.getSetting('lootLogHistory')");
        expect(entryText).toMatch(/customCheck:\s*\(\)\s*=>[^\n]*\|\|/);
    });
});

describe('LootLogStats: only lootLogHistory on', () => {
    let stats;

    beforeEach(() => {
        vi.clearAllMocks();
        config.getSetting.mockImplementation((key) => key === 'lootLogHistory');
        stats = new LootLogStats();
    });

    test('initialize() does not return early and wires the history observer, not the stats one', async () => {
        await stats.initialize();

        expect(stats.initialized).toBe(true);
        expect(stats.historyEnabled).toBe(true);

        const watcherNames = domObserver.onClass.mock.calls.map((call) => call[0]);
        expect(watcherNames).toContain('LootLogHistory');
        expect(watcherNames).not.toContain('LootLogStats');
    });

    test('a loot_log_updated message persists to history and renders it, without running the stats pass', async () => {
        await stats.initialize();

        const processSpy = vi.spyOn(stats, 'processLootLogElement');
        const renderSpy = vi.spyOn(stats, 'renderHistoricalEntries').mockResolvedValue(undefined);

        const wsCall = webSocketHook.on.mock.calls.find((call) => call[0] === 'loot_log_updated');
        expect(wsCall).toBeDefined();
        const handler = wsCall[1];

        handler({ lootLog: [{ characterActionId: 'a1' }] });
        expect(lootLogHistory.mergeAndSave).toHaveBeenCalledWith([{ characterActionId: 'a1' }]);

        await new Promise((resolve) => setTimeout(resolve, 250));

        expect(renderSpy).toHaveBeenCalled();
        expect(processSpy).not.toHaveBeenCalled();
    });
});
