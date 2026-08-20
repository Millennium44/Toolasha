/**
 * @vitest-environment happy-dom
 *
 * Telling the player about a newer release. The interesting failures are the
 * nags that should not happen: a dev build "behind" a release, a cache still
 * fresh being re-fetched, an equal version announced as news.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    settings: {},
    stored: {},
    writes: [],
    response: { status: 200, text: JSON.stringify({ tag_name: 'v3.17.0' }) },
    requests: [],
    version: '3.16.0',
    toasts: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => state.settings[key] ?? fallback,
        getSettingValue: (key, fallback) => state.settings[key] ?? fallback,
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, _store, fallback) => state.stored[key] ?? fallback,
        setJSON: async (key, value) => {
            state.writes.push(key);
            state.stored[key] = value;
        },
    },
}));
vi.mock('../sync/gist-client.js', () => ({
    httpRequest: async (options) => {
        state.requests.push(options.url);
        return state.response;
    },
}));
vi.mock('../../utils/script-version.js', () => ({ scriptVersion: () => state.version }));
vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        state.toasts.push({ message, options });
        return { element: null, dismiss: () => {} };
    },
}));

const { default: feature, updateCheck, compareVersions } = await import('./update-check.js');

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    state.settings = { updateCheck: true, updateCheckHours: 6 };
    state.stored = {};
    state.writes = [];
    state.requests = [];
    state.version = '3.16.0';
    state.toasts = [];
    state.response = { status: 200, text: JSON.stringify({ tag_name: 'v3.17.0' }) };
    updateCheck.cleanup();
});

/** Run initialize and let the startup delay elapse */
async function boot() {
    await feature.initialize();
    await vi.advanceTimersByTimeAsync(10 * 1000);
}

describe('version comparison', () => {
    test('orders numerically, not lexically', () => {
        expect(compareVersions('3.17.0', '3.9.0')).toBeGreaterThan(0);
        expect(compareVersions('3.16.0', '3.16.0')).toBe(0);
        expect(compareVersions('3.16.0', '3.999.0')).toBeLessThan(0);
        expect(compareVersions('4.0', '3.99.99')).toBeGreaterThan(0);
    });
});

describe('the check', () => {
    test('a newer release is announced, and the answer written down', async () => {
        await boot();

        expect(state.requests).toHaveLength(1);
        expect(state.toasts).toHaveLength(1);
        expect(state.toasts[0].message).toContain('v3.17.0');
        expect(state.toasts[0].message).toContain('v3.16.0');
        expect(state.stored.updateCheckState.latestVersion).toBe('3.17.0');
    });

    test('the setting off means no request and no toast', async () => {
        state.settings.updateCheck = false;

        await boot();

        expect(state.requests).toEqual([]);
        expect(state.toasts).toEqual([]);
    });

    test('a fresh cache is trusted without a request, and still announces', async () => {
        state.stored.updateCheckState = { checkedAt: Date.now() - 60 * 60 * 1000, latestVersion: '3.17.0' };

        await boot();

        expect(state.requests).toEqual([]);
        expect(state.toasts).toHaveLength(1);
    });

    test('a stale cache goes back to the network, on the configured interval', async () => {
        state.settings.updateCheckHours = 2;
        state.stored.updateCheckState = { checkedAt: Date.now() - 3 * 60 * 60 * 1000, latestVersion: '3.16.0' };

        await boot();

        expect(state.requests).toHaveLength(1);
    });

    test('being current is not news', async () => {
        state.response = { status: 200, text: JSON.stringify({ tag_name: 'v3.16.0' }) };

        await boot();

        expect(state.toasts).toEqual([]);
    });

    test('a dev build far ahead of every release stays silent', async () => {
        state.version = '3.999.0';

        await boot();

        expect(state.toasts).toEqual([]);
    });

    test('outside the userscript sandbox there is nothing to compare, so nothing happens', async () => {
        state.version = null;

        await boot();

        expect(state.requests).toEqual([]);
        expect(state.toasts).toEqual([]);
    });

    test('a failed request neither announces nor caches', async () => {
        state.response = { status: 403, text: '{"message":"rate limited"}' };

        await boot();

        expect(state.toasts).toEqual([]);
        expect(state.writes).toEqual([]);
    });
});
