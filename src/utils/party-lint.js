/**
 * Party lint
 *
 * Loadout mistakes worth calling out on a party, as readable strings.
 *
 * Extracted from `combat-sim-ui.js` so the surfaces that lint a *live* party —
 * the DPS panel watching a run in progress — do not have to import the whole
 * simulator UI to ask two questions about gear and auras. The sim re-exports
 * everything here, so its callers and tests are untouched. Pure throughout:
 * game data comes in as arguments, never through an import.
 *
 * The two checks are the two mistakes a party cannot see from inside the game:
 * gear that does nothing in combat quietly occupying a combat slot, and the
 * same aura equipped twice when one copy reaches every ally.
 */

/**
 * Is this equipment piece skilling gear — a piece that contributes nothing to combat?
 *
 * Read off the item's own stats rather than a name list, the same way
 * `skilling-gear-candidates.js` scopes gear to a skill: skilling tools and
 * outfits carry a nonzero value in `equipmentDetail.noncombatStats` and no
 * nonzero value in `equipmentDetail.combatStats`. A Philosopher's Necklace,
 * which carries both, is not flagged — it does work in combat; a piece with
 * neither is not flagged either, because "no stats" is not the same claim as
 * "skilling gear".
 *
 * @param {Object} itemDetail - From `itemDetailMap`
 * @returns {boolean}
 */
export function isSkillingGearItem(itemDetail) {
    const equipment = itemDetail?.equipmentDetail;
    if (!equipment) return false;
    const hasValue = (stats) => Object.values(stats || {}).some((value) => Number(value) !== 0);
    return hasValue(equipment.noncombatStats) && !hasValue(equipment.combatStats);
}

/**
 * Is this ability an aura — a special ability whose buffs land on the whole party?
 *
 * Read off the ability data rather than the hrid: the engine treats exactly
 * this shape as party-wide (`processAbilityBuffEffect` walks every living ally
 * for a `/ability_effect_types/buff` effect with `targetType 'allAllies'`), so
 * anything matching it is an aura in the only sense that matters here — and a
 * special ability that only buffs its caster (Invincible, Vampirism) is not.
 *
 * @param {Object} abilityDetail - From `abilityDetailMap`
 * @returns {boolean}
 */
export function isAuraAbility(abilityDetail) {
    if (!abilityDetail?.isSpecialAbility) return false;
    return (abilityDetail.abilityEffects || []).some(
        (effect) =>
            effect?.effectType === '/ability_effect_types/buff' &&
            effect?.targetType === 'allAllies' &&
            Array.isArray(effect?.buffs) &&
            effect.buffs.length > 0
    );
}

/**
 * The name a party warning calls a member by.
 * @param {Object} dto - Player DTO
 * @param {Array<Object>} playerInfo - `[{ hrid, name }]` as the sim loads it
 * @returns {string}
 */
function partyMemberName(dto, playerInfo) {
    const entry = (playerInfo || []).find((info) => info?.hrid === dto?.hrid);
    return entry?.name || dto?.hrid || 'Unknown player';
}

/**
 * Party members wearing gear that does nothing in combat.
 *
 * One warning per offending member, naming every piece at once — five separate
 * lines about one person's outfit would read as five problems.
 *
 * @param {Array<Object>} playerDTOs - Player DTOs (`equipment` keyed by slot)
 * @param {Array<Object>} playerInfo - `[{ hrid, name }]`
 * @param {Object} itemDetailMap - Game data
 * @returns {Array<string>} Human-readable warnings
 */
export function skillingGearWarnings(playerDTOs, playerInfo, itemDetailMap = {}) {
    const warnings = [];
    for (const dto of playerDTOs || []) {
        const pieces = [];
        for (const [slot, worn] of Object.entries(dto?.equipment || {})) {
            // Tool slots have no combat equivalent — a Holy Alembic is always
            // equipped and never displacing combat gear, so it is not a mistake
            if (String(slot).endsWith('_tool')) continue;
            if (!worn?.hrid) continue;
            const detail = itemDetailMap[worn.hrid];
            if (!isSkillingGearItem(detail)) continue;
            pieces.push(detail.name || worn.hrid.split('/').pop());
        }
        if (pieces.length > 0) {
            warnings.push(`${partyMemberName(dto, playerInfo)} has skilling gear equipped: ${pieces.join(', ')}`);
        }
    }
    return warnings;
}

/**
 * Auras equipped by more than one party member.
 *
 * Two copies of the same aura are one aura: the buff reaches every ally from
 * whoever casts it, keyed by its unique hrid, so the second copy adds nothing
 * and costs its wearer the special slot.
 *
 * @param {Array<Object>} playerDTOs - Player DTOs (`abilities` array of slots)
 * @param {Array<Object>} playerInfo - `[{ hrid, name }]`
 * @param {Object} abilityDetailMap - Game data
 * @returns {Array<string>} Human-readable warnings, one per duplicated aura
 */
