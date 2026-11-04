/**
 * A trial the game did not run, told apart from a result this client never saw.
 *
 * The claims: the game's list of what a cycle runs is saved with the cycle and
 * carried into the archive and the long-term list; a trial left off a cycle's
 * list reads "n/r" while one with no list to go on reads "—" as it always did; a
 * list held for one kind says nothing of the other; the lists survive a merge
 * between devices whichever way round (convergent, the fuller list kept, a copy
 * kept whole never dropping it); a list outliving its cycle is never filed with
 * the next; and nothing a player acts on — tiers, points, Best, Past weeks —
 * moves by a digit.
 *
 * Fixtures use the game's shapes: the 11/2 test-server cycle ran 6 of the 15
 * trials (4 skilling, 2 combat), read here through the real payload parser.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ testServer: false }));
vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => game.testServer === true,
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback) => fallback,
        tryGet: async () => ({ found: false, value: null }),
        set: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => null } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, onSettingChange: () => () => {} } }));

import {
    cleanScheduled,
    cycleTrialsOf,
    mergeCycleTrials,
    mergeScheduled,
    splitScheduled,
    trialHistoryCells,
    trialHistoryDetail,
    trialHistoryTiers,
    trialResultsHistory,
    trialResultsOf,
    withTrialResults,
} from './guild-trial-results.js';
import {
    archiveCycle,
    archiveEarlierCycles,
    mergeTrialRecords,
    recordScheduled,
    rollRecordToWeek,
    scheduledFromPayload,
    trialHourStartedAt,
    weeklyTrialSetFrom,
} from './guild-trials-store.js';
import { pastCycles, summariseArchivedCycle, FOREIGN_CYCLE_REASON } from './guild-trial-history.js';
import { TRIAL_BUDGET_MS, parseCurrentTrialsData, trialWeekStart } from './guild-trials-math.js';
import { NOV2_CURRENT_TRIALS_DATA } from './guild-trial-points.fixture.js';
import { CURRENT_TRIALS_DATA_SKILLING } from './guild-trial-messages.fixture.js';
import * as CLEARS from './guild-trial-tier-clears.fixture.js';
import { buildGuildUpdated } from '../../__fixtures__/wire/guild-trial.js';

const HOUR = TRIAL_BUDGET_MS;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const now = Date.parse('2026-11-04T12:00:00Z');
const thisWeek = trialWeekStart(now);
const weeksAgo = (n) => thisWeek - n * WEEK;

/** The 11/2 cycle's lists, as the game sent them: 4 of the 10 skilling trials, 2 of the 5 combat */
const NOV2_SKILLING = ['alchemy', 'brewing', 'foraging', 'woodcutting'];
const NOV2_COMBAT = ['jellyfish', 'swarm'];

/** A card or payload-filed tile with a tier */
const skillingTile = (name, tier) => ({
    name,
    kind: 'skilling',
    tier,
    points: 0,
    pointsByTier: { [tier]: 2000 },
    serverTier: tier,
    serverTierAt: 1,
    serverDone: true,
    completed: true,
    samples: [],
    tiers: [],
});
const combatTile = (name, tier) => ({ ...skillingTile(name, tier), kind: 'combat' });

/** An archived cycle as `archiveCycle` writes one */
const entry = (week, tiles, extra = {}) => ({
    archivedAt: week + WEEK,
    reason: 'the week rolled over',
    weekStart: week,
    tiles,
    ...extra,
});

const nov2 = {
    skilling: { trials: NOV2_SKILLING, at: weeksAgo(1) + 2 * DAY },
    combat: { trials: NOV2_COMBAT, at: weeksAgo(1) + 2 * DAY + HOUR },
};

beforeEach(() => {
    game.testServer = false;
});

