/**
 * What the away card is allowed to say.
 *
 * The risk here is the mirror image of the account panel's: that one can show a
 * stale line as if it were current, and this one can invent a change out of a
 * pair of instants that never justified it. So the assertions are mostly about
 * silence — a subject only one side answered, a character with no snapshot at
 * all, a diff already read — and about the two wordings that are allowed to
 * exist: a matured deadline stated against the instant it named, and a reading
 * stated as a net delta.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const stores = vi.hoisted(() => ({ data: new Map(), writes: [] }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async (key, store, fallback) => (stores.data.has(key) ? stores.data.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            stores.writes.push({ key, value });
            stores.data.set(key, value);
            return true;
        }),
    },
}));

const { awayDiffLines, awayDiffSeenKey, computeAwayDiff, markAwayDiffSeen } = await import('./away-diff.js');
const { snapshotKey } = await import('./briefing-snapshot-store.js');

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

/** A snapshot taken `hoursAgo` hours before NOW. */
const snap = (facts, hoursAgo = 3) => ({
    characterId: 'alt',
    characterName: 'Alt',
    at: NOW - hoursAgo * HOUR,
    facts,
});

const diff = (facts, liveFacts, hoursAgo = 3) =>
    awayDiffLines({ snapshot: snap(facts, hoursAgo), liveFacts, now: NOW });

/** The one line for a key, or undefined. */
const line = (lines, key) => lines.find((entry) => entry.key === key);

beforeEach(() => {
    stores.data.clear();
    stores.writes.length = 0;
});

describe('awayDiffLines — a deadline that lapsed', () => {
    test('states the matured claim against the instant it named, never as a countdown', () => {
        // An hour of ale, recorded three hours ago: it ran out two hours ago
        const lines = diff(
            { consumable: { name: 'Ale', secondsLeft: 3600 } },
            { consumable: { name: 'Ale', secondsLeft: 0 } }
        );

        const dry = line(lines, 'consumable');
        expect(dry.value).toMatch(/^Ale ran dry at /);
        // The past tense is the whole point: the clock has already falsified
        // "runs dry", and a countdown is falsified twice over
        expect(dry.value).not.toContain('runs dry');
        expect(dry.value).not.toContain('1h');
        expect(dry.value).not.toContain(' in ');
        expect(dry.tone).toBe('bad');
    });

    test('says nothing while the deadline is still ahead — that is the live briefing’s job', () => {
        const lines = diff(
            { consumable: { name: 'Ale', secondsLeft: 20 * 3600 } },
            { consumable: { name: 'Ale', secondsLeft: 17 * 3600 } }
        );
        expect(line(lines, 'consumable')).toBeUndefined();
    });

    test('says nothing when the live side has no consumable to compare against', () => {
        const lines = diff({ consumable: { name: 'Ale', secondsLeft: 60 } }, { tasksReady: 1 });
        expect(lines).toEqual([]);
    });
});

describe('awayDiffLines — readings', () => {
    test('a reading states the net delta, and carries the age of the older side', () => {
        const lines = diff({ listings: { filled: 0, undercut: 3 } }, { listings: { filled: 0, undercut: 5 } });

        const listings = line(lines, 'listings');
        expect(listings.value).toBe('2 more listings undercut');
        expect(listings.ageMs).toBe(3 * HOUR);
        expect(listings.since).toBe(NOW - 3 * HOUR);
    });

    test('one listing is one listing, not one listings', () => {
        const lines = diff({ listings: { filled: 0, undercut: 3 } }, { listings: { filled: 0, undercut: 4 } });
        expect(line(lines, 'listings').value).toBe('1 more listing undercut');
    });

    test('a delta the other way is reported the other way', () => {
        const lines = diff({ listings: { filled: 0, undercut: 5 } }, { listings: { filled: 0, undercut: 2 } });
        expect(line(lines, 'listings').value).toBe('3 fewer listings undercut');
    });

    test('a reading that did not move produces no line', () => {
        const lines = diff({ listings: { filled: 0, undercut: 3 } }, { listings: { filled: 0, undercut: 3 } });
        expect(lines).toEqual([]);
    });

    test('tasks that arrived and tasks that were claimed are different sentences', () => {
        expect(line(diff({ tasksReady: 1 }, { tasksReady: 4 }), 'tasksReady').value).toBe('3 more waiting');
        expect(line(diff({ tasksReady: 4 }, { tasksReady: 1 }), 'tasksReady').value).toBe('3 tasks claimed');
    });

    test('an enhancement run that moved is reported by its levels', () => {
        const lines = diff(
            { enhancement: { itemName: 'Sword', currentLevel: 2, targetLevel: 8 } },
            { enhancement: { itemName: 'Sword', currentLevel: 5, targetLevel: 8 } }
        );
        expect(line(lines, 'enhancement').value).toBe('Sword +2 → +5');
    });

    test('a signup that appeared is reported by name', () => {
        const lines = diff(
            { guild: { signedUp: false, trialName: null } },
            { guild: { signedUp: true, trialName: 'gathering' } }
        );
        expect(line(lines, 'guild').value).toBe('Signed up: gathering');
    });
});

