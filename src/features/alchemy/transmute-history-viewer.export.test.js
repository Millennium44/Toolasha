/**
 * The CSV/text export reads only `.profit` — since the qualifications the
 * on-screen table marks with a symbol (*†‡◇§: unpriced input, an unpriced or
 * unrecorded or estimated catalyst, a repaired self-return count) have no way
 * to reach it. An exported row read more confident than the same row on
 * screen, which is the failure mode every fix in this history-viewer family has
 * been about. `buildDataNote` is the fix: it spells out every qualification in
 * readable text (a CSV reader has no legend for the symbols) into the existing
 * "Data Note" column, reusing the mechanism the session-repair work already
 * put there.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, prices: {} }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_id, fallback) => fallback },
}));
vi.mock('../../core/websocket.js', () => ({
    default: { on: () => {}, off: () => {}, onSocketEvent: () => {}, offSocketEvent: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid] ?? null,
        getCurrentCharacterId: () => 'char-1',
        getCurrentCharacterGameMode: () => 'standard',
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => game.prices[hrid] ?? 0,
    getItemPrices: () => null,
    getItemPriceInfo: (hrid) => ({ price: game.prices[hrid] ?? null, source: 'book', estimated: false }),
    getPricingMode: () => 'ask',
}));
vi.mock('./alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({
        load: async () => [],
        save: async () => true,
        clear: async () => {},
        forget: () => {},
    }),
    NO_CHARACTER: 'none',
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');

const GEM = '/items/gem';
const SHARD = '/items/shard';
const PRIME = '/items/prime_catalyst';

/**
 * @param {Object} [overrides] - Session fields
 * @returns {Object} A stored session
 */
const session = (overrides = {}) => ({
    id: 'transmute_1',
    trackerVersion: 2,
    startTime: 1,
    inputItemHrid: GEM,
    totalAttempts: 100,
    totalSuccesses: 80,
    bulkMultiplier: 1,
    results: { [SHARD]: { count: 80, totalValue: 56000, priceEach: 700 } },
    catalystsUsed: { [PRIME]: 80 },
    ...overrides,
});

beforeEach(() => {
    game.items = {
        [GEM]: { name: 'gem', alchemyDetail: { bulkMultiplier: 1 } },
        [SHARD]: { name: 'shard' },
        [PRIME]: { name: 'prime catalyst' },
    };
    game.prices = { [GEM]: 500, [SHARD]: 700, [PRIME]: 1000 };
    transmuteHistoryViewer.profitCache.clear();
});

describe('buildDataNote', () => {
    test('a clean session — priced input, priced+recorded catalyst, no repair — gets an empty note', () => {
        const detail = transmuteHistoryViewer.computeSessionProfit(session());
        expect(transmuteHistoryViewer.buildDataNote(session(), detail)).toBe('');
    });

    test('an unpriced input says the total is incomplete', () => {
        game.prices[GEM] = 0;
        const s = session();
        const detail = transmuteHistoryViewer.computeSessionProfit(s);
        expect(detail.inputUnpriced).toBe(true);
        expect(transmuteHistoryViewer.buildDataNote(s, detail)).toContain('input unpriced — total is incomplete');
    });

    test('an unpriced catalyst says it was excluded, not free', () => {
        game.prices[PRIME] = 0;
        const s = session();
        const detail = transmuteHistoryViewer.computeSessionProfit(s);
        expect(detail.catalystUnpriced).toBe(true);
        expect(transmuteHistoryViewer.buildDataNote(s, detail)).toContain(
            'catalyst could not be priced — excluded, not zero'
        );
    });

    test('a session that predates catalyst tracking says the catalyst was not recorded', () => {
        const s = session({ catalystsUsed: undefined, predictedCatalystHrid: undefined });
        const detail = transmuteHistoryViewer.computeSessionProfit(s);
        expect(detail.catalystUnrecorded).toBe(true);
        expect(transmuteHistoryViewer.buildDataNote(s, detail)).toContain(
            'catalyst not recorded (predates tracking) — excluded, not zero'
        );
    });

    test('a session predicted from the slot at start says the catalyst is estimated', () => {
        const s = session({ catalystsUsed: undefined, predictedCatalystHrid: PRIME });
        const detail = transmuteHistoryViewer.computeSessionProfit(s);
        expect(detail.catalystEstimated).toBe(true);
        expect(transmuteHistoryViewer.buildDataNote(s, detail)).toContain('catalyst estimated, not measured');
    });

    test('a repaired self-return count is carried over, without the on-screen warning glyph', () => {
        const s = session({ repair: { outcome: 'repaired', from: 40, to: 80 } });
        const detail = transmuteHistoryViewer.computeSessionProfit(s);
        const note = transmuteHistoryViewer.buildDataNote(s, detail);
        expect(note).toContain('Self-return count repaired');
        expect(note).not.toContain('⚠');
    });

    test('an unpriced output and a pre-fix session land in the note', () => {
        const s = session({
            trackerVersion: undefined,
            results: { [SHARD]: { count: 80, totalValue: 0, priceEach: 0, unpriced: true } },
        });
        const detail = transmuteHistoryViewer.computeSessionProfit(s);
        const note = transmuteHistoryViewer.buildDataNote(s, detail);
        expect(note).toContain('output unpriced — revenue is incomplete');
        expect(note).toContain('recorded before the 2026-09-23 tracker fix');
    });

    test('several qualifications on one session all land in the note', () => {
        game.prices[GEM] = 0;
        game.prices[PRIME] = 0;
        const s = session();
        const detail = transmuteHistoryViewer.computeSessionProfit(s);
        const note = transmuteHistoryViewer.buildDataNote(s, detail);
        expect(note).toContain('input unpriced');
        expect(note).toContain('catalyst could not be priced');
    });
});

describe('exportHistory', () => {
    /** @returns {string} The CSV text passed to the Blob constructor */
    function captureCsv() {
        const OriginalBlob = globalThis.Blob;
        let captured = null;
        const spy = vi.spyOn(globalThis, 'Blob').mockImplementation(
            class {
                constructor(parts, opts) {
                    captured = parts[0];
                    return new OriginalBlob(parts, opts);
                }
            }
        );
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        transmuteHistoryViewer.exportHistory();

        spy.mockRestore();
        return captured;
    }

    test('the header includes a Data Note column', () => {
        transmuteHistoryViewer.sessions = [];
        const csv = captureCsv();
        expect(csv.split('\n')[0]).toContain('"Data Note"');
    });

    test('a qualified row carries the readable note in the CSV', () => {
        game.prices[GEM] = 0;
        transmuteHistoryViewer.sessions = [session()];
        const csv = captureCsv();
        const dataRow = csv.split('\n')[1];
        expect(dataRow).toContain('input unpriced — total is incomplete');
    });

    test("a clean row's Data Note cell is empty", () => {
        transmuteHistoryViewer.sessions = [session()];
        const csv = captureCsv();
        const dataRow = csv.split('\n')[1];
        // The row ends in an empty quoted cell — no stray note text leaks in
        expect(dataRow.trimEnd()).toMatch(/,""$/);
    });
});
