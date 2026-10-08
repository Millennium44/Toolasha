/* global process */
/**
 * The per-day recorders' retention windows, as sync judges them. Key shapes are the ones the recorders write
 * (`<prefix>_<charId>_<YYYY-MM-DD>` for the 100-day recorders, `_<YYYY-MM>` for the 400-day ones). The rule is
 * checked against the recorders' own pruning (`localDayId(now - days)`, chunked by the UTC date of the row's
 * local midnight) in time zones on both sides of UTC and across DST changes.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/storage.js', () => ({ default: {} }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { on: () => {}, off: () => {}, getCurrentCharacterId: () => 'me', isFromActiveSocket: () => true },
}));

const { retentionDrops, mergeForKey } = await import('../../utils/sync-merge-registry.js');
const { timeChunkId } = await import('../../utils/chunked-history.js');
const { localDayId, dayStart } = await import('./gold-sources.js');
// Importing the recorders registers their rules, the way the page does
await import('./combat-loot-recorder.js');
await import('./item-flow-recorder.js');
await import('./chest-opening-recorder.js');
await import('./production-income-recorder.js');

const STORE = 'networthHistory';
const DAY = 86400000;
const NOW = Date.UTC(2026, 11, 28, 12, 0, 0);
const originalTZ = process.env.TZ;

/**
 * The local day id `n` calendar days from the local day of `t`
 * @param {number} t - Epoch ms
 * @param {number} n - Days
 * @returns {string} Day id
 */
const dayAt = (t, n) => {
    const date = new Date(t);
    return localDayId(new Date(date.getFullYear(), date.getMonth(), date.getDate() + n, 12).getTime());
};