export function duplicateAuraWarnings(playerDTOs, playerInfo, abilityDetailMap = {}) {
    const wearersByAura = new Map();
    for (const dto of playerDTOs || []) {
        const seen = new Set();
        for (const ability of dto?.abilities || []) {
            if (!ability?.hrid || seen.has(ability.hrid)) continue;
            seen.add(ability.hrid);
            if (!isAuraAbility(abilityDetailMap[ability.hrid])) continue;
            const wearers = wearersByAura.get(ability.hrid) || [];
            wearers.push(partyMemberName(dto, playerInfo));
            wearersByAura.set(ability.hrid, wearers);
        }
    }

    const warnings = [];
    for (const [auraHrid, wearers] of wearersByAura) {
        if (wearers.length < 2) continue;
        const auraName = abilityDetailMap[auraHrid]?.name || auraHrid.split('/').pop();
        const names =
            wearers.length === 2
                ? wearers.join(' and ')
                : `${wearers.slice(0, -1).join(', ')} and ${wearers[wearers.length - 1]}`;
        warnings.push(`${auraName} is equipped by ${names} — auras do not stack`);
    }
    return warnings;
}

/**
 * Every loadout mistake worth flagging on a loaded party, as readable strings.
 *
 * Only for actual parties: solo, both checks are moot — one copy of an aura is
 * the correct number, and gear is the player's own screen looking back at them.
 *
 * @param {Array<Object>} playerDTOs - Player DTOs as the sim will run them
 * @param {Array<Object>} playerInfo - `[{ hrid, name }]`
 * @param {Object} gameData - Payload from `buildGameDataPayload`
 * @returns {Array<string>} Warnings, empty when there is nothing to say
 */
export function partyLintWarnings(playerDTOs, playerInfo, gameData) {
    if (!Array.isArray(playerDTOs) || playerDTOs.length < 2) return [];
    return [
        ...skillingGearWarnings(playerDTOs, playerInfo, gameData?.itemDetailMap || {}),
        ...duplicateAuraWarnings(playerDTOs, playerInfo, gameData?.abilityDetailMap || {}),
    ];
}

/**
 * The live party, in the DTO shape the lint reads.
 *
 * `new_battle` names every player and carries every player's equipped kit whole
 * (`combatDetails.combatAbilities`) — but nobody's equipment: the combat unit
 * has stats, not wearables. So the mapping is honest about what it can source:
 * abilities are filled for everyone from the payload, and equipment only for
 * the current player, from the client's own always-current equipment list
 * passed in by the caller. Everyone else's `equipment` is left empty rather
 * than guessed from a stale cached profile, which means the gear check only
 * ever speaks about the one loadout it can actually see.
 *
 * @param {Object} battle - A `new_battle` payload (`players` is an array)
 * @param {Object} [options]
 * @param {string|number} [options.currentCharacterId] - Who the client is
 * @param {Array<Object>} [options.ownEquipment] - The current player's equipped
 *   items, `[{ itemHrid, enhancementLevel }]`
 * @param {Object} [options.itemDetailMap] - Game data, to key equipment by
 *   `equipmentDetail.type`; an item the map cannot place is skipped
 * @returns {{playerDTOs: Array<Object>, playerInfo: Array<Object>}} Lint inputs;
 *   both empty when the battle names nobody
 */
export function battleLintInputs(battle, { currentCharacterId, ownEquipment, itemDetailMap } = {}) {
    const players = Array.isArray(battle?.players) ? battle.players : [];
    const playerDTOs = [];
    const playerInfo = [];

    players.forEach((player, index) => {
        const hrid = `player${index + 1}`;
        const name = player?.character?.name || player?.name || `Player ${index + 1}`;

        const isSelf =
            currentCharacterId !== null &&
            currentCharacterId !== undefined &&
            player?.character?.id === currentCharacterId;

        const equipment = {};
        if (isSelf) {
            for (const item of ownEquipment || []) {
                const type = itemDetailMap?.[item?.itemHrid]?.equipmentDetail?.type;
                if (!type) continue;
                equipment[type] = { hrid: item.itemHrid, enhancementLevel: item.enhancementLevel || 0 };
            }
        }

        const abilities = (player?.combatDetails?.combatAbilities || [])
            .filter((ability) => ability?.abilityHrid)
            .map((ability) => ({ hrid: ability.abilityHrid, level: ability.level || 1 }));

        playerDTOs.push({ hrid, equipment, abilities });
        playerInfo.push({ hrid, name });
    });

    return { playerDTOs, playerInfo };
}
