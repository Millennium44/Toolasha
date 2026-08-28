/** @vitest-environment happy-dom */

/**
 * The Skill Level tile.
 *
 * What it has to get right is which action counts as "active" — the front of
 * the queue by ordinal, not insertion order — and which action types report
 * nothing at all: an empty queue, and combat/labyrinth, which do not train a
 * single skill. Everything it reads comes straight off `dataManager`, so a
 * character switch is just the next render reading different data — there is
 * no reading kept between renders for a switch to leave stale.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    rows: {},
    actions: [],
    skills: [],
    table: [],
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
        getInitClientData: () => ({ levelExperienceTable: game.table }),
        getActionDetails: (hrid) => game.actionDetails?.[hrid] || null,
    },
}));

const { activeSkillProgress } = await import('./skill-level-row.js');

/**
 * A queued action.
 * @param {string} actionHrid - Which action
 * @param {number} ordinal - Queue position, lower is more active
 * @param {boolean} [isDone] - Whether it has already finished
 * @returns {Object} A queued action
 */
function queued(actionHrid, ordinal, isDone = false) {
    return { actionHrid, ordinal, isDone };
}

/**
 * Draw the tile into a fresh container.
 * @returns {HTMLElement} The container
 */
function draw() {
    const container = document.createElement('div');
    game.rows.skillLevel.render(container);
    return container;
}

describe('the skill level tile', () => {
    beforeEach(() => {
        game.actions = [];
        game.skills = [
            { skillHrid: '/skills/tailoring', level: 20, experience: 1500 },
            { skillHrid: '/skills/milking', level: 50, experience: 99999 },
        ];
        game.table = [0, 0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500];
        // 21 levels' worth so tailoring (level 20) and its experience stay in range
        game.table = Array.from({ length: 200 }, (_, level) => level * level * 50);
        game.actionDetails = {
            '/actions/tailoring/robe': { type: '/action_types/tailoring' },
            '/actions/milking/cow': { type: '/action_types/milking' },
            '/actions/combat/monster': { type: '/action_types/combat' },
            '/actions/labyrinth/room': { type: '/action_types/labyrinth' },
        };
    });

    test('registers with no panel behind it', () => {
        expect(game.rows.skillLevel).toBeDefined();
        expect(typeof game.rows.skillLevel.onOpen).not.toBe('function');
    });

    test('an empty queue draws nothing', () => {
        expect(activeSkillProgress()).toBeNull();
        expect(draw().textContent).toBe('');
    });

    test('reports the skill the front action trains', () => {
        game.actions = [queued('/actions/tailoring/robe', 3)];

        const progress = activeSkillProgress();
        expect(progress.name).toBe('Tailoring');
        expect(progress.level).toBe(20);

        const text = draw().textContent;
        expect(text).toContain('Tailoring');
        expect(text).toContain('20');
        expect(text).toMatch(/%/);
    });

    test('picks the front of the queue by ordinal, not array order', () => {
        // Insertion order has milking first, but tailoring has the lower ordinal
        game.actions = [queued('/actions/milking/cow', 5), queued('/actions/tailoring/robe', 1)];

        expect(activeSkillProgress().name).toBe('Tailoring');
    });

    test('a finished action in front is skipped for the next one still running', () => {
        game.actions = [queued('/actions/tailoring/robe', 1, true), queued('/actions/milking/cow', 2)];

        expect(activeSkillProgress().name).toBe('Milking');
    });

    test('combat is not a trained skill', () => {
        game.actions = [queued('/actions/combat/monster', 1)];

        expect(activeSkillProgress()).toBeNull();
        expect(draw().textContent).toBe('');
    });

    test('labyrinth is not a trained skill either', () => {
        game.actions = [queued('/actions/labyrinth/room', 1)];

        expect(activeSkillProgress()).toBeNull();
    });

    test('a skill missing from the character (not yet loaded) reports nothing', () => {
        game.actions = [queued('/actions/tailoring/robe', 1)];
        game.skills = [{ skillHrid: '/skills/milking', level: 50, experience: 99999 }];

        expect(activeSkillProgress()).toBeNull();
    });

    test('a character switch is just the next read — nothing carries over', () => {
        game.actions = [queued('/actions/tailoring/robe', 1)];
        expect(activeSkillProgress().name).toBe('Tailoring');

        // Arriving character has no tailoring queued at all
        game.actions = [queued('/actions/milking/cow', 1)];
        game.skills = [{ skillHrid: '/skills/milking', level: 12, experience: 40 }];

        const progress = activeSkillProgress();
        expect(progress.name).toBe('Milking');
        expect(progress.level).toBe(12);
    });

    test('the cap reports no experience remaining, and says so in the tooltip', () => {
        game.actions = [queued('/actions/tailoring/robe', 1)];
        game.skills = [{ skillHrid: '/skills/tailoring', level: game.table.length - 1, experience: 1e12 }];

        const progress = activeSkillProgress();
        expect(progress.remaining).toBeNull();
        expect(draw().title).toContain('level cap');
    });
});
