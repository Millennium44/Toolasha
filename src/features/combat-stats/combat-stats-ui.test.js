/** @vitest-environment happy-dom */

/**
 * Combat Statistics popup: the session picker.
 *
 * The popup always answered "how is this run going"; the archive already held
 * the runs before it. These test the join — an archived session rendered
 * through the same calculator as the live view, with its stored duration,
 * clearly headed as archived, and Live restored on the way back. Read-only
 * over the archive throughout.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    /** What the collector says the run in progress is; null = nothing live */
    live: null,
    /** The archive, newest first */
    sessions: [],
}));

// Real subscribe/unsubscribe bookkeeping, unlike a no-op stub, so a test can
// prove a cleanup+initialize cycle does not accumulate listeners.
const settingListeners = vi.hoisted(() => ({}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_TEXT_PRIMARY: '#eee',
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TOOLTIP_PROFIT: '#5f5',
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback ?? null,
        getPricingModeLabel: () => 'Hybrid',
        onSettingChange: (key, callback) => {
            (settingListeners[key] ??= []).push(callback);
            return () => {
                settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => ({ name: hrid.split('/').pop(), rarity: 0 }),
        getActionDetails: (hrid) => (hrid === '/actions/combat/chimerical_den' ? { name: 'Chimerical Den' } : null),
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => ({}), getPrice: () => null },
}));
vi.mock('./combat-stats-data-collector.js', () => ({
    default: {
        getLatestData: () => mocks.live,
        loadLatestData: async () => null,
        resetConsumableTracking: async () => {},
    },
}));
vi.mock('./combat-session-history.js', () => ({
    loadSessions: async () => mocks.sessions,
}));
vi.mock('../../utils/key-cost.js', () => ({
    formatKeyCostNote: () => '',
    describeKeyCost: () => ({ unitCost: null }),
    getKeyPricingMode: () => 'ask',
}));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        isInitialized: false,
        getCachedValue: () => null,
        calculateSingleContainer: () => null,
        calculateExpectedValue: () => null,
    },
}));

const { default: combatStatsUI, archivedSessionLabel, combatSessionText } = await import('./combat-stats-ui.js');

/** Coins only, so the real calculator prices the run without a market */
const player = (name, coins, isCurrentPlayer = false) => ({
    name,
    isCurrentPlayer,
    deathCount: 0,
    loot: { 1: { itemHrid: '/items/coin', count: coins } },
    experience: {},
    consumables: [],
});

