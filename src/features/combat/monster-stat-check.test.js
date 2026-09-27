/**
 * The point of the panel is to make a sim-vs-game gap visible and to say which
 * gaps are buffs and which are bugs. These pin the room-level recovery, the
 * verdict logic, and an end-to-end comparison against a real engine-built
 * monster — so a match reads as a match, a live buff reads as a buff, and a
 * genuine modelling gap reads as a mismatch.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setGameData } from '../combat-sim/engine/game-data.js';
import Monster from '../combat-sim/engine/monster.js';
import {
    deriveRoomLevel,
    styleKeyOf,
    activeBuffNames,
    statRows,
    compareStat,
    classify,
    buildComparison,
    buffedStatKeys,
    planBuffFold,
    simPlayerLabel,
    combatEffectNames,
    flaggedRows,
    buildExportPayload,
    buffName,
    compareBuffProduction,
    buffSignature,
    unionProducedBuffs,
    captureContextMismatches,
} from './monster-stat-check.js';

describe('deriveRoomLevel', () => {
    test('recovers the room level from the scaled defense', () => {
        // room 212: gameDefense = base * 212/100
        expect(deriveRoomLevel(212, 100)).toBe(212);
        expect(deriveRoomLevel(636, 300)).toBe(212);
    });

    test('treats an unscaled monster as no room level', () => {
        expect(deriveRoomLevel(100, 100)).toBe(0); // scale 1.0
        expect(deriveRoomLevel(105, 100)).toBe(0); // within the ~1.0 floor
    });

    test('guards against missing or zero inputs', () => {
        expect(deriveRoomLevel(0, 100)).toBe(0);
        expect(deriveRoomLevel(200, 0)).toBe(0);
        expect(deriveRoomLevel(undefined, undefined)).toBe(0);
    });
});

describe('styleKeyOf', () => {
    test('reads the array form and the singular form', () => {
        expect(styleKeyOf({ combatStyleHrids: ['/combat_styles/magic'] })).toBe('magic');
        expect(styleKeyOf({ combatStyleHrid: '/combat_styles/smash' })).toBe('smash');
    });

    test('falls back to smash when unstyled', () => {
        expect(styleKeyOf({})).toBe('smash');
        expect(styleKeyOf(null)).toBe('smash');
    });
});

describe('activeBuffNames', () => {
    test('strips the hrid path and underscores', () => {
        expect(activeBuffNames({ '/buff_uniques/curse': {}, '/buff_uniques/guardian_aura': {} })).toEqual([
            'curse',
            'guardian aura',
        ]);
    });

    test('empty when nothing is up', () => {
        expect(activeBuffNames({})).toEqual([]);
        expect(activeBuffNames(null)).toEqual([]);
    });
});

describe('compareStat', () => {
    test('deltaPct is the game relative to the sim baseline', () => {
        // game below baseline (a debuff shredded it) → negative
        expect(compareStat('x', { x: 90 }, { x: 100 }).deltaPct).toBeCloseTo(-10, 6);
        // game above baseline (a buff raised it) → positive
        expect(compareStat('x', { x: 120 }, { x: 100 }).deltaPct).toBeCloseTo(20, 6);
        expect(compareStat('x', { x: 100 }, { x: 100 }).deltaPct).toBe(0);
    });

    test('null when a side is missing, zero when both read zero', () => {
        expect(compareStat('x', {}, { x: 5 }).deltaPct).toBeNull();
        expect(compareStat('x', { x: 5 }, {}).deltaPct).toBeNull();
        expect(compareStat('x', { x: 5 }, { x: 0 }).deltaPct).toBeNull(); // can't divide by a zero baseline
        expect(compareStat('x', { x: 0 }, { x: 0 }).deltaPct).toBe(0);
    });

    test('falls back to combatStats when the flat key is missing — the sim shape for timing/crit rows', () => {
        // The game's payload carries attackInterval flat; the sim only ever
        // computes it onto combatStats (see the comment above TIMING_ROWS in
        // monster-stat-check.js). A flat key on one side and a nested one on
        // the other must still compare correctly.
        const game = { attackInterval: 3104213747 };
        const sim = { combatStats: { attackInterval: 3104213747 } };
        expect(compareStat('attackInterval', game, sim).deltaPct).toBe(0);
        expect(compareStat('attackInterval', game, sim).sim).toBe(3104213747);
    });

    test('a flat key on both sides is read flat, never shadowed by a same-named nested one', () => {
        expect(compareStat('x', { x: 100, combatStats: { x: 999 } }, { x: 100 }).game).toBe(100);
    });
});

describe('classify', () => {
    test('within tolerance is a match', () => {
        expect(classify(0, false)).toBe('match');
        expect(classify(0.5, true)).toBe('match');
    });

    test('game above the baseline with an effect up is a buff', () => {
        expect(classify(47, true)).toBe('buff');
    });

    test('game below the baseline with an effect up is a debuff', () => {
        // The pestilent-shot case: sim baseline 515, game 413 → −19.8%, effect up
        expect(classify(-19.8, true)).toBe('debuff');
    });

    test('any gap with no active effect is a mismatch', () => {
        expect(classify(-32, false)).toBe('mismatch');
        expect(classify(47, false)).toBe('mismatch');
    });

    test('no data is unknown', () => {
        expect(classify(null, true)).toBe('unknown');
    });

    test('lowerIsBetter flips which direction reads as a buff', () => {
        // Attack interval: game below the sim baseline (a real attack-speed
        // buff shortened it) must read as a buff, not a debuff.
        expect(classify(-19.8, true, true)).toBe('buff');
        // Game above the baseline (interval got longer) is the bad direction.
        expect(classify(19.8, true, true)).toBe('debuff');
    });

    test('lowerIsBetter does not change a mismatch or a match', () => {
        expect(classify(-32, false, true)).toBe('mismatch');
        expect(classify(0.5, true, true)).toBe('match');
        expect(classify(null, true, true)).toBe('unknown');
    });
});

describe('buildComparison against an engine-built monster', () => {
    const HRID = '/monsters/stat_dummy';

    function seed() {
        setGameData({
            abilityDetailMap: {},
            combatMonsterDetailMap: {
                [HRID]: {
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
                            combatStyleHrids: ['/combat_styles/magic'],
                            attackInterval: 0,
                            armor: 200,
                            fireResistance: 500,
                            natureResistance: 500,
                            waterResistance: 100,
                        },
                    },
                },
            },
        });
    }

    afterEach(() => setGameData(null));

    /** A game unit whose live combatDetails equal the sim's, before any override */
    function gameUnitMatching(simDetails, extra = {}) {
        return {
            combatBuffMap: {},
            combatDetails: { ...simDetails, combatStats: { combatStyleHrids: ['/combat_styles/magic'] } },
            ...extra,
        };
    }

    test('identical numbers read as all matches', () => {
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const result = buildComparison(gameUnitMatching(monster.combatDetails), monster.combatDetails);

        expect(result.hasMismatch).toBe(false);
        const verdicts = result.groups.flatMap((g) => g.rows.map((r) => r.verdict));
        expect(verdicts.every((v) => v === 'match' || v === 'unknown')).toBe(true);
        // The fire-resistance row is present and matched
        const fire = result.groups[0].rows.find((r) => r.key === 'totalFireResistance');
        expect(fire.verdict).toBe('match');
    });

    test('a live resistance buff above the sim baseline reads as buff, not bug', () => {
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails, {
            combatBuffMap: { '/buff_uniques/toughness': {} },
        });
        // Game's fire resist has ramped 30% above the sim's static baseline
        gameUnit.combatDetails.totalFireResistance = monster.combatDetails.totalFireResistance * 1.3;

        const result = buildComparison(gameUnit, monster.combatDetails);
        const fire = result.groups[0].rows.find((r) => r.key === 'totalFireResistance');
        expect(fire.verdict).toBe('buff');
        expect(result.hasMismatch).toBe(false);
        expect(result.buffs).toContain('toughness');
    });

    test('a live resistance shred below the sim baseline reads as debuff, not bug', () => {
        // The pestilent-shot case: the player's debuff lowers the monster's armour
        // ~20% below the sim's unbuffed baseline. That is the debuff working, not a
        // sim error — the panel must not flag it red.
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails, {
            combatBuffMap: { '/buff_uniques/pestilent_shot_armor': {} },
        });
        gameUnit.combatDetails.totalArmor = monster.combatDetails.totalArmor * 0.8;

        const result = buildComparison(gameUnit, monster.combatDetails);
        const armor = result.groups[0].rows.find((r) => r.key === 'totalArmor');
        expect(armor.verdict).toBe('debuff');
        expect(result.hasMismatch).toBe(false);
    });

    test('with the effect applied to the sim, the debuffed stat matches', () => {
        // The buffed-sim path: inject the same pestilent-shot armour shred into
        // the sim, and the game's debuffed armour should line up — a match, not a
        // flag, because both sides now carry the effect.
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.combatBuffs = {
            '/buff_uniques/pestilent_shot_armor': { typeHrid: '/buff_types/armor', ratioBoost: -0.199, flatBoost: 0 },
        };
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails, {
            combatBuffMap: { '/buff_uniques/pestilent_shot_armor': {} },
        });

        const result = buildComparison(gameUnit, monster.combatDetails, { simBuffed: true });
        const armor = result.groups[0].rows.find((r) => r.key === 'totalArmor');
        expect(armor.verdict).toBe('match');
        expect(result.hasMismatch).toBe(false);
        expect(result.simBuffed).toBe(true);
    });

    test('in buffed mode a real gap is a mismatch, not a debuff', () => {
        // Effects are already in the sim, so a remaining gap is unexplained — it
        // must read as a mismatch even though an effect is present.
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails, {
            combatBuffMap: { '/buff_uniques/pestilent_shot_armor': {} },
        });
        gameUnit.combatDetails.totalArmor = monster.combatDetails.totalArmor * 0.8;

        const result = buildComparison(gameUnit, monster.combatDetails, { simBuffed: true });
        const armor = result.groups[0].rows.find((r) => r.key === 'totalArmor');
        expect(armor.verdict).toBe('mismatch');
        expect(result.hasMismatch).toBe(true);
    });

    test('a gap with no buffs is flagged as a mismatch', () => {
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails); // no buffs
        gameUnit.combatDetails.totalArmor = monster.combatDetails.totalArmor * 1.5;

        const result = buildComparison(gameUnit, monster.combatDetails);
        const armor = result.groups[0].rows.find((r) => r.key === 'totalArmor');
        expect(armor.verdict).toBe('mismatch');
        expect(result.hasMismatch).toBe(true);
    });

    test('a leniency key stays buff-aware even in buffed mode — precision is not a bug', () => {
        // The player check: the sim's fight-start build has no precision, so live
        // accuracy sits ~68% above it. Named as a leniency key, that row reads as a
        // buff, not a mismatch, while every other stat keeps the sharp check.
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails, {
            combatBuffMap: { '/buff_uniques/precision': { typeHrid: '/buff_types/accuracy', ratioBoost: 0.684 } },
        });
        gameUnit.combatDetails.magicAccuracyRating = monster.combatDetails.magicAccuracyRating * 1.684;

        const leniencyKeys = buffedStatKeys(gameUnit.combatBuffMap, 'magic');
        const result = buildComparison(gameUnit, monster.combatDetails, { simBuffed: true, leniencyKeys });
        const acc = result.groups.flatMap((g) => g.rows).find((r) => r.key === 'magicAccuracyRating');
        expect(acc.verdict).toBe('buff');
        expect(result.hasMismatch).toBe(false);
    });

    test('leniency is scoped — an un-boosted stat still flags in buffed mode', () => {
        // Precision lifts accuracy only; an armour gap the same run is still a bug.
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails, {
            combatBuffMap: { '/buff_uniques/precision': { typeHrid: '/buff_types/accuracy', ratioBoost: 0.684 } },
        });
        gameUnit.combatDetails.totalArmor = monster.combatDetails.totalArmor * 0.8;

        const leniencyKeys = buffedStatKeys(gameUnit.combatBuffMap, 'magic');
        const result = buildComparison(gameUnit, monster.combatDetails, { simBuffed: true, leniencyKeys });
        const armor = result.groups[0].rows.find((r) => r.key === 'totalArmor');
        expect(armor.verdict).toBe('mismatch');
    });
});

