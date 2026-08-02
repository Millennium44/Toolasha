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
    inventory: [],
}));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getInventory: () => state.inventory } }));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => null, setJSON: async () => {} } }));
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

const { dpsPanel, deathsPanel, profitPanel, combatProfitView } = await import('./combat-panels.js');

const panels = () => [dpsPanel, deathsPanel, profitPanel];
const FAILED = 'could not be drawn';

beforeEach(() => {
    state.dps = { dps: 4000, dtps: 500, damage: 1_000_000, taken: 125_000, seconds: 250, partySize: 2 };
    state.filtering = true;
    state.inventory = [];
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

    test('each case shows its working, not just its conclusion', () => {
        // "55.6M/day" is a conclusion. The sum beneath it is the same
        // conclusion with the revenue and the cost visible, which is what says
        // whether a bad number is a revenue problem or a cost problem.
        profitPanel.show();
        const text = profitPanel.panel.textContent;

        expect(text).toContain('coin/day');
        expect(text).toMatch(/-?[\d.]+[KMB]? - -?[\d.]+[KMB]? = -?[\d.]+[KMB]?/);
    });

    test('Costs Off drops the cost side rather than zeroing it', () => {
        profitPanel.show();
        const button = [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Costs On');
        expect(button).toBeTruthy();

        button.click();
        const text = profitPanel.panel.textContent;
        expect(text).toContain('Costs Off');
        expect(text).not.toContain('Cost (Ask)');

        // Put it back, since the panel remembers between openings
        [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Costs Off').click();
    });

    test('the mode button cycles the headline through the three cases', () => {
        profitPanel.show();
        const mode = () =>
            [...profitPanel.panel.querySelectorAll('button')].find((b) =>
                ['Lazy', 'Mid', 'Patient'].includes(b.textContent)
            );

        const first = mode().textContent;
        mode().click();
        expect(mode().textContent).not.toBe(first);
    });

    test('the fourth corner of the book is there too', () => {
        // Bid-Ask, Bid-Bid and Ask-Bid have names; Ask - Ask is the one that
        // does not, and leaving it out leaves the set incomplete
        profitPanel.show();
        const text = profitPanel.panel.textContent;

        expect(text).toContain('Ask - Ask');
        expect(text).toContain('Revenue (Ask) - Cost (Ask)');
        // Each named case says which corner it is, so the set reads as a set
        expect(text).toContain('(Bid - Bid)');
    });

    test('the tax counts what is already in the bag', () => {
        // 25 bags a week is the price of a MooPass, not the price of *your*
        // MooPass — cowbells accumulate, and charging for all 25 overstates it
        state.inventory = [
            { itemHrid: '/items/cowbell', count: 50 },
            { itemHrid: '/items/bag_of_10_cowbells', count: 5 },
        ];
        profitPanel.show();

        // 50 loose plus 5 bags is 100 cowbells, so 15 bags are still owed
        expect(profitPanel.panel.textContent).toContain('15 of 25 bags');
    });

    test('Tax On subtracts it from every case', () => {
        profitPanel.show();
        const before = profitPanel.panel.textContent;
        expect(before).toContain('Tax Off');

        [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Tax Off').click();
        const after = profitPanel.panel.textContent;

        expect(after).toContain('Tax On');
        expect(after).toContain('Paying the Tax');
        // Three terms in the sum now, not two
        expect(after).toMatch(/-?[\d.]+[KMB]? - -?[\d.]+[KMB]? - -?[\d.]+[KMB]? = -?[\d.]+[KMB]?/);

        [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Tax On').click();
    });

    test('the tile is told which reading the panel is showing', () => {
        // The tile used to be hard-wired to bid revenue less every cost, which
        // is one of four readings and not necessarily the one on screen
        profitPanel.show();
        const lazy = combatProfitView(state.stats);
        expect(lazy).toBeTruthy();

        [...profitPanel.panel.querySelectorAll('button')]
            .find((b) => ['Lazy', 'Mid', 'Patient', 'Ask'].includes(b.textContent.split(' ')[0]))
            .click();

        expect(combatProfitView(state.stats).title).not.toBe(lazy.title);
    });

    test('nothing to read from is nothing rather than a row of zeroes', () => {
        expect(combatProfitView(null)).toBeNull();
    });

    test('the tile carries the tax only when the panel is counting it', () => {
        profitPanel.show();
        expect(combatProfitView(state.stats).tax).toBe(0);

        [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Tax Off').click();
        expect(combatProfitView(state.stats).tax).toBeGreaterThan(0);

        [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Tax On').click();
    });

    test('Profit shows what patience is worth', () => {
        profitPanel.show();
        expect(profitPanel.panel.textContent).toContain('Patient over lazy');
    });
});
