/**
 * The labyrinth builds a monster at difficultyTier 0, which drops every
 * tier-gated ability — leaving a monster like the Cyclops as a bare
 * auto-attacker and the sim over-predicting clears. `includeAllAbilities` is the
 * lever that keeps the full kit; this pins that gating down.
 *
 * A minimal single-effect ability detail is supplied so the abilities can
 * actually instantiate; the gating, not the ability's mechanics, is under test.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setGameData } from './game-data.js';
import { setBuffCapture, getCapturedMonsterBuffs } from './combat-unit.js';
import Monster from './monster.js';

const HRID = '/monsters/test_dummy';
const ABILITY_HRID = '/abilities/test_blast';

/** A minimal damage ability the engine can instantiate */
const ABILITY_DETAIL = {
    hrid: ABILITY_HRID,
    manaCost: 0,
    cooldownDuration: 5e9,
    castDuration: 0,
    isSpecialAbility: false,
    abilityEffects: [
        {
            targetType: 'allEnemies',
            effectType: '/ability_effect_types/damage',
            combatStyleHrid: '/combat_styles/magic',
            damageType: '/damage_types/fire',
            baseDamageFlat: 0,
            baseDamageFlatLevelBonus: 0,
            baseDamageRatio: 0.3,
            baseDamageRatioLevelBonus: 0,
            bonusAccuracyRatio: 0,
            bonusAccuracyRatioLevelBonus: 0,
            damageOverTimeRatio: 0,
            damageOverTimeDuration: 0,
            armorDamageRatio: 0,
            armorDamageRatioLevelBonus: 0,
            hpDrainRatio: 0,
            pierceChance: 0,
            blindChance: 0,
            blindDuration: 0,
            silenceChance: 0,
            silenceDuration: 0,
            stunChance: 0,
            stunDuration: 0,
            spendHpRatio: 0,
            buffs: null,
        },
    ],
    defaultCombatTriggers: [],
};

/** Two abilities, one available at tier 0 and one gated behind tier 1 */
const ABILITIES = [
    { abilityHrid: ABILITY_HRID, level: 10, minDifficultyTier: 0 },
    { abilityHrid: ABILITY_HRID, level: 10, minDifficultyTier: 1 },
];

function seed(abilities = ABILITIES) {
    setGameData({
        abilityDetailMap: { [ABILITY_HRID]: ABILITY_DETAIL },
        combatMonsterDetailMap: { [HRID]: { enrageTime: 0, abilities } },
    });
}

afterEach(() => setGameData(null));

describe('Monster ability tier gating', () => {
    test('at difficulty tier 0 the tier-gated ability is dropped by default', () => {
        seed();
        const monster = new Monster(HRID, 0, 100);
        expect(monster.abilities.filter(Boolean)).toHaveLength(1);
    });

    test('includeAllAbilities keeps the full kit even at tier 0', () => {
        seed();
        const monster = new Monster(HRID, 0, 100, true);
        expect(monster.abilities.filter(Boolean)).toHaveLength(2);
    });

    test('the tier filter still applies to non-labyrinth monsters', () => {
        // A tier-2 monster instantiates a tier-1 ability but not a tier-3 gate
        seed([
            { abilityHrid: ABILITY_HRID, level: 10, minDifficultyTier: 1 },
            { abilityHrid: ABILITY_HRID, level: 10, minDifficultyTier: 3 },
        ]);
        const monster = new Monster(HRID, 2, 0);
        expect(monster.abilities.filter(Boolean)).toHaveLength(1);
    });
});

