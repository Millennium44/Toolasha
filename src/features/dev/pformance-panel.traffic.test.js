/** @vitest-environment happy-dom
 *
 * The extras the traffic work added: the Tampermonkey traffic section and the
 * all-tabs list, and the tab census that feeds the latter.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = {};
vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSettingValue: (key, fallback) => (key in settings ? settings[key] : fallback),
        setSettingValue: (key, value) => {
            settings[key] = value;
        },
    },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
const download = vi.hoisted(() => vi.fn());
vi.mock('../../utils/csv-export.js', () => ({ downloadFile: download }));

const { default: pformancePanel } = await import('./pformance-panel.js');
const { getSettingDefinition } = await import('../../core/settings-schema.js');
const { gmSetValue, gmRequest, resetGmTraffic } = await import('../../utils/gm-traffic.js');

const onScreen = () => document.getElementById('toolasha-pformance-panel');
const text = () => onScreen()?.textContent || '';

const monitor = {
    enabled: false,
    timerCounters: { interval: 2, timeout: 7, domRearm: 3, named: 1 },
    getAllStats: () => new Map(),
    getSnapshots: () => new Map(),
    getSpans: () => [],
    getMarks: () => [],
};

/** A loopback bus shared by every channel opened through BroadcastChannel */
class FakeChannel {
    static all = [];
    constructor(name) {
        this.name = name;
        this.closed = false;
        FakeChannel.all.push(this);
    }
    postMessage(data) {
        for (const other of FakeChannel.all) if (other !== this && !other.closed) other.onmessage?.({ data });
    }
    close() {
        this.closed = true;
    }
}

beforeEach(() => {
    download.mockClear();
    vi.useFakeTimers();
    window.Toolasha = {
        Core: {
            performanceMonitor: monitor,
            dataManager: { getCurrentCharacterId: () => 5, getCurrentCharacterName: () => 'Tester' },
        },
    };
    for (const key of Object.keys(settings)) delete settings[key];
    FakeChannel.all = [];
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    vi.stubGlobal('GM_setValue', vi.fn());
    resetGmTraffic();
});

afterEach(() => {
    vi.useRealTimers();
    pformancePanel.disable();
    document.body.replaceChildren();
    delete window.Toolasha;
    vi.unstubAllGlobals();
});

