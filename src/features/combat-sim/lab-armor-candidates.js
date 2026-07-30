/**
 * Forced Lab Sim armor candidates.
 *
 * The labyrinth is where body/legs choices matter most, so the Lab Sim upgrade
 * analysis always evaluates the Anchorbound plate pieces and the top-tier armor
 * that suits the loadout's weapon — every combination of the two sets, whether or
 * not the tier progression would have proposed them. Without this, a player
 * already in decent gear never sees the comparison, because the normal candidate
 * generator only ever steps one tier from what's equipped.
 *
 * Enhancement levels come from what you actually own: the level you have equipped,
 * else the best copy sitting in your inventory, else a +7 assumption so the
 * comparison still runs for gear you haven't bought yet.
 */

/** Anchorbound plate pieces, always offered */
export const ANCHORBOUND_HRIDS = ['/items/anchorbound_plate_body', '/items/anchorbound_plate_legs'];

/** Assumed enhancement level when a piece is neither equipped nor owned */
export const DEFAULT_ARMOR_ENHANCEMENT = 7;

const BODY_SLOT = '/equipment_types/body';
const LEGS_SLOT = '/equipment_types/legs';
const BACK_SLOT = '/equipment_types/back';
const ARMOR_SLOTS = [BODY_SLOT, LEGS_SLOT];

const WEAPON_SLOTS = ['/equipment_types/two_hand', '/equipment_types/main_hand'];

/** Slot order used for keys and descriptions: weapon first, then armor */
const SLOT_ORDER = [...WEAPON_SLOTS, ...ARMOR_SLOTS, BACK_SLOT];

/**
 * Elemental damage types and the armor stat that amplifies each. Magic gear is
 * split by element, so "magic robes" is not one answer — a nature weapon and a
 * fire spell want different robes.
 */
const ELEMENT_AMPLIFY = {
    '/damage_types/fire': 'fireAmplify',
    '/damage_types/nature': 'natureAmplify',
    '/damage_types/water': 'waterAmplify',
};

/**
 * Cap on how many elements get their own armor set. Every set multiplies the
 * pair combinations, and a build past two elements is vanishingly rare.
 */
const MAX_ELEMENTAL_SETS = 2;

/**
 * Collapse an item role into the style family it serves.
 * @param {Object} combatStats - equipmentDetail.combatStats
 * @returns {string} 'melee', 'ranged', 'magic', or 'defensive'
 */
export function styleFamilyOfStats(combatStats) {
    if (!combatStats) return 'defensive';

    const amplify = (combatStats.fireAmplify || 0) + (combatStats.natureAmplify || 0) + (combatStats.waterAmplify || 0);
    if (amplify > 0) return 'magic';

    const melee =
        (combatStats.stabDamage || 0) +
        (combatStats.slashDamage || 0) +
        (combatStats.smashDamage || 0) +
        (combatStats.stabAccuracy || 0) +
        (combatStats.slashAccuracy || 0) +
        (combatStats.smashAccuracy || 0);
    const ranged = (combatStats.rangedDamage || 0) + (combatStats.rangedAccuracy || 0);
    const magic = (combatStats.magicDamage || 0) + (combatStats.magicAccuracy || 0);

    if (melee <= 0 && ranged <= 0 && magic <= 0) return 'defensive';
    if (ranged >= melee && ranged >= magic) return 'ranged';
    if (magic >= melee && magic >= ranged) return 'magic';
    return 'melee';
}

/**
 * Which style the loadout's weapon plays. Checks the two-hander as well as the
 * main hand, since a two-handed loadout leaves main_hand empty.
 * @param {Object} playerDTO - Player DTO
 * @param {Object} gameData - Game data payload
 * @returns {string} 'melee', 'ranged', 'magic', or 'defensive' when unarmed
 */
export function getWeaponStyleFamily(playerDTO, gameData) {
    for (const slot of WEAPON_SLOTS) {
        const equipped = playerDTO?.equipment?.[slot];
        if (!equipped?.hrid) continue;
        const stats = gameData?.itemDetailMap?.[equipped.hrid]?.equipmentDetail?.combatStats;
        const family = styleFamilyOfStats(stats);
        if (family !== 'defensive') return family;
    }
    return 'defensive';
}

/**
 * Elements this loadout actually deals damage with, most important first.
 *
 * The weapon and the spells can disagree — a Nature trident paired with Fireball
 * — and each wants its own robes, so both are reported. The weapon's element
 * leads, then ability elements by how many equipped abilities use them.
 * @param {Object} playerDTO - Player DTO
 * @param {Object} gameData - Game data payload
 * @returns {string[]} Damage type HRIDs, capped at MAX_ELEMENTAL_SETS
 */