const ARCHIVED = {
    key: 'A,B,C,D,E|2026-08-05T10:00:00Z',
    combatStartTime: '2026-08-05T10:00:00Z',
    durationSeconds: 22_320, // 6h 12m
    actionHrid: '/actions/combat/chimerical_den',
    battleId: 100,
    players: ['A', 'B', 'C', 'D', 'E'].map((name, index) => player(name, 1000 * (index + 1), index === 0)),
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const popup = () => document.querySelector('.toolasha-combat-stats-popup');
const picker = () => document.querySelector('.toolasha-combat-stats-session-picker');

beforeEach(() => {
    mocks.live = {
        battleId: 5,
        combatStartTime: null,
        durationSeconds: 600,
        players: [player('LiveGuy', 5000, true)],
    };
    mocks.sessions = [ARCHIVED];
    vi.stubGlobal('alert', vi.fn());
});

afterEach(() => {
    combatStatsUI.closePopup();
    combatStatsUI.viewing = 'live';
    vi.unstubAllGlobals();
});

describe('naming an archived run in the picker', () => {
    test('duration, zone and party size, in one line', () => {
        const label = archivedSessionLabel(ARCHIVED, { zoneNameOf: () => 'Chimerical Den' });
        expect(label).toContain('6h 12m · Chimerical Den · party of 5');
    });

    test('a zone the archive never recorded goes unnamed rather than guessed', () => {
        const label = archivedSessionLabel({ ...ARCHIVED, actionHrid: null }, { zoneNameOf: () => null });
        expect(label).toContain('6h 12m · party of 5');
    });

    test('one player is solo, and a missing date says so', () => {
        const label = archivedSessionLabel({ durationSeconds: 60, players: [player('A', 1)] });
        expect(label).toContain('Unknown date');
        expect(label).toContain('solo');
    });
});

describe('the session picker on the popup', () => {
    test('defaults to Live, with every archived run on offer', async () => {
        await combatStatsUI.showPopup();

        expect(popup().textContent).toContain('Combat Statistics');
        expect(popup().textContent).not.toContain('Archived Session');
        expect(popup().textContent).toContain('LiveGuy');

        expect(picker().value).toBe('live');
        const labels = [...picker().options].map((option) => option.textContent);
        expect(labels[0]).toBe('Live session');
        expect(labels[1]).toContain('Chimerical Den · party of 5');
    });

    test('choosing an archived run renders it, headed as archived, at its stored duration', async () => {
        await combatStatsUI.showPopup();

        picker().value = ARCHIVED.key;
        picker().dispatchEvent(new Event('change'));
        await flush();

        const text = popup().textContent;
        expect(text).toContain('Combat Statistics — Archived Session');
        expect(text).toContain('Archived session —');
        // The archived duration, through the same calculator the live view uses
        expect(text).toContain('6h 12m');
        // Every member of the archived party, priced
        for (const name of ['A', 'B', 'C', 'D', 'E']) expect(text).toContain(name);
        // Consumable tracking is live-only, so its reset is not offered here
        expect(text).not.toContain('Reset Consumable Tracking');
    });

    test('switching back to Live restores the run in progress', async () => {
        await combatStatsUI.showPopup();
        picker().value = ARCHIVED.key;
        picker().dispatchEvent(new Event('change'));
        await flush();

        picker().value = 'live';
        picker().dispatchEvent(new Event('change'));
        await flush();

        const text = popup().textContent;
        expect(text).not.toContain('Archived Session');
        expect(text).toContain('LiveGuy');
        expect(text).toContain('Reset Consumable Tracking');
    });

    test('a remembered session that fell off the archive falls back to Live', async () => {
        combatStatsUI.viewing = 'gone|2026-01-01T00:00:00Z';
        await combatStatsUI.showPopup();

        expect(combatStatsUI.viewing).toBe('live');
        expect(popup().textContent).not.toContain('Archived Session');
    });

    test('no live run but a stocked archive still opens the popup', async () => {
        mocks.live = null;
        await combatStatsUI.showPopup();

        expect(globalThis.alert).not.toHaveBeenCalled();
        expect(popup().textContent).toContain('pick an archived session');
    });

    test('nothing live and nothing archived still alerts, as before', async () => {
        mocks.live = null;
        mocks.sessions = [];
        await combatStatsUI.showPopup();

        expect(globalThis.alert).toHaveBeenCalled();
        expect(popup()).toBeNull();
    });
});

describe('combatSessionText', () => {
    const stats = (name, overrides = {}) => ({
        name,
        durationFormatted: '1h 0m',
        encountersPerHour: 10,
        income: { ask: 1000, bid: 900 },
        dailyIncome: { ask: 24000, bid: 21600 },
        consumableCosts: 50,
        dailyProfit: { ask: 23000, bid: 20600 },
        totalExp: 500,
        expPerHour: 500,
        deathCount: 1,
        deathsPerHour: 1,
        ...overrides,
    });

    test('one block per player, under the header, priced by the chosen key', () => {
        const text = combatSessionText([stats('A'), stats('B')], {
            header: 'Combat Statistics — Live',
            priceKey: 'bid',
        });
        expect(text.startsWith('Combat Statistics — Live')).toBe(true);
        expect(text).toContain('A');
        expect(text).toContain('B');
        expect(text).toContain('Income (bid): 900');
        expect(text).toContain('Daily profit: 20600/d');
    });

    test('no players says so rather than printing an empty header', () => {
        expect(combatSessionText([])).toContain('No data.');
        expect(combatSessionText(null)).toContain('No data.');
    });

    test('the formatter passed in is what renders every number', () => {
        const text = combatSessionText([stats('A')], { formatNum: (n) => `<${n}>` });
        expect(text).toContain('Encounters/hour: <10>');
        expect(text).toContain('Total EXP: <500>');
    });
});

describe('the Copy button on the popup', () => {
    const copyButton = () => [...popup().querySelectorAll('button')].find((b) => b.textContent.includes('Copy'));

    test('is offered for a live run with data, and copies every player', async () => {
        await combatStatsUI.showPopup();

        const written = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((value) => {
            written.push(value);
            return Promise.resolve();
        });

        const btn = copyButton();
        expect(btn).toBeTruthy();
        btn.click();
        await flush();

        expect(written[0]).toContain('LiveGuy');
        expect(written[0]).not.toContain('Archived Session');
    });

    test('switches to a checkmark, then back, after copying', async () => {
        vi.useFakeTimers();
        await combatStatsUI.showPopup();
        vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

        const btn = copyButton();
        btn.click();
        await Promise.resolve();
        expect(btn.textContent).toContain('Copied');

        vi.advanceTimersByTime(1200);
        expect(btn.textContent).toContain('Copy');
        expect(btn.textContent).not.toContain('Copied');
        vi.useRealTimers();
    });

    test('an archived session copies headed as archived', async () => {
        await combatStatsUI.showPopup();
        picker().value = ARCHIVED.key;
        picker().dispatchEvent(new Event('change'));
        await flush();

        const written = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((value) => {
            written.push(value);
            return Promise.resolve();
        });
        copyButton().click();
        await flush();

        expect(written[0]).toContain('Archived Session');
        for (const name of ['A', 'B', 'C', 'D', 'E']) expect(written[0]).toContain(name);
    });

    test('a popup open with nothing measured yet offers no Copy button', async () => {
        mocks.live = null;
        await combatStatsUI.showPopup();

        expect(popup()).toBeTruthy();
        expect(copyButton()).toBeUndefined();
    });
});

describe('cleanup unregisters the setting-change listener it registered', () => {
    afterEach(() => {
        combatStatsUI.cleanup();
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];
    });

    test('a character-switch cycle does not accumulate listeners', () => {
        // Every character switch runs cleanup() then initialize() again
        // (feature-registry.js). If the unregister function onSettingChange
        // hands back is discarded, each cycle leaves one more copy of the
        // same callback on config's per-key list.
        combatStatsUI.initialize();
        for (let i = 0; i < 3; i++) {
            combatStatsUI.cleanup();
            combatStatsUI.initialize();
        }

        expect(settingListeners.combatStats).toHaveLength(1);
    });
});
