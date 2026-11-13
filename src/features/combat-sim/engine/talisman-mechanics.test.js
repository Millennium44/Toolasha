/**
 * The five talisman-only mechanics in the fight: Smite, Shatter, Overkill (in `CombatUtilities.processAttack`),
 * Echo and Fortify (in the simulator).
 *
 * The measured integers come from character 30404 on the test server (2026-11-12/13). The 30404 fixture
 * (`talisman-3a-30404-combat.js`) carries the worn gear but not the food, drinks, buffs or task state that were
 * active when the ceilings were read, so the engine's own crit ceiling from that gear (1638 against no armor) is
 * not the 1783 the server showed. The ceilings are therefore reproduced from a stand-in attacker whose
 * pre-mitigation crit roll is 2469 (the one integer for which 55.2, 64.4, 73.6 and 80.5 armor give 1783, 1704,
 * 1631 and 1581 at the real 0.432 penetration) and the fixture player is used where the question is wiring.
 *
 * What the invariance tests guard is the worst failure: a unit WITHOUT these talismans must fight exactly as
 * before, drawing no extra random numbers.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import CombatSimulator from './combat-simulator.js';
import CombatUtilities from './combat-utilities.js';
import CombatUnit from './combat-unit.js';
import CheckBuffExpirationEvent from './events/check-buff-expiration-event.js';
import { getGameData, setGameData } from './game-data.js';
import Monster from './monster.js';
import Player from './player.js';
import { clearSimRng, random, seedSimRng } from './rng.js';
import Zone from './zone.js';
import { ENHANCEMENT_TABLE } from '../../../__fixtures__/wire/enhancement-scaling.js';
import { COMBAT_MODIFIER_DETAILS } from '../../../__fixtures__/talisman-combat-modifiers.js';
import { SLOTTED_TALISMANS } from '../../../__fixtures__/talisman-3a-30404.js';
import { WORN_GEAR } from '../../../__fixtures__/talisman-3a-30404-combat.js';

const ONE_SECOND = 1e9;

afterEach(() => {
    clearSimRng();
    setGameData(null);
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------
// processAttack on stand-in units
// ---------------------------------------------------------------------------------------------------------------

/** An attacker whose every swing is a certain hit and a certain crit, so its damage is exactly `roll` */
function attacker({ roll = 2469, mechanics, penetration = 0.432, critical = true } = {}) {
    return {
        hrid: 'player1',
        isPlayer: true,
        talismanMechanics: mechanics,
        overkillStore: 0,
        combatDetails: {
            currentHitpoints: 1e9,
            stabAccuracyRating: 1e9,
            stabMaxDamage: roll,
            stabEvasionRating: 1,
            totalArmor: 0,
            defensiveMaxDamage: 0,
            combatStats: {
                combatStyleHrid: '/combat_styles/stab',
                damageType: '/damage_types/physical',
                physicalAmplify: 0,
                armorPenetration: penetration,
                physicalThorns: 0,
                elementalThorns: 0,
                criticalRate: critical ? 10 : 0,
                criticalDamage: 0,
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

function victim({ armor = 0, hp = 1e9, boss = false } = {}) {
    return {
        hrid: '/monsters/dummy',
        isPlayer: false,
        isBoss: boss,
        combatDetails: {
            currentHitpoints: hp,
            stabEvasionRating: 1,
            totalArmor: armor,
            defensiveMaxDamage: 0,
            combatStats: { physicalThorns: 0, elementalThorns: 0, retaliation: 0, damageTaken: 0, armorPenetration: 0 },
        },
    };
}

/** The damage of one certain, critical, maximum-roll hit */
function ceiling(armor, { boss = false, mechanics } = {}) {
    seedSimRng(1);
    return CombatUtilities.processAttack(attacker({ mechanics }), victim({ armor, boss }), null).damageDone;
}

// Shatter 0.05032 and Smite 0.07548 are the belt-scaled values of the 30404 capture (0.04 and 0.06 times 1.258)
const SHATTER = 0.04 * 1.258;
const SMITE = 0.06 * 1.258;

describe('Smite', () => {
    test('a boss crit ceiling of 1581 becomes 1700 and a non-boss one is unchanged', () => {
        expect(ceiling(80.5, { boss: true })).toBe(1581);
        expect(ceiling(80.5, { boss: true, mechanics: { smite: SMITE } })).toBe(1700);
        expect(ceiling(80.5, { boss: false, mechanics: { smite: SMITE } })).toBe(1581);
    });

    test('applies to an ability hit as well, and only on the player who has it', () => {
        const effect = {
            combatStyleHrid: '/combat_styles/stab',
            damageType: '/damage_types/physical',
            bonusAccuracyRatio: 0,
            damageFlat: 0,
            damageRatio: 1,
            armorDamageRatio: 0,
            hpDrainRatio: 0,
        };
        seedSimRng(1);
        const plain = CombatUtilities.processAttack(attacker(), victim({ armor: 80.5, boss: true }), effect);
        seedSimRng(1);
        const smitten = CombatUtilities.processAttack(
            attacker({ mechanics: { smite: SMITE } }),
            victim({ armor: 80.5, boss: true }),
            effect
        );
        expect(smitten.damageDone).toBe(Math.floor(plain.damageDone * (1 + SMITE)));
    });

    test('a real 30404 build reaches the wiring: boss damage is floor(non-boss * (1 + smite))', () => {
        const player = fixturePlayer30404();
        player.combatDetails.combatStats.criticalRate = 10;
        expect(player.talismanMechanics.smite).toBeCloseTo(SMITE, 12);
        seedSimRng(5);
        const normal = CombatUtilities.processAttack(player, victim({ armor: 80.5 }), null).damageDone;
        seedSimRng(5);
        const boss = CombatUtilities.processAttack(player, victim({ armor: 80.5, boss: true }), null).damageDone;
        expect(boss).toBe(Math.floor(normal * (1 + player.talismanMechanics.smite)));
    });
});

describe('Shatter', () => {
    const CASES = [
        // [armor, ceiling without, ceiling with Shatter 0.05032]: stalactite, magnetic, granite golem, boss
        [55.2, 1783, 1800],
        [64.4, 1704, 1722],
        [73.6, 1631, 1650],
        [80.5, 1581, 1601],
    ];

    test.each(CASES)('armor %s: crit ceiling %s becomes %s', (armor, without, withShatter) => {
        expect(ceiling(armor)).toBe(without);
        expect(ceiling(armor, { mechanics: { shatter: SHATTER } })).toBe(withShatter);
    });

    test('only a critical hit is shattered', () => {
        seedSimRng(3);
        const plain = CombatUtilities.processAttack(attacker({ critical: false }), victim({ armor: 80.5 }), null);
        seedSimRng(3);
        const shattered = CombatUtilities.processAttack(
            attacker({ critical: false, mechanics: { shatter: SHATTER } }),
            victim({ armor: 80.5 }),
            null
        );
        expect(shattered.isCrit).toBe(false);
        expect(shattered.damageDone).toBe(plain.damageDone);
    });

    test('an elemental crit pierces the matching resistance by the same amount', () => {
        const fire = (mechanics) => {
            const source = attacker({ mechanics, penetration: 0 });
            source.combatDetails.fireMaxDamage = 0;
            const effect = {
                combatStyleHrid: '/combat_styles/stab',
                damageType: '/damage_types/fire',
                bonusAccuracyRatio: 0,
                damageFlat: 0,
                damageRatio: 1,
                armorDamageRatio: 0,
                hpDrainRatio: 0,
            };
            source.combatDetails.combatStats.fireAmplify = 0;
            source.combatDetails.combatStats.firePenetration = 0.2;
            source.combatDetails.totalFireResistance = 0;
            const target = victim();
            target.combatDetails.totalFireResistance = 80;
            seedSimRng(2);
            return CombatUtilities.processAttack(source, target, effect).damageDone;
        };
        const plain = fire(undefined);
        const shattered = fire({ shatter: 0.3 });
        // 80 / 1.2 = 66.7 resistance against 80 / 1.5 = 53.3
        expect(shattered).toBe(Math.ceil((100 / (100 + 80 / 1.5)) * 2469));
        expect(plain).toBe(Math.ceil((100 / (100 + 80 / 1.2)) * 2469));
    });
});

describe('Overkill', () => {
    // One hit of 300 against a target with 100 left: 200 past the last hitpoint
    const killer = (mechanics) => attacker({ roll: 300, mechanics, penetration: 0 });

    test('a killing blow stores the value times the excess, and the next landed hit adds it as true damage', () => {
        const source = killer({ overkill: 0.1887 });
        seedSimRng(1);
        const first = CombatUtilities.processAttack(source, victim({ hp: 100 }), null);
        expect(first.damageDone).toBe(100);
        expect(source.overkillStore).toBeCloseTo(0.1887 * 200, 9);

        // Armor 100 halves the hit to 150; the stored 37.74 floors to 37 and is not mitigated
        seedSimRng(1);
        const second = CombatUtilities.processAttack(source, victim({ armor: 100 }), null);
        expect(second.damageDone).toBe(150 + Math.floor(0.1887 * 200));
        expect(source.overkillStore).toBe(0);
    });

    test('a measured ratio: extra over excess floors back to 0.1887', () => {
        for (const excess of [500, 1000, 1581]) {
            const source = attacker({ roll: excess + 1, mechanics: { overkill: 0.1887 }, penetration: 0 });
            seedSimRng(1);
            CombatUtilities.processAttack(source, victim({ hp: 1 }), null);
            seedSimRng(1);
            const hit = CombatUtilities.processAttack(source, victim(), null);
            const extra = hit.damageDone - (excess + 1);
            expect(extra).toBe(Math.floor(0.1887 * excess));
        }
    });

    test('a hit that does not kill stores nothing, a miss keeps the store, and kills add up', () => {
        const source = killer({ overkill: 0.5 });
        seedSimRng(1);
        CombatUtilities.processAttack(source, victim(), null);
        expect(source.overkillStore).toBe(0);

        CombatUtilities.processAttack(source, victim({ hp: 100 }), null);
        CombatUtilities.processAttack(source, victim({ hp: 200 }), null);
        // The second kill's blow carried the first kill's store: excess 100 + 0.5*200 = 200 - ... computed below
        expect(source.overkillStore).toBeGreaterThan(0);

        const stored = source.overkillStore;
        source.combatDetails.stabAccuracyRating = 1;
        const dummy = victim();
        dummy.combatDetails.stabEvasionRating = 1e9;
        const missed = CombatUtilities.processAttack(source, dummy, null);
        expect(missed.didHit).toBe(false);
        expect(source.overkillStore).toBe(stored);
    });

    test('a unit without the mechanic never stores or adds anything', () => {
        const source = killer(undefined);
        seedSimRng(1);
        const hit = CombatUtilities.processAttack(source, victim({ hp: 100 }), null);
        expect(hit.damageDone).toBe(100);
        expect(source.overkillStore).toBe(0);
    });
});

describe('zero-mechanic invariance', () => {
    function run(mechanics) {
        seedSimRng(77);
        const out = [];
        const source = attacker({ roll: 400, mechanics, critical: false });
        for (let i = 0; i < 200; i++) {
            const result = CombatUtilities.processAttack(
                source,
                victim({ armor: 30, hp: 150, boss: i % 2 === 0 }),
                null
            );
            out.push(result.damageDone, result.didHit, result.isCrit);
        }
        return { out, next: random() };
    }

    test('absent, empty and zero-valued mechanics give the same results and draw the same numbers', () => {
        const base = run(undefined);
        expect(run({})).toEqual(base);
        expect(run({ echo: 0, smite: 0, shatter: 0, fortify: 0, overkill: 0 })).toEqual(base);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// The simulator: Echo and Fortify
// ---------------------------------------------------------------------------------------------------------------

const ZONE_HRID = '/actions/combat/test_meadow';
const DUMMY_HRID = '/monsters/test_dummy';

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
                            maxSpawnCount: 2,
                            maxTotalStrength: 2,
                            spawns: [{ combatMonsterHrid: DUMMY_HRID, difficultyTier: 0, rate: 1, strength: 1 }],
                        },
                    },
                },
            },
        },
        combatMonsterDetailMap: {
            [DUMMY_HRID]: {
                experience: 10,
                enrageTime: 300 * ONE_SECOND,
                abilities: [],
                combatDetails: {
                    staminaLevel: 10,
                    intelligenceLevel: 5,
                    attackLevel: 40,
                    meleeLevel: 40,
                    defenseLevel: 30,
                    rangedLevel: 1,
                    magicLevel: 1,
                    attackInterval: 3500000000,
                    combatStats: {
                        combatStyleHrids: ['/combat_styles/smash'],
                        damageType: '/damage_types/physical',
                        attackInterval: 0,
                    },
                },
            },
        },
        combatStyleDetailMap: { '/combat_styles/smash': { skillExpMap: { '/skills/attack': 1, '/skills/melee': 1 } } },
    });
}

