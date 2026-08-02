/**
 * @vitest-environment happy-dom
 *
 * The panel's rendering, exercised rather than reasoned about.
 *
 * Everything else in this repository is tested in `node`, because everything
 * else worth testing is arithmetic. This file is the exception, and it exists
 * because of a specific failure: a method was called and never written, the
 * render threw on it, and every section below that point silently did not
 * appear. No arithmetic test could have caught that — the arithmetic was fine.
 * Only building the panel catches it.
 *
 * So the load-bearing assertion here is the dullest one: **the panel renders
 * every section and none of them reports a failure**. A missing method, a
 * renamed helper, a property read off an object that stopped having it — all of
 * them fail that one line.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The character the panel reads, swapped between tests.
 *
 * Hoisted because `vi.mock` factories run before the module body, so a plain
 * `let` here would still be in its temporal dead zone when the mock is built.
 */
const game = vi.hoisted(() => ({ skills: [], table: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => game.skills,
        getInitClientData: () => ({ levelExperienceTable: game.table }),
    },
}));

// Geometry is held in IndexedDB, which is not what this file is about
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: () => {},
    saveGeometry: () => {},
}));

vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({
        totalWisdom: 62.65,
        charmExperience: 0,
        charmBreakdown: [],
        totalMultiplier: 1.6265,
    }),
}));

const { combatLevelPanel, combatSkillState, combatProgress, nextCombatLevel, busiest, resetSession } =
    await import('./combat-level-panel.js');

/** A plausible experience curve, since the real one is 200 rows of the game's */
function experienceTable() {
    const table = [0, 0];
    for (let level = 2; level <= 200; level++) {
        table[level] = table[level - 1] + Math.round(1000 * Math.pow(1.09, level - 1));
    }
    return table;
}

/** The build from GWhiz's own panel, so the figures mean something */
const BUILD = { stamina: 110, intelligence: 100, attack: 129, defense: 120, melee: 134, ranged: 107, magic: 106 };

/**
 * Put a character in front of the panel.
 *
 * @param {Object} [fractions] - Skill name → how far into its level, 0 to 1
 * @returns {Array<Object>} The skill list the mock will serve
 */
function character(fractions = {}) {
    game.table = experienceTable();
    game.skills = Object.entries(BUILD).map(([name, level]) => {
        const floor = game.table[level];
        const span = game.table[level + 1] - floor;
        return {
            skillHrid: `/skills/${name}`,
            level,
            experience: floor + (fractions[name] ?? 0) * span,
        };
    });
    return game.skills;
}

/**
 * Give a skill experience, as the game would.
 * @param {string} name - Skill name
 * @param {number} amount - How much
 */
function grant(name, amount) {
    const skill = game.skills.find((entry) => entry.skillHrid === `/skills/${name}`);
    skill.experience += amount;
}

const text = () => combatLevelPanel.panel.textContent;
const FAILED = 'could not be drawn';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'));
    character();
    resetSession(combatSkillState().skills);
});

