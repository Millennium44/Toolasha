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
    /** Two tabs on one bus, both joined; the first one polls */
    const pair = () => {
        const bus = makeBus();
        const a = createTabCensus({ getSummary: () => summary('A'), tabId: 'a', createChannel: bus.create });
        const b = createTabCensus({ getSummary: () => summary('B'), tabId: 'b', createChannel: bus.create });
        a.start();
        b.start();
        return { bus, a, b };
    };

    test('a tab that never polls still answers a poll, with no timer of its own', () => {
        const { bus, a, b } = pair();
        expect(b.isPolling()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        a.startPolling();

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

    test('nobody is listed until a poll is sent', () => {
        const { a, b } = pair();
        expect(a.getTabs()).toHaveLength(1);
        b.stop();
        a.stop();
    });

    test('a tab only listens for replies to its own polls', () => {
        const bus = makeBus();
        const [a, b, c] = ['a', 'b', 'c'].map((id) => {
            const census = createTabCensus({ getSummary: () => summary(id), tabId: id, createChannel: bus.create });
            census.start();
            return census;
        });
        b.startPolling();
        expect(a.getTabs()).toHaveLength(1);
        expect(b.getTabs()).toHaveLength(3);
        a.stop();
        b.stop();
        c.stop();
    });

    test('own summary is read at list time, so a character switch shows at once', () => {
        const bus = makeBus();
        let name = 'First';
        const census = createTabCensus({ getSummary: () => summary(name), createChannel: bus.create });
        census.start();
        census.startPolling();
        name = 'Second';
        expect(census.getTabs()[0].summary.characterName).toBe('Second');
        census.stop();
    });

    test('a reply that arrives a poll late is still listed; two missed polls drop the tab', () => {
        const bus = makeBus();
        const a = createTabCensus({ getSummary: () => summary('A'), tabId: 'a', createChannel: bus.create });
        a.start();
        a.startPolling();
        const hear = bus.channels[0].onmessage;
        const reply = (round) =>
            hear({ data: { v: 1, type: 'summary', tabId: 'slow', replyTo: 'a', round, summary: summary('Slow') } });

        // Round 1 went out; the hidden tab answers only after round 2 is already out
        a.pollNow();
        reply(1);
        expect(a.getTabs().map((t) => t.tabId)).toContain('slow');

        // Round 3 goes out with no answer to 2: round 1 is now two behind
        a.pollNow();
        expect(a.getTabs().map((t) => t.tabId)).not.toContain('slow');
        a.stop();
    });

    test('a tab that answers every poll stays listed over time', () => {
        const { a, b } = pair();
        a.startPolling();
        for (let i = 0; i < 6; i++) vi.advanceTimersByTime(10_000);
        expect(a.getTabs()).toHaveLength(2);
        a.stop();
        b.stop();
    });

    test('a goodbye removes the peer immediately', () => {
        const { a, b } = pair();
        a.startPolling();
        b.stop();
        expect(a.getTabs()).toHaveLength(1);
        a.stop();
    });

    test('pagehide says goodbye, and stop removes the listener', () => {
        const target = new EventTarget();
        vi.stubGlobal('window', target);
        const bus = makeBus();
        const a = createTabCensus({ getSummary: () => summary('A'), tabId: 'a', createChannel: bus.create });
        a.start();
        const b = createTabCensus({ getSummary: () => summary('B'), tabId: 'b', createChannel: bus.create });
        b.start();
        a.startPolling();
        expect(a.getTabs()).toHaveLength(2);

        target.dispatchEvent(new Event('pagehide'));
        expect(a.getTabs()).toHaveLength(1);

        a.stop();
        b.stop();
        vi.unstubAllGlobals();
    });

    test('stop clears the poll timer, closes the channel and forgets peers; start again works', () => {
        const { bus, a, b } = pair();
        a.startPolling();
        expect(vi.getTimerCount()).toBe(1);
        a.stop();
        expect(a.isRunning()).toBe(false);
        expect(a.isPolling()).toBe(false);
        expect(bus.channels[0].closed).toBe(true);
        expect(bus.channels[0].onmessage).toBe(null);
        expect(vi.getTimerCount()).toBe(0);
        a.stop();

        a.start();
        a.startPolling();
        expect(a.getTabs()).toHaveLength(2);
        a.stop();
        b.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('stopPolling drops the timer and the list but keeps answering', () => {
        const { a, b } = pair();
        b.startPolling();
        b.stopPolling();
        expect(vi.getTimerCount()).toBe(0);
        expect(b.getTabs()).toHaveLength(1);
        a.startPolling();
        expect(a.getTabs()).toHaveLength(2);
        a.stop();
        b.stop();
    });

    test('ignores its own id, malformed messages and other versions', () => {
        const bus = makeBus();
        const a = createTabCensus({ getSummary: () => summary('A'), tabId: 'a', createChannel: bus.create });
        a.start();
        a.startPolling();
        const hear = bus.channels[0].onmessage;
        hear({ data: { v: 1, type: 'summary', tabId: 'a', replyTo: 'a', round: 1, summary: summary('echo') } });
        hear({ data: { v: 2, type: 'summary', tabId: 'z', replyTo: 'a', round: 1, summary: summary('future') } });
        hear({ data: { v: 1, type: 'summary', tabId: 'y', replyTo: 'a', round: 1, summary: 'nope' } });
        hear({ data: { v: 1, type: 'summary', tabId: 'x', replyTo: 'a', summary: summary('no round') } });
        hear({ data: null });
        expect(a.getTabs()).toHaveLength(1);
        a.stop();
    });

    test('without BroadcastChannel it is unsupported, starts nothing and still lists itself', () => {
        vi.stubGlobal('BroadcastChannel', undefined);
        const census = createTabCensus({ getSummary: () => summary('A') });
        census.start();
        census.startPolling();
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
