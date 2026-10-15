/**
 * Check a swap
 *
 * The Lab Simulator's Upgrade and Skilling tabs only ever analyze candidates the
 * advisor generates. This is the other half of the question: "what would
 * Sinister Cape +7 do for me?", asked about a piece the generator may never
 * propose, at a level it would not have picked, across every loadout that has a
 * use for it.
 *
 * A checked swap is built into the same candidate shapes a generated row uses and
 * costed by the same functions, so a swap and a generated row for the same target
 * price identically and read side by side:
 *
 * - Combat: one candidate for the whole run, flagged `checkedSwap` so that
 *   `candidateAppliesToDTO` asks "does this loadout have a use for the slot" and
 *   not the generator's "would this be an upgrade". The all-fights analysis then
 *   measures it against every fight with its assigned loadout.
 * - Skilling: one merged candidate whose members are the same piece written into
 *   each skill kit that can feel it, applied by `applySkillingCandidate`.
 *
 * This module is pure. Running the sims and drawing the tables stay in the panel.
 *
 * @module lab-swap-check
 */

import {
    SIGNIFICANCE_Z,
    attemptsNoise,
    calculateUpgradeCost,
    checkedAbilityAppliesToDTO,
    checkedSwapAppliesToDTO,
    expectedFightAttempts,
    explainLabCandidateCost,
    ownedAbilityLevel,
    valuePerMillion,
} from './upgrade-advisor.js';
import { affectsSkill, isCombatOnlyItem } from './skilling-gear-candidates.js';

/** The highest enhancement level a swap may ask for */
export const MAX_SWAP_LEVEL = 20;

const ALL_SKILLS = [
    '/skills/milking',
    '/skills/foraging',
    '/skills/woodcutting',
    '/skills/cheesesmithing',
    '/skills/crafting',
    '/skills/tailoring',
    '/skills/cooking',
    '/skills/brewing',
    '/skills/alchemy',
    '/skills/enhancing',
];

/** Abilities are checked by their hrid, which starts with this */
const ABILITY_PREFIX = '/abilities/';

/** The queued "Ability order" check: not an ability, but kept in the same queue (it starts with the ability prefix) */
export const ABILITY_ORDER_HRID = '/abilities/__order__';

/** The highest ability level a swap may ask for (the game's cap) */
export const MAX_ABILITY_SWAP_LEVEL = 200;

/**
 * Whether a swap is an ability rather than a piece of equipment.
 * @param {{hrid: string}} swap
 * @returns {boolean}
 */
export function isAbilitySwap(swap) {
    return String(swap?.hrid || '').startsWith(ABILITY_PREFIX);
}

/**
 * Clamp a typed ability level: a whole number from 1 up to the game's cap.
 * @param {*} value - Whatever the box held
 * @returns {number}
 */
export function clampAbilityLevel(value) {
    const level = Math.floor(Number(value));
    if (!Number.isFinite(level)) return 1;
    return Math.min(MAX_ABILITY_SWAP_LEVEL, Math.max(1, level));
}

/**
 * Clamp a typed level for whichever kind of thing the swap is.
 * @param {string} hrid - Item or ability hrid
 * @param {*} value - Whatever the box held
 * @returns {number}
 */
export function clampLevelFor(hrid, value) {
    if (hrid === ABILITY_ORDER_HRID) return 0;
    return String(hrid || '').startsWith(ABILITY_PREFIX) ? clampAbilityLevel(value) : clampSwapLevel(value);
}

/** The most swaps a tab keeps queued; each one costs a full set of simulations */
export const MAX_QUEUED_SWAPS = 12;

/**
 * A swap is `{ hrid, level }`. Which one it is, for de-duplicating and removing.
 * @param {{hrid: string, level: number}} swap
 * @returns {string}
 */
export function checkedSwapKey(swap) {
    return `${swap.hrid}@${swap.level}`;
}

/**
 * Clamp a typed level into a whole number the game can have.
 * @param {*} value - Whatever the box held
 * @returns {number} 0..MAX_SWAP_LEVEL
 */
export function clampSwapLevel(value) {
    const level = Math.floor(Number(value));
    if (!Number.isFinite(level)) return 0;
    return Math.min(MAX_SWAP_LEVEL, Math.max(0, level));
}

/**
 * Bring a remembered queue back into shape.
 *
 * What comes out of storage is whatever an older build or a hand edit left there,
 * so every entry is checked: an unknown item stays (game data may not be loaded
 * yet when this runs, and a chip for an item the game later renames is harmless),
 * but a malformed one is dropped, levels are clamped, and repeats collapse.
 *
 * @param {*} raw - The stored value
 * @returns {{combat: Array<{hrid: string, level: number}>, skilling: Array<{hrid: string, level: number}>}}
 */
export function sanitizeSwapQueues(raw) {
    const clean = (list, allowAbilities = false) => {
        const seen = new Set();
        const out = [];
        for (const entry of Array.isArray(list) ? list : []) {
            if (!entry || typeof entry.hrid !== 'string') continue;
            const isItem = entry.hrid.startsWith('/items/');
            if (!isItem && !(allowAbilities && entry.hrid.startsWith(ABILITY_PREFIX))) continue;
            const swap = { hrid: entry.hrid, level: clampLevelFor(entry.hrid, entry.level) };
            const key = checkedSwapKey(swap);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(swap);
            if (out.length >= MAX_QUEUED_SWAPS) break;
        }
        return out;
    };
    return { combat: clean(raw?.combat, true), skilling: clean(raw?.skilling) };
}

/**
 * Bring the remembered Check a swap options back into shape: for each tab, whether
 * "All loadouts" is ticked and whether the section was left open (null when it was
 * never toggled, so the default applies), and whether each tab's generated Upgrades
 * results are shown (true unless left collapsed).
 * @param {*} raw - The stored `options`
 * @returns {{all: {combat: boolean, skilling: boolean}, open: {combat: boolean|null, skilling: boolean|null}, upgradesOpen: {combat: boolean, skilling: boolean}, checkedOpen: {combat: boolean, skilling: boolean}}}
 */
