import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTabCensus, buildTabSummary, TAB_CENSUS_CHANNEL } from './tab-census.js';

/** A loopback bus: every channel hears every other channel's posts, not its own. */
function makeBus() {
    const channels = [];
    return {
        channels,
        create(name) {
            const channel = {
                name,
                closed: false,
                onmessage: null,
                postMessage(data) {
                    for (const other of channels) {
                        if (other !== channel && !other.closed) other.onmessage?.({ data });
                    }
                },
                close() {
                    channel.closed = true;
                },
            };
            channels.push(channel);
            return channel;
        },
    };
}

const summary = (name) => ({ characterName: name, uptimeMs: 1000, traffic: null, heapMb: null, stalls: null });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createTabCensus', () => {
    test('lists own tab first and marked, then peers heard from', () => {
        const bus = makeBus();
        const a = createTabCensus({ getSummary: () => summary('A'), tabId: 'a', createChannel: bus.create });
        const b = createTabCensus({ getSummary: () => summary('B'), tabId: 'b', createChannel: bus.create });
        a.start();
        b.start();
        b.start();

        const tabs = a.getTabs();
        expect(tabs.map((t) => [t.tabId, t.self])).toEqual([
            ['a', true],
            ['b', false],
        ]);
        expect(tabs[1].summary.characterName).toBe('B');
        expect(bus.channels[0].name).toBe(TAB_CENSUS_CHANNEL);
        a.stop();
        b.stop();
    });

    test('own summary is read at list time, so a character switch shows at once', () => {
        const bus = makeBus();
        let name = 'First';
        const census = createTabCensus({ getSummary: () => summary(name), createChannel: bus.create });
        census.start();
        name = 'Second';
        expect(census.getTabs()[0].summary.characterName).toBe('Second');
        census.stop();
    });

    test('a tab that goes quiet drops out after the stale window', () => {
        const bus = makeBus();
        let clock = 1_000_000;
        const now = () => clock;
        const a = createTabCensus({ getSummary: () => summary('A'), tabId: 'a', createChannel: bus.create, now });
        const b = createTabCensus({ getSummary: () => summary('B'), tabId: 'b', createChannel: bus.create, now });
        a.start();
        b.start();
        expect(a.getTabs()).toHaveLength(2);

        clock += 29_000;
        expect(a.getTabs()).toHaveLength(2);
        clock += 2_000;
        expect(a.getTabs()).toHaveLength(1);
        b.stop();
        a.stop();
    });

    test('republishes on the interval and a fresh beat keeps a peer listed', () => {
        const bus = makeBus();
        let clock = 0;
        const now = () => clock;
        const a = createTabCensus({ getSummary: () => summary('A'), tabId: 'a', createChannel: bus.create, now });
        const b = createTabCensus({ getSummary: () => summary('B'), tabId: 'b', createChannel: bus.create, now });
        a.start();
        b.start();
        for (let i = 0; i < 6; i++) {
            clock += 10_000;
            vi.advanceTimersByTime(10_000);
        }
        expect(a.getTabs()).toHaveLength(2);
        a.stop();
        b.stop();
    });

    test('a goodbye removes the peer immediately', () => {
        const bus = makeBus();
        const a = createTabCensus({ getSummary: () => summary('A'), tabId: 'a', createChannel: bus.create });
        const b = createTabCensus({ getSummary: () => summary('B'), tabId: 'b', createChannel: bus.create });
        a.start();
        b.start();
        b.stop();
        expect(a.getTabs()).toHaveLength(1);
        a.stop();
    });

    test('stop clears the timer, closes the channel and forgets peers; start again works', () => {
        const bus = makeBus();
        const a = createTabCensus({ getSummary: () => summary('A'), tabId: 'a', createChannel: bus.create });
        const b = createTabCensus({ getSummary: () => summary('B'), tabId: 'b', createChannel: bus.create });
        a.start();
        b.start();
        a.stop();
        expect(a.isRunning()).toBe(false);
        expect(bus.channels[0].closed).toBe(true);
        expect(bus.channels[0].onmessage).toBe(null);
        expect(vi.getTimerCount()).toBe(1);
        expect(a.getTabs()).toHaveLength(1);
        a.stop();

        a.start();
        expect(a.getTabs()).toHaveLength(2);
        a.stop();
        b.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('ignores its own id, malformed messages and other versions', () => {
        const bus = makeBus();
        const a = createTabCensus({ getSummary: () => summary('A'), tabId: 'a', createChannel: bus.create });
        a.start();
        const hear = bus.channels[0].onmessage;
        hear({ data: { v: 1, type: 'summary', tabId: 'a', summary: summary('echo') } });
        hear({ data: { v: 2, type: 'summary', tabId: 'z', summary: summary('future') } });
        hear({ data: { v: 1, type: 'summary', tabId: 'y', summary: 'nope' } });
        hear({ data: null });
        expect(a.getTabs()).toHaveLength(1);
        a.stop();
    });

    test('without BroadcastChannel it is unsupported, starts nothing and still lists itself', () => {
        vi.stubGlobal('BroadcastChannel', undefined);
        const census = createTabCensus({ getSummary: () => summary('A') });
        census.start();
        expect(census.supported).toBe(false);
        expect(census.isRunning()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(census.getTabs()).toHaveLength(1);
        vi.unstubAllGlobals();
    });

    test('a channel that cannot be opened leaves it stopped', () => {
        const census = createTabCensus({
            getSummary: () => summary('A'),
            createChannel: () => {
                throw new Error('denied');
            },
        });
        census.start();
        expect(census.isRunning()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('buildTabSummary', () => {
    const traffic = () => ({ totals: {}, perHour: {} });

    test('reads the character at call time and tolerates a missing data manager', () => {
        const dm = {
            name: 'One',
            getCurrentCharacterId: () => 7,
            getCurrentCharacterName() {
                return this.name;
            },
        };
        expect(buildTabSummary({ dataManager: dm, monitor: null, getTraffic: traffic }).characterName).toBe('One');
        dm.name = 'Two';
        expect(buildTabSummary({ dataManager: dm, monitor: null, getTraffic: traffic })).toMatchObject({
            characterName: 'Two',
            characterId: 7,
        });
        expect(buildTabSummary({ dataManager: null, monitor: null, getTraffic: traffic }).characterName).toBe(null);
    });

    test('stalls are null unless the monitor is measuring', () => {
        const monitor = {
            enabled: false,
            getStallAttribution: () => ({ stalls: 3, totalMs: 900.4 }),
            getWorstStallMs: () => 400,
        };
        expect(buildTabSummary({ dataManager: null, monitor, getTraffic: traffic }).stalls).toBe(null);
        monitor.enabled = true;
        expect(buildTabSummary({ dataManager: null, monitor, getTraffic: traffic }).stalls).toEqual({
            count: 3,
            totalMs: 900,
            worstMs: 400,
        });
    });

    test('heap is in MB where readable and null where not', () => {
        const base = { dataManager: null, monitor: null, getTraffic: traffic };
        expect(buildTabSummary({ ...base, heapBytes: () => 104857600 }).heapMb).toBe(100);
        expect(buildTabSummary({ ...base, heapBytes: () => null }).heapMb).toBe(null);
        expect(buildTabSummary(base).heapMb).toBe(null);
    });
});
