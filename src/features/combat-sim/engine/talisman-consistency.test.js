/**
 * Consistency (2026-11-20 test patch): "Auto attacks roll at least {{value}} of their maximum damage." Measured live
 * (G5 = 0.09, ~170 non-crit autos with and without): it rescales the roll to uniform from value x max up to max, not
 * a clamp (no spike at the floor); crits are unaffected; abilities are assumed unaffected. A parry counter is an auto.
 */
import { describe, test, expect, afterEach, vi } from 'vitest';

const rng = vi.hoisted(() => ({ fixed: null }));
vi.mock('./rng.js', async (importOriginal) => {
    const original = await importOriginal();
    return { ...original, random: () => (rng.fixed === null ? original.random() : rng.fixed) };
});

const { default: CombatUtilities } = await import('./combat-utilities.js');
const { clearSimRng, seedSimRng } = await import('./rng.js');
const { computeTalismanCombat } = await import('./talisman-combat.js');
const { BELT_ITEMS } = await import('../../../__fixtures__/talisman-bonuses.js');
const { FULL_MODIFIER_DETAILS } = await import('../../../__fixtures__/talisman-full-modifiers.js');
const { isMechanicLine } = await import('../talisman-line-ranking.js');
const { isSpecialModifierDetail } = await import('../../../utils/talisman-bonuses.js');

const MAX = 1000;

afterEach(() => {
    rng.fixed = null;
    clearSimRng();
});

function attacker({ consistency, critRate = 0, critDamage = 0.5 } = {}) {
    return {
        hrid: 'player1',
        isPlayer: true,
        talismanMechanics: consistency === undefined ? undefined : { consistency },
        overkillStore: 0,
        combatDetails: {
            currentHitpoints: 1e9,
            stabAccuracyRating: 1e9,
            stabMaxDamage: MAX,
            stabEvasionRating: 1,
            totalArmor: 0,
            defensiveMaxDamage: 0,
            combatStats: {
                combatStyleHrid: '/combat_styles/stab',
                damageType: '/damage_types/physical',
                physicalAmplify: 0,
                armorPenetration: 0,
                physicalThorns: 0,
                elementalThorns: 0,
                criticalRate: critRate,
                criticalDamage: critDamage,
                taskDamage: 0,
                damageTaken: 0,
                autoAttackDamage: 0,
                abilityDamage: 0,
                lifeSteal: 0,
                manaLeech: 0,
                retaliation: 0,
            },
        },
        addHitpoints: () => 0,
        addManapoints: () => 0,
    };
}

function victim() {
    return {
        hrid: '/monsters/dummy',
        isPlayer: false,
        isBoss: false,
        combatDetails: {
            currentHitpoints: 1e9,
            stabEvasionRating: 1,
            totalArmor: 0,
            defensiveMaxDamage: 0,
            combatStats: { physicalThorns: 0, elementalThorns: 0, retaliation: 0, damageTaken: 0, armorPenetration: 0 },
        },
    };
}

const ABILITY = {
    combatStyleHrid: '/combat_styles/stab',
    damageType: '/damage_types/physical',
    bonusAccuracyRatio: 0,
    damageFlat: 0,
    damageRatio: 1,
    armorDamageRatio: 0,
    hpDrainRatio: 0,
};

const hit = (unit, effect = null) => CombatUtilities.processAttack(unit, victim(), effect).damageDone;

