/**
 * @vitest-environment happy-dom
 *
 * The panel's job is to draw an attribution without hiding the part of it that
 * is not attributed, so what is asserted here is mostly that the residual is on
 * screen, labelled, and separate from the sources.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { Z_FLOATING_PANEL: 1100, getSetting: () => true, getSettingValue: () => null },
}));

const collectGoldSourceInputs = vi.fn(async () => ({}));
vi.mock('./gold-sources-collect.js', () => ({
    collectGoldSourceInputs: (...args) => collectGoldSourceInputs(...args),
    createPricer: () => () => null,
}));

const {
    default: goldSourcesPanel,
    buildPanelBody,
    buildBars,
    buildTotalsTable,
    sourceTooltip,
    coverageText,
    combatBasisLabel,
    combatCoverageText,
    calendarSummaryText,
    calendarCellKind,
    MODAL_ID,
} = await import('./gold-sources-panel.js');

const D19 = Date.parse('2026-08-19T12:00:00Z');
const D20 = Date.parse('2026-08-20T12:00:00Z');

/** An attribution shaped like the real one, with a big honest residual */
function attribution(overrides = {}) {
    const sources = {
        combat: 5_000_000,
        gathering: 1_000_000,
        production: 250_000,
        alchemy: 0,
        enhancement: -400_000,
        marketplace: 800_000,
        offline: 120_000,
        consumables: -300_000,
        marketTax: -90_000,
        ...(overrides.sources || {}),
    };
    return {
        from: D19,
        to: D20,
        days: [
            { day: '2026-08-19', sources, explained: 6_380_000, delta: 7_000_000, residual: 620_000 },
            { day: '2026-08-20', sources, explained: 6_380_000, delta: null, residual: null },
        ],
        totals: { sources, explained: 6_380_000, delta: 20_000_000, residual: 13_620_000 },
        coverage: {
            combat: D19,
            gathering: D19,
            production: D20,
            offline: null,
            alchemy: null,
            enhancement: null,
            marketplace: D19,
            marketTax: D19,
            consumables: null,
        },
        unpricedEnhancementSessions: 0,
        ...overrides,
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
    goldSourcesPanel.closeModal();
    collectGoldSourceInputs.mockClear();
});

