/**
 * The gear stats check, against the game's real enhancement table and real items.
 *
 * What decides whether anybody keeps reading its warning is that a healthy client is silent, so most of
 * these are endings that must say nothing: a match, game figures that include extra sources, missing
 * data, an empty wardrobe, a character already compared. The one that must speak is the 3.76.0 bug.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ENHANCEMENT_TABLE, FIXTURE_ITEMS, FIXTURE_LOCATIONS } from '../__fixtures__/wire/enhancement-scaling.js';

const game = vi.hoisted(() => ({
    clientData: null,
    equipment: new Map(),
    characterData: null,
    characterId: 1,
    switching: false,
}));

vi.mock('./data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
        getEquipment: () => new Map(game.equipment),
        getCurrentCharacterId: () => game.characterId,
        getHouseRooms: () => new Map(),
        get characterData() {
            return game.characterData;
        },
        get isCharacterSwitching() {
            return game.switching;
        },
    },
}));

const { compareGearStats, runGearStatsCheck, _resetGearStatsCheck } = await import('./gear-stats-check.js');

/** Worn gear: forager's top, shears and cape at the given levels, the necklace and pouch at +10 */
function wear(level) {
    const worn = new Map();
    for (const hrid of Object.keys(FIXTURE_ITEMS)) {
        const location = FIXTURE_LOCATIONS[hrid];
        worn.set(location, { itemHrid: hrid, itemLocationHrid: location, enhancementLevel: level });
    }
    return worn;
}

/** The game's rule, written out for the fixture items at one level */
function gameStatsAt(level) {
    const t = ENHANCEMENT_TABLE[level];
    return {
        skillingEfficiency: 0.02 + t * 0.002,
        skillingSpeed: 0.04 + t * 0.004,
        foragingEfficiency: 0.1 + t * 0.002,
        foragingSpeed: 1.05 + t * 0.021 + 0.058 + t * 0.0058,
        woodcuttingEfficiency: 0,
        woodcuttingSpeed: 0,
        drinkConcentration: 0.1 + t * 0.002,
    };
}

