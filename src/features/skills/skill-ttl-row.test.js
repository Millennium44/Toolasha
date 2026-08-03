/**
 * @vitest-environment happy-dom
 *
 * The Time to Level tile, and the target it is supposed to follow.
 *
 * The row has two jobs and they conflict: on its own it reports whichever skill
 * is going up fastest, and once a target has been chosen in the Combat Level
 * panel it must report that instead. Getting the precedence wrong is not a
 * visible error — the tile goes on showing a true and useless number, and the
 * selector that was supposed to drive it looks broken.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ skills: [], table: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => game.skills,
        getInitClientData: () => ({ levelExperienceTable: game.table }),
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: { getJSON: async () => null, setJSON: async () => {} },
}));

vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: () => {},
    saveGeometry: () => {},
}));

vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({
        totalWisdom: 0,
        charmExperience: 0,
        charmBreakdown: [],
        totalMultiplier: 1,
    }),
}));

const { select, clearSelection } = await import('../ui/combat-level-panel.js');
await import('./skill-ttl-row.js');
const { registeredRows } = await import('../../utils/overlay-rows.js');

const ttlRow = registeredRows().find((row) => row.key === 'timeToLevel');

const BUILD = { stamina: 110, intelligence: 100, attack: 129, defense: 120, melee: 134, ranged: 107, magic: 106 };

function experienceTable() {
    const table = [0, 0];
    for (let level = 2; level <= 200; level++) {
        table[level] = table[level - 1] + Math.round(1000 * Math.pow(1.09, level - 1));
    }
    return table;
}

function character() {
    game.table = experienceTable();
    game.skills = Object.entries(BUILD).map(([name, level]) => ({
        skillHrid: `/skills/${name}`,
        level,
        experience: game.table[level],
    }));
}

function grant(name, amount) {
    game.skills.find((skill) => skill.skillHrid === `/skills/${name}`).experience += amount;
}

/** Draw the row and read it back */
function draw() {
    const container = document.createElement('div');
    ttlRow.render(container);
    return container.textContent;
}

/** Give the row two readings far enough apart to measure a rate from */
function train(name, amount) {
    draw();
    grant(name, amount);
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    return draw();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    character();
    clearSelection();
});

afterEach(() => {
    clearSelection();
    vi.useRealTimers();
});

describe('with no target chosen', () => {
    test('it reports the skill going up fastest, as it always did', () => {
        // The level being worked towards, not the one already held: the time
        // beside it is time until that number
        expect(train('melee', 1000000)).toContain('Melee 135');
    });

    test('nothing measurable yet draws nothing rather than a guess', () => {
        expect(draw()).toBe('');
    });
});

describe('with a target chosen in the panel', () => {
    test('it follows the choice rather than the fastest skill', () => {
        // The reported bug: choosing Defense left the tile reporting Melee
        train('melee', 1000000);

        select({ skill: 'defense', level: 121, focus: 'defense' });
        const drawn = draw();

        expect(drawn).toContain('Defense 121');
        expect(drawn).not.toContain('Melee');
    });

    test('a target beyond the next level is spelled out', () => {
        train('melee', 1000000);
        select({ skill: 'defense', level: 130, focus: 'defense' });

        expect(draw()).toContain('Defense → 130');
    });

    test('the next level is not spelled out, since the arrow would say nothing', () => {
        train('melee', 1000000);
        select({ skill: 'defense', level: 121, focus: 'defense' });

        expect(draw()).not.toContain('→');
    });

    test('a skill nothing is pointed at says so rather than inventing a time', () => {
        train('melee', 1000000);
        select({ skill: 'magic', level: 110 });

        const container = document.createElement('div');
        ttlRow.render(container);
        expect(container.textContent).toContain('Magic');
        expect(container.textContent).toContain('—');
        expect(container.title).toContain('Nothing is pointed at this skill');
    });

    test('the combat level is a target like any other', () => {
        train('melee', 1000000);
        select({ skill: 'combat', level: 130, focus: 'melee' });

        const drawn = draw();
        expect(drawn).toContain('Combat → 130');
        expect(drawn).not.toContain('Melee');
    });

    test('clearing the choice hands the row back its own question', () => {
        train('melee', 1000000);
        select({ skill: 'defense', level: 121 });
        expect(draw()).toContain('Defense');

        clearSelection();
        expect(draw()).toContain('Melee');
    });
});