describe('awayDiffLines — the task board', () => {
    test('crossing into full uses the engine’s own wording for a full board', () => {
        const lines = diff(
            { taskSlots: { ok: true, isFull: false, msUntilFull: 30 * 60_000, msUntilWaste: 0 } },
            { taskSlots: { ok: true, isFull: true, msUntilFull: 0, msUntilWaste: 20 * 60_000 } }
        );

        const board = line(lines, 'taskSlots');
        expect(board.value).toBe('Full — first wasted in 20m');
        expect(board.tone).toBe('bad');
    });

    test('a board that only got closer to full is not a change', () => {
        const lines = diff(
            { taskSlots: { ok: true, isFull: false, msUntilFull: 50 * 60_000, msUntilWaste: 0 } },
            { taskSlots: { ok: true, isFull: false, msUntilFull: 20 * 60_000, msUntilWaste: 0 } }
        );
        expect(lines).toEqual([]);
    });

    test('a board emptied while you were away says so', () => {
        const lines = diff(
            { taskSlots: { ok: true, isFull: true, msUntilFull: 0, msUntilWaste: 0 } },
            { taskSlots: { ok: true, isFull: false, msUntilFull: 9 * HOUR, msUntilWaste: 0 } }
        );
        expect(line(lines, 'taskSlots').value).toBe('No longer full');
    });
});

describe('awayDiffLines — what it refuses to say', () => {
    test('a fact only the snapshot has produces nothing', () => {
        expect(diff({ tasksReady: 3 }, {})).toEqual([]);
    });

    test('a fact only the live side has produces nothing', () => {
        expect(diff({}, { tasksReady: 3 })).toEqual([]);
    });

    test('a live fact outside the snapshot’s subjects is never compared', () => {
        // `queue` and `notices` are live-only subjects; a snapshot cannot carry
        // them, so there is no earlier reading for them to differ from
        const lines = diff({ queue: { queued: 3, seconds: 60 } }, { queue: { queued: 0, seconds: 0 } });
        expect(lines).toEqual([]);
    });

    test('no snapshot is silence, not "nothing happened"', () => {
        expect(awayDiffLines({ snapshot: null, liveFacts: { tasksReady: 3 }, now: NOW })).toEqual([]);
    });

    test('a snapshot from the future is a clock that moved, not a negative age', () => {
        const lines = awayDiffLines({
            snapshot: { at: NOW + HOUR, facts: { tasksReady: 1 } },
            liveFacts: { tasksReady: 4 },
            now: NOW,
        });
        expect(line(lines, 'tasksReady').ageMs).toBe(0);
    });
});

describe('computeAwayDiff', () => {
    const facts = { listings: { filled: 0, undercut: 3 } };
    const live = { listings: { filled: 0, undercut: 5 } };

    test('a character with no snapshot gets no card at all', async () => {
        expect(await computeAwayDiff('alt', live, NOW)).toBeNull();
    });

    test('a snapshot that differs in nothing gets no card', async () => {
        stores.data.set(snapshotKey('alt'), snap(facts));
        expect(await computeAwayDiff('alt', facts, NOW)).toBeNull();
    });

    test('a snapshot that differs gets a card', async () => {
        stores.data.set(snapshotKey('alt'), snap(facts));
        const card = await computeAwayDiff('alt', live, NOW);
        expect(card.at).toBe(NOW - 3 * HOUR);
        expect(card.lines).toHaveLength(1);
    });

    test('dismissing it keeps it dismissed for that snapshot', async () => {
        stores.data.set(snapshotKey('alt'), snap(facts));
        const card = await computeAwayDiff('alt', live, NOW);

        await markAwayDiffSeen('alt', card.at);
        expect(stores.data.get(awayDiffSeenKey('alt'))).toBe(card.at);
        expect(await computeAwayDiff('alt', live, NOW)).toBeNull();
    });

    test('the next switch away overwrites the snapshot, and the mark with it', async () => {
        stores.data.set(snapshotKey('alt'), snap(facts));
        await markAwayDiffSeen('alt', NOW - 3 * HOUR);

        // Switching away again writes a newer snapshot; the mark is for the old
        // instant and cannot silence the new one
        stores.data.set(snapshotKey('alt'), snap(facts, 1));
        const card = await computeAwayDiff('alt', live, NOW);
        expect(card.at).toBe(NOW - HOUR);
    });

    test('a mark from a different character silences nothing here', async () => {
        stores.data.set(snapshotKey('alt'), snap(facts));
        await markAwayDiffSeen('other', NOW);
        expect(await computeAwayDiff('alt', live, NOW)).not.toBeNull();
    });

    test('the snapshot itself is never deleted — the account panel still needs it', async () => {
        stores.data.set(snapshotKey('alt'), snap(facts));
        const card = await computeAwayDiff('alt', live, NOW);
        await markAwayDiffSeen('alt', card.at);
        expect(stores.data.get(snapshotKey('alt'))).toBeTruthy();
    });
});
