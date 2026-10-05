/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    char: '900001',
    characterData: null,
    characterSkills: null,
    tracker: null,
    skills: null,
    testServer: false,
    clientData: null,
    simulate: vi.fn(),
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        get characterSkills() {
            return game.characterSkills;
        },
        guildBuildingLevelMap: { '/guild_buildings/skilling_encampment': 2 },
        getCurrentCharacterId: () => game.char,
        getInitClientData: () => game.clientData,
    },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    guildXpTracker: () => game.tracker,
    guildMemberSkills: () => game.skills,
}));
vi.mock('../../utils/game-server.js', () => ({ isTestServer: () => game.testServer }));
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
    parseTrialMinLevels,
} from './guild-trial-assign-ui.js';
import { GUILD_SKILLING_TICKS, CURRENT_TRIALS_DATA_SKILLING } from '../guild/guild-trial-messages.fixture.js';
import { optimizeTrialAssignment } from './guild-trial-assign.js';

/** A Friday 00:00 UTC, as the game's currentWeekStartMs computes it */
const WEEK = '2026-10-02T00:00:00.000Z';
const NOW = Date.parse('2026-10-05T12:00:00Z');
const CRAFTING = '/guild_skilling/crafting';
const MILKING = '/guild_skilling/milking';

/** Guild members as the XP tracker keeps them (`memberMeta`, from `guildCharacterMap`) */
let META;

function freshMeta() {
    return {
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
}

function makeTracker() {
    return {
        getCurrentWeekStartAt: () => WEEK,
        getMemberList: () => Object.entries(META).map(([characterID, meta]) => ({ characterID, ...meta })),
        getMemberMeta: (id) => META[id] || null,
    };
}

const LEVELS = {
    crafter: { '/skills/crafting': 140, '/skills/milking': 95 },
    milker: { '/skills/crafting': 90, '/skills/milking': 150 },
};

function makeSkills() {
    return {
        initialized: true,
        all: () => ({ crafter: {}, milker: {} }),
        levelFor: (name, skill) => LEVELS[name.toLowerCase()]?.[skill] ?? null,
    };
}

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
    const sim = { kind: 'assign', generation: 0, readings: {}, successReadings: {}, panel: null };
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
const markers = (shell, id) =>
    [...shell.querySelectorAll(`tr[data-member-id="${id}"] [data-coverage]`)].map((m) => m.dataset.coverage);
const placedBy = (planner) => Object.fromEntries(planner.result.result.members.map((m) => [m.name, m.trialHrid]));

async function recommend(planner, shell) {
    click(shell, 'Recommend sign-ups');
    await vi.waitFor(() => expect(planner.controller).toBeNull());
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    META = freshMeta();
    game.char = '900001';
    game.testServer = false;
    game.characterSkills = null;
    game.characterData = { guildWeeklyTrialSet: { skillHrids: [MILKING, CRAFTING], combatHrids: [] } };
    game.clientData = {
        guildBuildingDetailMap: {
            '/guild_buildings/skilling_encampment': { maxLevel: 10, skillingTrialSlotsPerLevel: 1 },
        },
        guildTrialDetailMap: {
            [CRAFTING]: { skillHrid: '/skills/crafting' },
            [MILKING]: { skillHrid: '/skills/milking' },
        },
        skillDetailMap: { '/skills/crafting': { name: 'Crafting' }, '/skills/milking': { name: 'Milking' } },
    };
    game.tracker = makeTracker();
    game.skills = makeSkills();
    game.simulate.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
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

    test('only members who joined strictly before the week are eligible; this cycle’s sign-ups are read', () => {
        META[900006] = { name: 'OnTheDot', joinTime: WEEK };
        META[900007] = { name: 'Garbled', joinTime: 'not a time' };
        // The tracker stores null when the game sends no join time; that is unreadable, not 1970
        META[900008] = { name: 'NoJoin', joinTime: null };
        const roster = cycleRoster(game.tracker, { now: NOW, testServer: false });
        expect(roster.members.map((m) => m.name)).toEqual(['Crafter', 'Me', 'Milker', 'Unknown']);
        const crafter = roster.members.find((m) => m.name === 'Crafter');
        expect(crafter).toMatchObject({ id: '900002', current: MILKING, inCombat: true });
    });

    test('the test server lets everyone take part, as the game does', () => {
        META[900007] = { name: 'Garbled', joinTime: 'not a time' };
        const names = cycleRoster(game.tracker, { now: NOW, testServer: true }).members.map((m) => m.name);
        expect(names).toContain('Newcomer');
        expect(names).toContain('Garbled');
    });

    test('trial minimum levels are a JSON string, clamped to 200; empty means none', () => {
        expect(parseTrialMinLevels(JSON.stringify({ [CRAFTING]: 120, [MILKING]: 900 }))).toEqual({
            [CRAFTING]: 120,
            [MILKING]: 200,
        });
        expect(parseTrialMinLevels('{}')).toEqual({});
        expect(parseTrialMinLevels('')).toEqual({});
        expect(parseTrialMinLevels('nope')).toEqual({});
    });

    test('members without a reading take the player’s own reading of the trial, level bonus included', () => {
        const reading = { ...GUILD_SKILLING_TICKS[0], at: 1 };
        const assumed = defaultAssumptions(
            [CRAFTING, MILKING],
            { [CRAFTING]: reading },
            {
                ownBaseLevels: { '/skills/crafting': 95 },
                clientData: game.clientData,
            }
        );
        expect(assumed[CRAFTING]).toMatchObject({ efficiency: reading.efficiency, actionSeconds: 4.464 });
        // The reading's curve puts effective level at 100 over a base of 95
        expect(assumed[CRAFTING].levelBonus).toBeCloseTo(5, 9);
        expect(assumed[MILKING].source).toContain('another trial');
        expect(assumed[MILKING].levelBonus).toBe(0);
        expect(defaultAssumptions([MILKING], {})[MILKING]).toMatchObject({ ...FALLBACK_ASSUMPTION, levelBonus: 0 });
    });
});