export function getLoadoutElements(playerDTO, gameData) {
    const weaponElement = (() => {
        for (const slot of WEAPON_SLOTS) {
            const equipped = playerDTO?.equipment?.[slot];
            if (!equipped?.hrid) continue;
            const damageType = gameData?.itemDetailMap?.[equipped.hrid]?.equipmentDetail?.combatStats?.damageType;
            if (damageType && ELEMENT_AMPLIFY[damageType]) return damageType;
        }
        return null;
    })();

    const abilityCounts = new Map();
    for (const ability of playerDTO?.abilities || []) {
        if (!ability?.hrid) continue;
        const effects = gameData?.abilityDetailMap?.[ability.hrid]?.abilityEffects || [];
        const elements = new Set();
        for (const effect of effects) {
            if (effect?.damageType && ELEMENT_AMPLIFY[effect.damageType]) elements.add(effect.damageType);
        }
        for (const element of elements) {
            abilityCounts.set(element, (abilityCounts.get(element) || 0) + 1);
        }
    }

    const ordered = [...abilityCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([element]) => element);

    const result = [];
    for (const element of [weaponElement, ...ordered]) {
        if (!element || result.includes(element)) continue;
        result.push(element);
        if (result.length >= MAX_ELEMENTAL_SETS) break;
    }
    return result;
}

/**
 * Top-tier armor amplifying a specific element.
 * @param {string} slot - Equipment slot HRID
 * @param {string} element - Damage type HRID
 * @param {Object} gameData - Game data payload
 * @returns {Object|null} { hrid, name, itemLevel } or null when nothing amplifies it
 */
export function findElementalArmor(slot, element, gameData) {
    const stat = ELEMENT_AMPLIFY[element];
    if (!stat) return null;

    const entries = [];
    for (const [hrid, item] of Object.entries(gameData?.itemDetailMap || {})) {
        const equipmentDetail = item?.equipmentDetail;
        if (equipmentDetail?.type !== slot) continue;
        const amplify = Number(equipmentDetail.combatStats?.[stat]) || 0;
        if (amplify <= 0) continue;
        if (hrid.endsWith('_refined')) continue;
        entries.push({
            hrid,
            name: item.name || hrid.split('/').pop().replace(/_/g, ' '),
            itemLevel: item.itemLevel || 0,
            amplify,
        });
    }
    if (entries.length === 0) return null;

    const topLevel = Math.max(...entries.map((entry) => entry.itemLevel));
    const ranked = entries
        .filter((entry) => entry.itemLevel === topLevel)
        .sort((a, b) => b.amplify - a.amplify || a.hrid.localeCompare(b.hrid));

    const { hrid, name, itemLevel } = ranked[0];
    return { hrid, name, itemLevel };
}

/**
 * Enhancement level to sim a piece at: equipped level, else the best copy owned,
 * else the default assumption.
 * @param {string} itemHrid - Item HRID
 * @param {Object} playerDTO - Player DTO (its equipment is the loadout being analyzed)
 * @param {Array<Object>} [inventory] - characterItems from dataManager
 * @returns {number} Enhancement level
 */
export function resolveItemEnhancement(itemHrid, playerDTO, inventory) {
    for (const equipped of Object.values(playerDTO?.equipment || {})) {
        if (equipped?.hrid === itemHrid) return Math.max(0, Math.floor(Number(equipped.enhancementLevel) || 0));
    }

    let best = null;
    for (const item of inventory || []) {
        if (item?.itemHrid !== itemHrid) continue;
        // Equipped copies live in the same list under a different location
        if (item.itemLocationHrid && item.itemLocationHrid !== '/item_locations/inventory') continue;
        if (Number(item.count) <= 0) continue;
        const level = Math.max(0, Math.floor(Number(item.enhancementLevel) || 0));
        if (best === null || level > best) best = level;
    }
    if (best !== null) return best;

    return DEFAULT_ARMOR_ENHANCEMENT;
}

/**
 * Top-tier armor for a slot, preferring the piece that serves the weapon's style.
 * "Top tier" is the highest item level present rather than a hardcoded 95, so a
 * future tier doesn't quietly leave this pinned to old gear.
 * @param {string} slot - Equipment slot HRID
 * @param {string} styleFamily - From getWeaponStyleFamily
 * @param {Object} gameData - Game data payload
 * @returns {Object|null} { hrid, name, itemLevel } or null when the slot has no armor
 */