describe('buildPanelBody', () => {
    test('production actions that could not be valued are said out loud', () => {
        const body = buildPanelBody(attribution({ unpricedProductionActions: 4 }));
        const note = body.querySelector('.mwi-gold-sources-unpriced-production');
        expect(note.textContent).toContain('4 production actions');
        expect(note.textContent).toContain('residual');
    });

    test('the summary reports a loss explained by a loss as a positive share', () => {
        const body = buildPanelBody(
            attribution({
                totals: {
                    sources: { enhancement: -16_000_000 },
                    explained: -16_000_000,
                    delta: -20_000_000,
                    residual: null,
                },
            })
        );

        const summary = body.querySelector('.mwi-gold-sources-summary').textContent;
        expect(summary).toContain('(80%)');
        expect(summary).not.toContain('-80%');
    });

    test('the summary keeps a mixed-sign window positive too', () => {
        const body = buildPanelBody(
            attribution({
                totals: { sources: { combat: 5_000_000 }, explained: 5_000_000, delta: -20_000_000, residual: null },
            })
        );

        expect(body.querySelector('.mwi-gold-sources-summary').textContent).toContain('(25%)');
    });

    test('nothing is said when every production action was priced', () => {
        const body = buildPanelBody(attribution());
        expect(body.querySelector('.mwi-gold-sources-unpriced-production')).toBeNull();
    });

    test('draws every source row plus a residual row of its own', () => {
        const body = buildPanelBody(attribution());
        const text = body.textContent;

        for (const label of [
            'Combat drops',
            'Gathering',
            'Production',
            'Alchemy',
            'Enhancement',
            'Marketplace',
            'Offline progress',
            'Consumables',
            'Market tax',
        ]) {
            expect(text).toContain(label);
        }

        expect(text).toContain('Unexplained residual');
        expect(text).toContain('Measured net worth change');
        expect(body.querySelector('.mwi-gold-sources-row-residual')).toBeTruthy();
    });

    test('the residual is the gap, not a rounded-away remainder', () => {
        const body = buildPanelBody(attribution());
        const row = body.querySelector('.mwi-gold-sources-row-residual');
        expect(row.textContent).toContain('13.62M');
    });

    test('production is labelled an estimate and the measured sources are not', () => {
        const body = buildPanelBody(attribution());
        const production = body.querySelector('.mwi-gold-sources-row-production');
        const combat = body.querySelector('.mwi-gold-sources-row-combat');
        expect(production.textContent).toContain('Estimated');
        expect(combat.textContent).toContain('Measured');
    });

    test('costs are drawn negative', () => {
        const body = buildPanelBody(attribution());
        expect(body.querySelector('.mwi-gold-sources-row-consumables').textContent).toContain('-300.00K');
        expect(body.querySelector('.mwi-gold-sources-row-marketTax').textContent).toContain('-90.00K');
    });

    test('a window with no measured change says so instead of showing a fake residual', () => {
        const body = buildPanelBody(
            attribution({ totals: { sources: {}, explained: 0, delta: null, residual: null } })
        );
        expect(body.querySelector('.mwi-gold-sources-summary').textContent).toContain('no measured change');
        expect(body.querySelector('.mwi-gold-sources-row-residual').textContent).toContain('—');
    });

    test('unvalued enhancement runs are called out rather than counted as zero', () => {
        const body = buildPanelBody(attribution({ unpricedEnhancementSessions: 2 }));
        expect(body.querySelector('.mwi-gold-sources-unpriced').textContent).toContain('2 enhancement sessions');
    });

    test('the UTC and today’s-prices caveats are on the panel', () => {
        const body = buildPanelBody(attribution());
        expect(body.querySelector('.mwi-gold-sources-note').textContent).toContain('UTC');
        expect(body.querySelector('.mwi-gold-sources-note').textContent).toContain('today');
    });
});

describe('the combat row’s basis', () => {
    /** A combatBasis with everything at rest */
    const basis = (overrides = {}) => ({
        lootLogDays: 0,
        sessionDays: 0,
        uncoveredDays: 0,
        sessions: 0,
        emptySessions: 0,
        sessionsHeld: 0,
        sessionCap: 20,
        lastLootLog: null,
        combatRan: false,
        ...overrides,
    });

    test('names whichever recording fed it, and both when both did', () => {
        expect(combatBasisLabel(basis({ lootLogDays: 3 }))).toBe('Measured — loot log');
        expect(combatBasisLabel(basis({ sessionDays: 2 }))).toBe('Measured — battle feed');
        expect(combatBasisLabel(basis({ lootLogDays: 3, sessionDays: 2 }))).toBe(
            'Measured — loot log 3d, battle feed 2d'
        );
    });

    test('a zero nothing recorded is not called Measured', () => {
        expect(combatBasisLabel(basis({ combatRan: true, uncoveredDays: 7 }))).toBe('Not recorded');
        // No combat at all is a real zero, and says so
        expect(combatBasisLabel(basis())).toBe('Measured');
    });

    test('an attribution from before this existed still labels the row', () => {
        expect(combatBasisLabel(null)).toBeNull();
        expect(sourceTooltip('combat', { combat: D19 })).toContain('Measured');
    });

    test('the coverage line says when the loot log last spoke and what filled the rest', () => {
        const text = combatCoverageText(
            basis({ lastLootLog: D19, sessionDays: 2, uncoveredDays: 3, sessionsHeld: 20, combatRan: true })
        );
        expect(text).toContain('last recorded combat on 2026-08-19');
        expect(text).toContain('battle feed filled 2 days');
        expect(text).toContain('20 most recent runs');
        expect(text).toContain('3 days in this window have neither recording');
    });

    test('the coverage line says plainly when the loot log has never recorded combat', () => {
        expect(combatCoverageText(basis({ sessionDays: 1, combatRan: true }))).toContain('never recorded combat');
    });

    test('the table cell and tooltip carry the basis through', () => {
        const body = buildPanelBody(
            attribution({ combatBasis: basis({ sessionDays: 2, combatRan: true, sessions: 4 }) })
        );
        const row = body.querySelector('.mwi-gold-sources-row-combat');
        expect(row.textContent).toContain('Measured — battle feed');
        expect(row.title).toContain('battle feed filled 2 days');
    });

    test('days neither recording covers are called out, not left as a silent zero', () => {
        const body = buildPanelBody(
            attribution({
                combatBasis: basis({ uncoveredDays: 5, emptySessions: 2, sessions: 2, combatRan: true }),
            })
        );
        const note = body.querySelector('.mwi-gold-sources-combat-gap');
        expect(note.textContent).toContain('5 days');
        expect(note.textContent).toContain('2 recorded runs');
        expect(note.textContent).toContain('residual');
        expect(note.textContent).toContain('20 most recent runs');
    });

    test('nothing is said when both recordings covered the window', () => {
        const body = buildPanelBody(
            attribution({ combatBasis: basis({ lootLogDays: 2, combatRan: true, sessions: 2 }) })
        );
        expect(body.querySelector('.mwi-gold-sources-combat-gap')).toBeNull();
    });
});

