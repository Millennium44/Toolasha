/**
 * The skilling half of a trial, off the socket.
 *
 * Every payload here is one the game actually sent — three consecutive
 * `guild_skilling_updated` ticks and the `end_guild_skilling` that followed
 * them, from a guildmate's raw recording of a Crafting trial. What is worth
 * asserting is that the pool, the tier and the personal figures come out of the
 * message rather than out of a tab that has to be open, and that a message this
 * module does not recognise changes nothing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ wsHandlers: {} }));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.wsHandlers[type] = handler;
        },
        off: (type) => delete game.wsHandlers[type],
    },
}));

const {
    END_SKILLING_MESSAGE,
    guildTrialSkilling,
    NEW_SKILLING_MESSAGE,
    personalFromSkilling,
    readSkillingUpdate,
    SKILLING_FRESH_MS,
    SKILLING_MESSAGE,
    SKILLING_SAMPLE_MS,
} = await import('./guild-trial-skilling.js');

const { END_GUILD_SKILLING, GUILD_SKILLING_TICKS } = await import('./guild-trial-messages.fixture.js');

const now = Date.parse('2026-08-03T15:59:52Z');

describe('readSkillingUpdate', () => {
    test('reads the pool, the tier and who is in it, from the game’s own words', () => {
        const update = readSkillingUpdate(GUILD_SKILLING_TICKS[0], now);

        expect(update.trial).toMatchObject({ kind: 'skilling', key: 'crafting', name: 'Crafting' });
        expect(update.tier).toBe(10);
        expect(update.reading).toEqual({ current: 21_608, max: 88_920 });
        expect(update.participantIds).toHaveLength(17);
        expect(update.participantIds).toContain(910007);
    });

    test('the pool confirms the derived ladder on arrival', () => {
        // Crafting's first tier is 76,000 of work; seventeen participants add
        // one per cent each, and 76,000 × 1.17 is 88,920 exactly
        const { reading } = readSkillingUpdate(GUILD_SKILLING_TICKS[0], now);
        expect(reading.max).toBe(76_000 * 1.17);
    });

    test('a trial hrid it does not recognise is not a trial', () => {
        expect(readSkillingUpdate({ trialHrid: '/guild_skilling/knitting' })).toBeNull();
        // A combat trial is not this module's
        expect(readSkillingUpdate({ trialHrid: '/guild_combat/badger', tier: 3 })).toBeNull();
        expect(readSkillingUpdate(null)).toBeNull();
    });

    test('a payload with no pool on it still yields its tier and participants', () => {
        const update = readSkillingUpdate({ trialHrid: '/guild_skilling/milking', tier: 4, participantIds: [7] }, now);
        expect(update.reading).toBeNull();
        expect(update.tier).toBe(4);
        expect(update.participantIds).toEqual([7]);
    });
});

describe('personalFromSkilling', () => {
    test('the per-tier figures the DOM footer was being scraped for', () => {
        expect(personalFromSkilling(GUILD_SKILLING_TICKS[0])).toEqual({
            'Success Rate': '8.0%',
            Efficiency: '61.5%',
            'Double Progress': '0.0%',
            'Work Power': '161',
            'Work Time': '4.46s',
        });
    });

    test('a stated zero is kept and a missing figure is not invented', () => {
        // A double-progress chance of zero is a fact about the trial; a field
        // the payload does not carry is not a zero and gets no row
        expect(personalFromSkilling({ doubleProgressChance: 0 })).toEqual({ 'Double Progress': '0.0%' });
        expect(personalFromSkilling({})).toEqual({});
        expect(personalFromSkilling(null)).toEqual({});
    });
});

describe('the live skilling tracker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        guildTrialSkilling.initialize();
        guildTrialSkilling.reset();
    });

    afterEach(() => {
        guildTrialSkilling.cleanup();
        vi.useRealTimers();
    });

    test('every message in the family is listened to', () => {
        for (const type of [SKILLING_MESSAGE, NEW_SKILLING_MESSAGE, END_SKILLING_MESSAGE]) {
            expect(typeof game.wsHandlers[type]).toBe('function');
        }
    });

    test('a trial is looked up by the name its card carries', () => {
        game.wsHandlers[SKILLING_MESSAGE](GUILD_SKILLING_TICKS[0]);

        expect(guildTrialSkilling.forTrial('Crafting')).toMatchObject({ tier: 10 });
        expect(guildTrialSkilling.forTrial('Milking')).toBeNull();
    });

    test('a reading that has stopped arriving stops standing in', () => {
        game.wsHandlers[SKILLING_MESSAGE](GUILD_SKILLING_TICKS[0]);
        expect(guildTrialSkilling.forTrial('Crafting', now + SKILLING_FRESH_MS)).toBeTruthy();
        expect(guildTrialSkilling.forTrial('Crafting', now + SKILLING_FRESH_MS + 1)).toBeNull();
    });

    test('participation is an answer rather than an inference', () => {
        game.wsHandlers[SKILLING_MESSAGE](GUILD_SKILLING_TICKS[0]);

        expect(guildTrialSkilling.participating('Crafting', 910007)).toBe(true);
        expect(guildTrialSkilling.participating('Crafting', 999999)).toBe(false);
        // Not knowable is not "not in it": no update, no answer
        expect(guildTrialSkilling.participating('Milking', 910007)).toBeNull();
    });

    test('a downsampled, timestamped series is kept for the export', () => {
        const tick = GUILD_SKILLING_TICKS[0]; // Crafting, tier 10
        // Three ticks inside one sample window keep only the first
        game.wsHandlers[SKILLING_MESSAGE](tick);
        vi.setSystemTime(now + 2000);
        game.wsHandlers[SKILLING_MESSAGE](tick);
        vi.setSystemTime(now + 5000);
        game.wsHandlers[SKILLING_MESSAGE](tick);
        // One past the window earns a second point
        vi.setSystemTime(now + SKILLING_SAMPLE_MS + 1);
        game.wsHandlers[SKILLING_MESSAGE](tick);

        const series = guildTrialSkilling.snapshot().series.crafting;
        expect(series).toHaveLength(2);
        expect(series[0]).toMatchObject({ at: now, tier: 10 });
        expect(series[0].max).toBeGreaterThan(0);
        expect(series[1].at).toBe(now + SKILLING_SAMPLE_MS + 1);
    });

    test('a tier change is kept even inside the sample window', () => {
        game.wsHandlers[SKILLING_MESSAGE](GUILD_SKILLING_TICKS[0]); // tier 10
        vi.setSystemTime(now + 1000);
        game.wsHandlers[SKILLING_MESSAGE]({ ...GUILD_SKILLING_TICKS[0], tier: 11 });

        expect(guildTrialSkilling.snapshot().series.crafting.map((p) => p.tier)).toEqual([10, 11]);
    });

    test('the end message states the tier banked, not the tier running', () => {
        // The recording has this arriving while tier 10 was in progress — the
        // game confirming the badge semantics this feature reasoned its way to
        game.wsHandlers[SKILLING_MESSAGE](GUILD_SKILLING_TICKS[0]);
        expect(guildTrialSkilling.forTrial('Crafting').tier).toBe(10);

        game.wsHandlers[END_SKILLING_MESSAGE](END_GUILD_SKILLING);
        expect(guildTrialSkilling.endedFor('Crafting')).toMatchObject({ tier: 9 });
    });

    test('a trial that reports again has not ended after all', () => {
        game.wsHandlers[END_SKILLING_MESSAGE](END_GUILD_SKILLING);
        expect(guildTrialSkilling.endedFor('Crafting')).toBeTruthy();

        game.wsHandlers[SKILLING_MESSAGE](GUILD_SKILLING_TICKS[0]);
        expect(guildTrialSkilling.endedFor('Crafting')).toBeNull();
    });

    test('the opening message is read with the same parser, unobserved as it is', () => {
        // Nothing has ever been seen of `new_guild_skilling`. One carrying a pool
        // is used; one carrying nothing recognisable changes nothing
        game.wsHandlers[NEW_SKILLING_MESSAGE]({
            trialHrid: '/guild_skilling/crafting',
            tier: 1,
            targetWorkValue: 76_760,
            currentWorkValue: 0,
        });
        expect(guildTrialSkilling.forTrial('Crafting')).toMatchObject({ tier: 1 });

        game.wsHandlers[NEW_SKILLING_MESSAGE]({ nothing: true });
        expect(guildTrialSkilling.forTrial('Crafting').tier).toBe(1);
    });

    test('a malformed payload is logged rather than thrown', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => game.wsHandlers[SKILLING_MESSAGE](null)).not.toThrow();
        expect(() => game.wsHandlers[END_SKILLING_MESSAGE]({ trialHrid: 7 })).not.toThrow();
        spy.mockRestore();
    });

    test('the snapshot is what the export carries', () => {
        game.wsHandlers[SKILLING_MESSAGE](GUILD_SKILLING_TICKS[2]);
        const snapshot = guildTrialSkilling.snapshot();

        expect(snapshot.updates.crafting).toMatchObject({ tier: 10, actionCounter: 85 });
        expect(snapshot.ended).toEqual({});
    });
});
