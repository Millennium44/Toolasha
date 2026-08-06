/**
 * The recorder, with the game faked around it.
 *
 * The load-bearing rule is which pairs get written at all. A prediction taken
 * *after* a run finished is measured against gear the run was never played
 * with, so the recorder must refuse it — and the one case where that refusal
 * would be wrong is the run that was already going when the script started,
 * whose forecast is still current. Both are asserted here, because either
 * mistake produces a full-looking history of numbers that mean nothing.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'char-1',
    actionType: '/action_types/milking',
    profitPerHour: 1000,
    /** Loot log handlers, by message type */
    handlers: {},
    stored: {},
    /** What the loot log's own arithmetic says a finished run paid */
    runProfit: { askProfit: 500, bidProfit: 400 },
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, store, fallback) => game.stored[`${store}:${key}`] ?? fallback,
        set: async (key, value, store) => {
            game.stored[`${store}:${key}`] = value;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getActionDetails: () => ({ type: game.actionType }),
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.handlers[type] = handler;
        },
        off: (type) => {
            delete game.handlers[type];
        },
    },
}));
vi.mock('../actions/gathering-profit.js', () => ({
    calculateGatheringProfit: async () => ({ profitPerHour: game.profitPerHour, hasMissingPrices: false }),
}));
vi.mock('../actions/production-profit.js', () => ({
    calculateProductionProfit: async () => ({ profitPerHour: game.profitPerHour, hasMissingPrices: false }),
}));
vi.mock('../actions/loot-log-stats.js', () => ({
    LootLogStats: class {
        calculateProfit() {
            return game.runProfit;
        }
    },
}));
// The work is supposed to wait for a quiet moment; a test has none to wait for
vi.mock('../../utils/background-work.js', () => ({ runInBackground: async (name, work) => await work() }));

const { PredictionCalibration, actionTypeOf } = await import('./prediction-calibration.js');

/**
 * A loot log entry.
 * @param {number} id - characterActionId
 * @param {string} start - ISO start
 * @param {number} minutes - How long it ran
 * @returns {Object}
 */
function entry(id, start, minutes = 60) {
    const startTime = new Date(start);
    return {
        characterActionId: id,
        actionHrid: '/actions/milking/cow',
        startTime: startTime.toISOString(),
        endTime: new Date(startTime.getTime() + minutes * 60_000).toISOString(),
        actionCount: 100,
        drops: { '/items/milk': 100 },
    };
}

let calibration;

beforeEach(async () => {
    game.stored = {};
    game.handlers = {};
    game.profitPerHour = 1000;
    game.runProfit = { askProfit: 500, bidProfit: 400 };
    calibration = new PredictionCalibration();
    await calibration.initialize();
});

/** Deliver a loot log message and wait for the queued pass. */
async function send(lootLog) {
    game.handlers.loot_log_updated({ lootLog });
    await calibration.queue;
}

describe('actionTypeOf', () => {
    test('names the skill an action belongs to', () => {
        expect(actionTypeOf('/actions/milking/cow')).toBe('milking');
        expect(actionTypeOf('')).toBe('unknown');
    });
});

describe('pairing a forecast with a finished run', () => {
    test('writes nothing for the run that is still going', async () => {
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        expect(await calibration.getRecords()).toHaveLength(0);
    });

    test('writes the pair once a later run replaces it', async () => {
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);

        const records = await calibration.getRecords();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ id: 1, actionType: 'milking', predicted: 1000, actual: 500 });
        // The pair is persisted under this character's own key
        expect(game.stored['lootLogHistory:calibration_char-1']).toHaveLength(1);
    });

    test('keeps the forecast taken while the run was going, not a later one', async () => {
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        // Gear changed, so the calculator now says something else entirely
        game.profitPerHour = 9999;
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);

        expect((await calibration.getRecords())[0].predicted).toBe(1000);
    });

    test('refuses a run that was already over when the script started', async () => {
        // Both arrive at once: the older one never had a live forecast taken
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);
        expect(await calibration.getRecords()).toHaveLength(0);
    });

    test('does not write the same run twice', async () => {
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);

        expect(await calibration.getRecords()).toHaveLength(1);
    });

    test('skips runs too short for their rate to mean anything', async () => {
        await send([entry(1, '2026-08-04T10:00:00Z', 0.5)]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z', 0.5)]);

        expect(await calibration.getRecords()).toHaveLength(0);
    });

    test('turns the run total into a rate per hour', async () => {
        // Half an hour of running that paid 500 is 1000/h
        await send([entry(1, '2026-08-04T10:00:00Z', 30)]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z', 30)]);

        expect((await calibration.getRecords())[0].actual).toBe(1000);
    });

    test('records nothing for an action the calculators cannot forecast', async () => {
        game.actionType = '/action_types/combat';
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);

        expect(await calibration.getRecords()).toHaveLength(0);
        game.actionType = '/action_types/milking';
    });

    test('accepts a pair another recorder measured, into the same ledger', async () => {
        const written = await calibration.addRecord({
            id: 'combat|A|2026-08-04T10:00:00Z',
            actionType: 'combat',
            predicted: 1000,
            actual: 900,
            t: Date.now(),
        });

        expect(written).toBe(true);
        // Same store, same key: one history, whoever measured the pair
        expect(game.stored['lootLogHistory:calibration_char-1']).toHaveLength(1);
    });

    test('does not accept the same outside pair twice, nor one without a name', async () => {
        const record = { id: 'combat|A|t', actionType: 'combat', predicted: 1, actual: 1, t: 0 };
        expect(await calibration.addRecord(record)).toBe(true);
        expect(await calibration.addRecord(record)).toBe(false);
        expect(await calibration.addRecord({ actionType: 'combat', predicted: 1, actual: 1 })).toBe(false);
        expect(await calibration.getRecords()).toHaveLength(1);
    });

    test('drops the oldest pairs rather than growing without end', async () => {
        calibration.records = Array.from({ length: 1000 }, (_, i) => ({ id: `old-${i}`, t: i }));
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);

        const records = await calibration.getRecords();
        expect(records).toHaveLength(1000);
        expect(records[0].id).toBe('old-1');
        expect(records[records.length - 1].id).toBe(1);
    });
});
