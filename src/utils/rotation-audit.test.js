/**
 * The rotation auditor's arithmetic.
 *
 * Everything worth asserting here is a ratio that has to survive being wrong in
 * a specific way: an ability that cannot be paid for and one the rotation simply
 * never reaches produce the same cast count and want opposite fixes, so the test
 * that matters is the one that separates them. The rest is the discipline the
 * combat trackers all keep — a rate with nothing to divide by is null, never
 * zero — and the cooldown model, which is deliberately conservative and must not
 * quietly become optimistic.
 */

import { describe, test, expect } from 'vitest';
import {
    newRotationState,
    noteRotationKit,
    noteRotationFight,
    foldRotationTick,
    summariseRotation,
    abilityVerdict,
    bestChange,
    MAX_TICK_GAP_MS,
} from './rotation-audit.js';

const CHEAP = '/abilities/cheap';
const PRICEY = '/abilities/pricey';
const SLOW = '/abilities/slow';

/** Costs and cooldowns as the game states them: mana flat, cooldown in nanoseconds */
const DETAILS = {
    [CHEAP]: { manaCost: 10, cooldownDuration: 2e9 },
    [PRICEY]: { manaCost: 500, cooldownDuration: 5e9 },
    [SLOW]: { manaCost: 20, cooldownDuration: 10e9 },
};

const START = 1_700_000_000_000;

/**
 * Feed a run of ticks half a second apart.
 *
 * @param {Object} state - The audit state
 * @param {Array<Object>} ticks - `{mana, maxMana, action, cast, events}` per tick
 * @param {Object} [options] - `{step}` ms between ticks
 * @returns {Object} The same state
 */
function run(state, ticks, { step = 500 } = {}) {
    let attacks = 0;
    ticks.forEach((tick, index) => {
        if (tick.cast) attacks += 1;
        foldRotationTick(state, {
            at: START + index * step,
            player: { cMP: tick.mana, mMP: tick.maxMana ?? 1000, atkCounter: attacks },
            action: tick.action || 'idle',
            events: tick.events || [],
            detailMap: DETAILS,
        });
    });
    return state;
}

/** A state with both abilities on the bar and one fight begun */
function armed(kit = [CHEAP, PRICEY]) {
    const state = newRotationState();
    noteRotationKit(state, kit, DETAILS);
    noteRotationFight(state);
    return state;
}

/** @param {Object} summary - From `summariseRotation` @param {string} hrid - Which row */
const rowFor = (summary, hrid) => summary.abilities.find((row) => row.hrid === hrid);

describe('what the bar states', () => {
    test('a slotted ability is a row before it has ever fired', () => {
        const summary = summariseRotation(armed());

        expect(summary.abilities.map((row) => row.hrid).sort()).toEqual([CHEAP, PRICEY].sort());
        expect(rowFor(summary, PRICEY).casts).toBe(0);
        expect(rowFor(summary, PRICEY).equipped).toBe(true);
    });

    test('the starvation floor is the cheapest non-aura cost on the bar', () => {
        expect(summariseRotation(armed()).castFloor).toBe(10);

        const state = newRotationState();
        noteRotationKit(state, [PRICEY, '/abilities/fierce_aura'], {
            ...DETAILS,
            '/abilities/fierce_aura': { manaCost: 1 },
        });
        // The aura is a point cheaper and is still not what stalling means
        expect(summariseRotation(state).castFloor).toBe(500);
    });
});

