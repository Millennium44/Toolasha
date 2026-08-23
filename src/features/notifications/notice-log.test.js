/**
 * Tests for the notice log.
 *
 * The bound is the only thing standing between a feature that appends on every
 * notification and a storage key that grows for the life of the account, so it
 * is asserted from both ends: entries stop accumulating, and the ones that
 * survive are the newest.
 *
 * The other test worth its length is the load-after-append case. Notifications
 * start with the websocket and this store loads from IndexedDB, so a notice
 * arriving before the read lands is the normal case rather than a race — and a
 * load that replaced the in-memory entries would delete exactly the notices the
 * player has not seen.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: new Map(), character: 'char-1' }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => store.character },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key) => store.data.get(key) ?? null,
        setJSON: async (key, value) => {
            // Cloned on the way in, as IndexedDB would: a store handing back the
            // same object the log is still mutating would hide every bug here
            store.data.set(key, JSON.parse(JSON.stringify(value)));
        },
    },
}));

const {
    appendNotice,
    readNotices,
    noticeCount,
    unreadNoticeCount,
    noticesSince,
    markNoticesSeen,
    clearNotices,
    loadNoticeLog,
    noticeLogKey,
    MAX_ENTRIES,
    MAX_TEXT_LENGTH,
    _resetNoticeLog,
} = await import('./notice-log.js');

/** One notice, with only the fields a test cares about spelled out */
function notice(overrides = {}) {
    return {
        key: 'market-undercut-1',
        category: 'market',
        subject: 'Cheese',
        text: 'Cheese sell listing undercut.',
        urgency: 'normal',
        channels: ['toast'],
        at: 1_000,
        ...overrides,
    };
}

/** Let the un-awaited persist inside `appendNotice` land */
async function settle() {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    store.data.clear();
    store.character = 'char-1';
    _resetNoticeLog();
});

describe('appending', () => {
    test('a notice comes back with everything the panel draws', () => {
        const entry = appendNotice(notice());
        expect(entry).toMatchObject({
            at: 1_000,
            category: 'market',
            subject: 'Cheese',
            urgency: 'normal',
            channels: ['toast'],
        });
        expect(readNotices()).toEqual([entry]);
    });

    test('an urgency nobody recognises is normal, not critical', () => {
        expect(appendNotice(notice({ urgency: 'shouty' })).urgency).toBe('normal');
        expect(appendNotice(notice({ urgency: 'critical' })).urgency).toBe('critical');
    });

    test('a runaway message is truncated rather than stored whole', () => {
        const entry = appendNotice(notice({ text: 'x'.repeat(5_000) }));
        expect(entry.text).toHaveLength(MAX_TEXT_LENGTH);
    });

    test('the newest is first, because that is the order it is read in', () => {
        appendNotice(notice({ at: 1, subject: 'first' }));
        appendNotice(notice({ at: 2, subject: 'second' }));
        expect(readNotices().map((entry) => entry.subject)).toEqual(['second', 'first']);
    });
});

describe('the bound', () => {
    test('the log stops growing, and it is the oldest that go', () => {
        for (let index = 0; index < MAX_ENTRIES + 50; index += 1) {
            appendNotice(notice({ at: index, subject: `n${index}` }));
        }

        expect(noticeCount()).toBe(MAX_ENTRIES);
        const entries = readNotices(MAX_ENTRIES);
        expect(entries[0].subject).toBe(`n${MAX_ENTRIES + 49}`);
        expect(entries[entries.length - 1].subject).toBe('n50');
    });

    test('a log persisted over the bound is trimmed when it is read back', async () => {
        store.data.set(noticeLogKey('char-1'), {
            seenAt: 0,
            entries: Array.from({ length: MAX_ENTRIES + 25 }, (_, index) => notice({ at: index })),
        });

        await loadNoticeLog();
        expect(noticeCount()).toBe(MAX_ENTRIES);
    });
});

describe('persistence', () => {
    test('what was appended is what is read back', async () => {
        appendNotice(notice({ at: 5, subject: 'Cheese' }));
        appendNotice(notice({ at: 6, subject: 'Milk' }));
        await settle();

        expect(store.data.get(noticeLogKey('char-1')).entries).toHaveLength(2);

        _resetNoticeLog();
        await loadNoticeLog();
        expect(readNotices().map((entry) => entry.subject)).toEqual(['Milk', 'Cheese']);
    });

    test('a notice that arrived before the load survives it', async () => {
        store.data.set(noticeLogKey('char-1'), { seenAt: 0, entries: [notice({ at: 1, subject: 'saved' })] });

        // The order the live script does this in: the websocket is talking
        // before IndexedDB has answered
        appendNotice(notice({ at: 2, subject: 'live' }));
        await loadNoticeLog();

        expect(readNotices().map((entry) => entry.subject)).toEqual(['live', 'saved']);
    });

    test('the log follows the character, and does not mix two of them', async () => {
        appendNotice(notice({ at: 1, subject: 'on char-1' }));
        await settle();

        store.character = 'char-2';
        await loadNoticeLog();
        expect(noticeCount()).toBe(0);

        appendNotice(notice({ at: 2, subject: 'on char-2' }));
        await settle();
        expect(store.data.get(noticeLogKey('char-2')).entries).toHaveLength(1);
        expect(store.data.get(noticeLogKey('char-1')).entries).toHaveLength(1);
    });

    test('a store that cannot be read leaves an empty log rather than throwing', async () => {
        store.data.set(noticeLogKey('char-1'), { entries: 'not an array' });
        await expect(loadNoticeLog()).resolves.toBeUndefined();
        expect(noticeCount()).toBe(0);
    });
});

describe('what has been read', () => {
    test('everything is unread until it is marked seen', () => {
        appendNotice(notice({ at: 10 }));
        appendNotice(notice({ at: 20 }));
        expect(unreadNoticeCount()).toBe(2);

        markNoticesSeen(15);
        expect(unreadNoticeCount()).toBe(1);

        markNoticesSeen(20);
        expect(unreadNoticeCount()).toBe(0);
    });

    test('the count since a moment is what the briefing asks for', () => {
        appendNotice(notice({ at: 10 }));
        appendNotice(notice({ at: 20 }));
        appendNotice(notice({ at: 30 }));
        expect(noticesSince(15)).toBe(2);
        expect(noticesSince(0)).toBe(3);
        expect(noticesSince(30)).toBe(0);
    });

    test('a read mark survives a reload', async () => {
        appendNotice(notice({ at: 10 }));
        markNoticesSeen(10);
        await settle();

        _resetNoticeLog();
        await loadNoticeLog();
        expect(unreadNoticeCount()).toBe(0);
    });

    test('clearing empties both the log and what was written', async () => {
        appendNotice(notice({ at: 10 }));
        await clearNotices();

        expect(noticeCount()).toBe(0);
        expect(store.data.get(noticeLogKey('char-1')).entries).toEqual([]);
    });
});
