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

const { classifyAbility, foldSupportTick, newSupportState, summariseSupport, supportCoverage } =
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

    test('regeneration with nobody casting is unattributed, not invented healing', () => {
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
