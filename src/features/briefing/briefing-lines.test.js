/**
 * The briefing's editorial judgement, tested without a game.
 *
 * The lines themselves are trivial string building; what is worth asserting is
 * the *omission* — every subject has a threshold below which it is not news,
 * and a briefing that ignored those thresholds would be a wall of "all fine"
 * that nobody reads twice.
 */

import { describe, test, expect } from 'vitest';
import { buildBriefingLines, BUFF_WINDOW_MS, QUEUE_WARN_SECONDS } from './briefing-lines.js';

const NOW = 1_700_000_000_000;

/**
 * The keys of whatever the briefing decided to say.
 * @param {Object} facts - Facts under test
 * @returns {Array<string>} Line keys, in order
 */
function keys(facts) {
    return buildBriefingLines(facts, NOW).map((line) => line.key);
}

/**
 * One line by key, or undefined.
 * @param {Object} facts - Facts under test
 * @param {string} key - Which line
 * @returns {Object|undefined} The line
 */
function line(facts, key) {
    return buildBriefingLines(facts, NOW).find((entry) => entry.key === key);
}

describe('buildBriefingLines', () => {
    test('says nothing when there is nothing to say', () => {
        expect(buildBriefingLines({}, NOW)).toEqual([]);
        expect(buildBriefingLines(undefined, NOW)).toEqual([]);
    });

    test('a quiet game produces no lines at all', () => {
        const facts = {
            queue: null,
            tasksReady: 0,
            taskSlots: { ok: true, isFull: false, msUntilFull: 6 * 3_600_000, msUntilWaste: 9 * 3_600_000 },
            rerolls: { known: true, available: false, remaining: 0 },
            buffs: [{ name: 'Experience', expiresAt: NOW + 5 * 3_600_000 }],
            consumable: { name: 'Coffee', secondsLeft: Infinity },
            listings: { filled: 0, undercut: 0 },
            enhancement: null,
            guild: null,
            labyrinth: { ok: true, available: 0 },
            idle: [],
        };
        expect(keys(facts)).toEqual([]);
    });

    test('lines come in reading order', () => {
        const facts = {
            queue: { queued: 0 },
            tasksReady: 2,
            labyrinth: { ok: true, available: 3, isFull: false },
            idle: [{ characterName: 'Alt' }],
        };
        expect(keys(facts)).toEqual(['queue', 'tasksReady', 'labyrinth', 'idle']);
    });

    describe('the action queue', () => {
        test('an empty queue is bad news and says since when', () => {
            const entry = line({ queue: { queued: 0, emptySince: NOW - 20 * 60_000 } }, 'queue');
            expect(entry.tone).toBe('bad');
            expect(entry.value).toContain('Empty');
            expect(entry.value).toContain('20m ago');
            expect(entry.target).toBe('queue');
        });

        test('an empty queue with no snapshot says only that it is empty', () => {
            expect(line({ queue: { queued: 0 } }, 'queue').value).toBe('Empty');
        });

        test('a short queue is a warning and a long one is not', () => {
            expect(line({ queue: { queued: 3, seconds: QUEUE_WARN_SECONDS - 1 } }, 'queue').tone).toBe('gold');
            expect(line({ queue: { queued: 3, seconds: QUEUE_WARN_SECONDS + 1 } }, 'queue').tone).toBe('good');
        });

        test('an unbounded action never runs out', () => {
            expect(line({ queue: { queued: 1, seconds: 0, infinite: true } }, 'queue').value).toBe('Running, no end');
        });
    });

    describe('the task board', () => {
        test('a full board reports when the first task is wasted', () => {
            const entry = line({ taskSlots: { ok: true, isFull: true, msUntilWaste: 2 * 3_600_000 } }, 'taskSlots');
            expect(entry.tone).toBe('bad');
            expect(entry.value).toContain('2h');
            expect(entry.target).toBe('tasks');
        });

        test('a board that is already wasting says so', () => {
            const entry = line({ taskSlots: { ok: true, isFull: true, msUntilWaste: -1 } }, 'taskSlots');
            expect(entry.value).toBe('Full — tasks are being wasted');
        });

        test('a deadline more than an hour out is not news', () => {
            const far = { ok: true, isFull: false, msUntilFull: 2 * 3_600_000 };
            const near = { ok: true, isFull: false, msUntilFull: 20 * 60_000 };
            expect(line({ taskSlots: far }, 'taskSlots')).toBeUndefined();
            expect(line({ taskSlots: near }, 'taskSlots').tone).toBe('gold');
        });

        test('a forecast that could not be made produces nothing', () => {
            expect(line({ taskSlots: { ok: false, reason: 'no task cooldown' } }, 'taskSlots')).toBeUndefined();
        });
    });

    test('a free reroll is mentioned only while one is offered', () => {
        expect(line({ rerolls: { known: true, available: true, remaining: 2 } }, 'rerolls').value).toBe('2 free');
        expect(line({ rerolls: { known: true, available: false, remaining: 0 } }, 'rerolls')).toBeUndefined();
        expect(line({ rerolls: { known: false, available: true } }, 'rerolls')).toBeUndefined();
    });

    describe('community buffs', () => {
        test('only ones lapsing within the window, soonest first, counted once', () => {
            const facts = {
                buffs: [
                    { name: 'Gathering', expiresAt: NOW + 40 * 60_000 },
                    { name: 'Experience', expiresAt: NOW + 10 * 60_000 },
                    { name: 'Efficiency', expiresAt: NOW + BUFF_WINDOW_MS + 60_000 },
                ],
            };
            const entry = line(facts, 'buffs');
            expect(entry.value).toContain('Experience in 10m');
            expect(entry.value).toContain('+1 more');
        });

        test('a buff that has already gone is not about to go', () => {
            expect(line({ buffs: [{ name: 'Experience', expiresAt: NOW - 1 }] }, 'buffs')).toBeUndefined();
        });
    });

    describe('consumables', () => {
        test('an unused consumable never runs dry', () => {
            expect(line({ consumable: { name: 'Coffee', secondsLeft: Infinity } }, 'consumable')).toBeUndefined();
        });

        test('a short supply is bad news and a long one is only a figure', () => {
            expect(line({ consumable: { name: 'Coffee', secondsLeft: 600 } }, 'consumable').tone).toBe('bad');
            expect(line({ consumable: { name: 'Coffee', secondsLeft: 86_400 } }, 'consumable').tone).toBe('neutral');
        });
    });

    describe('market listings', () => {
        test('each kind is named and zeroes are left out', () => {
            const entry = line({ listings: { filled: 3, undercut: 1 } }, 'listings');
            expect(entry.value).toBe('3 filled, 1 undercut');
            expect(entry.target).toBe('listings');
        });

        test('nothing happened means no line', () => {
            expect(line({ listings: { filled: 0, undercut: 0 } }, 'listings')).toBeUndefined();
        });
    });

    test('an enhancement run reports its target and protections', () => {
        const facts = {
            enhancement: { itemName: 'Cheese Sword', currentLevel: 4, targetLevel: 8, protectionsUsed: 2 },
        };
        const entry = line(facts, 'enhancement');
        expect(entry.value).toBe('Cheese Sword +4 → +8 · 2 protected');
        expect(entry.target).toBe('enhancement');
    });

    describe('the guild trial', () => {
        test('an unknowable signup is not reported as no signup', () => {
            expect(line({ guild: { signedUp: null } }, 'guild')).toBeUndefined();
        });

        test('not signed up is worth saying', () => {
            expect(line({ guild: { signedUp: false } }, 'guild').value).toBe('Not signed up this week');
        });

        test('a countdown nothing produces is never printed', () => {
            // A guild trial has no scheduled start, so `startsInMs` was a field
            // no collector ever set — the line says what is known and no more
            const facts = { guild: { signedUp: true, trialName: 'combat', startsInMs: 30 * 60_000 } };
            const entry = line(facts, 'guild');
            expect(entry.value).toBe('Signed up: combat');
            expect(entry.tone).toBe('good');
        });
    });

    test('labyrinth entries are only news when there are some', () => {
        expect(line({ labyrinth: { ok: true, available: 0 } }, 'labyrinth')).toBeUndefined();
        expect(line({ labyrinth: { ok: true, available: 5, isFull: true } }, 'labyrinth').value).toBe('5 — capped');
        expect(line({ labyrinth: { ok: true, available: 2, isFull: false } }, 'labyrinth').tone).toBe('good');
    });

    test('idle characters are listed by name', () => {
        const entry = line({ idle: [{ characterName: 'Alt' }, {}] }, 'idle');
        expect(entry.value).toBe('Alt, A character');
        expect(entry.target).toBeNull();
    });

    test('unread notices are reported, and no notices are not', () => {
        expect(keys({ notices: 0 })).toEqual([]);
        expect(keys({})).toEqual([]);

        const entry = line({ notices: 12 }, 'notices');
        expect(entry.value).toBe('12 while you were away');
        expect(entry.target).toBe('notices');
    });

    test('one malformed fact costs its own line and no other', () => {
        const exploding = {
            get buffs() {
                throw new Error('nope');
            },
        };
        const facts = Object.assign(exploding, { queue: { queued: 0 }, idle: [{ characterName: 'Alt' }] });
        expect(keys(facts)).toEqual(['queue', 'idle']);
    });
});

