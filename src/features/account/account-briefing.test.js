/**
 * What an old briefing line is still allowed to claim.
 *
 * This is the whole risk of showing an account-wide briefing at all: every line
 * about an alt was true at a moment that has passed, and a line that goes on
 * counting down from a moment that has passed is not stale, it is wrong. So the
 * assertions here are mostly about what *disappears* and about the shape of what
 * survives — never a countdown, always either an absolute instant or a claim the
 * clock cannot touch.
 */

import { describe, test, expect } from 'vitest';
import {
    DIM_AFTER_MS,
    absoluteTime,
    ageBriefingLines,
    accountBriefings,
    briefingFromLiveFacts,
    briefingFromSnapshot,
    snapshotSubjects,
} from './account-briefing.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

/** A line as the engine builds it, with a horizon. */
const deadline = (at, text, lapses = true) => ({
    key: 'consumable',
    label: 'First to run dry',
    value: 'Ale in 3h',
    tone: 'bad',
    target: 'consumables',
    horizon: { at, text, lapses },
});

/** A line with nothing time-bound about it. */
const reading = () => ({ key: 'tasksReady', label: 'Tasks to claim', value: '3 waiting', tone: 'gold' });

describe('ageBriefingLines', () => {
    test('a deadline that has passed is gone, not shown smaller', () => {
        const snapshotAt = NOW - 5 * HOUR;
        const lines = [deadline(snapshotAt + 3 * HOUR, 'Ale runs dry')];
        expect(ageBriefingLines(lines, snapshotAt, NOW)).toEqual([]);
    });

    test('a deadline that has not passed is restated absolutely, never as a countdown', () => {
        const snapshotAt = NOW - 2 * HOUR;
        const [line] = ageBriefingLines([deadline(snapshotAt + 3 * HOUR, 'Ale runs dry')], snapshotAt, NOW);

        expect(line.value).toMatch(/^Ale runs dry at /);
        // The recorded countdown is what must not survive, in any wording
        expect(line.value).not.toContain('3h');
        expect(line.value).not.toContain('in ');
    });

    test('a horizon more than a day out carries the day, so the clock time is not the wrong day', () => {
        const [line] = ageBriefingLines([deadline(NOW + 30 * HOUR, 'Ale runs dry')], NOW, NOW);
        expect(line.value).toMatch(/^Ale runs dry at \w{3} /);
    });

    test('a claim that only matures keeps its subject and loses its time', () => {
        const snapshotAt = NOW - 5 * HOUR;
        const line = deadline(snapshotAt + 20 * 60_000, 'Full — tasks are being wasted', false);
        const [aged] = ageBriefingLines([line], snapshotAt, NOW);
        expect(aged.value).toBe('Full — tasks are being wasted');
        expect(aged.value).not.toMatch(/\d/);
    });

    test('a reading survives whatever the clock does, and keeps its recorded figure', () => {
        const snapshotAt = NOW - 30 * HOUR;
        const [line] = ageBriefingLines([reading()], snapshotAt, NOW);
        expect(line.value).toBe('3 waiting');
        expect(line.ageMs).toBe(30 * HOUR);
    });

    test('every line carries the age of the snapshot, and dims a day past it', () => {
        const fresh = ageBriefingLines([reading()], NOW - DIM_AFTER_MS + 1000, NOW);
        expect(fresh[0].dim).toBe(false);

        const old = ageBriefingLines([reading()], NOW - DIM_AFTER_MS - 1000, NOW);
        expect(old[0].dim).toBe(true);
        expect(old[0].ageMs).toBe(DIM_AFTER_MS + 1000);
    });

    test('a snapshot stamped in the future is zero old rather than negative', () => {
        const [line] = ageBriefingLines([reading()], NOW + HOUR, NOW);
        expect(line.ageMs).toBe(0);
        expect(line.dim).toBe(false);
    });

    test('the exact instant of a horizon counts as passed', () => {
        expect(ageBriefingLines([deadline(NOW, 'Ale runs dry')], NOW - HOUR, NOW)).toEqual([]);
        expect(ageBriefingLines([deadline(NOW + 1, 'Ale runs dry')], NOW - HOUR, NOW)).toHaveLength(1);
    });

    test('nothing to age is not an error', () => {
        expect(ageBriefingLines(null, NOW, NOW)).toEqual([]);
        expect(ageBriefingLines([null, undefined], NOW, NOW)).toEqual([]);
    });

    test('a malformed horizon is treated as no horizon rather than as expired', () => {
        const line = { ...reading(), horizon: { text: 'nope' } };
        expect(ageBriefingLines([line], NOW, NOW)).toHaveLength(1);
    });
});

describe('absoluteTime', () => {
    test('is never a duration', () => {
        for (const offset of [60_000, 5 * HOUR, 40 * HOUR]) {
            const text = absoluteTime(NOW + offset, NOW);
            expect(text).not.toMatch(/\bago\b|\bin\b/);
            expect(text).toMatch(/\d{1,2}:\d{2}/);
        }
    });
});

describe('snapshotSubjects', () => {
    test('drops the subjects a snapshot cannot carry, so every character is asked the same questions', () => {
        const facts = {
            tasksReady: 3,
            queue: { queued: 0 },
            buffs: [{ name: 'Gathering', expiresAt: NOW }],
            idle: [{ characterName: 'Alt' }],
            notices: 12,
            labyrinth: { ok: true, available: 2 },
        };
        expect(Object.keys(snapshotSubjects(facts)).sort()).toEqual(['labyrinth', 'tasksReady']);
    });

    test('nothing at all is an empty bag rather than a throw', () => {
        expect(snapshotSubjects(null)).toEqual({});
    });
});