describe('scheduledFromPayload — the game’s list, read off the real payload', () => {
    test('a finished cycle’s payload states the 6 trials that ran, placed at its newest stamp', () => {
        const read = parseCurrentTrialsData(NOV2_CURRENT_TRIALS_DATA);
        const offset = 44;
        const held = { ...read, at: 1793660000000 };

        const lists = scheduledFromPayload(held, { offset });
        expect(lists.skilling.trials).toEqual(NOV2_SKILLING);
        expect(lists.combat.trials).toEqual(NOV2_COMBAT);
        // Skilling's newest stamp is Alchemy's tierStartedAtMs; combat's is Swarm's
        expect(lists.skilling.at).toBe(1793656808120 + offset);
        expect(lists.combat.at).toBe(1793658094676 + offset);
    });

    test('a finished payload needs the clock offset to be placed, or it is unknown', () => {
        const read = parseCurrentTrialsData(NOV2_CURRENT_TRIALS_DATA);
        expect(scheduledFromPayload({ ...read, at: 1793660000000 }, { offset: null })).toEqual({});
    });

    test('skilling known and combat not yet: only skilling is written', () => {
        // Mid skilling hour: combat is `{status: '', parties: null}`
        const read = parseCurrentTrialsData(CURRENT_TRIALS_DATA_SKILLING);
        const lists = scheduledFromPayload({ ...read, at: 1790716000000 }, { offset: 5_300 });
        expect(Object.keys(lists)).toEqual(['skilling']);
        expect(lists.skilling.trials).toEqual(['alchemy', 'brewing', 'cooking', 'milking']);
    });

    test('a running kind is placed at its hour’s start, the same at every pass', () => {
        const read = parseCurrentTrialsData(CURRENT_TRIALS_DATA_SKILLING);
        const offset = 5_300;
        const first = scheduledFromPayload({ ...read, at: 1790716000000 }, { offset });
        const later = scheduledFromPayload({ ...read, at: 1790716900000 }, { offset });
        expect(first.skilling.at).toBe(trialHourStartedAt(read.skilling, offset));
        expect(later.skilling.at).toBe(first.skilling.at);
    });

    test('empty parties are a record not filled in yet, never a cycle that ran nothing', () => {
        const read = parseCurrentTrialsData(
            JSON.stringify({ skilling: { status: 'in_progress', parties: {} }, combat: { status: '', parties: {} } })
        );
        expect(scheduledFromPayload({ ...read, at: 1 }, { offset: 0 })).toEqual({});
    });

    test('an hrid this build does not know, or one under the wrong kind, is not a trial of the list', () => {
        const read = parseCurrentTrialsData(
            JSON.stringify({
                skilling: {
                    status: 'in_progress',
                    parties: {
                        '/guild_skilling/alchemy': {
                            highestTier: 1,
                            budgetRemainingMs: 3_000_000,
                            tierStartedAtMs: 5e12,
                        },
                        '/guild_skilling/swimming': {
                            highestTier: 1,
                            budgetRemainingMs: 3_000_000,
                            tierStartedAtMs: 5e12,
                        },
                        '/guild_combat/badger': { highestTier: 1, budgetRemainingMs: 3_000_000, tierStartedAtMs: 5e12 },
                    },
                },
            })
        );
        expect(scheduledFromPayload({ ...read, at: 5e12 }, { offset: 0 }).skilling.trials).toEqual(['alchemy']);
    });

    test('a finished payload that outlived its cycle is placed before the running cycle and dropped', () => {
        // At the next cycle's skilling hour the combat side still states the last cycle's two trials
        const read = parseCurrentTrialsData(NOV2_CURRENT_TRIALS_DATA);
        const cycleStart = 1793656808120 + 6 * HOUR;
        const lists = scheduledFromPayload({ ...read, at: cycleStart + 1000 }, { offset: 44, cycleStart });
        expect(lists).toEqual({});
    });
});

describe('recordScheduled — filing the list into the week’s record', () => {
    const week = weeksAgo(1);
    const lists = { skilling: { trials: NOV2_SKILLING, at: week + 2 * DAY } };

    test('files a list placed inside the record’s own week', () => {
        const record = recordScheduled({ weekStart: week, tiles: {} }, lists);
        expect(record.scheduled).toEqual(lists);
    });

    test('a list placed in another week is not this record’s', () => {
        expect(recordScheduled({ weekStart: weeksAgo(2), tiles: {} }, lists)).toEqual({
            weekStart: weeksAgo(2),
            tiles: {},
        });
        const next = { weekStart: week + WEEK, tiles: {} };
        expect(recordScheduled(next, lists)).toBe(next);
    });

    test('the same list again changes nothing, so a pass does not rewrite the record', () => {
        const once = recordScheduled({ weekStart: week, tiles: {} }, lists);
        expect(recordScheduled(once, lists)).toBe(once);
        // …nor the same cycle’s list placed a few seconds later, or a subset of it
        expect(recordScheduled(once, { skilling: { trials: ['alchemy'], at: lists.skilling.at + 5_000 } })).toBe(once);
    });

    test('a later cycle’s list replaces the earlier’s whole; an earlier one cannot', () => {
        const once = recordScheduled({ weekStart: week, tiles: {} }, lists);
        const nextCycle = { skilling: { trials: ['cooking', 'milking'], at: lists.skilling.at + 4 * HOUR } };
        const second = recordScheduled(once, nextCycle);
        expect(second.scheduled.skilling.trials).toEqual(['cooking', 'milking']);
        expect(recordScheduled(second, lists)).toBe(second);
    });
});

