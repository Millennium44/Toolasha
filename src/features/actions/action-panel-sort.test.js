/**
 * @vitest-environment happy-dom
 *
 * Whose pins the panel is sorting by.
 *
 * The pins and the sort mode are two separate per-character keys, and this
 * module reloads them from its own `character_initialized` listener — a
 * deferred macrotask the feature registry's switch chain does not serialise.
 * So a read can answer for a character the player has already left, and
 * `togglePin()` writes the pin list back whole and immediately: adopting a
 * stale read means the next pin click files it under the wrong character.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({
    characterId: 'char1',
    data: {},
    writes: [],
    /** Fired inside every read, so a test can land a switch in one */
    onRead: null,
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, _store, fallback) => {
            store.onRead?.();
            return store.data[key] ?? fallback;
        },
        get: async (key, _store, fallback) => {
            store.onRead?.();
            return store.data[key] ?? fallback;
        },
        setJSON: async (key, value) => {
            store.writes.push({ key, value });
            store.data[key] = value;
            return true;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => store.characterId,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/dom.js', () => ({ dismissTooltips: () => {} }));

const { default: actionPanelSort } = await import('./action-panel-sort.js');

beforeEach(() => {
    store.characterId = 'char1';
    store.data = {};
    store.writes = [];
    store.onRead = null;
    actionPanelSort.onCharacterSwitching();
    // onCharacterSwitching clears the pins but not the mode, which is a panel
    // preference rather than character data until the next load replaces it
    actionPanelSort.sortMode = 'default';
});

describe('a character switch inside the pin read', () => {
    test('the departing character’s pins are not adopted', async () => {
        store.data.pinnedActions_char1 = ['/actions/milking/cow'];
        store.data.actionSortMode_char1 = 'profit';
        store.data.pinnedActions_char2 = ['/actions/brewing/tea'];

        // The reads were issued for char1; the player is on char2 by the time
        // the first one answers
        store.onRead = () => {
            store.characterId = 'char2';
            store.onRead = null;
        };

        await actionPanelSort.initialize();

        // char1's pins in memory would be written over char2's stored list by
        // the very next pin click
        expect([...actionPanelSort.pinnedActions]).toEqual([]);
        expect(actionPanelSort.sortMode).toBe('default');
    });

    test('the arriving character’s own reload still lands', async () => {
        store.data.pinnedActions_char2 = ['/actions/brewing/tea'];
        store.data.actionSortMode_char2 = 'profit';
        store.characterId = 'char2';

        await actionPanelSort.onCharacterInitialized();

        expect([...actionPanelSort.pinnedActions]).toEqual(['/actions/brewing/tea']);
        expect(actionPanelSort.sortMode).toBe('profit');
    });

    test('the pins and the sort mode always come from the same character', async () => {
        store.data.pinnedActions_char1 = ['/actions/milking/cow'];
        store.data.actionSortMode_char2 = 'profit';

        // The switch lands between the two reads, which used to resolve their
        // keys independently — char1's pins beside char2's sort mode
        let reads = 0;
        store.onRead = () => {
            reads += 1;
            if (reads === 1) store.characterId = 'char2';
        };

        await actionPanelSort.initialize();

        expect([...actionPanelSort.pinnedActions]).toEqual([]);
        expect(actionPanelSort.sortMode).toBe('default');
    });
});
