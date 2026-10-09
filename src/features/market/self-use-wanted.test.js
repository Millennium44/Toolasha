/** @vitest-environment happy-dom */
/**
 * The self-use keep list: per character, persisted whole in the settings store
 * as `selfUseWanted_<characterId>`, cached for the tooltip's synchronous reads,
 * and never written over another character's list when a switch lands inside
 * a read.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    charId: 'main',
    stored: {},
    writes: [],
    /** Fired once per read, after the value is in hand — lets a test land a switch inside one */
    onRead: null,
    itemDetailMap: {},
    /** `storage.onWrite` listeners, to announce another tab's write through */
    writeListeners: new Set(),
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, _store, fallback) => {
            const value = key in state.stored ? state.stored[key] : fallback;
            state.onRead?.();
            // A held read answers with what was stored when it started, once the test releases it
            if (state.holdReads) return new Promise((resolve) => state.heldReads.push(() => resolve(value)));
            return value;
        },
        setJSON: async (key, value, store) => {
            state.writes.push({ key, store });
            state.stored[key] = value;
        },
        // One read-fold-write transaction over what is stored, the way core/storage.js runs it
        update: async (key, mutate, store) => {
            const found = key in state.stored;
            const current = state.stored[key];
            state.onRead?.();
            const next = mutate(current, found);
            if (next === undefined) return { written: false, value: current };
            state.writes.push({ key, store });
            state.stored[key] = next;
            return { written: true, value: next };
        },
        onWrite: (listener) => {
            state.writeListeners.add(listener);
            return () => state.writeListeners.delete(listener);
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.charId,
        getInitClientData: () => ({ itemDetailMap: state.itemDetailMap }),
    },
}));

const { default: selfUseWanted, STORAGE_KEY_PREFIX } = await import('./self-use-wanted.js');
const { ownsKey } = await import('../sync/sync-ownership.js');

beforeEach(() => {
    state.charId = 'main';
    state.stored = {};
    state.writes = [];
    state.onRead = null;
    state.itemDetailMap = {};
    selfUseWanted._reset();
    state.writeListeners = new Set();
    state.holdReads = false;
    state.heldReads = [];
});