describe('mergeScheduled — two devices’ lists', () => {
    const at = weeksAgo(1) + 2 * DAY;
    const a = { skilling: { trials: ['alchemy', 'brewing'], at } };
    const b = { skilling: { trials: ['alchemy', 'foraging', 'woodcutting'], at: at + 20 * 60_000 } };
    const next = { skilling: { trials: ['cooking'], at: at + 4 * HOUR } };

    test('one cycle stated twice keeps the fuller list, either way round', () => {
        const ab = mergeScheduled(a, b);
        expect(ab).toEqual(mergeScheduled(b, a));
        expect(ab.skilling.trials).toEqual(['alchemy', 'brewing', 'foraging', 'woodcutting']);
        expect(ab.skilling.at).toBe(b.skilling.at);
    });

    test('a later cycle’s list wins whole, and an earlier cycle’s is not added to it', () => {
        expect(mergeScheduled(a, next)).toEqual(next);
        expect(mergeScheduled(next, a)).toEqual(next);
    });

    test('is associative, so three devices converge whatever order they pull in', () => {
        const orders = [
            mergeScheduled(mergeScheduled(a, b), next),
            mergeScheduled(a, mergeScheduled(b, next)),
            mergeScheduled(mergeScheduled(next, a), b),
            mergeScheduled(mergeScheduled(b, next), a),
        ];
        for (const order of orders) expect(order).toEqual(orders[0]);
    });

    test('each kind on its own: a side holding only one kind leaves the other as it was', () => {
        const combat = { combat: { trials: NOV2_COMBAT, at } };
        expect(mergeScheduled(a, combat)).toEqual({ ...a, ...combat });
        expect(mergeScheduled(null, null)).toBeNull();
    });

    test('a malformed side is no list', () => {
        expect(cleanScheduled({ skilling: { trials: [], at } })).toBeNull();
        expect(cleanScheduled({ skilling: { trials: ['alchemy'], at: 'soon' } })).toBeNull();
        expect(cleanScheduled('alchemy')).toBeNull();
    });
});

describe('archiveCycle — the list goes with the cycle it described', () => {
    const week = weeksAgo(1);
    const live = () => ({
        weekStart: week,
        tiles: {
            'skilling::alchemy': skillingTile('Alchemy', 20),
            'combat::trial swarm': combatTile('Trial Swarm', 21),
        },
        scheduled: {
            skilling: { trials: NOV2_SKILLING, at: week + 2 * DAY },
            combat: { trials: NOV2_COMBAT, at: week + 2 * DAY + HOUR },
        },
        history: [],
    });

    test('the archived cycle holds it, the live record does not, and the slim list is kept beside the results', () => {
        const archived = archiveCycle(live(), 'the week rolled over', week + WEEK);
        expect(archived.history).toHaveLength(1);
        expect(archived.history[0].scheduled.skilling.trials).toEqual(NOV2_SKILLING);
        expect(archived.scheduled).toBeUndefined();
        expect(archived.cycleTrials).toEqual([
            { weekStart: week, cycleFrom: null, skilling: NOV2_SKILLING, combat: NOV2_COMBAT },
        ]);
    });

    test('a week rolling over carries the slim list to the new week and never the live lists', () => {
        const rolled = rollRecordToWeek(live(), week + WEEK);
        expect(rolled.scheduled).toBeUndefined();
        expect(rolled.cycleTrials[0]).toMatchObject({ weekStart: week, skilling: NOV2_SKILLING });
        expect(rolled.history[0].scheduled).toBeDefined();
    });

    test('a record that never had a list archives into the shape it always had', () => {
        const record = live();
        delete record.scheduled;
        const archived = archiveCycle(record, 'the week rolled over', week + WEEK);
        expect(archived.history[0]).not.toHaveProperty('scheduled');
        expect(archived).not.toHaveProperty('cycleTrials');
        expect(archived).not.toHaveProperty('scheduled');
    });

    test('another guild’s cycle keeps no list and leaves none behind', () => {
        const archived = archiveCycle(live(), FOREIGN_CYCLE_REASON, week + WEEK);
        expect(archived.history[0]).not.toHaveProperty('scheduled');
        expect(archived).not.toHaveProperty('cycleTrials');
    });

    test('the same cycle archived twice keeps the list even when the copy that states more has none', () => {
        const first = archiveCycle(live(), 'the week rolled over', week + WEEK);
        // A second archive of the week off cards that state more, but from a record that never saw the list
        const fuller = {
            weekStart: week,
            tiles: { ...live().tiles, 'skilling::brewing': skillingTile('Brewing', 19) },
            history: first.history,
        };
        const second = archiveCycle(fuller, 'the week rolled over', week + WEEK);
        expect(second.history).toHaveLength(1);
        expect(Object.keys(second.history[0].tiles)).toContain('skilling::brewing');
        expect(second.history[0].scheduled.skilling.trials).toEqual(NOV2_SKILLING);
    });
});

