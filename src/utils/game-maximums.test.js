import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ clientData: null, throws: false }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => {
            if (state.throws) throw new Error('not ready');
            return state.clientData;
        },
    },
}));

import {
    FALLBACK_MAX_ENHANCEMENT_LEVEL,
    FALLBACK_MAX_GUILD_BUILDING_LEVEL,
    FALLBACK_MAX_GUILD_SHRINE_LEVEL,
    FALLBACK_MAX_HOUSE_ROOM_LEVEL,
    FALLBACK_MAX_LEVEL,
    maxEnhancementLevel,
    maxGuildBuildingLevel,
    maxGuildShrineLevel,
    maxHouseRoomLevel,
    maxLevel,
} from './game-maximums.js';
import { normalizeGoal } from '../features/planner/goal-planner.js';
import { getLevelFromExp } from '../features/combat-sim-integration/skill-calculator-logic.js';
import { clampAbilityLevel, clampSwapLevel } from '../features/combat-sim/lab-swap-check.js';

const table = (length) => Array.from({ length }, (_, i) => i * 10);

beforeEach(() => {
    state.clientData = null;
    state.throws = false;
});

describe('table-backed maximums', () => {
    test.each([
        ['maxLevel', maxLevel, 'levelExperienceTable', FALLBACK_MAX_LEVEL, 201],
        [
            'maxEnhancementLevel',
            maxEnhancementLevel,
            'enhancementLevelTotalBonusMultiplierTable',
            FALLBACK_MAX_ENHANCEMENT_LEVEL,
            21,
        ],
    ])('%s reads the table, and falls back on anything unusable', (_name, read, key, fallback, liveLength) => {
        // Game data not loaded yet
        expect(read()).toBe(fallback);
        state.clientData = {};
        expect(read()).toBe(fallback);
        // Empty, one-slot, junk and partial tables never produce 0, -1 or NaN
        for (const junk of [[], [0], null, undefined, 'abc', 5, {}, { length: 400 }, table(3)]) {
            state.clientData = { [key]: junk };
            expect(read()).toBe(fallback);
        }
        // The live shape, and a patch that raises the cap by 50 or 1
        state.clientData = { [key]: table(liveLength) };
        expect(read()).toBe(fallback);
        state.clientData = { [key]: table(liveLength + 50) };
        expect(read()).toBe(fallback + 50);
        state.clientData = { [key]: table(liveLength + 1) };
        expect(read()).toBe(fallback + 1);
    });

    test('an explicit game data argument wins over the data manager, and null reads as not loaded', () => {
        state.clientData = { levelExperienceTable: table(300) };
        expect(maxLevel({ levelExperienceTable: table(251) })).toBe(250);
        expect(maxLevel(null)).toBe(FALLBACK_MAX_LEVEL);
        expect(maxLevel()).toBe(299);
    });

    test('a data manager that throws reads as not loaded', () => {
        state.throws = true;
        expect(maxLevel()).toBe(FALLBACK_MAX_LEVEL);
        expect(maxEnhancementLevel()).toBe(FALLBACK_MAX_ENHANCEMENT_LEVEL);
        expect(maxHouseRoomLevel()).toBe(FALLBACK_MAX_HOUSE_ROOM_LEVEL);
    });
});

describe('detail-map maximums', () => {
    test.each([
        ['maxGuildBuildingLevel', maxGuildBuildingLevel, 'guildBuildingDetailMap', FALLBACK_MAX_GUILD_BUILDING_LEVEL],
        ['maxGuildShrineLevel', maxGuildShrineLevel, 'guildShrineDetailMap', FALLBACK_MAX_GUILD_SHRINE_LEVEL],
    ])('%s reads the highest maxLevel and falls back on anything unusable', (_name, read, key, fallback) => {
        expect(read()).toBe(fallback);
        for (const junk of [
            null,
            [],
            {},
            'x',
            { a: null },
            { a: {} },
            { a: { maxLevel: 0 } },
            { a: { maxLevel: -4 } },
            { a: { maxLevel: 'abc' } },
            { a: { maxLevel: NaN } },
        ]) {
            state.clientData = { [key]: junk };
            expect(read()).toBe(fallback);
        }
        state.clientData = { [key]: { a: { maxLevel: 20 }, b: { maxLevel: 20 } } };
        expect(read()).toBe(20);
        state.clientData = { [key]: { a: { maxLevel: 25 }, b: { maxLevel: 20 }, c: {} } };
        expect(read()).toBe(25);
    });
});

describe('maxHouseRoomLevel', () => {
    const rooms = (...levels) => ({
        houseRoomDetailMap: {
            '/house_rooms/dojo': { upgradeCostsMap: Object.fromEntries(levels.map((level) => [level, []])) },
        },
    });

    test('falls back without room data, and takes the top of the upgrade-cost ladder when it is higher', () => {
        expect(maxHouseRoomLevel()).toBe(8);
        for (const junk of [
            null,
            [],
            {},
            { a: null },
            { a: { upgradeCostsMap: null } },
            { a: { upgradeCostsMap: { x: 1 } } },
        ]) {
            state.clientData = { houseRoomDetailMap: junk };
            expect(maxHouseRoomLevel()).toBe(8);
        }
        state.clientData = rooms(1, 2, 3, 4, 5, 6, 7, 8);
        expect(maxHouseRoomLevel()).toBe(8);
        state.clientData = rooms(1, 2, 3, 9, 10);
        expect(maxHouseRoomLevel()).toBe(10);
    });
});

describe('a raised cap reaches a real reader in each group', () => {
    test("level: the skill calculator climbs past 200, and stops at 200 on today's table", () => {
        expect(getLevelFromExp(1e9, table(201))).toBe(200);
        expect(getLevelFromExp(1e9, table(251))).toBe(250);
    });

    test('level and enhancement: swap clamps follow the tables', () => {
        expect(clampAbilityLevel(999)).toBe(200);
        expect(clampSwapLevel(999)).toBe(20);
        state.clientData = {
            levelExperienceTable: table(251),
            enhancementLevelTotalBonusMultiplierTable: table(26),
        };
        expect(clampAbilityLevel(999)).toBe(250);
        expect(clampSwapLevel(999)).toBe(25);
        expect(clampAbilityLevel(150)).toBe(150);
    });

    test("goal planner: a saved level is only clamped at the live cap, and a saved value at today's cap is untouched", () => {
        const goal = (type, extra) => normalizeGoal({ type, ...extra });
        const live = () => ({
            skill: goal('skill', { skillHrid: '/skills/milking', targetLevel: 230 })?.targetLevel,
            enh: goal('equipment', { itemHrid: '/items/x', enhancementLevel: 23 })?.enhancementLevel,
            house: goal('house', { roomHrid: '/house_rooms/dojo', targetLevel: 9 })?.targetLevel,
        });
        // Data not loaded: the old constants, exactly
        expect(live()).toEqual({ skill: 200, enh: 20, house: 8 });
        state.clientData = {
            levelExperienceTable: table(251),
            enhancementLevelTotalBonusMultiplierTable: table(26),
            houseRoomDetailMap: { '/house_rooms/dojo': { upgradeCostsMap: { 9: [], 10: [] } } },
        };
        expect(live()).toEqual({ skill: 230, enh: 23, house: 9 });
        // A value within today's caps is the same either way
        expect(goal('skill', { skillHrid: '/skills/milking', targetLevel: 120 }).targetLevel).toBe(120);
    });
});
