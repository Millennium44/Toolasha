/**
 * The JSON Backup export/import round trip. Unlike the CSV export, the
 * backup is meant to be read back in — hand-corrected sessions replace the
 * originals by id, and a malformed or mismatched file must leave storage
 * untouched. See `alchemy-session-import.js` for the envelope format.
 *
 * The tracker is mocked as a small in-memory store rather than through
 * `alchemy-session-store.js`, so these tests exercise the viewer's own
 * validation/merge/confirm flow without depending on chunked-history
 * internals — those are covered separately in `chunked-history.test.js`.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { buildAlchemyBackupEnvelope, ALCHEMY_BACKUP_VERSION } from './alchemy-session-import.js';

const game = vi.hoisted(() => ({ items: {}, prices: {}, characterId: 'char-1' }));
const trackerState = vi.hoisted(() => ({ stored: [], activeSession: null }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_id, fallback) => fallback },
}));
vi.mock('../../core/websocket.js', () => ({
    default: { on: () => {}, off: () => {}, onSocketEvent: () => {}, offSocketEvent: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid] ?? null,
        getCurrentCharacterId: () => game.characterId,
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

vi.mock('./transmute-history-tracker.js', () => ({
    transmuteHistoryTracker: {
        getCharacterScope: () => game.characterId,
        get activeSession() {
            return trackerState.activeSession;
        },
        loadStoredSessions: async () => trackerState.stored,
        loadSessions: async () => trackerState.stored,
        importSessions: async (sessions) => {
            trackerState.stored = sessions;
            return true;
        },
    },
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');

const GEM = '/items/gem';
const SHARD = '/items/shard';

/** @returns {Object} A well-formed stored transmute session */
const session = (overrides = {}) => ({
    id: 'transmute_1',
    startTime: 1000,
    lastActivityTime: 2000,
    inputItemHrid: GEM,
    totalAttempts: 3,
    totalSuccesses: 1,
    bulkMultiplier: 1,
    results: { [SHARD]: { count: 1, totalValue: 700, priceEach: 700, isSelfReturn: false, unpriced: false } },
    catalystsUsed: {},
    ...overrides,
});

/** @param {Array<Object>} sessions */
const backupText = (sessions, envelopeOverrides = {}) =>
    JSON.stringify({
        ...buildAlchemyBackupEnvelope({ kind: 'transmute', characterId: 'char-1', sessions }),
        ...envelopeOverrides,
    });

beforeEach(() => {
    game.items = { [GEM]: { name: 'gem', alchemyDetail: { bulkMultiplier: 1 } }, [SHARD]: { name: 'shard' } };
    game.prices = { [GEM]: 500, [SHARD]: 700 };
    game.characterId = 'char-1';
    trackerState.stored = [];
    trackerState.activeSession = null;
    transmuteHistoryViewer.profitCache.clear();
    transmuteHistoryViewer.sessions = [];
    transmuteHistoryViewer.filteredSessions = [];
    // happy-dom does not implement alert/confirm; stub both before spying
    window.alert = vi.fn();
    window.confirm = vi.fn().mockReturnValue(true);
});

describe('exportBackup → importBackupText round trip', () => {
    /** @returns {Promise<string>} The JSON text handed to the download helper */
    async function captureBackup() {
        let captured = null;
        const spy = vi.spyOn(globalThis, 'Blob').mockImplementation(
            class {
                constructor(parts) {
                    captured = parts[0];
                }
            }
        );
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        await transmuteHistoryViewer.exportBackup();

        spy.mockRestore();
        return captured;
    }

    test('round trip is identity: exporting and re-importing changes nothing', async () => {
        trackerState.stored = [session()];
        const text = await captureBackup();

        await transmuteHistoryViewer.importBackupText(text);

        expect(trackerState.stored).toEqual([session()]);
    });

    test('a corrected session replaces the original by id', async () => {
        // Recorded as 1 success / 2 failures; hand-corrected to 2 self-return
        // successes / 1 failure — the worked example in alchemy-session-import.js
        trackerState.stored = [session({ totalAttempts: 3, totalSuccesses: 1, results: {} })];

        const corrected = session({
            totalAttempts: 3,
            totalSuccesses: 2,
            results: {
                [GEM]: { count: 2, totalValue: 0, priceEach: 0, isSelfReturn: true, unpriced: false },
            },
        });
        window.confirm.mockReturnValue(true);

        await transmuteHistoryViewer.importBackupText(backupText([corrected]));

        expect(trackerState.stored).toEqual([corrected]);
    });
});