describe('archiveEarlierCycles — one list per cycle on the test server', () => {
    const read = parseCurrentTrialsData(
        JSON.stringify({
            skilling: { status: 'in_progress', parties: CLEARS.LAST_PAYLOAD_PARTIES },
            combat: { status: '', parties: null },
        })
    );
    const offset = CLEARS.SERVER_CLOCK_OFFSET_MS;
    const skillingStart = trialHourStartedAt(read.skilling, offset);
    const lastCycle = skillingStart - 5 * HOUR;
    const old = {
        skilling: { trials: ['cooking', 'milking'], at: lastCycle },
        combat: { trials: ['badger', 'chameleon'], at: lastCycle + HOUR },
    };
    const current = { skilling: { trials: ['alchemy', 'brewing'], at: skillingStart } };
    const record = (extra = {}) => ({
        weekStart: 0,
        tiles: {
            'skilling::cooking': {
                name: 'Cooking',
                kind: 'skilling',
                tierSeenAt: { 20: lastCycle + 60_000 },
                tier: 20,
            },
            'skilling::alchemy': { name: 'Alchemy', kind: 'skilling', tierSeenAt: { 16: skillingStart + 120_000 } },
        },
        history: [],
        ...extra,
    });

    test('the last cycle’s lists go to its archive, and this cycle’s are filed after it', () => {
        const next = archiveEarlierCycles(record({ scheduled: old }), read, { offset, at: 9 });
        expect(next.history).toHaveLength(1);
        expect(next.history[0].scheduled).toEqual(old);
        expect(next).not.toHaveProperty('scheduled');
        expect(recordScheduled({ ...next, weekStart: trialWeekStart(skillingStart) }, current).scheduled).toEqual(
            current
        );
        expect(next.cycleTrials).toEqual([
            expect.objectContaining({ skilling: ['cooking', 'milking'], combat: ['badger', 'chameleon'] }),
        ]);
    });

    test('this cycle’s list written before the archive is not filed as the last cycle’s', () => {
        // The new payload's skilling list was filed first, over the old one; combat's old list is still there
        const held = record({ scheduled: { skilling: current.skilling, combat: old.combat } });
        const next = archiveEarlierCycles(held, read, { offset, at: 9 });
        expect(next.history[0].scheduled).toEqual({ combat: old.combat });
        expect(next.scheduled).toEqual(current);
    });

    test('a list that outlived its tiles is dropped, not filed with the next cycle’s', () => {
        const stale = record({ scheduled: { skilling: current.skilling, combat: old.combat } });
        stale.tiles = { 'skilling::alchemy': stale.tiles['skilling::alchemy'] };
        const next = archiveEarlierCycles(stale, read, { offset, at: 9 });
        expect(next.history).toHaveLength(0);
        expect(next.scheduled).toEqual(current);
    });

    test('with nothing earlier and nothing stale the same record comes back', () => {
        const held = record({ scheduled: current });
        held.tiles = { 'skilling::alchemy': held.tiles['skilling::alchemy'] };
        expect(archiveEarlierCycles(held, read, { offset, at: 9 })).toBe(held);
    });

    test('splitScheduled leaves a kind with no boundary where it is', () => {
        const split = splitScheduled(old, { skilling: lastCycle + 1, combat: null });
        expect(Object.keys(split.earlier)).toEqual(['skilling']);
        expect(Object.keys(split.current)).toEqual(['combat']);
    });
});

