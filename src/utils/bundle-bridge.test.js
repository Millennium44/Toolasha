/**
 * Tests for the bundle bridge.
 *
 * The one property every accessor must hold: with no namespace to read — no
 * window at all, or a window with no Toolasha on it — it answers null instead
 * of throwing. That is the contract that lets call sites run in tests, in
 * workers, and before the owning bundle has loaded.
 */
import { describe, test, expect, afterEach } from 'vitest';

import * as bridge from './bundle-bridge.js';

const accessors = Object.entries(bridge).filter(([, value]) => typeof value === 'function');

afterEach(() => {
    delete globalThis.window;
});

describe('bundle-bridge', () => {
    test('exports only functions', () => {
        expect(accessors.length).toBe(Object.keys(bridge).length);
        expect(accessors.length).toBeGreaterThan(0);
    });

    test.each(accessors.map(([name]) => name))('%s() is null with no window', (name) => {
        delete globalThis.window;
        expect(bridge[name]()).toBeNull();
    });

    test.each(accessors.map(([name]) => name))('%s() is null with a window but no namespace', (name) => {
        globalThis.window = {};
        expect(bridge[name]()).toBeNull();
    });

    test.each(accessors.map(([name]) => name))('%s() is null with a namespace missing its target', (name) => {
        globalThis.window = { Toolasha: {} };
        if (name === 'toolashaRoot') {
            expect(bridge.toolashaRoot()).toEqual({});
        } else {
            expect(bridge[name]()).toBeNull();
        }
    });

    test('an accessor hands back the live module, not a copy', () => {
        const loadout = { getAllSnapshots: () => [] };
        globalThis.window = { Toolasha: { Combat: { loadoutSnapshot: loadout } } };
        expect(bridge.loadoutSnapshot()).toBe(loadout);
    });
});

describe('guildXpTracker() reads the live tracker, not its registration record', () => {
    test('the Combat key it reads is bound to the tracker singleton', async () => {
        const { readFileSync } = await import('node:fs');
        const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
        const bridgeSource = read('./bundle-bridge.js');
        const key = bridgeSource.match(/guildXpTracker\(\)\s*\{[\s\S]*?Combat\?\.(\w+)/)[1];
        const combat = read('../libraries/combat.js');
        const importLine = combat.split('\n').find((line) => line.includes("'../features/guild/guild-xp-tracker.js'"));
        // The default export is { name, initialize, cleanup, … } with none of getMemberMeta / getMemberList /
        // getCurrentWeekStartAt / onMetaChanged; only the named singleton has them
        expect(importLine).toContain(`{ guildXPTracker as ${key} }`);

        const { guildXPTracker } = await import('../features/guild/guild-xp-tracker.js');
        for (const method of ['getMemberMeta', 'getMemberList', 'getCurrentWeekStartAt', 'onMetaChanged']) {
            expect(typeof guildXPTracker[method]).toBe('function');
        }
    });
});