describe('buildBars', () => {
    test('one row per day, each with a segment per non-zero source', () => {
        const bars = buildBars(attribution());
        const tracks = bars.querySelectorAll('.mwi-gold-sources-track');
        expect(tracks.length).toBe(2);
        expect(tracks[0].querySelectorAll('.mwi-gold-sources-seg-combat').length).toBe(1);
        expect(tracks[0].querySelectorAll('.mwi-gold-sources-seg-residual').length).toBe(1);
    });

    test('a day with no measured change gets no residual segment', () => {
        const bars = buildBars(attribution());
        const tracks = bars.querySelectorAll('.mwi-gold-sources-track');
        expect(tracks[1].querySelectorAll('.mwi-gold-sources-seg-residual').length).toBe(0);
    });

    test('an empty window says so rather than drawing nothing', () => {
        const bars = buildBars({ days: [] });
        expect(bars.textContent).toContain('No days in this window yet');
    });
});

describe('tooltips', () => {
    test('name the recording and when it started', () => {
        const tip = sourceTooltip('combat', { combat: D19 });
        expect(tip).toContain('Loot log history');
        expect(tip).toContain('since 2026-08-19');
        expect(tip).toContain('Measured');
    });

    test('say plainly when a source has recorded nothing', () => {
        expect(coverageText(null)).toContain('Nothing has been recorded');
    });

    test('mark the estimated source as estimated', () => {
        expect(sourceTooltip('production', {})).toContain('Estimated');
    });
});

describe('the modal', () => {
    test('opens, draws, and closes again', async () => {
        collectGoldSourceInputs.mockResolvedValueOnce({
            series: [
                { t: D19, total: 1000 },
                { t: D20, total: 4000 },
            ],
            lootEntries: [],
            actionType: () => null,
            productionDays: [],
            alchemySessions: [],
            enhancementSessions: [],
            tradeFills: [],
            combatSessions: [],
            price: () => null,
            marketTax: 0.05,
        });

        await goldSourcesPanel.openModal();
        const modal = document.getElementById(MODAL_ID);
        expect(modal).toBeTruthy();
        expect(modal.textContent).toContain('Where the gold came from');
        expect(modal.querySelector('.mwi-gold-sources-body')).toBeTruthy();
        expect(modal.textContent).not.toContain('could not be drawn');

        goldSourcesPanel.closeModal();
        expect(document.getElementById(MODAL_ID)).toBeNull();
    });

    test('a source that cannot be read leaves the panel standing', async () => {
        collectGoldSourceInputs.mockRejectedValueOnce(new Error('storage is gone'));
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await goldSourcesPanel.openModal();
        const modal = document.getElementById(MODAL_ID);
        expect(modal).toBeTruthy();
        expect(modal.textContent).toContain('could not be drawn');
        goldSourcesPanel.closeModal();
    });
});

