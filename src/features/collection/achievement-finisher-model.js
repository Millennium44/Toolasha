/**
 * Achievement-tier finisher: the pure join of the game's achievement catalog
 * with the character's own achievement list.
 *
 * Nothing here reads the game. The catalog is `achievementDetailMap` (hrid →
 * `{hrid?, name?, tierHrid, target?, sortIndex?}`) and the list is
 * `characterAchievements` (`{achievementHrid, isCompleted}` rows, as the server
 * sends and `achievements_updated` merges them). The list carries no
 * per-achievement progress that has been observed, so a remaining achievement's
 * progress is "unavailable" — never 0 — except the two point-total
 * achievements (`collection_points_N`, `bestiary_points_N`), whose progress is
 * the Collections / Bestiary total the caller passes in.
 */

import { achievementTierReward } from '../../utils/achievement-combat-buffs.js';

/** The game's tier order, lowest first; a tier outside it sorts after, by hrid */
const TIER_ORDER = [
    '/achievement_tiers/beginner',
    '/achievement_tiers/novice',
    '/achievement_tiers/adept',
    '/achievement_tiers/veteran',
    '/achievement_tiers/elite',
    '/achievement_tiers/champion',
];

const POINTS_PATTERN = /\/(collection|bestiary)_points_(\d+)$/;

/**
 * A readable name from an hrid's last segment, for when the catalog gives none.
 * @param {string} hrid
 * @returns {string}
 */
export function nameFromHrid(hrid) {
    return (
        String(hrid || '')
            .split('/')
            .pop()
            .split('_')
            .filter(Boolean)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ') || String(hrid || '')
    );
}

/**
 * Which existing planner serves a remaining achievement, from its hrid.
 * @param {string} hrid
 * @returns {{planner: 'collection'|'bestiary', target: number}|null}
 */
export function plannerFor(hrid) {
    const match = POINTS_PATTERN.exec(String(hrid || ''));
    if (!match) return null;
    const target = Number(match[2]);
    if (!(target > 0)) return null;
    return { planner: match[1], target };
}

/**
 * Order tiers: by the catalog's own sort index when every tier has one, else by the game's known order.
 * @param {Array<{tierHrid: string}>} tiers
 * @param {Object|null} tierDetailMap
 * @returns {Array}
 */
function sortTiers(tiers, tierDetailMap) {
    const index = (hrid) => {
        const sortIndex = Number(tierDetailMap?.[hrid]?.sortIndex);
        return Number.isFinite(sortIndex) ? sortIndex : null;
    };
    const allIndexed = tiers.length > 0 && tiers.every((tier) => index(tier.tierHrid) !== null);
    return [...tiers].sort((a, b) => {
        if (allIndexed) return index(a.tierHrid) - index(b.tierHrid);
        const ai = TIER_ORDER.indexOf(a.tierHrid);
        const bi = TIER_ORDER.indexOf(b.tierHrid);
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        return a.tierHrid.localeCompare(b.tierHrid);
    });
}

/**
 * Join the catalog with the character's list into per-tier checklists.
 *
 * Completion counts distinct catalog achievements only: a duplicate row never
 * counts twice, a row for an hrid the catalog does not know is ignored, and
 * only `isCompleted === true` completes. An achievement with no row while a list
 * is loaded is "not done" (the server only lists what it has a record of).
 *
 * @param {Object} input
 * @param {Object|null} input.detailMap - `achievementDetailMap`
 * @param {Object|null} [input.tierDetailMap] - `achievementTierDetailMap`, when the client data has one
 * @param {Array|null} input.achievements - the character's achievement list; null when not loaded
 * @param {{collection: number|null, bestiary: number|null}} [input.points] - Current totals; null: not loaded
 * @returns {{state: 'unknown', reason: 'catalog'|'achievements'}
 *   | {state: 'ok', tiers: Array<Object>, completeTiers: number}}
 */
export function buildTierChecklists({ detailMap, tierDetailMap = null, achievements, points = {} }) {
    if (!detailMap || typeof detailMap !== 'object' || Object.keys(detailMap).length === 0) {
        return { state: 'unknown', reason: 'catalog' };
    }
    if (!Array.isArray(achievements)) return { state: 'unknown', reason: 'achievements' };

    const completed = new Set();
    for (const row of achievements) {
        if (row?.isCompleted === true && row.achievementHrid && detailMap[row.achievementHrid]) {
            completed.add(row.achievementHrid);
        }
    }

    const byTier = new Map();
    for (const [key, detail] of Object.entries(detailMap)) {
        const tierHrid = detail?.tierHrid;
        if (!tierHrid) continue;
        const hrid = detail.hrid || key;
        if (!byTier.has(tierHrid)) byTier.set(tierHrid, { remaining: [], done: [] });
        const bucket = byTier.get(tierHrid);
        const entry = { hrid, name: detail.name || nameFromHrid(hrid) };
        if (completed.has(key) || completed.has(hrid)) {
            bucket.done.push(entry);
            continue;
        }
        const link = plannerFor(hrid);
        entry.planner = link ? link.planner : null;
        entry.target = link ? link.target : null;
        const current = link ? points[link.planner] : null;
        entry.progress = Number.isFinite(current) ? { current, target: link.target } : null;
        bucket.remaining.push(entry);
    }

    const tiers = [];
    for (const [tierHrid, bucket] of byTier) {
        const total = bucket.done.length + bucket.remaining.length;
        tiers.push({
            tierHrid,
            name: tierDetailMap?.[tierHrid]?.name || nameFromHrid(tierHrid),
            total,
            doneCount: bucket.done.length,
            done: bucket.done,
            remaining: bucket.remaining,
            complete: total > 0 && bucket.remaining.length === 0,
            reward: achievementTierReward(tierHrid),
        });
    }
    const ordered = sortTiers(tiers, tierDetailMap);
    return { state: 'ok', tiers: ordered, completeTiers: ordered.filter((tier) => tier.complete).length };
}
