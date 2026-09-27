/** @vitest-environment happy-dom */

/**
 * The Enhancement Session tile.
 *
 * The tracker owns the session, so nothing here checks arithmetic it does not
 * do. What is worth pinning down is that the tile reads a live session rather
 * than a stale one, keeps drawing a finished session instead of blanking it at
 * the moment its totals become interesting, and actually reaches the panel on a
 * double-click.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    rows: {},
    session: null,
    stored: {},
    sessionThrows: false,
    uiToggles: 0,
}));

vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
}));

vi.mock('./enhancement-tracker.js', () => ({
    default: {
        getCurrentSession: () => {
            if (game.sessionThrows) throw new Error('storage is asleep');
            return game.session;
        },
        getAllSessions: () => game.stored,
    },
}));

vi.mock('./enhancement-ui.js', () => ({
    default: {
        toggle: () => {
            game.uiToggles += 1;
        },
    },
}));

await import('./enhancement-session-row.js');

/**
 * A session as the tracker keeps one.
 * @param {Object} [overrides] - Fields to change
 * @returns {Object} A session
 */
function session(overrides = {}) {
    return {
        state: 'tracking',
        itemHrid: '/items/blazing_trident',
        itemName: 'Blazing Trident',
        startLevel: 5,
        currentLevel: 7,
        targetLevel: 10,
        totalAttempts: 148,
        totalSuccesses: 22,
        totalCost: 310_000_000,
        ...overrides,
    };
}

/**
 * Draw the tile into a fresh container.
 * @returns {HTMLElement} The container
 */
function draw() {
    const container = document.createElement('div');
    game.rows.enhancementSession.render(container);
    return container;
}

describe('the enhancement session tile', () => {
    beforeEach(() => {
        game.session = null;
        game.stored = {};
        game.sessionThrows = false;
        game.uiToggles = 0;
    });

    test('registers, off by default', () => {
        expect(game.rows.enhancementSession).toBeDefined();
        expect(game.rows.enhancementSession.defaultVisible).toBe(false);
    });

    test('draws nothing when there are no sessions at all', () => {
        expect(draw().textContent).toBe('');
    });

    test('a tracker that cannot answer is logged rather than thrown', () => {
        game.sessionThrows = true;
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(draw().textContent).toBe('');
        expect(logged).toHaveBeenCalled();

        logged.mockRestore();
    });

    test('a live session draws its attempts, spend and the level it is on', () => {
        game.session = session();

        const container = draw();
        expect(container.textContent).toContain('+7→10');
        expect(container.textContent).toContain('148');
        expect(container.textContent).toContain('310.00M');
    });

    test('the tooltip carries the success rate the tile has no room for', () => {
        game.session = session();

        expect(draw().title).toContain('14.9%');
        expect(draw().title).toContain('Blazing Trident');
    });

    test('a finished session keeps drawing, and says that it is finished', () => {
        // The tracker's current session is null the moment a run completes;
        // the finished one is only in the stored list
        game.session = null;
        game.stored = {
            older: session({ state: 'completed', totalAttempts: 9, lastUpdateTime: 1_000 }),
            latest: session({ state: 'completed', currentLevel: 10, lastUpdateTime: 2_000 }),
        };

        const container = draw();
        expect(container.textContent).toContain('148');
        expect(container.title).toContain('finished');
    });

    test('a session with no attempts yet still draws, at zero', () => {
        game.session = session({ totalAttempts: 0, totalSuccesses: 0, totalCost: 0, currentLevel: 5 });

        expect(draw().textContent).toContain('+5→10');
    });

    test('opening the tile toggles the enhancement panel', () => {
        game.rows.enhancementSession.onOpen();

        expect(game.uiToggles).toBe(1);
    });

    test('drawing it never opens anything', () => {
        game.session = session();
        draw();

        expect(game.uiToggles).toBe(0);
    });

    test('it says what a double-click will do', () => {
        game.session = session();

        expect(draw().title).toContain('Double-click for the enhancement panel');
    });
});
