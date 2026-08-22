/**
 * Per-player support metrics, against the payload as it actually arrives.
 *
 * The shapes here are transcribed from recorded runs (`pMap` entries carry
 * `cHP mHP cMP mMP isActive leftCombat atkCounter isAutoAtk abilityHrid int
 * dmgCounter critCounter`, and nothing else) — which is also the evidence for
 * the metrics this file refuses to produce.
 */

import { describe, test, expect, vi } from 'vitest';

const game = vi.hoisted(() => ({ clientData: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
    },
}));

const { classifyAbility, foldSupportTick, newSupportState, splitRegenRises, summariseSupport, supportCoverage } =
    await import('./guild-trial-support.js');

/** The game's own ability data, in the shape `upgrade-advisor.js` already reads */
const detailMap = {
    '/abilities/rejuvenate': { abilityEffects: [{ effectType: '/ability_effect_types/heal' }] },
    '/abilities/frenzy': {
        abilityEffects: [{ effectType: '/ability_effect_types/buff', buffs: [{ typeHrid: '/x' }] }],
    },
    '/abilities/entangle': { abilityEffects: [{ effectType: '/ability_effect_types/damage' }] },
};

/**
 * A `pMap` entry.
 * @param {Object} fields - Overrides
 * @returns {Object} The entry
 */
function unit(fields) {
    return { cHP: 1000, mHP: 1000, cMP: 500, mMP: 500, atkCounter: 1, isActive: true, ...fields };
}

describe('classifyAbility', () => {
    test('reads what an ability does off the game’s own effects', () => {
        expect(classifyAbility('/abilities/rejuvenate', detailMap)).toEqual({ heals: true, buffs: false, known: true });
        expect(classifyAbility('/abilities/frenzy', detailMap)).toEqual({ heals: false, buffs: true, known: true });
        expect(classifyAbility('/abilities/entangle', detailMap)).toEqual({ heals: false, buffs: false, known: true });
    });

    test('an auto-attack and an idle tick are neither', () => {
        expect(classifyAbility('auto', detailMap).heals).toBe(false);
        expect(classifyAbility('idle', detailMap).heals).toBe(false);
        expect(classifyAbility('', detailMap).known).toBe(true);
    });

    test('without client data the names stand in, and say they are standing in', () => {
        const guessed = classifyAbility('/abilities/rejuvenate', {});
        expect(guessed).toEqual({ heals: true, buffs: false, known: false });
        expect(classifyAbility('/abilities/critical_aura', {}).buffs).toBe(true);
    });
});

