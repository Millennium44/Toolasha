/**
 * Healing credited to whoever did it.
 *
 * The cases worth pinning are the two things that are nobody's healing — a
 * revive and the stream's own regeneration — and the order the caster rungs are
 * tried in, since each one is only right when the ones above it said nothing.
 */

import { describe, test, expect } from 'vitest';
import {
    OTHER_HEAL,
    SHARED_HEAL,
    foldHealingTick,
    newHealingState,
    resetHealingBaselines,
    seedHealingState,
} from './healing-done.js';

const HEAL = '/abilities/heal';
const BLOOM_PROC = '/abilities/entangle';

const DETAILS = {
    [HEAL]: { abilityEffects: [{ effectType: '/ability_effect_types/heal', targetType: 'lowestHpAlly' }] },
    [BLOOM_PROC]: { abilityEffects: [{ effectType: '/ability_effect_types/damage', targetType: 'enemy' }] },
};

const unit = (fields = {}) => ({ cHP: 1000, mHP: 2000, cMP: 500, mMP: 1000, atkCounter: 0, ...fields });

/** A party of two at a known baseline */
function party() {
    const state = newHealingState();
    foldHealingTick(state, { 0: unit(), 1: unit() }, {}, DETAILS);
    return state;
}

describe('what is nobody’s healing', () => {
    test('a revive is counted apart and credits nobody', () => {
        const state = newHealingState();
        foldHealingTick(state, { 0: unit({ cHP: 0 }) }, {}, DETAILS);
        foldHealingTick(state, { 0: unit({ cHP: 2000 }) }, {}, DETAILS);

        expect(state.revived).toBe(2000);
        expect(state.total).toBe(0);
        expect(state.players).toEqual({});
    });

    test('health and mana rising together is regeneration, and teaches its size', () => {
        const state = party();
        foldHealingTick(state, { 0: unit({ cHP: 1079, cMP: 520 }), 1: unit({ cHP: 1054, cMP: 520 }) }, {}, DETAILS);

        expect(state.regen).toBe(133);
        expect(state.total).toBe(0);
        expect(state.regenAmount).toEqual({ 0: 79, 1: 54 });
    });

    test('on a regeneration tick a player already at full mana regenerates too', () => {
        const state = party();
        foldHealingTick(state, { 0: unit({ cHP: 1079, cMP: 520 }), 1: unit({ cHP: 1054 }) }, {}, DETAILS);
        expect(state.regen).toBe(133);
        expect(state.regenAmount[1]).toBeUndefined();
    });

    test('a learned amount, or a smaller top-up to full, is regeneration on any tick', () => {
        const state = party();
        foldHealingTick(state, { 0: unit({ cHP: 1079, cMP: 520 }) }, {}, DETAILS);
        foldHealingTick(state, { 0: unit({ cHP: 1158, cMP: 520 }) }, {}, DETAILS);
        foldHealingTick(state, { 0: unit({ cHP: 1960, cMP: 520 }) }, {}, DETAILS);
        foldHealingTick(state, { 0: unit({ cHP: 2000, cMP: 520 }) }, {}, DETAILS);

        // 79 + 79 learned-size, then 802 of real healing, then a 40 top-up
        expect(state.regen).toBe(79 + 79 + 40);
        expect(state.total).toBe(802);
    });
});

describe('who gets the rest', () => {
    test('a lone heal cast owns the rise on an ally, filed under the heal', () => {
        const state = party();
        foldHealingTick(state, { 0: unit({ atkCounter: 1, cMP: 400 }), 1: unit({ cHP: 1300 }) }, { 0: HEAL }, DETAILS);

        expect(state.players[0]).toEqual({ healing: 300, byAbility: { [HEAL]: 300 } });
        expect(state.players[1]).toBeUndefined();
    });

    test('a heal beside a regeneration tick keeps its own part and no more', () => {
        const state = party();
        foldHealingTick(state, { 2: unit() }, {}, DETAILS);
        foldHealingTick(state, { 1: unit({ cHP: 1054, cMP: 520 }) }, {}, DETAILS);
        foldHealingTick(
            state,
            { 0: unit({ atkCounter: 1, cMP: 400 }), 1: unit({ cHP: 1108, cMP: 540 }), 2: unit({ cHP: 1300 }) },
            { 0: HEAL },
            DETAILS
        );

        expect(state.players[0].healing).toBe(300);
        expect(state.regen).toBe(108);
    });

    test('the lone player on a tick owns their own rise — a life-steal on the swing', () => {
        const state = newHealingState();
        foldHealingTick(state, { 0: unit() }, {}, DETAILS);
        foldHealingTick(state, { 0: unit({ cHP: 1017, atkCounter: 1 }) }, { 0: 'auto' }, DETAILS);
        foldHealingTick(state, { 0: unit({ cHP: 1030, atkCounter: 1 }) }, { 0: 'auto' }, DETAILS);

        expect(state.players[0].byAbility).toEqual({ auto: 17, [OTHER_HEAL]: 13 });
    });

    test('a lone ability cast owns rises that are not a heal’s, like an on-cast proc', () => {
        const state = party();
        foldHealingTick(
            state,
            { 0: unit({ atkCounter: 1 }), 1: unit({ cHP: 1120 }) },
            { 0: BLOOM_PROC, 1: 'auto' },
            DETAILS
        );
        expect(state.players[0].byAbility).toEqual({ [BLOOM_PROC]: 120 });
    });

    test('nothing to go on splits it among those present, and says how much was split', () => {
        const state = party();
        foldHealingTick(state, { 0: unit(), 1: unit({ cHP: 1100 }) }, {}, DETAILS);

        expect(state.players[0].byAbility).toEqual({ [SHARED_HEAL]: 50 });
        expect(state.players[1].byAbility).toEqual({ [SHARED_HEAL]: 50 });
        expect(state.shared).toBe(100);
        expect(state.total).toBe(100);
    });
});

describe('baselines', () => {
    test('new_battle states them, so the first rise of a battle counts', () => {
        const state = newHealingState();
        seedHealingState(state, { 0: { currentHitpoints: 900, currentManapoints: 300 } });
        foldHealingTick(state, { 0: unit({ cHP: 1000, cMP: 300 }) }, {}, DETAILS);
        expect(state.total).toBe(100);
    });

    test('a battle nothing announced starts from none, keeping what was learned', () => {
        const state = party();
        foldHealingTick(state, { 0: unit({ cHP: 1079, cMP: 520 }) }, {}, DETAILS);
        resetHealingBaselines(state);
        foldHealingTick(state, { 0: unit({ cHP: 5 }) }, {}, DETAILS);

        expect(state.total).toBe(0);
        expect(state.regenAmount[0]).toBe(79);
    });
});