describe('buildTotalsTable', () => {
    test('shares are taken against the measured change, so they add up to more than nothing', () => {
        const table = buildTotalsTable(attribution());
        const combat = table.querySelector('.mwi-gold-sources-row-combat');
        // 5M of a 20M measured change
        expect(combat.textContent).toContain('25%');
    });

    test('a losing window does not report an earning source as a negative share', () => {
        // Dividing by the signed delta flipped every sign: combat genuinely
        // brought 5M in, and the column said it was minus a quarter of the week
        const table = buildTotalsTable(
            attribution({
                totals: { sources: { combat: 5_000_000 }, explained: 5_000_000, delta: -20_000_000, residual: null },
            })
        );

        const combat = table.querySelector('.mwi-gold-sources-row-combat');
        expect(combat.textContent).toContain('25%');
        expect(combat.textContent).not.toContain('-25%');
    });

    test('a loss explained by a loss is a positive share of it', () => {
        // Both sides negative: enhancement burned 16M of a 20M fall. The
        // signed-numerator version printed -80%, which reads as "worked against
        // the change" when it is in fact most of the change
        const table = buildTotalsTable(
            attribution({
                totals: {
                    sources: { enhancement: -16_000_000 },
                    explained: -16_000_000,
                    delta: -20_000_000,
                    residual: null,
                },
            })
        );

        const enhancement = table.querySelector('.mwi-gold-sources-row-enhancement');
        expect(enhancement.textContent).toContain('80%');
        expect(enhancement.textContent).not.toContain('-80%');
        // The direction is still on the amount beside it
        expect(enhancement.textContent).toContain('-16');
    });

    test('the column says what the share is of', () => {
        expect(buildTotalsTable(attribution()).textContent).toContain('Share of change');
    });

    test('with no measured change there is nothing to take a share of', () => {
        const table = buildTotalsTable(
            attribution({ totals: { sources: {}, explained: 0, delta: null, residual: null } })
        );
        expect(table.querySelector('.mwi-gold-sources-row-combat').textContent).toContain('—');
    });
});