describe('the Assign skilling view', () => {
    test('draws the roster with coverage markers and recommends a sheet', async () => {
        const { planner, shell, sim } = makeSim();
        sim.readings[CRAFTING] = { ...GUILD_SKILLING_TICKS[0], at: 1 };
        sim.panel.render();

        expect(text(shell)).toContain('Trials from the login payload');
        expect(shell.querySelector('[aria-label="Slots per trial"]').value).toBe('22');
        expect(text(shell)).toContain('Slots: 22 from the Skilling Encampment');
        expect(markers(shell, '900002')).toEqual(['level', 'level']);
        expect(text(shell)).not.toContain('Newcomer');

        await recommend(planner, shell);
        expect(planner.error).toBe('');
        const placed = placedBy(planner);
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
    });

    test('slot cap without Encampment data says so', () => {
        game.clientData = { ...game.clientData, guildBuildingDetailMap: {} };
        const { shell, sim } = makeSim();
        sim.panel.render();
        expect(text(shell)).toContain('Slots: 20 (Encampment data unavailable)');
    });

    test('a pin and a typed level change the inputs', async () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        const input = shell.querySelector('[aria-label="Unknown Crafting level"]');
        input.value = '150';
        input.dispatchEvent(new Event('input'));
        sim.panel.render();
        expect(markers(shell, '900005')[1]).toBe('manual');
        const pin = shell.querySelector('tr[data-member-id="900003"] select');
        pin.value = 'bench';
        pin.dispatchEvent(new Event('change'));
        await recommend(planner, shell);
        const placed = placedBy(planner);
        expect(placed.Milker).toBeNull();
        expect(placed.Unknown).toBe(CRAFTING);
        // Milker is not in combat: leaving skilling costs the participation bonus, and the sheet says so
        expect(text(shell.querySelector('[data-trial-assign="result"]'))).toContain(
            'loses participation bonus unless in combat'
        );
    });

    test('out-of-range assumptions, base work and typed levels are refused, not scored', () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        const inputFor = (caption) => shell.querySelector(`input[aria-label="${caption}"]`);
        const workTime = inputFor('Work time (s)');
        workTime.focus();
        workTime.value = '0';
        workTime.dispatchEvent(new Event('input'));
        expect(Object.values(planner.assumed).some((a) => 'actionSeconds' in a)).toBe(false);
        expect(workTime.style.borderColor).not.toBe('');
        workTime.value = '-3';
        workTime.dispatchEvent(new Event('input'));
        expect(Object.values(planner.assumed).some((a) => 'actionSeconds' in a)).toBe(false);
        workTime.value = '6';
        workTime.dispatchEvent(new Event('input'));
        expect(Object.values(planner.assumed).some((a) => a.actionSeconds === 6)).toBe(true);
        expect(workTime.style.borderColor).toBe('');

        const baseWork = inputFor('Tier 1 base work');
        const before = planner.baseWork;
        baseWork.focus();
        for (const bad of ['0', '-1', '', '2e9']) {
            baseWork.value = bad;
            baseWork.dispatchEvent(new Event('input'));
            expect(planner.baseWork).toBe(before);
            expect(baseWork.style.borderColor).not.toBe('');
        }

        const level = shell.querySelector('[aria-label="Unknown Crafting level"]');
        level.value = '-5';
        level.dispatchEvent(new Event('input'));
        sim.panel.render();
        expect(markers(shell, '900005')[1]).not.toBe('manual');
        // Above the scoring range the cell says the value is not used instead of keeping it silently
        const high = shell.querySelector('[aria-label="Unknown Crafting level"]');
        high.value = '600';
        high.dispatchEvent(new Event('input'));
        expect(high.style.borderColor).not.toBe('');
        expect(high.max).toBe('500');
    });

    test('a pin to a trial that is no longer drawn is dropped and shows Auto', async () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        const pin = shell.querySelector('tr[data-member-id="900003"] select');
        pin.value = MILKING;
        pin.dispatchEvent(new Event('change'));
        const second = shell.querySelectorAll('[aria-label="Trial 1"]')[0];
        second.value = '/guild_skilling/cooking';
        second.dispatchEvent(new Event('change'));
        expect(planner.pins).toEqual({});
        expect(shell.querySelector('tr[data-member-id="900003"] select').value).toBe('');
        await recommend(planner, shell);
        expect(placedBy(planner).Milker).toBe(CRAFTING);
    });

    test('your own base level comes from your character, so you are never without data', () => {
        game.characterSkills = [
            { skillHrid: '/skills/crafting', level: 95 },
            { skillHrid: '/skills/milking', level: 120 },
        ];
        const { shell, sim } = makeSim();
        sim.readings[CRAFTING] = { ...GUILD_SKILLING_TICKS[0], at: 1 };
        sim.panel.render();
        // Milking first: the weekly set's order
        expect(markers(shell, '900001')).toEqual(['level', 'reading']);
        expect(text(shell)).toContain('level bonus');
    });

    test('a trial minimum keeps members below it out, and is shown', async () => {
        game.characterData.guild = { trialMinLevelsData: JSON.stringify({ [CRAFTING]: 120 }) };
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        expect(text(shell)).toContain('min 120');
        expect(markers(shell, '900003')).toEqual(['level', 'below-min']);
        const pin = shell.querySelector('tr[data-member-id="900003"] select');
        pin.value = CRAFTING;
        pin.dispatchEvent(new Event('change'));
        await recommend(planner, shell);
        expect(placedBy(planner).Milker).not.toBe(CRAFTING);
    });

    test('says when skill levels or the roster are not available', () => {
        game.skills = { initialized: false, all: () => ({}), levelFor: () => null };
        let { shell, sim } = makeSim();
        sim.panel.render();
        expect(text(shell)).toContain('Skill levels need the Guild Trials feature on (and profiles opened)');
        document.body.replaceChildren();
        game.skills = null;
        ({ shell, sim } = makeSim());
        sim.panel.render();
        expect(text(shell)).toContain('Skill levels need the Guild Trials feature on (and profiles opened)');
        document.body.replaceChildren();
        game.tracker = { getCurrentWeekStartAt: () => WEEK, getMemberList: () => [], getMemberMeta: () => null };
        ({ shell, sim } = makeSim());
        sim.panel.render();
        expect(text(shell)).toContain('The guild roster is not loaded yet');
    });

    test('a new drawn set drops overrides and the result; changed sign-ups drop the result', async () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        await recommend(planner, shell);
        expect(planner.result).not.toBeNull();
        META[900003] = { ...META[900003], signupWeekStartAt: WEEK, signedUpSkillingTrialHrid: CRAFTING };
        sim.panel.render();
        expect(planner.result).toBeNull();

        await recommend(planner, shell);
        planner.trialOverrides = [CRAFTING];
        planner.setWeeklyTrialSet({ skillHrids: [CRAFTING, MILKING], combatHrids: [] });
        expect(planner.trialOverrides).toBeNull();
        expect(planner.result).toBeNull();
    });

    test('a character switch mid-search discards the result', async () => {
        const { planner, sim } = makeSim();
        sim.panel.render();
        const pending = planner.recommend();
        game.char = '900099';
        sim.generation++;
        await pending;
        expect(planner.result).toBeNull();
    });

    test('the simulator check runs each recommended trial with its sign-up count', async () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        await recommend(planner, shell);
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
        }
        expect(text(shell.querySelector('[data-trial-assign="check"]'))).toContain('T3–T5 (P10–P90)');
    });

    test('canceling the check is not an error and drops partial results', async () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        await recommend(planner, shell);
        let calls = 0;
        game.simulate.mockImplementation(async (_message, _progress, { signal }) => {
            calls++;
            if (calls === 1) return { lowHighestTier: 1, highHighestTier: 2, medianHighestTier: 1, meanBasePoints: 1 };
            return new Promise((resolve, reject) =>
                signal.addEventListener('abort', () => reject(new Error('Simulation canceled.')))
            );
        });
        click(shell, 'Check with simulator');
        await vi.waitFor(() => expect(calls).toBe(2));
        click(shell, 'Cancel');
        await vi.waitFor(() => expect(planner.controller).toBeNull());
        expect(planner.error).toBe('');
        expect(planner.check).toBeNull();
        expect(text(shell)).toContain('Canceled.');
        expect(shell.querySelector('[role="alert"]')).toBeNull();
    });

    test('an edit removes the shown recommendation at once and keeps the caret in the input', async () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        await recommend(planner, shell);
        expect(shell.querySelector('[data-trial-assign="result"]')).not.toBeNull();
        const input = shell.querySelector('[aria-label="Unknown Crafting level"]');
        input.focus();
        input.value = '15';
        input.dispatchEvent(new Event('input'));
        expect(shell.querySelector('[data-trial-assign="result"]')).toBeNull();
        expect(document.activeElement).toBe(input);
        expect(input.isConnected).toBe(true);
    });

    test('a two-pin overflow says which pin was dropped', async () => {
        const { planner, shell, sim } = makeSim();
        planner.cap = 1;
        planner.pins = { 900003: CRAFTING, 900005: CRAFTING };
        planner.manual = { 900005: { [CRAFTING]: '150' } };
        sim.panel.render();
        await recommend(planner, shell);
        const crafting = planner.result.result.trials.find((t) => t.trialHrid === CRAFTING);
        expect(crafting.signups).toBe(1);
        expect(text(shell.querySelector('[data-trial-assign="result"]'))).toContain('pin dropped: trial full');
    });

    test('a sign-up change drops a recommendation built on the old sign-ups without stealing focus', async () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        await recommend(planner, shell);
        const input = shell.querySelector('[aria-label="Unknown Crafting level"]');
        input.focus();
        META[900003] = { ...META[900003], signupWeekStartAt: WEEK, signedUpSkillingTrialHrid: CRAFTING };
        planner.inputsChanged();
        expect(planner.result).toBeNull();
        expect(shell.querySelector('[data-trial-assign="result"]')).toBeNull();
        expect(document.activeElement).toBe(input);
        // Nothing focused: the view redraws with the new sign-up
        input.blur();
        META[900005] = { ...META[900005], signupWeekStartAt: WEEK, signedUpSkillingTrialHrid: MILKING };
        planner.inputsChanged();
        expect(text(shell.querySelector('tr[data-member-id="900005"]'))).toContain('Milking');
    });

    test('a changed input redraws the view; an unchanged one does not', () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        const render = vi.spyOn(sim.panel, 'render');
        planner.inputsChanged();
        expect(render).not.toHaveBeenCalled();

        // A guild update that changes only the minimums
        planner.trialMinLevelsData = JSON.stringify({ [CRAFTING]: 130 });
        planner.inputsChanged();
        expect(render).toHaveBeenCalledTimes(1);
        expect(text(shell)).toContain('Crafting min 130');

        // A new profile capture
        LEVELS.milker['/skills/milking'] = 160;
        planner.inputsChanged();
        expect(render).toHaveBeenCalledTimes(2);
        expect(shell.querySelector('[aria-label="Milker Milking level"]').placeholder).toBe('160');
        LEVELS.milker['/skills/milking'] = 150;

        // A new own reading
        sim.readings[CRAFTING] = { ...GUILD_SKILLING_TICKS[0], at: 2 };
        planner.inputsChanged();
        expect(render).toHaveBeenCalledTimes(3);
        expect(markers(shell, '900001')[1]).toBe('reading');
    });

    test('outside the Assign view nothing is computed or drawn', () => {
        const { planner, sim } = makeSim();
        sim.kind = 'skilling';
        const context = vi.spyOn(planner, 'context');
        planner.inputsChanged();
        expect(context).not.toHaveBeenCalled();
    });

    test('a rename drops the recommendation and its chat text, and redraws', async () => {
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        await recommend(planner, shell);
        META[900002] = { ...META[900002], name: 'Crafter2' };
        LEVELS.crafter2 = LEVELS.crafter;
        planner.inputsChanged();
        expect(planner.result).toBeNull();
        expect(text(shell)).toContain('Crafter2');
        delete LEVELS.crafter2;
    });

    test('a member below the minimum of the trial they signed up for is not kept there, and is told', async () => {
        game.characterData.guild = { trialMinLevelsData: JSON.stringify({ [CRAFTING]: 120, [MILKING]: 120 }) };
        LEVELS.unknown = { '/skills/crafting': 50, '/skills/milking': 50 };
        META[900005] = { ...META[900005], signupWeekStartAt: WEEK, signedUpSkillingTrialHrid: CRAFTING };
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        try {
            await recommend(planner, shell);
            expect(placedBy(planner).Unknown ?? null).toBeNull();
            expect(text(shell.querySelector('[data-trial-assign="result"]'))).toContain(
                'below the trial minimum: must change sign-up'
            );
            expect(text(shell.querySelector('[data-trial-assign="result"]'))).toContain('Unknown');
        } finally {
            delete LEVELS.unknown;
        }
    });

    test('a signed-up member with no data at all is still kept where they signed up', async () => {
        META[900005] = { ...META[900005], signupWeekStartAt: WEEK, signedUpSkillingTrialHrid: CRAFTING };
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        await recommend(planner, shell);
        expect(placedBy(planner).Unknown).toBe(CRAFTING);
    });

    test('the current sign-ups score still counts a below-minimum sign-up in its trial’s pool', async () => {
        game.characterData.guild = { trialMinLevelsData: JSON.stringify({ [CRAFTING]: 120 }) };
        LEVELS.unknown = { '/skills/crafting': 50 };
        META[900002] = { ...META[900002], signedUpSkillingTrialHrid: CRAFTING };
        META[900005] = { ...META[900005], signupWeekStartAt: WEEK, signedUpSkillingTrialHrid: CRAFTING };
        const { planner, shell, sim } = makeSim();
        sim.panel.render();
        try {
            await recommend(planner, shell);
            const { problem, result } = planner.result;
            const unknown = problem.members.find((m) => m.name === 'Unknown');
            expect(unknown).toMatchObject({ current: CRAFTING });
            expect(result.members.find((m) => m.name === 'Unknown').trialHrid).toBeNull();
            // Without that zero-work sign-up the Crafting pool would be 1% smaller
            const without = optimizeTrialAssignment({
                ...problem,
                members: problem.members.filter((m) => m.name !== 'Unknown'),
            });
            expect(result.currentPoints).toBeLessThan(without.currentPoints);
        } finally {
            delete LEVELS.unknown;
        }
    });
});