describe('foldSupportTick', () => {
    test('health falling is damage taken and health rising is healing received', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cHP: 1000 }) }, {}, detailMap);
        foldSupportTick(state, { 0: unit({ cHP: 700 }) }, {}, detailMap);
        foldSupportTick(state, { 0: unit({ cHP: 900 }) }, {}, detailMap);

        expect(state.players[0].damageTaken).toBe(300);
        expect(state.players[0].healingReceived).toBe(200);
        // The dip is kept: how close the tank came to dying is the tank question
        expect(state.players[0].lowestHealthFraction).toBeCloseTo(0.7, 6);
    });

    test('a cast is the attack counter rising, labelled with what was prepared', () => {
        const state = newSupportState();
        const actions = { 0: '/abilities/frenzy' };
        foldSupportTick(state, { 0: unit({ atkCounter: 4 }) }, actions, detailMap);
        foldSupportTick(state, { 0: unit({ atkCounter: 5 }) }, actions, detailMap);
        foldSupportTick(state, { 0: unit({ atkCounter: 6 }) }, actions, detailMap);

        expect(state.players[0].casts).toBe(2);
        expect(state.players[0].buffCasts).toBe(2);
        expect(state.players[0].castsByAbility).toEqual({ '/abilities/frenzy': 2 });
    });

    test('a heal on a tick with one healer is credited to them', () => {
        const state = newSupportState();
        const before = { 0: unit({ cHP: 1000, atkCounter: 1 }), 1: unit({ cHP: 400, atkCounter: 1 }) };
        foldSupportTick(state, before, {}, detailMap);

        foldSupportTick(
            state,
            { 0: unit({ cHP: 1000, atkCounter: 2 }), 1: unit({ cHP: 700, atkCounter: 1 }) },
            { 0: '/abilities/rejuvenate' },
            detailMap
        );

        expect(state.players[0].healCasts).toBe(1);
        expect(state.players[0].healingDone).toBe(300);
        expect(state.players[1].healingReceived).toBe(300);
        expect(state.unattributedHealing).toBe(0);
    });

    test('two healers on one tick is not something the payload can separate', () => {
        const state = newSupportState();
        const start = {
            0: unit({ cHP: 1000, atkCounter: 1 }),
            1: unit({ cHP: 1000, atkCounter: 1 }),
            2: unit({ cHP: 400, atkCounter: 1 }),
        };
        foldSupportTick(state, start, {}, detailMap);
        foldSupportTick(
            state,
            {
                0: unit({ cHP: 1000, atkCounter: 2 }),
                1: unit({ cHP: 1000, atkCounter: 2 }),
                2: unit({ cHP: 700, atkCounter: 1 }),
            },
            { 0: '/abilities/rejuvenate', 1: '/abilities/rejuvenate' },
            detailMap
        );

        // Kept, and kept honest: a guild would rather see it unattributed than
        // assigned to whichever healer this file happened to look at first
        expect(state.unattributedHealing).toBe(300);
        expect(state.players[0].healingDone).toBe(0);
        expect(state.players[1].healingDone).toBe(0);
    });

    test('regeneration whose shape has not been learned yet stays unattributed, not invented healing', () => {
        // A lone riser before any wave has taught the fraction: nothing can
        // say whether it is regen or somebody's heal, so nobody is credited
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cHP: 900 }) }, {}, detailMap);
        foldSupportTick(state, { 0: unit({ cHP: 950 }) }, {}, detailMap);

        expect(state.players[0].healingReceived).toBe(50);
        expect(state.unattributedHealing).toBe(50);
    });

    test('mana spent and restored are both read', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cMP: 500 }) }, {}, detailMap);
        foldSupportTick(state, { 0: unit({ cMP: 380 }) }, {}, detailMap);
        foldSupportTick(state, { 0: unit({ cMP: 400 }) }, {}, detailMap);

        expect(state.players[0].manaSpent).toBe(120);
        expect(state.players[0].manaRestored).toBe(20);
    });

    test('the first sighting of a player is not a full bar of damage', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cHP: 300, mHP: 1000 }) }, {}, detailMap);
        expect(state.players[0].damageTaken).toBe(0);
        expect(state.players[0].healingReceived).toBe(0);
    });

    test('an empty tick changes nothing', () => {
        const state = newSupportState();
        foldSupportTick(state, {}, {}, detailMap);
        foldSupportTick(state, null, {}, detailMap);
        expect(summariseSupport(state).players).toEqual([]);
    });
});