function plainPlayer(extra = {}) {
    return Player.createFromDTO({
        hrid: 'player1',
        staminaLevel: 70,
        intelligenceLevel: 40,
        attackLevel: 70,
        meleeLevel: 70,
        defenseLevel: 60,
        rangedLevel: 1,
        magicLevel: 1,
        equipment: {},
        food: [null, null, null],
        drinks: [null, null, null],
        abilities: [null, null, null, null],
        houseRooms: {},
        debuffOnLevelGap: 0,
        ...extra,
    });
}

/** A simulator with one player and `count` dummies, mid-fight at one second */
function fightSim({ mechanics = {}, count = 1, hp = 1e9 } = {}) {
    installGameData();
    const zone = new Zone(ZONE_HRID, 0);
    const player = plainPlayer();
    player.zoneBuffs = zone.buffs;
    player.extraBuffs = [];
    const sim = new CombatSimulator([player], zone);
    sim.reset();
    sim.simulationTime = ONE_SECOND;
    player.reset(sim.simulationTime);
    // After the reset: the player rebuilds `talismanMechanics` from its own talismans whenever its stats are rebuilt
    player.talismanMechanics = mechanics;
    sim.enemies = Array.from({ length: count }, () => new Monster(DUMMY_HRID, 0));
    for (const enemy of sim.enemies) {
        enemy.reset(sim.simulationTime);
        enemy.combatDetails.currentHitpoints = hp;
        enemy.combatDetails.maxHitpoints = hp;
        enemy.combatDetails.smashEvasionRating = 1;
        // The dummies never act in these tests
        enemy.combatDetails.combatStats.retaliation = 0;
        sim.simResult.updateTimeSpentAlive(enemy.hrid, true, sim.simulationTime);
    }
    player.combatDetails.smashAccuracyRating = 1e9;
    return { sim, player };
}

