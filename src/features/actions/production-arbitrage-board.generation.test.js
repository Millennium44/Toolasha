/** @vitest-environment happy-dom */

/**
 * The arbitrage board's generation counter.
 *
 * `ensureRows()` used to have no way to tell an abandoned ranking run from
 * the current one: its `onProgress` callback and its final `.then` closed
 * over `this` (the module singleton) and wrote straight into `this.rows` /
 * `this.progress` and called `this.panel?.render()` whenever they fired —
 * whether or not anything still wanted that result.
 *
 * Two ways that showed up:
 *   - A character switch calls disable() then initialize() again. If a
 *     ranking for the departing character was still running, its callbacks
 *     kept firing into the *new* character's freshly-built panel.
 *   - Recompute cleared `this.rows` and called `ensureRows()`, which bails
 *     out immediately whenever `this.computing` is already true — so a
 *     Recompute clicked while "Costing recipes…" was still on screen was a
 *     silent no-op.
 *
 * `rankProductionArbitrage` is mocked here as a deferred promise per call, so
 * each test can control exactly when a run "finishes" relative to the next
 * action taken.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const panelState = vi.hoisted(() => ({ created: null }));

/** One pending `rankProductionArbitrage` call, resolvable by hand. */
const ranking = vi.hoisted(() => ({
    /** @type {Array<{onProgress: Function, resolve: Function, reject: Function}>} */
    pending: [],
    calls: 0,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, COLOR_ACCENT: '#22c55e' },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

vi.mock('../../utils/simple-panel.js', () => ({
    createPanel: ({ draw }) => {
        const panel = document.createElement('div');
        const body = document.createElement('div');
        panel.appendChild(body);
        const api = {
            draw,
            render: () => {
                body.replaceChildren();
                draw(body);
            },
            show: () => {
                if (!panel.isConnected) document.body.appendChild(panel);
                api.render();
            },
            hide: () => panel.remove(),
            get panel() {
                return panel;
            },
        };
        panelState.created = api;
        return api;
    },
}));

vi.mock('../../utils/item-navigation.js', () => ({
    navigateToAction: () => true,
    navigateToItem: () => true,
}));

vi.mock('../../utils/liquidity-cap.js', () => ({
    liquidityMarkerHtml: () => '',
}));

vi.mock('./production-arbitrage.js', async () => {
    const actual = await vi.importActual('./production-arbitrage.js');
    return {
        PRODUCTION_SKILLS: actual.PRODUCTION_SKILLS,
        arrangeRows: actual.arrangeRows,
        rankProductionArbitrage: ({ onProgress } = {}) => {
            ranking.calls += 1;
            return new Promise((resolve, reject) => {
                ranking.pending.push({ onProgress, resolve, reject });
            });
        },
        clearProductionArbitrageCache: () => {},
    };
});

const { default: board } = await import('./production-arbitrage-board.js');

/**
 * A minimal but fully-shaped row — drawTable() reads every field
 * unconditionally, so a partial object throws mid-render rather than
 * standing in for "the wrong character's data" the way these tests need.
 * @param {string} itemHrid
 * @returns {Object}
 */
function row(itemHrid) {
    return {
        itemHrid,
        itemName: itemHrid,
        actionHrid: `/actions/cheesesmithing/${itemHrid}`,
        actionName: itemHrid,
        skillHrid: '/skills/cheesesmithing',
        skillLabel: 'Cheesesmithing',
        requiredLevel: 1,
        level: 50,
        levelMet: true,
        materialCostPerUnit: 50,
        saleAfterTax: 95,
        marginPerUnit: 40,
        marginPerAction: 40,
        marginPerHour: 4000,
        actionsPerHour: 100,
        unitsPerHour: 100,
        makeablePerDay: 2400,
        unitsPerDay: 2400,
        marginPerDay: 96_000,
        uncappedMarginPerDay: 96_000,
        liquidityLimit: null,
        volumeChecked: true,
        quality: null,
        qualityNote: '',
        profitData: {},
    };
}

/** Settle whatever microtasks a resolved/rejected ranking still has queued */
async function settle() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
    ranking.pending = [];
    ranking.calls = 0;
    board.initialize();
});

afterEach(() => {
    board.disable();
    document.body.replaceChildren();
});

describe('a character switch mid-ranking', () => {
    test('an in-flight run does not render into the panel built for the next character', async () => {
        board.open();
        expect(ranking.calls).toBe(1);
        const firstRun = ranking.pending[0];

        // The switch: this character's board is torn down...
        board.disable();
        // ...and a fresh one stands up for whoever is now active
        board.initialize();
        board.open();
        await settle();
        expect(ranking.calls).toBe(2);
        const secondRun = ranking.pending[1];
        const secondRows = [row('/items/new-character-item')];
        const staleRows = [row('/items/old-character-item')];

        // The abandoned run for the departed character finally lands
        firstRun.onProgress?.(1, 1, staleRows);
        firstRun.resolve(staleRows);
        await settle();

        // It must not have overwritten what the current run already produced,
        // nor what it will produce
        expect(board.rows).not.toEqual(staleRows);

        secondRun.resolve(secondRows);
        await settle();
        expect(board.rows).toEqual(secondRows);
    });
});

describe('recompute while a ranking is already running', () => {
    test('supersedes the in-flight run rather than being silently dropped', async () => {
        board.open();
        expect(ranking.calls).toBe(1);
        const firstRun = ranking.pending[0];
        expect(board.computing).toBe(true);

        // Recompute, clicked while "Costing recipes…" is still on screen
        board.recompute();
        await settle();

        // A second ranking actually started — the old code's ensureRows()
        // bailed out here because `computing` was still true from the first
        expect(ranking.calls).toBe(2);
        const secondRun = ranking.pending[1];
        const secondRows = [row('/items/recomputed')];
        const staleRows = [row('/items/stale')];

        // The superseded first run resolves after the second one has started
        firstRun.resolve(staleRows);
        await settle();
        // Its result must not have landed, and must not have left `computing`
        // stuck (the superseded run's own finally must not touch it either)
        expect(board.rows).not.toEqual(staleRows);

        secondRun.resolve(secondRows);
        await settle();

        expect(board.rows).toEqual(secondRows);
        expect(board.computing).toBe(false);
    });
});