describe('mergeTrialRecords — the fields survive a merge between devices', () => {
    const week = weeksAgo(1);
    const at = week + 2 * DAY;
    const side = (scheduled, extra = {}) => ({
        weekStart: week,
        tiles: {},
        guildId: 'g1',
        guildName: 'SuperMoo',
        history: [],
        trialResults: [],
        ...(scheduled ? { scheduled } : {}),
        ...extra,
    });

    test('two devices with different lists of one cycle converge on the fuller one in both orders', () => {
        const a = side({ skilling: { trials: ['alchemy', 'brewing'], at } });
        const b = side({
            skilling: { trials: ['alchemy', 'foraging', 'woodcutting'], at: at + 10 * 60_000 },
            combat: { trials: NOV2_COMBAT, at: at + HOUR },
        });
        const ab = mergeTrialRecords(a, b);
        const ba = mergeTrialRecords(b, a);
        expect(ab).toEqual(ba);
        expect(ab.scheduled.skilling.trials).toEqual(['alchemy', 'brewing', 'foraging', 'woodcutting']);
        expect(ab.scheduled.combat.trials).toEqual(NOV2_COMBAT);
    });

    test('a device with no list leaves the other’s untouched', () => {
        const a = side(null);
        const b = side({ skilling: { trials: NOV2_SKILLING, at } });
        expect(mergeTrialRecords(a, b).scheduled).toEqual(b.scheduled);
        expect(mergeTrialRecords(b, a).scheduled).toEqual(b.scheduled);
        // And two devices with none merge into the shape they always had
        expect(mergeTrialRecords(a, side(null))).not.toHaveProperty('scheduled');
    });

    test('a record taken whole keeps its lists and its slim list', () => {
        const held = side({ skilling: { trials: NOV2_SKILLING, at } });
        held.cycleTrials = [{ weekStart: weeksAgo(2), cycleFrom: null, skilling: NOV2_SKILLING }];
        const whole = mergeTrialRecords(null, held);
        expect(whole.scheduled).toEqual(held.scheduled);
        expect(whole.cycleTrials).toEqual(held.cycleTrials);
        expect(mergeTrialRecords(held, null).cycleTrials).toEqual(held.cycleTrials);
    });

    test('a stale device’s copy of an archived cycle’s list is not brought back to life', () => {
        const archived = side(null, {
            history: [entry(week, { 'skilling::alchemy': skillingTile('Alchemy', 20) }, { scheduled: nov2 })],
        });
        const stale = side(nov2);
        const merged = mergeTrialRecords(archived, stale);
        expect(merged).not.toHaveProperty('scheduled');
        expect(mergeTrialRecords(stale, archived)).toEqual(merged);
        expect(merged.cycleTrials[0].skilling).toEqual(NOV2_SKILLING);
    });

    test('an older week’s record is archived with its list when a newer week’s merges over it', () => {
        const older = {
            weekStart: weeksAgo(2),
            tiles: { 'skilling::alchemy': skillingTile('Alchemy', 20) },
            history: [],
            scheduled: { skilling: { trials: NOV2_SKILLING, at: weeksAgo(2) + 2 * DAY } },
        };
        const newer = side({ skilling: { trials: ['cooking'], at: week + 3 * DAY } });
        const merged = mergeTrialRecords(older, newer);
        expect(merged.scheduled.skilling.trials).toEqual(['cooking']);
        expect(merged.cycleTrials.find((cycle) => cycle.weekStart === weeksAgo(2)).skilling).toEqual(NOV2_SKILLING);
        expect(mergeTrialRecords(newer, older)).toEqual(merged);
    });

    test('two archives of one cycle fold into one that holds both statements', () => {
        const tiles = { 'skilling::alchemy': skillingTile('Alchemy', 20) };
        const a = side(null, { history: [entry(week, tiles, { scheduled: { skilling: nov2.skilling } })] });
        const b = side(null, {
            history: [
                entry(
                    week,
                    { ...tiles, 'skilling::brewing': skillingTile('Brewing', 19) },
                    { scheduled: { combat: nov2.combat } }
                ),
            ],
        });
        const ab = mergeTrialRecords(a, b);
        expect(ab.history).toHaveLength(1);
        expect(ab.history[0].scheduled).toEqual(nov2);
        expect(mergeTrialRecords(b, a).history[0].scheduled).toEqual(nov2);
        expect(ab.cycleTrials).toEqual(mergeTrialRecords(b, a).cycleTrials);
    });

    test('another guild’s record brings none of its lists', () => {
        const mine = side({ skilling: { trials: ['cooking'], at } });
        const theirs = side(nov2, { guildId: 'g2', guildName: 'Elsewhere' });
        expect(mergeTrialRecords(mine, theirs).scheduled).toEqual(mine.scheduled);
    });
});