describe('Timing rows — monster attack interval/cast speed/crit, player HP regen', () => {
    const HRID = '/monsters/pyre_hunter_stat_dummy';
    const ROOM_LEVEL = 255;

    // Trimmed straight from a real labyrinth tick capture (a Pyre Hunter at room
    // 255 and its player, `new_battle` payloads) — not derived from anything the
    // sim computes. Building the "game" side from these, rather than by copying
    // the sim's own numbers, is the point: it proves the comparison reproduces
    // what the game actually sent, not just that a value equals itself.
    const REAL_MONSTER = {
        attackLevel: 255,
        rawAttackInterval: 3_500_000_000, // combatStats.attackInterval (base, pre-scaling)
        attackInterval: 3_104_212_860, // flat, resolved — attackLevel/2000 = 0.1275 only, no buffs
        totalCastSpeed: 0.1275,
    };
    const REAL_PLAYER = {
        attackLevel: 154,
        rawAttackInterval: 2_718_060_971, // combatStats.attackInterval (weapon base)
        attackInterval: 1_917_730_617, // flat, resolved — attackLevel/2000 + a 0.316 attack-speed buff total
        rawCastSpeed: 0.048, // combatStats.castSpeed (base gear stat, pre-level, pre-buff)
        totalCastSpeed: 0.441, // flat, resolved — see the arithmetic test below
        // Neither the monster nor the player capture has a flat top-level form
        // of these three; both only ever carry them under combatStats.
        criticalRate: 0.312128,
        criticalDamage: 0.1,
        hpRegenPer10: 0.0742,
        // A trimmed slice of the real combatBuffMap: enough cast/attack-speed
        // buffs to be a non-empty, realistic buff set (a player's map is never
        // actually this short — guild, house, community and achievement buffs
        // are always present too), enough to bridge the cast-speed gap below,
        // and the matching attack-speed buffs (same four sources, ratioBoost
        // instead of flatBoost) that shorten the real attack interval.
        combatBuffMap: {
            '/buff_uniques/cast_speed_guild_buff': { typeHrid: '/buff_types/cast_speed', flatBoost: 0.016 },
            '/buff_uniques/house_cast_speed': { typeHrid: '/buff_types/cast_speed', flatBoost: 0.03 },
            '/buff_uniques/labyrinth_crate_cast_speed': { typeHrid: '/buff_types/cast_speed', flatBoost: 0.15 },
            '/buff_uniques/labyrinth_upgrade_cast_speed': { typeHrid: '/buff_types/cast_speed', flatBoost: 0.12 },
            '/buff_uniques/attack_speed_guild_buff': { typeHrid: '/buff_types/attack_speed', ratioBoost: 0.016 },
            '/buff_uniques/house_attack_speed': { typeHrid: '/buff_types/attack_speed', ratioBoost: 0.03 },
            '/buff_uniques/labyrinth_crate_attack_speed': { typeHrid: '/buff_types/attack_speed', ratioBoost: 0.15 },
            '/buff_uniques/labyrinth_upgrade_attack_speed': { typeHrid: '/buff_types/attack_speed', ratioBoost: 0.12 },
        },
    };

    test('the real player capture’s flat totalCastSpeed is the raw stat plus attackLevel/2000 plus its cast-speed buffs', () => {
        // This is the arithmetic TIMING_ROWS's comment cites: not a rename, an
        // addition of three components, checked against the real numbers.
        const buffTotal = Object.values(REAL_PLAYER.combatBuffMap)
            .filter((b) => b.typeHrid === '/buff_types/cast_speed')
            .reduce((sum, b) => sum + b.flatBoost, 0);
        expect(buffTotal).toBeCloseTo(0.316, 6);
        const rebuilt = REAL_PLAYER.rawCastSpeed + REAL_PLAYER.attackLevel / 2000 + buffTotal;
        expect(rebuilt).toBeCloseTo(REAL_PLAYER.totalCastSpeed, 6);
    });

    /** Base (unscaled) monster data shaped like a real combatMonsterDetailMap entry. */
    function seed() {
        setGameData({
            abilityDetailMap: {},
            combatMonsterDetailMap: {
                [HRID]: {
                    enrageTime: 0,
                    experience: 100,
                    abilities: [],
                    combatDetails: {
                        staminaLevel: 100,
                        intelligenceLevel: 100,
                        // Base attack level 100, scaled by roomLevel/100 to 255 at
                        // room 255, matching REAL_MONSTER.attackLevel.
                        attackLevel: 100,
                        meleeLevel: 100,
                        defenseLevel: 100,
                        rangedLevel: 100,
                        magicLevel: 100,
                        attackInterval: REAL_MONSTER.rawAttackInterval,
                        combatStats: {
                            combatStyleHrids: ['/combat_styles/magic'],
                            attackInterval: 0, // 0 here means "seed from the flat base above"
                            armor: 200,
                            fireResistance: 500,
                            natureResistance: 500,
                            waterResistance: 100,
                        },
                    },
                },
            },
        });
    }

    afterEach(() => setGameData(null));

    test('the sim reproduces the real Pyre Hunter’s attack interval and cast speed from its base stats', () => {
        seed();
        const monster = new Monster(HRID, 0, ROOM_LEVEL, true);
        monster.updateCombatDetails();

        expect(monster.combatDetails.combatStats.attackInterval).toBeCloseTo(REAL_MONSTER.attackInterval, -3);
        expect(monster.combatDetails.combatStats.castSpeed).toBeCloseTo(REAL_MONSTER.totalCastSpeed, 4);
    });

    test('a monster comparison matches the real capture’s flat attack interval and cast speed, not a self-copy', () => {
        seed();
        const monster = new Monster(HRID, 0, ROOM_LEVEL, true);
        monster.updateCombatDetails();
        // The "game" side is the literal captured numbers, independent of
        // whatever the sim above computed — a genuine cross-check.
        const gameUnit = {
            isPlayer: false,
            combatBuffMap: {},
            combatDetails: {
                attackInterval: REAL_MONSTER.attackInterval,
                totalCastSpeed: REAL_MONSTER.totalCastSpeed,
                combatStats: { combatStyleHrids: ['/combat_styles/magic'] },
            },
        };

        const result = buildComparison(gameUnit, monster.combatDetails);
        const timing = result.groups.find((g) => g.group === 'Timing');
        const interval = timing.rows.find((r) => r.key === 'attackInterval');
        const castSpeed = timing.rows.find((r) => r.key === 'totalCastSpeed');

        expect(interval.verdict).toBe('match');
        expect(castSpeed.verdict).toBe('match');
        // No player-only row leaked into a monster comparison
        expect(timing.rows.some((r) => r.key === 'hpRegenPer10')).toBe(false);
        expect(result.hasMismatch).toBe(false);
    });

    test('a real gap in the monster’s attack interval is caught, not swallowed by the combatStats fallback', () => {
        seed();
        const monster = new Monster(HRID, 0, ROOM_LEVEL, true);
        monster.updateCombatDetails();
        const gameUnit = {
            isPlayer: false,
            combatBuffMap: {},
            combatDetails: {
                // The game reads 10% faster than the real capture — a genuine gap
                attackInterval: REAL_MONSTER.attackInterval * 0.9,
                totalCastSpeed: REAL_MONSTER.totalCastSpeed,
                combatStats: { combatStyleHrids: ['/combat_styles/magic'] },
            },
        };

        const result = buildComparison(gameUnit, monster.combatDetails);
        const interval = result.groups.find((g) => g.group === 'Timing').rows.find((r) => r.key === 'attackInterval');
        expect(interval.verdict).toBe('mismatch');
        expect(result.hasMismatch).toBe(true);
    });

    test('an unfolded player baseline reads the cast-speed/attack-interval gap as a buff, not a mismatch', () => {
        // The raw (unfolded) sim build carries only what a fresh, self-buff-free
        // player would have: attackLevel/2000 and nothing else. The real game
        // unit is fully buffed (cast_speed_guild_buff, attack_speed_guild_buff
        // and friends). This is the scenario the P1 report raised — every row
        // must read "buff", the same as every other row already does when live
        // buffs are up and the sim baseline lacks them, never "mismatch" — and,
        // for attack interval specifically, "buff" even though the real
        // (buffed) interval is the SMALLER number (see `lowerIsBetter` on the
        // `attackInterval` row and the `classify` tests above).
        const unbuffedSimDetails = {
            combatStats: {
                combatStyleHrids: ['/combat_styles/slash'],
                castSpeed: REAL_PLAYER.rawCastSpeed + REAL_PLAYER.attackLevel / 2000, // 0.125, no buffs folded
                attackInterval: REAL_PLAYER.rawAttackInterval / (1 + REAL_PLAYER.attackLevel / 2000), // no attack-speed buffs
                criticalRate: 0,
                criticalDamage: 0,
                hpRegenPer10: 0,
            },
        };
        const gameUnit = {
            isPlayer: true,
            combatBuffMap: REAL_PLAYER.combatBuffMap,
            combatDetails: {
                attackInterval: REAL_PLAYER.attackInterval,
                totalCastSpeed: REAL_PLAYER.totalCastSpeed,
                combatStats: { combatStyleHrids: ['/combat_styles/slash'] },
            },
        };

        const result = buildComparison(gameUnit, unbuffedSimDetails, { simBuffed: false });
        const timing = result.groups.find((g) => g.group === 'Timing');
        const castSpeed = timing.rows.find((r) => r.key === 'totalCastSpeed');
        const interval = timing.rows.find((r) => r.key === 'attackInterval');

        expect(castSpeed.verdict).toBe('buff');
        // The real attack-speed buffs shorten the interval below the unbuffed
        // baseline — the good direction for this row — and must read "buff",
        // not "debuff" (a plain higher-is-better read would get this backwards)
        // and not "mismatch" (there IS an effect explaining it).
        expect(interval.verdict).toBe('buff');
        expect(result.hasMismatch).toBe(false);
    });

    test('a folded player comparison matches the real capture on cast speed, attack interval, crit and regen', () => {
        // Once buffs are folded onto the sim (planBuffFold; cast_speed and
        // attack_speed are both in ENGINE_BUFF_TYPES), its combatStats carries
        // the same resolved totals the game reports flat — so the comparison
        // must read every timing/crit/regen row as a match, not a permanent gap.
        const foldedSimDetails = {
            combatStats: {
                combatStyleHrids: ['/combat_styles/slash'],
                castSpeed: REAL_PLAYER.totalCastSpeed,
                attackInterval: REAL_PLAYER.attackInterval,
                criticalRate: REAL_PLAYER.criticalRate,
                criticalDamage: REAL_PLAYER.criticalDamage,
                hpRegenPer10: REAL_PLAYER.hpRegenPer10,
            },
        };
        const playerUnit = {
            isPlayer: true,
            combatBuffMap: REAL_PLAYER.combatBuffMap,
            combatDetails: {
                attackInterval: REAL_PLAYER.attackInterval,
                totalCastSpeed: REAL_PLAYER.totalCastSpeed,
                combatStats: {
                    combatStyleHrids: ['/combat_styles/slash'],
                    criticalRate: REAL_PLAYER.criticalRate,
                    criticalDamage: REAL_PLAYER.criticalDamage,
                    hpRegenPer10: REAL_PLAYER.hpRegenPer10,
                },
            },
        };

        const result = buildComparison(playerUnit, foldedSimDetails, { simBuffed: true });
        const timing = result.groups.find((g) => g.group === 'Timing');
        for (const key of ['attackInterval', 'totalCastSpeed', 'criticalRate', 'criticalDamage', 'hpRegenPer10']) {
            expect(timing.rows.find((r) => r.key === key).verdict).toBe('match');
        }
        expect(result.hasMismatch).toBe(false);
    });
});

