/**
 * The per-day recorders' retention windows, as sync judges them. Key shapes are the ones the recorders write
 * (`<prefix>_<charId>_<YYYY-MM-DD>` for the 100-day recorders, `_<YYYY-MM>` for the 400-day ones).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/storage.js', () => ({ default: {} }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { on: () => {}, off: () => {}, getCurrentCharacterId: () => 'me', isFromActiveSocket: () => true },
}));

const { retentionDrops, mergeForKey } = await import('../../utils/sync-merge-registry.js');
// Importing the recorders registers their rules, the way the page does
await import('./combat-loot-recorder.js');
await import('./item-flow-recorder.js');
await import('./chest-opening-recorder.js');
await import('./production-income-recorder.js');

const STORE = 'networthHistory';
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const NOW = Date.UTC(2026, 11, 28, 12, 0, 0);

describe('per-day recorder retention', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    test.each(['combatLootRec', 'itemFlowRec'])('%s drops day keys older than 100 days, keeps the rest', (prefix) => {
        const keep = `${prefix}_32030_${iso(NOW - 99 * 86400000)}`;
        const edge = `${prefix}_32030_${iso(NOW - 100 * 86400000)}`;
        const old = `${prefix}_32030_${iso(NOW - 103 * 86400000)}`;
        const today = `${prefix}_32030_${iso(NOW)}`;
        const drops = retentionDrops(STORE, [keep, edge, old, today]);
        expect([...drops]).toEqual([old]);
    });

    test.each(['chestOpenRec', 'prodIncomeRec'])('%s judges a month key by its last day, over 400 days', (prefix) => {
        // 400 days before 2026-12-28 is 2025-11-23: November 2025 can still hold a kept day, October cannot
        const nov = `${prefix}_32030_2025-11`;
        const oct = `${prefix}_32030_2025-10`;
        const cur = `${prefix}_32030_2026-12`;
        expect([...retentionDrops(STORE, [nov, oct, cur])]).toEqual([oct]);
    });

    test('an idle device is never judged against a clock later than its newest key', () => {
        const prefix = 'combatLootRec';
        vi.setSystemTime(Date.UTC(2027, 5, 1));
        const newest = `${prefix}_32030_2026-12-28`;
        const aged = `${prefix}_32030_2026-10-01`; // 88 days before the newest key, 243 before the clock
        expect([...retentionDrops(STORE, [newest, aged])]).toEqual([]);
    });

    test('characters are judged separately and unparsable keys are left alone', () => {
        const a = `combatLootRec_111_${iso(NOW)}`;
        const b = `combatLootRec_222_2026-01-01`;
        const b2 = `combatLootRec_222_${iso(NOW)}`;
        const tomb = 'combatLootRecTomb_111';
        const legacy = 'combatLoot_111';
        expect([...retentionDrops(STORE, [a, b, b2, tomb, legacy])]).toEqual([b]);
    });

    test('a folded month chunk drops the rows past the window, so the gist cannot hand them back', () => {
        const registration = mergeForKey(STORE, 'chestOpenRec_32030_2025-11');
        // Rows 400 days back from 2026-12-28 is 2025-11-23: the 20th is past it, the 25th is not
        const local = [{ d: '2025-11-25', openings: {} }];
        const gist = [
            { d: '2025-11-20', openings: {} },
            { d: '2025-11-25', openings: {} },
        ];

        const folded = registration.mergeForPull(local, gist);

        expect(folded.map((row) => row.d)).toEqual(['2025-11-25']);
    });
});