describe('regeneration and on-cast procs', () => {
    // The live evidence this exists for: 333 seconds of a watched Trial
    // Chameleon showed "0 party hps" over "22.7K unattributed" with the party
    // near full health throughout — a bucket that read as attribution failing,
    // when most of it was the trial's own flat regeneration plus Blooming
    // Trident's Bloom ("on ability cast, 38% chance to heal lowest HP% ally"),
    // which no healing-ability stream will ever label.

    test('a uniform-fraction wave across different maxima is regeneration, and teaches the fraction', () => {
        const state = newSupportState();
        foldSupportTick(state, { 1: unit({ cHP: 1900, mHP: 2000 }), 2: unit({ cHP: 2800, mHP: 3000 }) }, {}, detailMap);
        // Both rise by 3% of their own maximum on one tick — no cast heal
        // scales per-recipient-max
        foldSupportTick(state, { 1: unit({ cHP: 1960, mHP: 2000 }), 2: unit({ cHP: 2890, mHP: 3000 }) }, {}, detailMap);

        expect(state.regenHealing).toBe(150);
        expect(state.unattributedHealing).toBe(0);
        expect(state.regenFraction).toBeCloseTo(0.03, 9);
        // Still counted as received by each unit — what changed is the label
        expect(state.players[1].healingReceived).toBe(60);
    });

    test('the learned fraction then classifies lone and clamped-to-full rises', () => {
        const state = newSupportState();
        foldSupportTick(state, { 1: unit({ cHP: 1900, mHP: 2000 }), 2: unit({ cHP: 2800, mHP: 3000 }) }, {}, detailMap);
        foldSupportTick(state, { 1: unit({ cHP: 1960, mHP: 2000 }), 2: unit({ cHP: 2890, mHP: 3000 }) }, {}, detailMap);

        // A lone riser of exactly one regen tick
        foldSupportTick(state, { 2: unit({ cHP: 2980, mHP: 3000 }) }, {}, detailMap);
        expect(state.regenHealing).toBe(240);

        // A smaller rise that tops its unit to full — less than one regen tick
        // was missing
        foldSupportTick(state, { 2: unit({ cHP: 3000, mHP: 3000 }) }, {}, detailMap);
        expect(state.regenHealing).toBe(260);
        expect(state.unattributedHealing).toBe(0);
    });

    test('units sharing one maximum cannot teach the fraction — a flat party heal looks the same', () => {
        const state = newSupportState();
        foldSupportTick(state, { 1: unit({ cHP: 2800, mHP: 3000 }), 2: unit({ cHP: 2700, mHP: 3000 }) }, {}, detailMap);
        foldSupportTick(state, { 1: unit({ cHP: 2890, mHP: 3000 }), 2: unit({ cHP: 2790, mHP: 3000 }) }, {}, detailMap);

        expect(state.regenFraction).toBeNull();
        expect(state.regenHealing).toBe(0);
        expect(state.unattributedHealing).toBe(180);
    });

    test('a big burst heal cannot teach itself in as regeneration', () => {
        const state = newSupportState();
        const { regen, rest } = splitRegenRises(state, [
            { index: '1', amount: 400, health: 1900, max: 2000 },
            { index: '2', amount: 600, health: 2500, max: 3000 },
        ]);

        expect(regen).toEqual([]);
        expect(rest).toHaveLength(2);
        expect(state.regenFraction).toBeNull();
    });

    test('a lone ability cast owns the rises its tick carries — the Bloom proc case', () => {
        // The tick is grouped by actor, so the lone cast beside the rise is
        // what caused it: a heal, a leech, or an on-cast proc
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ atkCounter: 1 }), 2: unit({ cHP: 2600, mHP: 3000 }) }, {}, detailMap);
        foldSupportTick(
            state,
            { 0: unit({ atkCounter: 2 }), 2: unit({ cHP: 2737, mHP: 3000 }) },
            { 0: '/abilities/entangle' },
            detailMap
        );

        expect(state.players[0].healingDone).toBe(137);
        expect(state.unattributedHealing).toBe(0);
    });

    test('an auto-attack claims nothing — procs fire on ability casts', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ atkCounter: 1 }), 2: unit({ cHP: 2600, mHP: 3000 }) }, {}, detailMap);
        foldSupportTick(
            state,
            { 0: unit({ atkCounter: 2 }), 2: unit({ cHP: 2737, mHP: 3000 }) },
            { 0: 'auto' },
            detailMap
        );

        expect(state.players[0].healingDone).toBe(0);
        expect(state.unattributedHealing).toBe(137);
    });

    test('a lone caster is not handed the regeneration that shares their tick', () => {
        const state = newSupportState();
        foldSupportTick(
            state,
            { 0: unit({ atkCounter: 1 }), 1: unit({ cHP: 1900, mHP: 2000 }), 2: unit({ cHP: 2800, mHP: 3000 }) },
            {},
            detailMap
        );
        foldSupportTick(
            state,
            { 0: unit({ atkCounter: 1 }), 1: unit({ cHP: 1960, mHP: 2000 }), 2: unit({ cHP: 2890, mHP: 3000 }) },
            {},
            detailMap
        );

        // One regen tick lands beside a lone cast: the cast gets nothing, and
        // the regen stays the game's
        foldSupportTick(
            state,
            { 0: unit({ atkCounter: 2 }), 2: unit({ cHP: 2980, mHP: 3000 }) },
            { 0: '/abilities/entangle' },
            detailMap
        );

        expect(state.players[0].casts).toBe(1);
        expect(state.regenHealing).toBe(240);
        expect(state.players[0].healingDone).toBe(0);
    });

    test('the summary carries regeneration apart from unattributed', () => {
        const state = newSupportState();
        state.regenHealing = 150;
        state.unattributedHealing = 40;
        state.regenFraction = 0.03;

        const summary = summariseSupport(state);
        expect(summary.regenHealing).toBe(150);
        expect(summary.unattributedHealing).toBe(40);
        expect(summary.regenFraction).toBeCloseTo(0.03, 9);
    });
});