describe('Consistency in the damage roll', () => {
    test('floor at RNG 0, ceiling at RNG near 1, for a non-crit auto', () => {
        rng.fixed = 0;
        expect(hit(attacker({ consistency: 0.12 }))).toBe(0.12 * MAX);
        expect(hit(attacker())).toBe(1);
        rng.fixed = 0.999999;
        expect(hit(attacker({ consistency: 0.12 }))).toBe(MAX);
    });

    test('a parry counter is an auto (processAttack with no ability) and gets the floor', () => {
        rng.fixed = 0;
        const parrier = attacker({ consistency: 0.12 });
        expect(CombatUtilities.processAttack(parrier, victim(), null).damageDone).toBe(120);
    });

    test('crits are unchanged', () => {
        rng.fixed = 0;
        const crit = hit(attacker({ consistency: 0.12, critRate: 10 }));
        expect(crit).toBe(hit(attacker({ critRate: 10 })));
        expect(crit).toBe(MAX * 1.5);
    });

    test('ability damage is unchanged', () => {
        rng.fixed = 0;
        expect(hit(attacker({ consistency: 0.12 }), ABILITY)).toBe(hit(attacker(), ABILITY));
    });

    test('a unit with no consistency draws the same stream as before (one draw, same result)', () => {
        seedSimRng(7);
        const a = [];
        for (let i = 0; i < 50; i++) a.push(hit(attacker()));
        seedSimRng(7);
        const b = [];
        for (let i = 0; i < 50; i++) b.push(hit(attacker({ consistency: 0 })));
        expect(b).toEqual(a);
    });

    test('over many seeded rolls the mean rises by about consistency / 2 of the max, and no roll is below the floor', () => {
        const N = 20000;
        const c = 0.12;
        seedSimRng(11);
        let base = 0;
        for (let i = 0; i < N; i++) base += hit(attacker());
        seedSimRng(11);
        let sum = 0;
        let lowest = Infinity;
        for (let i = 0; i < N; i++) {
            const d = hit(attacker({ consistency: c }));
            sum += d;
            lowest = Math.min(lowest, d);
        }
        expect(lowest).toBeGreaterThanOrEqual(c * MAX);
        const rise = (sum - base) / N / MAX;
        expect(rise).toBeGreaterThan(c / 2 - 0.01);
        expect(rise).toBeLessThan(c / 2 + 0.01);
    });
});

describe('Consistency as a talisman line', () => {
    const detail = {
        hrid: '/talisman_modifiers/consistency',
        name: 'Consistency',
        talismanTypeHrid: '/talisman_types/combat',
        targetHrid: '/talisman_modifier_targets/combat_stat',
        groupHrid: '/talisman_modifier_groups/special',
        keys: ['Consistency'],
        isPercent: true,
        weight: 0.1,
        gradeValues: [0.03, 0.045, 0.06, 0.075, 0.09, 0.12],
    };
    const gameData = {
        talismansEnabled: true,
        talismanModifierDetailMap: { ...FULL_MODIFIER_DETAILS, [detail.hrid]: detail },
        itemDetailMap: BELT_ITEMS,
        enhancementLevelTotalBonusMultiplierTable: [],
    };
    const MEDIUM = { hrid: '/items/medium_talisman_belt', enhancementLevel: 0 };
    const line = (key, grade) => ({ hrid: `/talisman_modifiers/${key}`, grade });
    const talisman = (slotIndex, ...modifiers) => ({ id: slotIndex, modifiers, slotIndex });
    const run = (talismans) =>
        computeTalismanCombat({ talismans, belt: MEDIUM, gameData, modeledStats: new Set(['criticalDamage']) });

    test('it lands in mechanics (power 0.15 scales it), is a Special and a mechanic line', () => {
        const out = run([talisman(1, line('consistency', 6))]);
        expect(out.mechanics.consistency).toBeCloseTo(0.12 * 1.15, 10);
        expect(out.unmodeled).toEqual({});
        expect(isSpecialModifierDetail(detail)).toBe(true);
        expect(isMechanicLine(detail)).toBe(true);
    });

    test('beside another Special on the same talisman both count', () => {
        const out = run([talisman(1, line('consistency', 5), line('fortify', 2))]);
        expect(out.mechanics.consistency).toBeCloseTo(0.09 * 1.15, 10);
        expect(out.mechanics.fortify).toBeCloseTo(0.01725, 10);
    });

    test('a second copy adds nothing; the highest grade counts', () => {
        const one = run([talisman(1, line('consistency', 5))]);
        const two = run([talisman(1, line('consistency', 5)), talisman(2, line('consistency', 5))]);
        const mixed = run([talisman(1, line('consistency', 2)), talisman(2, line('consistency', 5))]);
        expect(two.mechanics.consistency).toBeCloseTo(one.mechanics.consistency, 12);
        expect(mixed.mechanics.consistency).toBeCloseTo(0.09 * 1.15, 12);
    });
});
