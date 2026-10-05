/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    char: '900001',
    characterData: null,
    simulate: vi.fn(),
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        guildBuildingLevelMap: { '/guild_buildings/skilling_encampment': 2 },
        getCurrentCharacterId: () => game.char,
        getInitClientData: () => ({
            guildBuildingDetailMap: {
                '/guild_buildings/skilling_encampment': { maxLevel: 10, skillingTrialSlotsPerLevel: 1 },
            },
            guildTrialDetailMap: {
                '/guild_skilling/crafting': { skillHrid: '/skills/crafting' },
                '/guild_skilling/milking': { skillHrid: '/skills/milking' },
            },
            skillDetailMap: {
                '/skills/crafting': { name: 'Crafting' },
                '/skills/milking': { name: 'Milking' },
            },
        }),
    },
}));
vi.mock('../../utils/simple-panel.js', () => ({
    panelCard: (parent, text) => {
        const el = document.createElement('div');
        el.textContent = text;
        parent.appendChild(el);
        return el;
    },
    panelNote: (text) => {
        const el = document.createElement('p');
        el.textContent = text;
        return el;
    },
    panelLine: (label, text) => {
        const el = document.createElement('div');
        el.textContent = `${label}: ${text}`;
        return el;
    },
}));
vi.mock('./guild-trial-runner.js', () => ({ runGuildTrialSimulation: (...args) => game.simulate(...args) }));
vi.mock('./combat-sim-adapter.js', () => ({ buildGameDataPayload: () => ({ combatMonsterDetailMap: {} }) }));

import {
    TrialAssignPlanner,
    cycleRoster,
    defaultAssumptions,
    drawnSkillingTrials,
    FALLBACK_ASSUMPTION,
} from './guild-trial-assign-ui.js';
import { GUILD_SKILLING_TICKS, CURRENT_TRIALS_DATA_SKILLING } from '../guild/guild-trial-messages.fixture.js';

const WEEK = '2026-10-02T00:00:00Z';
const CRAFTING = '/guild_skilling/crafting';
const MILKING = '/guild_skilling/milking';

/** Guild members as the XP tracker keeps them (`memberMeta`, from `guildCharacterMap`) */
const META = {
    900001: { name: 'Me', joinTime: '2026-01-01T00:00:00Z' },
    900002: {
        name: 'Crafter',
        joinTime: '2026-02-01T00:00:00Z',
        signupWeekStartAt: WEEK,
        signedUpSkillingTrialHrid: MILKING,
        signedUpCombatTrialHrid: '/guild_combat/badger',
    },
    900003: { name: 'Milker', joinTime: '2026-03-01T00:00:00Z' },
    900004: { name: 'Newcomer', joinTime: '2026-10-03T00:00:00Z' },
    900005: { name: 'Unknown', joinTime: '2026-03-01T00:00:00Z' },
};

const tracker = {
    getCurrentWeekStartAt: () => WEEK,
    getMemberList: () => Object.entries(META).map(([characterID, meta]) => ({ characterID, ...meta })),
    getMemberMeta: (id) => META[id] || null,
};

const LEVELS = {
    crafter: { '/skills/crafting': 140, '/skills/milking': 95 },
    milker: { '/skills/crafting': 90, '/skills/milking': 150 },
};
const skills = { levelFor: (name, skill) => LEVELS[name.toLowerCase()]?.[skill] ?? null };

/** The simulator's controls, as guild-trial-sim.js draws them */
const ui = {
    button(parent, label, handler, disabled = false) {
        const el = document.createElement('button');
        el.textContent = label;
        el.disabled = disabled;
        el.addEventListener('click', handler);
        parent.appendChild(el);
        return el;
    },
    row(parent) {
        const el = document.createElement('div');
        parent.appendChild(el);
        return el;
    },
    field(parent, label, value, change) {
        const input = document.createElement('input');
        input.setAttribute('aria-label', label);
        input.value = value;
        input.addEventListener('input', () => change(Number(input.value)));
        parent.appendChild(input);
        return input;
    },
    select(parent, label, value, options, change) {
        const input = document.createElement('select');
        input.setAttribute('aria-label', label);
        for (const [key, text] of options) {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = text;
            input.appendChild(option);
        }
        input.value = value;
        input.addEventListener('change', () => change(input.value));
        parent.appendChild(input);
    },
};

function makeSim() {
    const shell = document.createElement('section');
    document.body.appendChild(shell);
    const sim = { generation: 0, readings: {}, successReadings: {}, panel: null };
    const planner = new TrialAssignPlanner(sim);
    sim.panel = {
        render: () => {
            shell.replaceChildren();
            planner.draw(shell, ui);
        },
    };
    return { sim, planner, shell };
}

const text = (root) => root.textContent;
const click = (root, label) => [...root.querySelectorAll('button')].find((b) => b.textContent === label).click();

beforeEach(() => {
    game.char = '900001';
    game.characterData = { guildWeeklyTrialSet: { skillHrids: [MILKING, CRAFTING], combatHrids: [] } };
    globalThis.window.Toolasha = { Combat: { guildXPTracker: tracker, guildMemberSkills: skills } };
    game.simulate.mockReset();
});

afterEach(() => {
    document.body.replaceChildren();
    delete globalThis.window.Toolasha;
});

