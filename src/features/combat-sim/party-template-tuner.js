/**
 * "Match my build": a party template tuned to the current character, so a template teammate is about as strong as you
 * are rather than at the fixed standard levels.
 *
 * Two independent parts, both free of the DOM:
 *
 * - Combat levels ({@link matchCombatLevels}): each of the seven combat stats is the character's own, except the
 *   template's main stat (melee, ranged, magic or defense by role), which is the character's HIGHEST of melee, ranged,
 *   magic and defense, so a melee player's template mage is not crippled by their low magic.
 * - Gear enhancement and ability levels ({@link tuneTemplate}): one knob per template, an integer offset k applied to
 *   the standardized profile ({@link applyOffset}), searched so the template's build score (combat equipment plus
 *   abilities, the profile card's own calculation) lands closest to the character's. House and guild shrines are the
 *   character's own and are neither tuned nor compared.
 */

import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import { calculateCombatScore } from '../profile/score-calculator.js';
import { ensureOwnScore, scorePricingStamp } from '../profile/build-score-row.js';

/** Lowest and highest offset tried */
export const OFFSET_MIN = -15;
export const OFFSET_MAX = 15;

/** Most template scorings one tuning may spend (each prices a whole build) */
export const MAX_EVALS = 15;

/** Gap between the offsets of the coarse scan */
const SCAN_STEP = 3;

const STAT_KEYS = [
    'staminaLevel',
    'intelligenceLevel',
    'attackLevel',
    'meleeLevel',
    'defenseLevel',
    'rangedLevel',
    'magicLevel',
];

/** Style stats the main stat is taken from */
const STYLE_KEYS = ['meleeLevel', 'rangedLevel', 'magicLevel', 'defenseLevel'];

/** Slots that follow the offset in full; every other slot follows half of it */
const FULL_OFFSET_SLOTS = new Set(['main_hand', 'two_hand', 'off_hand', 'head', 'body', 'legs', 'feet', 'hands']);

/**
 * The combat stat a role's template is built around.
 * @param {string} role
 * @returns {string} A level key of the player DTO
 */
export function mainStatKey(role) {
    if (role === 'ranged') return 'rangedLevel';
    if (role === 'nature_mage' || role === 'fire_mage' || role === 'water_mage') return 'magicLevel';
    if (role === 'tank') return 'defenseLevel';
    return 'meleeLevel';
}

/**
 * A copy of a template build with the character's own combat levels. The template's main stat is the character's
 * highest style stat (max of melee, ranged, magic, defense); the other six are the character's own.
 * @param {Object} dto - The template's player DTO
 * @param {string} role - The template's role
 * @param {Object} levels - The character's levels (a player DTO carries them)
 * @returns {Object}
 */
