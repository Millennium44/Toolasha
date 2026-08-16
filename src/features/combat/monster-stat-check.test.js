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
    offenseRatioBoosts,
    foldOffenseBuffs,
    combatEffectNames,
    flaggedRows,
    buildExportPayload,
    buffName,
    compareBuffProduction,
    buffSignature,
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

describe('foldOffenseBuffs — the sim column carries your live offense buffs', () => {
    test('precision folds accuracy by its ratio, matching your live rating', () => {
        const sim = { smashAccuracyRating: 507, smashMaxDamage: 380 };
        const buffs = { '/buff_uniques/precision': { typeHrid: '/buff_types/accuracy', ratioBoost: 0.684 } };
        const out = foldOffenseBuffs(sim, buffs, 'smash');
        expect(out.smashAccuracyRating).toBeCloseTo(507 * 1.684, 5); // ≈ 853, your live value
        expect(out.smashMaxDamage).toBe(380); // untouched
    });

    test('a monster damage shred folds max hit down', () => {
        const sim = { smashAccuracyRating: 507, smashMaxDamage: 380 };
        const buffs = { '/buff_uniques/crippling': { typeHrid: '/buff_types/damage', ratioBoost: -0.234 } };
        const out = foldOffenseBuffs(sim, buffs, 'smash');
        expect(out.smashMaxDamage).toBeCloseTo(380 * 0.766, 5); // ≈ 291
    });

    test('accuracy and fury-accuracy multiply, matching the engine formula', () => {
        const sim = { magicAccuracyRating: 100, magicMaxDamage: 50 };
        const buffs = {
            '/buff_uniques/precision': { typeHrid: '/buff_types/accuracy', ratioBoost: 0.5 },
            '/buff_uniques/fury': { typeHrid: '/buff_types/fury_accuracy', ratioBoost: 0.2 },
        };
        const out = foldOffenseBuffs(sim, buffs, 'magic');
        expect(out.magicAccuracyRating).toBeCloseTo(100 * 1.5 * 1.2, 5);
    });

    test('no offense buffs returns the sim details unchanged (same object)', () => {
        const sim = { smashAccuracyRating: 507, smashMaxDamage: 380 };
        expect(foldOffenseBuffs(sim, { '/b': { typeHrid: '/buff_types/armor', ratioBoost: 0.1 } }, 'smash')).toBe(sim);
        expect(foldOffenseBuffs(sim, {}, 'smash')).toBe(sim);
    });
});

describe('offenseRatioBoosts', () => {
    test('sums each offense boost into its own bucket', () => {
        const b = offenseRatioBoosts({
            a: { typeHrid: '/buff_types/accuracy', ratioBoost: 0.3 },
            b: { typeHrid: '/buff_types/accuracy', ratioBoost: 0.1 },
            c: { typeHrid: '/buff_types/damage', ratioBoost: -0.2 },
            d: { typeHrid: '/buff_types/max_hitpoints', ratioBoost: 0.02 },
        });
        expect(b.accuracy).toBeCloseTo(0.4, 5);
        expect(b.damage).toBeCloseTo(-0.2, 5);
        expect(b.furyAccuracy).toBe(0);
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

    test('flags a sim-only effect as extra', () => {
        const produced = [
            { uniqueHrid: '/buff_uniques/elusiveness', typeHrid: '/buff_types/evasion', ratioBoost: 0.5, flatBoost: 0 },
        ];
        const rows = compareBuffProduction({}, produced);
        expect(rows[0].verdict).toBe('extra');
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