export function findTopTierArmor(slot, styleFamily, gameData) {
    const entries = [];
    for (const [hrid, item] of Object.entries(gameData?.itemDetailMap || {})) {
        const equipmentDetail = item?.equipmentDetail;
        if (equipmentDetail?.type !== slot) continue;
        if (!equipmentDetail.combatStats) continue;
        // Refined variants share their base item level but cost far more to reach
        // a usable enhancement; the plain tier is the fair comparison
        if (hrid.endsWith('_refined')) continue;
        entries.push({
            hrid,
            name: item.name || hrid.split('/').pop().replace(/_/g, ' '),
            itemLevel: item.itemLevel || 0,
            family: styleFamilyOfStats(equipmentDetail.combatStats),
        });
    }
    if (entries.length === 0) return null;

    const topLevel = Math.max(...entries.map((entry) => entry.itemLevel));
    const atTop = entries.filter((entry) => entry.itemLevel === topLevel);

    // Style match first, then style-neutral armor, then anything — sorted by hrid
    // so a tie resolves the same way every run
    const ranked = [...atTop].sort((a, b) => {
        const rank = (entry) => (entry.family === styleFamily ? 0 : entry.family === 'defensive' ? 1 : 2);
        return rank(a) - rank(b) || a.hrid.localeCompare(b.hrid);
    });

    const { hrid, name, itemLevel } = ranked[0];
    return { hrid, name, itemLevel };
}

/**
 * The weapon this loadout attacks with.
 * @param {Object} playerDTO - Player DTO
 * @param {Object} gameData - Game data payload
 * @returns {Object|null} { slot, hrid, name, itemLevel, damageType } or null when unarmed
 */
export function getEquippedWeapon(playerDTO, gameData) {
    for (const slot of WEAPON_SLOTS) {
        const equipped = playerDTO?.equipment?.[slot];
        if (!equipped?.hrid) continue;
        const item = gameData?.itemDetailMap?.[equipped.hrid];
        if (!item?.equipmentDetail) continue;
        return {
            slot,
            hrid: equipped.hrid,
            name: item.name || equipped.hrid.split('/').pop().replace(/_/g, ' '),
            itemLevel: item.itemLevel || 0,
            damageType: item.equipmentDetail.combatStats?.damageType || '',
        };
    }
    return null;
}

/**
 * The same class of weapon in a different element — a Blooming Trident's Blazing
 * counterpart. Elemental variants share the weapon's last name word ("Trident"),
 * which keeps the comparison within one weapon class instead of proposing a
 * completely different playstyle; without a same-class match, the best top-tier
 * weapon of that element in the same slot is used.
 * @param {Object} weapon - From getEquippedWeapon
 * @param {string} element - Damage type HRID
 * @param {Object} gameData - Game data payload
 * @returns {Object|null} { hrid, name, itemLevel } or null when the element has no weapon
 */
export function findElementalWeapon(weapon, element, gameData) {
    if (!weapon || !ELEMENT_AMPLIFY[element]) return null;

    const lastWord = (name) => (name || '').trim().split(/\s+/).pop().toLowerCase();
    const weaponClass = lastWord(weapon.name);

    const entries = [];
    for (const [hrid, item] of Object.entries(gameData?.itemDetailMap || {})) {
        const equipmentDetail = item?.equipmentDetail;
        if (equipmentDetail?.type !== weapon.slot) continue;
        if (equipmentDetail.combatStats?.damageType !== element) continue;
        if (hrid.endsWith('_refined')) continue;
        if (hrid === weapon.hrid) continue;
        const name = item.name || hrid.split('/').pop().replace(/_/g, ' ');
        entries.push({ hrid, name, itemLevel: item.itemLevel || 0, sameClass: lastWord(name) === weaponClass });
    }
    if (entries.length === 0) return null;

    // Same weapon class first, then the highest tier available
    const ranked = entries.sort(
        (a, b) => Number(b.sameClass) - Number(a.sameClass) || b.itemLevel - a.itemLevel || a.hrid.localeCompare(b.hrid)
    );

    const { hrid, name, itemLevel } = ranked[0];
    return { hrid, name, itemLevel };
}

