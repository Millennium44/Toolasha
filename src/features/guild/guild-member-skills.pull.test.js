/** @vitest-environment happy-dom */

/**
 * `guildMemberSkills_<guild>` takes a sync pull under a running page: the key is live-safe, a pull refreshes the
 * in-memory captures, and a save after a pull keeps what the pull brought.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const db = vi.hoisted(() => ({ stores: new Map(), failReads: 0 }));

vi.mock('../../core/storage.js', () => {
    const storeFor = (name) => {
        if (!db.stores.has(name)) db.stores.set(name, new Map());
        return db.stores.get(name);
    };
    return {
        default: {
            listStores: () => Promise.resolve(Array.from(db.stores.keys())),
            getAll: (name) => Promise.resolve(Object.fromEntries(storeFor(name))),
            beginRestore: vi.fn(() => Promise.resolve()),
            finishRestore: vi.fn(),
            endRestore: () => Promise.resolve(),
            putAll: (name, entries) => {
                for (const [key, value] of Object.entries(entries || {})) storeFor(name).set(key, value);
                return Promise.resolve(Object.keys(entries || {}).length);
            },
            get: async (key, name, fallback) => (storeFor(name).has(key) ? storeFor(name).get(key) : fallback),
            tryGet: async (key, name) =>
                db.failReads-- > 0
                    ? null
                    : storeFor(name).has(key)
                      ? { found: true, value: structuredClone(storeFor(name).get(key)) }
                      : { found: false, value: null },
            set: async (key, value, name) => {
                storeFor(name).set(key, structuredClone(value));
                return true;
            },
        },
    };
});
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 30404 } }));
vi.mock('./guild-xp-tracker.js', () => ({ guildXPTracker: { getMemberList: () => [] } }));
vi.mock('./guild-loadout-capture.js', () => ({ default: { seen: () => [], onCaptured: () => () => {} } }));

const { guildMemberSkills, memberSkillsStorageKey } = await import('./guild-member-skills.js');
await import('../inventory/custom-tabs/custom-tabs-data.js');
const { isLiveSafeKey, announceSyncPullApplied } = await import('../../utils/sync-merge-registry.js');
const { importEverything } = await import('../../utils/full-backup.js');

const GUILD = 'Milky Way';
const KEY = memberSkillsStorageKey(GUILD);
const capture = (name, level, at) => ({ name, characterId: `${name}-id`, skills: { '/skills/alchemy': level }, at });
const stored = () => db.stores.get('guildHistory')?.get(KEY);

beforeEach(async () => {
    db.stores.clear();
    guildMemberSkills.forget();
    guildMemberSkills.initialized = false;
    db.stores.set('guildHistory', new Map([[KEY, { ada: capture('Ada', 50, 1000) }]]));
    await guildMemberSkills.initialize(GUILD);
});

afterEach(() => {
    guildMemberSkills.cleanup();
    guildMemberSkills.forget();
});

describe('guild member skills and a sync pull', () => {
    test('both keys resolve as live-safe in the forms the game produces', () => {
        expect(isLiveSafeKey('guildHistory', 'guildMemberSkills_default')).toBe(true);
        expect(isLiveSafeKey('guildHistory', KEY)).toBe(true);
        expect(isLiveSafeKey('settings', '603281_inventoryTabs_config')).toBe(true);
    });

    test('a restore with liveSafeMerge latches neither key', async () => {
        const payload = {
            formatVersion: 1,
            stores: {
                guildHistory: { guildMemberSkills_default: { ada: capture('Ada', 60, 2000) } },
                settings: { '603281_inventoryTabs_config': { version: 1, tabs: [], selectedTabId: null } },
            },
        };
        const result = await importEverything(payload, { liveSafeMerge: true });
        expect(result.latched).toBe(0);
    });

    test('a pull refreshes the in-memory captures and tells the listeners', async () => {
        expect(guildMemberSkills.captures.ada.skills['/skills/alchemy']).toBe(50);
        const told = vi.fn();
        guildMemberSkills.onChanged(told);

        db.stores.get('guildHistory').set(KEY, {
            ada: capture('Ada', 70, 3000),
            bo: capture('Bo', 40, 3000),
        });
        announceSyncPullApplied({ guildHistory: [KEY] });
        await vi.waitFor(() => expect(guildMemberSkills.captures.bo).toBeTruthy());

        expect(guildMemberSkills.captures.ada.skills['/skills/alchemy']).toBe(70);
        expect(told).toHaveBeenCalled();
    });

    test('a save after a pull keeps the pulled capture over the older one in memory', async () => {
        // The pull is in storage but the refresh has not run: memory still holds the old capture
        db.stores.get('guildHistory').set(KEY, { ada: capture('Ada', 70, 3000) });
        guildMemberSkills._onProfile({
            profile: {
                sharableCharacter: { id: 'Bo-id', name: 'Bo' },
                characterSkills: [{ skillHrid: '/skills/alchemy', level: 30, characterID: 'Bo-id' }],
            },
        });
        await vi.waitFor(() => expect(stored().bo).toBeTruthy());

        expect(stored().ada.skills['/skills/alchemy']).toBe(70);
    });

    test('a pull of another guild leaves the captures alone', async () => {
        const told = vi.fn();
        guildMemberSkills.onChanged(told);
        db.stores.get('guildHistory').set(KEY, { ada: capture('Ada', 99, 9000) });
        announceSyncPullApplied({ guildHistory: ['guildMemberSkills_Other'] });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(guildMemberSkills.captures.ada.skills['/skills/alchemy']).toBe(50);
        expect(told).not.toHaveBeenCalled();
    });

    test('a rename save that lands before the pull is adopted keeps the members the pull brought', async () => {
        guildMemberSkills._onProfile({
            profile: {
                sharableCharacter: { id: 'Ada-id', name: 'Adalina' },
                characterSkills: [{ skillHrid: '/skills/alchemy', level: 55, characterID: 'Ada-id' }],
            },
        });
        await vi.waitFor(() => expect(stored().adalina).toBeTruthy());
        // The pull brings a new member; memory has not adopted it yet when the rename (Adalina -> Ada) is saved
        db.stores.get('guildHistory').set(KEY, { ...stored(), bo: capture('Bo', 40, Date.now() + 1) });
        guildMemberSkills._onProfile({
            profile: {
                sharableCharacter: { id: 'Ada-id', name: 'Ada' },
                characterSkills: [{ skillHrid: '/skills/alchemy', level: 60, characterID: 'Ada-id' }],
            },
        });
        await vi.waitFor(() => expect(stored().ada).toBeTruthy());

        expect(stored().bo).toBeTruthy();
        expect(stored().adalina).toBeUndefined();
    });

    test('a redo mark survives a save and a pull, without moving the capture date', async () => {
        guildMemberSkills.redoMember('Ada', 5000);
        expect(guildMemberSkills.captures.ada.at).toBe(1000);
        await guildMemberSkills.record.save();

        // Storage still has the unmarked capture from before: the fold must not drop the mark
        db.stores.get('guildHistory').set(KEY, { ada: capture('Ada', 50, 1000) });
        await guildMemberSkills.record.load();

        expect(guildMemberSkills.captures.ada.redoRequestedAt).toBe(5000);
        expect(guildMemberSkills.captures.ada.at).toBe(1000);
        expect(guildMemberSkills.progress(6000).logged).toBe(0);
    });

    test('a failed first read is retried and the retry adopts the pulled captures', async () => {
        db.stores.get('guildHistory').set(KEY, { ada: capture('Ada', 70, 3000) });
        db.failReads = 1;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        announceSyncPullApplied({ guildHistory: [KEY] });
        await vi.waitFor(() => expect(guildMemberSkills.captures.ada.skills['/skills/alchemy']).toBe(70), {
            timeout: 3000,
        });
        warn.mockRestore();
        db.failReads = 0;
    });
});
