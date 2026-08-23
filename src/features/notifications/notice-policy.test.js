/**
 * Tests for the delivery policy.
 *
 * Two things here are worth more than the rest. The quiet window that crosses
 * midnight is the case a naive `start <= now && now < end` gets silently
 * backwards — it silences the *day* instead of the night — and it is the case
 * every player who sets quiet hours will use. And the category derivation is
 * what lets sixteen alert features stay untouched, so a key that falls through
 * to `other` is a feature that quietly stops being digestible.
 *
 * The clock is set rather than mocked: quiet hours are local wall-clock
 * arithmetic, and a test that mocks `getHours` would be testing the mock.
 */

import { describe, test, expect } from 'vitest';
import {
    CATEGORIES,
    NOTICE_KINDS,
    DEFAULT_CRITICAL_CATEGORIES,
    DEFAULT_DIGEST_CATEGORIES,
    kindForEventKey,
    categoryForEventKey,
    categoryLabel,
    parseCategoryList,
    isCriticalCategory,
    isDigestCategory,
    parseTimeOfDay,
    isWithinQuietHours,
    summarizeDigest,
} from './notice-policy.js';

/** A local-time moment, so the window arithmetic is exercised in the runner's own zone */
function at(hours, minutes = 0) {
    const date = new Date(2026, 4, 17, hours, minutes, 0, 0);
    return date;
}

describe('categories', () => {
    test('every kind names a category that exists', () => {
        for (const kind of NOTICE_KINDS) {
            expect(Object.keys(CATEGORIES)).toContain(kind.category);
        }
    });

    test.each([
        ['market-undercut-9182', 'market'],
        ['market-listing-filled', 'market'],
        ['community-buff-expiring:/community_buffs/experience:2026-05-17', 'buffs'],
        ['combat-consumable-low', 'consumables'],
        ['consumable-low:/action_types/cheesesmithing', 'consumables'],
        ['empty-queue', 'queue'],
        ['combat-death', 'combat'],
        ['task-slots:full', 'tasks'],
        ['labyrinth-entry:9', 'labyrinth'],
        ['labyrinth-stopped:3', 'labyrinth'],
        ['guild-trial-start:live', 'guild'],
        ['guild-trial-results:2026-05', 'guild'],
        ['skill-levelup:/skills/mining:74', 'skills'],
        ['enhancement-target:/items/cheese:12', 'enhancement'],
        ['ttl-target:/items/milk:100', 'progress'],
    ])('%s belongs to %s', (key, category) => {
        expect(categoryForEventKey(key)).toBe(category);
    });

    test('a key nobody has claimed still has somewhere to go', () => {
        const kind = kindForEventKey('something-nobody-wrote-a-row-for');
        expect(kind.category).toBe('other');
        expect(kind.noun.many).toBe('notices');
    });

    test('the longer prefix wins over a shorter one it contains', () => {
        // Both rows start with `combat-`; a first-match-wins lookup over the
        // declared order would put a dry consumable in the combat category and
        // therefore make it critical by default for the wrong reason
        expect(categoryForEventKey('combat-consumable-low')).toBe('consumables');
        expect(categoryForEventKey('combat-death')).toBe('combat');
    });

    test('an unknown category still gets a label rather than blank', () => {
        expect(categoryLabel('market')).toBe('Market');
        expect(categoryLabel('nonsense')).toBe('nonsense');
        expect(categoryLabel('')).toBe('Other');
    });
});

describe('allow-lists', () => {
    test('a list is read past spacing, capitals and stray commas', () => {
        expect([...parseCategoryList(' Market ,, BUFFS,queue, ')]).toEqual(['market', 'buffs', 'queue']);
        expect(parseCategoryList('').size).toBe(0);
        expect(parseCategoryList(null).size).toBe(0);
    });

    test('the shipped defaults protect exactly the interruptions worth having', () => {
        for (const category of ['combat', 'queue', 'consumables']) {
            expect(isCriticalCategory(category, DEFAULT_CRITICAL_CATEGORIES)).toBe(true);
            expect(isDigestCategory(category, DEFAULT_DIGEST_CATEGORIES)).toBe(false);
        }
        for (const category of ['market', 'buffs', 'tasks']) {
            expect(isCriticalCategory(category, DEFAULT_CRITICAL_CATEGORIES)).toBe(false);
            expect(isDigestCategory(category, DEFAULT_DIGEST_CATEGORIES)).toBe(true);
        }
    });

    test('an empty critical list makes nothing critical', () => {
        expect(isCriticalCategory('combat', '')).toBe(false);
    });
});

