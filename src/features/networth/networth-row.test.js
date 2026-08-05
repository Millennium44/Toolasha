/** @vitest-environment happy-dom */

/**
 * The Net Worth tile, and the chart behind it.
 *
 * The tile is the one headline figure the feature publishes, and the history
 * chart is where that figure came from and where it has been — so a double-click
 * has somewhere obvious to go. Registered at module scope, which is what makes it
 * testable without starting the feature: importing the module is enough.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    rows: {},
    currentData: null,
    chartToggles: 0,
    chartRejects: false,
}));

vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
}));

vi.mock('./networth-history-chart.js', () => ({
    default: {
        toggleModal: async () => {
            game.chartToggles += 1;
            if (game.chartRejects) throw new Error('storage is asleep');
        },
        closeModal: () => {},
        setNetworthFeature: () => {},
    },
}));

const networthFeature = (await import('./index.js')).default;

/**
 * Draw the tile into a fresh container.
 * @returns {HTMLElement} The container it drew into
 */
function draw() {
    const container = document.createElement('div');
    game.rows.netWorth.render(container);
    return container;
}

describe('the Net Worth tile', () => {
    beforeEach(() => {
        networthFeature.currentData = null;
        game.chartToggles = 0;
        game.chartRejects = false;
    });

    test('registers itself on import, without the feature being started', () => {
        expect(game.rows.netWorth).toBeDefined();
        expect(networthFeature.isActive).toBe(false);
    });

    test('draws nothing before a total has been calculated', () => {
        expect(draw().textContent).toBe('');
    });

    test('draws the total once one has been published', () => {
        networthFeature.currentData = { totalNetworth: 1_234_567_890 };

        expect(draw().textContent).toContain('Net Worth');
        expect(draw().textContent).toContain('1.23B');
    });

    test('opens the history chart when the tile is opened', async () => {
        expect(typeof game.rows.netWorth.onOpen).toBe('function');

        await game.rows.netWorth.onOpen();

        expect(game.chartToggles).toBe(1);
    });

    test('says what a double-click will do', () => {
        networthFeature.currentData = { totalNetworth: 100 };

        expect(draw().title).toContain('Double-click for the net worth history chart');
    });

    test('a chart that fails to open is logged rather than thrown', async () => {
        game.chartRejects = true;
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(game.rows.netWorth.onOpen()).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalled();

        logged.mockRestore();
    });

    test('rendering the summary never opens the chart on its own', () => {
        networthFeature.currentData = { totalNetworth: 100 };
        draw();

        expect(game.chartToggles).toBe(0);
    });
});
