/**
 * The roster composition lint.
 *
 * The claim every rule here is built around: a gap is only ever asserted when
 * the whole roster's kits are known. A roster of four with two captures that
 * happens to contain no revive has not been shown to lack one, and a checklist
 * that says "no revive carrier" on that evidence is worse than no checklist —
 * the lead swaps somebody out to fix a problem that was never there. So the
 * three states are `ok`, `gap` and `unknown`, and the coverage line is what
 * tells a reader which of the three they are looking at.
 */

import { describe, test, expect } from 'vitest';

import {
    INVINCIBLE_HRID,
    REVIVE_HRID,
    TANK_TIER_STEPS,
    compositionStatusLine,
    lintComposition,
    parseRosterNames,
    resolveRosterKits,
    tanksNeededForTier,
} from './guild-trial-composition.js';

/** A synthetic ability map: no game data is imported by anything under test */
const abilityDetailMap = {
    [REVIVE_HRID]: { name: 'Revive', isSpecialAbility: true, abilityEffects: [] },
    [INVINCIBLE_HRID]: {
        name: 'Invincible',
        isSpecialAbility: true,
        // Buffs only its caster, so `isAuraAbility` says no — see party-lint
        abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'self', buffs: [{}] }],
    },
    '/abilities/fierce_aura': {
        name: 'Fierce Aura',
        isSpecialAbility: true,
        abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{}] }],
    },
    '/abilities/aqua_aura': {
        name: 'Aqua Aura',
        isSpecialAbility: true,
        abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{}] }],
    },
    '/abilities/taunt': {
        name: 'Taunt',
        abilityEffects: [{ effectType: '/ability_effect_types/buff', buffs: [{ typeHrid: '/buff_types/threat' }] }],
    },
    '/abilities/fireball': {
        name: 'Fireball',
        abilityEffects: [
            {
                effectType: '/ability_effect_types/damage',
                combatStyleHrid: '/combat_styles/magic',
                damageType: '/damage_types/fire',
            },
        ],
    },
};

/**
 * A kit source entry, keyed as `resolveRosterKits` reads it.
 * @param {Array<string>} hrids - Abilities carried
 * @param {Object} [stats] - A combat sheet
 * @returns {Object} A kit
 */
function kit(hrids, stats = null) {
    return { abilities: hrids.map((hrid) => ({ hrid, level: 100 })), stats };
}

/**
 * Resolve a named roster against a kit book.
 * @param {Array<string>} names - The roster
 * @param {Object} loadouts - name (lowercased) → kit
 * @returns {Array<Object>} Resolved members
 */
function resolve(names, loadouts) {
    return resolveRosterKits(names, { loadouts, abilityDetailMap });
}

describe('parseRosterNames', () => {
    test('takes newlines or commas, and either order of decoration', () => {
        expect(parseRosterNames('Alice\nBob, Carol')).toEqual(['Alice', 'Bob', 'Carol']);
        expect(parseRosterNames('1. Alice (tank)\n- Bob [heal]')).toEqual(['Alice', 'Bob']);
    });

    test('the same person twice is one person', () => {
        expect(parseRosterNames('Alice\nalice\nALICE')).toEqual(['Alice']);
    });

    test('nothing pasted is nobody, not a blank name', () => {
        expect(parseRosterNames('  \n , \n')).toEqual([]);
    });
});

describe('tanksNeededForTier', () => {
    test('steps up with the tier and never falls back down', () => {
        expect(tanksNeededForTier(1)).toBe(1);
        expect(tanksNeededForTier(5)).toBe(1);
        expect(tanksNeededForTier(6)).toBe(2);
        expect(tanksNeededForTier(12)).toBe(3);
        expect(tanksNeededForTier(21)).toBe(4);
    });

    test('a tier past the ladder is clamped to its top, not extrapolated', () => {
        expect(tanksNeededForTier(400)).toBe(TANK_TIER_STEPS[TANK_TIER_STEPS.length - 1].tanks);
    });

    test('no tier named is no number to want', () => {
        expect(tanksNeededForTier(null)).toBeNull();
        expect(tanksNeededForTier(0)).toBeNull();
    });
});

