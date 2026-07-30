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
const ARMOR_SLOTS = [BODY_SLOT, LEGS_SLOT];

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
    for (const slot of ['/equipment_types/two_hand', '/equipment_types/main_hand']) {
        const equipped = playerDTO?.equipment?.[slot];
        if (!equipped?.hrid) continue;
        const stats = gameData?.itemDetailMap?.[equipped.hrid]?.equipmentDetail?.combatStats;
        const family = styleFamilyOfStats(stats);
        if (family !== 'defensive') return family;
    }
    return 'defensive';
}

/**
 * Enhancement level to sim a piece at: equipped level, else the best copy owned,
 * else the default assumption.
 * @param {string} itemHrid - Item HRID
 * @param {Object} playerDTO - Player DTO (its equipment is the loadout being analyzed)
 * @param {Array<Object>} [inventory] - characterItems from dataManager
 * @returns {number} Enhancement level
 */
export function resolveArmorEnhancement(itemHrid, playerDTO, inventory) {
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
 * Canonical key for a slot assignment, so the same combination generated by two
 * different set pairings is only simmed once.
 * @param {Object} assignment - slot → { hrid, enhancementLevel }
 * @returns {string}
 */
function assignmentKey(assignment) {
    return ARMOR_SLOTS.filter((slot) => assignment[slot])
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
 * Build the forced armor candidates: each set's body and legs alone, each set as a
 * pair, and the cross-set pairs.
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
    const toPiece = (hrid) => {
        const item = gameData.itemDetailMap[hrid];
        const slot = item?.equipmentDetail?.type;
        if (!slot || !ARMOR_SLOTS.includes(slot)) return null;
        return {
            slot,
            hrid,
            name: item.name || hrid.split('/').pop().replace(/_/g, ' '),
            enhancementLevel: resolveArmorEnhancement(hrid, playerDTO, inventory),
        };
    };

    const anchorPieces = {};
    for (const hrid of ANCHORBOUND_HRIDS) {
        const piece = toPiece(hrid);
        if (piece) anchorPieces[piece.slot] = piece;
    }

    const topPieces = {};
    for (const slot of ARMOR_SLOTS) {
        const top = findTopTierArmor(slot, styleFamily, gameData);
        if (!top) continue;
        const piece = toPiece(top.hrid);
        if (piece) topPieces[slot] = piece;
    }

    // Each slot may be filled from either set; build every combination of the two
    const bodyOptions = [anchorPieces[BODY_SLOT], topPieces[BODY_SLOT]].filter(Boolean);
    const legsOptions = [anchorPieces[LEGS_SLOT], topPieces[LEGS_SLOT]].filter(Boolean);

    const assignments = [];
    for (const body of bodyOptions) assignments.push({ [BODY_SLOT]: body });
    for (const legs of legsOptions) assignments.push({ [LEGS_SLOT]: legs });
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

        const slots = ARMOR_SLOTS.filter((slot) => assignment[slot]);
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
        const description =
            slots.length === 1
                ? `${gameData.itemDetailMap[currentPrimary?.hrid]?.name || 'empty'} → ${primary.name} (+${primary.enhancementLevel})`
                : slots.map((slot) => `${assignment[slot].name} +${assignment[slot].enhancementLevel}`).join(' & ');

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
