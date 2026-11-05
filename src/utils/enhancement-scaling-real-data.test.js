/**
 * Enhancement scaling against the game's real table and real items.
 *
 * The fixture (`src/__fixtures__/wire/enhancement-scaling.js`) is read off the test server. The game's
 * rule is `base + table[level] * noncombatEnhancementBonuses[stat]`; every reader here has to land on it
 * at every level. A reader that treats the table as a fraction (3.76.0) is off by 50x at +20 and fails.
 */

import { describe, test, expect, vi } from 'vitest';
import {
    ENHANCEMENT_TABLE,
    FIXTURE_ITEMS,
    READ_OFF_AT_PLUS_10,
    wornOnly,
} from '../__fixtures__/wire/enhancement-scaling.js';

const game = vi.hoisted(() => ({ clientData: null }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
        getHouseRooms: () => new Map(),
    },
}));

const { parseEquipmentEfficiencyBonuses, parseEquipmentSpeedBonuses, parseRareFindBonus } =
    await import('./equipment-parser.js');
const { getDrinkConcentration } = await import('./tea-parser.js');
const { parseEquipmentWisdom, parseCharmExperience } = await import('./experience-parser.js');
const { getEnhancementMultiplier } = await import('./enhancement-multipliers.js');

game.clientData = { enhancementLevelTotalBonusMultiplierTable: ENHANCEMENT_TABLE, itemDetailMap: FIXTURE_ITEMS };

const LEVELS = Array.from({ length: 20 }, (_, i) => i + 1);
const FORAGING = '/action_types/foraging';

/** The game's own rule */
function expected(itemHrid, stat, level) {
    const { noncombatStats, noncombatEnhancementBonuses } = FIXTURE_ITEMS[itemHrid].equipmentDetail;
    return noncombatStats[stat] + ENHANCEMENT_TABLE[level] * noncombatEnhancementBonuses[stat];
}

/** How each fixture stat is read by the code, as a fraction */
const READERS = {
    foragingEfficiency: (worn) => parseEquipmentEfficiencyBonuses(worn, FORAGING, FIXTURE_ITEMS) / 100,
    skillingEfficiency: (worn) => parseEquipmentEfficiencyBonuses(worn, '/action_types/none', FIXTURE_ITEMS) / 100,
    foragingSpeed: (worn) => parseEquipmentSpeedBonuses(worn, FORAGING, FIXTURE_ITEMS),
    skillingSpeed: (worn) => parseEquipmentSpeedBonuses(worn, '/action_types/none', FIXTURE_ITEMS),
    foragingRareFind: (worn) => parseRareFindBonus(worn, FORAGING, FIXTURE_ITEMS) / 100,
    skillingExperience: (worn) => parseEquipmentWisdom(worn, FIXTURE_ITEMS).total / 100,
    foragingExperience: (worn) => parseCharmExperience(worn, '/skills/foraging', FIXTURE_ITEMS).total / 100,
    drinkConcentration: (worn) => getDrinkConcentration(worn, FIXTURE_ITEMS),
};

describe('the real table', () => {
    test('is the stepped shape: +10 reads 14.5 and +20 reads 50, not a fraction', () => {
        expect(ENHANCEMENT_TABLE).toHaveLength(21);
        expect(ENHANCEMENT_TABLE[10]).toBe(14.5);
        expect(ENHANCEMENT_TABLE[20]).toBe(50);
    });

    test('the derived bonuses reproduce the totals read off the page at +10', () => {
        for (const [hrid, stats] of Object.entries(READ_OFF_AT_PLUS_10)) {
            for (const [stat, total] of Object.entries(stats)) {
                expect(expected(hrid, stat, 10)).toBeCloseTo(total, 4);
            }
        }
    });
});

describe('every fixture stat scales as base + table[level] * bonus at every level', () => {
    for (const [hrid, item] of Object.entries(FIXTURE_ITEMS)) {
        for (const stat of Object.keys(item.equipmentDetail.noncombatStats)) {
            const read = READERS[stat];
            if (!read) continue; // the next test fails on any stat left without a reader

            test(`${hrid.split('/').pop()} ${stat}`, () => {
                expect(read(wornOnly(hrid, 0))).toBeCloseTo(expected(hrid, stat, 0), 10);
                for (const level of LEVELS) {
                    expect(read(wornOnly(hrid, level))).toBeCloseTo(expected(hrid, stat, level), 8);
                }
            });
        }
    }

    test('every stat on every fixture item has a reader', () => {
        const unread = [];
        for (const [hrid, item] of Object.entries(FIXTURE_ITEMS)) {
            for (const stat of Object.keys(item.equipmentDetail.noncombatStats)) {
                if (!READERS[stat]) unread.push(`${hrid} ${stat}`);
            }
        }
        expect(unread).toEqual([]);
    });
});

describe('the slot multiplier is in the bonus, once', () => {
    test('getEnhancementMultiplier matches the game for a 5x slot and a 1x slot at +20', () => {
        // neck: 0.02 * 5 * 0.02 = 0.002 per step; +20 doubles nothing but 1 + 50/50 * 5 = 6
        expect(getEnhancementMultiplier(FIXTURE_ITEMS['/items/philosophers_necklace'], 20)).toBeCloseTo(6, 10);
        expect(getEnhancementMultiplier(FIXTURE_ITEMS['/items/foragers_top'], 20)).toBeCloseTo(2, 10);
    });
});