describe('resolveRosterKits', () => {
    test('a name nothing has ever captured is carried through as unknown', () => {
        const [alice, ghost] = resolve(['Alice', 'Ghost'], { alice: kit([REVIVE_HRID]) });
        expect(alice.known).toBe(true);
        expect(ghost).toMatchObject({ name: 'Ghost', known: false, abilities: [], classTag: null });
    });

    test('a sighting that read no sheet and no kit is not a known kit', () => {
        const [only] = resolve(['Alice'], { alice: { abilities: [], stats: {} } });
        expect(only.known).toBe(false);
    });

    test('a capture beats a stored loadout', () => {
        const [alice] = resolveRosterKits(['Alice'], {
            captures: { alice: kit([REVIVE_HRID]) },
            loadouts: { alice: kit(['/abilities/fireball']) },
            abilityDetailMap,
        });
        expect(alice.source).toBe('capture');
        expect(alice.abilities[0].hrid).toBe(REVIVE_HRID);
    });

    test('the class is inferred from the kit, so a taunt is a tank', () => {
        const [alice] = resolve(['Alice'], { alice: kit(['/abilities/taunt']) });
        expect(alice.classTag.key).toBe('tank');
    });
});

describe('lintComposition — the coverage rule', () => {
    test('a partial roster never claims a gap, only an unknown', () => {
        const members = resolve(['Alice', 'Ghost'], { alice: kit(['/abilities/fireball']) });
        const lint = lintComposition({ members, tier: 3, abilityDetailMap });

        expect(lint.coverage).toMatchObject({ known: 1, total: 2, complete: false, line: '1 of 2 kits known' });
        expect(lint.checks.find((check) => check.key === 'revive').status).toBe('unknown');
        expect(lint.gaps).toBe(0);
    });

    test('a fully known roster with nothing carrying revive is a gap', () => {
        const members = resolve(['Alice'], { alice: kit(['/abilities/fireball']) });
        const lint = lintComposition({ members, tier: 3, abilityDetailMap });

        const revive = lint.checks.find((check) => check.key === 'revive');
        expect(revive.status).toBe('gap');
        expect(lint.coverage.complete).toBe(true);
    });
});