describe('a starved ability', () => {
    const ticks = Array.from({ length: 21 }, () => ({ mana: 100, action: CHEAP, cast: true }));

    test('is ready the whole fight and unaffordable for all of it', () => {
        const summary = summariseRotation(run(armed(), ticks));
        const pricey = rowFor(summary, PRICEY);

        expect(summary.seconds).toBeCloseTo(10, 5);
        expect(pricey.casts).toBe(0);
        expect(pricey.readySeconds).toBeCloseTo(10, 5);
        expect(pricey.starvedShare).toBe(1);
        expect(pricey.uptime).toBe(0);
    });

    test('says so, and says which way the fix runs', () => {
        const summary = summariseRotation(run(armed(), ticks));
        const verdict = rowFor(summary, PRICEY).verdict;

        expect(verdict.kind).toBe('starved');
        expect(verdict.text).toContain('0% uptime');
        expect(verdict.text).toContain('starved 100%');
        expect(verdict.text).toMatch(/drop it or raise regen/);
    });

    test('is the row the suggestion picks, and the suggestion is labelled as one', () => {
        const summary = summariseRotation(run(armed(), ticks));

        expect(summary.suggestion.kind).toBe('swap');
        expect(summary.suggestion.text).toMatch(/^Suggestion:/);
        expect(summary.suggestion.text).toContain('pricey');
    });

    test('sorts above the ability that is working', () => {
        const summary = summariseRotation(run(armed(), ticks));
        expect(summary.abilities[0].hrid).toBe(PRICEY);
    });
});

describe('an always-affordable ability', () => {
    test('cast off cooldown is on cooldown for the whole fight', () => {
        const ticks = Array.from({ length: 21 }, () => ({ mana: 100, action: CHEAP, cast: true }));
        const cheap = rowFor(summariseRotation(run(armed(), ticks)), CHEAP);

        expect(cheap.casts).toBe(20);
        // Ready only for the half-second before the first cast landed; every
        // tick after that is inside the previous cast's two seconds
        expect(cheap.uptime).toBeCloseTo(0.95, 5);
        expect(cheap.readySeconds).toBeCloseTo(0.5, 5);
        // Ready and affordable throughout: nothing starved, which is a measured
        // zero rather than the null of never having been ready
        expect(cheap.starvedShare).toBe(0);
        expect(cheap.verdict.kind).toBe('fine');
    });

    test('with mana to spare and no casts is a priority question, not a mana one', () => {
        const ticks = Array.from({ length: 21 }, () => ({ mana: 100, action: CHEAP, cast: false }));
        const summary = summariseRotation(run(armed([CHEAP, SLOW]), ticks));
        const slow = rowFor(summary, SLOW);

        expect(slow.casts).toBe(0);
        expect(slow.starvedShare).toBe(0);
        expect(slow.verdict.kind).toBe('idle');
        expect(slow.verdict.text).toContain('mana to spare');
    });
});

describe('uptime is cooldown coverage', () => {
    test('one cast of a two-second ability over ten seconds is a fifth', () => {
        // Cast on the very first tick, then nothing for the rest of the run
        const ticks = Array.from({ length: 21 }, (_, index) => ({
            mana: 100,
            action: CHEAP,
            cast: index === 1,
        }));
        const cheap = rowFor(summariseRotation(run(armed(), ticks)), CHEAP);

        expect(cheap.casts).toBe(1);
        expect(cheap.uptime).toBeCloseTo(0.2, 5);
        expect(cheap.readySeconds).toBeCloseTo(8, 5);
    });

    test('an ability the game states no cooldown for has no uptime rather than a zero', () => {
        const state = newRotationState();
        noteRotationKit(state, ['/abilities/undocumented'], {});
        noteRotationFight(state);
        run(state, [{ mana: 100 }, { mana: 100 }]);

        const row = rowFor(summariseRotation(state), '/abilities/undocumented');
        expect(row.uptime).toBeNull();
        expect(row.cooldownSeconds).toBeNull();
    });
});

