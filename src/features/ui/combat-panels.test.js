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

const state = vi.hoisted(() => ({ dps: {}, luck: null, stats: null }));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-geometry.js', () => ({ restoreGeometry: () => {}, saveGeometry: () => {} }));
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

const { dpsPanel, deathsPanel, dropLuckPanel, profitPanel } = await import('./combat-panels.js');

const panels = () => [dpsPanel, deathsPanel, dropLuckPanel, profitPanel];
const FAILED = 'could not be drawn';

beforeEach(() => {
    state.dps = { dps: 4000, dtps: 500, damage: 1_000_000, taken: 125_000, seconds: 250, partySize: 2 };
    state.luck = { percentile: 0.51, income: 5_000_000, expected: 4_000_000, battles: 300, hasBonuses: true };
    state.stats = {
        durationSeconds: 3600,
        totalEncounters: 400,
        players: [
            {
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
                    get deathCount() {
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

    test('and your own share of a party’s output', () => {
        dpsPanel.show();
        expect(dpsPanel.panel.textContent).toContain('2,000/s');
    });

    test('Deaths says how long a death is worth', () => {
        // Four deaths in an hour is one every fifteen minutes
        deathsPanel.show();
        expect(deathsPanel.panel.textContent).toContain('15m');
        expect(deathsPanel.panel.textContent).toContain('100');
    });

    test('no deaths is rated as nothing rather than as infinity', () => {
        state.stats.players[0].deathCount = 0;
        deathsPanel.show();
        expect(deathsPanel.panel.textContent).toContain('No deaths this run');
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

    test('Profit shows both sides, since the gap is often the whole profit', () => {
        profitPanel.show();
        expect(profitPanel.panel.textContent).toContain('At ask (patient)');
        expect(profitPanel.panel.textContent).toContain('At bid (immediate)');
    });

    test('and splits the costs it is subtracting', () => {
        profitPanel.show();
        expect(profitPanel.panel.textContent).toContain('Consumables/day');
        expect(profitPanel.panel.textContent).toContain('Keys/day');
    });
});