describe('running out of mana', () => {
    test('a dry spell is counted once, however many ticks it lasts', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cMP: 100 }) }, {}, detailMap, 0);
        foldSupportTick(state, { 0: unit({ cMP: 0 }) }, {}, detailMap, 1000);
        foldSupportTick(state, { 0: unit({ cMP: 0 }) }, {}, detailMap, 2000);
        foldSupportTick(state, { 0: unit({ cMP: 0 }) }, {}, detailMap, 3000);
        foldSupportTick(state, { 0: unit({ cMP: 50 }) }, {}, detailMap, 4000);

        expect(state.players[0].manaOuts).toBe(1);
        // Empty from 1s to 4s
        expect(state.players[0].emptyManaMs).toBe(3000);
    });

    test('recovering and running dry again is two', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cMP: 100 }) }, {}, detailMap, 0);
        foldSupportTick(state, { 0: unit({ cMP: 0 }) }, {}, detailMap, 1000);
        foldSupportTick(state, { 0: unit({ cMP: 80 }) }, {}, detailMap, 2000);
        foldSupportTick(state, { 0: unit({ cMP: 0 }) }, {}, detailMap, 3000);

        expect(state.players[0].manaOuts).toBe(2);
    });

    test('a caster who never empties has nothing to report', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cMP: 500 }) }, {}, detailMap, 0);
        foldSupportTick(state, { 0: unit({ cMP: 40 }) }, {}, detailMap, 1000);

        expect(state.players[0].manaOuts).toBe(0);
        expect(state.players[0].emptyManaMs).toBe(0);
    });

    test('the totals carry it, and so does the coverage note', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cMP: 10 }), 1: unit({ cMP: 10 }) }, {}, detailMap, 0);
        foldSupportTick(state, { 0: unit({ cMP: 0 }), 1: unit({ cMP: 0 }) }, {}, detailMap, 1000);

        expect(summariseSupport(state).totals.manaOuts).toBe(2);
        expect(supportCoverage().manaOuts).toMatch(/^measured/);
    });
});

describe('low mana and a stalled rotation', () => {
    const costed = {
        ...detailMap,
        '/abilities/entangle': { abilityEffects: [{ effectType: '/ability_effect_types/damage' }], manaCost: 120 },
        '/abilities/rejuvenate': { abilityEffects: [{ effectType: '/ability_effect_types/heal' }], manaCost: 200 },
        '/abilities/fierce_aura': {
            abilityEffects: [{ effectType: '/ability_effect_types/buff', buffs: [{ typeHrid: '/x' }] }],
            manaCost: 1000,
        },
    };

    test('low is under a fifth of the bar, counted per spell with its time', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cMP: 500, mMP: 500 }) }, {}, costed, 0);
        foldSupportTick(state, { 0: unit({ cMP: 90, mMP: 500 }) }, {}, costed, 1000);
        foldSupportTick(state, { 0: unit({ cMP: 80, mMP: 500 }) }, {}, costed, 2000);
        foldSupportTick(state, { 0: unit({ cMP: 300, mMP: 500 }) }, {}, costed, 3000);
        foldSupportTick(state, { 0: unit({ cMP: 50, mMP: 500 }) }, {}, costed, 4000);
        const row = state.players[0];
        expect(row.lowManaOuts).toBe(2);
        expect(row.lowManaMs).toBe(2000);
        expect(row.lowMana).toBe(true);
        // Never empty, so no dry spell
        expect(row.manaOuts).toBe(0);
    });

    test('starved is under the cheapest non-aura ability seen cast', () => {
        const state = newSupportState();
        // Casts: an aura (ignored for the floor), entangle (120), rejuvenate (200) → floor 120
        foldSupportTick(state, { 0: unit({ cMP: 500, atkCounter: 1 }) }, { 0: '/abilities/fierce_aura' }, costed, 0);
        foldSupportTick(state, { 0: unit({ cMP: 500, atkCounter: 2 }) }, { 0: '/abilities/fierce_aura' }, costed, 500);
        foldSupportTick(state, { 0: unit({ cMP: 480, atkCounter: 3 }) }, { 0: '/abilities/rejuvenate' }, costed, 1000);
        foldSupportTick(state, { 0: unit({ cMP: 460, atkCounter: 4 }) }, { 0: '/abilities/entangle' }, costed, 1500);
        expect(state.players[0].castFloor).toBe(120);

        // 119 is under the floor: starved, though not low (500 max → low is <100) and not empty
        foldSupportTick(state, { 0: unit({ cMP: 119, atkCounter: 4 }) }, {}, costed, 2000);
        expect(state.players[0].starved).toBe(true);
        expect(state.players[0].starvedOuts).toBe(1);
        expect(state.players[0].lowMana).toBe(false);
        foldSupportTick(state, { 0: unit({ cMP: 300, atkCounter: 4 }) }, {}, costed, 2500);
        expect(state.players[0].starved).toBe(false);
        expect(state.players[0].starvedMs).toBe(500);
    });

    test('no cast seen means no starvation line, however low the bar', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cMP: 500 }) }, {}, costed, 0);
        foldSupportTick(state, { 0: unit({ cMP: 5 }) }, {}, costed, 1000);
        expect(state.players[0].castFloor).toBeNull();
        expect(state.players[0].starvedOuts).toBe(0);
        expect(state.players[0].lowManaOuts).toBe(1);
    });

    test('the totals and the coverage carry both', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cMP: 500 }) }, {}, costed, 0);
        foldSupportTick(state, { 0: unit({ cMP: 5 }) }, {}, costed, 1000);
        const summary = summariseSupport(state);
        expect(summary.totals.lowManaOuts).toBe(1);
        expect(summary.totals.starvedOuts).toBe(0);
        expect(supportCoverage().starvedOuts).toMatch(/cheapest/);
        expect(supportCoverage().lowManaOuts).toMatch(/fifth/);
    });
});