describe('horizons', () => {
    test('a deadline carries the absolute instant its own countdown names', () => {
        expect(line({ queue: { queued: 1, seconds: 600 } }, 'queue').horizon).toEqual({
            at: NOW + 600_000,
            text: 'Queue ends',
            lapses: true,
        });

        expect(line({ consumable: { name: 'Ale', secondsLeft: 7200 } }, 'consumable').horizon).toEqual({
            at: NOW + 7_200_000,
            text: 'Ale runs dry',
            lapses: true,
        });

        expect(line({ buffs: [{ name: 'Gathering', expiresAt: NOW + 900_000 }] }, 'buffs').horizon).toEqual({
            at: NOW + 900_000,
            text: 'Gathering ends',
            lapses: true,
        });
    });

    test('a filling task board lapses at the moment it fills, because the sentence changes', () => {
        const entry = line({ taskSlots: { ok: true, isFull: false, msUntilFull: 40 * 60_000 } }, 'taskSlots');
        expect(entry.horizon).toEqual({ at: NOW + 40 * 60_000, text: 'Task board fills', lapses: true });
    });

    test('a full task board does not lapse — the waste instant only makes it worse', () => {
        const entry = line({ taskSlots: { ok: true, isFull: true, msUntilWaste: 20 * 60_000 } }, 'taskSlots');
        expect(entry.value).toBe('Full — first wasted in 20m');
        expect(entry.horizon).toEqual({
            at: NOW + 20 * 60_000,
            text: 'Full — tasks are being wasted',
            lapses: false,
        });
    });

    test('a board already wasting has no countdown left to carry', () => {
        const entry = line({ taskSlots: { ok: true, isFull: true, msUntilWaste: -1 } }, 'taskSlots');
        expect(entry.value).toBe('Full — tasks are being wasted');
        expect(entry.horizon).toBeUndefined();
    });

    test('readings carry no horizon at all', () => {
        for (const facts of [
            { tasksReady: 3 },
            { rerolls: { known: true, available: true, remaining: 1 } },
            { listings: { filled: 2, undercut: 0 } },
            { enhancement: { itemName: 'Sword', currentLevel: 4, targetLevel: 8 } },
            { guild: { signedUp: false } },
            { labyrinth: { ok: true, available: 3, isFull: true } },
            { notices: 4 },
        ]) {
            for (const entry of buildBriefingLines(facts, NOW)) {
                expect(entry.horizon).toBeUndefined();
            }
        }
    });

    test('an idle queue is a state rather than a deadline', () => {
        expect(line({ queue: { queued: 0 } }, 'queue').horizon).toBeUndefined();
        expect(line({ queue: { queued: 1, infinite: true, seconds: 0 } }, 'queue').horizon).toBeUndefined();
    });
});
