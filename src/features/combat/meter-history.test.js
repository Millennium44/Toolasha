/**
 * The saved-session store both meter boards file finished sessions into.
 *
 * What matters: what survives eviction (ten recent, thirty starred), that a
 * fuller reading of one session replaces it without losing its star or name,
 * that a game-totals reading is never replaced by a stream one, that every
 * write lands under the character it names, and that a list read which
 * finishes after a character switch is not shown for the next character.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const opts = vi.hoisted(() => ({ characterId: 'A', stored: new Map(), gate: null, settings: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => opts.settings[key] ?? fallback,
        getSettingValue: (_key, fallback) => fallback,
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => opts.characterId } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => {
            if (opts.gate) await opts.gate;
            return opts.stored.has(key) ? opts.stored.get(key) : fallback;
        },
        set: async (key, value) => {
            opts.stored.set(key, value);
            return true;
        },
        delete: async (key) => opts.stored.delete(key),
    },
}));

const {
    MAX_FAVOURITES,
    MAX_RECENT,
    cachedHistoryIndex,
    deleteEntry,
    ensureHistoryLoaded,
    fitEntry,
    formatSessionDuration,
    getHistoryEntry,
    historyEnabled,
    historyEntryKey,
    historyIndexKey,
    historyListHTML,
    loadHistoryIndex,
    renameEntry,
    saveHistoryEntry,
    setFavourite,
    trimIndex,
    _resetMeterHistory,
} = await import('./meter-history.js');

/** A small combat body */
const entry = (id, endedAt, extra = {}) => ({
    id,
    type: 'combat',
    startedAt: endedAt - 60_000,
    endedAt,
    seconds: 60,
    basis: 'stream',
    summary: { label: `Zone ${id}`, total: 1000, perSecond: 16 },
    dealt: { players: [{ name: 'Abe', damage: 1000 }] },
    ...extra,
});

beforeEach(() => {
    opts.characterId = 'A';
    opts.stored = new Map();
    opts.gate = null;
    opts.settings = {};
    _resetMeterHistory();
});

describe('what is kept', () => {
    test('the ten newest unstarred and every starred one up to thirty', () => {
        const index = [
            ...Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, endedAt: i })),
            ...Array.from({ length: 32 }, (_, i) => ({ id: `f${i}`, endedAt: i, favourite: true })),
        ];
        const { kept, dropped } = trimIndex(index);
        expect(kept.filter((summary) => !summary.favourite)).toHaveLength(MAX_RECENT);
        expect(kept.filter((summary) => summary.favourite)).toHaveLength(MAX_FAVOURITES);
        expect(dropped.map((summary) => summary.id).sort()).toEqual(['f0', 'f1', 'r0', 'r1']);
        // Newest first
        expect(kept[0].endedAt).toBe(31);
    });

    test('an eleventh session evicts the oldest body, and a starred one outlives it', async () => {
        await saveHistoryEntry(entry('e0', 1000), 'A');
        await saveHistoryEntry(entry('e1', 2000), 'A');
        expect((await setFavourite('combat', 'e1', true, 'A')).ok).toBe(true);
        for (let i = 2; i <= 11; i++) await saveHistoryEntry(entry(`e${i}`, 1000 * (i + 1)), 'A');

        const ids = (await loadHistoryIndex('combat', 'A')).map((summary) => summary.id);
        expect(ids).toContain('e1');
        expect(ids).not.toContain('e0');
        expect(ids).toHaveLength(MAX_RECENT + 1);
        expect(opts.stored.has(historyEntryKey('A', 'combat', 'e0'))).toBe(false);
        expect(opts.stored.has(historyEntryKey('A', 'combat', 'e1'))).toBe(true);
    });

    test('a thirty-first star is refused rather than pushing an old favourite out', async () => {
        opts.stored.set(historyIndexKey('A', 'combat'), [
            ...Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, endedAt: i, favourite: true })),
            { id: 'plain', endedAt: 99, favourite: false },
        ]);
        expect(await setFavourite('combat', 'plain', true, 'A')).toEqual({ ok: false, reason: 'full' });
        const index = await loadHistoryIndex('combat', 'A');
        expect(index.filter((summary) => summary.favourite)).toHaveLength(30);
    });
});

