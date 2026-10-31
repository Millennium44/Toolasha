/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ actions: [], active: true }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        isFromActiveSocket: (context) => (context?.socket === 'old' ? false : game.active),
    },
}));

const { isLabyrinthFightActive, isFromActiveSocket } = await import('./labyrinth-activity.js');

const header = (text) => {
    document.body.innerHTML = `<div class="Header_actionName__x1">${text}</div>`;
};
const action = (actionHrid, over = {}) => ({ id: 1, actionHrid, ordinal: 1, isDone: false, ...over });

describe('which fight is on screen', () => {
    beforeEach(() => {
        game.actions = [];
        game.active = true;
        document.body.innerHTML = '';
    });

    test('a Chinese labyrinth header counts, by the running action rather than the English word', () => {
        header('迷宫 - 独眼巨人 Lv.200');
        game.actions = [action('/actions/combat/labyrinth/explore')];
        expect(isLabyrinthFightActive()).toBe(true);
    });

    test('a zone fight under a labyrinth-looking header is not a labyrinth fight', () => {
        header('Labyrinth - Cyclops Lv.200');
        game.actions = [action('/actions/combat/fly')];
        expect(isLabyrinthFightActive()).toBe(false);
    });

    test('a queued zone behind the running labyrinth action does not decide it', () => {
        game.actions = [
            action('/actions/combat/fly', { id: 2, ordinal: 2 }),
            action('/actions/combat/labyrinth/explore'),
        ];
        expect(isLabyrinthFightActive()).toBe(true);
    });

    test('with no action known the header text is the fallback, in either language', () => {
        header('Labyrinth - Cyclops Lv.200');
        expect(isLabyrinthFightActive()).toBe(true);
        header('迷宫 - 独眼巨人 Lv.200');
        expect(isLabyrinthFightActive()).toBe(true);
        header('Fly');
        expect(isLabyrinthFightActive()).toBe(false);
        document.body.innerHTML = '';
        expect(isLabyrinthFightActive()).toBe(false);
    });
});

describe('which connection a frame came from', () => {
    test('a frame from a stale socket is refused, a current one is taken', () => {
        game.active = true;
        expect(isFromActiveSocket({ socket: 'old' })).toBe(false);
        expect(isFromActiveSocket({ socket: 'new' })).toBe(true);
    });
});