describe('the history — "n/r" against "—"', () => {
    const w1 = weeksAgo(1);
    const w2 = weeksAgo(2);
    const w3 = weeksAgo(3);
    // 11/2's cycle (w1), a cycle from before this change (w2), and a cycle whose only list is skilling's (w3)
    const history = [
        entry(
            w3,
            {
                'skilling::alchemy': skillingTile('Alchemy', 17),
                'combat::trial badger': combatTile('Trial Badger', 12),
            },
            { scheduled: { skilling: { trials: ['brewing', 'cooking'], at: w3 + 2 * DAY } } }
        ),
        entry(w2, {
            'skilling::alchemy': skillingTile('Alchemy', 18),
            'combat::trial swarm': combatTile('Trial Swarm', 19),
        }),
        entry(
            w1,
            {
                'skilling::alchemy': skillingTile('Alchemy', 20),
                'combat::trial swarm': combatTile('Trial Swarm', 21),
                'skilling::foraging': skillingTile('Foraging', 18),
            },
            { scheduled: nov2 }
        ),
    ];
    const record = { weekStart: thisWeek, tiles: {}, history };
    const view = (cycleTrials) => trialResultsHistory(trialResultsOf(record), { now, cycleTrials });
    const row = (rows, id) => rows.find((r) => r.id === id);

    test('a trial the cycle’s list leaves off is "n/r"; one with no list to go on stays "—"', () => {
        const { rows } = view(cycleTrialsOf(record));
        // Weeks run newest first: w1, w2, w3
        const badger = row(rows, 'combat:badger');
        expect(badger.weeks.map((week) => week.notRun === true)).toEqual([true, false, false]);
        expect(trialHistoryTiers(badger)).toBe('n/r · — · T12');

        const swarm = row(rows, 'combat:swarm');
        // w3's list is skilling only, so combat there is unknown, not "did not run"
        expect(swarm.weeks.map((week) => week.notRun === true)).toEqual([false, false, false]);
        expect(trialHistoryTiers(swarm)).toBe('T21 · T19 · —');

        const alchemy = row(rows, 'skilling:alchemy');
        // Alchemy was left off w3's list yet has a result: the result wins, and nothing is marked
        expect(alchemy.weeks.every((week) => !week.notRun)).toBe(true);
        expect(trialHistoryTiers(alchemy)).toBe('T20 · T18 · T17');

        // Foraging ran in w1, has no result in w2 (no list: unknown) and w3 (not on that list)
        const foraging = row(rows, 'skilling:foraging');
        expect(trialHistoryTiers(foraging)).toBe('T18 · — · n/r');
    });

    test('a cycle from before the change, and a cycle this client was absent for, read "—"', () => {
        const { rows } = view(cycleTrialsOf({ history: [history[1]] }));
        for (const r of rows) for (const week of r.weeks) expect(week.notRun).toBeUndefined();
        expect(trialHistoryTiers(row(rows, 'combat:badger'))).toBe('— · — · T12');
    });

    test('the hover and its key say which is which', () => {
        const { rows } = view(cycleTrialsOf(record));
        const detail = trialHistoryDetail(row(rows, 'combat:badger'));
        expect(detail).toMatch(/: did not run$/m);
        expect(detail).toContain('"n/r" is a cycle the game’s own list says the trial did not run in');
        expect(detail).toContain('"—" is a cycle this client has no result for');
        expect(detail).toContain('T12');
        expect(trialHistoryCells(row(rows, 'combat:badger'))).toContain('n/r');
    });

    test('tiers, points, Best and every total are exactly what they were without the lists', () => {
        const without = view([]);
        const withLists = view(cycleTrialsOf(record));
        const strip = (shown) => ({
            cycles: shown.cycles,
            rows: shown.rows.map((r) => ({
                ...r,
                weeks: r.weeks.map(({ notRun: _marker, ...rest }) => rest),
            })),
        });
        expect(strip(withLists)).toEqual(without);
        expect(withLists.rows.map((r) => r.best)).toEqual(without.rows.map((r) => r.best));

        // Past weeks and the results the totals come from read the archive, and a list on an entry changes neither
        const bare = history.map(({ scheduled: _dropped, ...rest }) => rest);
        expect(trialResultsOf({ history: bare })).toEqual(trialResultsOf({ history }));
        expect(
            pastCycles(history, now).map((cycle) => summariseArchivedCycle(cycle, { now, buildersHallBonus: 0.4 }))
        ).toEqual(pastCycles(bare, now).map((cycle) => summariseArchivedCycle(cycle, { now, buildersHallBonus: 0.4 })));
        // The slim list is the only thing added, and only where a list was kept
        const stored = withTrialResults({ ...record, history });
        expect(stored.trialResults).toEqual(trialResultsOf({ history: bare }));
        expect(withTrialResults({ ...record, history: bare })).not.toHaveProperty('cycleTrials');
    });

    test('the slim list is capped with the results and a cycle’s kinds are unioned, not replaced', () => {
        const merged = mergeCycleTrials(
            [{ weekStart: w1, cycleFrom: null, skilling: ['alchemy'] }],
            [{ weekStart: w1, cycleFrom: null, skilling: ['brewing'], combat: ['swarm'] }],
            [{ weekStart: w1, cycleFrom: null }],
            [null, { weekStart: 'x' }]
        );
        expect(merged).toEqual([
            { weekStart: w1, cycleFrom: null, skilling: ['alchemy', 'brewing'], combat: ['swarm'] },
        ]);
    });

    test('a test-server week’s cycles each keep their own list', () => {
        game.testServer = true;
        const first = { weekStart: w1, cycleFrom: w1 + HOUR, skilling: ['alchemy'] };
        const second = { weekStart: w1, cycleFrom: w1 + 6 * HOUR, skilling: ['cooking'] };
        const merged = mergeCycleTrials([second], [first]);
        expect(merged).toEqual([first, second]);
    });
});

