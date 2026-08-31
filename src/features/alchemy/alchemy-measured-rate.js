/**
 * Measured alchemy success rate, beside the predicted one
 *
 * Every alchemy forecast on screen is built on a success rate the model
 * computed, and `alchemy-calibration.js` has been quietly holding the other
 * half of that sentence for as long as the trackers have been stamping
 * predictions onto sessions: what the rate actually came out at, per
 * item+catalyst+enhancement combination, with a Wilson interval saying whether
 * the difference is something the sample can support.
 *
 * That reading has only ever been visible on the Prediction Calibration panel,
 * which is not where anybody picks an item. This carries it to the two places
 * the forecast is read — the alchemy action panel's Success Rate line and the
 * Best Items rankings — as one string:
 *
 *     predicted 63% · measured 58% (n=2,140, sim too high)
 *
 * ## Display-only, by design — and this is not a limitation to fix later
 *
 * The measured rate is **never** substituted into the ranking arithmetic, and
 * must not be. The ranking decides which items get run; the measured rate is
 * built only from items that were run. Feed one into the other and an item that
 * drew an unlucky stretch has its predicted profit marked down, falls in the
 * ranking, stops being chosen, and therefore never accumulates the attempts
 * that would clear its name — its bad sample is frozen in place and cited
 * forever. The forecast has to stay the thing the ranking is computed from, and
 * the measurement has to stay a thing the reader is told, so that the reader —
 * who can also decide to go and run the item anyway — is the one closing the
 * loop.
 *
 * ## "Not enough yet" is the normal case
 *
 * {@link MIN_ATTEMPTS} is 50 attempts *per combination*, and a player who
 * alchemises twenty different items spreads their history across twenty
 * buckets. Most combinations will sit under the floor for months, so the
 * under-floor rendering had to be something that can sit on every row
 * indefinitely without becoming noise. The choice made here, stated plainly so
 * the next reader does not have to infer it:
 *
 * - **No attempts recorded at all** → nothing is drawn. There is no reading and
 *   no progress towards one; a marker would be pure clutter.
 * - **Some attempts, under the floor** → a dim, unobtrusive `measured n=12/50`
 *   marker with an explanatory tooltip. Not the rate itself: a rate from twelve
 *   attempts is a number, not a reading, and putting it on screen in the same
 *   shape as a decided one is exactly the confusion the floor exists to
 *   prevent. The count alone says "this is being watched, it is not ready".
 * - **At or over the floor** → the full line, including the Wilson verdict.
 *
 * ## Cheap by construction
 *
 * The forecast lines redraw constantly. Nothing here recomputes on a draw: the
 * three trackers' sessions are read from storage once, summarised on first ask,
 * and both are memoised until the read ages past {@link CACHE_TTL_MS}, when a
 * fresh read starts in the background while the old answer keeps being served.
 * The sync accessor never awaits — before the first read lands it says "no
 * line", which is the honest answer at that moment.
 *
 * The stores are built here rather than by importing the three tracker
 * singletons, for the reason `calibration-badge.js` gives about the calibration
 * recorder: a tracker is a websocket-bound singleton owned by its own bundle,
 * and importing it from a rendering module would bundle a second, uninitialised
 * copy. The store wrapper is a storage reader and nothing else — and it is
 * built fresh for every read, the way `gold-sources-collect.js` reads the same
 * keys. A chunked-history store serves its first read from memory forever
 * after, which is right for the tracker that does the writing and wrong for a
 * reader whose storage is written by somebody else: a long-lived reader here
 * would never see a session recorded after its first read, and the
 * {@link CACHE_TTL_MS} refresh would re-serve the page-load snapshot until a
 * reload.
 */

import dataManager from '../../core/data-manager.js';
import { MIN_ATTEMPTS, ALCHEMY_KINDS, comboKey, summarizeKind, verdictText } from '../insights/alchemy-calibration.js';
import { createAlchemySessionStore, NO_CHARACTER } from './alchemy-session-store.js';

export { MIN_ATTEMPTS, ALCHEMY_KINDS };

/** How long one read of the sessions is served before a fresh one is started */
export const CACHE_TTL_MS = 30 * 1000;

/** Colours, matching the calibration panel's own verdict palette */
export const MEASURED_COLORS = Object.freeze({
    /** Sample and prediction agree */
    consistent: '#9aa0a6',
    /** The sample excludes the prediction — the model is saying something the runs deny */
    off: '#f87171',
    /** Under the floor: present, not yet a reading */
    pending: '#6b7280',
});

/** The three trackers' legacy base keys, keyed by kind */
const STORE_KEYS = {
    transmute: 'transmuteSessions',
    decompose: 'decomposeSessions',
    coinify: 'coinifySessions',
};

/** One character's sessions, summarised lazily, kept until they age out */
const cache = {
    charId: null,
    /** kind → summary from `summarizeKind`, or null before the first read */
    summaries: null,
    loadedAt: 0,
    loading: null,
};

