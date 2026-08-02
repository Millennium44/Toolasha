/**
 * @vitest-environment happy-dom
 *
 * The four combat panels, built rather than reasoned about.
 *
 * They compute nothing — they read four collectors and lay the result out. So
 * the only failure mode is reading a field that is not there, which is exactly
 * what the Ability Book panel shipped with and what building them catches.
 */

import { describe, test, expect, afterEach, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    dps: {},
    luck: null,
    stats: null,
    breakdown: { seconds: 0, players: [] },
    filtering: true,
}));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-geometry.js', () => ({ restoreGeometry: () => {}, saveGeometry: () => {} }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => ({ ask: 400000, bid: 380000 }) }));
vi.mock('../../features/combat/combat-dps.js', () => ({
    default: {
        get dps() {
            return state.dps.dps ?? null;
        },
        get dtps() {
            return state.dps.dtps ?? null;
        },
        get damage() {
            return state.dps.damage ?? 0;
        },
        get taken() {
            return state.dps.taken ?? 0;
        },
        get seconds() {
            return state.dps.seconds ?? 0;
        },
        get partySize() {
            return state.dps.partySize ?? 1;
        },
    },
}));
vi.mock('../../features/combat/combat-drop-luck.js', () => ({
    default: {
        get lastResult() {
            return state.luck;
        },
    },
    formatOrdinal: (value) => `${Math.round(value * 100)}th`,
    describeLuck: () => 'about average',
}));
vi.mock('../../features/combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => state.stats },
}));
vi.mock('../../features/combat/damage-tracker.js', () => ({
    default: {},
    damageBreakdown: () => state.breakdown,
    actionLabel: (action) => (action === 'auto' ? 'Auto attack' : action),
    isFilteringNonDamaging: () => state.filtering,
    setFilterNonDamaging: (value) => {
        state.filtering = value;
    },
}));

const { dpsPanel, deathsPanel, dropLuckPanel, profitPanel } = await import('./combat-panels.js');

const panels = () => [dpsPanel, deathsPanel, dropLuckPanel, profitPanel];
const FAILED = 'could not be drawn';

beforeEach(() => {
    state.dps = { dps: 4000, dtps: 500, damage: 1_000_000, taken: 125_000, seconds: 250, partySize: 2 };
    state.filtering = true;
    state.breakdown = {
        seconds: 300,
        players: [
            {
                index: '0',
                name: 'You',
                damage: 900000,
                hits: 90,
                crits: 18,
                misses: 10,
                accuracy: 0.9,
                critRate: 0.2,
                dps: 3000,
                abilities: [{ action: 'auto', damage: 900000, hits: 90, crits: 18, misses: 10 }],
            },
        ],
    };
    state.luck = { percentile: 0.51, income: 5_000_000, expected: 4_000_000, battles: 300, hasBonuses: true };
    state.stats = {
        durationSeconds: 3600,
        totalEncounters: 400,
        players: [
            { name: 'Ally', deathCount: 2 },
            {
                name: 'You',
                isCurrentPlayer: true,
                deathCount: 4,
                dailyIncome: { ask: 100, bid: 80 },
                dailyProfit: { ask: 60, bid: 40 },
                dailyConsumableCosts: 30,
                dailyKeyCosts: 10,
            },
        ],
    };
});

afterEach(() => {
    for (const panel of panels()) panel.hide();
});

describe('every panel draws', () => {
    test('with data, and none of them fails', () => {
        for (const panel of panels()) {
            panel.show();
            expect(panel.panel.textContent).not.toContain(FAILED);
        }
    });

    test('with nothing loaded, and still none of them fails', () => {
        // The state every panel is in for the first minute of a session
        state.dps = {};
        state.luck = null;
        state.stats = null;
        state.breakdown = { seconds: 0, players: [] };

        for (const panel of panels()) {
            panel.show();
            expect(panel.panel.textContent).not.toContain(FAILED);
            expect(panel.panel.textContent.length).toBeGreaterThan(0);
        }
    });

    test('opening one twice does not build a second', () => {
        dpsPanel.show();
        dpsPanel.show();
        expect(document.querySelectorAll('#toolasha-dpsPanel-panel')).toHaveLength(1);
    });

    test('hiding takes it off the page and stops its clock', () => {
        dpsPanel.show();
        dpsPanel.hide();
        expect(document.querySelector('#toolasha-dpsPanel-panel')).toBeNull();
        expect(dpsPanel.refreshId).toBeNull();
    });

    test('a panel that throws says so instead of showing an empty box', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        state.stats = {
            players: [
                {
                    isCurrentPlayer: true,
                    get name() {
                        throw new Error('deliberate');
                    },
                },
            ],
        };
        deathsPanel.show();
        expect(deathsPanel.panel.textContent).toContain('deliberate');
    });
});

describe('what the panels add over their tiles', () => {
    test('Damage says whether you are winning the exchange', () => {
        // 4,000 dealt against 500 taken
        dpsPanel.show();
        expect(dpsPanel.panel.textContent).toContain('8.0× in your favour');
    });

    test('Damage attributes to a player and an ability, as DPs does', () => {
        dpsPanel.show();
        const text = dpsPanel.panel.textContent;

        expect(text).toContain('You');
        expect(text).toContain('Auto attack');
        // Ninety hits against ten misses
        expect(text).toContain('90.0%');
        expect(text).toContain('20.0%');
    });

    test('and carries the non-damaging filter DPs has', () => {
        dpsPanel.show();
        const toggle = dpsPanel.panel.querySelector('[data-filter-toggle]');
        expect(toggle.textContent).toContain('on');

        toggle.click();
        expect(state.filtering).toBe(false);
    });

    test('with nothing attributed it says why rather than showing zeroes', () => {
        state.breakdown = { seconds: 0, players: [] };
        dpsPanel.show();
        expect(dpsPanel.panel.textContent).toContain('needs a cast to start');
    });

    test('Deaths breaks the party down by player, as IHurt does', () => {
        // A party figure says the group is dying and not who, and "who" is the
        // whole question when one member is under-geared for the zone
        deathsPanel.show();
        const text = deathsPanel.panel.textContent;

        expect(text).toContain('Ally');
        expect(text).toContain('You');
        // Two plus four across an hour
        expect(text).toContain('6');
    });

    test('and does not claim to know what killed anybody', () => {
        deathsPanel.show();
        expect(deathsPanel.panel.textContent).toContain('counts rather than causes');
    });

    test('Profit names the three cases HWhat names', () => {
        profitPanel.show();
        const text = profitPanel.panel.textContent;

        expect(text).toContain('Lazy Profit');
        expect(text).toContain('Mid Profit');
        expect(text).toContain('Revenue (Bid) - Cost (Ask)');
    });

    test('and costs the weekly tax in cowbell bags', () => {
        profitPanel.show();
        const text = profitPanel.panel.textContent;

        expect(text).toContain('Pay the Tax');
        expect(text).toContain('25 bags');
    });

    test('Drop Luck says how many coins the verdict is about', () => {
        // A percentile alone cannot distinguish a fortune from a rounding error
        dropLuckPanel.show();
        expect(dropLuckPanel.panel.textContent).toContain('+1.0M');
    });

    test('a shortfall reads as a shortfall', () => {
        state.luck = { ...state.luck, income: 3_000_000 };
        dropLuckPanel.show();
        expect(dropLuckPanel.panel.textContent).toContain('-1.0M');
    });

    test('Profit shows what patience is worth', () => {
        profitPanel.show();
        expect(profitPanel.panel.textContent).toContain('Patient over lazy');
    });
});
