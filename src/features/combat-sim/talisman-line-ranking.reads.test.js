/**
 * The skilling ranking treats a line as applicable when its stat is in `skillingStatsRead(type)`, and as worth
 * nothing otherwise. This checks the other half: every stat that set names is actually read off the equipment Map's
 * talisman share by the parser the profit and experience math use, so no applicable line is silently left at zero.
 */
import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        getPersonalBuffFlatBoost: () => 0,
        getAchievementBuffFlatBoost: () => 0,
        getHouseRooms: () => new Map(),
        getHouseRoomLevel: () => 0,
        getCommunityBuffLevel: () => 0,
        getMooPassBuffs: () => [],
        characterData: {},
    },
}));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ equipment: new Map(), drinks: [] }),
}));

const { skillingStatsRead } = await import('./talisman-line-ranking.js');
const { attachTalismanBonuses } = await import('../../utils/talisman-bonuses.js');
const parser = await import('../../utils/equipment-parser.js');
const experience = await import('../../utils/experience-parser.js');
const { getActionEfficiencyContext } = await import('../../utils/efficiency.js');

const BELT = '/item_locations/belt';
const ITEMS = { '/items/large_talisman_belt': { equipmentDetail: { type: '/equipment_types/belt' } } };

/** Everything the math reads for this action type, summed, from a Map whose only talisman stat is `name` */
function readAll(type, name) {
    const isBuff = name.startsWith('/buff_types/');
    const equipment = attachTalismanBonuses(new Map([[BELT, { itemHrid: '/items/large_talisman_belt' }]]), {
        noncombat: isBuff ? {} : { [name]: 0.05 },
        buffs: isBuff ? { [name]: 0.05 } : {},
        combat: {},
    });
    const skill = type.replace('/action_types/', '');
    return (
        parser.parseEquipmentSpeedBonuses(equipment, type, ITEMS) +
        parser.parseEquipmentEfficiencyBonuses(equipment, type, ITEMS) +
        parser.parseRareFindBonus(equipment, type, ITEMS) +
        parser.parseEssenceFindBonus(equipment, ITEMS, type) +
        parser.parseGatheringQuantityBonus(equipment, ITEMS) +
        parser.parseEquipmentTalismanBuff(equipment, '/buff_types/gourmet') +
        parser.parseEquipmentTalismanBuff(equipment, '/buff_types/processing') +
        experience.parseEquipmentWisdom(equipment, ITEMS).total +
        experience.parseCharmExperience(equipment, `/skills/${skill}`, ITEMS).total +
        // The skilling Special lines: Epiphany in the XP multiplier, Abundance and Invigoration in the efficiency
        // context. Prosperity is read in the production profit calculator (profit-calculator.prosperity.test.js)
        experience.calculateExperienceMultiplier(`/skills/${skill}`, type, { equipment, drinks: [] }).epiphany +
        getActionEfficiencyContext(
            { type, baseTimeCost: 6e9, levelRequirement: { skillHrid: `/skills/${skill}`, level: 1 } },
            { actionContext: { equipment, drinks: [] } }
        ).abundance +
        getActionEfficiencyContext(
            { type, baseTimeCost: 6e9, levelRequirement: { skillHrid: `/skills/${skill}`, level: 1 } },
            { actionContext: { equipment, drinks: [] } }
        ).invigoration
    );
}

describe('skillingStatsRead names only stats the skilling math reads', () => {
    for (const type of [
        '/action_types/milking',
        '/action_types/foraging',
        '/action_types/woodcutting',
        '/action_types/cooking',
        '/action_types/brewing',
        '/action_types/cheesesmithing',
        '/action_types/crafting',
        '/action_types/tailoring',
    ]) {
        test(type, () => {
            for (const name of skillingStatsRead(type)) {
                if (name === 'prosperity') continue;
                expect(readAll(type, name), name).toBeGreaterThan(0);
            }
        });
    }
});