/**
 * A rate as a whole percentage, the way both surfaces already print one.
 * @param {number|null} rate - 0..1
 * @returns {string}
 */
function ratePercent(rate) {
    return Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '—';
}

/**
 * An attempt count with thousands separators, so 2140 reads as a count.
 * @param {number} n - Attempts
 * @returns {string}
 */
function countText(n) {
    return Number(n || 0).toLocaleString('en-US');
}

/**
 * The line to draw beside a forecast, or nothing.
 *
 * Pure: the combination summary in, the string out. Every rule about what is
 * and is not shown lives here so it can be tested without a DOM, a store or a
 * character.
 *
 * @param {Object|null} combo - One entry from `summarizeKind`'s `combos`
 * @param {Object} [options] - Overrides
 * @param {number} [options.predicted] - The rate the surface is quoting, 0..1.
 *   Falls back to the combination's own attempt-weighted prediction; passing
 *   the live one is better, because it is what the reader is looking at.
 * @param {number} [options.minAttempts] - The floor, injectable for tests
 * @returns {{text: string, tone: 'consistent'|'off'|'pending', color: string,
 *   title: string, enough: boolean, attempts: number}|null} Null when there is
 *   nothing at all to say
 */
export function describeMeasuredRate(combo, { predicted = null, minAttempts = MIN_ATTEMPTS } = {}) {
    const attempts = Math.max(0, Math.floor(Number(combo?.attempts) || 0));
    // Never run, or never stamped: no reading and no progress towards one
    if (!combo || attempts <= 0) return null;

    const forecast = Number.isFinite(predicted) ? predicted : combo.predicted;

    if (attempts < Math.max(1, minAttempts)) {
        return {
            text: `measured n=${countText(attempts)}/${minAttempts}`,
            tone: 'pending',
            color: MEASURED_COLORS.pending,
            title:
                `This combination has ${countText(attempts)} recorded attempts. A success rate needs ` +
                `${minAttempts} before the sample can contradict the forecast, so no measured rate is shown yet — ` +
                'the count alone says the history is being kept.\n' +
                'The forecast is unaffected either way: the measured rate is never fed back into it.',
            enough: false,
            attempts,
        };
    }

    const off = combo.verdict === 'sim too high' || combo.verdict === 'sim too low';
    const text =
        `predicted ${ratePercent(forecast)} · measured ${ratePercent(combo.observed)} ` +
        `(n=${countText(attempts)}, ${off ? verdictText(combo).toLowerCase() : 'consistent'})`;

    const interval =
        Number.isFinite(combo.low) && Number.isFinite(combo.high)
            ? `\nThe sample's 95% Wilson interval is ${ratePercent(combo.low)}–${ratePercent(combo.high)}.`
            : '';
    const meaning = off
        ? `The forecast sits outside that interval, so these ${countText(attempts)} attempts are saying something ` +
          'the model does not allow for.'
        : 'The forecast sits inside that interval — the attempts so far are consistent with it.';

    return {
        text,
        tone: off ? 'off' : 'consistent',
        color: off ? MEASURED_COLORS.off : MEASURED_COLORS.consistent,
        title:
            `Measured over ${countText(attempts)} recorded attempts on this exact item, catalyst and ` +
            `enhancement level, against the rate that was stamped on those sessions when they ran.${interval}\n` +
            `${meaning}\n` +
            'This is shown, never used: the profit and the ranking are computed from the forecast alone. ' +
            'Scoring an item by its own measured rate would sink an unlucky item out of the ranking, stop it ' +
            'being run, and leave it no way to earn the attempts that would clear its name.',
        enough: true,
        attempts,
    };
}

/**
 * Read the three trackers' sessions and summarise them. One read at a time; a
 * second ask while one is in flight joins it.
 * @returns {Promise<Object>} kind → summary
 */
export async function loadMeasuredRates() {
    const charId = dataManager.getCurrentCharacterId?.() || null;
    const scope = charId || NO_CHARACTER;
    if (cache.loading && cache.charId === charId) return cache.loading;

    cache.charId = charId;
    cache.loading = (async () => {
        const sessionsByKind = {};
        await Promise.all(
            ALCHEMY_KINDS.map(async (kind) => {
                try {
                    // A fresh store per read: a kept instance would serve its
                    // first read forever, and the trackers write through their
                    // own instances, so this one's memory would never move
                    const store = createAlchemySessionStore(STORE_KEYS[kind], 'AlchemyMeasuredRate');
                    sessionsByKind[kind] = (await store.load(scope)) || [];
                } catch (error) {
                    // One unreadable tracker must not blank the other two
                    console.error(`[AlchemyMeasuredRate] Could not read ${kind} sessions:`, error);
                    sessionsByKind[kind] = [];
                }
            })
        );

        const summaries = {};
        for (const kind of ALCHEMY_KINDS) summaries[kind] = summarizeKind(kind, sessionsByKind[kind]);
        // The character may have changed while the read was out
        if (cache.charId === charId) {
            cache.summaries = summaries;
            cache.loadedAt = Date.now();
        }
        return summaries;
    })().finally(() => {
        if (cache.charId === charId) cache.loading = null;
    });

    return cache.loading;
}