describe('the daily net worth calendar section', () => {
    const NOW = new Date(2026, 7, 22, 15).getTime();
    /** A snapshot at a local wall-clock time, so the day keying is the reader's */
    const at = (month, day, hour, total) => ({ t: new Date(2026, month - 1, day, hour).getTime(), total });

    /** Open the section and hand back the drawn calendar */
    function openCalendar(series, now = NOW) {
        const body = buildPanelBody(attribution(), { series, now });
        const section = body.querySelector('.mwi-nw-calendar-section');
        section.querySelector('.mwi-nw-calendar-toggle').click();
        return { body, section };
    }

    test('the grid is not built until the section is opened', () => {
        const body = buildPanelBody(attribution(), { series: [at(8, 20, 20, 100)], now: NOW });
        const section = body.querySelector('.mwi-nw-calendar-section');

        expect(section).toBeTruthy();
        expect(section.querySelector('.mwi-nw-calendar-grid')).toBeNull();

        section.querySelector('.mwi-nw-calendar-toggle').click();
        expect(section.querySelector('.mwi-nw-calendar-grid')).toBeTruthy();
    });

    test('a panel drawn without a series has no calendar at all', () => {
        expect(buildPanelBody(attribution()).querySelector('.mwi-nw-calendar-section')).toBeNull();
    });

    test('cells are classed by the sign of the day', () => {
        const { section } = openCalendar([at(8, 19, 20, 100), at(8, 20, 20, 900), at(8, 21, 20, 400)]);
        const cell = (day) => section.querySelector(`.mwi-nw-calendar-cell[data-day="${day}"]`);

        expect(cell('2026-08-20').className).toContain('mwi-nw-calendar-cell-gain');
        expect(cell('2026-08-21').className).toContain('mwi-nw-calendar-cell-loss');
        // The opening day has nothing before it, and today has no snapshot
        expect(cell('2026-08-19').className).toContain('mwi-nw-calendar-cell-nodata');
        expect(cell('2026-08-22').className).toContain('mwi-nw-calendar-cell-nodata');
    });

    test('a day with no snapshot says so rather than reading as a flat day', () => {
        const { section } = openCalendar([at(8, 20, 20, 100), at(8, 21, 20, 160)]);
        const quiet = section.querySelector('.mwi-nw-calendar-cell[data-day="2026-08-22"]');

        expect(quiet.title).toContain('no data');
        expect(quiet.title).toContain('not a day of zero change');
        expect(quiet.className).not.toContain('mwi-nw-calendar-cell-flat');
    });

    test('the tooltip carries the exact figure and the date', () => {
        const { section } = openCalendar([at(8, 20, 20, 1_000_000), at(8, 21, 20, 3_500_000)]);
        const cell = section.querySelector('.mwi-nw-calendar-cell[data-day="2026-08-21"]');

        expect(cell.title).toContain('2026-08-21');
        expect(cell.title).toContain('+2.50M');
    });

    test('a cell carrying a multi-day gap is marked and says how far back the last snapshot is', () => {
        const { section } = openCalendar([at(8, 16, 20, 100), at(8, 21, 20, 700)]);
        const cell = section.querySelector('.mwi-nw-calendar-cell[data-day="2026-08-21"]');

        expect(cell.className).toContain('mwi-nw-calendar-cell-gap');
        expect(cell.textContent).toBe('·');
        expect(cell.title).toContain('5 days back');
        expect(cell.title).toContain('whole change');
    });

    test('an ordinary day is not marked', () => {
        const { section } = openCalendar([at(8, 20, 20, 100), at(8, 21, 20, 160)]);
        const cell = section.querySelector('.mwi-nw-calendar-cell[data-day="2026-08-21"]');
        expect(cell.className).not.toContain('mwi-nw-calendar-cell-gap');
        expect(cell.textContent).toBe('');
    });

    test('the summary line names both extremes and counts the days each way', () => {
        const { section } = openCalendar([
            at(8, 18, 20, 1_000_000),
            at(8, 19, 20, 3_000_000),
            at(8, 20, 20, 2_000_000),
            at(8, 21, 20, 2_500_000),
        ]);

        const summary = section.querySelector('.mwi-nw-calendar-summary').textContent;
        expect(summary).toContain('Best +2.00M on 2026-08-19');
        expect(summary).toContain('worst -1.00M on 2026-08-20');
        expect(summary).toContain('2 up / 1 down');
    });

    test('an empty history says nothing has been measured rather than reporting a best day', () => {
        const { section } = openCalendar([]);
        expect(section.querySelector('.mwi-nw-calendar-summary').textContent).toContain('No day in this window');
    });
});

describe('calendarSummaryText', () => {
    test('nothing measured is not dressed up as a zero best day', () => {
        expect(calendarSummaryText({ measured: 0, positive: 0, negative: 0, best: null, worst: null })).toContain(
            'No day in this window'
        );
        expect(calendarSummaryText(null)).toContain('No day in this window');
    });
});

describe('calendarCellKind', () => {
    test('classes by sign, with a zero of its own and no data of its own', () => {
        expect(calendarCellKind({ delta: 5 })).toBe('gain');
        expect(calendarCellKind({ delta: -5 })).toBe('loss');
        expect(calendarCellKind({ delta: 0 })).toBe('flat');
        expect(calendarCellKind({ delta: null })).toBe('nodata');
        expect(calendarCellKind(null)).toBe('nodata');
    });
});