describe('Tampermonkey traffic and all-tabs sections', () => {
    test('absent while the extras are off; the tab still joins the channel and answers a poll', () => {
        pformancePanel.initialize();
        pformancePanel.show();
        expect(text()).not.toContain('Tampermonkey traffic');
        expect(text()).not.toContain('All tabs');
        expect(FakeChannel.all).toHaveLength(1);
        expect(pformancePanel.tabCensus.isPolling()).toBe(false);

        const asker = new FakeChannel('toolasha-tab-census');
        const replies = [];
        asker.onmessage = (event) => replies.push(event.data);
        asker.postMessage({ v: 1, type: 'poll', tabId: 'asker', round: 1 });
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatchObject({ type: 'summary', replyTo: 'asker', round: 1 });
        expect(replies[0].summary.characterName).toBe('Tester');
    });

    test('drawn with the extras on, with counted writes and requests, and nothing fails to draw', () => {
        settings.pformanceAttribution = true;
        gmSetValue('toolasha_init_client_data', 'x'.repeat(4096));
        vi.stubGlobal('GM_xmlhttpRequest', () => {});
        gmRequest({ url: 'https://api.github.com/gists' });

        pformancePanel.initialize();
        pformancePanel.show();

        expect(text()).toContain('Tampermonkey traffic');
        expect(text()).toContain('toolasha_init_client_data: 1x, 4.0 KB');
        expect(text()).toContain('api.github.com: 1x');
        expect(text()).toContain('▶ this tab — Tester');
        expect(text()).not.toContain('could not be drawn');
    });

    test('polls only while the panel is open with extras on, and hears another tab', () => {
        settings.pformanceAttribution = true;
        pformancePanel.initialize();
        expect(FakeChannel.all).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);

        const other = new FakeChannel('toolasha-tab-census');
        other.onmessage = (event) => {
            if (event.data.type !== 'poll') return;
            other.postMessage({
                v: 1,
                type: 'summary',
                tabId: 'zzz',
                replyTo: event.data.tabId,
                round: event.data.round,
                summary: { characterName: 'Other', uptimeMs: 7200000, traffic: null, heapMb: 512, stalls: null },
            });
        };
        pformancePanel.show();
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        pformancePanel._updateContent();
        expect(text()).toContain('zzz — Other, up 2h 0m');
        expect(text()).toContain('heap 512MB');

        pformancePanel.hide();
        expect(pformancePanel.tabCensus.isPolling()).toBe(false);
        expect(pformancePanel.tabCensus.isRunning()).toBe(true);

        pformancePanel.disable();
        expect(FakeChannel.all[0].closed).toBe(true);
    });

    test('opening the panel joins the census even when initialize() never ran (command palette off)', () => {
        pformancePanel.show();
        expect(pformancePanel.tabCensus?.isRunning()).toBe(true);
    });

    test('joinTabCensus() joins without initialize() or show(), once, and leaveTabCensus() stops it', () => {
        pformancePanel.joinTabCensus();
        pformancePanel.joinTabCensus();
        expect(FakeChannel.all.length).toBe(1);
        expect(pformancePanel.tabCensus.isRunning()).toBe(true);
        expect(pformancePanel.tabCensus.isPolling()).toBe(false);

        // The later joins reuse the same census
        pformancePanel.initialize();
        pformancePanel.show();
        expect(FakeChannel.all.length).toBe(1);

        pformancePanel.leaveTabCensus();
        expect(FakeChannel.all[0].closed).toBe(true);
        expect(pformancePanel.tabCensus).toBeNull();
        pformancePanel.leaveTabCensus();
    });

    test('toggling the extras button starts and stops polling, not the channel', () => {
        pformancePanel.initialize();
        pformancePanel.show();
        const toggle = [...onScreen().querySelectorAll('button')].find((b) => b.textContent === '◎');
        toggle.click();
        expect(pformancePanel.tabCensus.isPolling()).toBe(true);
        expect(settings.pformanceAttribution).toBe(true);
        expect(text()).toContain('All tabs');
        toggle.click();
        expect(pformancePanel.tabCensus.isPolling()).toBe(false);
        expect(FakeChannel.all[0].closed).toBe(false);
        expect(text()).not.toContain('All tabs');
    });

    test('says so when BroadcastChannel is missing', () => {
        vi.stubGlobal('BroadcastChannel', undefined);
        settings.pformanceAttribution = true;
        pformancePanel.initialize();
        pformancePanel.show();
        expect(text()).toContain('no BroadcastChannel');
        expect(text()).not.toContain('could not be drawn');
    });
});

describe('the extras setting', () => {
    test('is declared in the settings schema, hidden and off by default, so the toggle can persist', () => {
        const definition = getSettingDefinition('pformanceAttribution');
        expect(definition).toMatchObject({ type: 'checkbox', default: false, hidden: true });
    });
});