describe('per-day recorder retention', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
        if (originalTZ === undefined) delete process.env.TZ;
        else process.env.TZ = originalTZ;
    });

    test.each(['combatLootRec', 'itemFlowRec'])('%s drops day keys older than 100 days, keeps the rest', (prefix) => {
        process.env.TZ = 'UTC';
        const key = (n) => `${prefix}_32030_${timeChunkId(dayStart(dayAt(NOW, n)), 'day')}`;
        const drops = retentionDrops(STORE, [key(-99), key(-100), key(-101), key(-103), key(0)]);
        expect([...drops].sort()).toEqual([key(-101), key(-103)].sort());
    });

    // Every zone, at instants around the DST changes of the Americas and Auckland. The recorder keeps a row
    // when its local day id is not before `localDayId(now - days)`; a key must go exactly when no row it can
    // hold survives that
    const zones = [
        'UTC',
        'America/New_York',
        'America/Los_Angeles',
        'Pacific/Auckland',
        'Asia/Kolkata',
        'Pacific/Kiritimati',
    ];
    const instants = [
        Date.UTC(2026, 11, 28, 12),
        Date.UTC(2026, 2, 8, 6, 30),
        Date.UTC(2026, 2, 9, 5, 30),
        Date.UTC(2026, 10, 1, 4, 30),
        Date.UTC(2026, 3, 4, 13, 30),
        Date.UTC(2026, 8, 26, 12, 30),
    ];
    const cases = zones.flatMap((zone) => instants.map((instant) => [zone, instant]));

    test.each(cases)('day keys are judged as the recorder judges the row, in %s at %i', (zone, instant) => {
        process.env.TZ = zone;
        vi.setSystemTime(instant);
        const floor = localDayId(instant - 100 * DAY);
        const newest = `combatLootRec_1_${timeChunkId(dayStart(localDayId(instant)), 'day')}`;
        const keys = [newest];
        const expected = new Set();
        for (let n = -108; n <= -92; n++) {
            const rowDay = dayAt(instant, n);
            const key = `combatLootRec_1_${timeChunkId(dayStart(rowDay), 'day')}`;
            keys.push(key);
            // The recorder deletes the key exactly when its row is before the floor
            if (rowDay < floor) expected.add(key);
        }
        const drops = retentionDrops(STORE, keys);
        for (const key of keys) expect(drops.has(key), key).toBe(expected.has(key));
    });

    test.each(cases)('month keys are kept while a surviving row can be in them, in %s at %i', (zone, instant) => {
        process.env.TZ = zone;
        vi.setSystemTime(instant);
        const floor = localDayId(instant - 400 * DAY);
        const newest = `chestOpenRec_1_${timeChunkId(dayStart(localDayId(instant)), 'month')}`;
        /** key -> whether some row day the recorder files under it survives the floor */
        const survives = new Map();
        for (let n = -440; n <= -380; n++) {
            const rowDay = dayAt(instant, n);
            const key = `chestOpenRec_1_${timeChunkId(dayStart(rowDay), 'month')}`;
            survives.set(key, survives.get(key) || rowDay >= floor);
        }
        const drops = retentionDrops(STORE, [newest, ...survives.keys()]);
        for (const [key, keeps] of survives) expect(drops.has(key), key).toBe(!keeps);
    });

    test.each(['chestOpenRec', 'prodIncomeRec'])('%s judges a month key by its last day, over 400 days', (prefix) => {
        process.env.TZ = 'UTC';
        // 400 days before 2026-12-28 is 2025-11-23: November 2025 can still hold a kept day, October cannot
        const nov = `${prefix}_32030_2025-11`;
        const oct = `${prefix}_32030_2025-10`;
        const cur = `${prefix}_32030_2026-12`;
        expect([...retentionDrops(STORE, [nov, oct, cur])]).toEqual([oct]);
    });

    test('an idle character keeps its history: the cut never passes the newest key less the window', () => {
        process.env.TZ = 'America/New_York';
        vi.setSystemTime(Date.UTC(2027, 5, 1));
        const prefix = 'combatLootRec';
        const newest = `${prefix}_32030_2026-12-28`;
        const aged = `${prefix}_32030_2026-10-01`;
        expect([...retentionDrops(STORE, [newest, aged])]).toEqual([]);
    });

    test("an idle character's newest month key caps from the month's first day, not its last", () => {
        process.env.TZ = 'UTC';
        vi.setSystemTime(Date.UTC(2028, 5, 1));
        // Last recorded on 2026-01-01: the recorder's last prune then kept rows from 2024-11-27 on
        const prefix = 'chestOpenRec';
        const newest = `${prefix}_32030_2026-01`;
        const kept = `${prefix}_32030_2024-11`;
        expect([...retentionDrops(STORE, [newest, kept])]).toEqual([]);
    });

    test('characters are judged separately and unparsable keys are left alone', () => {
        process.env.TZ = 'UTC';
        const a = `combatLootRec_111_${localDayId(NOW)}`;
        const b = 'combatLootRec_222_2026-01-01';
        const b2 = `combatLootRec_222_${localDayId(NOW)}`;
        const tomb = 'combatLootRecTomb_111';
        const legacy = 'combatLoot_111';
        expect([...retentionDrops(STORE, [a, b, b2, tomb, legacy])]).toEqual([b]);
    });

    test('a folded month chunk drops the rows past the window, so the gist cannot hand them back', () => {
        process.env.TZ = 'UTC';
        const registration = mergeForKey(STORE, 'chestOpenRec_32030_2025-11');
        // 400 days back from 2026-12-28 is 2025-11-23: the 20th is past it, the 25th is not
        const local = [{ d: '2025-11-25', openings: {} }];
        const gist = [
            { d: '2025-11-20', openings: {} },
            { d: '2025-11-25', openings: {} },
        ];

        expect(registration.mergeForPull(local, gist).map((row) => row.d)).toEqual(['2025-11-25']);
    });

    test('a folded chunk of an idle character is never written empty', () => {
        process.env.TZ = 'UTC';
        vi.setSystemTime(Date.UTC(2027, 5, 1));
        const registration = mergeForKey(STORE, 'combatLootRec_32030_2026-10-01');
        const local = [{ d: '2026-10-01', openings: {} }];
        const gist = [{ d: '2026-10-01', openings: {} }];

        const folded = registration.mergeForPull(local, gist);

        expect(folded.map((row) => row.d)).toEqual(['2026-10-01']);
    });
});