describe('planBuffFold — what the sim player is handed so both sides match', () => {
    // Guild damage (+3%) and the labyrinth combat-damage upgrade (+12%) are
    // persistent /buff_types/damage ratios: on you as the fight opens, and
    // already inside the sim's build. They must fold to nothing.
    const PERSISTENT = {
        '/buff_uniques/guild_damage': { typeHrid: '/buff_types/damage', ratioBoost: 0.03 },
        '/buff_uniques/labyrinth_combat_damage': { typeHrid: '/buff_types/damage', ratioBoost: 0.12 },
    };

    test('a buff cast during the fight folds by its full ratio', () => {
        const live = {
            ...PERSISTENT,
            '/buff_uniques/precision': { typeHrid: '/buff_types/accuracy', ratioBoost: 0.684 },
        };
        const plan = planBuffFold(live, { ...PERSISTENT });
        const accuracy = plan.buffs['/buff_uniques/toolasha_fold/accuracy'];
        expect(accuracy.ratioBoost).toBeCloseTo(0.684, 6);
        expect(accuracy.typeHrid).toBe('/buff_types/accuracy');
        expect(plan.folded).toEqual(['precision']);
        expect(plan.inBuild).toEqual(['guild damage', 'labyrinth combat damage']);
    });

    test('persistent ratios present at fight start are handed over as targets, named as already in the build', () => {
        // The plan no longer subtracts the start map: the totals are TARGETS
        // and the engine applies only the difference over what the sim player
        // already holds, so a persistent buff cannot be counted twice whether
        // or not a fight-start map was ever seen. The start map only refines
        // the naming.
        const plan = planBuffFold({ ...PERSISTENT }, { ...PERSISTENT });
        expect(plan.asTargets).toBe(true);
        expect(plan.folded).toEqual([]);
        expect(plan.inBuild.length).toBe(Object.keys(PERSISTENT).length);
        // Boosts of one type sum into one target, the way the engine sums them
        expect(plan.buffs['/buff_uniques/toolasha_fold/damage'].ratioBoost).toBeCloseTo(0.15, 6);
    });

    test('every stat group folds, not just offense', () => {
        const live = {
            '/buff_uniques/toughness': { typeHrid: '/buff_types/armor', ratioBoost: 0.5 },
            '/buff_uniques/elusiveness': { typeHrid: '/buff_types/evasion', ratioBoost: 0.27 },
            '/buff_uniques/vitality': { typeHrid: '/buff_types/max_hitpoints', ratioBoost: 0.1 },
            '/buff_uniques/aqua_shield': { typeHrid: '/buff_types/water_resistance', ratioBoost: 0.56 },
        };
        const plan = planBuffFold(live, {});
        expect(plan.buffs['/buff_uniques/toolasha_fold/armor'].ratioBoost).toBeCloseTo(0.5, 6);
        expect(plan.buffs['/buff_uniques/toolasha_fold/evasion'].ratioBoost).toBeCloseTo(0.27, 6);
        expect(plan.buffs['/buff_uniques/toolasha_fold/max_hitpoints'].ratioBoost).toBeCloseTo(0.1, 6);
        expect(plan.buffs['/buff_uniques/toolasha_fold/water_resistance'].ratioBoost).toBeCloseTo(0.56, 6);
    });

    test('boosts of one type sum, the way the engine sums them', () => {
        const live = {
            a: { typeHrid: '/buff_types/accuracy', ratioBoost: 0.3, flatBoost: 5 },
            b: { typeHrid: '/buff_types/accuracy', ratioBoost: 0.1, flatBoost: 2 },
        };
        const plan = planBuffFold(live, {});
        expect(plan.buffs['/buff_uniques/toolasha_fold/accuracy'].ratioBoost).toBeCloseTo(0.4, 6);
        expect(plan.buffs['/buff_uniques/toolasha_fold/accuracy'].flatBoost).toBeCloseTo(7, 6);
    });

    test('a buff that expired since fight start is simply absent from the targets', () => {
        // Nothing to hand over: the engine holds only permanent buffs, so an
        // expired transient is neither on you nor in the sim
        const start = { '/buff_uniques/opening_surge': { typeHrid: '/buff_types/accuracy', ratioBoost: 0.5 } };
        const plan = planBuffFold({}, start);
        expect(plan.buffs['/buff_uniques/toolasha_fold/accuracy']).toBeUndefined();
    });

    test('a stack that grew is handed over at its current size, and named as folded', () => {
        const start = { '/buff_uniques/stacking': { typeHrid: '/buff_types/damage', ratioBoost: 0.1 } };
        const live = { '/buff_uniques/stacking': { typeHrid: '/buff_types/damage', ratioBoost: 0.3 } };
        const plan = planBuffFold(live, start);
        expect(plan.buffs['/buff_uniques/toolasha_fold/damage'].ratioBoost).toBeCloseTo(0.3, 6);
        expect(plan.folded).toEqual(['stacking']);
    });

    test('a buff type the engine has no term for is named, never silently dropped', () => {
        const live = {
            '/buff_uniques/mystery_ward': { typeHrid: '/buff_types/mystery', ratioBoost: 0.9 },
            '/buff_uniques/precision': { typeHrid: '/buff_types/accuracy', ratioBoost: 0.5 },
        };
        const plan = planBuffFold(live, {});
        expect(plan.notModelled).toEqual(['mystery ward']);
        expect(plan.folded).toEqual(['precision']);
        expect(plan.buffs['/buff_uniques/toolasha_fold/mystery']).toBeUndefined();
    });

    test('without a fight-start map the whole live map folds, and it says so', () => {
        const plan = planBuffFold({ ...PERSISTENT });
        expect(plan.hasStartMap).toBe(false);
        expect(plan.buffs['/buff_uniques/toolasha_fold/damage'].ratioBoost).toBeCloseTo(0.15, 6);

        expect(planBuffFold({}, {}).hasStartMap).toBe(true);
    });

    test('no buffs at all plans nothing', () => {
        const plan = planBuffFold({}, {});
        expect(plan.buffs).toEqual({});
        expect(plan.folded).toEqual([]);
        expect(plan.notModelled).toEqual([]);
    });
});