describe('lintComposition — the rules', () => {
    test('a revive and an invincible on the roster pass, and name who has them', () => {
        const members = resolve(['Alice', 'Bob'], {
            alice: kit([REVIVE_HRID]),
            bob: kit([INVINCIBLE_HRID]),
        });
        const lint = lintComposition({ members, tier: 3, abilityDetailMap });

        expect(lint.checks.find((check) => check.key === 'revive')).toMatchObject({ status: 'ok', detail: 'Alice' });
        expect(lint.checks.find((check) => check.key === 'invincible')).toMatchObject({ status: 'ok', detail: 'Bob' });
    });

    test('the same aura on two members is flagged; two different auras are not', () => {
        const duplicated = lintComposition({
            members: resolve(['Alice', 'Bob'], {
                alice: kit(['/abilities/fierce_aura']),
                bob: kit(['/abilities/fierce_aura']),
            }),
            abilityDetailMap,
        });
        expect(duplicated.checks.find((check) => check.key === 'duplicateAuras')).toMatchObject({ status: 'gap' });

        const distinct = lintComposition({
            members: resolve(['Alice', 'Bob'], {
                alice: kit(['/abilities/fierce_aura']),
                bob: kit(['/abilities/aqua_aura']),
            }),
            abilityDetailMap,
        });
        expect(distinct.checks.find((check) => check.key === 'duplicateAuras').status).toBe('ok');
    });

    test('an ability that only buffs its caster is not an aura, so two copies are fine', () => {
        const lint = lintComposition({
            members: resolve(['Alice', 'Bob'], {
                alice: kit([INVINCIBLE_HRID]),
                bob: kit([INVINCIBLE_HRID]),
            }),
            abilityDetailMap,
        });
        expect(lint.checks.find((check) => check.key === 'duplicateAuras').status).toBe('ok');
    });

    test('one tank is enough at tier 3 and not at tier 8', () => {
        const members = resolve(['Alice', 'Bob'], {
            alice: kit(['/abilities/taunt']),
            bob: kit(['/abilities/fireball']),
        });

        expect(
            lintComposition({ members, tier: 3, abilityDetailMap }).checks.find((c) => c.key === 'tanks').status
        ).toBe('ok');
        const short = lintComposition({ members, tier: 8, abilityDetailMap }).checks.find((c) => c.key === 'tanks');
        expect(short.status).toBe('gap');
        expect(short.text).toBe('1 of 2 tanks wanted for tier 8');
    });

    test('with no tier named the tank count is reported and not judged', () => {
        const members = resolve(['Alice'], { alice: kit(['/abilities/taunt']) });
        expect(lintComposition({ members, abilityDetailMap }).checks.find((c) => c.key === 'tanks').status).toBe(
            'unknown'
        );
    });

    test('a swap is only suggested from a real bench kit that really carries it', () => {
        const members = resolve(['Alice'], { alice: kit(['/abilities/fireball']) });
        const bench = resolve(['Carol', 'Dave'], {
            carol: kit([REVIVE_HRID]),
            dave: kit(['/abilities/fireball']),
        });

        const lint = lintComposition({ members, bench, tier: 3, abilityDetailMap });
        expect(lint.checks.find((check) => check.key === 'revive').suggestions).toEqual(['Carol']);
        // Nobody on this bench tanks, so the tank gap offers nothing rather
        // than inventing somebody
        expect(lint.checks.find((check) => check.key === 'tanks').suggestions).toEqual([]);
    });

    test('the written plan becomes a check when there is one, and not otherwise', () => {
        const members = resolve(['Alice'], { alice: kit(['/abilities/fireball']) });
        expect(lintComposition({ members, abilityDetailMap }).checks.some((check) => check.key === 'plan')).toBe(false);

        const lint = lintComposition({
            members,
            abilityDetailMap,
            planCompare: {
                verdicts: [{ name: 'Alice', status: 'missing', missing: ['Fierce Aura'] }],
                summary: { planLines: 1, plannedPlayers: 1, comparedPlayers: 1, onPlan: 0 },
            },
        });
        const plan = lint.checks.find((check) => check.key === 'plan');
        expect(plan).toMatchObject({ status: 'gap', text: '1 of 1 not on the written plan' });
        expect(plan.detail).toContain('Fierce Aura');
    });

    test('a plan nobody has a capture for is unknown, not a failure', () => {
        const lint = lintComposition({
            members: resolve(['Alice'], {}),
            abilityDetailMap,
            planCompare: { verdicts: [], summary: { planLines: 1, plannedPlayers: 1, comparedPlayers: 0, onPlan: 0 } },
        });
        expect(lint.checks.find((check) => check.key === 'plan').status).toBe('unknown');
    });
});

describe('compositionStatusLine', () => {
    test('counts the gaps and the unknowns and always states the coverage', () => {
        const lint = lintComposition({
            members: resolve(['Alice', 'Ghost'], { alice: kit(['/abilities/fireball']) }),
            tier: 8,
            abilityDetailMap,
        });
        expect(compositionStatusLine(lint)).toContain('3 unknown');
        expect(compositionStatusLine(lint)).toContain('1 of 2 kits known');
    });

    test('an empty roster has nothing to say about', () => {
        expect(compositionStatusLine(lintComposition({ members: [] }))).toBe('No roster to check.');
    });
});
