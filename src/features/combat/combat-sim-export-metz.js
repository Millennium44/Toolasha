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
const COMBAT_CHARM_HRID = /_(attack|defense|intelligence|stamina|magic|ranged|melee)_charm$/;

function sameCharacterId(left, right) {
    return left != null && right != null && String(left) === String(right);
}

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
    if (!equipmentDetail) return false;
    return Object.values(equipmentDetail.combatStats || {}).some(Boolean) || COMBAT_CHARM_HRID.test(itemHrid);
}

function buildOwnedBlock({ inventoryItems, itemDetailMap, characterAbilities, equippedAbilityHrids, capturedAt }) {
    const equipment = (inventoryItems || [])
        .filter(
            (item) =>
                item.itemLocationHrid === INVENTORY_LOCATION &&
                Number(item.count) > 0 &&
                isCombatWearable(item.itemHrid, itemDetailMap)
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

    return equipment.length || abilities.length ? { ...(capturedAt && { capturedAt }), equipment, abilities } : null;
}

function equipmentIdentity(item) {
    return `${item?.itemHrid || ''}::${Number(item?.enhancementLevel) || 0}`;
}

function reconcileOwnedEquipment(character, equipped) {
    const pool = new Map();
    const add = (item, count) => {
        if (!item?.itemHrid || count <= 0) return;
        const key = equipmentIdentity(item);
        const current = pool.get(key);
        if (current) current.count += count;
        else {
            pool.set(key, {
                itemHrid: item.itemHrid,
                enhancementLevel: Number(item.enhancementLevel) || 0,
                count,
                equipped: false,
            });
        }
    };

    for (const item of character.player?.equipment || []) add(item, 1);
    for (const item of character.owned?.equipment || []) add(item, Number(item.count) || 1);

    for (const item of equipped) {
        const key = equipmentIdentity(item);
        const spare = pool.get(key);
        if (!spare) continue;
        spare.count -= 1;
        if (spare.count <= 0) pool.delete(key);
    }
    return [...pool.values()];
}

function reconcileOwnedAbilities(character, equipped) {
    const pool = new Map();
    for (const ability of [...(character.abilities || []), ...(character.owned?.abilities || [])]) {
        if (ability?.abilityHrid) {
            pool.set(ability.abilityHrid, {
                abilityHrid: ability.abilityHrid,
                level: Number(ability.level) || 1,
                equipped: false,
            });
        }
    }
    for (const ability of equipped) pool.delete(ability.abilityHrid);
    return [...pool.values()];
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
    // On an external simulator page dataManager is intentionally empty. The GM bridge still
    // carries init_character_data, whose characterItems are the only inventory source there.
    // On the game page prefer the live collection so an emptied bag cannot fall back to the
    // login snapshot and resurrect items that are no longer owned.
    const hasLiveData = characterObj === dataManager.characterData;
    const inventoryItems = hasLiveData
        ? dataManager.getInventory() || []
        : Array.isArray(characterObj.characterItems)
          ? characterObj.characterItems
          : [];
    const mooPassBuffs = hasLiveData ? dataManager.getMooPassBuffs() : characterObj.mooPassBuffs || [];
    const equippedAbilityHrids = new Set(
        (characterObj.combatUnit?.combatAbilities || []).map((ability) => ability.abilityHrid).filter(Boolean)
    );
    return toMetzCharacter(characterObj.character?.name || 'Player 1', source, {
        hasMooPass: (mooPassBuffs?.length ?? 0) > 0,
        skills: characterObj.characterSkills,
        speedGear: buildSpeedGear(inventoryItems, itemDetailMap),
        owned: buildOwnedBlock({
            inventoryItems,
            itemDetailMap,
            characterAbilities: characterObj.characterAbilities,
            equippedAbilityHrids,
            capturedAt: hasLiveData ? new Date().toISOString() : null,
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
        if (!member.characterID || sameCharacterId(member.characterID, characterObj.character.id)) continue;
        const profile = profileList.find((entry) => sameCharacterId(entry.characterID, member.characterID));
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

    if (externalProfileId && !sameCharacterId(externalProfileId, characterObj.character?.id)) {
        const profile = (await getProfileList()).find((entry) => sameCharacterId(entry.characterID, externalProfileId));
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
    const filledAbilities = dropBlankSlots(abilities, 'abilityHrid');
    const ownedEquipment = reconcileOwnedEquipment(character, strippedEquipment);
    const ownedAbilities = reconcileOwnedAbilities(character, filledAbilities);
    const { owned: previousOwned, ...characterWithoutOwned } = character;
    const owned =
        ownedEquipment.length || ownedAbilities.length
            ? {
                  ...(previousOwned?.capturedAt && { capturedAt: previousOwned.capturedAt }),
                  equipment: ownedEquipment,
                  abilities: ownedAbilities,
              }
            : null;
    return {
        ...characterWithoutOwned,
        player: { ...character.player, equipment: strippedEquipment },
        abilities: filledAbilities,
        triggerMap: triggerMap || {},
        food: { '/action_types/combat': dropBlankSlots(food, 'itemHrid') },
        drinks: { '/action_types/combat': dropBlankSlots(drinks, 'itemHrid') },
        ...(owned && { owned }),
    };
}