describe('simPlayerLabel — which player the sim was built from', () => {
    test('a zone names the zone, its tier and the consumables', () => {
        expect(simPlayerLabel({ source: 'zone', zoneName: 'Twilight Zone', tier: 5 })).toBe(
            'Sim player: your current build · Twilight Zone (T5) · food & drinks on · zone buffs'
        );
    });

    test('the labyrinth names the loadout and what the lab adds and forbids', () => {
        expect(simPlayerLabel({ source: 'labyrinth', loadoutName: 'Lab magic' })).toBe(
            'Sim player: labyrinth setup · loadout Lab magic · lab token buffs · crates · no food/drink'
        );
    });

    test('a guild trial names the tier', () => {
        expect(simPlayerLabel({ source: 'trial', tier: 8 })).toBe('Sim player: your current build · Guild trial T8');
    });

    test('an unknown source produces nothing rather than a wrong claim', () => {
        expect(simPlayerLabel(null)).toBe('');
        expect(simPlayerLabel({})).toBe('');
    });
});

describe('combatEffectNames', () => {
    test('lists stat-moving combat effects, skips folded level buffs', () => {
        const names = combatEffectNames({
            '/buff_uniques/precision': { typeHrid: '/buff_types/accuracy', ratioBoost: 0.684 },
            '/buff_uniques/community_attack': { typeHrid: '/buff_types/attack_level', flatBoost: 5 },
        });
        expect(names).toEqual(['precision']);
    });
});

