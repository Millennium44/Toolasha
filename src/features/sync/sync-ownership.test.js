import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    SYNCED_STORES,
    FOREIGN_STORES,
    KEY_FILTERED_STORES,
    OWNED_KEY_PREFIXES,
    isSyncedStore,
    ownsKey,
    partitionOwnedKeys,
} from './sync-ownership.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', '..');

describe('the declared store list', () => {
    test('every store the script creates is either synced or declared foreign', () => {
        // The failure this catches: someone adds an object store in storage.js,
        // nothing here changes, and the store silently never syncs — or, before
        // the declared list existed, silently did. Either way the decision was
        // never made. Making this test fail is how it gets made.
        const storage = readFileSync(join(srcRoot, 'core', 'storage.js'), 'utf8');
        const created = new Set();
        for (const match of storage.matchAll(/createObjectStore\(\s*(['"])([^'"]+)\1\s*\)/g)) created.add(match[2]);
        // The upstream-shared stores are created from a list, not one call each
        for (const match of storage.matchAll(/for \(const shared of \[([^\]]+)\]\)/g)) {
            for (const name of match[1].matchAll(/['"]([^'"]+)['"]/g)) created.add(name[1]);
        }

        expect(created.size).toBeGreaterThan(10);
        const declared = new Set([...SYNCED_STORES, ...FOREIGN_STORES]);
        expect([...created].filter((name) => !declared.has(name))).toEqual([]);
    });

    test('no store is claimed and disclaimed at once', () => {
        expect(SYNCED_STORES.filter((name) => FOREIGN_STORES.includes(name))).toEqual([]);
    });

    test("another script's store is not synced", () => {
        expect(isSyncedStore('openableAnalytics')).toBe(false);
        expect(isSyncedStore('settings')).toBe(true);
    });

    test('a store nothing has ever heard of is not synced', () => {
        expect(isSyncedStore('someOtherScriptsStore')).toBe(false);
    });
});

describe('ownsKey', () => {
    test('a store of ours carries everything in it, because everything in it is ours', () => {
        expect(KEY_FILTERED_STORES).not.toContain('guildHistory');
        expect(ownsKey('guildHistory', 'anything at all')).toBe(true);
    });

    test('a shared store is read key by key', () => {
        expect(ownsKey('settings', 'panelGeometry')).toBe(true);
        expect(ownsKey('settings', 'someOtherScriptsRecord')).toBe(false);
    });

    test('a registered base covers its per-character forms', () => {
        expect(ownsKey('settings', 'taskCapProtection')).toBe(true);
        expect(ownsKey('settings', 'taskCapProtection_12345')).toBe(true);
    });

    test('a character-id-leading key is matched by shape', () => {
        expect(ownsKey('settings', '12345_bulkSell_lastTab')).toBe(true);
        expect(ownsKey('settings', 'default_inventoryTabs_config')).toBe(true);
        expect(ownsKey('settings', '12345_someOtherScriptsThing')).toBe(false);
    });

    test('a key in a store this script does not own is not ours either', () => {
        expect(ownsKey('openableAnalytics', 'panelGeometry')).toBe(false);
    });

    test('device-local keys are still ours', () => {
        // LOCAL_ONLY_KEY_PREFIXES keeps these off the wire; this list is only
        // about whose they are, and treating them as foreign here would mean a
        // pull stopped clearing them from an older build's payload
        expect(ownsKey('settings', 'toolasha_local_chatHistory_1')).toBe(true);
        expect(ownsKey('settings', 'Toolasha_marketAPI_json')).toBe(true);
    });
});

describe('partitionOwnedKeys', () => {
    test('hands back the same object when nothing is foreign', () => {
        const entries = { panelGeometry: 1, panelSizeMemory: 2 };
        const result = partitionOwnedKeys('settings', entries);
        expect(result.owned).toBe(entries);
        expect(result.foreignKeys).toBe(0);
    });

    test('weighs what it leaves behind without naming it', () => {
        const entries = { panelGeometry: { a: 1 }, someoneElsesBigRecord: 'x'.repeat(1000) };
        const result = partitionOwnedKeys('settings', entries);
        expect(Object.keys(result.owned)).toEqual(['panelGeometry']);
        expect(result.foreignKeys).toBe(1);
        expect(result.foreignBytes).toBeGreaterThan(1000);
    });

    test('a value that cannot be serialized does not fail the push', () => {
        const cycle = {};
        cycle.self = cycle;
        const result = partitionOwnedKeys('settings', { someoneElses: cycle });
        expect(result.foreignKeys).toBe(1);
        expect(Number.isFinite(result.foreignBytes)).toBe(true);
    });

    test('a store of ours is not filtered at all', () => {
        const entries = { whatever: 1 };
        expect(partitionOwnedKeys('xpHistory', entries).owned).toBe(entries);
    });
});

describe('the prefix list itself', () => {
    test('no prefix is empty, which would claim the whole store', () => {
        expect(OWNED_KEY_PREFIXES.filter((prefix) => !prefix)).toEqual([]);
    });

    test('no prefix is listed twice', () => {
        const seen = OWNED_KEY_PREFIXES.filter((prefix, index) => OWNED_KEY_PREFIXES.indexOf(prefix) !== index);
        expect(seen).toEqual([]);
    });

    test('no prefix is swallowed by a shorter one', () => {
        // Harmless at runtime, but it means one of the two rows is a lie about
        // what is registered, and the shorter one may be broader than intended
        const redundant = OWNED_KEY_PREFIXES.filter((prefix) =>
            OWNED_KEY_PREFIXES.some((other) => other !== prefix && prefix.startsWith(other))
        );
        expect(redundant).toEqual([]);
    });
});