describe('a finished kind’s list counts only inside the cycle that is running', () => {
    const read = parseCurrentTrialsData(NOV2_CURRENT_TRIALS_DATA);
    const offset = 44;
    const held = { ...read, at: 1793660000000 };
    // Skilling's hour ended at 1793656808120, so it began an hour before; combat's began as it ended
    const cycleStart = 1793656808120 - HOUR + offset;

    test('both finished lists are filed against the cycle they ran in', () => {
        game.testServer = true;
        const lists = scheduledFromPayload(held, { offset, cycleStart });
        expect(lists.skilling.trials).toEqual(NOV2_SKILLING);
        expect(lists.combat.trials).toEqual(NOV2_COMBAT);
    });

    test('a last cycle’s combat list whose newest stamp is inside the 60 s window is not this cycle’s', () => {
        game.testServer = true;
        // The next cycle began 30 s after the last combat party banked its tier
        const next = 1793658094676 + offset + 30_000;
        expect(scheduledFromPayload({ ...held, at: next + 1_000 }, { offset, cycleStart: next })).toEqual({});
    });

    test('a list with one stamp before the cycle began is no list, whatever the others say', () => {
        game.testServer = true;
        const mixed = parseCurrentTrialsData(
            JSON.stringify({
                skilling: { status: 'completed', parties: null },
                combat: {
                    status: 'completed',
                    parties: {
                        '/guild_combat/jellyfish': {
                            highestTier: 3,
                            budgetRemainingMs: 0,
                            highestTierReachedAtMs: cycleStart - HOUR,
                            tierStartedAtMs: cycleStart - 20_000,
                            done: true,
                        },
                    },
                },
            })
        );
        expect(scheduledFromPayload({ ...mixed, at: cycleStart }, { offset: 0, cycleStart })).toEqual({});
    });

    test('a list stamped after the cycle’s span is a later cycle’s, which this cycle’s start cannot place', () => {
        game.testServer = true;
        expect(scheduledFromPayload(held, { offset, cycleStart: cycleStart - DAY })).toEqual({});
    });

    test('on the test server a finished list with no cycle start to hold it against is unknown', () => {
        game.testServer = true;
        expect(scheduledFromPayload(held, { offset })).toEqual({});
    });

    test('on live a finished list whose stamps are in two weeks is unknown', () => {
        const wide = parseCurrentTrialsData(
            JSON.stringify({
                skilling: { status: 'completed', parties: null },
                combat: {
                    status: 'completed',
                    parties: {
                        '/guild_combat/jellyfish': {
                            highestTier: 3,
                            budgetRemainingMs: 0,
                            highestTierReachedAtMs: thisWeek - 1000,
                            tierStartedAtMs: thisWeek + 1000,
                            done: true,
                        },
                    },
                },
            })
        );
        expect(scheduledFromPayload({ ...wide, at: thisWeek }, { offset: 0 })).toEqual({});
    });
});

describe('the game’s draw for the cycle joins a running list and never makes one', () => {
    const draw = weeklyTrialSetFrom(buildGuildUpdated());
    const running = (skilling, combat = { status: '', parties: null }) =>
        parseCurrentTrialsData(JSON.stringify({ skilling, combat }));
    const party = (started) => ({
        highestTier: 1,
        budgetRemainingMs: HOUR - 60_000,
        tierStartedAtMs: started,
        highestTierReachedAtMs: started,
        done: false,
    });
    const T = 1793700000000;

    test('reads the wire shape: hrids to trial keys, per kind', () => {
        expect(draw).toEqual({ skilling: NOV2_SKILLING, combat: NOV2_COMBAT });
        expect(weeklyTrialSetFrom({})).toBeNull();
        expect(weeklyTrialSetFrom({ guildWeeklyTrialSet: 'x' })).toBeNull();
        // A hrid under the wrong list, or one this build does not know, is no trial of that kind
        expect(
            weeklyTrialSetFrom({
                guildWeeklyTrialSet: {
                    skillHrids: ['/guild_combat/swarm', '/guild_skilling/swimming'],
                    combatHrids: [],
                },
            })
        ).toEqual({ skilling: [], combat: [] });
    });

    test('a running hour whose parties name two of the four drawn trials is filed with all four', () => {
        const read = running({
            status: 'in_progress',
            parties: { '/guild_skilling/alchemy': party(T), '/guild_skilling/woodcutting': party(T) },
        });
        const lists = scheduledFromPayload({ ...read, at: T, weeklyTrials: draw }, { offset: 0 });
        expect(lists.skilling.trials).toEqual(NOV2_SKILLING);
        // Without the draw the same payload would have marked Brewing and Foraging as not run
        expect(scheduledFromPayload({ ...read, at: T }, { offset: 0 }).skilling.trials).toEqual([
            'alchemy',
            'woodcutting',
        ]);
    });

    test('the draw alone files nothing: a kind with no party named is still unknown', () => {
        const read = running({ status: 'in_progress', parties: {} });
        expect(scheduledFromPayload({ ...read, at: T, weeklyTrials: draw }, { offset: 0 })).toEqual({});
        // …and combat, not yet started, takes nothing from a draw that names its trials
        const skillingOnly = running({ status: 'in_progress', parties: { '/guild_skilling/alchemy': party(T) } });
        const lists = scheduledFromPayload({ ...skillingOnly, at: T, weeklyTrials: draw }, { offset: 0 });
        expect(Object.keys(lists)).toEqual(['skilling']);
    });

    test('a finished kind is read from its parties alone: the draw outlives its cycle', () => {
        game.testServer = true;
        const read = parseCurrentTrialsData(NOV2_CURRENT_TRIALS_DATA);
        const finished = { ...read, at: 1793660000000, weeklyTrials: { skilling: ['cooking'], combat: ['badger'] } };
        const lists = scheduledFromPayload(finished, { offset: 44, cycleStart: 1793656808120 - HOUR + 44 });
        expect(lists.skilling.trials).toEqual(NOV2_SKILLING);
        expect(lists.combat.trials).toEqual(NOV2_COMBAT);
    });
});

