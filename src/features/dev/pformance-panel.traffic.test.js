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
vi.mock('../../utils/csv-export.js', () => ({ downloadFile: () => {} }));

const { default: pformancePanel } = await import('./pformance-panel.js');
const { getSettingDefinition } = await import('../../core/settings-schema.js');
const { gmSetValue, gmRequest, resetGmTraffic } = await import('../../utils/gm-traffic.js');

const onScreen = () => document.getElementById('toolasha-pformance-panel');
const text = () => onScreen()?.textContent || '';

const monitor = {
    enabled: false,
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
