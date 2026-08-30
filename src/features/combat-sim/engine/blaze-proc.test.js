// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * Where blaze procs from, pinned.
 *
 * `blaze` is a combat stat, not an ability the player slots: the engine
 * synthesises `/abilities/blaze` in `ability.js` and casts it as a free extra
 * ability. The only place it is rolled is `tryUseAbility` — an *ability cast*
 * procs it, an auto attack does not. That split is invisible from the stat
 * sheet and expensive to get wrong in either direction: rolled on autos too, a
 * blaze build's simulated damage inflates by several percent (most visibly
 * against a monster whose resistances dwarf its armour, where an elemental
 * side-channel is the only thing that moves); never rolled at all, an
 * ability-heavy blaze build under-reads by the same amount.
 *
 * These tests hold both halves at once, so a change to either path has to move
 * a red test rather than a number nobody was watching. The auto-attack half is
 * the invariant an implementation of blaze-on-autos would have to break
 * deliberately — see the comment at `processAutoAttackEvent` for why the repo
 * has no evidence the game does that.
 */

import { describe, test, expect, afterEach } from 'vitest';

import CombatSimulator from './combat-simulator.js';
import { setGameData } from './game-data.js';
import Player from './player.js';
import { clearSimRng, seedSimRng } from './rng.js';
import Zone from './zone.js';

const ONE_SECOND = 1e9;

const ZONE_HRID = '/actions/combat/golden_meadow';
const RAT_HRID = '/monsters/golden_rat';
const BLAZE_CHARM_HRID = '/items/test_blaze_back';
const STRIKE_HRID = '/abilities/test_strike';

/** Every numeric field an ability effect is read for, all off. */
const NO_EFFECT = {
    baseDamageFlat: 0,
    baseDamageFlatLevelBonus: 0,
    baseDamageRatio: 0,
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
};

/** A punching bag: enough hitpoints to survive the window, no offence worth modelling. */
function monster() {
    return {
        experience: 10,
        enrageTime: 300 * ONE_SECOND,
        abilities: [],
        combatDetails: {
            staminaLevel: 200,
            intelligenceLevel: 1,
            attackLevel: 1,
            meleeLevel: 1,
            defenseLevel: 1,
            rangedLevel: 1,
            magicLevel: 1,
            attackInterval: 3500000000,
            combatStats: {
                combatStyleHrids: ['/combat_styles/smash'],
                damageType: '/damage_types/physical',
                attackInterval: 0,
            },
        },
    };
}

/**
 * One zone, one monster, one item that grants blaze outright, and one trivial
 * ability the player can spam.
 */
function installGameData() {
    setGameData({
        actionDetailMap: {
            [ZONE_HRID]: {
                buffs: null,
                combatZoneInfo: {
                    isDungeon: false,
                    dungeonInfo: null,
                    fightInfo: {
                        bossSpawns: null,
                        randomSpawnInfo: {
                            maxSpawnCount: 1,
                            maxTotalStrength: 1,
                            spawns: [{ combatMonsterHrid: RAT_HRID, difficultyTier: 0, rate: 1, strength: 1 }],
                        },
                    },
                },
            },
        },
        combatMonsterDetailMap: { [RAT_HRID]: monster() },
        combatStyleDetailMap: {
            '/combat_styles/smash': { skillExpMap: { '/skills/attack': 1, '/skills/melee': 1 } },
            '/combat_styles/magic': { skillExpMap: { '/skills/intelligence': 1, '/skills/magic': 1 } },
        },
        enhancementLevelTotalBonusMultiplierTable: [0],
        itemDetailMap: {
            // Worn on the back, not the charm slot: the charm slot is read for
            // focusTraining, which this fixture has no reason to carry
            [BLAZE_CHARM_HRID]: {
                equipmentDetail: {
                    // Certainty, so a run of any length that can proc blaze does
                    combatStats: { blaze: 1 },
                    combatEnhancementBonuses: {},
                },
            },
        },
        abilityDetailMap: {
            [STRIKE_HRID]: {
                hrid: STRIKE_HRID,
                name: 'Test Strike',
                isSpecialAbility: false,
                manaCost: 0,
                cooldownDuration: 2 * ONE_SECOND,
                castDuration: 0,
                abilityEffects: [
                    {
                        ...NO_EFFECT,
                        targetType: 'enemy',
                        effectType: '/ability_effect_types/damage',
                        combatStyleHrid: '/combat_styles/smash',
                        damageType: '/damage_types/physical',
                        baseDamageRatio: 1,
                    },
                ],
                // No triggers: the ability fires whenever it is off cooldown
                defaultCombatTriggers: [],
            },
        },
    });
}