afterEach(() => {
    combatLevelPanel.hide();
    // The panel keeps its selections between openings, which is right for a
    // panel and wrong for a test — one test's target must not be the next's
    combatLevelPanel.targets = {};
    combatLevelPanel.lookup = { from: null, to: null };
    combatLevelPanel.ttl = { skill: null, level: null };
    combatLevelPanel.assigned = { primary: null, focus: null };
    combatLevelPanel.collapsed = {};
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('the panel renders at all', () => {
    test('every section is drawn, and none of them fails', () => {
        // The assertion the missing-method bug would have failed. It shipped
        // because a panel that stops halfway looks like a panel missing a
        // feature, and nothing anywhere said otherwise.
        combatLevelPanel.show();

        for (const heading of ['Start:', 'Target Selector', 'Combat', 'Time to Level', 'Charms', 'Exp Lookup']) {
            expect(text()).toContain(heading);
        }
        expect(text()).not.toContain(FAILED);
    });

    test('it renders with a character that has no experience anywhere', () => {
        character();
        combatLevelPanel.show();
        expect(text()).not.toContain(FAILED);
    });

    test('it says so rather than throwing when the game has sent nothing', () => {
        game.skills = [];
        combatLevelPanel.show();
        expect(text()).toContain('No combat skills loaded yet');
    });

    test('opening it twice does not build a second one', () => {
        combatLevelPanel.show();
        combatLevelPanel.show();
        expect(document.querySelectorAll('#toolasha-combat-level-panel')).toHaveLength(1);
    });

    test('hiding it takes it off the page and stops its clock', () => {
        combatLevelPanel.show();
        combatLevelPanel.hide();
        expect(document.querySelector('#toolasha-combat-level-panel')).toBeNull();
        expect(combatLevelPanel.refreshId).toBeNull();
    });
});

describe('one section failing costs one section', () => {
    test('the sections after a thrown one still appear', () => {
        combatLevelPanel.show();
        vi.spyOn(combatLevelPanel, '_combatBlock').mockImplementation(() => {
            throw new Error('deliberate');
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});

        combatLevelPanel._render();

        expect(text()).toContain('deliberate');
        // The three sections below the one that threw
        expect(text()).toContain('Time to Level');
        expect(text()).toContain('Exp Lookup');
    });
});

describe('the figures on it', () => {
    test('the formula is the one the game’s own number comes from', () => {
        combatLevelPanel.show();
        expect(text()).toContain('0.1×(110+100+129+120+134)+0.5×134=126.300');
    });

    test('the bar counts the part-finished level, not just the whole ones', () => {
        // Melee halfway to 135 is worth 0.5 x 0.6 = 0.3 combat levels already
        // earned, so 126.300 + 0.300 = 126.600 — a 60% bar where the fraction
        // of the displayed number alone would say 30%
        character({ melee: 0.5 });
        combatLevelPanel.show();

        expect(combatProgress(combatSkillState()).partial.exact).toBeCloseTo(126.6, 6);
        expect(text()).toContain('60.0%');
        expect(text()).not.toContain('30.0%');
    });

    test('the shortest route to the next combat level is named', () => {
        combatLevelPanel.show();
        expect(text()).toContain('2 levels of Melee needed to level Combat');
    });
});

describe('rates, once there is a window to measure over', () => {
    /**
     * Move the clock forward and grant the experience that time bought.
     *
     * The clock is moved rather than let run: letting it run fires the panel's
     * five-second refresh sixty times for five minutes of measurement, which is
     * sixty full renders to produce two readings. Two readings is all a rate is.
     *
     * @param {number} minutes - How long
     * @param {Object<string, number>} perMinute - Skill name → experience a minute
     */
    function train(minutes, perMinute) {
        for (const [name, amount] of Object.entries(perMinute)) grant(name, amount * minutes);
        vi.setSystemTime(Date.now() + minutes * 60 * 1000);
        combatLevelPanel._render();
    }

    test('nothing claims a rate before the window is long enough', () => {
        combatLevelPanel.show();
        // Twenty seconds is the floor, and this is the first render
        expect(busiest(combatSkillState())).toBeNull();
        expect(text()).toContain('measuring');
    });

    test('a skill gaining experience gets its own block, with its share', () => {
        combatLevelPanel.show();
        train(5, { melee: 200000, attack: 100000 });

        expect(busiest(combatSkillState()).name).toBe('melee');
        // 200k of every 300k
        expect(text()).toContain('(66.7%)');
        expect(text()).toContain('(33.3%)');
    });

    test('a skill gaining nothing gets a tile rather than a row of dashes', () => {
        combatLevelPanel.show();
        train(5, { melee: 200000 });

        // Ranged is not being trained, so it is in the compact half
        expect(text()).toContain('Ranged');
        expect(text()).not.toContain(FAILED);
    });

    test('a clock that goes backwards starts the measurement again rather than stopping it', () => {
        // Readings stamped in the future cannot be measured against anything —
        // the window between them is negative — so without this the rates go
        // quiet until real time catches up, which for a resume from sleep can
        // be hours
        combatLevelPanel.show();
        train(5, { melee: 200000 });
        expect(busiest(combatSkillState()).name).toBe('melee');

        vi.setSystemTime(Date.now() - 60 * 60 * 1000);
        combatLevelPanel._render();
        expect(busiest(combatSkillState())).toBeNull();

        train(5, { melee: 200000 });
        expect(busiest(combatSkillState()).name).toBe('melee');
    });

    test('switching character starts the measurement again rather than reporting the gap', () => {
        // A test-server character beside a live one is an ordinary thing to
        // have, and the difference between their totals is not a rate
        combatLevelPanel.show();
        train(5, { melee: 200000 });
        expect(busiest(combatSkillState()).name).toBe('melee');

        character();
        train(5, {});
        expect(busiest(combatSkillState())).toBeNull();

        train(5, { melee: 200000 });
        expect(busiest(combatSkillState()).name).toBe('melee');
        expect(text()).not.toContain(FAILED);
    });

    test('the next combat level is costed from the route, not from the rate alone', () => {
        combatLevelPanel.show();
        train(5, { melee: 200000 });

        const next = nextCombatLevel(combatSkillState());
        expect(next.skill).toBe('melee');
        expect(next.levels).toBe(2);
        // Two levels of Melee at the measured rate, against the real table —
        // not the remaining combat fraction divided by a combat-per-hour figure
        expect(next.seconds).toBeGreaterThan(0);
        expect(next.seconds).toBeCloseTo(secondsForLevels('melee', 2, 200000 * 60), -1);
    });

    /**
     * @param {string} name - Skill
     * @param {number} levels - How many
     * @param {number} perHour - Measured rate
     * @returns {number} Seconds those levels cost
     */
    function secondsForLevels(name, levels, perHour) {
        const skill = game.skills.find((entry) => entry.skillHrid === `/skills/${name}`);
        const owed = game.table[skill.level + levels] - skill.experience;
        return (owed / perHour) * 3600;
    }
});

describe('the controls', () => {
    const inputs = () => [...combatLevelPanel.panel.querySelectorAll('input[type="number"]')];
    const selects = () => [...combatLevelPanel.panel.querySelectorAll('select')];

    test('a target typed into a row is kept and used', () => {
        combatLevelPanel.show();
        // The first row's target box, past the selector's own
        const box = inputs()[1];
        box.value = '140';
        box.dispatchEvent(new Event('change'));

        expect(combatLevelPanel.targets.stamina).toBe(140);
        expect(inputs()[1].value).toBe('140');
    });

    test('a target below one is refused rather than dividing by a negative', () => {
        combatLevelPanel.show();
        const box = inputs()[1];
        box.value = '-5';
        box.dispatchEvent(new Event('change'));

        expect(combatLevelPanel.targets.stamina).toBe(1);
    });

    test('choosing a different skill in the selector drops the level meant for the old one', () => {
        combatLevelPanel.show();
        combatLevelPanel.ttl = { skill: 'melee', level: 200 };

        const picker = selects()[0];
        picker.value = 'magic';
        picker.dispatchEvent(new Event('change'));

        expect(combatLevelPanel.ttl).toEqual({ skill: 'magic', level: null });
    });

    test('the exp lookup shows the subtraction it did', () => {
        combatLevelPanel.show();
        combatLevelPanel.lookup = { from: 1, to: 3 };
        combatLevelPanel._render();

        const expected = game.table[3] - game.table[1];
        expect(text()).toContain(`${expected.toLocaleString()} exp`);
    });

    test('a folded section stays folded, and unfolds again', () => {
        combatLevelPanel.show();
        expect(text()).toContain('Exp Lookup');

        combatLevelPanel.collapsed.lookup = true;
        combatLevelPanel._render();
        expect(text()).toContain('▶ Exp Lookup');

        combatLevelPanel.collapsed.lookup = false;
        combatLevelPanel._render();
        expect(text()).toContain('▼ Exp Lookup');
    });

    test('Reset starts the session clock again', () => {
        combatLevelPanel.show();
        grant('melee', 500000);
        vi.setSystemTime(Date.now() + 10 * 60 * 1000);
        combatLevelPanel._render();
        expect(text()).toContain('500,000');

        const reset = [...combatLevelPanel.panel.querySelectorAll('button')].find(
            (button) => button.textContent === 'Reset'
        );
        reset.click();

        expect(text()).not.toContain('500,000');
    });

    test('a field being typed into is not rebuilt underneath', () => {
        combatLevelPanel.show();
        const box = inputs()[1];
        box.focus();
        box.value = '14';

        combatLevelPanel._render();

        // Half a level number survives the five-second refresh
        expect(combatLevelPanel.panel.querySelectorAll('input[type="number"]')[1].value).toBe('14');
    });
});

describe('Primary and Focus point the measured shares somewhere else', () => {
    test('a skill gaining nothing is given the rate of the one it replaced', () => {
        combatLevelPanel.show();
        grant('melee', 1000000);
        vi.setSystemTime(Date.now() + 5 * 60 * 1000);
        combatLevelPanel._render();

        const melee = combatSkillState().skills.find((skill) => skill.name === 'melee');
        const ranged = combatSkillState().skills.find((skill) => skill.name === 'ranged');
        expect(melee.perHour).toBeCloseTo(12000000, 0);
        expect(ranged.perHour).toBeNull();

        combatLevelPanel.assigned.focus = 'ranged';
        combatLevelPanel._render();

        // Ranged is not gaining anything, but under this assignment it would be
        // gaining what Melee is — which is the question the selector asks
        expect(rowFor('Ranged')).toContain('12,000,000');
        expect(text()).not.toContain(FAILED);
    });

    /**
     * The Time to Level line for one skill.
     * @param {string} name - Skill label
     * @returns {string} The row's text, cells run together
     */
    function rowFor(name) {
        const rows = [...combatLevelPanel.panel.querySelectorAll('div')];
        const line = rows.find((div) => div.style.display === 'grid' && div.textContent.startsWith(name));
        return line?.textContent ?? '';
    }
});
