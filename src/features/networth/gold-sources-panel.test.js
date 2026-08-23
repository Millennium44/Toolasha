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
