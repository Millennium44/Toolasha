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

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_TEXT_PRIMARY: '#eee',
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TOOLTIP_PROFIT: '#5f5',
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback ?? null,
        getPricingModeLabel: () => 'Hybrid',
        onSettingChange: () => {},
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

const { default: combatStatsUI, archivedSessionLabel } = await import('./combat-stats-ui.js');

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