/**
 * Back-slot options worth trying: the cape matching the loadout's style, plus the
 * melee cape whatever the style is.
 *
 * The melee cape trades offence for defence, which in the labyrinth can be worth
 * more to a ranged or magic run than its own style's cape — and the reverse
 * needs testing too, since a run already wearing the melee cape should still see
 * what its style cape does. Both are levelled to the cape currently worn so the
 * result reflects the cape rather than its enhancement.
 * @param {Object} playerDTO - Player DTO
 * @param {Object} gameData - Game data payload
 * @param {string} styleFamily - From getWeaponStyleFamily
 * @param {Function} toPiece - (hrid, levelOverride) => piece
 * @returns {Array<Object>} Back-slot pieces
 */
export function getCapeOptions(playerDTO, gameData, styleFamily, toPiece) {
    const equippedBack = playerDTO?.equipment?.[BACK_SLOT];
    const comparisonLevel = equippedBack?.hrid ? equippedBack.enhancementLevel || 0 : null;

    const options = [];
    const seen = new Set();
    for (const family of [styleFamily, 'melee']) {
        const found = findTopTierArmor(BACK_SLOT, family, gameData);
        if (!found || seen.has(found.hrid)) continue;
        seen.add(found.hrid);
        const piece = toPiece(found.hrid, comparisonLevel);
        if (piece) options.push(piece);
    }
    return options;
}

/**
 * Canonical key for a slot assignment, so the same combination generated by two
 * different set pairings is only simmed once.
 * @param {Object} assignment - slot → { hrid, enhancementLevel }
 * @returns {string}
 */
function assignmentKey(assignment) {
    return SLOT_ORDER.filter((slot) => assignment[slot])
        .map((slot) => `${slot}=${assignment[slot].hrid}@${assignment[slot].enhancementLevel}`)
        .join('|');
}

/**
 * Is this assignment exactly what the loadout already wears?
 * @param {Object} assignment - slot → { hrid, enhancementLevel }
 * @param {Object} playerDTO - Player DTO
 * @returns {boolean}
 */
function isAlreadyEquipped(assignment, playerDTO) {
    return Object.entries(assignment).every(([slot, item]) => {
        const equipped = playerDTO?.equipment?.[slot];
        return equipped?.hrid === item.hrid && (equipped.enhancementLevel || 0) === item.enhancementLevel;
    });
}

/**
 * Build the forced candidates: each set's body and legs alone, each set as a pair,
 * the cross-set pairs, and — when the spells use an element the weapon does not —
 * that element's weapon, alone and with its matching robes.
 * @param {Object} playerDTO - Player DTO for the loadout being analyzed
 * @param {Object} gameData - Game data payload
 * @param {Array<Object>} [inventory] - characterItems from dataManager
 * @returns {Array<Object>} Candidates of type 'cross_slot' tagged labArmor
 */