/**
 * Forget what is cached, so the next ask reads the sessions again.
 */
export function invalidateMeasuredRates() {
    cache.charId = null;
    cache.summaries = null;
    cache.loadedAt = 0;
    cache.loading = null;
}

/**
 * The cached summaries, kicking off a read when there is none or it has aged.
 * @returns {Object|null} kind → summary, or null before the first read lands
 */
function cachedSummaries() {
    const charId = dataManager.getCurrentCharacterId?.() || null;
    if (cache.charId !== charId) {
        invalidateMeasuredRates();
        loadMeasuredRates();
        return null;
    }
    if (cache.summaries === null || Date.now() - cache.loadedAt > CACHE_TTL_MS) {
        // Fire and forget: the stale answer is served until the fresh one lands
        loadMeasuredRates();
    }
    return cache.summaries;
}

/**
 * The recorded history for one exact combination, synchronously, from whatever
 * the cache holds.
 *
 * Exact by construction, and deliberately so. There is no fall back to "all
 * transmutes" the way the profit-calibration badge falls back to a whole skill:
 * a transmute success rate is a property of the item and the catalyst, so
 * borrowing another item's rate would not be a weaker version of the answer, it
 * would be a different question.
 *
 * @param {string} kind - `transmute` | `decompose` | `coinify`
 * @param {Object} identity - What the surface is showing
 * @param {string} identity.inputItemHrid - The item being alchemised
 * @param {string|null} [identity.catalystHrid] - The catalyst, if any
 * @param {number} [identity.enhancementLevel] - Its enhancement level
 * @returns {Object|null} The combination summary, or null when unknown
 */
export function measuredComboFor(kind, { inputItemHrid, catalystHrid = null, enhancementLevel = 0 } = {}) {
    if (!kind || !inputItemHrid) return null;
    const summaries = cachedSummaries();
    if (!summaries) return null;

    const key = comboKey({
        inputItemHrid,
        predictedCatalystHrid: catalystHrid,
        enhancementLevel,
    });
    return summaries[kind]?.combos?.find((combo) => combo.key === key) || null;
}

/**
 * The line for one forecast, or null — the whole lookup in one call.
 *
 * @param {string} kind - `transmute` | `decompose` | `coinify`
 * @param {Object} identity - Passed to {@link measuredComboFor}
 * @param {Object} [options] - Passed to {@link describeMeasuredRate}
 * @returns {Object|null} From `describeMeasuredRate`, or null
 */
export function measuredRateFor(kind, identity, options = {}) {
    try {
        return describeMeasuredRate(measuredComboFor(kind, identity), options);
    } catch (error) {
        console.error('[AlchemyMeasuredRate] Measured-rate lookup failed:', error);
        return null;
    }
}

/**
 * The line as an element, styled to sit beside a forecast without competing
 * with it.
 * @param {Object|null} measured - From `describeMeasuredRate`
 * @returns {HTMLElement|null}
 */
export function measuredRateElement(measured) {
    if (!measured || typeof document === 'undefined') return null;
    const span = document.createElement('span');
    span.className = 'mwi-alchemy-measured-rate';
    span.dataset.tone = measured.tone;
    span.title = measured.title;
    span.style.cssText =
        `margin-left:6px; font-size:0.85em; white-space:nowrap; cursor:help; color:${measured.color};` +
        (measured.enough ? '' : ' opacity:0.65;');
    span.textContent = measured.text;
    return span;
}

/**
 * Append the measured line to a forecast line, when there is one to show.
 *
 * @param {HTMLElement|null} line - The line the forecast is on
 * @param {string} kind - `transmute` | `decompose` | `coinify`
 * @param {Object} identity - Passed to {@link measuredComboFor}
 * @param {Object} [options] - Passed to {@link describeMeasuredRate}
 * @returns {HTMLElement|null} The element appended, or null
 */
export function appendMeasuredRate(line, kind, identity, options = {}) {
    if (!line) return null;
    const span = measuredRateElement(measuredRateFor(kind, identity, options));
    if (span) line.appendChild(span);
    return span;
}

export default {
    MIN_ATTEMPTS,
    CACHE_TTL_MS,
    MEASURED_COLORS,
    describeMeasuredRate,
    loadMeasuredRates,
    invalidateMeasuredRates,
    measuredComboFor,
    measuredRateFor,
    measuredRateElement,
    appendMeasuredRate,
};