describe('buffedStatKeys', () => {
    test('maps a precision (accuracy) buff to the style accuracy row', () => {
        const keys = buffedStatKeys(
            { '/buff_uniques/precision': { typeHrid: '/buff_types/accuracy', ratioBoost: 0.684 } },
            'magic'
        );
        expect(keys.has('magicAccuracyRating')).toBe(true);
        expect(keys.has('magicMaxDamage')).toBe(false);
    });

    test('an empty or unmapped buff map yields no keys', () => {
        expect(buffedStatKeys({}, 'smash').size).toBe(0);
        expect(buffedStatKeys({ '/buff_uniques/x': { typeHrid: '/buff_types/mystery' } }, 'smash').size).toBe(0);
    });
});

describe('statRows', () => {
    test('offense rows follow the monster style', () => {
        const groups = statRows('magic');
        const offense = groups.find((g) => g.group === 'Offense');
        expect(offense.rows.map(([key]) => key)).toEqual(['magicAccuracyRating', 'magicMaxDamage']);
    });

    test('a monster gets the timing/crit rows but not the player-only regen row', () => {
        const timing = statRows('magic', 'monster').find((g) => g.group === 'Timing');
        expect(timing.rows.map(([key]) => key)).toEqual([
            'attackInterval',
            'totalCastSpeed',
            'criticalRate',
            'criticalDamage',
        ]);
    });

    test('a player also gets HP regen alongside the timing/crit rows', () => {
        const timing = statRows('magic', 'player').find((g) => g.group === 'Timing');
        expect(timing.rows.map(([key]) => key)).toEqual([
            'attackInterval',
            'totalCastSpeed',
            'criticalRate',
            'criticalDamage',
            'hpRegenPer10',
        ]);
    });

    test('defaults to the monster row set when no unit kind is given', () => {
        const timing = statRows('magic').find((g) => g.group === 'Timing');
        expect(timing.rows.some(([key]) => key === 'hpRegenPer10')).toBe(false);
    });
});

