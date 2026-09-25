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
        onSettingChange: vi.fn(() => () => {}),
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

describe('LootLogStats: switching either part live', () => {
    let stats;
    let on;

    /** Flip a setting and fire the listener the instance registered for it */
    const flip = (key, value) => {
        if (value) on.add(key);
        else on.delete(key);
        for (const [registered, callback] of config.onSettingChange.mock.calls) {
            if (registered === key) callback(value);
        }
    };

    const watchers = (name) => domObserver.onClass.mock.calls.filter((call) => call[0] === name).length;

    beforeEach(() => {
        vi.clearAllMocks();
        on = new Set();
        config.getSetting.mockImplementation((key) => on.has(key));
        domObserver.onClass.mockImplementation(() => vi.fn());
        document.body.innerHTML = '';
        stats = new LootLogStats();
    });

    test('statistics switched on in history-only mode attach the row watcher, not a second socket listener', async () => {
        on.add('lootLogHistory');
        await stats.initialize();
        expect(watchers('LootLogStats')).toBe(0);

        flip('lootLogStats', true);

        expect(watchers('LootLogStats')).toBe(1);
        expect(webSocketHook.on.mock.calls.filter((call) => call[0] === 'loot_log_updated')).toHaveLength(1);

        // Flipping it again while on does not stack a second watcher
        flip('lootLogStats', true);
        expect(watchers('LootLogStats')).toBe(1);
    });

    test('statistics switched off detach the row watcher and take the drawn figures and stamps away', async () => {
        on.add('lootLogStats');
        on.add('lootLogHistory');
        await stats.initialize();
        const unregister =
            domObserver.onClass.mock.results[
                domObserver.onClass.mock.calls.findIndex((call) => call[0] === 'LootLogStats')
            ].value;

        document.body.innerHTML = `
            <div class="LootLogPanel_actionLoot__32gl_" data-mwi-loot-log-stamp="1|2">
                <div></div><div><div class="mwi-loot-log-value">5</div></div>
                <div><span class="mwi-loot-log-avgtime">1s</span></div>
            </div>`;

        flip('lootLogStats', false);

        expect(unregister).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.mwi-loot-log-value')).toBeNull();
        expect(document.querySelector('.mwi-loot-log-avgtime')).toBeNull();
        expect(document.querySelector('.LootLogPanel_actionLoot__32gl_').dataset.mwiLootLogStamp).toBeUndefined();
        expect(stats.initialized).toBe(true);
    });

    test('history switched on in statistics-only mode starts persisting', async () => {
        on.add('lootLogStats');
        await stats.initialize();
        const handler = webSocketHook.on.mock.calls.find((call) => call[0] === 'loot_log_updated')[1];

        handler({ lootLog: [{ characterActionId: 'a1' }] });
        expect(lootLogHistory.mergeAndSave).not.toHaveBeenCalled();

        flip('lootLogHistory', true);
        expect(watchers('LootLogHistory')).toBe(1);
        expect(lootLogHistory.mergeAndSave).toHaveBeenCalledWith([{ characterActionId: 'a1' }]);
    });

    test('history switched off stops persisting and removes the historical section', async () => {
        on.add('lootLogHistory');
        await stats.initialize();
        document.body.innerHTML = '<div class="mwi-loot-log-history"></div>';
        const handler = webSocketHook.on.mock.calls.find((call) => call[0] === 'loot_log_updated')[1];

        flip('lootLogHistory', false);
        handler({ lootLog: [{ characterActionId: 'a2' }] });

        expect(lootLogHistory.mergeAndSave).not.toHaveBeenCalled();
        expect(document.querySelector('.mwi-loot-log-history')).toBeNull();
    });
});