describe('quiet hours', () => {
    test('a time is read, and anything that is not one is not', () => {
        expect(parseTimeOfDay('23:00')).toBe(23 * 60);
        expect(parseTimeOfDay('7:05')).toBe(7 * 60 + 5);
        expect(parseTimeOfDay('00:00')).toBe(0);
        expect(parseTimeOfDay('24:00')).toBeNull();
        expect(parseTimeOfDay('12:60')).toBeNull();
        expect(parseTimeOfDay('noon')).toBeNull();
        expect(parseTimeOfDay('')).toBeNull();
    });

    test('a window inside one day is the interval between its ends', () => {
        expect(isWithinQuietHours(at(13, 0), '09:00', '17:00')).toBe(true);
        expect(isWithinQuietHours(at(9, 0), '09:00', '17:00')).toBe(true);
        expect(isWithinQuietHours(at(17, 0), '09:00', '17:00')).toBe(false);
        expect(isWithinQuietHours(at(8, 59), '09:00', '17:00')).toBe(false);
        expect(isWithinQuietHours(at(23, 30), '09:00', '17:00')).toBe(false);
    });

    test('a window that crosses midnight covers both sides of it', () => {
        // The whole reason this function exists: 23:00–07:00 is a night, not an
        // empty range, and not the sixteen hours in between
        expect(isWithinQuietHours(at(23, 0), '23:00', '07:00')).toBe(true);
        expect(isWithinQuietHours(at(2, 30), '23:00', '07:00')).toBe(true);
        expect(isWithinQuietHours(at(6, 59), '23:00', '07:00')).toBe(true);
        expect(isWithinQuietHours(at(7, 0), '23:00', '07:00')).toBe(false);
        expect(isWithinQuietHours(at(12, 0), '23:00', '07:00')).toBe(false);
        expect(isWithinQuietHours(at(22, 59), '23:00', '07:00')).toBe(false);
    });

    test('a window with both ends the same is off rather than eternal', () => {
        expect(isWithinQuietHours(at(3, 0), '23:00', '23:00')).toBe(false);
        expect(isWithinQuietHours(at(23, 0), '23:00', '23:00')).toBe(false);
    });

    test('a half-written setting silences nothing', () => {
        expect(isWithinQuietHours(at(3, 0), '', '07:00')).toBe(false);
        expect(isWithinQuietHours(at(3, 0), '23:00', 'later')).toBe(false);
    });

    test('the window is read off the wall clock, so an offset change cannot move it', () => {
        // Two moments 24h apart in local terms are the same wall-clock time, and
        // this is what stays true through a daylight-saving change: the test
        // does not assert an offset, it asserts that the hour on the clock is
        // the only input
        const night = at(1, 0);
        const nextNight = new Date(night.getTime());
        nextNight.setDate(nextNight.getDate() + 1);
        expect(isWithinQuietHours(night, '23:00', '07:00')).toBe(true);
        expect(isWithinQuietHours(nextNight, '23:00', '07:00')).toBe(true);
    });

    test('a moment that is not a moment is not inside anything', () => {
        expect(isWithinQuietHours(new Date('nope'), '23:00', '07:00')).toBe(false);
    });
});

describe('digest summaries', () => {
    const undercut = { one: 'undercut', many: 'undercuts' };
    const lapsing = { one: 'lapsing', many: 'lapsing' };

    test('an empty batch reads as nothing at all', () => {
        expect(summarizeDigest([])).toBe('');
        expect(summarizeDigest(null)).toBe('');
    });

    test('the summary counts by category and names the subjects', () => {
        const message = summarizeDigest([
            { category: 'market', noun: undercut, subject: 'Cheese' },
            { category: 'market', noun: undercut, subject: 'Milk' },
            { category: 'market', noun: undercut, subject: 'Flax' },
            { category: 'buffs', noun: lapsing, subject: 'Experience' },
        ]);
        expect(message).toBe('Market: 3 undercuts (Cheese, Milk, Flax) · Buffs: 1 lapsing (Experience)');
    });

    test('one of a thing is not pluralised, including the ones that do not take an s', () => {
        expect(summarizeDigest([{ category: 'buffs', noun: lapsing }])).toBe('Buffs: 1 lapsing');
        expect(summarizeDigest([{ category: 'market', noun: undercut }])).toBe('Market: 1 undercut');
    });

    test('the same subject twice is one subject', () => {
        const message = summarizeDigest([
            { category: 'market', noun: undercut, subject: 'Cheese' },
            { category: 'market', noun: undercut, subject: 'Cheese' },
        ]);
        expect(message).toBe('Market: 2 undercuts (Cheese)');
    });

    test('a long list is named up to the limit and then counted', () => {
        const message = summarizeDigest(
            ['Cheese', 'Milk', 'Flax', 'Log', 'Egg'].map((subject) => ({ category: 'market', noun: undercut, subject }))
        );
        expect(message).toBe('Market: 5 undercuts (Cheese, Milk, Flax, +2)');
    });

    test('two kinds inside one category are counted apart', () => {
        const filled = { one: 'filled listing', many: 'filled listings' };
        const message = summarizeDigest([
            { category: 'market', noun: undercut, subject: 'Cheese' },
            { category: 'market', noun: filled },
            { category: 'market', noun: filled },
        ]);
        expect(message).toBe('Market: 1 undercut (Cheese), 2 filled listings');
    });
});