describe('Labyrinth resistance recompute keeps self-buffs', () => {
    // The Cyclops has no base fire resistance; its whole fire mitigation is
    // 0.2*defense plus its Toughness / Guardian Aura self-buffs. The room-level
    // rescale used to reassign the totals from base stats and wipe those buffs,
    // so the sim under-mitigated and over-credited the player's damage per hit.
    const RES_HRID = '/monsters/res_dummy';
    function seedRes(combatStats = {}) {
        setGameData({
            abilityDetailMap: {},
            combatMonsterDetailMap: {
                [RES_HRID]: {
                    enrageTime: 0,
                    experience: 100,
                    abilities: [],
                    combatDetails: {
                        staminaLevel: 100,
                        intelligenceLevel: 100,
                        attackLevel: 100,
                        meleeLevel: 100,
                        defenseLevel: 100,
                        rangedLevel: 100,
                        magicLevel: 100,
                        attackInterval: 3e9,
                        combatStats: {
                            combatStyleHrids: ['/combat_styles/smash'],
                            attackInterval: 0,
                            fireResistance: 0,
                            armor: 0,
                            ...combatStats,
                        },
                    },
                },
            },
        });
    }

    test('base fire resistance scales from unscaled defense with no buff', () => {
        seedRes();
        const monster = new Monster(RES_HRID, 0, 200);
        monster.updateCombatDetails();
        // room 200: defenseLevel 200, base = (0.2 * 100 unscaled + 0) * 2 = 40
        expect(monster.combatDetails.totalFireResistance).toBeCloseTo(40, 3);
    });

    test('a flat fire-resistance buff lands on top of the rescaled base', () => {
        seedRes();
        const monster = new Monster(RES_HRID, 0, 200);
        monster.combatBuffs = {
            toughness: { typeHrid: '/buff_types/fire_resistance', flatBoost: 500, ratioBoost: 0 },
        };
        monster.updateCombatDetails();
        // 40 base + 500 buff — before the fix this read 40, wiping the buff
        expect(monster.combatDetails.totalFireResistance).toBeCloseTo(540, 3);
    });

    test('a ratio armour buff scales off the rescaled base', () => {
        seedRes();
        const monster = new Monster(RES_HRID, 0, 200);
        monster.combatBuffs = { guard: { typeHrid: '/buff_types/armor', flatBoost: 0, ratioBoost: 0.5 } };
        monster.updateCombatDetails();
        // base armour 40, +50% = 60
        expect(monster.combatDetails.totalArmor).toBeCloseTo(60, 3);
    });
});

describe('updateCombatDetails is idempotent and reconstructive', () => {
    // A general invariant on the stat-total recompute: computing twice must give
    // the same totals, and an incrementally-buffed monster must equal a fresh one
    // rebuilt with the same buff set. Guards the class of rescale/stale-state bugs
    // where a recompute diverges from a clean rebuild.
    const INV_HRID = '/monsters/inv_dummy';
    function seedInv() {
        setGameData({
            abilityDetailMap: {},
            combatMonsterDetailMap: {
                [INV_HRID]: {
                    enrageTime: 0,
                    experience: 100,
                    abilities: [],
                    combatDetails: {
                        staminaLevel: 100,
                        intelligenceLevel: 100,
                        attackLevel: 100,
                        meleeLevel: 100,
                        defenseLevel: 100,
                        rangedLevel: 100,
                        magicLevel: 100,
                        attackInterval: 3e9,
                        combatStats: {
                            combatStyleHrids: ['/combat_styles/smash'],
                            attackInterval: 0,
                            fireResistance: 100,
                            armor: 50,
                        },
                    },
                },
            },
        });
    }
    afterEach(() => setGameData(null));

    const BUFF = {
        uniqueHrid: '/buff_uniques/toughness',
        typeHrid: '/buff_types/fire_resistance',
        flatBoost: 300,
        ratioBoost: 0,
        duration: 1e12,
    };

    test('recomputing twice yields identical totals', () => {
        seedInv();
        const monster = new Monster(INV_HRID, 0, 200);
        monster.combatBuffs = { [BUFF.uniqueHrid]: BUFF };
        monster.updateCombatDetails();
        const first = monster.combatDetails.totalFireResistance;
        monster.updateCombatDetails();
        expect(monster.combatDetails.totalFireResistance).toBeCloseTo(first, 6);
    });

    test('incrementally buffed equals a fresh rebuild with the same buff set', () => {
        seedInv();
        const incremental = new Monster(INV_HRID, 0, 200);
        incremental.addBuff(BUFF, 0); // addBuff runs updateCombatDetails

        const fresh = new Monster(INV_HRID, 0, 200);
        fresh.combatBuffs = { [BUFF.uniqueHrid]: BUFF };
        fresh.updateCombatDetails();

        expect(incremental.combatDetails.totalFireResistance).toBeCloseTo(fresh.combatDetails.totalFireResistance, 6);
    });
});