/** Another tab committed `value` under `key` and announced it */
const otherTabWrites = (key, value, storeName = 'settings') => {
    state.stored[key] = value;
    for (const listener of state.writeListeners) listener({ storeName, keys: [key], origin: 'remote' });
};
const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('another tab', () => {
    test('two writes heard before either re-read answers: the later read wins whatever order they land', async () => {
        await selfUseWanted.load();
        state.holdReads = true;
        otherTabWrites('selfUseWanted_main', ['/items/frenzy']);
        otherTabWrites('selfUseWanted_main', ['/items/frenzy', '/items/puncture']);
        const [older, newer] = state.heldReads;

        older();
        await settle();
        newer();
        await settle();
        expect(selfUseWanted.getCached()).toEqual(['/items/frenzy', '/items/puncture']);
    });

    test('a later read that lands first is not overwritten by the earlier one', async () => {
        await selfUseWanted.load();
        state.holdReads = true;
        otherTabWrites('selfUseWanted_main', ['/items/frenzy']);
        otherTabWrites('selfUseWanted_main', ['/items/frenzy', '/items/puncture']);
        const [older, newer] = state.heldReads;

        newer();
        await settle();
        older();
        await settle();
        expect(selfUseWanted.getCached()).toEqual(['/items/frenzy', '/items/puncture']);
    });

    test("this tab's own change beats a re-read that started before it, and a fresh read follows", async () => {
        await selfUseWanted.load();
        state.holdReads = true;
        otherTabWrites('selfUseWanted_main', ['/items/frenzy']);
        const [stale] = state.heldReads;

        await selfUseWanted.setKept('/items/puncture', true);
        expect(selfUseWanted.getCached()).toEqual(['/items/frenzy', '/items/puncture']);

        stale();
        await settle();
        expect(selfUseWanted.getCached()).toEqual(['/items/frenzy', '/items/puncture']);
        // The read taken after the change agrees with it
        state.heldReads.at(-1)();
        await settle();
        expect(selfUseWanted.getCached()).toEqual(['/items/frenzy', '/items/puncture']);
    });

    test("a mark made in another tab reaches this tab's cache and its listeners", async () => {
        await selfUseWanted.load();
        const heard = vi.fn();
        selfUseWanted.onChange(heard);

        otherTabWrites('selfUseWanted_main', ['/items/frenzy']);
        await settle();

        expect(selfUseWanted.isKept('/items/frenzy')).toBe(true);
        expect(heard).toHaveBeenCalledTimes(1);
    });

    test('a chip on screen is relabelled when another tab marks its item', async () => {
        await selfUseWanted.load();
        const chip = document.createElement('span');
        chip.className = 'toolasha-selfuse-keep-chip';
        chip.setAttribute('data-item-hrid', '/items/frenzy');
        document.body.appendChild(chip);

        otherTabWrites('selfUseWanted_main', ['/items/frenzy']);
        await settle();
        expect(chip.textContent).toBe('☑ Kept for self-use');
        chip.remove();
    });

    test("another character's key, another store, or this tab's own write reloads nothing", async () => {
        await selfUseWanted.load();
        const heard = vi.fn();
        selfUseWanted.onChange(heard);

        otherTabWrites('selfUseWanted_alt', ['/items/frenzy']);
        otherTabWrites('selfUseWanted_main', ['/items/frenzy'], 'networthHistory');
        state.stored.selfUseWanted_main = ['/items/puncture'];
        for (const listener of state.writeListeners) {
            listener({ storeName: 'settings', keys: ['selfUseWanted_main'], origin: 'commit' });
        }
        await settle();

        expect(heard).not.toHaveBeenCalled();
        expect(selfUseWanted.isKept('/items/frenzy')).toBe(false);
    });

    test('a change made in another tab while nobody listened is read when listening resumes', async () => {
        await selfUseWanted.load();
        selfUseWanted.stopWatching();
        // Committed while this tab was not listening, so never announced to it
        state.stored.selfUseWanted_main = ['/items/frenzy'];

        expect(await selfUseWanted.load()).toEqual(['/items/frenzy']);
        expect(selfUseWanted.isKept('/items/frenzy')).toBe(true);
        expect(state.writeListeners.size).toBe(1);
    });

    test('teardown stops listening', async () => {
        await selfUseWanted.load();
        expect(state.writeListeners.size).toBe(1);
        selfUseWanted.stopWatching();
        expect(state.writeListeners.size).toBe(0);
    });
});

describe('marking items', () => {
    test('a new character starts with nothing marked', async () => {
        expect([...(await selfUseWanted.getSet())]).toEqual([]);
    });

    test('toggle adds an hrid for the current character, persists it, and removes it again', async () => {
        expect(await selfUseWanted.toggle('/items/frenzy')).toBe(true);
        expect(state.stored.selfUseWanted_main).toEqual(['/items/frenzy']);
        expect(state.writes.at(-1)).toEqual({ key: 'selfUseWanted_main', store: 'settings' });
        expect(selfUseWanted.isKept('/items/frenzy')).toBe(true);

        expect(await selfUseWanted.toggle('/items/frenzy')).toBe(false);
        expect(state.stored.selfUseWanted_main).toEqual([]);
        expect(selfUseWanted.isKept('/items/frenzy')).toBe(false);
    });

    test('a mark survives a reload: a fresh cache reads it back', async () => {
        await selfUseWanted.setKept('/items/frenzy', true);
        selfUseWanted._reset();
        expect((await selfUseWanted.getSet()).has('/items/frenzy')).toBe(true);
    });

    test('clear empties the list', async () => {
        await selfUseWanted.setKept('/items/frenzy', true);
        await selfUseWanted.setKept('/items/puncture', true);
        expect(await selfUseWanted.clear()).toBe(true);
        expect(state.stored.selfUseWanted_main).toEqual([]);
    });

    test('a listener hears every change', async () => {
        const heard = vi.fn();
        const off = selfUseWanted.onChange(heard);
        await selfUseWanted.toggle('/items/frenzy');
        await selfUseWanted.clear();
        off();
        await selfUseWanted.toggle('/items/frenzy');
        expect(heard).toHaveBeenCalledTimes(2);
    });

    test('a stored list is read defensively: junk and duplicates dropped', async () => {
        state.stored.selfUseWanted_main = ['/items/frenzy', '/items/frenzy', 42, null, 'frenzy'];
        expect([...(await selfUseWanted.getSet())]).toEqual(['/items/frenzy']);
    });
});

