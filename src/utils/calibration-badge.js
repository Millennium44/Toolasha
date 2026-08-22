/**
 * Calibration badges
 *
 * The calibration panel knows how each profit forecast has fared against the
 * runs that actually happened; the forecasts themselves are shown somewhere
 * else entirely — the action panel, the action bar, the alchemy rankings, the
 * all-zones sim table — where a number that has been 12% hot for a month reads
 * exactly like one that is right. This module carries that track record to
 * the forecast: a small inline marker ("−12% over 40 runs", "on target (38
 * runs)") with a plain-English tooltip, or nothing at all below the sample
 * floor.
 *
 * ## Cheap by construction
 *
 * The forecast lines redraw often. Nothing here recomputes on a draw: the
 * ledger is read from storage once, summarised per action type on first ask,
 * and both are memoised until the read is older than {@link CACHE_TTL_MS},
 * when a fresh read is started in the background while the old answer keeps
 * being served. The sync accessor never awaits anything — before the first
 * read lands it says "no badge", which is the honest answer at that moment.
 *
 * ## Why storage rather than the recorder
 *
 * The recorder is a ui-bundle singleton, and the forecast lines live in the
 * actions and sim bundles, which load before it. Importing it would bundle a
 * second, uninitialised recorder per bundle; reading the ledger it writes is
 * one IndexedDB get, and the ledger's shape is the one thing the two share.
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';
import storage from '../core/storage.js';
import { summarizeCalibration, DEFAULT_MIN_SAMPLES } from '../features/insights/calibration-math.js';

/** The setting that switches the badges off */
export const BADGE_SETTING = 'insights_calibrationBadges';

/** The store and key base the recorder writes the ledger under */
const STORE_NAME = 'lootLogHistory';
const KEY_BASE = 'calibration';

/** How long one read of the ledger is served before a fresh one is started */
export const CACHE_TTL_MS = 60 * 1000;

/** Runs needed before a badge says anything — the panel's own floor */
export const BADGE_MIN_SAMPLES = DEFAULT_MIN_SAMPLES;

/** Inside this the forecast counts as on target */
export const ON_TARGET_PERCENT = 5;

/** Past this the gap is painted red rather than amber */
export const RED_PERCENT = 15;

/** Badge colours by tone */
export const BADGE_COLORS = Object.freeze({
    neutral: '#9aa0a6',
    amber: '#ffb74d',
    red: '#f87171',
});

const BADGE_BACKGROUNDS = Object.freeze({
    neutral: 'rgba(154,160,166,0.14)',
    amber: 'rgba(255,183,77,0.14)',
    red: 'rgba(248,113,113,0.14)',
});

/** One character's ledger, summarised lazily, kept until it ages out */
const cache = {
    charId: null,
    records: null,
    loadedAt: 0,
    loading: null,
    /** `${actionType}|${actionHrid}|${tier}` → group summary or null */
    summaries: new Map(),
};

/**
 * Escape text for an HTML attribute.
 * @param {string} text - Raw text
 * @returns {string}
 */
function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The calibration series an action belongs to, from either spelling of its
 * type: the loot log's skill name (`milking`), an action-type hrid
 * (`/action_types/milking`) or an action hrid (`/actions/milking/cow`).
 * @param {string} hridOrType - Any of the above
 * @returns {string|null} e.g. `milking`, or null when there is nothing to read
 */
export function calibrationActionType(hridOrType) {
    if (!hridOrType || typeof hridOrType !== 'string') return null;
    if (hridOrType.startsWith('/actions/')) {
        const parts = hridOrType.split('/');
        return parts.length >= 3 ? parts[2] : null;
    }
    if (hridOrType.startsWith('/action_types/')) return hridOrType.slice('/action_types/'.length) || null;
    return hridOrType;
}

/**
 * Which colour a deviation earns.
 * @param {number} deviationPercent - Signed median deviation
 * @returns {'neutral'|'amber'|'red'}
 */
export function classifyDeviation(deviationPercent) {
    const size = Math.abs(deviationPercent);
    if (size < ON_TARGET_PERCENT) return 'neutral';
    if (size <= RED_PERCENT) return 'amber';
    return 'red';
}

/**
 * Calendar date as a player reads it, e.g. `3 Aug`.
 * @param {number} t - Epoch ms
 * @returns {string}
 */