describe('summariseSupport', () => {
    test('rows carry names and the totals add up', () => {
        const state = newSupportState();
        const start = { 0: unit({ cHP: 1000 }), 1: unit({ cHP: 1000 }) };
        foldSupportTick(state, start, {}, detailMap);
        foldSupportTick(state, { 0: unit({ cHP: 600 }), 1: unit({ cHP: 900 }) }, {}, detailMap);

        const summary = summariseSupport(state, { 0: 'Tib', 1: 'Moo' });

        // Most damage taken first: the tank is the row a guild looks for
        expect(summary.players.map((row) => row.name)).toEqual(['Tib', 'Moo']);
        expect(summary.totals.damageTaken).toBe(500);
    });

    test('a fallback classification is flagged so a caption can say so', () => {
        const state = newSupportState();
        game.clientData = {};
        foldSupportTick(state, { 0: unit({ atkCounter: 1 }) }, { 0: '/abilities/rejuvenate' });
        foldSupportTick(state, { 0: unit({ atkCounter: 2 }) }, { 0: '/abilities/rejuvenate' });

        expect(summariseSupport(state).abilityKindsKnown).toBe(false);
    });
});

describe('what it will not measure', () => {
    test('every refused metric says why, in the export itself', () => {
        const coverage = supportCoverage();

        expect(coverage.damageMitigated).toMatch(/not carried/);
        expect(coverage.threat).toMatch(/rating only/);
        expect(coverage.amountBuffed).toMatch(/not on the wire/);
        // And the ones that are real say they are measured
        expect(coverage.damageTaken).toMatch(/^measured/);
        expect(coverage.healingReceived).toMatch(/^measured/);
    });
});

describe('a revive is not a heal', () => {
    test('zero to positive counts as a revive and never as healing', () => {
        const state = newSupportState();
        // Down, then back
        foldSupportTick(state, { 0: unit({ cHP: 400 }), 1: unit({ atkCounter: 1 }) }, {}, detailMap);
        foldSupportTick(state, { 0: unit({ cHP: 0 }), 1: unit({ atkCounter: 1 }) }, {}, detailMap);
        foldSupportTick(
            state,
            { 0: unit({ cHP: 1000 }), 1: unit({ atkCounter: 2, abilityHrid: '/abilities/rejuvenate' }) },
            { 1: '/abilities/rejuvenate' },
            detailMap
        );

        expect(state.players['0'].revives).toBe(1);
        expect(state.players['0'].healingReceived).toBe(0);
        expect(state.revivedHealth).toBe(1000);
        // …and nothing lands on the healer who happened to be casting
        expect(state.players['1'].healingDone).toBe(0);
        expect(state.unattributedHealing).toBe(0);
    });

    test('an ordinary heal off a non-zero floor is still a heal', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cHP: 1 }), 1: unit({ atkCounter: 1 }) }, {}, detailMap);
        foldSupportTick(
            state,
            { 0: unit({ cHP: 900 }), 1: unit({ atkCounter: 2 }) },
            { 1: '/abilities/rejuvenate' },
            detailMap
        );

        expect(state.players['0'].revives).toBe(0);
        expect(state.players['0'].healingReceived).toBe(899);
        expect(state.players['1'].healingDone).toBe(899);
    });

    test('the summary carries the count and the health apart from healing', () => {
        const state = newSupportState();
        foldSupportTick(state, { 0: unit({ cHP: 0 }) }, {}, detailMap);
        foldSupportTick(state, { 0: unit({ cHP: 1000 }) }, {}, detailMap);

        const summary = summariseSupport(state, { 0: 'Bob' });
        expect(summary.totals.revives).toBe(1);
        expect(summary.totals.healingReceived).toBe(0);
        expect(summary.revivedHealth).toBe(1000);
    });
});