const DAMAGE_EFFECT = {
    effectType: '/ability_effect_types/damage',
    targetType: 'enemy',
    combatStyleHrid: '/combat_styles/smash',
    damageType: '/damage_types/physical',
    bonusAccuracyRatio: 0,
    damageFlat: 0,
    damageRatio: 1,
    armorDamageRatio: 0,
    hpDrainRatio: 0,
    damageOverTimeRatio: 0,
    stunChance: 0,
    blindChance: 0,
    silenceChance: 0,
    pierceChance: 0,
    buffs: null,
};
const ABILITY = { hrid: '/abilities/test_strike' };

function spyProcessAttack() {
    const original = CombatUtilities.processAttack.bind(CombatUtilities);
    const calls = [];
    vi.spyOn(CombatUtilities, 'processAttack').mockImplementation((...args) => {
        const result = original(...args);
        calls.push({ options: args[4], result, target: args[1] });
        return result;
    });
    return calls;
}

/**
 * A seeded scenario over every branch the mechanics touch, with no mechanic present: crits, a single-target and an
 * area cast, a life-drain cast, a boss with thorns and retaliation, the monsters' own swings and parries of none.
 * The pin below was taken on the engine as it stood BEFORE the mechanics were added (HEAD~1 of this change), so
 * it shows the new code leaves a unit without them exactly where it was, including the next random number.
 */