/**
 * One seeded window in the fixture zone.
 * @param {Object} options
 * @param {boolean} options.withAbility - Slot the test ability, or fight bare-handed
 * @param {number} [options.seconds] - Simulated seconds
 * @returns {Object} `{attacks, kills}` — the per-source histogram against the
 *   fixture monster, and how many of them died
 */
function tally({ withAbility, seconds = 120 }) {
    installGameData();
    seedSimRng(4242);

    const zone = new Zone(ZONE_HRID, 0);
    const player = Player.createFromDTO({
        hrid: 'player1',
        staminaLevel: 90,
        intelligenceLevel: 90,
        attackLevel: 90,
        meleeLevel: 90,
        defenseLevel: 60,
        rangedLevel: 1,
        magicLevel: 90,
        equipment: { '/equipment_types/back': { hrid: BLAZE_CHARM_HRID, enhancementLevel: 0 } },
        food: [null, null, null],
        drinks: [null, null, null],
        abilities: withAbility ? [{ hrid: STRIKE_HRID, level: 1, triggers: null }, null, null, null] : [],
        houseRooms: {},
        debuffOnLevelGap: 0,
    });
    player.zoneBuffs = zone.buffs;
    player.extraBuffs = [];

    const simulator = new CombatSimulator([player], zone);
    const result = simulator.simulate(seconds * ONE_SECOND);
    return {
        attacks: result.attacks.player1?.[RAT_HRID] ?? {},
        kills: result.deaths[RAT_HRID] ?? 0,
    };
}

/**
 * How many entries — hits and misses together — a tally source holds.
 * @param {Object} [histogram] - `{miss: n, <damage>: n, …}`
 * @returns {number}
 */
function entries(histogram) {
    return Object.values(histogram ?? {}).reduce((sum, n) => sum + n, 0);
}

afterEach(() => {
    clearSimRng();
    setGameData(null);
});

describe('blaze procs on ability casts only', () => {
    test('the stat is really on — an ability cast at blaze 1.0 files blaze every time', () => {
        const { attacks, kills } = tally({ withAbility: true });

        const casts = entries(attacks[STRIKE_HRID]);
        const blazes = entries(attacks.blaze);

        expect(casts).toBeGreaterThan(0);
        // At blaze 1.0 the roll never fails, so every cast procs — except a
        // cast that emptied the room. Blaze targets `allEnemies` and resolves
        // after the ability that carried it, so a killing blow leaves it
        // nothing alive to hit and it files nothing. That is the only shortfall
        // allowed, and it is bounded by the kills the run actually made
        expect(casts - blazes).toBeGreaterThanOrEqual(0);
        expect(casts - blazes).toBeLessThanOrEqual(kills);
    });

    test('an auto attack never procs blaze, however high the stat', () => {
        const { attacks } = tally({ withAbility: false });

        // The run really happened, and blaze really was at 1.0
        expect(entries(attacks.autoAttack)).toBeGreaterThan(0);
        expect(attacks.blaze).toBeUndefined();
    });

    test('a blaze proc is filed under its own key, on the counted side of the split', () => {
        const { attacks } = tally({ withAbility: true });

        // 'blaze', not '/abilities/blaze': the engine constructs the synthetic
        // ability from the combat-stat name, and `Ability` keeps the hrid it was
        // given. `simDamageTally` reads this key as a counted swing — right,
        // because the path that files it also files 'miss', so there is a
        // counted attempt behind every entry
        expect(Object.keys(attacks)).toContain('blaze');
        expect(Object.keys(attacks)).not.toContain('/abilities/blaze');
    });
});