export function generateLabArmorCandidates(playerDTO, gameData, inventory) {
    if (!playerDTO || !gameData?.itemDetailMap) return [];

    const styleFamily = getWeaponStyleFamily(playerDTO, gameData);

    /**
     * Resolve one piece into a slot assignment entry.
     * @param {string} hrid - Item HRID
     * @returns {Object|null} { slot, hrid, name, enhancementLevel }
     */
    const toPiece = (hrid, levelOverride = null) => {
        const item = gameData.itemDetailMap[hrid];
        const slot = item?.equipmentDetail?.type;
        if (!slot || !SLOT_ORDER.includes(slot)) return null;
        return {
            slot,
            hrid,
            name: item.name || hrid.split('/').pop().replace(/_/g, ' '),
            enhancementLevel:
                levelOverride === null ? resolveItemEnhancement(hrid, playerDTO, inventory) : levelOverride,
        };
    };

    const anchorPieces = {};
    for (const hrid of ANCHORBOUND_HRIDS) {
        const piece = toPiece(hrid);
        if (piece) anchorPieces[piece.slot] = piece;
    }

    // Magic splits by element: a nature weapon with fire spells wants both robe
    // sets compared, not one "magic" pick decided by a tiebreak
    const elements = getLoadoutElements(playerDTO, gameData);
    const setPieces = [];
    const elementSets = new Map();
    for (const element of elements) {
        const pieces = {};
        for (const slot of ARMOR_SLOTS) {
            const found = findElementalArmor(slot, element, gameData);
            const piece = found && toPiece(found.hrid);
            if (piece) pieces[slot] = piece;
        }
        if (Object.keys(pieces).length > 0) {
            setPieces.push(pieces);
            elementSets.set(element, pieces);
        }
    }

    // Without elemental gear in play (melee, ranged, or a weapon that deals
    // physical damage) fall back to the best armor for the weapon's style
    if (setPieces.length === 0) {
        const pieces = {};
        for (const slot of ARMOR_SLOTS) {
            const top = findTopTierArmor(slot, styleFamily, gameData);
            const piece = top && toPiece(top.hrid);
            if (piece) pieces[slot] = piece;
        }
        if (Object.keys(pieces).length > 0) setPieces.push(pieces);
    }

    // Each slot may be filled from any set; build every combination across them
    const optionsFor = (slot) => {
        const options = [];
        const seenHrids = new Set();
        for (const pieces of [anchorPieces, ...setPieces]) {
            const piece = pieces[slot];
            if (!piece || seenHrids.has(piece.hrid)) continue;
            seenHrids.add(piece.hrid);
            options.push(piece);
        }
        return options;
    };
    const bodyOptions = optionsFor(BODY_SLOT);
    const legsOptions = optionsFor(LEGS_SLOT);

    const assignments = [];
    for (const body of bodyOptions) assignments.push({ [BODY_SLOT]: body });
    for (const legs of legsOptions) assignments.push({ [LEGS_SLOT]: legs });

    // Casting fire spells off a nature weapon leaves the weapon's own element
    // unused — so try the same weapon class in the spells' element, both on its
    // own and wearing that element's robes, which is the build it belongs to
    const weapon = getEquippedWeapon(playerDTO, gameData);
    for (const element of elements) {
        if (!weapon || element === weapon.damageType) continue;
        const swap = findElementalWeapon(weapon, element, gameData);
        const weaponPiece = swap && toPiece(swap.hrid);
        if (!weaponPiece) continue;

        assignments.push({ [weaponPiece.slot]: weaponPiece });

        const robes = elementSets.get(element);
        if (robes?.[BODY_SLOT] && robes?.[LEGS_SLOT]) {
            assignments.push({
                [weaponPiece.slot]: weaponPiece,
                [BODY_SLOT]: robes[BODY_SLOT],
                [LEGS_SLOT]: robes[LEGS_SLOT],
            });
        }
    }

    // The melee cape's defensive stats can beat a style cape on a ranged or magic
    // labyrinth run, so both are always offered — and both at the level of the cape
    // currently worn, since a cape comparison decided by enhancement is no
    // comparison at all
    for (const cape of getCapeOptions(playerDTO, gameData, styleFamily, toPiece)) {
        assignments.push({ [BACK_SLOT]: cape });
    }
    for (const body of bodyOptions) {
        for (const legs of legsOptions) {
            assignments.push({ [BODY_SLOT]: body, [LEGS_SLOT]: legs });
        }
    }

    const candidates = [];
    const seen = new Set();
    for (const assignment of assignments) {
        const key = assignmentKey(assignment);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (isAlreadyEquipped(assignment, playerDTO)) continue;

        const slots = SLOT_ORDER.filter((slot) => assignment[slot]);
        const addedSlots = {};
        const removedItems = [];
        for (const slot of slots) {
            const piece = assignment[slot];
            addedSlots[slot] = { hrid: piece.hrid, enhancementLevel: piece.enhancementLevel };
            const equipped = playerDTO.equipment?.[slot];
            if (equipped?.hrid) {
                removedItems.push({ hrid: equipped.hrid, enhancementLevel: equipped.enhancementLevel || 0 });
            }
        }

        const primarySlot = slots[0];
        const primary = assignment[primarySlot];
        const currentPrimary = playerDTO.equipment?.[primarySlot];

        // Same "current → replacement (+level)" shape as every other row, so a
        // two-piece swap reads as one change instead of its own notation
        const fromNames = slots.map(
            (slot) => gameData.itemDetailMap[playerDTO.equipment?.[slot]?.hrid]?.name || 'empty'
        );
        const toNames = slots.map((slot) => assignment[slot].name);
        const levels = slots.map((slot) => assignment[slot].enhancementLevel);
        const levelPart = levels.every((level) => level === levels[0])
            ? `(+${levels[0]})`
            : `(${levels.map((level) => `+${level}`).join('/')})`;
        const description = `${fromNames.join(' + ')} → ${toNames.join(' + ')} ${levelPart}`;

        candidates.push({
            type: 'cross_slot',
            labArmor: true,
            slot: primarySlot,
            currentHrid: currentPrimary?.hrid ?? null,
            currentLevel: currentPrimary?.enhancementLevel || 0,
            upgradeHrid: primary.hrid,
            upgradeLevel: primary.enhancementLevel,
            addedSlots,
            clearedSlots: [],
            removedItems,
            description,
        });
    }

    return candidates;
}