function unmechanicalScenario(mechanics) {
    const { sim, player } = fightSim({ mechanics, count: 3, hp: 60 });
    player.combatDetails.combatStats.criticalRate = 0.5;
    player.combatDetails.combatStats.criticalDamage = 0.5;
    player.combatDetails.smashAccuracyRating = 100;
    const [boss, second, third] = sim.enemies;
    for (const enemy of sim.enemies) enemy.combatDetails.smashEvasionRating = 100;
    player.combatDetails.smashEvasionRating = 100;
    boss.isBoss = true;
    boss.combatDetails.combatStats.physicalThorns = 0.3;
    boss.combatDetails.combatStats.retaliation = 0.3;
    boss.combatDetails.smashAccuracyRating = 100;
    second.combatDetails.smashAccuracyRating = 100;
    const single = DAMAGE_EFFECT;
    const area = { ...DAMAGE_EFFECT, targetType: 'allEnemies' };
    const drain = { ...DAMAGE_EFFECT, hpDrainRatio: 0.5 };
    seedSimRng(424242);
    const hp = [];
    for (let i = 0; i < 80; i++) {
        for (const enemy of [boss, second, third]) {
            enemy.combatDetails.currentHitpoints = 60;
        }
        player.combatDetails.currentHitpoints = player.combatDetails.maxHitpoints;
        sim._finalizedDeaths = new WeakSet();
        sim.processAbilityDamageEffect(player, ABILITY, [single, area, drain][i % 3]);
        CombatUtilities.processAttack(second, player, null, sim.taskDamageMode);
        CombatUtilities.processAttack(player, third, null, sim.taskDamageMode);
        hp.push(
            player.combatDetails.currentHitpoints,
            ...[boss, second, third].map((enemy) => enemy.combatDetails.currentHitpoints)
        );
    }
    return {
        totalDamageDealt: sim.simResult.totalDamageDealt,
        deaths: sim.simResult.deaths,
        crits: sim.simResult.crits,
        hpSum: hp.reduce((sum, value) => sum + value, 0),
        next: random(),
    };
}

describe('a unit without the mechanics fights as it did before they existed', () => {
    const PRE_CHANGE = {
        totalDamageDealt: { '/monsters/test_dummy': 1695, player1: 2426 },
        deaths: { '/monsters/test_dummy': 30 },
        crits: { player1: 26 },
        hpSum: 71900,
        next: 0.2778646817896515,
    };

    test('the seeded ability, crit, boss, thorns and drain scenario matches the pre-change engine', () => {
        const got = unmechanicalScenario({});
        expect(got).toEqual(PRE_CHANGE);
    });

    test('absent and zero-valued mechanics match the same pin', () => {
        const base = unmechanicalScenario({});
        expect(unmechanicalScenario(undefined)).toEqual(base);
        expect(unmechanicalScenario({ echo: 0, smite: 0, shatter: 0, fortify: 0, overkill: 0 })).toEqual(base);
    });
});

