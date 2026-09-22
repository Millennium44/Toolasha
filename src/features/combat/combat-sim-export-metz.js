/**
 * Export adapters for the Metz combat simulator.
 * Metz accepts the existing combat export fields in a character array, plus optional
 * skilling and owned-inventory blocks used by its optimizer.
 */

import dataManager from '../../core/data-manager.js';
import {
    getCharacterData,
    getClientData,
    getBattleData,
    getProfileList,
    constructSelfPlayer,
    constructPartyPlayer,
} from './combat-sim-export.js';

const ENHANCING_TOOL_LOCATION = '/item_locations/enhancing_tool';
const ALCHEMY_TOOL_LOCATION = '/item_locations/alchemy_tool';
const INVENTORY_LOCATION = '/item_locations/inventory';
const SPEED_GEAR_STATS = ['enhancingSpeed', 'skillingSpeed'];

function dropBlankSlots(slots, hridField) {
    return (slots || []).filter((slot) => slot?.[hridField]);
}

function extractToolsFromEquipment(equipment) {
    const rest = [];
    let enhancingTool = null;
    let alchemyTool = null;

    for (const item of equipment || []) {
        if (item.itemLocationHrid === ENHANCING_TOOL_LOCATION) {
            enhancingTool = { itemHrid: item.itemHrid, enhancementLevel: item.enhancementLevel || 0 };
        } else if (item.itemLocationHrid === ALCHEMY_TOOL_LOCATION) {
            alchemyTool = { itemHrid: item.itemHrid, enhancementLevel: item.enhancementLevel || 0 };
        } else {
            rest.push(item);
        }
    }
    return { equipment: rest, enhancingTool, alchemyTool };
}

function extractSkillLevels(skills) {
    let enhancingLevel = null;
    let alchemyLevel = null;
    for (const skill of skills || []) {
        if (skill?.skillHrid === '/skills/enhancing') enhancingLevel = skill.level;
        if (skill?.skillHrid === '/skills/alchemy') alchemyLevel = skill.level;
    }
    return { enhancingLevel, alchemyLevel };
}

function buildSkillingBlock({ skills, equipment, speedGear }) {
    const { equipment: strippedEquipment, enhancingTool, alchemyTool } = extractToolsFromEquipment(equipment);
    const { enhancingLevel, alchemyLevel } = extractSkillLevels(skills);
    const hasSkilling =
        enhancingLevel != null || alchemyLevel != null || enhancingTool || alchemyTool || speedGear?.length > 0;

    return {
        equipment: strippedEquipment,
        skilling: hasSkilling
            ? {
                  ...(enhancingLevel != null && { enhancingLevel }),
                  ...(alchemyLevel != null && { alchemyLevel }),
                  enhancingTool,
                  alchemyTool,
                  speedGear: speedGear || [],
              }
            : null,
    };
}

function buildSpeedGear(inventoryItems, itemDetailMap) {
    return (inventoryItems || [])
        .filter((item) => {
            const stats = itemDetailMap?.[item.itemHrid]?.equipmentDetail?.noncombatStats || {};
            return SPEED_GEAR_STATS.some((stat) => (stats[stat] || 0) > 0);
        })
        .map((item) => ({ itemHrid: item.itemHrid, enhancementLevel: item.enhancementLevel || 0 }));
}

function isCombatWearable(itemHrid, itemDetailMap) {
    const equipmentDetail = itemDetailMap?.[itemHrid]?.equipmentDetail;
    return Boolean(equipmentDetail) && !equipmentDetail.type?.endsWith('_tool');
}

function buildOwnedBlock({ inventoryItems, itemDetailMap, characterAbilities, equippedAbilityHrids }) {
    const equipment = (inventoryItems || [])
        .filter(
            (item) => item.itemLocationHrid === INVENTORY_LOCATION && isCombatWearable(item.itemHrid, itemDetailMap)
        )
        .map((item) => ({
            itemHrid: item.itemHrid,
            enhancementLevel: item.enhancementLevel || 0,
            count: item.count || 1,
            equipped: false,
        }));
    const abilities = (characterAbilities || [])
        .filter((ability) => ability?.abilityHrid && !equippedAbilityHrids.has(ability.abilityHrid))
        .map((ability) => ({ abilityHrid: ability.abilityHrid, level: ability.level || 1, equipped: false }));

    return equipment.length || abilities.length ? { capturedAt: new Date().toISOString(), equipment, abilities } : null;
}

