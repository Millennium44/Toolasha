import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    gmSetValue,
    gmGetValue,
    gmDeleteValue,
    gmRequest,
    gmRequestAvailable,
    getGmTrafficSnapshot,
    getGmTrafficSummary,
    resetGmTraffic,
} from './gm-traffic.js';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    resetGmTraffic();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('gmSetValue', () => {
    test('passes key and value through and returns what GM_setValue returns', () => {
        const stub = vi.fn(() => 'ret');
        vi.stubGlobal('GM_setValue', stub);
        expect(gmSetValue('k', 'abc')).toBe('ret');
        expect(stub).toHaveBeenCalledWith('k', 'abc');
    });

    test('rethrows what GM_setValue throws and counts no bytes for it', () => {
        const boom = new Error('quota');
        vi.stubGlobal('GM_setValue', () => {
            throw boom;
        });
        expect(() => gmSetValue('k', 'abcdef')).toThrow(boom);
        const snap = getGmTrafficSnapshot();
        expect(snap.totals.writeBytes).toBe(0);
        expect(snap.totals.writeCalls).toBe(0);
        expect(snap.writeErrors).toBe(1);
        expect(snap.writesByKey[0]).toMatchObject({ name: 'k', errors: 1, bytes: 0 });
    });

    test('sizes string values by length and sorts keys by bytes', () => {
        vi.stubGlobal('GM_setValue', vi.fn());
        gmSetValue('small', 'ab');
        gmSetValue('big', 'x'.repeat(1000));
        gmSetValue('big', 'x'.repeat(500));
        const snap = getGmTrafficSnapshot();
        expect(snap.totals).toMatchObject({ writeCalls: 3, writeBytes: 1502 });
        expect(snap.writesByKey.map((row) => row.name)).toEqual(['big', 'small']);
        expect(snap.writesByKey[0]).toMatchObject({ calls: 2, bytes: 1500 });
    });

    test('a non-string value is counted as a call but not serialized to be sized', () => {
        vi.stubGlobal('GM_setValue', vi.fn());
        const value = { toJSON: vi.fn(() => 'x') };
        gmSetValue('obj', value);
        expect(value.toJSON).not.toHaveBeenCalled();
        const snap = getGmTrafficSnapshot();
        expect(snap.unsizedWrites).toBe(1);
        expect(snap.totals).toMatchObject({ writeCalls: 1, writeBytes: 0 });
    });

    test('keys past the cap fold into one overflow row', () => {
        vi.stubGlobal('GM_setValue', vi.fn());
        for (let i = 0; i < 80; i++) gmSetValue(`key${i}`, 'a');
        const names = getGmTrafficSnapshot().writesByKey.map((row) => row.name);
        expect(names.length).toBe(65);
        expect(names).toContain('(other)');
    });
});

describe('gmGetValue', () => {
    test('returns the value, counts calls by key and sizes string results', () => {
        vi.stubGlobal(
            'GM_getValue',
            vi.fn((key, fallback) => (key === 'hit' ? '12345' : fallback))
        );
        expect(gmGetValue('hit', null)).toBe('12345');
        expect(gmGetValue('miss', null)).toBe(null);
        const snap = getGmTrafficSnapshot();
        expect(snap.totals).toMatchObject({ readCalls: 2, readBytes: 5 });
        expect(snap.readsByKey.find((row) => row.name === 'hit')).toMatchObject({ calls: 1, bytes: 5 });
    });

    test('lets a throw through uncounted', () => {
        vi.stubGlobal('GM_getValue', () => {
            throw new Error('no');
        });
        expect(() => gmGetValue('k', null)).toThrow('no');
        expect(getGmTrafficSnapshot().totals.readCalls).toBe(0);
    });
});

describe('gmRequest', () => {
    test('is unavailable without a GM request function and throws if called', () => {
        expect(gmRequestAvailable()).toBe(false);
        expect(() => gmRequest({ url: 'https://a.test/x' })).toThrow();
    });

    test('counts by host, sizes the response, and still runs the caller handlers', () => {
        const handle = { abort: vi.fn() };
        let sent;
        vi.stubGlobal('GM_xmlhttpRequest', (details) => {
            sent = details;
            return handle;
        });
        const onload = vi.fn(() => 'done');
        const onerror = vi.fn();

        expect(gmRequestAvailable()).toBe(true);
        expect(gmRequest({ method: 'GET', url: 'https://api.github.com/gists', onload, onerror })).toBe(handle);
        expect(sent.method).toBe('GET');

        const response = { responseText: 'y'.repeat(2048), status: 200 };
        expect(sent.onload(response)).toBe('done');
        expect(onload).toHaveBeenCalledWith(response);
        sent.onerror({ error: 'x' });
        expect(onerror).toHaveBeenCalled();

        const snap = getGmTrafficSnapshot();
        expect(snap.totals).toMatchObject({ requestCalls: 1, responseBytes: 2048 });
        expect(snap.requestsByHost[0]).toMatchObject({ name: 'api.github.com', calls: 1, bytes: 2048, errors: 1 });
    });

    test('falls back to GM.xmlHttpRequest and works with no handlers supplied', () => {
        const fn = vi.fn();
        vi.stubGlobal('GM', { xmlHttpRequest: fn });
        gmRequest({ url: 'not a url' });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(getGmTrafficSnapshot().requestsByHost[0].name).toBe('(unparsed)');
        expect(() => fn.mock.calls[0][0].onload({ responseText: 'abc' })).not.toThrow();
    });
});

describe('rates', () => {
    test('per-hour rate extrapolates the observed window', () => {
        vi.stubGlobal('GM_setValue', vi.fn());
        gmSetValue('k', 'x'.repeat(1000));
        vi.setSystemTime(Date.now() + 10 * 60000);
        const snap = getGmTrafficSnapshot();
        expect(snap.rateWindowMs).toBe(10 * 60000);
        expect(snap.perHour.writeBytes).toBe(6000);
        expect(snap.perHour.writeCalls).toBe(6);
    });

    test('writes older than an hour leave the rate but stay in the totals', () => {
        vi.stubGlobal('GM_setValue', vi.fn());
        gmSetValue('k', 'x'.repeat(1000));
        vi.setSystemTime(Date.now() + 61 * 60000);
        gmSetValue('k', 'x'.repeat(100));
        const snap = getGmTrafficSnapshot();
        expect(snap.totals.writeBytes).toBe(1100);
        expect(snap.perHour.writeBytes).toBe(100);
        expect(snap.rateWindowMs).toBe(60 * 60000);
    });

    test('summary carries totals and rates but no per-key rows', () => {
        const summary = getGmTrafficSummary();
        expect(Object.keys(summary).sort()).toEqual(['perHour', 'rateWindowMs', 'startedAt', 'totals']);
    });
});

describe('gmDeleteValue', () => {
    test('passes the key through, counts a delete and rethrows a failure uncounted', () => {
        const stub = vi.fn(() => 'gone');
        vi.stubGlobal('GM_deleteValue', stub);
        expect(gmDeleteValue('k')).toBe('gone');
        expect(stub).toHaveBeenCalledWith('k');
        expect(getGmTrafficSnapshot().totals.deleteCalls).toBe(1);

        vi.stubGlobal('GM_deleteValue', () => {
            throw new Error('no');
        });
        expect(() => gmDeleteValue('k')).toThrow('no');
        expect(getGmTrafficSnapshot().totals.deleteCalls).toBe(1);
    });
});
