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
