/**
 * Healing credited to whoever did it.
 *
 * The cases worth pinning are what is nobody's healing — a revive, the stream's
 * regeneration, and any rise no heal, life-steal or Bloom accounts for, which
 * lands on the team's uncredited line — and the three things that do earn a
 * player healing, each only on the bar it can reach.
 */

import { describe, test, expect } from 'vitest';
import {
    BLOOM_HEAL_PREFIX,
    LIFESTEAL_HEAL,
    foldHealingTick,
    healingUnitStats,
    newHealingState,
    resetHealingBaselines,
    seedHealingState,
} from './healing-done.js';

const HEAL = '/abilities/heal';
const SELF_HEAL = '/abilities/self_mend';
const ENTANGLE = '/abilities/entangle';
const LIFE_DRAIN = '/abilities/life_drain';

const DETAILS = {
    [HEAL]: { abilityEffects: [{ effectType: '/ability_effect_types/heal', targetType: 'lowestHpAlly' }] },
    [SELF_HEAL]: { abilityEffects: [{ effectType: '/ability_effect_types/heal', targetType: 'self' }] },
    [ENTANGLE]: { abilityEffects: [{ effectType: '/ability_effect_types/damage', targetType: 'enemy' }] },
    [LIFE_DRAIN]: {
        abilityEffects: [{ effectType: '/ability_effect_types/damage', targetType: 'enemy', hpDrainRatio: 0.2 }],
    },
};

const unit = (fields = {}) => ({ cHP: 1000, mHP: 2000, cMP: 500, mMP: 1000, atkCounter: 0, ...fields });

/** A landed hit, as `attributeTick` states one */
const hit = (playerIndex, amount, extra = {}) => ({
    playerIndex,
    monsterIndex: '0',
    amount,
    isMiss: false,
    isHeal: false,
    isDot: false,
    ...extra,
});

/** A party of two at a known baseline */
function party() {
    const state = newHealingState();
    foldHealingTick(state, { 0: unit(), 1: unit() }, {}, DETAILS);
    return state;
}

/** Every non-revive rise is credited, uncredited or regeneration — never dropped, never twice */
const accounted = (state) => state.total + state.uncredited + state.regen;