function toMetzCharacter(name, source, extra = {}) {
    const { hasMooPass, skills, speedGear, owned } = extra;
    const { equipment, skilling } = buildSkillingBlock({ skills, equipment: source.player.equipment, speedGear });
    const character = {
        name,
        player: { ...source.player, equipment },
        abilities: dropBlankSlots(source.abilities, 'abilityHrid'),
        triggerMap: source.triggerMap,
        houseRooms: source.houseRooms,
        guildCombatBuffLevels: source.guildCombatBuffLevels,
        food: { '/action_types/combat': dropBlankSlots(source.food?.['/action_types/combat'], 'itemHrid') },
        drinks: { '/action_types/combat': dropBlankSlots(source.drinks?.['/action_types/combat'], 'itemHrid') },
        ...(hasMooPass !== undefined && { hasMooPass }),
    };
    if (skilling) character.skilling = skilling;
    if (owned) character.owned = owned;
    if (source.achievements && Object.keys(source.achievements).length) character.achievements = source.achievements;
    return character;
}

function buildSelfMetzCharacter(characterObj, clientObj) {
    const source = constructSelfPlayer(characterObj, clientObj);
    const itemDetailMap = clientObj?.itemDetailMap;
    const inventoryItems = dataManager.getInventory() || [];
    const equippedAbilityHrids = new Set(
        (characterObj.combatUnit?.combatAbilities || []).map((ability) => ability.abilityHrid).filter(Boolean)
    );
    return toMetzCharacter(characterObj.character?.name || 'Player 1', source, {
        hasMooPass: (dataManager.getMooPassBuffs()?.length ?? 0) > 0,
        skills: characterObj.characterSkills,
        speedGear: buildSpeedGear(inventoryItems, itemDetailMap),
        owned: buildOwnedBlock({
            inventoryItems,
            itemDetailMap,
            characterAbilities: characterObj.characterAbilities,
            equippedAbilityHrids,
        }),
    });
}

/** Build the current character and every cached party member in Metz's team shape. */
export async function constructMetzTeamExport() {
    const characterObj = getCharacterData();
    if (!characterObj) return null;

    const clientObj = getClientData();
    const battleObj = getBattleData();
    const profileList = await getProfileList();
    const team = [buildSelfMetzCharacter(characterObj, clientObj)];

    for (const member of Object.values(characterObj.partyInfo?.partySlotMap || {})) {
        if (!member.characterID || member.characterID === characterObj.character.id) continue;
        const profile = profileList.find((entry) => entry.characterID === member.characterID);
        if (!profile) continue;
        team.push(
            toMetzCharacter(profile.characterName, constructPartyPlayer(profile, clientObj, battleObj), {
                skills: profile.profile?.characterSkills,
            })
        );
    }
    return team;
}

/** Build one current or cached-profile character in Metz's import shape. */
export async function constructMetzCharacterExport(externalProfileId = null) {
    const characterObj = getCharacterData();
    if (!characterObj) return null;
    const clientObj = getClientData();

    if (externalProfileId && externalProfileId !== characterObj.character?.id) {
        const profile = (await getProfileList()).find((entry) => entry.characterID === externalProfileId);
        if (!profile) return null;
        return toMetzCharacter(profile.characterName, constructPartyPlayer(profile, clientObj, getBattleData()), {
            skills: profile.profile?.characterSkills,
        });
    }
    return buildSelfMetzCharacter(characterObj, clientObj);
}

/** Apply a saved combat loadout without overwriting tools learned from live equipment. */
export function applyLoadoutOverrideToMetzCharacter(character, { equipment, abilities, triggerMap, food, drinks }) {
    const { equipment: strippedEquipment } = extractToolsFromEquipment((equipment || []).map((item) => ({ ...item })));
    return {
        ...character,
        player: { ...character.player, equipment: strippedEquipment },
        abilities: dropBlankSlots(abilities, 'abilityHrid'),
        triggerMap: triggerMap || {},
        food: { '/action_types/combat': dropBlankSlots(food, 'itemHrid') },
        drinks: { '/action_types/combat': dropBlankSlots(drinks, 'itemHrid') },
    };
}