describe('the exported report', () => {
    /** Press the save button and return the text and parsed JSON that were written */
    const saved = async () => {
        await pformancePanel._exportReport('file');
        const text = download.mock.calls.find((call) => call[0].endsWith('.txt'))[1];
        const json = JSON.parse(download.mock.calls.find((call) => call[0].endsWith('.json'))[1]);
        return { text, json };
    };

    test('carries timer counters, and says the extras are off when they are', async () => {
        pformancePanel.initialize();
        pformancePanel.show();
        const { text, json } = await saved();

        expect(text).toContain('9 created (7 timeout, 2 interval), 3 observer debounce re-arms, 1 named');
        expect(json.timerCounters.counters).toEqual(monitor.timerCounters);
        expect(json.leak.canary).toMatchObject({ rows: null, reason: expect.stringContaining('extras are off') });
        expect(json.leak.heap.reason).toContain('extras are off');
        expect(json.tabs.reason).toContain('only this tab is listed');
        expect(json.tabs.tabs).toHaveLength(1);
        // Traffic is always counted, so it is present whether or not the extras are on
        expect(json.traffic.snapshot.totals.writeCalls).toBe(0);
        expect(text).toContain('extras are off');
    });

    test('with the extras on: traffic, tabs, canary and heap, with nothing private in them', async () => {
        settings.pformanceAttribution = true;
        window.Toolasha.Core.performanceMonitor = {
            ...monitor,
            heapMemorySupported: () => true,
            createLeakCanary: () => ({
                sample: () => {},
                getReport: () => [
                    { source: 'timers:interval', latest: 3, lowest: 1, samples: 9, decreases: 0, growing: false },
                ],
                reset: () => {},
            }),
            createHeapTrend: () => ({
                sample: () => {},
                getTrend: () => ({ usedMb: 80, changeMb: 2, perMinuteMb: 1, samples: 5, spanMs: 120000 }),
                reset: () => {},
            }),
        };
        gmSetValue('toolasha_init_client_data', 'x'.repeat(2048));
        vi.stubGlobal('GM_xmlhttpRequest', () => {});
        gmRequest({ url: 'https://api.github.com/gists/0123456789abcdef0123456789abcdef?access_token=SECRET' });

        const other = new FakeChannel('toolasha-tab-census');
        other.onmessage = (event) => {
            if (event.data.type !== 'poll') return;
            other.postMessage({
                v: 1,
                type: 'summary',
                tabId: 'zzz',
                replyTo: event.data.tabId,
                round: event.data.round,
                summary: { characterName: 'Other', uptimeMs: 7200000, traffic: null, heapMb: 512, stalls: null },
            });
        };
        pformancePanel.initialize();
        pformancePanel.show();
        const { text, json } = await saved();

        expect(json.leak.canary.rows[0].source).toBe('timers:interval');
        expect(json.leak.heap.trend.usedMb).toBe(80);
        expect(json.traffic.snapshot.writesByKey[0]).toMatchObject({ name: 'toolasha_init_client_data', bytes: 2048 });
        expect(json.traffic.snapshot.requestsByHost[0].name).toBe('api.github.com');
        expect(json.tabs.tabs.map((tab) => tab.tabId)).toContain('zzz');
        expect(json.tabs.reason).toBe(null);
        expect(text).toContain('zzz: up 2h 0m');
        for (const output of [text, JSON.stringify(json)]) {
            expect(output).not.toContain('SECRET');
            expect(output).not.toContain('0123456789abcdef');
            expect(output).not.toContain('Tester');
            expect(output).not.toContain('Other');
        }
    });

    test('says why when the heap is unreadable and the census cannot hear anyone', async () => {
        vi.stubGlobal('BroadcastChannel', undefined);
        settings.pformanceAttribution = true;
        pformancePanel.initialize();
        pformancePanel.show();
        const { json } = await saved();

        expect(json.leak.canary.reason).toContain('no canary yet');
        expect(json.leak.heap.reason).toContain('does not expose heap size');
        expect(json.tabs.reason).toContain('no BroadcastChannel');
    });

    test('a monitor with none of the optional methods still exports', async () => {
        window.Toolasha.Core.performanceMonitor = { ...monitor, timerCounters: undefined };
        settings.pformanceAttribution = true;
        pformancePanel.show();

        await expect(pformancePanel._exportReport('file')).resolves.not.toThrow();
        const json = JSON.parse(download.mock.calls.find((call) => call[0].endsWith('.json'))[1]);
        expect(json.timerCounters.reason).toContain('no timer counters');
    });
});
