/**
 * The CSV export used to read only `.profit`, with no way to say an exported
 * total is incomplete when the input could not be priced — the on-screen
 * Profit column marks that with a `*`, and the export silently dropped it. A
 * qualified row then read more confident in the spreadsheet than it did on
 * screen. `buildDataNote` fixes that: a "Data Note" cell (the same column name
 * the transmute viewer already carries) spells the qualification out in
 * readable text, empty when nothing qualifies the row.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const INPUT_HRID = '/items/cotton';
const CATALYST_HRID = '/items/catalyst_of_decomposition';

const state = vi.hoisted(() => ({ mode: 'conservative', inputPriced: true }));

vi.mock('./decompose-history-tracker.js', () => ({
    decomposeHistoryTracker: { on: () => {}, off: () => {}, loadSessions: async () => [] },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (key, fallback) => fallback },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getItemDetails: (itemHrid) =>
            itemHrid === INPUT_HRID ? { name: 'Cotton', itemLevel: 1, alchemyDetail: { bulkMultiplier: 1 } } : null,
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
    },
}));

function priceFor(itemHrid, options) {
    if (options?.context !== 'profit' || options?.side !== 'buy') return null;
    if (itemHrid === INPUT_HRID) return state.inputPriced ? (state.mode === 'optimistic' ? 100 : 200) : 0;
    if (itemHrid === CATALYST_HRID) return 50;
    return null;
}

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid, options) => priceFor(itemHrid, options),
    getItemPriceInfo: (itemHrid, options) => {
        const price = priceFor(itemHrid, options);
        return { price, source: price === null ? null : 'book', estimated: false };
    },
}));

const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');

const session = () => ({
    id: 's1',
    trackerVersion: 2,
    inputItemHrid: INPUT_HRID,
    bulkMultiplier: 1,
    totalAttempts: 10,
    totalSuccesses: 8,
    results: {},
    catalystOfDecompositionUsed: 2,
    primeCatalystUsed: 0,
});

beforeEach(() => {
    state.mode = 'conservative';
    state.inputPriced = true;
    decomposeHistoryViewer.profitCache.clear();
});

describe('buildDataNote', () => {
    test('a priced session gets an empty note', () => {
        const detail = decomposeHistoryViewer.computeSessionProfit(session());
        expect(decomposeHistoryViewer.buildDataNote(detail)).toBe('');
    });

    test('an unpriced input says the total is incomplete', () => {
        state.inputPriced = false;
        const detail = decomposeHistoryViewer.computeSessionProfit(session());
        expect(detail.inputUnpriced).toBe(true);
        expect(decomposeHistoryViewer.buildDataNote(detail)).toBe('input unpriced — total is incomplete');
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

        decomposeHistoryViewer.exportHistory();

        spy.mockRestore();
        return captured;
    }

    test('the header includes a Data Note column', () => {
        decomposeHistoryViewer.sessions = [];
        const csv = captureCsv();
        expect(csv.split('\n')[0]).toContain('"Data Note"');
    });

    test('a qualified row carries the readable note in the CSV', () => {
        state.inputPriced = false;
        decomposeHistoryViewer.sessions = [session()];
        const csv = captureCsv();
        expect(csv.split('\n')[1]).toContain('input unpriced — total is incomplete');
    });

    test("a clean row's Data Note cell is empty", () => {
        decomposeHistoryViewer.sessions = [session()];
        const csv = captureCsv();
        expect(csv.split('\n')[1].trimEnd()).toMatch(/,""$/);
    });

    test('an unpriced output is named in Results and the note, not exported as a plain zero', () => {
        decomposeHistoryViewer.sessions = [
            { ...session(), results: { '/items/fiber': { count: 8, totalValue: 0, priceEach: 0, unpriced: true } } },
        ];
        const row = captureCsv().split('\n')[1];
        expect(row).toContain('fiber x8 = 0 (0 each, unpriced)');
        expect(row).toContain('output unpriced — revenue is incomplete');
    });

    test('an unrecorded catalyst and a pre-fix session are both carried into the note', () => {
        const legacy = { ...session(), catalystOfDecompositionUsed: undefined, primeCatalystUsed: undefined };
        delete legacy.trackerVersion;
        decomposeHistoryViewer.sessions = [legacy];
        const row = captureCsv().split('\n')[1];
        expect(row).toContain('catalyst not recorded (predates tracking)');
        expect(row).toContain('recorded before the 2026-09-23 tracker fix');
    });
});