export function sanitizeSwapOptions(raw) {
    const flag = (value) => (typeof value === 'boolean' ? value : null);
    return {
        all: { combat: raw?.all?.combat === true, skilling: raw?.all?.skilling === true },
        open: { combat: flag(raw?.open?.combat), skilling: flag(raw?.open?.skilling) },
        // The generated Upgrades results beside the section: open unless left closed
        upgradesOpen: { combat: raw?.upgradesOpen?.combat !== false, skilling: raw?.upgradesOpen?.skilling !== false },
        // The Checked swaps results below it: open unless left closed
        checkedOpen: { combat: raw?.checkedOpen?.combat !== false, skilling: raw?.checkedOpen?.skilling !== false },
    };
}

/**
 * The display name of an item.
 * @param {string} hrid - Item hrid
 * @param {Object} gameData - Game data payload
 * @returns {string}
 */
export function swapItemName(hrid, gameData) {
    if (hrid === ABILITY_ORDER_HRID) return 'Ability order';
    return (
        gameData?.itemDetailMap?.[hrid]?.name ||
        gameData?.abilityDetailMap?.[hrid]?.name ||
        String(hrid || '')
            .split('/')
            .pop()
            .replace(/_/g, ' ')
    );
}

/**
 * The text of a chip: "Sinister Cape +7".
 * @param {{hrid: string, level: number}} swap
 * @param {Object} gameData - Game data payload
 * @returns {string}
 */
export function describeCheckedSwap(swap, gameData) {
    if (swap.hrid === ABILITY_ORDER_HRID) return 'Ability order';
    // An ability has a level, not an enhancement: "Critical Aura 7"
    if (isAbilitySwap(swap)) return `${swapItemName(swap.hrid, gameData)} ${swap.level}`;
    return `${swapItemName(swap.hrid, gameData)} +${swap.level}`;
}

/**
 * Every item that can be worn, by name, for the picker.
 * @param {Object} gameData - Game data payload
 * @returns {Array<{hrid: string, name: string, slot: string}>}
 */
export function listEquipmentItems(gameData) {
    const items = [];
    for (const [hrid, detail] of Object.entries(gameData?.itemDetailMap || {})) {
        const slot = detail?.equipmentDetail?.type;
        if (!slot || !detail.name) continue;
        items.push({ hrid, name: detail.name, slot });
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Equipment whose name contains what was typed, names that start with it first.
 * @param {Object} gameData - Game data payload
 * @param {string} query - Typed text
 * @param {number} [limit=30] - Most results
 * @returns {Array<{hrid: string, name: string, slot: string}>}
 */
export function searchEquipmentItems(gameData, query, limit = 30) {
    const needle = String(query || '')
        .trim()
        .toLowerCase();
    if (!needle) return [];
    const matches = listEquipmentItems(gameData).filter((item) => item.name.toLowerCase().includes(needle));
    matches.sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
    });
    return matches.slice(0, limit);
}

/**
 * The item a typed name means, or null when it names none or several.
 *
 * An exact name wins outright; otherwise the text has to narrow the list to one
 * item, so "sinister" resolves and "cape" does not. A bare hrid also resolves.
 *
 * @param {Object} gameData - Game data payload
 * @param {string} text - What the picker holds
 * @returns {string|null} Item hrid
 */
export function resolveEquipmentHrid(gameData, text) {
    const typed = String(text || '').trim();
    if (!typed) return null;
    if (gameData?.itemDetailMap?.[typed]?.equipmentDetail?.type) return typed;
    const lower = typed.toLowerCase();
    const items = listEquipmentItems(gameData);
    const exact = items.filter((item) => item.name.toLowerCase() === lower);
    if (exact.length === 1) return exact[0].hrid;
    if (exact.length > 1) return null;
    const partial = items.filter((item) => item.name.toLowerCase().includes(lower));
    return partial.length === 1 ? partial[0].hrid : null;
}

/**
 * Every ability, by name, for the picker.
 * @param {Object} gameData - Game data payload
 * @returns {Array<{hrid: string, name: string}>}
 */
export function listAbilities(gameData) {
    const abilities = [];
    for (const [hrid, detail] of Object.entries(gameData?.abilityDetailMap || {})) {
        if (!detail?.name) continue;
        abilities.push({ hrid, name: detail.name });
    }
    return abilities.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Abilities whose name contains what was typed, names that start with it first.
 * @param {Object} gameData - Game data payload
 * @param {string} query - Typed text
 * @param {number} [limit=30] - Most results
 * @returns {Array<{hrid: string, name: string}>}
 */
export function searchAbilities(gameData, query, limit = 30) {
    const needle = String(query || '')
        .trim()
        .toLowerCase();
    if (!needle) return [];
    const matches = listAbilities(gameData).filter((ability) => ability.name.toLowerCase().includes(needle));
    matches.sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
    });
    return matches.slice(0, limit);
}

/**
 * The ability a typed name means, or null when it names none or several: the
 * game's English name in any case, the hrid tail ("critical_aura") or the full
 * hrid; otherwise the text has to narrow the list to one ability.
 * @param {Object} gameData - Game data payload
 * @param {string} text - What the picker holds
 * @returns {string|null} Ability hrid
 */
export function resolveAbilityHrid(gameData, text) {
    const typed = String(text || '').trim();
    if (!typed) return null;
    const map = gameData?.abilityDetailMap || {};
    if (map[typed]) return typed;
    const lower = typed.toLowerCase();
    const byTail = `${ABILITY_PREFIX}${lower.replace(/\s+/g, '_')}`;
    const abilities = listAbilities(gameData);
    const exact = abilities.filter((ability) => ability.name.toLowerCase() === lower);
    if (exact.length === 1) return exact[0].hrid;
    if (exact.length > 1) return null;
    if (map[byTail]) return byTail;
    const partial = abilities.filter((ability) => ability.name.toLowerCase().includes(lower));
    return partial.length === 1 ? partial[0].hrid : null;
}