function shortDate(t) {
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Reduce a group summary to what a badge shows.
 *
 * @param {Object|null} group - A group from `summarizeCalibration`, with
 *   `firstAt` added when known
 * @param {Object} [options] - Overrides
 * @param {number} [options.minSamples] - Runs needed before anything is said
 * @param {string} [options.label] - What the forecast is called in the tooltip
 * @returns {{text: string, tone: string, color: string, title: string, deviation: number, samples: number}|null}
 *   The badge, or null when there is not enough to say
 */
export function describeBadge(group, { minSamples = BADGE_MIN_SAMPLES, label = null } = {}) {
    if (!group || !Number.isFinite(group.medianDeviation)) return null;
    const samples = Number(group.rated) || 0;
    if (samples < minSamples) return null;

    const deviation = group.medianDeviation;
    const tone = classifyDeviation(deviation);
    const rounded = Math.round(Math.abs(deviation));
    const signed = `${deviation < 0 ? '−' : '+'}${rounded}%`;
    const text = tone === 'neutral' ? `on target (${samples} runs)` : `${signed} over ${samples} runs`;

    const what = label ? `The ${label} forecast` : 'This forecast';
    const window =
        Number.isFinite(group.firstAt) && group.firstAt > 0 && Number.isFinite(group.lastAt) && group.lastAt > 0
            ? ` (${shortDate(group.firstAt)} – ${shortDate(group.lastAt)})`
            : '';
    let meaning;
    if (tone === 'neutral') {
        meaning = `${what} has been on target: the typical run paid within ${ON_TARGET_PERCENT}% of what was predicted.`;
    } else if (deviation < 0) {
        meaning = `${what} has run hot: the typical run paid ${rounded}% LESS than predicted.`;
    } else {
        meaning = `${what} has run cold: the typical run paid ${rounded}% MORE than predicted.`;
    }
    const title =
        `${meaning}\nMeasured over the last ${samples} finished runs${window}, median of the per-run gaps.` +
        '\nFrom the Prediction Calibration ledger — open that panel for every skill measured.';

    return { text, tone, color: BADGE_COLORS[tone], title, deviation, samples };
}

/**
 * The inline style the badge is drawn with. Small and inline so the line it
 * sits on does not grow.
 * @param {string} tone - Badge tone
 * @returns {string}
 */
function badgeStyle(tone) {
    return (
        `display:inline-block; margin-left:5px; padding:0 4px; border-radius:3px; font-size:0.78em; ` +
        `font-weight:500; line-height:1.5; vertical-align:baseline; white-space:nowrap; cursor:help; ` +
        `background:${BADGE_BACKGROUNDS[tone]}; color:${BADGE_COLORS[tone]};`
    );
}

/**
 * A badge as an HTML string, for lines built by string.
 * @param {Object|null} badge - From `describeBadge`
 * @returns {string} Markup, or an empty string for no badge
 */
export function badgeHtml(badge) {
    if (!badge) return '';
    return (
        `<span class="mwi-calibration-badge" data-tone="${badge.tone}" title="${escapeHtml(badge.title)}" ` +
        `style="${badgeStyle(badge.tone)}">${escapeHtml(badge.text)}</span>`
    );
}

/**
 * A badge as an element, for lines built with the DOM.
 * @param {Object|null} badge - From `describeBadge`
 * @returns {HTMLElement|null} The span, or null for no badge
 */
export function badgeElement(badge) {
    if (!badge || typeof document === 'undefined') return null;
    const span = document.createElement('span');
    span.className = 'mwi-calibration-badge';
    span.dataset.tone = badge.tone;
    span.title = badge.title;
    span.style.cssText = badgeStyle(badge.tone);
    span.textContent = badge.text;
    return span;
}

/**
 * Whether the badges are switched on.
 * @returns {boolean}
 */
export function calibrationBadgesEnabled() {
    try {
        return config.getSetting(BADGE_SETTING, true) !== false;
    } catch {
        return true;
    }
}

/**
 * Forget what is cached, so the next ask reads the ledger again.
 */
export function invalidateCalibrationBadges() {
    cache.charId = null;
    cache.records = null;
    cache.loadedAt = 0;
    cache.loading = null;
    cache.summaries.clear();
}

/**
 * Read the ledger from storage into the cache. One read at a time; a second
 * ask while one is in flight joins it.
 * @returns {Promise<Array<Object>>} The records (empty when there are none)
 */
export async function loadCalibrationBadges() {
    const charId = dataManager.getCurrentCharacterId?.() || null;
    if (!charId) return [];
    if (cache.loading && cache.charId === charId) return cache.loading;

    cache.charId = charId;
    cache.loading = (async () => {
        try {
            const stored = await storage.get(`${KEY_BASE}_${charId}`, STORE_NAME, []);
            const records = Array.isArray(stored) ? stored : [];
            // The character may have changed while the read was out
            if (cache.charId !== charId) return records;
            cache.records = records;
            cache.loadedAt = Date.now();
            cache.summaries.clear();
            return records;
        } catch (error) {
            console.error('[CalibrationBadge] Could not read the calibration ledger:', error);
            if (cache.charId === charId) {
                cache.records = cache.records || [];
                cache.loadedAt = Date.now();
            }
            return cache.records || [];
        } finally {
            if (cache.charId === charId) cache.loading = null;
        }
    })();
    return cache.loading;
}

/**
 * The cached records, kicking off a read when there is none or it has aged.
 * @returns {Array<Object>|null} Records, or null before the first read lands
 */
function cachedRecords() {
    const charId = dataManager.getCurrentCharacterId?.() || null;
    if (!charId) return null;
    if (cache.charId !== charId) {
        invalidateCalibrationBadges();
        loadCalibrationBadges();
        return null;
    }
    if (cache.records === null || Date.now() - cache.loadedAt > CACHE_TTL_MS) {
        // Fire and forget: the stale answer is served until the fresh one lands
        loadCalibrationBadges();
    }
    return cache.records;
}

/**
 * The summary for one series, memoised until the ledger is re-read.
 *
 * @param {string} actionType - The loot log's skill name, or `combat`
 * @param {Object} [filter] - Narrow to one action
 * @param {string} [filter.actionHrid] - Only records for this action
 * @param {number} [filter.difficultyTier] - Only records at this tier (combat)
 * @returns {Object|null} A group from `summarizeCalibration` with `firstAt`, or
 *   null when nothing is recorded for it yet
 */
export function getCalibrationGroup(actionType, { actionHrid = null, difficultyTier = null } = {}) {
    const type = calibrationActionType(actionType);
    if (!type) return null;
    const records = cachedRecords();
    if (!records) return null;

    const key = `${type}|${actionHrid || ''}|${difficultyTier ?? ''}`;
    if (cache.summaries.has(key)) return cache.summaries.get(key);

    const matching = records.filter(
        (record) =>
            record &&
            record.actionType === type &&
            (actionHrid === null || record.actionHrid === actionHrid) &&
            (difficultyTier === null || (record.difficultyTier ?? 0) === difficultyTier)
    );
    let group = null;
    if (matching.length) {
        const summary = summarizeCalibration(matching);
        group = summary.groups.find((candidate) => candidate.actionType === type) || null;
        if (group) {
            group = {
                ...group,
                firstAt: matching.reduce((earliest, r) => (r.t && r.t < earliest ? r.t : earliest), Infinity),
            };
            if (!Number.isFinite(group.firstAt)) group.firstAt = null;
        }
    }
    cache.summaries.set(key, group);
    return group;
}

/**
 * The badge for one forecast, or null — synchronously, from whatever the
 * cache holds.
 *
 * With an `actionHrid`, the action's own runs are preferred; when it has too
 * few, the whole series for its skill speaks for it instead (and the tooltip
 * says so), since a forecast that has run hot across a skill is still worth
 * knowing on an action that has never been measured.
 *
 * @param {string} actionType - Skill name, action-type hrid or action hrid
 * @param {Object} [options] - Narrowing and wording
 * @param {string} [options.actionHrid] - Prefer this action's runs
 * @param {number} [options.difficultyTier] - Only this tier's runs (combat)
 * @param {boolean} [options.exact] - With an `actionHrid`, never fall back to
 *   the skill's series — for a table where every row would otherwise repeat it
 * @param {string} [options.label] - What the forecast is called in the tooltip
 * @returns {Object|null} From `describeBadge`, or null
 */
export function calibrationBadgeFor(
    actionType,
    { actionHrid = null, difficultyTier = null, exact = false, label = null } = {}
) {
    if (!calibrationBadgesEnabled()) return null;
    try {
        const type = calibrationActionType(actionType);
        const name = label ?? type;
        if (actionHrid) {
            const own = describeBadge(getCalibrationGroup(type, { actionHrid, difficultyTier }), { label: name });
            if (own || exact) return own;
        }
        const series = getCalibrationGroup(type, { difficultyTier });
        const badge = describeBadge(series, { label: name });
        if (badge && actionHrid) {
            badge.title += `
This action has fewer than ${BADGE_MIN_SAMPLES} measured runs of its own, so every ${name} action is counted.`;
        }
        return badge;
    } catch (error) {
        console.error('[CalibrationBadge] Badge lookup failed:', error);
        return null;
    }
}

/**
 * Append a badge to a forecast line, when there is one to show.
 * @param {HTMLElement|null} line - The line the forecast is on
 * @param {string} actionType - Skill name, action-type hrid or action hrid
 * @param {Object} [options] - Passed to `calibrationBadgeFor`
 * @returns {HTMLElement|null} The badge appended, or null
 */
export function appendCalibrationBadge(line, actionType, options = {}) {
    if (!line) return null;
    const badge = badgeElement(calibrationBadgeFor(actionType, options));
    if (badge) line.appendChild(badge);
    return badge;
}

export default {
    BADGE_SETTING,
    BADGE_MIN_SAMPLES,
    BADGE_COLORS,
    calibrationActionType,
    classifyDeviation,
    describeBadge,
    badgeHtml,
    badgeElement,
    calibrationBadgesEnabled,
    invalidateCalibrationBadges,
    loadCalibrationBadges,
    getCalibrationGroup,
    calibrationBadgeFor,
    appendCalibrationBadge,
};