describe('mana, measured and looked up', () => {
    test('spend and regen come off the bar moving, not off the costs', () => {
        const summary = summariseRotation(
            run(armed(), [{ mana: 100 }, { mana: 90 }, { mana: 130 }, { mana: 120 }], { step: 1000 })
        );

        expect(summary.manaSpent).toBe(20);
        expect(summary.manaRestored).toBe(40);
        // Three measured seconds: the first tick has nothing before it
        expect(summary.seconds).toBeCloseTo(3, 5);
        expect(summary.manaPerMinute).toBeCloseTo(400, 5);
        expect(summary.regenPerMinute).toBeCloseTo(800, 5);
        expect(summary.manaBalance).toBeCloseTo(400, 5);
    });

    test('per-ability mana is the stated cost times casts, and per-mana value follows', () => {
        const ticks = Array.from({ length: 11 }, (_, index) => ({
            mana: 100,
            action: CHEAP,
            cast: index > 0,
            events: index > 0 ? [{ action: CHEAP, amount: 100 }] : [],
        }));
        const cheap = rowFor(summariseRotation(run(armed(), ticks)), CHEAP);

        expect(cheap.casts).toBe(10);
        expect(cheap.manaSpent).toBe(100);
        expect(cheap.damage).toBe(1000);
        expect(cheap.outputPerCast).toBe(100);
        expect(cheap.damagePerMana).toBe(10);
        // Ten casts of a two-second cooldown is twenty seconds of cooldown bought
        expect(cheap.damagePerCooldownSecond).toBeCloseTo(50, 5);
    });

    test('seconds under the cheapest cast are counted per fight', () => {
        const state = armed();
        // Under ten mana is under everything on the bar
        run(
            state,
            Array.from({ length: 5 }, () => ({ mana: 4 })),
            { step: 1000 }
        );

        const summary = summariseRotation(state);
        expect(summary.starvedSeconds).toBeCloseTo(4, 5);
        expect(summary.starvedShare).toBe(1);
        expect(summary.suggestion.kind).toBe('swap');
    });

    test('a gap longer than a tick is between fights and buys no time', () => {
        const state = armed();
        foldRotationTick(state, { at: START, player: { cMP: 5, mMP: 100, atkCounter: 0 }, detailMap: DETAILS });
        foldRotationTick(state, {
            at: START + MAX_TICK_GAP_MS * 10,
            player: { cMP: 5, mMP: 100, atkCounter: 0 },
            detailMap: DETAILS,
        });

        expect(summariseRotation(state).seconds).toBe(0);
    });
});

describe('what it refuses to say', () => {
    test('too little fighting is measuring, not a verdict', () => {
        const summary = summariseRotation(run(armed(), [{ mana: 100 }, { mana: 100 }]));

        expect(summary.measurable).toBe(false);
        expect(summary.abilities[0].verdict.kind).toBe('measuring');
        expect(bestChange(summary)).toBeNull();
    });

    test('no fights recorded is no per-fight figure', () => {
        const summary = summariseRotation(newRotationState());

        expect(summary.manaPerMinute).toBeNull();
        expect(summary.regenPerMinute).toBeNull();
        expect(summary.starvedShare).toBeNull();
        expect(summary.suggestion).toBeNull();
    });

    test('a verdict on a row with no cooldown says the game did not state one', () => {
        const verdict = abilityVerdict({ uptime: null, starvedShare: null }, 60);
        expect(verdict.kind).toBe('unknown');
        expect(verdict.text).toContain('no cooldown');
    });

    test('an ability that fires but is pinched is not the same as one that never fires', () => {
        const verdict = abilityVerdict({ uptime: 0.6, starvedShare: 0.7 }, 60);
        expect(verdict.kind).toBe('pinched');
        expect(verdict.text).toContain('more regen would buy casts here');
    });
});

describe('the suggestion', () => {
    test('names regen when the bar is going down faster than it comes back', () => {
        const suggestion = bestChange({
            seconds: 60,
            manaPerMinute: 900,
            regenPerMinute: 400,
            starvedSeconds: 3.5,
            abilities: [],
        });

        expect(suggestion.kind).toBe('regen');
        expect(suggestion.text).toContain('500 more mana a minute');
        expect(suggestion.text).toContain('3.5s per fight');
    });

    test('says mana is not the constraint when nothing was ever under its cost', () => {
        const suggestion = bestChange({
            seconds: 60,
            manaPerMinute: 100,
            regenPerMinute: 400,
            starvedSeconds: 0,
            abilities: [{ verdict: { kind: 'idle' } }],
        });

        expect(suggestion.kind).toBe('priority');
        expect(suggestion.text).toContain('mana is not the constraint');
    });
});