/**
 * What a Check a swap box means: a piece of equipment first, otherwise an ability.
 * @param {Object} gameData - Game data payload
 * @param {string} text - What the picker holds
 * @returns {string|null} Item hrid or ability hrid
 */
export function resolveSwapHrid(gameData, text) {
    if (/^(ability |abilities )?order$/i.test(String(text || '').trim())) return ABILITY_ORDER_HRID;
    return resolveEquipmentHrid(gameData, text) || resolveAbilityHrid(gameData, text);
}

/**
 * The slot an item is worn in.
 * @param {string} hrid - Item hrid
 * @param {Object} gameData - Game data payload
 * @returns {string|null} e.g. `/equipment_types/back`
 */
export function swapSlot(hrid, gameData) {
    return gameData?.itemDetailMap?.[hrid]?.equipmentDetail?.type || null;
}

/**
 * The candidate fields that describe how the swap is bought, given what is worn.
 *
 * The same two routes the generator uses. When some loadout already wears the
 * item at a lower level this is an enhance of that copy (`enhancement`), which
 * `calculateUpgradeCost` prices as the self-enhance ladder, a market delta, a
 * mirror or a refine route as the item allows. When nothing wears it, it is a
 * purchase of the target level less the resale of whatever it replaces (`tier`).
 *
 * @param {Object} swap - `{ hrid, level }`
 * @param {Array<{hrid: string, level: number}>} worn - What each reached kit wears in the slot, `null` for bare
 * @param {Object} gameData - Game data payload
 * @returns {Object} `{ type, currentHrid, currentLevel, description, route }`
 */
function routeFor(swap, worn, gameData) {
    const name = swapItemName(swap.hrid, gameData);
    const sameItem = worn.filter((piece) => piece && piece.hrid === swap.hrid && piece.level < swap.level);
    if (sameItem.length) {
        const best = sameItem.reduce((top, piece) => (piece.level > top.level ? piece : top));
        return {
            type: 'enhancement',
            currentHrid: swap.hrid,
            currentLevel: best.level,
            description: `${name} +${best.level} → +${swap.level}`,
            route: 'enhance',
        };
    }
    // The most commonly worn replacement stands for the purchase's resale credit
    const counts = new Map();
    for (const piece of worn) {
        if (!piece || piece.hrid === swap.hrid) continue;
        const key = `${piece.hrid}@${piece.level}`;
        counts.set(key, { piece, count: (counts.get(key)?.count || 0) + 1 });
    }
    const top = [...counts.values()].sort((a, b) => b.count - a.count)[0]?.piece || null;
    if (!top) {
        return {
            type: 'tier',
            currentHrid: '',
            currentLevel: 0,
            description: `${name} +${swap.level}`,
            route: 'fill',
        };
    }
    return {
        type: 'tier',
        currentHrid: top.hrid,
        currentLevel: top.level,
        description: `${swapItemName(top.hrid, gameData)} +${top.level} → ${name} +${swap.level}`,
        route: 'swap',
    };
}

/**
 * Why a row is priced the way it is, in one sentence.
 * @param {string} route - `enhance`, `swap` or `fill`
 * @returns {string}
 */
function routeCaveat(route) {
    if (route === 'enhance') {
        return (
            'Checked by hand. Priced as enhancing the copy you wear to this level, by whichever route is cheapest ' +
            '(a held spare, a refine, a mirror, or enhancing it).'
        );
    }
    if (route === 'swap') {
        return 'Checked by hand. Priced as buying it at this level, less what the piece it replaces would sell for.';
    }
    return 'Checked by hand. Priced as buying it at this level; nothing in the slot is sold.';
}

const KEPT_CAVEAT =
    ' The piece it replaces is still worn by a loadout this swap does not reach, so its resale is not credited.';

/**
 * Every piece the swap replaces, split into what is sold and what is kept.
 *
 * The swap reaches several loadouts, and they may wear different pieces in the
 * slot: each distinct piece (by item and level) is replaced somewhere and so is
 * credited once. A piece that a loadout the swap does not reach still wears is
 * kept, not sold, and the item being bought is never its own replacement.
 *
 * @param {Object} swap - `{ hrid, level }`
 * @param {string} routeName - From `routeFor`; only a `swap` replaces anything
 * @param {Array<Object|null|undefined>} reachedPieces - `{ hrid, level }` worn in the slot by the loadouts reached
 * @param {Array<Object|null|undefined>} unreachedPieces - `{ hrid, enhancementLevel }` worn by the loadouts left out
 * @returns {{removed: Array<{hrid: string, enhancementLevel: number}>, kept: Array<{hrid: string, enhancementLevel: number}>}|null}
 */