describe('changes land on what is stored', () => {
    test('a mark made in another tab is kept when this tab marks another item', async () => {
        await selfUseWanted.load();
        // Committed by another tab, not yet heard here
        state.stored.selfUseWanted_main = ['/items/puncture'];

        await selfUseWanted.setKept('/items/frenzy', true);

        expect(state.stored.selfUseWanted_main).toEqual(['/items/puncture', '/items/frenzy']);
        expect(selfUseWanted.getCached()).toEqual(['/items/puncture', '/items/frenzy']);
    });

    test('a removal made in another tab is not undone by a later change here', async () => {
        state.stored.selfUseWanted_main = ['/items/frenzy', '/items/puncture'];
        await selfUseWanted.load();
        state.stored.selfUseWanted_main = ['/items/puncture'];

        await selfUseWanted.setKept('/items/puncture', false);

        expect(state.stored.selfUseWanted_main).toEqual([]);
    });

    test('two quick removals both land', async () => {
        state.stored.selfUseWanted_main = ['/items/frenzy', '/items/puncture', '/items/fierce_aura'];
        await selfUseWanted.load();
        await Promise.all([
            selfUseWanted.setKept('/items/frenzy', false),
            selfUseWanted.setKept('/items/puncture', false),
        ]);
        expect(state.stored.selfUseWanted_main).toEqual(['/items/fierce_aura']);
        expect(selfUseWanted.getCached()).toEqual(['/items/fierce_aura']);
    });
});

describe('per character', () => {
    test("another character's list is separate", async () => {
        await selfUseWanted.setKept('/items/frenzy', true);
        state.charId = 'alt';
        expect((await selfUseWanted.getSet()).has('/items/frenzy')).toBe(false);
        expect(selfUseWanted.isKept('/items/frenzy')).toBe(false);
        await selfUseWanted.setKept('/items/puncture', true);
        expect(state.stored.selfUseWanted_alt).toEqual(['/items/puncture']);
        expect(state.stored.selfUseWanted_main).toEqual(['/items/frenzy']);

        state.charId = 'main';
        expect([...(await selfUseWanted.getSet())]).toEqual(['/items/frenzy']);
    });

    test("a switch landing inside a cold read writes nothing over the newcomer's list", async () => {
        state.stored.selfUseWanted_alt = ['/items/puncture'];
        state.onRead = () => {
            state.charId = 'alt';
        };
        expect(await selfUseWanted.toggle('/items/frenzy')).toBeNull();
        expect(state.stored.selfUseWanted_alt).toEqual(['/items/puncture']);
        expect(state.stored.selfUseWanted_main).toBeUndefined();
    });
});

describe('sync', () => {
    test('the key is one the gist sync carries', () => {
        expect(ownsKey('settings', `${STORAGE_KEY_PREFIX}_123456`)).toBe(true);
        expect(ownsKey('settings', 'selfUseWanted_default')).toBe(true);
    });
});

describe('which tooltips get the chip', () => {
    test('anything a decompose or transmute yields, and the alchemy bonus drops', () => {
        state.itemDetailMap = {
            '/items/cheese_sword': { alchemyDetail: { decomposeItems: [{ itemHrid: '/items/cheese', count: 18 }] } },
            '/items/vampirism': {
                alchemyDetail: { transmuteDropTable: [{ itemHrid: '/items/frenzy', dropRate: 1 }] },
            },
            '/items/apple': {},
        };
        expect(selfUseWanted.isAlchemyOutput('/items/cheese')).toBe(true);
        expect(selfUseWanted.isAlchemyOutput('/items/frenzy')).toBe(true);
        expect(selfUseWanted.isAlchemyOutput('/items/small_artisans_crate')).toBe(true);
        expect(selfUseWanted.isAlchemyOutput('/items/apple')).toBe(false);
    });
});