export function matchCombatLevels(dto, role, levels) {
    const copy = structuredClone(dto);
    const own = (key) => Math.max(1, Math.floor(Number(levels?.[key])) || 1);
    for (const key of STAT_KEYS) copy[key] = own(key);
    copy[mainStatKey(role)] = Math.max(...STYLE_KEYS.map(own));
    return copy;
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * A copy of a template build with every gear enhancement level and ability level moved by the offset: weapons, off
 * hand and armor by k, every other slot by half of k (rounded); ability levels by 5 per step. Enhancement stays in
 * 0..20, ability levels in 1..200.
 * @param {Object} dto
 * @param {number} k
 * @returns {Object}
 */
export function applyOffset(dto, k) {
    const copy = structuredClone(dto);
    for (const [key, item] of Object.entries(copy.equipment || {})) {
        if (!item) continue;
        const slot = key.replace('/equipment_types/', '');
        const step = FULL_OFFSET_SLOTS.has(slot) ? k : Math.round(k / 2);
        item.enhancementLevel = clamp((item.enhancementLevel || 0) + step, 0, 20);
    }
    for (const ability of copy.abilities || []) {
        if (ability) ability.level = clamp((ability.level || 1) + 5 * k, 1, 200);
    }
    return copy;
}

/**
 * The template build in the `profile_shared` shape `calculateCombatScore` reads. House rooms and shrines are left
 * out: they are not part of what is compared.
 * @param {Object} dto
 * @returns {{profile: Object}}
 */
export function profileDataFor(dto) {
    const wearableItemMap = {};
    for (const [key, item] of Object.entries(dto.equipment || {})) {
        if (!item?.hrid) continue;
        const slot = key.replace('/equipment_types/', '/item_locations/');
        wearableItemMap[slot] = {
            itemLocationHrid: slot,
            itemHrid: item.hrid,
            enhancementLevel: item.enhancementLevel || 0,
        };
    }
    const equippedAbilities = (dto.abilities || [])
        .filter((a) => a?.hrid)
        .map((a) => ({ abilityHrid: a.hrid, level: a.level || 1 }));
    return {
        profile: { characterHouseRoomMap: {}, equippedAbilities, wearableItemMap, hideWearableItems: false },
    };
}

/**
 * What is compared in a score: the combat equipment and the abilities.
 * @param {{equipment?: number, ability?: number}|null} score - A `calculateCombatScore` result
 * @returns {number|null} null when there is no usable figure (nothing priced)
 */
export function comparableScore(score) {
    const value = (Number(score?.equipment) || 0) + (Number(score?.ability) || 0);
    return value > 0 ? value : null;
}

/**
 * Search the offset whose score is closest to the target. The score is not assumed to grow with the offset (below the
 * high-enhancement threshold a piece is priced from market asks, above it from computed costs, so one expensive
 * listing can put a lower level above a higher one): a coarse scan of every third offset across
 * [OFFSET_MIN, OFFSET_MAX], then the immediate neighbors of the two best coarse points, inside the evaluation cap.
 * @param {Object} options
 * @param {(k: number) => Promise<number|null>} options.scoreAt - The template's comparable score at an offset
 * @param {number} options.target - The character's comparable score
 * @param {() => boolean} [options.stillCurrent] - False once the answer is for nobody (checked after every await)
 * @param {number} [options.maxEvals]
 * @param {(progress: {phase: string, done: number, max: number}) => void} [options.onProgress] - Called before each scoring
 * @returns {Promise<{status: 'ok'|'clampedLow'|'clampedHigh'|'failed'|'aborted', k: number|null,
 *   score: number|null, evals: number}>} `clampedLow`: even the lowest score seen is above the target;
 *   `clampedHigh`: even the highest score seen is below it
 */
export async function solveOffset({
    scoreAt,
    target,
    stillCurrent = () => true,
    maxEvals = MAX_EVALS,
    onProgress = null,
}) {
    let evals = 0;
    const seen = new Map();
    const done = (status, k, score) => ({ status, k, score, evals });
    // Returns false when the search must stop (switched, unscorable)
    const probe = async (k) => {
        if (seen.has(k)) return true;
        evals += 1;
        onProgress?.({ phase: 'solve', done: evals, max: maxEvals });
        const score = await scoreAt(k);
        if (!stillCurrent()) return 'aborted';
        if (score === null) return 'failed';
        seen.set(k, score);
        return true;
    };
    const gap = (k) => Math.abs(seen.get(k) - target);

    const coarse = [];
    for (let k = OFFSET_MIN; k <= OFFSET_MAX; k += SCAN_STEP) coarse.push(k);
    if (coarse[coarse.length - 1] !== OFFSET_MAX) coarse.push(OFFSET_MAX);
    for (const k of coarse) {
        const state = await probe(k);
        if (state !== true) return done(state, null, null);
    }
    // The neighbors of the two best coarse points, nearest the target first
    const best = [...coarse].sort((x, y) => gap(x) - gap(y)).slice(0, 2);
    const neighbors = best.flatMap((k) => [k - 1, k + 1]).filter((k) => k >= OFFSET_MIN && k <= OFFSET_MAX);
    for (const k of neighbors) {
        if (evals >= maxEvals) break;
        const state = await probe(k);
        if (state !== true) return done(state, null, null);
    }
    let pick = coarse[0];
    for (const k of seen.keys()) if (gap(k) < gap(pick)) pick = k;
    const score = seen.get(pick);
    // The target lies beyond everything reachable: the best score is the lowest seen and still above it, or the
    // highest seen and still below it (gear stops adding score once the enhancement or level caps are hit)
    const scores = [...seen.values()];
    if (score > target && score <= Math.min(...scores)) return done('clampedLow', pick, score);
    if (score < target && score >= Math.max(...scores)) return done('clampedHigh', pick, score);
    return done('ok', pick, score);
}

/**
 * Whether a score counted something at zero for want of a price: a worn piece, or an ability book (an unpriced
 * ability row does not raise `equipmentUnpriced`).
 * @param {Object|null} score - A `calculateCombatScore` result
 * @returns {boolean}
 */
export function hasUnpriced(score) {
    return (
        Number(score?.equipmentUnpriced) > 0 ||
        (Array.isArray(score?.breakdown?.abilities) && score.breakdown.abilities.some((row) => row?.unpriced))
    );
}

/** Hand the main thread back for a macrotask, so a long run of scorings does not freeze the page */
function yieldToBrowser() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Solved offsets by template, character, score stamp and pricing context */
const cache = new Map();

/** Forget every solved offset */
export function clearTunerCache() {
    cache.clear();
}

/**
 * The real inputs: the live character, its own build score, the scoring.
 * @returns {Object}
 */
export function liveDeps() {
    return {
        getCharacterId: () => dataManager.getCurrentCharacterId(),
        // A score computed under another pricing stamp is recomputed, not compared against
        getOwnScore: async () => ensureOwnScore({ stamp: scorePricingStamp() }),
        getPricingKey: () =>
            [
                dataManager.getCurrentCharacterGameMode?.() || '',
                config.getSetting('networth_highEnhancementUseCost') ? 'cost' : 'market',
                config.getSetting('networth_highEnhancementMinLevel') || 13,
                scorePricingStamp(),
            ].join('|'),
        scoreProfile: async (profileData) => calculateCombatScore(profileData),
    };
}

/**
 * The score stamp of the character's own score: any change to the figures it is compared on changes the stamp.
 * @param {Object} score
 * @returns {string}
 */
function stampOf(score) {
    return [score.total, score.equipment, score.ability].map((v) => Number(v || 0).toFixed(1)).join('|');
}

/**
 * Tune a template to the current character.
 * @param {{id: string, role: string, playerDto: Object}} template
 * @param {Object} levels - The character's combat levels (a player DTO carries them)
 * @param {Object} [deps] - See {@link liveDeps}
 * @param {Object} [options]
 * @param {(progress: {phase: string, done: number, max: number}) => void} [options.onProgress] - 'score' while the
 *   character's own score is awaited, then 'solve' before each of the (at most MAX_EVALS) scorings
 * @returns {Promise<{status: 'ok'|'partial'|'clampedLow'|'clampedHigh'|'noScore'|'failed'|'aborted', dto: Object,
 *   k: number|null, templateScore: number|null, ownScore: number|null, cached: boolean}>} `partial`: gear in either score was unpriced, so the match is approximate (the tuned build
 *   is still returned, never reported as `ok`); `clamp` is `clampedLow`/`clampedHigh` whenever the solve was clamped,
 *   whether or not the gear was priced (`status` is then `partial`). `dto` is always usable:
 *   with `noScore` (the character's score is not loaded), `failed` or `aborted` it is the standardized template with
 *   only the matched combat levels
 */
export async function tuneTemplate(template, levels, deps = liveDeps(), { onProgress = null, restarted = false } = {}) {
    const characterId = deps.getCharacterId();
    // The pricing context the solve starts under: a market refresh or a pricing-setting change while it runs makes
    // the character's score and every probe come from different quotes, and what it matched is stale
    const pricingKey = deps.getPricingKey();
    const sameCharacter = () => deps.getCharacterId() === characterId;
    const stillCurrent = () => sameCharacter() && deps.getPricingKey() === pricingKey;
    const leveled = matchCombatLevels(template.playerDto, template.role, levels);
    const fallback = (status, extra = {}) => ({
        status,
        dto: leveled,
        k: null,
        templateScore: null,
        ownScore: null,
        cached: false,
        ...extra,
    });

    // Another character: nothing to hand back. Only the prices moved: solve again once on the new ones, and give
    // up if they move again rather than chase them
    const abandoned = () =>
        sameCharacter() && !restarted
            ? tuneTemplate(template, levels, deps, { onProgress, restarted: true })
            : fallback('aborted');

    onProgress?.({ phase: 'score', done: 0, max: MAX_EVALS });
    const own = await deps.getOwnScore();
    if (!stillCurrent()) return abandoned();
    const target = comparableScore(own);
    if (!own || target === null) return fallback('noScore');

    // An unpriced piece in the character's own score is part of what a solved offset was matched against
    const key = [template.id, characterId, stampOf(own), pricingKey, hasUnpriced(own) ? 'partial' : 'priced'].join('#');
    const hit = cache.get(key);
    if (hit) return { ...hit, dto: applyOffset(leveled, hit.k), cached: true };

    // A piece nothing could price counts as zero in either score, so a match through it is only approximate
    let unpriced = hasUnpriced(own);
    const scoreAt = async (k) => {
        // Scoring a whole build is heavy: let the page paint between probes
        await (deps.yieldToBrowser ?? yieldToBrowser)();
        const result = await deps.scoreProfile(profileDataFor(applyOffset(template.playerDto, k)));
        if (hasUnpriced(result)) unpriced = true;
        return comparableScore(result);
    };
    const solved = await solveOffset({ scoreAt, target, stillCurrent, onProgress });
    if (!stillCurrent() || solved.status === 'aborted') return abandoned();
    if (solved.status === 'failed') return fallback('failed');

    const result = {
        status: unpriced ? 'partial' : solved.status,
        clamp: solved.status === 'clampedLow' || solved.status === 'clampedHigh' ? solved.status : null,
        k: solved.k,
        templateScore: solved.score,
        ownScore: target,
    };
    cache.set(key, result);
    return { ...result, dto: applyOffset(leveled, solved.k), cached: false };
}
