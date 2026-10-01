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
    pformancePanel.disable();
    document.body.replaceChildren();
    delete window.Toolasha;
    vi.unstubAllGlobals();
});

describe('Tampermonkey traffic and all-tabs sections', () => {
    test('absent while the extras are off, and no channel is opened', () => {
        pformancePanel.initialize();
        pformancePanel.show();
        expect(text()).not.toContain('Tampermonkey traffic');
        expect(text()).not.toContain('All tabs');
        expect(FakeChannel.all).toHaveLength(0);
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

    test('publishes while the panel is closed, hears another tab, and stops on disable', () => {
        settings.pformanceAttribution = true;
        pformancePanel.initialize();
        expect(FakeChannel.all).toHaveLength(1);

        const other = new FakeChannel('toolasha-tab-census');
        other.postMessage({
            v: 1,
            type: 'summary',
            tabId: 'zzz',
            summary: { characterName: 'Other', uptimeMs: 7200000, traffic: null, heapMb: 512, stalls: null },
        });
        pformancePanel.show();
        expect(text()).toContain('zzz — Other, up 2h 0m');
        expect(text()).toContain('heap 512MB');

        pformancePanel.disable();
        expect(FakeChannel.all[0].closed).toBe(true);
    });

    test('toggling the extras button starts and stops publishing', () => {
        pformancePanel.initialize();
        pformancePanel.show();
        const toggle = [...onScreen().querySelectorAll('button')].find((b) => b.textContent === '◎');
        toggle.click();
        expect(FakeChannel.all).toHaveLength(1);
        expect(text()).toContain('All tabs');
        toggle.click();
        expect(FakeChannel.all[0].closed).toBe(true);
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