describe('flaggedRows', () => {
    const comparison = {
        groups: [
            {
                group: 'Mitigation',
                rows: [
                    { key: 'a', label: 'A', game: 100, sim: 100, deltaPct: 0, verdict: 'match' },
                    { key: 'b', label: 'B', game: 80, sim: 100, deltaPct: -20, verdict: 'debuff' },
                ],
            },
            {
                group: 'Offense',
                rows: [{ key: 'c', label: 'C', game: 150, sim: 100, deltaPct: 50, verdict: 'mismatch' }],
            },
        ],
    };

    test('keeps buff/debuff/mismatch rows and drops matches', () => {
        const rows = flaggedRows(comparison);
        expect(rows.map((r) => r.key)).toEqual(['b', 'c']);
        expect(rows[0]).toMatchObject({ group: 'Mitigation', stat: 'B', verdict: 'debuff' });
        expect(rows[1]).toMatchObject({ group: 'Offense', stat: 'C', verdict: 'mismatch' });
    });

    test('empty for an all-match comparison', () => {
        expect(flaggedRows({ groups: [{ group: 'x', rows: [{ verdict: 'match' }, { verdict: 'unknown' }] }] })).toEqual(
            []
        );
        expect(flaggedRows(null)).toEqual([]);
    });
});

describe('buffName', () => {
    test('strips the path and underscores', () => {
        expect(buffName('/buff_uniques/pestilent_shot_armor')).toBe('pestilent shot armor');
        expect(buffName(null)).toBe('');
    });
});