function replacedPieces(swap, routeName, reachedPieces, unreachedPieces) {
    if (routeName !== 'swap') return null;
    const stillWorn = (hrid, level) =>
        unreachedPieces.some((piece) => piece?.hrid === hrid && (piece.enhancementLevel || 0) === level);
    const seen = new Set();
    const removed = [];
    const kept = [];
    for (const piece of reachedPieces) {
        if (!piece?.hrid || piece.hrid === swap.hrid) continue;
        const key = `${piece.hrid}@${piece.level}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const item = { hrid: piece.hrid, enhancementLevel: piece.level };
        (stillWorn(piece.hrid, piece.level) ? kept : removed).push(item);
    }
    return { removed, kept };
}

const OWNED_CAVEAT =
    'Checked by hand. You already wear a copy at exactly this level in another loadout, and the loadouts are ' +
    'alternatives, so the piece is moved and nothing is bought.';

/**
 * Whether a worn piece is this item at the level asked for or higher.
 * @param {Object|null|undefined} piece - `{ hrid, enhancementLevel }`
 * @param {{hrid: string, level: number}} swap
 * @returns {boolean}
 */
function wornAtLeast(piece, swap) {
    return piece?.hrid === swap.hrid && (piece.enhancementLevel || 0) >= swap.level;
}

/**
 * Whether a worn piece is this item at exactly the level asked for. Only such a copy
 * can be reused as the checked piece: a higher one would be simulated as the lower
 * level, which is a downgraded copy, so it is not treated as owned.
 * @param {Object|null|undefined} piece - `{ hrid, enhancementLevel }`
 * @param {{hrid: string, level: number}} swap
 * @returns {boolean}
 */
function wornExactly(piece, swap) {
    return piece?.hrid === swap.hrid && (piece.enhancementLevel || 0) === swap.level;
}

/**
 * A checked swap as a whole-run combat candidate.
 *
 * Its reach is every loadout `checkedSwapAppliesToDTO` accepts, and the cost is
 * computed once, from the most common piece it would replace, the way a pooled
 * generated row is. A swap that reaches no loadout is still returned, with
 * `reach: 0`, so the caller can say so instead of silently dropping it.
 *
 * @param {{hrid: string, level: number}} swap - What to check
 * @param {Array<Object>} dtos - The loadout of every fight in the run
 * @param {Object} gameData - Game data payload
 * @param {boolean} [isSelf=true] - Whether the loadouts are the live character's
 * @param {Object} [options] - `{ allLoadouts, ownershipDtos }`: `allLoadouts` reaches every loadout with the
 *   slot, whatever its style; `ownershipDtos` is every loadout the character has (default `dtos`), which
 *   is what "already owned" and "still worn elsewhere" read, while reach reads `dtos` alone
 * @returns {Object|null} A candidate, or null when the item has no equipment slot
 */
export function buildCombatSwapCandidate(swap, dtos, gameData, isSelf = true, options = {}) {
    const slot = swapSlot(swap.hrid, gameData);
    if (!slot) return null;
    const allLoadouts = Boolean(options.allLoadouts);
    const base = { slot, upgradeHrid: swap.hrid, upgradeLevel: swap.level, allLoadouts };
    const reached = (dtos || []).filter((dto) => checkedSwapAppliesToDTO(base, dto, gameData));
    // What the character holds: the simulated fights may be a subset of their loadouts
    const owned = options.ownershipDtos || dtos || [];
    const worn = reached.map((dto) => {
        const piece = dto.equipment?.[slot];
        return piece?.hrid ? { hrid: piece.hrid, level: piece.enhancementLevel || 0 } : null;
    });
    const route = routeFor(swap, worn, gameData);
    const candidate = {
        slot,
        currentHrid: route.currentHrid,
        currentLevel: route.currentLevel,
        upgradeHrid: swap.hrid,
        upgradeLevel: swap.level,
        description: route.description,
        type: route.type,
        checkedSwap: true,
        allLoadouts,
        // Whose copies priced it, so a breakdown built later reads the same inventory
        isSelf,
        pricingNote: routeCaveat(route.route),
        reach: reached.length,
    };
    // One physical piece serves every loadout (they are alternatives, not worn
    // together), so a copy already worn at this level in any loadout is owned
    if (owned.some((dto) => wornExactly(dto?.equipment?.[slot], swap))) {
        candidate.cost = 0;
        candidate.noPurchase = true;
        candidate.pricingNote = OWNED_CAVEAT;
    } else {
        // A replaced piece that a loadout the swap does not reach still wears
        // cannot be sold to fund it
        const replaced = replacedPieces(
            swap,
            route.route,
            worn,
            owned.filter((dto) => !reached.includes(dto)).map((dto) => dto?.equipment?.[slot])
        );
        if (replaced) {
            // Each distinct piece replaced in a reached loadout is sold once
            candidate.removedItems = replaced.removed;
            if (replaced.kept.length) {
                candidate.keptItems = replaced.kept;
                candidate.pricingNote += KEPT_CAVEAT;
            }
        }
        candidate.cost = calculateUpgradeCost(candidate, gameData, isSelf);
    }
    return candidate;
}

/**
 * A checked swap as a Skilling row's candidate: the piece written into every skill
 * kit that can feel it.
 *
 * "Can feel it" is `affectsSkill`: the item carries a stat that skill's room reads
 * (its own speed or efficiency, or the generic skilling ones). A tool for another
 * skill, or a combat piece, reaches none of the kits. A kit already wearing the
 * item at that level or higher is left out, and a skill outside the run's scope is
 * never reached. Its kit still counts for what the character holds: a copy it wears at
 * the level asked for is owned, and a piece it wears is kept rather than sold. Each member names its skill, so `applyToEquipment` writes it
 * into that kit alone, and into a kit of its own for a skill that was running in
 * the base one.
 *
 * @param {{hrid: string, level: number}} swap - What to check
 * @param {Object} context - `{ dto, skillEquipmentMap, skills }` where `skills` are the skill hrids in scope
 * @param {Object} gameData - Game data payload
 * @param {boolean} [isSelf=true] - Whether the kits are the live character's
 * @param {Object} [options] - `{ allLoadouts }`: reach every kit in scope, whichever skill the item is for
 * @returns {Object|null} A merged candidate, or null when no kit in scope can feel the item
 */
export function buildSkillingSwapCandidate(swap, context, gameData, isSelf = true, options = {}) {
    const detail = gameData?.itemDetailMap?.[swap.hrid];
    const slot = detail?.equipmentDetail?.type;
    if (!slot) return null;
    const { dto, skillEquipmentMap = {}, skills = [] } = context;

    // "All loadouts" waives which skill an item is for, but not whether it is for
    // any skill at all: a piece with no skilling stats moves no room
    const allLoadouts = Boolean(options.allLoadouts);
    if (allLoadouts && !ALL_SKILLS.some((skill) => affectsSkill(detail, skill))) return null;
    const kitOf = (skill) => skillEquipmentMap[skill] || dto?.equipment || {};
    // Every kit the character has, the skills outside this run's scope included: a kit
    // the filter or a skipped room leaves out still holds its pieces
    const everySkill = [...new Set([...ALL_SKILLS, ...skills, ...Object.keys(skillEquipmentMap)])];
    // One physical piece serves every kit (they are alternatives), so a copy worn at
    // exactly this level in any kit, or in the base equipment, is owned
    const owned = [...everySkill.map((skill) => kitOf(skill)[slot]), dto?.equipment?.[slot]].some((piece) =>
        wornExactly(piece, swap)
    );
    const reached = [];
    for (const skill of skills) {
        const piece = kitOf(skill)[slot];
        // Already that good here; only an exact-level copy can be moved to the others
        if (wornAtLeast(piece, swap)) continue;
        if (!allLoadouts && !affectsSkill(detail, skill)) continue;
        reached.push({ skill, piece });
    }
    if (!reached.length) return null;

    const worn = reached.map(({ piece }) =>
        piece?.hrid ? { hrid: piece.hrid, level: piece.enhancementLevel || 0 } : null
    );
    const route = routeFor(swap, worn, gameData);
    const scope = reached.map(({ skill }) => String(skill).replace('/skills/', '')).join(', ');

    const members = reached.map(({ skill, piece }) => ({
        skillKey: skill,
        slot,
        currentHrid: piece?.hrid || '',
        currentLevel: piece?.enhancementLevel || 0,
        upgradeHrid: swap.hrid,
        upgradeLevel: swap.level,
        description: route.description,
        type: 'skilling_gear',
    }));

    // Priced as one purchase. A skilling piece never pays for itself out of combat
    // armor (see `bestGearForSkill`), so a replaced combat-only piece is kept
    const priced = {
        slot,
        currentHrid: route.currentHrid,
        currentLevel: route.currentLevel,
        upgradeHrid: swap.hrid,
        upgradeLevel: swap.level,
        description: route.description,
        type: route.type,
    };
    const unreachedPieces = everySkill
        .filter((skill) => !reached.some((entry) => entry.skill === skill))
        .map((skill) => kitOf(skill)[slot]);
    const replaced = replacedPieces(swap, route.route, worn, unreachedPieces);
    if (replaced) {
        // Combat armor is never sold to fund a skilling piece; it goes back in its loadout
        const combatOnly = (item) => isCombatOnlyItem(gameData.itemDetailMap[item.hrid]);
        const keptCombat = replaced.removed.filter(combatOnly);
        const kept = [...replaced.kept, ...keptCombat];
        priced.removedItems = replaced.removed.filter((item) => !combatOnly(item));
        if (kept.length) priced.keptItems = kept;
        // Why each kept piece is kept, so the row can say so: another kit wears it, or it is combat armor
        if (replaced.kept.length) priced.keptUnreached = true;
        if (keptCombat.length) priced.keptCombat = true;
    }
    // A kit already wearing the piece at this level owns it; the others reuse that copy
    const cost = owned ? 0 : calculateUpgradeCost(priced, gameData, isSelf);
    const costDetail = owned ? null : explainLabCandidateCost(priced, gameData, isSelf);

    return {
        ...priced,
        description: `${route.description} (${scope})`,
        skillKey: undefined,
        skillKeys: reached.map(({ skill }) => skill),
        members,
        merged: true,
        checkedSwap: true,
        isSelf,
        pricingNote: owned ? OWNED_CAVEAT : routeCaveat(route.route),
        // Nothing to buy when an owned copy is moved: no Save/Watch/Market actions
        noPurchase: owned,
        allLoadouts,
        cost,
        costDetail,
    };
}

/**
 * Measure checked swaps on the Skilling tab: the clear rate with each one in, and
 * what it is worth per point.
 *
 * Rows come back in the shape `runSkillingUpgradeAnalysis` gives a gold row, so
 * the Skilling table draws them without knowing the difference; the caller runs
 * `annotateRoomsReached` over them for the Rooms, Tries and breakdown columns.
 *
 * @param {Object} params
 * @param {Array<{hrid: string, level: number}>} params.swaps - The queue
 * @param {{dto: Object, skillEquipmentMap: Object}} params.baseSetup - What the table is measured from
 * @param {Function} params.evaluate - `createSkillingEvaluator(...)`
 * @param {Function} params.applySetup - `applySkillingCandidate`
 * @param {number|Object} params.roomLevel - What the table is measured at
 * @param {string[]} params.skills - Skill hrids in scope
 * @param {Object} params.gameData - Game data payload
 * @param {Function} [params.abortSignal] - Polled between swaps
 * @param {Function} [params.onProgress] - `({ current, total, description })`
 * @param {boolean} [params.allLoadouts=false] - Waive which skill each item is for
 * @param {function(): Promise<void>} [params.yieldFn] - Awaited between swaps so the page can paint
 * @returns {Promise<{baseline: {clearRate: number, xpPerRoom: number}, rows: Array<Object>, unreached: Array<Object>}>}
 *   `unreached` are the swaps no kit in scope can feel
 */
export async function evaluateSkillingSwaps({
    swaps,
    baseSetup,
    evaluate,
    applySetup,
    roomLevel,
    skills,
    gameData,
    abortSignal = null,
    onProgress = null,
    allLoadouts = false,
    yieldFn = () => new Promise((resolve) => setTimeout(resolve, 0)),
}) {
    const baselineRates = evaluate(baseSetup, roomLevel);
    const baseline = { clearRate: baselineRates.clearRate, xpPerRoom: baselineRates.xpPerRoom || 0 };
    const rows = [];
    const unreached = [];
    let current = 0;
    for (const swap of swaps) {
        if (abortSignal?.()) break;
        await yieldFn();
        onProgress?.({ current, total: swaps.length, description: describeCheckedSwap(swap, gameData) });
        const candidate = buildSkillingSwapCandidate(
            swap,
            { dto: baseSetup.dto, skillEquipmentMap: baseSetup.skillEquipmentMap, skills },
            gameData,
            true,
            { allLoadouts }
        );
        current++;
        if (!candidate) {
            unreached.push(swap);
            continue;
        }
        const after = evaluate(applySetup(baseSetup, candidate), roomLevel);
        const clearRateDelta = after.clearRate - baseline.clearRate;
        rows.push({
            candidate,
            costType: 'gold',
            cost: candidate.cost,
            costDetail: candidate.costDetail ?? null,
            clearRate: after.clearRate,
            clearRateDelta,
            goldPerClearRate:
                clearRateDelta > 1e-9 && candidate.cost != null ? candidate.cost / (clearRateDelta * 100) : Infinity,
            metricType: 'clearRate',
        });
    }
    return { baseline, rows, unreached };
}

/**
 * The abilities that are always ready (no cooldown), from game data.
 * @param {Object} gameData - Game data payload
 * @returns {string[]} Ability hrids with `cooldownDuration === 0`
 */
export function zeroCooldownAbilities(gameData) {
    return Object.entries(gameData?.abilityDetailMap || {})
        .filter(([, detail]) => detail?.cooldownDuration === 0)
        .map(([hrid]) => hrid);
}

/**
 * A checked ability as combat candidates: one per way it could go onto a bar.
 *
 * "Try each, show best." The ability is simulated in place of each ability the
 * reached loadouts cast (one option per distinct ability replaced), in a free
 * slot where a loadout has one, and, where a loadout already casts it below the
 * level asked, as a level-up of that copy. A loadout casting it at the level
 * asked or higher is reached by no option and is counted in `alreadyEquipped`.
 * Slot kind follows the game: a special ability (an aura) only ever takes slot 0
 * and an ordinary one never does. `mergeCheckedAbilityRows` folds the options'
 * rows back into one row with the best option per loadout.
 *
 * The cost is the ability books from the character's current level to the level
 * asked (none when already there), the same price an ability-swap row gets.
 *
 * @param {{hrid: string, level: number}} swap - What to check (an ability hrid)
 * @param {Array<Object>} dtos - The loadout of every fight in the run
 * @param {Object} gameData - Game data payload
 * @param {boolean} [isSelf=true] - Whether the loadouts are the live character's
 * @param {Object} [options] - `{ allLoadouts }`: waive the weapon-style test for ordinary abilities
 * @returns {{candidates: Array<Object>, reach: number, alreadyEquipped: number, key: string}|null}
 *   Null when the ability is unknown
 */
export function buildCombatAbilityCandidates(swap, dtos, gameData, isSelf = true, options = {}) {
    const detail = gameData?.abilityDetailMap?.[swap.hrid];
    if (!detail) return null;
    const typedLevel = clampAbilityLevel(swap.level);
    // What they would actually equip: a character holding the ability above the
    // typed level keeps theirs, so that is what gets simulated. The books are
    // then from the current level to the typed one, none when already past it.
    const ownedLevel = ownedAbilityLevel(swap.hrid, isSelf);
    const level = Math.max(typedLevel, ownedLevel);
    const special = Boolean(detail.isSpecialAbility);
    const allLoadouts = Boolean(options.allLoadouts);
    const key = `${swap.hrid}@${typedLevel}`;
    const name = swapItemName(swap.hrid, gameData);
    const loadouts = (dtos || []).filter(Boolean);

    const base = {
        type: 'ability_swap',
        checkedAbility: true,
        checkedAbilityKey: key,
        upgradeHrid: swap.hrid,
        upgradeLevel: level,
        specialAbility: special,
        // Abilities that are always ready: they must sit after every ability with a cooldown
        zeroCooldownHrids: zeroCooldownAbilities(gameData),
        allLoadouts,
        isSelf,
        description: level === typedLevel ? `${name} ${level}` : `${name} ${level}, you have it at ${ownedLevel}`,
    };
    base.cost = calculateUpgradeCost({ ...base }, gameData, isSelf);

    // Free-slot and level-up first, so an exact tie prefers the option that costs a loadout nothing
    const tried = [
        { ...base, slot: `ability_${special ? 0 : 1}`, fillsFreeSlot: true, optionId: 'fill' },
        { ...base, slot: 'ability_1', levelUp: true, optionId: 'levelup' },
    ];
    const replaced = new Map();
    for (const dto of loadouts) {
        (dto.abilities || []).forEach((ability, index) => {
            if (!ability?.hrid || ability.hrid === swap.hrid || replaced.has(ability.hrid)) return;
            replaced.set(ability.hrid, index);
        });
    }
    for (const [replacesHrid, index] of replaced) {
        tried.push({
            ...base,
            slot: `ability_${index}`,
            replacesHrid,
            currentHrid: replacesHrid,
            optionId: `replace:${replacesHrid}`,
        });
    }
    for (const option of tried) {
        option.poolKey = `checked_ability:${key}:${option.optionId}`;
        option.optionLabel = option.fillsFreeSlot
            ? 'a free slot'
            : option.levelUp
              ? 'its own copy'
              : swapItemName(option.replacesHrid, gameData);
        option.caveat =
            'Checked by hand. Tried in place of each ability the loadout casts and in a free slot, with default ' +
            'triggers; each loadout shows the best of those. The cost is the ability books from your current ' +
            'level to this one.';
    }

    const candidates = tried.filter((option) =>
        loadouts.some((dto) => checkedAbilityAppliesToDTO(option, dto, gameData))
    );
    const reach = loadouts.filter((dto) =>
        candidates.some((option) => checkedAbilityAppliesToDTO(option, dto, gameData))
    ).length;
    const alreadyEquipped = loadouts.filter((dto) =>
        (dto.abilities || []).some((ability) => ability?.hrid === swap.hrid && (ability.level || 0) >= level)
    ).length;
    return { candidates, reach, alreadyEquipped, key };
}

/**
 * For each fight, the option row its saved loadout should use. Fights sharing a saved loadout
 * (`loadoutId`) share one choice: the option minimizing the summed expected attempts over that
 * loadout's fights, where a fight the option does not apply to counts at its baseline win rate.
 * Ties go to the earlier option. A fight with no saved loadout is its own group. An option that
 * applies to none of a group's fights is never chosen for it.
 * @param {Array<Object>} rows - One row per option
 * @param {Object} baseline - The analysis baseline
 * @param {Array<Object>} [contextFights] - The run's fights, parallel to `baseline.fights`
 * @returns {Array<Object|null>} The chosen row per fight index, null where nothing applies
 */
function chooseRowPerLoadout(rows, baseline, contextFights) {
    const groups = new Map();
    baseline.fights.forEach((_baseFight, i) => {
        // 0 is the worn gear, which every fight without a saved loadout shares; a fight that says
        // nothing about its loadout (undefined or null) stands alone
        const raw = contextFights?.[i]?.loadoutId;
        const id = Number(raw) || 0;
        const key = raw === undefined || raw === null ? `fight:${i}` : id > 0 ? `loadout:${id}` : 'current-gear';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(i);
    });
    const chosen = new Array(baseline.fights.length).fill(null);
    for (const indexes of groups.values()) {
        let bestRow = null;
        let bestAttempts = Infinity;
        for (const row of rows) {
            if (!indexes.some((i) => row.fights[i]?.applied)) continue;
            const attempts = indexes.reduce((sum, i) => {
                const fight = row.fights[i];
                return sum + expectedFightAttempts(fight?.applied ? fight.winRate : baseline.fights[i].winRate);
            }, 0);
            // Keeping the current order is free and exact, so it wins a tie
            const tiesForKeep =
                attempts === bestAttempts && row.candidate?.keepCurrent && !bestRow?.candidate?.keepCurrent;
            if (attempts < bestAttempts || tiesForKeep) {
                bestAttempts = attempts;
                bestRow = row;
            }
        }
        for (const i of indexes) chosen[i] = bestRow && bestRow.fights[i]?.applied ? bestRow : null;
    }
    return chosen;
}

/**
 * Fold the per-option rows of checked abilities into one row each.
 *
 * Each saved loadout keeps one option across every fight it covers (fewest summed
 * expected attempts; ties go to the earlier option); a loadout no option reached keeps its baseline, and one
 * already casting the ability is named as such. The row's totals are then worked
 * out the way the analysis works them out for any row. Rows that are not checked
 * abilities pass through untouched.
 *
 * @param {{baseline: Object, results: Array<Object>, context?: Object}} analysis - From `runLabyrinthAllFightsAnalysis`
 * @param {Object} gameData - Game data payload
 * @returns {Object} The same analysis with its results replaced
 */
export function mergeCheckedAbilityRows(analysis, gameData) {
    const { baseline } = analysis || {};
    if (!baseline || !Array.isArray(analysis.results)) return analysis;
    const groups = new Map();
    const passthrough = [];
    for (const row of analysis.results) {
        const key = row.candidate?.checkedAbilityKey;
        if (!key) {
            passthrough.push(row);
            continue;
        }
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    if (!groups.size) return analysis;

    const merged = [];
    for (const rows of groups.values()) {
        const first = rows[0].candidate;
        const level = first.upgradeLevel;
        // A saved loadout has one ability configuration, so every fight it covers takes the same
        // option: the one with the fewest summed expected attempts (the Lab objective). Fights with
        // no saved loadout each stand alone.
        const chosenRowByFight = chooseRowPerLoadout(rows, baseline, analysis.context?.fights);
        const fights = baseline.fights.map((baseFight, i) => {
            const bestRow = chosenRowByFight[i];
            const best = bestRow ? bestRow.fights[i] : null;
            if (best && bestRow.candidate.keepCurrent) {
                // The order the loadout has now is its best: no change, measured by the baseline itself
                return {
                    ...best,
                    winRate: baseFight.winRate,
                    trials: baseFight.trials ?? best.trials,
                    winRateDelta: 0,
                    note: bestRow.candidate.fightNote,
                    chosenOption: bestRow.candidate,
                };
            }
            if (best) {
                const option = bestRow.candidate;
                return option.fightNote
                    ? { ...best, note: option.fightNote, chosenOption: option }
                    : { ...best, replaced: option.optionLabel, chosenOption: option };
            }
            const dto = analysis.context?.fights?.[i]?.dto;
            const owned = (dto?.abilities || []).find((ability) => ability?.hrid === first.upgradeHrid);
            const skip =
                owned && (owned.level || 0) >= level ? { skipReason: `already equipped at ${owned.level}` } : {};
            return {
                monsterHrid: baseFight.monsterHrid,
                monsterName: baseFight.monsterName,
                roomLevel: baseFight.roomLevel,
                loadoutName: baseFight.loadoutName,
                winRate: baseFight.winRate,
                winRateDelta: 0,
                applied: false,
                ...skip,
            };
        });
        const applied = fights.filter((fight) => fight.applied);
        const runClearChance = fights.reduce((product, fight) => product * fight.winRate, 1);
        const expectedAttempts = fights.reduce((sum, fight) => sum + expectedFightAttempts(fight.winRate), 0);
        const attemptsDelta = expectedAttempts - baseline.expectedAttempts;
        const noise = attemptsNoise(applied, baseline.fights);
        const avgWinDelta = applied.reduce((sum, fight) => sum + fight.winRateDelta, 0) / (applied.length || 1);
        const cost = rows[0].cost;

        const parts = [];
        for (const fight of applied) {
            const option = fight.chosenOption;
            const part =
                option.partLabel ||
                (option.fillsFreeSlot ? 'free slot' : option.levelUp ? 'level-up' : `replaces ${option.optionLabel}`);
            if (!parts.includes(part)) parts.push(part);
        }
        const shown = parts.slice(0, 3).join(', ') + (parts.length > 3 ? `, +${parts.length - 3} more` : '');
        const candidate = {
            ...first,
            description: parts.length ? `${first.description} (${shown})` : first.description,
        };
        delete candidate.poolKey;
        delete candidate.optionLabel;
        delete candidate.optionId;
        delete candidate.replacesHrid;
        delete candidate.currentHrid;
        delete candidate.fillsFreeSlot;
        delete candidate.levelUp;
        delete candidate.order;
        delete candidate.partLabel;
        delete candidate.fightNote;
        delete candidate.keepCurrent;
        for (const fight of fights) delete fight.chosenOption;

        const attemptsSaved = -attemptsDelta;
        merged.push({
            candidate,
            fights,
            costType: 'gold',
            tokenCost: null,
            costDetail: first.abilityOrder
                ? null
                : explainLabCandidateCost({ ...first }, gameData, first.isSelf !== false),
            appliedFights: applied.length,
            runClearChance,
            runClearDelta: runClearChance - baseline.runClearChance,
            expectedAttempts,
            attemptsDelta,
            attemptsDeltaNoise: noise,
            significant: Math.abs(attemptsDelta) > SIGNIFICANCE_Z * noise,
            avgWinDelta,
            cost,
            attemptsSavedPerMillion: valuePerMillion(cost, attemptsSaved),
        });
    }

    const results = [...passthrough, ...merged];
    // The analysis's own ordering: priced rows by value first, then by raw gain
    results.sort((a, b) => {
        const unpriced = (result) => (result.attemptsSavedPerMillion === null ? 1 : 0);
        return (
            unpriced(a) - unpriced(b) ||
            (b.attemptsSavedPerMillion ?? 0) - (a.attemptsSavedPerMillion ?? 0) ||
            a.attemptsDelta - b.attemptsDelta
        );
    });
    return { ...analysis, results };
}

/**
 * Every order a set of ordinary abilities may be cast in: the ones with a
 * cooldown in any order, then the always-ready ones (no cooldown) in any order,
 * since the game casts the first ready ability in slot order and anything after
 * an always-ready one never gets to cast.
 * @param {string[]} hrids - The ordinary abilities, current order
 * @param {Set<string>|string[]} zeroCooldown - Ability hrids with no cooldown
 * @returns {string[][]} Every consistent order, including the current one if it is consistent
 */
export function consistentAbilityOrders(hrids, zeroCooldown) {
    const zero = new Set(zeroCooldown);
    const permutations = (items) =>
        items.length <= 1
            ? [items]
            : items.flatMap((item, i) =>
                  permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
              );
    const cooling = permutations(hrids.filter((hrid) => !zero.has(hrid)));
    const ready = permutations(hrids.filter((hrid) => zero.has(hrid)));
    return cooling.flatMap((front) => ready.map((back) => [...front, ...back]));
}

/**
 * The "Ability order" check as combat candidates: for each distinct set of
 * ordinary abilities in the reached loadouts, every consistent order other than
 * the one a loadout has now (one candidate per set and order; a candidate reaches
 * the loadouts with that set in another order), plus a "keep" candidate for each
 * current order so the loadout may stay as it is. The special slot stays put. Free
 * of cost. `mergeCheckedAbilityRows` keeps the best order per loadout.
 *
 * @param {Array<Object>} dtos - The loadout of every fight in the run
 * @param {Object} gameData - Game data payload
 * @param {boolean} [isSelf=true] - Whether the loadouts are the live character's
 * @returns {{candidates: Array<Object>, reach: number, alreadyEquipped: number, key: string}}
 */
export function buildCombatAbilityOrderCandidates(dtos, gameData, isSelf = true) {
    const loadouts = (dtos || []).filter(Boolean);
    const zero = zeroCooldownAbilities(gameData);
    const nameOf = (hrid) => swapItemName(hrid, gameData);
    const byId = new Map();
    const keeps = new Map();
    for (const dto of loadouts) {
        const current = (dto.abilities || [])
            .slice(1)
            .filter(Boolean)
            .map((ability) => ability.hrid);
        if (current.length < 2) continue;
        const keepId = `keep:${current.join('>')}`;
        if (!keeps.has(keepId)) {
            const keepText = 'Order: current order is best';
            keeps.set(keepId, {
                type: 'ability_order',
                slot: 'ability_1',
                checkedAbility: true,
                abilityOrder: true,
                keepCurrent: true,
                checkedAbilityKey: 'ability_order',
                poolKey: `checked_ability_order:${keepId}`,
                order: current,
                upgradeHrid: ABILITY_ORDER_HRID,
                upgradeLevel: 0,
                description: 'Ability order',
                partLabel: keepText,
                fightNote: keepText,
                cost: 0,
                noPurchase: true,
                isSelf,
                caveat:
                    'Checked by hand. Every order of the ordinary abilities was tried (the special slot fixed, ' +
                    'always-ready abilities last); each loadout shows the best. Costs nothing: set it in the game.',
            });
        }
        for (const order of consistentAbilityOrders(current, zero)) {
            if (order.join('|') === current.join('|')) continue;
            const id = `${[...current].sort().join('|')}=>${order.join('>')}`;
            if (byId.has(id)) continue;
            const text = `Order: ${order.map(nameOf).join(' → ')}`;
            byId.set(id, {
                type: 'ability_order',
                slot: 'ability_1',
                checkedAbility: true,
                abilityOrder: true,
                checkedAbilityKey: 'ability_order',
                poolKey: `checked_ability_order:${id}`,
                order,
                upgradeHrid: ABILITY_ORDER_HRID,
                upgradeLevel: 0,
                description: 'Ability order',
                partLabel: text,
                fightNote: text,
                cost: 0,
                noPurchase: true,
                isSelf,
                caveat:
                    'Checked by hand. Every order of the ordinary abilities was tried (the special slot fixed, ' +
                    'always-ready abilities last); each loadout shows the best. Costs nothing: set it in the game.',
            });
        }
    }
    const candidates = [...byId.values(), ...keeps.values()];
    const reach = loadouts.filter((dto) =>
        candidates.some((option) => checkedAbilityAppliesToDTO(option, dto, gameData))
    ).length;
    return { candidates, reach, alreadyEquipped: 0, key: 'ability_order' };
}

/**
 * Build whatever a queued ability-kind swap means: an ability, or the order check.
 * @param {{hrid: string, level: number}} swap - The queued entry
 * @param {Array<Object>} dtos - The loadout of every fight in the run
 * @param {Object} gameData - Game data payload
 * @param {boolean} [isSelf=true] - Whether the loadouts are the live character's
 * @param {Object} [options] - `{ allLoadouts }`
 * @returns {{candidates: Array<Object>, reach: number, alreadyEquipped: number, key: string}|null}
 */
export function buildCombatAbilityCheck(swap, dtos, gameData, isSelf = true, options = {}) {
    if (swap.hrid === ABILITY_ORDER_HRID) return buildCombatAbilityOrderCandidates(dtos, gameData, isSelf);
    return buildCombatAbilityCandidates(swap, dtos, gameData, isSelf, options);
}
