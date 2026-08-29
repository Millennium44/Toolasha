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

const game = vi.hoisted(() => ({ skills: [], table: [], dmHandlers: {}, actions: [], actionDetails: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => game.skills,
        getInitClientData: () => ({ levelExperienceTable: game.table }),
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
        getCurrentCharacterId: () => 'char1',
        getCurrentActions: () => game.actions,
        getActionDetails: (hrid) => game.actionDetails[hrid],
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: { getJSON: async () => null, setJSON: async () => {} },
}));

vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
    markPanelInteracted: () => {},
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
    game.actions = [];
    game.actionDetails = {};
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

    test('a target several levels off is the number on the tile', () => {
        train('melee', 1000000);
        select({ skill: 'defense', level: 130, focus: 'defense' });

        expect(draw()).toContain('Defense 130');
    });

    test('no arrow, because it cost the number it was introducing', () => {
        // "Defense → 130:" ellipsised to "Defense → 1…" on a tile this narrow
        train('melee', 1000000);
        select({ skill: 'defense', level: 130, focus: 'defense' });

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
        expect(drawn).toContain('Combat 130');
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

describe('a combat target yields the tile, but only to a skilling skill', () => {
    function addSkill(name, level) {
        game.skills.push({ skillHrid: `/skills/${name}`, level, experience: game.table[level] });
    }

    test('a target gaining nothing steps aside while tailoring climbs, and keeps the tooltip', () => {
        addSkill('tailoring', 150);
        select({ skill: 'melee', level: 140 });
        train('tailoring', 1000000);

        const container = document.createElement('div');
        ttlRow.render(container);
        expect(container.textContent).toContain('Tailoring 151');
        expect(container.textContent).not.toContain('Melee');
        expect(container.title).toContain('Target Melee 140 is set but gaining nothing');
    });

    test('with nothing climbing at all, the target holds the tile', () => {
        select({ skill: 'melee', level: 140 });

        const drawn = draw();
        expect(drawn).toContain('Melee 140');
        expect(drawn).toContain('—');
    });
});

describe('the Skill Time to Level tile answers only for the queue', () => {
    const skillingRow = registeredRows().find((row) => row.key === 'skillTimeToLevel');

    function drawSkilling() {
        const container = document.createElement('div');
        skillingRow.render(container);
        return container;
    }

    function queueTailoring() {
        game.skills.push({ skillHrid: '/skills/tailoring', level: 150, experience: game.table[150] });
        game.actions = [{ actionHrid: '/actions/tailoring/kraken_tunic', isDone: false, ordinal: 0 }];
        game.actionDetails['/actions/tailoring/kraken_tunic'] = { type: '/action_types/tailoring' };
    }

    test('it reports the queued skill with a measured time, and no target can redirect it', () => {
        // The module-level history carries earlier tests' readings, and its
        // sample throttle would swallow this test's second reading — start it
        // the way a fresh character does
        game.dmHandlers.character_switching();
        queueTailoring();
        select({ skill: 'melee', level: 140 });

        drawSkilling();
        grant('tailoring', 1000000);
        vi.setSystemTime(Date.now() + 5 * 60 * 1000);
        const container = drawSkilling();

        expect(container.textContent).toContain('Tailoring 151');
        expect(container.textContent).not.toContain('Melee');
        expect(container.title).toContain('xp/hr');
    });

    test('no rate yet shows the skill with a dash rather than nothing', () => {
        queueTailoring();

        const container = drawSkilling();
        expect(container.textContent).toContain('Tailoring 151');
        expect(container.textContent).toContain('—');
    });

    test('a combat action up front blanks it rather than borrowing combat numbers', () => {
        train('melee', 1000000);
        game.actions = [{ actionHrid: '/actions/combat/golem_cave', isDone: false, ordinal: 0 }];
        game.actionDetails['/actions/combat/golem_cave'] = { type: '/action_types/combat' };

        expect(drawSkilling().textContent).toBe('');
    });
});

describe('this row keeps its own history, apart from combat-level-panel.js', () => {
    test('character_switching clears it, so a switch to a higher-xp character is not read as a burst of progress', () => {
        // This row's own skill-history instance only self-corrects a reading
        // that goes *backwards* — a switch to a character further along in a
        // skill looks exactly like real progress until the ten-minute window
        // rolls the old reading out on its own. Without a reset tied to
        // character_switching, the tile would report a huge xp/hr and a
        // nonsense ETA under the arriving character's name.
        train('melee', 1000000);
        expect(draw()).toContain('Melee 135');

        // The switch: a different character, already much further along in
        // the same skill — nothing here looks like a decrease
        game.skills = game.skills.map((skill) =>
            skill.skillHrid === '/skills/melee' ? { ...skill, experience: skill.experience + 50_000_000 } : skill
        );
        game.dmHandlers.character_switching();

        // Without the reset, this reads an enormous rate from the 50M jump
        // over the last sample interval — with it, there is nothing measurable
        // again until two fresh readings land
        expect(draw()).toBe('');
    });
});