describe('Echo', () => {
    test('a non-killing cast echoes about the Echo value of the time, at half damage, rolling its own hit', () => {
        const { sim, player } = fightSim({ mechanics: { echo: 0.168 } });
        // Forced crits and a hit chance well under 1, so the echo's own accuracy roll is visible
        player.combatDetails.combatStats.criticalRate = 10;
        player.combatDetails.combatStats.criticalDamage = 0;
        player.combatDetails.smashAccuracyRating = 1;
        sim.enemies[0].combatDetails.smashEvasionRating = 1;
        seedSimRng(11);
        const calls = spyProcessAttack();
        const casts = 6000;
        for (let i = 0; i < casts; i++) {
            sim.enemies[0].combatDetails.currentHitpoints = 1e9;
            sim.processAbilityDamageEffect(player, ABILITY, DAMAGE_EFFECT);
        }
        const echoes = calls.filter((c) => c.options?.isEcho);
        expect(echoes.length / casts).toBeGreaterThan(0.168 - 0.02);
        expect(echoes.length / casts).toBeLessThan(0.168 + 0.02);
        // Its own accuracy roll: some echoes land and some miss (hit chance is 0.5 here)
        expect(echoes.some((c) => c.result.didHit)).toBe(true);
        expect(echoes.some((c) => !c.result.didHit)).toBe(true);
        for (const c of echoes) expect(c.options.damageScale).toBe(0.5);
        // The cast itself is never an echo
        expect(calls.filter((c) => !c.options?.isEcho)).toHaveLength(casts);
    });

    test('the echo hit is half the damage of an identical certain-hit cast', () => {
        const { sim, player } = fightSim({ mechanics: { echo: 1 } });
        player.combatDetails.combatStats.criticalRate = 10;
        player.combatDetails.combatStats.criticalDamage = 0;
        seedSimRng(4);
        const calls = spyProcessAttack();
        sim.processAbilityDamageEffect(player, ABILITY, DAMAGE_EFFECT);
        const [cast, echo] = calls;
        expect(echo.options.isEcho).toBe(true);
        expect(echo.result.damageDone).toBe(Math.ceil(cast.result.damageDone / 2));
    });

    test('both hits are credited to the ability, so the damage totals add up', () => {
        const { sim, player } = fightSim({ mechanics: { echo: 1 } });
        seedSimRng(6);
        const calls = spyProcessAttack();
        sim.processAbilityDamageEffect(player, ABILITY, DAMAGE_EFFECT);
        const dealt = calls.reduce((sum, c) => sum + c.result.damageDone, 0);
        const recorded = sim.simResult.attacks.player1[DUMMY_HRID][ABILITY.hrid];
        const counted = Object.values(recorded).reduce((sum, n) => sum + n, 0);
        expect(counted).toBe(2);
        expect(sim.simResult.totalDamageDealt.player1).toBe(dealt);
    });

    test('a cast that killed its target does not echo and does not roll', () => {
        const { sim, player } = fightSim({ mechanics: { echo: 1 }, hp: 1 });
        seedSimRng(9);
        const calls = spyProcessAttack();
        for (let i = 0; i < 50; i++) {
            sim.enemies[0].combatDetails.currentHitpoints = 1;
            sim._finalizedDeaths = new WeakSet();
            sim.processAbilityDamageEffect(player, ABILITY, DAMAGE_EFFECT);
        }
        expect(calls.filter((c) => c.options?.isEcho)).toHaveLength(0);
        // The stream is where a mechanic-free player would have left it
        const { sim: plainSim, player: plain } = fightSim({ mechanics: {}, hp: 1 });
        seedSimRng(9);
        for (let i = 0; i < 50; i++) {
            plainSim.enemies[0].combatDetails.currentHitpoints = 1;
            plainSim._finalizedDeaths = new WeakSet();
            plainSim.processAbilityDamageEffect(plain, ABILITY, DAMAGE_EFFECT);
        }
        const after = random();
        seedSimRng(9);
        for (let i = 0; i < 50; i++) {
            sim.enemies[0].combatDetails.currentHitpoints = 1;
            sim._finalizedDeaths = new WeakSet();
            sim.processAbilityDamageEffect(player, ABILITY, DAMAGE_EFFECT);
        }
        expect(random()).toBe(after);
    });

    test('a caster put down by thorns on the cast does not echo', () => {
        const { sim, player } = fightSim({ mechanics: { echo: 1 } });
        player.combatDetails.currentHitpoints = 1;
        sim.enemies[0].combatDetails.combatStats.physicalThorns = 50;
        sim.enemies[0].combatDetails.defensiveMaxDamage = 1e6;
        seedSimRng(14);
        const calls = spyProcessAttack();
        sim.processAbilityDamageEffect(player, ABILITY, DAMAGE_EFFECT);
        expect(player.combatDetails.currentHitpoints).toBe(0);
        expect(calls.filter((c) => c.options?.isEcho)).toHaveLength(0);
    });

    test('an area cast rolls once and echoes every target still standing', () => {
        const { sim, player } = fightSim({ mechanics: { echo: 1 }, count: 3 });
        sim.enemies[0].combatDetails.currentHitpoints = 1;
        seedSimRng(8);
        const calls = spyProcessAttack();
        sim.processAbilityDamageEffect(player, ABILITY, { ...DAMAGE_EFFECT, targetType: 'allEnemies' });
        const echoes = calls.filter((c) => c.options?.isEcho);
        expect(echoes.map((c) => c.target)).toEqual([sim.enemies[1], sim.enemies[2]]);
    });

    test('an echo that kills is finished like any other kill', () => {
        const { sim, player } = fightSim({ mechanics: { echo: 1 } });
        player.combatDetails.combatStats.criticalRate = 10;
        player.combatDetails.combatStats.criticalDamage = 0;
        seedSimRng(12);
        const probe = spyProcessAttack();
        sim.processAbilityDamageEffect(player, ABILITY, DAMAGE_EFFECT);
        const cast = probe[0].result.damageDone;
        vi.restoreAllMocks();

        // The same cast against a target with one hitpoint more than it deals: only the echo can kill
        sim.enemies[0].combatDetails.currentHitpoints = cast + 1;
        sim.simResult.attacks = {};
        seedSimRng(12);
        sim.processAbilityDamageEffect(player, ABILITY, DAMAGE_EFFECT);
        expect(sim.enemies[0].combatDetails.currentHitpoints).toBe(0);
        expect(sim.simResult.deaths[DUMMY_HRID]).toBe(1);
    });

    test('Overkill carried into an echo is part of the echo hit, counted once', () => {
        const { sim, player } = fightSim({ mechanics: { echo: 1, overkill: 1 } });
        player.overkillStore = 500;
        player.combatDetails.combatStats.criticalRate = 0;
        seedSimRng(3);
        const calls = spyProcessAttack();
        sim.processAbilityDamageEffect(player, ABILITY, DAMAGE_EFFECT);
        const [cast, echo] = calls;
        // The cast took the store; the echo had nothing left to add
        expect(cast.result.damageDone).toBeGreaterThanOrEqual(500);
        expect(echo.result.damageDone).toBeLessThan(500);
        const recorded = sim.simResult.attacks.player1[DUMMY_HRID][ABILITY.hrid];
        expect(
            Object.keys(recorded)
                .map(Number)
                .sort((a, b) => a - b)
        ).toContain(cast.result.damageDone);
        expect(sim.simResult.totalDamageDealt.player1).toBe(cast.result.damageDone + echo.result.damageDone);
    });
});