beforeEach(() => {
    _resetGearStatsCheck();
    game.clientData = { itemDetailMap: FIXTURE_ITEMS, enhancementLevelTotalBonusMultiplierTable: ENHANCEMENT_TABLE };
    game.equipment = wear(10);
    game.characterData = { noncombatStats: gameStatsAt(10) };
    game.characterId = 1;
    game.switching = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('a healthy client is silent', () => {
    test('match: the parser agrees with the game at every level', () => {
        for (let level = 0; level <= 20; level++) {
            const { compared, mismatches } = compareGearStats(wear(level), FIXTURE_ITEMS, gameStatsAt(level));
            expect(compared).toBeGreaterThan(0);
            expect(mismatches).toEqual([]);
        }
        expect(runGearStatsCheck()).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test('+0 gear matches too', () => {
        game.equipment = wear(0);
        game.characterData = { noncombatStats: gameStatsAt(0) };
        expect(runGearStatsCheck()).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test('game figures that include buffs the parser never sees do not alarm', () => {
        game.characterData = {
            noncombatStats: {
                ...gameStatsAt(10),
                foragingEfficiency: gameStatsAt(10).foragingEfficiency + 0.25,
                foragingSpeed: gameStatsAt(10).foragingSpeed + 0.3,
                drinkConcentration: gameStatsAt(10).drinkConcentration + 0.05,
            },
        };
        expect(runGearStatsCheck()).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test('rounding in the game figure is tolerated', () => {
        const stats = { ...gameStatsAt(10) };
        stats.foragingEfficiency -= 0.004;
        stats.drinkConcentration -= 0.003;
        expect(compareGearStats(wear(10), FIXTURE_ITEMS, stats).mismatches).toEqual([]);
    });
});

describe('the 3.76.0 bug is the one thing that speaks', () => {
    test('a figure above the game by more than rounding is reported, naming the stat and both figures', () => {
        game.characterData = { noncombatStats: { ...gameStatsAt(10), foragingEfficiency: 0.1 } };
        const mismatches = runGearStatsCheck();
        expect(mismatches.map((m) => m.stat)).toEqual([expect.stringContaining('foragingEfficiency')]);
        expect(mismatches[0].game).toBeCloseTo(0.149, 10);
        expect(console.warn).toHaveBeenCalledTimes(1);
        const text = console.warn.mock.calls[0][0];
        expect(text).toContain('foragingEfficiency');
        expect(text).toContain('0.1490');
    });

    test('the table read as a fraction (every figure 50x at +20) is reported', () => {
        // Game says the real +20 stats; a parser that did not divide the table by 50 would be far above them
        const real = gameStatsAt(20);
        const inflated = { ...real };
        for (const key of Object.keys(inflated)) inflated[key] = inflated[key] / 20;
        const { mismatches } = compareGearStats(wear(20), FIXTURE_ITEMS, inflated);
        expect(mismatches.length).toBeGreaterThan(0);
    });

    test('drink concentration alone is compared against getDrinkConcentration', () => {
        game.characterData = { noncombatStats: { drinkConcentration: 0.1 } };
        const mismatches = runGearStatsCheck();
        expect(mismatches.map((m) => m.stat)).toEqual(['drinkConcentration']);
    });
});

describe('missing data is no comparison', () => {
    test('no noncombatStats', () => {
        game.characterData = {};
        expect(runGearStatsCheck()).toEqual([]);
        game.characterData = null;
        expect(runGearStatsCheck()).toEqual([]);
        game.characterData = { noncombatStats: {} };
        expect(runGearStatsCheck()).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test('empty equipment', () => {
        game.equipment = new Map();
        expect(compareGearStats(game.equipment, FIXTURE_ITEMS, gameStatsAt(10))).toEqual({
            compared: 0,
            mismatches: [],
        });
        expect(runGearStatsCheck()).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test('item map not loaded', () => {
        game.clientData = null;
        expect(runGearStatsCheck()).toEqual([]);
        game.clientData = {};
        expect(runGearStatsCheck()).toEqual([]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test('a stat the game did not send is not compared', () => {
        const { compared } = compareGearStats(wear(10), FIXTURE_ITEMS, { drinkConcentration: 0.129 });
        expect(compared).toBe(1);
    });

    test('data that arrives late is still checked: nothing compared marks nothing done', () => {
        game.characterData = null;
        expect(runGearStatsCheck()).toEqual([]);
        game.characterData = { noncombatStats: { ...gameStatsAt(10), drinkConcentration: 0.01 } };
        expect(runGearStatsCheck()).toHaveLength(1);
    });
});

describe('once per character', () => {
    test('a second call for the same character does nothing, even if the figures now differ', () => {
        game.characterData = { noncombatStats: { ...gameStatsAt(10), drinkConcentration: 0.01 } };
        expect(runGearStatsCheck()).toHaveLength(1);
        expect(runGearStatsCheck()).toEqual([]);
        expect(console.warn).toHaveBeenCalledTimes(1);
    });

    test('a different character is checked on its own', () => {
        game.characterData = { noncombatStats: { ...gameStatsAt(10), drinkConcentration: 0.01 } };
        expect(runGearStatsCheck()).toHaveLength(1);
        game.characterId = 2;
        expect(runGearStatsCheck()).toHaveLength(1);
        expect(console.warn).toHaveBeenCalledTimes(2);
    });

    test('a switch under way compares nothing and marks nothing', () => {
        game.characterData = { noncombatStats: { ...gameStatsAt(10), drinkConcentration: 0.01 } };
        game.switching = true;
        expect(runGearStatsCheck()).toEqual([]);
        game.switching = false;
        expect(runGearStatsCheck()).toHaveLength(1);
    });

    test('no character id compares nothing', () => {
        game.characterId = null;
        expect(runGearStatsCheck()).toEqual([]);
    });
});

describe('it can never throw into startup', () => {
    test('malformed equipment and stats are swallowed', () => {
        game.equipment = new Map([['/item_locations/body', null]]);
        expect(() => runGearStatsCheck()).not.toThrow();
        game.characterData = { noncombatStats: 'oops' };
        expect(() => runGearStatsCheck()).not.toThrow();
    });
});