describe('saving', () => {
    test('files the body and its summary under the character named, not the one logged in', async () => {
        opts.characterId = 'B';
        const summary = await saveHistoryEntry(entry('s1', 5000), 'A');
        expect(summary).toMatchObject({ id: 's1', label: 'Zone s1', total: 1000, favourite: false, name: null });
        expect(opts.stored.has(historyEntryKey('A', 'combat', 's1'))).toBe(true);
        expect(await loadHistoryIndex('combat', 'A')).toHaveLength(1);
        expect(await loadHistoryIndex('combat', 'B')).toHaveLength(0);
        expect((await getHistoryEntry('combat', 's1', 'A')).dealt.players[0].name).toBe('Abe');
    });

    test('the same session saved again replaces it and keeps its star and name', async () => {
        await saveHistoryEntry(entry('s1', 5000), 'A');
        await setFavourite('combat', 's1', true, 'A');
        await renameEntry('combat', 's1', '  Boss   run ', 'A');
        await saveHistoryEntry(entry('s1', 9000, { summary: { label: 'Zone s1', total: 4000 } }), 'A');

        const index = await loadHistoryIndex('combat', 'A');
        expect(index).toHaveLength(1);
        expect(index[0]).toMatchObject({ total: 4000, favourite: true, name: 'Boss run' });
    });

    test('a stream reading never replaces one restated in the game’s totals', async () => {
        await saveHistoryEntry(entry('t1', 5000, { type: 'trial', basis: 'game' }), 'A');
        expect(await saveHistoryEntry(entry('t1', 6000, { type: 'trial', basis: 'stream' }), 'A')).toBeNull();
        expect((await loadHistoryIndex('trial', 'A'))[0].basis).toBe('game');
    });

    test('a save and a rename landing together both survive', async () => {
        await saveHistoryEntry(entry('a', 1000), 'A');
        await Promise.all([saveHistoryEntry(entry('b', 2000), 'A'), renameEntry('combat', 'a', 'Named', 'A')]);
        const index = await loadHistoryIndex('combat', 'A');
        expect(index.map((summary) => summary.id)).toEqual(['b', 'a']);
        expect(index[1].name).toBe('Named');
    });

    test('delete removes the body and the summary, starred or not', async () => {
        await saveHistoryEntry(entry('d', 1000), 'A');
        await setFavourite('combat', 'd', true, 'A');
        expect(await deleteEntry('combat', 'd', 'A')).toBe(true);
        expect(await loadHistoryIndex('combat', 'A')).toEqual([]);
        expect(opts.stored.has(historyEntryKey('A', 'combat', 'd'))).toBe(false);
        expect(await deleteEntry('combat', 'd', 'A')).toBe(false);
    });

    test('an empty name goes back to the automatic label', async () => {
        await saveHistoryEntry(entry('n', 1000), 'A');
        await renameEntry('combat', 'n', 'Something', 'A');
        await renameEntry('combat', 'n', '   ', 'A');
        expect((await loadHistoryIndex('combat', 'A'))[0].name).toBeNull();
    });

    test('the setting is on unless it has been switched off', () => {
        expect(historyEnabled()).toBe(true);
        opts.settings.combatMeterHistory = false;
        expect(historyEnabled()).toBe(false);
    });
});

describe('the size guard', () => {
    test('a small body is cloned untouched', () => {
        const body = entry('x', 1);
        const fitted = fitEntry(body);
        expect(fitted).toEqual(body);
        expect(fitted).not.toBe(body);
        expect(fitted.trimmed).toBeUndefined();
    });

    test('a large one sheds per-enemy ability rows first', () => {
        const body = entry('x', 1, {
            dealt: {
                players: [
                    {
                        name: 'Abe',
                        abilities: [{ action: 'auto', damage: 5 }],
                        enemies: [{ name: 'Rat', abilities: Array.from({ length: 400 }, () => ({ action: 'auto' })) }],
                    },
                ],
            },
        });
        const fitted = fitEntry(body, 3000);
        expect(fitted.trimmed).toEqual(['per-enemy ability rows']);
        expect(fitted.dealt.players[0].enemies[0].abilities).toBeUndefined();
        expect(fitted.dealt.players[0].abilities).toHaveLength(1);
    });

    test('one that cannot be made to fit is refused, and nothing is written', async () => {
        const body = entry('huge', 1, { blob: 'y'.repeat(10_000) });
        expect(fitEntry(body, 5000)).toBeNull();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const big = entry('huge', 1, { blob: 'y'.repeat(500_000) });
        expect(await saveHistoryEntry(big, 'A')).toBeNull();
        expect(opts.stored.size).toBe(0);
    });
});

describe('the list', () => {
    test('a read that finishes after a character switch is not drawn for the next character', async () => {
        opts.stored.set(historyIndexKey('A', 'combat'), [{ id: 'x', endedAt: 1, label: 'Mine' }]);
        let release;
        opts.gate = new Promise((resolve) => {
            release = resolve;
        });
        const redraw = vi.fn();
        const reading = ensureHistoryLoaded('combat', redraw);
        opts.characterId = 'B';
        release();
        await reading;

        expect(redraw).not.toHaveBeenCalled();
        expect(cachedHistoryIndex('combat')).toBeNull();
        expect(cachedHistoryIndex('combat', 'A')).toHaveLength(1);
    });

    test('draws each saved session with its controls, and escapes names off the wire', () => {
        const index = [
            { id: 'a', endedAt: 1, seconds: 725, label: 'Swamp', name: '<b>mine</b>', total: 12_000, perSecond: 16 },
            { id: 'b', endedAt: 2, seconds: 45, label: 'Cave', total: 800, perSecond: null, favourite: true },
        ];
        const html = historyListHTML(index, { type: 'combat', confirming: 'b' });
        expect(html).toContain('&lt;b&gt;mine&lt;/b&gt;');
        expect(html).not.toContain('<b>mine</b>');
        expect(html).toContain('12m 05s');
        expect(html).toContain('★');
        expect(html).toContain('Delete?');
        expect(html).toContain('data-history-copy="a"');
        expect(historyListHTML(index, { type: 'combat', renaming: 'a' })).toContain('data-history-label="a"');
    });

    test('says when it is reading, and when there is nothing', () => {
        expect(historyListHTML(null, { type: 'trial' })).toContain('Reading saved sessions');
        expect(historyListHTML([], { type: 'trial' })).toContain('Nothing saved yet');
    });

    test('durations read as a person says them', () => {
        expect(formatSessionDuration(45)).toBe('45s');
        expect(formatSessionDuration(725)).toBe('12m 05s');
        expect(formatSessionDuration(3720)).toBe('1h 02m');
    });
});