describe('one cycle’s lists are one cycle whichever hour slot they were placed in', () => {
    // A cycle that began at half past: its start-of-hour list and its end-of-hour list straddle a wall-clock hour
    const startOfHour = weeksAgo(1) + 2 * DAY + 30 * 60_000;
    const full = { skilling: { trials: NOV2_SKILLING, at: startOfHour } };
    const partial = { skilling: { trials: ['alchemy', 'brewing'], at: startOfHour + 50 * 60_000 } };

    test('a partial list placed in a later hour slot does not shrink the fuller one, in either order', () => {
        expect(Math.floor(partial.skilling.at / HOUR)).toBeGreaterThan(Math.floor(full.skilling.at / HOUR));
        const merged = mergeScheduled(full, partial);
        expect(merged.skilling.trials).toEqual(NOV2_SKILLING);
        expect(mergeScheduled(partial, full)).toEqual(merged);
    });

    test('filing a partial list from a later slot leaves the record as it was', () => {
        const record = { weekStart: weeksAgo(1), tiles: {}, scheduled: full };
        expect(recordScheduled(record, partial)).toBe(record);
    });

    test('a fuller list from a later slot is added to the held one', () => {
        const record = { weekStart: weeksAgo(1), tiles: {}, scheduled: partial };
        expect(recordScheduled(record, full).scheduled.skilling.trials).toEqual(NOV2_SKILLING);
    });

    test('the next day’s list is still a new cycle’s, and replaces the last whole', () => {
        const nextDay = { skilling: { trials: ['cooking'], at: startOfHour + DAY } };
        expect(mergeScheduled(full, nextDay)).toEqual(nextDay);
        expect(mergeScheduled(nextDay, mergeScheduled(full, partial))).toEqual(nextDay);
    });

    test('three devices fold to one answer in every grouping', () => {
        const third = { skilling: { trials: ['foraging'], at: startOfHour + 10 * 60_000 } };
        const orders = [
            mergeScheduled(mergeScheduled(full, partial), third),
            mergeScheduled(full, mergeScheduled(partial, third)),
            mergeScheduled(mergeScheduled(third, partial), full),
        ];
        for (const order of orders) expect(order).toEqual(orders[0]);
        expect(orders[0].skilling.trials).toEqual(NOV2_SKILLING);
    });
});

describe('archiveEarlierCycles — a list goes only with the cycle its tiles are from', () => {
    const read = parseCurrentTrialsData(
        JSON.stringify({
            skilling: { status: 'in_progress', parties: CLEARS.LAST_PAYLOAD_PARTIES },
            combat: { status: '', parties: null },
        })
    );
    const offset = CLEARS.SERVER_CLOCK_OFFSET_MS;
    const skillingStart = trialHourStartedAt(read.skilling, offset);
    const lastCycle = skillingStart - DAY;
    const tiles = {
        'skilling::cooking': { name: 'Cooking', kind: 'skilling', tierSeenAt: { 20: lastCycle + 60_000 }, tier: 20 },
    };

    test('a list from the cycle before that one is not archived as that one’s', () => {
        // This cycle's list was never filed; the day before's was left on the record (or a stored copy brought it back)
        const held = {
            weekStart: 0,
            tiles,
            history: [],
            scheduled: {
                skilling: { trials: ['alchemy'], at: lastCycle - DAY },
                combat: { trials: ['badger'], at: lastCycle + HOUR },
            },
        };
        const next = archiveEarlierCycles(held, read, { offset, at: 9 });
        expect(next.history).toHaveLength(1);
        expect(next.history[0].scheduled).toEqual({ combat: held.scheduled.combat });
    });
});
