/**
 * The JSON Backup export/import round trip for coinify history. See
 * `transmute-history-viewer.import.test.js` for the shared reasoning; this
 * file only covers what differs — coinify's own session shape and fields.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { buildAlchemyBackupEnvelope, ALCHEMY_BACKUP_VERSION } from './alchemy-session-import.js';

const INPUT_HRID = '/items/cotton';

const game = vi.hoisted(() => ({ characterId: 'char-1' }));
const trackerState = vi.hoisted(() => ({ stored: [], activeSession: null }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_key, fallback) => fallback },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getItemDetails: (itemHrid) =>
            itemHrid === INPUT_HRID ? { name: 'Cotton', alchemyDetail: { bulkMultiplier: 1 } } : null,
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: () => 200,
    getItemPriceInfo: () => ({ price: 200, source: 'book', estimated: false }),
}));

vi.mock('./coinify-history-tracker.js', () => ({
    coinifyHistoryTracker: {
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

const { coinifyHistoryViewer } = await import('./coinify-history-viewer.js');

/** @returns {Object} A well-formed stored coinify session */
const session = (overrides = {}) => ({
    id: 'coinify_1',
    startTime: 1000,
    lastActivityTime: 2000,
    inputItemHrid: INPUT_HRID,
    enhancementLevel: 0,
    totalAttempts: 10,
    totalSuccesses: 8,
    totalCoinsEarned: 5000,
    coinsPerSuccess: 625,
    catalystOfCoinificationUsed: 8,
    primeCatalystUsed: 0,
    catalystsUsed: {},
    bulkMultiplier: 1,
    ...overrides,
});

const backupText = (sessions, envelopeOverrides = {}) =>
    JSON.stringify({
        ...buildAlchemyBackupEnvelope({ kind: 'coinify', characterId: 'char-1', sessions }),
        ...envelopeOverrides,
    });

beforeEach(() => {
    game.characterId = 'char-1';
    trackerState.stored = [];
    trackerState.activeSession = null;
    coinifyHistoryViewer.profitCache.clear();
    coinifyHistoryViewer.sessions = [];
    coinifyHistoryViewer.filteredSessions = [];
    window.alert = vi.fn();
    window.confirm = vi.fn().mockReturnValue(true);
});

describe('exportBackup → importBackupText round trip', () => {
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

        await coinifyHistoryViewer.exportBackup();

        spy.mockRestore();
        return captured;
    }

    test('round trip is identity', async () => {
        trackerState.stored = [session()];
        const text = await captureBackup();

        await coinifyHistoryViewer.importBackupText(text);

        expect(trackerState.stored).toEqual([session()]);
    });

    test('a corrected session replaces the original by id', async () => {
        trackerState.stored = [session({ totalSuccesses: 8, totalCoinsEarned: 5000 })];
        const corrected = session({ totalSuccesses: 9, totalCoinsEarned: 5625 });

        await coinifyHistoryViewer.importBackupText(backupText([corrected]));

        expect(trackerState.stored).toEqual([corrected]);
    });
});

describe('importBackupText refusals — nothing is written', () => {
    test('a wrong-kind file is refused', async () => {
        trackerState.stored = [session({ id: 'existing' })];
        const text = JSON.stringify(
            buildAlchemyBackupEnvelope({ kind: 'transmute', characterId: 'char-1', sessions: [session()] })
        );

        await coinifyHistoryViewer.importBackupText(text);

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
    });

    test('a malformed session is refused', async () => {
        trackerState.stored = [session({ id: 'existing' })];
        const bad = session({ id: 'bad', totalCoinsEarned: 'lots' });

        await coinifyHistoryViewer.importBackupText(backupText([bad]));

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
    });

    test('an unsupported (future) version is refused', async () => {
        trackerState.stored = [session({ id: 'existing' })];
        const text = backupText([session()], { version: ALCHEMY_BACKUP_VERSION + 1 });

        await coinifyHistoryViewer.importBackupText(text);

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
    });

    test('a wrong-character file is refused when declined', async () => {
        trackerState.stored = [session({ id: 'existing' })];
        window.confirm.mockReturnValue(false);
        const text = JSON.stringify(
            buildAlchemyBackupEnvelope({ kind: 'coinify', characterId: 'someone-else', sessions: [session()] })
        );

        await coinifyHistoryViewer.importBackupText(text);

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
    });

    test('import is refused while a session is actively recording', async () => {
        trackerState.stored = [session({ id: 'existing' })];
        trackerState.activeSession = { id: 'live', inputItemHrid: INPUT_HRID };

        await coinifyHistoryViewer.importBackupText(backupText([session({ id: 'new' })]));

        expect(trackerState.stored).toEqual([session({ id: 'existing' })]);
    });
});

describe('merge semantics', () => {
    test('sessions absent from the file are kept', async () => {
        trackerState.stored = [session({ id: 'keep' }), session({ id: 'replace-me', totalSuccesses: 1 })];
        const replaced = session({ id: 'replace-me', totalSuccesses: 2 });
        const added = session({ id: 'brand-new' });

        await coinifyHistoryViewer.importBackupText(backupText([replaced, added]));

        const byId = Object.fromEntries(trackerState.stored.map((s) => [s.id, s]));
        expect(byId['keep']).toEqual(session({ id: 'keep' }));
        expect(byId['replace-me']).toEqual(replaced);
        expect(byId['brand-new']).toEqual(added);
        expect(trackerState.stored).toHaveLength(3);
    });
});
