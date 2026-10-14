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

import { calculateUpgradeCost, checkedSwapAppliesToDTO, explainLabCandidateCost } from './upgrade-advisor.js';
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
    const clean = (list) => {
        const seen = new Set();
        const out = [];
        for (const entry of Array.isArray(list) ? list : []) {
            if (!entry || typeof entry.hrid !== 'string' || !entry.hrid.startsWith('/items/')) continue;
            const swap = { hrid: entry.hrid, level: clampSwapLevel(entry.level) };
            const key = checkedSwapKey(swap);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(swap);
            if (out.length >= MAX_QUEUED_SWAPS) break;
        }
        return out;
    };
    return { combat: clean(raw?.combat), skilling: clean(raw?.skilling) };
}

/**
 * Bring the remembered Check a swap options back into shape: for each tab, whether
 * "All loadouts" is ticked and whether the section was left open (null when it was
 * never toggled, so the default applies).
 * @param {*} raw - The stored `options`
 * @returns {{all: {combat: boolean, skilling: boolean}, open: {combat: boolean|null, skilling: boolean|null}}}
 */
export function sanitizeSwapOptions(raw) {
    const flag = (value) => (typeof value === 'boolean' ? value : null);
    return {
        all: { combat: raw?.all?.combat === true, skilling: raw?.all?.skilling === true },
        open: { combat: flag(raw?.open?.combat), skilling: flag(raw?.open?.skilling) },
    };
}

/**
 * The display name of an item.
 * @param {string} hrid - Item hrid
 * @param {Object} gameData - Game data payload
 * @returns {string}
 */
export function swapItemName(hrid, gameData) {
    return (
        gameData?.itemDetailMap?.[hrid]?.name ||
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
 * The replaced piece, as a kept item, when something outside the swap's reach still wears it.
 * @param {{route: string, currentHrid: string, currentLevel: number}} route - From `routeFor`
 * @param {Array<Object|null|undefined>} unreachedPieces - What the loadouts left out wear in the slot
 * @returns {Array<{hrid: string, enhancementLevel: number}>|null}
 */
function keptByUnreached(route, unreachedPieces) {
    if (route.route !== 'swap') return null;
    const stillWorn = unreachedPieces.some(
        (piece) => piece?.hrid === route.currentHrid && (piece.enhancementLevel || 0) === route.currentLevel
    );
    return stillWorn ? [{ hrid: route.currentHrid, enhancementLevel: route.currentLevel }] : null;
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
 * @param {Object} [options] - `{ allLoadouts }`: reach every loadout with the slot, whatever its style
 * @returns {Object|null} A candidate, or null when the item has no equipment slot
 */
export function buildCombatSwapCandidate(swap, dtos, gameData, isSelf = true, options = {}) {
    const slot = swapSlot(swap.hrid, gameData);
    if (!slot) return null;
    const allLoadouts = Boolean(options.allLoadouts);
    const base = { slot, upgradeHrid: swap.hrid, upgradeLevel: swap.level, allLoadouts };
    const reached = (dtos || []).filter((dto) => checkedSwapAppliesToDTO(base, dto, gameData));
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
    if ((dtos || []).some((dto) => wornExactly(dto?.equipment?.[slot], swap))) {
        candidate.cost = 0;
        candidate.noPurchase = true;
        candidate.pricingNote = OWNED_CAVEAT;
    } else {
        // A replaced piece that a loadout the swap does not reach still wears
        // cannot be sold to fund it
        const kept = keptByUnreached(
            route,
            (dtos || []).filter((dto) => !reached.includes(dto)).map((dto) => dto?.equipment?.[slot])
        );
        if (kept) {
            candidate.keptItems = kept;
            candidate.removedItems = [];
            candidate.pricingNote += KEPT_CAVEAT;
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
 * never looked at. Each member names its skill, so `applyToEquipment` writes it
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
    const reached = [];
    let owned = false;
    for (const skill of skills) {
        const kit = skillEquipmentMap[skill] || dto?.equipment || {};
        const piece = kit[slot];
        if (wornAtLeast(piece, swap)) {
            // Already that good here; only an exact-level copy can be moved to the others
            if (wornExactly(piece, swap)) owned = true;
            continue;
        }
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
    const replaced = route.currentHrid && route.type === 'tier' ? gameData.itemDetailMap[route.currentHrid] : null;
    const unreachedPieces = skills
        .filter((skill) => !reached.some((entry) => entry.skill === skill))
        .map((skill) => (skillEquipmentMap[skill] || dto?.equipment || {})[slot]);
    if ((replaced && isCombatOnlyItem(replaced)) || keptByUnreached(route, unreachedPieces)) {
        priced.keptItems = [{ hrid: route.currentHrid, enhancementLevel: route.currentLevel }];
        priced.removedItems = [];
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