describe('buffSignature', () => {
    test('order-independent, so the same effect set shares a signature', () => {
        const a = buffSignature({ '/buff_uniques/toughness': {}, '/buff_uniques/curse': {} });
        const b = buffSignature({ '/buff_uniques/curse': {}, '/buff_uniques/toughness': {} });
        expect(a).toBe(b);
    });

    test('a different effect set is a different signature; empty is stable', () => {
        expect(buffSignature({ '/buff_uniques/toughness': {} })).not.toBe(
            buffSignature({ '/buff_uniques/toughness': {}, '/buff_uniques/curse': {} })
        );
        expect(buffSignature({})).toBe('');
        expect(buffSignature(null)).toBe('');
    });
});

describe('compareBuffProduction', () => {
    const gameMap = {
        '/buff_uniques/pestilent_shot_armor': { typeHrid: '/buff_types/armor', ratioBoost: -0.199, flatBoost: 0 },
        '/buff_uniques/toughness': { typeHrid: '/buff_types/armor', ratioBoost: 0.452, flatBoost: 45.2 },
        '/buff_uniques/curse': { typeHrid: '/buff_types/damage_taken', ratioBoost: 0, flatBoost: 0.044 },
    };

    test('matches an effect the sim reproduces at the same strength', () => {
        const produced = [
            {
                uniqueHrid: '/buff_uniques/pestilent_shot_armor',
                typeHrid: '/buff_types/armor',
                ratioBoost: -0.2,
                flatBoost: 0,
            },
        ];
        const rows = compareBuffProduction(
            { '/buff_uniques/pestilent_shot_armor': gameMap['/buff_uniques/pestilent_shot_armor'] },
            produced
        );
        expect(rows[0].verdict).toBe('match');
    });

    test('flags an effect the sim never produced as missing', () => {
        const rows = compareBuffProduction(gameMap, []); // sim produced nothing
        expect(rows.every((r) => r.verdict === 'missing')).toBe(true);
    });

    test('flags a magnitude gap when the sim produces it too weak or strong', () => {
        const produced = [
            {
                uniqueHrid: '/buff_uniques/pestilent_shot_armor',
                typeHrid: '/buff_types/armor',
                ratioBoost: -0.3,
                flatBoost: 0,
            },
        ];
        const rows = compareBuffProduction(
            { '/buff_uniques/pestilent_shot_armor': gameMap['/buff_uniques/pestilent_shot_armor'] },
            produced
        );
        expect(rows[0].verdict).toBe('magnitude');
        expect(Math.abs(rows[0].deltaPct)).toBeGreaterThan(40);
    });

    test('a sim-only effect is notInSnapshot — timing, not a defect', () => {
        // The game column is one clicked instant; an effect the sim produces
        // that was between applications at that instant is not evidence of a
        // modelling gap and must not grade as one.
        const produced = [
            { uniqueHrid: '/buff_uniques/elusiveness', typeHrid: '/buff_types/evasion', ratioBoost: 0.5, flatBoost: 0 },
        ];
        const rows = compareBuffProduction({}, produced);
        expect(rows[0].verdict).toBe('notInSnapshot');
    });

    test('an integer multiple of the single-stack strength is stacks, not magnitude', () => {
        const game = { '/buff_uniques/enrage': { typeHrid: '/buff_types/damage', ratioBoost: 0.3, flatBoost: 0 } };
        const produced = [
            { uniqueHrid: '/buff_uniques/enrage', typeHrid: '/buff_types/damage', ratioBoost: 0.1, flatBoost: 0 },
        ];
        const rows = compareBuffProduction(game, produced);
        expect(rows[0].verdict).toBe('stacks');
        expect(rows[0].stackMultiple).toBe(3);
    });

    test('the stack multiple reads either direction, and on the flat boost too', () => {
        // Sim's peak at 2× the game's snapshot: the game was mid-stack when clicked
        const game = {
            '/buff_uniques/curse': { typeHrid: '/buff_types/damage_taken', ratioBoost: 0, flatBoost: 0.05 },
        };
        const produced = [
            { uniqueHrid: '/buff_uniques/curse', typeHrid: '/buff_types/damage_taken', ratioBoost: 0, flatBoost: 0.1 },
        ];
        const rows = compareBuffProduction(game, produced);
        expect(rows[0].verdict).toBe('stacks');
        expect(rows[0].stackMultiple).toBe(2);
    });

    test('a non-integer strength gap stays magnitude', () => {
        const game = { '/buff_uniques/aura': { typeHrid: '/buff_types/armor', ratioBoost: 0.25, flatBoost: 0 } };
        const produced = [
            { uniqueHrid: '/buff_uniques/aura', typeHrid: '/buff_types/armor', ratioBoost: 0.1, flatBoost: 0 },
        ];
        const rows = compareBuffProduction(game, produced);
        expect(rows[0].verdict).toBe('magnitude');
        expect(rows[0].stackMultiple).toBeNull();
    });

    test('opposite signs never read as stacks', () => {
        const game = { '/buff_uniques/shred': { typeHrid: '/buff_types/armor', ratioBoost: -0.2, flatBoost: 0 } };
        const produced = [
            { uniqueHrid: '/buff_uniques/shred', typeHrid: '/buff_types/armor', ratioBoost: 0.1, flatBoost: 0 },
        ];
        expect(compareBuffProduction(game, produced)[0].verdict).toBe('magnitude');
    });

    test('uses the flat boost when the effect has no ratio (curse)', () => {
        const produced = [
            {
                uniqueHrid: '/buff_uniques/curse',
                typeHrid: '/buff_types/damage_taken',
                ratioBoost: 0,
                flatBoost: 0.044,
            },
        ];
        const rows = compareBuffProduction({ '/buff_uniques/curse': gameMap['/buff_uniques/curse'] }, produced);
        expect(rows[0].verdict).toBe('match');
    });

    test('orders problems (missing/magnitude) before matches', () => {
        const produced = [
            {
                uniqueHrid: '/buff_uniques/toughness',
                typeHrid: '/buff_types/armor',
                ratioBoost: 0.452,
                flatBoost: 45.2,
            },
            {
                uniqueHrid: '/buff_uniques/curse',
                typeHrid: '/buff_types/damage_taken',
                ratioBoost: 0,
                flatBoost: 0.044,
            },
            // pestilent_shot_armor is in the game map but NOT produced → missing, should sort first
        ];
        const rows = compareBuffProduction(gameMap, produced);
        expect(rows[0].verdict).toBe('missing');
        expect(rows[0].name).toBe('pestilent shot armor');
    });
});