describe('buff capture (blind-sim instrumentation)', () => {
    const HRID2 = '/monsters/cap_dummy';
    function seedCap() {
        setGameData({
            abilityDetailMap: {},
            combatMonsterDetailMap: {
                [HRID2]: {
                    enrageTime: 0,
                    experience: 100,
                    abilities: [],
                    combatDetails: {
                        staminaLevel: 100,
                        intelligenceLevel: 100,
                        attackLevel: 100,
                        meleeLevel: 100,
                        defenseLevel: 100,
                        rangedLevel: 100,
                        magicLevel: 100,
                        attackInterval: 3e9,
                        combatStats: { combatStyleHrids: ['/combat_styles/smash'], attackInterval: 0 },
                    },
                },
            },
        });
    }

    afterEach(() => {
        setBuffCapture(false);
        setGameData(null);
    });

    test('records the peak magnitude of a buff applied to the monster', () => {
        seedCap();
        const monster = new Monster(HRID2, 0, 100);
        setBuffCapture(true);
        // Two applications of the same buff at different strengths; keep the peak.
        monster.addBuff(
            {
                uniqueHrid: '/buff_uniques/shred',
                typeHrid: '/buff_types/armor',
                ratioBoost: -0.2,
                flatBoost: 0,
                duration: 1e12,
            },
            0
        );
        monster.addBuff(
            {
                uniqueHrid: '/buff_uniques/shred',
                typeHrid: '/buff_types/armor',
                ratioBoost: -0.35,
                flatBoost: 0,
                duration: 1e12,
            },
            1
        );
        const produced = getCapturedMonsterBuffs();
        const shred = produced.find((b) => b.uniqueHrid === '/buff_uniques/shred');
        expect(shred).toBeTruthy();
        expect(shred.ratioBoost).toBeCloseTo(-0.35, 6);
    });

    test('captures nothing when the flag is off', () => {
        seedCap();
        const monster = new Monster(HRID2, 0, 100);
        monster.addBuff(
            {
                uniqueHrid: '/buff_uniques/x',
                typeHrid: '/buff_types/armor',
                ratioBoost: 0.5,
                flatBoost: 0,
                duration: 1e12,
            },
            0
        );
        expect(getCapturedMonsterBuffs()).toEqual([]);
    });
});

describe('resetCooldowns — labyrinth abilities open at deterministic half-cooldown', () => {
    test('a labyrinth monster (roomLevel > 0) opens each ability at exactly cd/2, no randomness', () => {
        seed();
        const now = 1e9;
        const lab = new Monster(HRID, 0, 200);
        lab.resetCooldowns(now);
        const ability = lab.abilities.find((a) => a);
        // Ready at now + 0.5·cd — the real lab casts Toughness at ~15s on a 30s
        // cooldown and a guardian aura at 60s on 120s, deterministically. No
        // random term, so under-run resistance-buff uptime can't over-credit the
        // player's damage.
        expect(ability.lastUsed).toBe(now - Math.floor(ability.cooldownDuration * 0.5));
    });

    test('a zone monster (roomLevel 0) keeps the randomized [cd/2, cd) first cast', () => {
        seed();
        const now = 1e9;
        const zone = new Monster(HRID, 0, 0);
        zone.resetCooldowns(now);
        const ability = zone.abilities.find((a) => a);
        const half = Math.floor(ability.cooldownDuration * 0.5);
        // lastUsed = now - half + floor(rand·half) ∈ [now - half, now)
        expect(ability.lastUsed).toBeGreaterThanOrEqual(now - half);
        expect(ability.lastUsed).toBeLessThan(now);
    });
});