describe('Fortify', () => {
    const VALUE = 0.1;

    function hit(sim, player) {
        // A monster swing that always lands
        const monster = sim.enemies[0];
        monster.combatDetails.smashAccuracyRating = 1e9;
        player.combatDetails.smashEvasionRating = 1;
        return sim._processAttack(monster, player, null);
    }

    function bases(player) {
        const { totalArmor, totalWaterResistance, totalNatureResistance, totalFireResistance } = player.combatDetails;
        return [totalArmor, totalWaterResistance, totalNatureResistance, totalFireResistance];
    }

    test('each landed hit adds a stack of armor and every elemental resistance, up to four', () => {
        const { sim, player } = fightSim({ mechanics: { fortify: VALUE } });
        player.combatDetails.maxHitpoints = player.combatDetails.currentHitpoints = 1e9;
        const base = bases(player);
        const seen = [];
        for (let i = 0; i < 6; i++) {
            hit(sim, player);
            seen.push(player.fortifyStacks);
        }
        expect(seen).toEqual([1, 2, 3, 4, 4, 4]);
        bases(player).forEach((value, i) => expect(value).toBeCloseTo(base[i] * (1 + VALUE * 4), 9));
    });

    test('all stacks expire together five seconds after the last hit, and a hit refreshes the window', () => {
        const { sim, player } = fightSim({ mechanics: { fortify: VALUE } });
        player.combatDetails.maxHitpoints = player.combatDetails.currentHitpoints = 1e9;
        const base = bases(player);

        hit(sim, player);
        sim.simulationTime += 4 * ONE_SECOND;
        hit(sim, player);
        expect(player.fortifyStacks).toBe(2);

        // The first hit's window would have ended at +5 s; the second pushed it to +9 s
        sim.simulationTime = ONE_SECOND + 5 * ONE_SECOND;
        sim.processCheckBuffExpirationEvent(new CheckBuffExpirationEvent(sim.simulationTime, player));
        expect(player.fortifyStacks).toBe(2);
        expect(bases(player)[0]).toBeCloseTo(base[0] * 1.2, 9);

        sim.simulationTime = ONE_SECOND + 9 * ONE_SECOND;
        sim.processCheckBuffExpirationEvent(new CheckBuffExpirationEvent(sim.simulationTime, player));
        expect(player.fortifyStacks).toBe(0);
        bases(player).forEach((value, i) => expect(value).toBeCloseTo(base[i], 9));

        // And the next hit starts again from one
        sim.simulationTime += ONE_SECOND;
        hit(sim, player);
        expect(player.fortifyStacks).toBe(1);
    });

    test('a hit after the window ran out without its expiry event starts a fresh stack', () => {
        const { sim, player } = fightSim({ mechanics: { fortify: VALUE } });
        player.combatDetails.maxHitpoints = player.combatDetails.currentHitpoints = 1e9;
        hit(sim, player);
        hit(sim, player);
        sim.simulationTime += 6 * ONE_SECOND;
        hit(sim, player);
        expect(player.fortifyStacks).toBe(1);
    });

    test('a hit arriving after the window, before its expiry event ran, meets base armor', () => {
        const { sim, player } = fightSim({ mechanics: { fortify: VALUE } });
        player.combatDetails.maxHitpoints = player.combatDetails.currentHitpoints = 1e9;
        const base = bases(player);
        hit(sim, player);
        hit(sim, player);
        sim.simulationTime += 5 * ONE_SECOND;
        const seenArmor = [];
        vi.spyOn(CombatUtilities, 'processAttack').mockImplementation(() => {
            seenArmor.push(player.combatDetails.totalArmor);
            return CombatUtilities.skippedAttackResult();
        });
        hit(sim, player);
        expect(seenArmor).toHaveLength(1);
        expect(seenArmor[0]).toBeCloseTo(base[0], 9);
    });

    test('a miss adds nothing, and a unit without Fortify is left exactly as it was', () => {
        const { sim, player } = fightSim({ mechanics: { fortify: VALUE } });
        const monster = sim.enemies[0];
        monster.combatDetails.smashAccuracyRating = 1;
        player.combatDetails.smashEvasionRating = 1e9;
        const result = sim._processAttack(monster, player, null);
        expect(result.didHit).toBe(false);
        expect(player.fortifyStacks).toBe(0);

        const { sim: plainSim, player: plain } = fightSim({ mechanics: {} });
        const before = bases(plain);
        const queued = plainSim.eventQueue.size ?? plainSim.eventQueue.length;
        hit(plainSim, plain);
        expect(plain.fortifyStacks).toBe(0);
        expect(bases(plain)).toEqual(before);
        expect(plainSim.eventQueue.size ?? plainSim.eventQueue.length).toBe(queued);
    });

    test('the stacks and the Overkill store end with the player and with a run reset', () => {
        const { sim, player } = fightSim({ mechanics: { fortify: VALUE, overkill: 0.5 } });
        player.combatDetails.maxHitpoints = player.combatDetails.currentHitpoints = 1e9;
        const base = bases(player);
        hit(sim, player);
        hit(sim, player);
        player.overkillStore = 12;
        sim._finalizeDeath(player);
        expect(player.fortifyStacks).toBe(0);
        expect(player.overkillStore).toBe(0);
        bases(player).forEach((value, i) => expect(value).toBeCloseTo(base[i], 9));

        player.overkillStore = 7;
        player.fortifyStacks = 3;
        player.reset(0);
        expect(player.overkillStore).toBe(0);
        expect(player.fortifyStacks).toBe(0);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole fight, and the build from the DTO
// ---------------------------------------------------------------------------------------------------------------

function fixturePlayer30404() {
    const itemDetailMap = {};
    const equipment = {};
    for (const [hrid, item] of Object.entries(WORN_GEAR)) {
        itemDetailMap[hrid] = {
            name: hrid,
            equipmentDetail: {
                type: item.type,
                combatStats: item.combatStats,
                combatEnhancementBonuses: item.combatEnhancementBonuses,
            },
        };
        equipment[item.type] = { hrid, enhancementLevel: item.lvl };
    }
    setGameData({
        talismansEnabled: true,
        enhancementLevelTotalBonusMultiplierTable: ENHANCEMENT_TABLE,
        talismanModifierDetailMap: COMBAT_MODIFIER_DETAILS,
        itemDetailMap,
    });
    const player = Player.createFromDTO({
        staminaLevel: 150,
        intelligenceLevel: 150,
        attackLevel: 151,
        meleeLevel: 156,
        defenseLevel: 151,
        rangedLevel: 150,
        magicLevel: 156,
        hrid: 'player1',
        equipment,
        food: [],
        drinks: [],
        abilities: [],
        houseRooms: {},
        debuffOnLevelGap: 0,
        talismans: SLOTTED_TALISMANS.map((t) => ({ slotIndex: t.slotIndex, modifiers: t.modifiers })),
    });
    player.updateCombatDetails();
    return player;
}

describe('a full seeded fight', () => {
    const BELT = '/items/large_talisman_belt';
    const GRADE = 6;

    /** Mechanic name to its talisman modifier hrid */
    const LINES = {
        echo: '/talisman_modifiers/echo',
        smite: '/talisman_modifiers/smite',
        shatter: '/talisman_modifiers/shatter',
        fortify: '/talisman_modifiers/fortify',
        overkill: '/talisman_modifiers/overkill',
    };

    /**
     * One seeded ten minutes. The mechanics arrive the way the game gives them: talisman lines in the DTO, scaled by
     * the belt the player wears (Large +0, power 0.2), under game data that says talismans exist.
     * @param {Array<string>} names - Mechanics to wear (none: no belt, no talismans)
     */
    function fight(names, seed = 20260813, { beltOnly = false } = {}) {
        installGameData();
        const base = getGameData();
        setGameData({
            ...base,
            talismansEnabled: true,
            enhancementLevelTotalBonusMultiplierTable: ENHANCEMENT_TABLE,
            talismanModifierDetailMap: COMBAT_MODIFIER_DETAILS,
            itemDetailMap: {
                [BELT]: {
                    name: 'Large Talisman Belt',
                    equipmentDetail: {
                        type: '/equipment_types/belt',
                        combatStats: { talismanSlots: 3, talismanPower: 0.2 },
                        combatEnhancementBonuses: { talismanPower: 0.004 },
                    },
                },
            },
        });
        seedSimRng(seed);
        const zone = new Zone(ZONE_HRID, 0);
        const wearing = names.length > 0 || beltOnly;
        const player = plainPlayer({
            equipment: wearing ? { '/equipment_types/belt': { hrid: BELT, enhancementLevel: 0 } } : {},
            talismans: wearing
                ? [
                      { slotIndex: 1, modifiers: names.slice(0, 4).map((n) => ({ hrid: LINES[n], grade: GRADE })) },
                      { slotIndex: 2, modifiers: names.slice(4).map((n) => ({ hrid: LINES[n], grade: GRADE })) },
                  ]
                : [],
        });
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const result = new CombatSimulator([player], zone).simulate(600 * ONE_SECOND);
        return { result, player, next: random() };
    }

    test('the mechanics reach the fight from the talisman lines, scaled by the belt', () => {
        const { player } = fight(['smite', 'shatter', 'fortify', 'overkill']);
        const grade = (name) => COMBAT_MODIFIER_DETAILS[LINES[name]].gradeValues[GRADE - 1];
        for (const name of ['smite', 'shatter', 'fortify', 'overkill']) {
            expect(player.talismanMechanics[name]).toBeCloseTo(grade(name) * 1.2, 12);
        }
        expect(fight([]).player.talismanMechanics).toEqual({});
    });

    test('a belt with no talismans fights exactly like no belt, to the last random number', () => {
        const none = fight([]);
        const belted = fight([], 20260813, { beltOnly: true });
        expect(belted.player.talismanMechanics).toEqual({});
        expect(belted.next).toBe(none.next);
        expect(JSON.stringify(belted.result)).toBe(JSON.stringify(none.result));
    });

    test('with every mechanic on the run completes and every point of damage is attributed to a hit', () => {
        const { result } = fight(['echo', 'smite', 'shatter', 'fortify', 'overkill']);
        let attributed = 0;
        for (const byTarget of Object.values(result.attacks.player1)) {
            for (const byAbility of Object.values(byTarget)) {
                for (const [damage, count] of Object.entries(byAbility)) {
                    if (damage !== 'miss') attributed += Number(damage) * count;
                }
            }
        }
        expect(attributed).toBe(result.totalDamageDealt.player1);
        expect(attributed).toBeGreaterThan(0);
    });

    test('Overkill adds damage to a fight that kills things, and Fortify changes what the player takes', () => {
        const without = fight([]);
        expect(fight(['overkill']).result.totalDamageDealt.player1).toBeGreaterThan(
            without.result.totalDamageDealt.player1
        );
        const fortified = fight(['fortify']);
        expect(JSON.stringify(fortified.result.totalDamageDealt)).not.toBe(
            JSON.stringify(without.result.totalDamageDealt)
        );
    });
});

describe('the unit base class', () => {
    test('a fresh unit has no Overkill store and no Fortify stacks', () => {
        const unit = new CombatUnit();
        expect(unit.overkillStore).toBe(0);
        expect(unit.fortifyStacks).toBe(0);
    });
});