describe('unionProducedBuffs', () => {
    test('unions effects across runs so one quiet run cannot erase an effect', () => {
        const runA = [{ uniqueHrid: '/buff_uniques/toughness', typeHrid: '/buff_types/armor', ratioBoost: 0.4 }];
        const runB = [{ uniqueHrid: '/buff_uniques/haste', typeHrid: '/buff_types/attack_speed', ratioBoost: 0.1 }];
        const union = unionProducedBuffs([runA, runB]);
        expect(union.map((r) => r.uniqueHrid).sort()).toEqual(['/buff_uniques/haste', '/buff_uniques/toughness']);
    });

    test('keeps the peak signed magnitude per effect, per boost field', () => {
        const union = unionProducedBuffs([
            [{ uniqueHrid: '/buff_uniques/shred', typeHrid: '/buff_types/armor', ratioBoost: -0.2, flatBoost: 0 }],
            [{ uniqueHrid: '/buff_uniques/shred', typeHrid: '/buff_types/armor', ratioBoost: -0.35, flatBoost: 0 }],
        ]);
        expect(union).toHaveLength(1);
        expect(union[0].ratioBoost).toBeCloseTo(-0.35, 6);
    });

    test('tolerates empty and malformed runs', () => {
        expect(unionProducedBuffs(null)).toEqual([]);
        expect(unionProducedBuffs([[], null, [{ typeHrid: '/x' }]])).toEqual([]);
    });
});

describe('captureContextMismatches', () => {
    const CURRENT = { monsterHrid: '/monsters/cyclops', roomLevel: 206, fingerprint: 'fp-now' };

    test('a fully matching context is usable', () => {
        expect(
            captureContextMismatches(
                { monsterHrid: '/monsters/cyclops', roomLevel: 206, fingerprint: 'fp-now' },
                CURRENT
            )
        ).toEqual([]);
    });

    test('names every field that differs', () => {
        expect(
            captureContextMismatches({ monsterHrid: '/monsters/dryad', roomLevel: 300, fingerprint: 'fp-old' }, CURRENT)
        ).toEqual(['monster', 'room level', 'build']);
    });

    test('a build change alone is named as build', () => {
        expect(
            captureContextMismatches(
                { monsterHrid: '/monsters/cyclops', roomLevel: 206, fingerprint: 'fp-old' },
                CURRENT
            )
        ).toEqual(['build']);
    });

    test('a fingerprint missing on either side passes — absence is not a mismatch', () => {
        expect(captureContextMismatches({ monsterHrid: '/monsters/cyclops', roomLevel: 206 }, CURRENT)).toEqual([]);
        expect(
            captureContextMismatches(
                { monsterHrid: '/monsters/cyclops', roomLevel: 206, fingerprint: 'fp-old' },
                { ...CURRENT, fingerprint: null }
            )
        ).toEqual([]);
    });

    test('an unlabelled capture (no context at all) passes', () => {
        expect(captureContextMismatches(null, CURRENT)).toEqual([]);
    });
});

describe('buildExportPayload', () => {
    test('wraps entries and the current snapshot with a fixed clock', () => {
        const payload = buildExportPayload([{ monsterHrid: '/monsters/x' }], { name: 'X' }, 1234);
        expect(payload).toMatchObject({
            format: 'toolasha-monster-stat-check',
            version: 1,
            exportedAt: 1234,
            current: { name: 'X' },
            entries: [{ monsterHrid: '/monsters/x' }],
        });
    });

    test('carries the player build when one is supplied', () => {
        const playerBuild = { hasMismatch: true, groups: [], playerBuffMap: {} };
        const payload = buildExportPayload([], null, 1, playerBuild);
        expect(payload.playerBuild).toBe(playerBuild);
    });

    test('tolerates missing inputs', () => {
        const payload = buildExportPayload(null, null, 0);
        expect(payload.entries).toEqual([]);
        expect(payload.current).toBeNull();
        expect(payload.playerBuild).toBeNull();
    });
});