describe('cycle inputs', () => {
    test('drawn trials come from the weekly set, then the trial progress payload', () => {
        expect(drawnSkillingTrials({ characterData: game.characterData })).toEqual({
            trials: [MILKING, CRAFTING],
            source: 'login payload',
        });
        const during = drawnSkillingTrials({
            characterData: { guild: { currentTrialsData: CURRENT_TRIALS_DATA_SKILLING } },
        });
        expect(during.trials.sort()).toEqual(
            ['/guild_skilling/alchemy', '/guild_skilling/brewing', '/guild_skilling/cooking', MILKING].sort()
        );
        expect(drawnSkillingTrials({}).trials).toEqual([]);
    });

    test('only members who joined before the cycle are eligible; this cycle’s sign-ups are read', () => {
        const roster = cycleRoster(tracker);
        expect(roster.members.map((m) => m.name)).toEqual(['Crafter', 'Me', 'Milker', 'Unknown']);
        const crafter = roster.members.find((m) => m.name === 'Crafter');
        expect(crafter).toMatchObject({ id: '900002', current: MILKING, inCombat: true });
    });

    test('members without a reading take the player’s own reading of the trial', () => {
        const reading = { ...GUILD_SKILLING_TICKS[0], at: 1 };
        const assumed = defaultAssumptions([CRAFTING, MILKING], { [CRAFTING]: reading });
        expect(assumed[CRAFTING]).toMatchObject({ efficiency: reading.efficiency, actionSeconds: 4.464 });
        expect(assumed[MILKING].source).toBe('your reading of another trial');
        expect(defaultAssumptions([MILKING], {})[MILKING]).toMatchObject(FALLBACK_ASSUMPTION);
    });
});

describe('the Assign skilling view', () => {
    test('draws the roster with coverage markers and recommends a sheet', async () => {
        const { planner, shell, sim } = makeSim();
        sim.readings[CRAFTING] = { ...GUILD_SKILLING_TICKS[0], at: 1 };
        sim.panel.render();

        expect(text(shell)).toContain('Trials from the login payload');
        expect(shell.querySelector('[aria-label="Slots per trial"]').value).toBe('22');
        const crafterRow = shell.querySelector('tr[data-member-id="900002"]');
        expect([...crafterRow.querySelectorAll('[data-coverage]')].map((m) => m.dataset.coverage)).toEqual([
            'level',
            'level',
        ]);
        const meRow = shell.querySelector('tr[data-member-id="900001"]');
        // Milking first: the weekly set's order
        expect([...meRow.querySelectorAll('[data-coverage]')].map((m) => m.dataset.coverage)).toEqual([
            'missing',
            'reading',
        ]);
        expect(text(shell)).not.toContain('Newcomer');

        click(shell, 'Recommend sign-ups');
        await vi.waitFor(() => expect(planner.result).not.toBeNull());
        expect(planner.error).toBe('');
        const placed = Object.fromEntries(planner.result.result.members.map((m) => [m.name, m.trialHrid]));
        expect(placed.Crafter).toBe(CRAFTING);
        expect(placed.Milker).toBe(MILKING);
        expect(placed.Unknown).toBeUndefined(); // no data, no sign-up: not placed
        const result = shell.querySelector('[data-trial-assign="result"]');
        expect(text(result)).toContain('Expected base points');
        expect(text(result)).toContain('was Milking');
        expect(text(result)).toContain('1 eligible members have no level or reading');
        const message = shell.querySelector('textarea').value;
        expect(message).toContain('Crafting: ');
        expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(400);
        expect(text(shell)).not.toContain('could not be drawn');
    });

    test('a pin and a typed level change the inputs', async () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        const input = shell.querySelector('[aria-label="Unknown Crafting level"]');
        input.value = '150';
        input.dispatchEvent(new Event('input'));
        sim.panel.render();
        const row = shell.querySelector('tr[data-member-id="900005"]');
        expect(row.querySelectorAll('[data-coverage]')[1].dataset.coverage).toBe('manual');
        const pin = shell.querySelector('tr[data-member-id="900003"] select');
        pin.value = 'bench';
        pin.dispatchEvent(new Event('change'));
        click(shell, 'Recommend sign-ups');
        await vi.waitFor(() => expect(planner.result).not.toBeNull());
        const placed = Object.fromEntries(planner.result.result.members.map((m) => [m.name, m.trialHrid]));
        expect(placed.Milker).toBeNull();
        expect(placed.Unknown).toBe(CRAFTING);
    });

    test('a character switch mid-search discards the result', async () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        const pending = planner.recommend();
        game.char = '900099';
        sim.generation++;
        await pending;
        expect(planner.result).toBeNull();
        expect(shell).toBeTruthy();
    });

    test('the simulator check runs each recommended trial with its sign-up count', async () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        click(shell, 'Recommend sign-ups');
        await vi.waitFor(() => expect(planner.result).not.toBeNull());
        game.simulate.mockImplementation(async ({ scenario }) => ({
            lowHighestTier: 3,
            highHighestTier: 5,
            medianHighestTier: 4,
            meanBasePoints: 520,
            trialHrid: scenario.trialHrid,
        }));
        click(shell, 'Check with simulator');
        await vi.waitFor(() => expect(planner.controller).toBeNull());
        expect(planner.error).toBe('');
        const calls = game.simulate.mock.calls.map(([message]) => message.scenario);
        expect(calls.map((s) => s.trialHrid).sort()).toEqual([CRAFTING, MILKING]);
        for (const scenario of calls) {
            const trial = planner.result.result.trials.find((t) => t.trialHrid === scenario.trialHrid);
            expect(scenario.participantCount).toBe(trial.signups);
            expect(scenario.kind).toBe('skilling');
        }
        expect(text(shell.querySelector('[data-trial-assign="check"]'))).toContain('T3–T5 (P10–P90)');
    });
});
