/** @vitest-environment happy-dom */

/**
 * The Queue Time Left tile.
 *
 * The arithmetic is one line and `action-calculator` is mocked to a flat answer,
 * because what is worth pinning down here is not the multiplication — it is the
 * three shapes of queue the tile has to tell apart. A queue of counted actions
 * has a time. A queue whose running action has no count has no time at all, and
 * must not read as a zero. And a counted action *in front of* an unbounded one
 * has a time, which is time until the queue stops changing rather than time
 * until it empties.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    rows: {},
    actions: [],
    skills: [{ skillHrid: '/skills/milking', level: 50 }],
    clientData: { itemDetailMap: {} },
    stats: { actionTime: 10, totalEfficiency: 0 },
}));

vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        getSkills: () => game.skills,
        getInitClientData: () => game.clientData,
        getEquipment: () => new Map(),
        getActionDetails: (hrid) => (hrid ? { name: hrid, type: '/action_types/milking' } : null),
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => game.stats,
}));

vi.mock('../../utils/efficiency.js', () => ({
    calculateEfficiencyMultiplier: (percent) => 1 + percent / 100,
}));

const { queueTimeLeft } = await import('./queue-time-row.js');

/**
 * A counted action.
 * @param {number} maxCount - How many were queued
 * @param {number} currentCount - How many are done
 * @returns {Object} A queued action
 */
function counted(maxCount, currentCount = 0) {
    return { actionHrid: '/actions/milking/cow', hasMaxCount: true, maxCount, currentCount, isDone: false };
}

/** An action with no count on it. @returns {Object} */
function unbounded() {
    return { actionHrid: '/actions/milking/cow', hasMaxCount: false, isDone: false };
}

/**
 * Draw the tile into a fresh container.
 * @returns {HTMLElement} The container
 */
function draw() {
    const container = document.createElement('div');
    game.rows.queueTimeLeft.render(container);
    return container;
}

describe('the queue time tile', () => {
    beforeEach(() => {
        game.actions = [];
        game.skills = [{ skillHrid: '/skills/milking', level: 50 }];
        game.clientData = { itemDetailMap: {} };
        game.stats = { actionTime: 10, totalEfficiency: 0 };
    });

    test('registers, off by default', () => {
        expect(game.rows.queueTimeLeft).toBeDefined();
        expect(game.rows.queueTimeLeft.defaultVisible).toBe(false);
    });

    test('is a summary with nothing behind it — the monitor panel is about other characters', () => {
        expect(typeof game.rows.queueTimeLeft.onOpen).not.toBe('function');
    });

    test('an empty queue draws nothing at all', () => {
        expect(draw().textContent).toBe('');
    });

    test('a queue the game has not loaded yet draws nothing', () => {
        game.clientData = null;
        game.actions = [counted(100)];

        expect(queueTimeLeft()).toBeNull();
        expect(draw().textContent).toBe('');
    });

    test('counted actions add up to a duration', () => {
        // 100 left at 10s each, and 50 more at 10s each: 1500s, or 25 minutes
        game.actions = [counted(100), counted(100, 50)];

        const left = queueTimeLeft();
        expect(left.seconds).toBe(1500);
        expect(left.finite).toBe(2);
        expect(draw().textContent).toContain('25m');
    });

    test('efficiency shortens the queue', () => {
        game.stats = { actionTime: 10, totalEfficiency: 100 };
        game.actions = [counted(100)];

        expect(queueTimeLeft().seconds).toBe(500);
    });

    test('finished actions are not queued work', () => {
        game.actions = [{ ...counted(100), isDone: true }, counted(10)];

        const left = queueTimeLeft();
        expect(left.queued).toBe(1);
        expect(left.seconds).toBe(100);
    });

    test('an unbounded action alone reads as ∞, never as a zero', () => {
        game.actions = [unbounded()];

        const left = queueTimeLeft();
        expect(left.infinite).toBe(true);
        expect(left.seconds).toBe(0);

        const container = draw();
        expect(container.textContent).toContain('∞');
        expect(container.textContent).not.toContain('0s');
        expect(container.title).toContain('never empties');
    });

    test('a counted action ahead of an unbounded one still has a time, and says what it is', () => {
        game.actions = [counted(60), unbounded()];

        const container = draw();
        expect(container.textContent).toContain('10m');
        expect(container.title).toContain('no count is queued');
    });
});