describe('importBackupText refusals — nothing is written', () => {
    test('a wrong-kind file is refused', async () => {
        trackerState.stored = [session({ id: 'existing' })];
        const text = JSON.stringify(
            buildAlchemyBackupEnvelope({ kind: 'coinify', characterId: 'char-1', sessions: [session()] })
        );

        await transmuteHistoryViewer.importBackupText(text);

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Import refused'));
    });

    test('a malformed session is refused', async () => {
        trackerState.stored = [session({ id: 'existing' })];
        const bad = session({ id: 'bad', totalAttempts: -1 });

        await transmuteHistoryViewer.importBackupText(backupText([bad]));

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Nothing was written'));
    });

    test('an unsupported (future) version is refused', async () => {
        trackerState.stored = [session({ id: 'existing' })];
        const text = backupText([session()], { version: ALCHEMY_BACKUP_VERSION + 1 });

        await transmuteHistoryViewer.importBackupText(text);

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
    });

    test('invalid JSON is refused', async () => {
        trackerState.stored = [session({ id: 'existing' })];

        await transmuteHistoryViewer.importBackupText('{not json');

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
    });

    test('a wrong-character file is refused when the user declines the confirm', async () => {
        trackerState.stored = [session({ id: 'existing' })];
        window.confirm.mockReturnValue(false);
        const text = JSON.stringify(
            buildAlchemyBackupEnvelope({ kind: 'transmute', characterId: 'someone-else', sessions: [session()] })
        );

        await transmuteHistoryViewer.importBackupText(text);

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
    });

    test('a wrong-character file proceeds when the user explicitly confirms', async () => {
        trackerState.stored = [];
        window.confirm.mockReturnValue(true);
        const text = JSON.stringify(
            buildAlchemyBackupEnvelope({ kind: 'transmute', characterId: 'someone-else', sessions: [session()] })
        );

        await transmuteHistoryViewer.importBackupText(text);

        expect(trackerState.stored).toEqual([session()]);
    });

    test('import is refused while a session is actively recording', async () => {
        trackerState.stored = [session({ id: 'existing' })];
        trackerState.activeSession = { id: 'live', inputItemHrid: GEM };

        await transmuteHistoryViewer.importBackupText(backupText([session({ id: 'new' })]));

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('actively recording'));
    });

    test('declining the merge-summary confirmation writes nothing', async () => {
        trackerState.stored = [session({ id: 'existing' })];
        window.confirm.mockReturnValue(false);

        await transmuteHistoryViewer.importBackupText(backupText([session({ id: 'new' })]));

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
    });
});

describe('merge semantics', () => {
    test('sessions absent from the file are kept alongside replaced/added ones', async () => {
        trackerState.stored = [
            session({ id: 'keep', totalSuccesses: 1 }),
            session({ id: 'replace-me', totalSuccesses: 1 }),
        ];
        window.confirm.mockReturnValue(true);

        const replaced = session({ id: 'replace-me', totalSuccesses: 2 });
        const added = session({ id: 'brand-new' });

        await transmuteHistoryViewer.importBackupText(backupText([replaced, added]));

        const byId = Object.fromEntries(trackerState.stored.map((s) => [s.id, s]));
        expect(byId['keep']).toEqual(session({ id: 'keep', totalSuccesses: 1 }));
        expect(byId['replace-me']).toEqual(replaced);
        expect(byId['brand-new']).toEqual(added);
        expect(trackerState.stored).toHaveLength(3);
    });
});