describe('briefingFromSnapshot', () => {
    test('builds against the snapshot’s clock, then ages the result', () => {
        const snapshot = {
            at: NOW - 2 * HOUR,
            facts: { tasksReady: 3, consumable: { name: 'Ale', secondsLeft: 3 * 3600 } },
        };
        const briefing = briefingFromSnapshot(snapshot, NOW);

        expect(briefing.at).toBe(NOW - 2 * HOUR);
        expect(briefing.lines.map((line) => line.key)).toEqual(['tasksReady', 'consumable']);
        // Recorded three hours from a moment two hours ago: one hour left, and
        // the only honest way to say it is the instant itself
        expect(briefing.lines[1].value).toMatch(/^Ale runs dry at /);
        expect(briefing.lines.every((line) => line.ageMs === 2 * HOUR)).toBe(true);
    });

    test('a snapshot whose every line has expired says nothing rather than something old', () => {
        const snapshot = { at: NOW - 9 * HOUR, facts: { consumable: { name: 'Ale', secondsLeft: 3 * 3600 } } };
        expect(briefingFromSnapshot(snapshot, NOW).lines).toEqual([]);
    });

    test('a character that was already out of a consumable still says so', () => {
        // `secondsLeft` is 0 when the stock is gone and the burn rate is not,
        // so the line's horizon lands on the snapshot instant itself. A
        // lapsing horizon at `now` is one no replay can ever be earlier than,
        // so the line was dropped on every read — the one character genuinely
        // out of drinks was the one the panel said nothing about, while the
        // ones with hours left got "Ale runs dry at 14:20".
        //
        // The task board's own already-matured case does this right (an
        // already-wasting board keeps a horizon-less line); this is that.
        const snapshot = { at: NOW - HOUR, facts: { consumable: { name: 'Ale', secondsLeft: 0 } } };
        const briefing = briefingFromSnapshot(snapshot, NOW);

        expect(briefing.lines.map((line) => line.key)).toEqual(['consumable']);
        expect(briefing.lines[0].value).not.toMatch(/ at /);
        // And still there a week later — nothing about the clock makes it false
        expect(briefingFromSnapshot(snapshot, NOW + 7 * 24 * HOUR).lines).toHaveLength(1);
    });

    test('a character with no snapshot is unknown, not quiet', () => {
        expect(briefingFromSnapshot(null, NOW)).toBeNull();
        expect(briefingFromSnapshot({ facts: {} }, NOW)).toBeNull();
    });

    test('a snapshot with no facts is a character we looked at and found nothing for', () => {
        const briefing = briefingFromSnapshot({ at: NOW - HOUR, facts: {} }, NOW);
        expect(briefing).not.toBeNull();
        expect(briefing.lines).toEqual([]);
    });
});

describe('briefingFromLiveFacts', () => {
    test('is current by construction — no age, no dimming, no restating', () => {
        const briefing = briefingFromLiveFacts({ consumable: { name: 'Ale', secondsLeft: 3 * 3600 } }, NOW);
        expect(briefing.lines[0].value).toBe('Ale in 3h');
        expect(briefing.lines[0].ageMs).toBe(0);
        expect(briefing.lines[0].dim).toBe(false);
    });

    test('is narrowed to the same subjects as a snapshot', () => {
        const briefing = briefingFromLiveFacts({ queue: { queued: 0 }, notices: 5, tasksReady: 2 }, NOW);
        expect(briefing.lines.map((line) => line.key)).toEqual(['tasksReady']);
    });
});

describe('accountBriefings', () => {
    const characters = [
        { id: 'here', name: 'Alpha', isCurrent: true },
        { id: 'alt', name: 'Beta', isCurrent: false },
        { id: 'quiet', name: 'Gamma', isCurrent: false },
        { id: 'never', name: 'Delta', isCurrent: false },
    ];

    const snapshots = {
        // Deliberately also present for the current character, and deliberately
        // stale: the live facts must win
        here: { at: NOW - 40 * HOUR, facts: { tasksReady: 9 } },
        alt: { at: NOW - 3 * HOUR, facts: { tasksReady: 3 } },
        quiet: { at: NOW - HOUR, facts: {} },
    };

    test('the current character comes from the game, not from its own stale record', () => {
        const [alpha] = accountBriefings({ characters, snapshots, liveFacts: { tasksReady: 1 }, now: NOW });
        expect(alpha.lines[0].value).toBe('1 waiting');
        expect(alpha.at).toBe(NOW);
        expect(alpha.known).toBe(true);
    });

    test('nothing found and never looked at are told apart', () => {
        const rows = accountBriefings({ characters, snapshots, liveFacts: {}, now: NOW });
        const by = Object.fromEntries(rows.map((row) => [row.id, row]));

        expect(by.quiet.known).toBe(true);
        expect(by.quiet.lines).toEqual([]);
        expect(by.never.known).toBe(false);
        expect(by.never.at).toBeNull();
    });

    test('the current character falls back to its snapshot when the live read failed', () => {
        const [alpha] = accountBriefings({ characters, snapshots, liveFacts: null, now: NOW });
        expect(alpha.lines[0].value).toBe('9 waiting');
        expect(alpha.lines[0].dim).toBe(true);
    });

    test('order and names are the account panel’s, untouched', () => {
        const rows = accountBriefings({ characters, snapshots, liveFacts: {}, now: NOW });
        expect(rows.map((row) => row.name)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    });

    test('no characters is no rows', () => {
        expect(accountBriefings({ characters: null, snapshots: null })).toEqual([]);
    });
});