describe('what is nobody’s healing', () => {
    test('a revive is counted apart and credits nobody', () => {
        const state = newHealingState();
        foldHealingTick(state, { 0: unit({ cHP: 0 }) }, {}, DETAILS);
        foldHealingTick(state, { 0: unit({ cHP: 2000 }) }, {}, DETAILS);

        expect(state.revived).toBe(2000);
        expect(state.total).toBe(0);
        expect(state.uncredited).toBe(0);
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

    test('a learned amount, or a smaller top-up to full, is regeneration; anything else with no cause is uncredited', () => {
        const state = party();
        foldHealingTick(state, { 0: unit({ cHP: 1079, cMP: 520 }) }, {}, DETAILS);
        foldHealingTick(state, { 0: unit({ cHP: 1158, cMP: 520 }) }, {}, DETAILS);
        foldHealingTick(state, { 0: unit({ cHP: 1960, cMP: 520 }) }, {}, DETAILS);
        foldHealingTick(state, { 0: unit({ cHP: 2000, cMP: 520 }) }, {}, DETAILS);

        // 79 + 79 learned-size, then 802 nobody caused, then a 40 top-up
        expect(state.regen).toBe(79 + 79 + 40);
        expect(state.uncredited).toBe(802);
        expect(state.total).toBe(0);
        expect(state.players).toEqual({});
    });

    test('a full-mana player’s regeneration, alone on its tick, is uncredited and not theirs', () => {
        // Their mana never rises, so nothing teaches their regeneration — and being
        // the only player on the tick is no longer a reason to credit them
        const state = party();
        foldHealingTick(state, { 1: unit({ cHP: 1042 }) }, {}, DETAILS);
        foldHealingTick(state, { 1: unit({ cHP: 1084 }) }, {}, DETAILS);

        expect(state.players).toEqual({});
        expect(state.uncredited).toBe(84);
        expect(accounted(state)).toBe(84);
    });

    test('a cast that is not a heal earns no healing, whoever rose beside it', () => {
        const state = party();
        foldHealingTick(state, { 0: unit({ atkCounter: 1 }), 1: unit({ cHP: 1120 }) }, { 0: ENTANGLE }, DETAILS);

        expect(state.players).toEqual({});
        expect(state.uncredited).toBe(120);
    });

    test('nothing to go on is one uncredited figure, never split among those present', () => {
        const state = party();
        foldHealingTick(state, { 0: unit(), 1: unit({ cHP: 1100 }) }, {}, DETAILS);

        expect(state.players).toEqual({});
        expect(state.uncredited).toBe(100);
        expect(state.shared).toBe(0);
    });
});

describe('a healing ability cast', () => {
    test('a lone heal cast owns the rise on an ally, filed under the heal', () => {
        const state = party();
        foldHealingTick(state, { 0: unit({ atkCounter: 1, cMP: 400 }), 1: unit({ cHP: 1300 }) }, { 0: HEAL }, DETAILS);

        expect(state.players[0]).toEqual({ healing: 300, byAbility: { [HEAL]: 300 } });
        expect(state.players[1]).toBeUndefined();
        expect(state.total).toBe(300);
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

    test('a heal that only targets its caster owns only the caster’s rise', () => {
        const state = party();
        foldHealingTick(
            state,
            { 0: unit({ atkCounter: 1, cHP: 1200 }), 1: unit({ cHP: 1100 }) },
            { 0: SELF_HEAL },
            DETAILS
        );

        expect(state.players[0].byAbility).toEqual({ [SELF_HEAL]: 200 });
        expect(state.uncredited).toBe(100);
    });

    test('two heal casters on one tick share it, and the split is counted', () => {
        const state = newHealingState();
        foldHealingTick(state, { 0: unit(), 1: unit(), 2: unit() }, {}, DETAILS);
        foldHealingTick(
            state,
            { 0: unit({ atkCounter: 1 }), 1: unit({ atkCounter: 1 }), 2: unit({ cHP: 1400 }) },
            { 0: HEAL, 1: HEAL },
            DETAILS
        );

        expect(state.players[0].healing).toBe(200);
        expect(state.players[1].healing).toBe(200);
        expect(state.shared).toBe(400);
    });
});

describe('life-steal from a hit', () => {
    test('an auto-attack with Life Steal on the sheet heals its hitter, up to what the hit can return', () => {
        const state = newHealingState();
        foldHealingTick(state, { 0: unit() }, {}, DETAILS);
        foldHealingTick(state, { 0: unit({ atkCounter: 1, cHP: 1030 }) }, { 0: 'auto' }, DETAILS, {
            events: [hit('0', 200)],
            units: { 0: healingUnitStats({ lifeSteal: 0.1 }) },
        });

        // floor(0.1 × 200) + a point of rounding; the rest of the rise is not the hit's
        expect(state.players[0].byAbility).toEqual({ [LIFESTEAL_HEAL]: 21 });
        expect(state.uncredited).toBe(9);
    });

    test('a draining ability heals its caster, amplified, and a killing hit is not capped', () => {
        const state = newHealingState();
        foldHealingTick(state, { 0: unit() }, {}, DETAILS);
        const units = { 0: healingUnitStats({ healingAmplify: 0.5 }) };
        foldHealingTick(state, { 0: unit({ atkCounter: 1, cHP: 1060 }) }, { 0: LIFE_DRAIN }, DETAILS, {
            events: [hit('0', 200)],
            units,
        });
        // floor(0.2 × 200 × 1.5) + 1 = 61
        expect(state.players[0].byAbility).toEqual({ [LIFE_DRAIN]: 60 });

        // Overkill hides damage the drain was computed off, so a killing tick keeps the whole rise
        foldHealingTick(state, { 0: unit({ atkCounter: 2, cHP: 1560 }) }, { 0: LIFE_DRAIN }, DETAILS, {
            events: [hit('0', 50), { isKill: true, killerIndex: '0', monsterIndex: '0' }],
            units,
        });
        expect(state.players[0].byAbility[LIFE_DRAIN]).toBe(560);
        expect(state.uncredited).toBe(0);
    });

    test('a miss, or a sheet that states no Life Steal, earns nothing', () => {
        const state = newHealingState();
        foldHealingTick(state, { 0: unit() }, {}, DETAILS);
        foldHealingTick(state, { 0: unit({ atkCounter: 1, cHP: 1020 }) }, { 0: 'auto' }, DETAILS, {
            events: [hit('0', 0, { isMiss: true })],
            units: { 0: healingUnitStats({ lifeSteal: 0.1 }) },
        });
        foldHealingTick(state, { 0: unit({ atkCounter: 2, cHP: 1040 }) }, { 0: 'auto' }, DETAILS, {
            events: [hit('0', 300)],
            units: { 0: healingUnitStats({}) },
        });
        // And no sheet at all is not evidence of life-steal either
        foldHealingTick(state, { 0: unit({ atkCounter: 3, cHP: 1060 }) }, { 0: 'auto' }, DETAILS, {
            events: [hit('0', 300)],
        });

        expect(state.players).toEqual({});
        expect(state.uncredited).toBe(60);
    });
});

describe('Bloom', () => {
    /** Three players: 0 full, 1 at 30%, 2 at 75% */
    function three() {
        const state = newHealingState();
        foldHealingTick(state, { 0: unit({ cHP: 2000 }), 1: unit({ cHP: 600 }), 2: unit({ cHP: 1500 }) }, {}, DETAILS);
        return state;
    }

    const TRIDENT = { 0: healingUnitStats({ bloom: 0.38 }, 1000) };

    test('an ability cast by a bloom wearer credits the rise on the lowest ally as Bloom, not as the ability', () => {
        const state = three();
        foldHealingTick(
            state,
            { 0: unit({ cHP: 2000, atkCounter: 1 }), 1: unit({ cHP: 760 }), 2: unit({ cHP: 1600 }) },
            { 0: ENTANGLE },
            DETAILS,
            { units: TRIDENT }
        );

        expect(state.players[0].byAbility).toEqual({ [`${BLOOM_HEAL_PREFIX}${ENTANGLE}`]: 160 });
        // Player 2's rise is not Bloom's target, and so not Bloom's
        expect(state.uncredited).toBe(100);
        expect(accounted(state)).toBe(260);
    });

    test('a rise beyond the most a proc can heal is uncredited', () => {
        const state = three();
        foldHealingTick(
            state,
            { 0: unit({ cHP: 2000, atkCounter: 1 }), 1: unit({ cHP: 900 }) },
            { 0: ENTANGLE },
            DETAILS,
            {
                units: TRIDENT,
            }
        );

        // (0.15 × 1000 + 10) × 1 + a point
        expect(state.players[0].healing).toBe(161);
        expect(state.uncredited).toBe(139);
    });

    test('an auto-attack never procs it, and a wearer nobody stated gets nothing', () => {
        const state = three();
        foldHealingTick(
            state,
            { 0: unit({ cHP: 2000, atkCounter: 1 }), 1: unit({ cHP: 700 }) },
            { 0: 'auto' },
            DETAILS,
            {
                units: TRIDENT,
            }
        );
        foldHealingTick(
            state,
            { 0: unit({ cHP: 2000, atkCounter: 2 }), 1: unit({ cHP: 800 }) },
            { 0: ENTANGLE },
            DETAILS
        );

        expect(state.players).toEqual({});
        expect(state.uncredited).toBe(200);
    });

    test('equal health fractions go to the earlier slot, as the engine picks', () => {
        const state = newHealingState();
        foldHealingTick(state, { 0: unit({ cHP: 2000 }), 1: unit(), 2: unit() }, {}, DETAILS);
        foldHealingTick(
            state,
            { 0: unit({ cHP: 2000, atkCounter: 1 }), 1: unit({ cHP: 1050 }), 2: unit({ cHP: 1050 }) },
            { 0: ENTANGLE },
            DETAILS,
            { units: { 0: healingUnitStats({ bloom: 0.2 }) } }
        );

        expect(state.players[0].healing).toBe(50);
        expect(state.uncredited).toBe(50);
    });
});

describe('sheets', () => {
    test('a stated sheet omits zero stats; no sheet is unknown', () => {
        expect(healingUnitStats(null)).toBeNull();
        expect(healingUnitStats({ bloom: 0.38 }, 1200)).toEqual({
            bloom: 0.38,
            lifeSteal: 0,
            healingAmplify: 0,
            magicMaxDamage: 1200,
        });
        expect(healingUnitStats({}).magicMaxDamage).toBeNull();
    });
});

describe('baselines', () => {
    test('new_battle states them, so the first rise of a battle counts', () => {
        const state = newHealingState();
        seedHealingState(state, { 0: { currentHitpoints: 900, currentManapoints: 300, maxHitpoints: 2000 } });
        foldHealingTick(state, { 0: unit({ cHP: 1000, cMP: 300 }) }, {}, DETAILS);
        expect(state.uncredited).toBe(100);
        expect(state.lastMax[0]).toBe(2000);
    });

    test('a battle nothing announced starts from none, keeping what was learned', () => {
        const state = party();
        foldHealingTick(state, { 0: unit({ cHP: 1079, cMP: 520 }) }, {}, DETAILS);
        resetHealingBaselines(state);
        foldHealingTick(state, { 0: unit({ cHP: 5 }) }, {}, DETAILS);

        expect(state.total).toBe(0);
        expect(state.uncredited).toBe(0);
        expect(state.regenAmount[0]).toBe(79);
    });
});
