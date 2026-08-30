/**
 * Daily ability checkpoints.
 *
 * One reading of every known ability's experience and level per local day, on
 * the same infrastructure as the skill checkpoints (`utils/daily-checkpoints.js`).
 *
 * ## Why the panel needs a long window
 *
 * `ability-book-panel.js` divides the experience an ability still owes by a
 * rate measured over the last ten minutes. That is the right measurement for
 * "how fast am I going right now" and a poor one for "when will this level",
 * which is the question the column actually answers: ten minutes of a fight is
 * not ten minutes of a fortnight, and an ability trained in bursts reads as
 * either unmeasurable or absurdly fast depending on when you look.
 *
 * A fortnight of daily checkpoints measures the thing the column is claiming.
 * It is only honest with its window attached, which is why
 * {@link checkpointRate} refuses to return a bare number: it comes back with
 * the days it spans and the days that recorded a gain, and the panel prints
 * both. "3.2K/hr measured over 14 days, 3 with combat" is a figure a reader can
 * use; "3.2K/hr" over the same data is one that misleads them about a rate
 * eleven days of which were idle.
 *
 * ## The key is per character, always
 *
 * A checkpoint's series key is `<characterId>|<abilityHrid>` and never the
 * ability alone. The panel's ten-minute history was keyed on the hrid, and an
 * ironcow with more Puncture experience than main switching in read as main
 * gaining that whole gap between two samples — tens of millions of experience
 * per hour, self-healing only when the departed reading fell out of the window
 * (see the `character_switching` clear near the bottom of
 * `ability-book-panel.js`, which must not be undone). A *persisted* series has
 * no ten-minute window to fall out of: the same mistake here would be a wrong
 * number written to disk, and it would still be there next year. The character
 * is in the record key as well, so the two must agree for an entry to be read
 * at all.
 *
 * ## Known abilities, not equipped ones
 *
 * `characterAbilities` is the list that carries experience, and it holds every
 * ability learned rather than the five in slots. Recording all of them means
 * unequipping an ability does not put a hole in its series — the checkpoints
 * keep saying what its experience was, which for an ability nobody is training
 * is a run of flat entries and a true zero rate.
 */

import dataManager from '../../core/data-manager.js';
import {
    createDailyCheckpoints,
    checkpointRate as rateOverCheckpoints,
    historyStart,
    seriesOf,
} from '../../utils/daily-checkpoints.js';

const STORE_NAME = 'xpHistory';

/**
 * The record prefix, spelled apart from the legacy stem (`abilityCheckpointRec_`
 * against `abilityCheckpoints_`) so the sync registry's two matchers stay
 * disjoint and a character id can never be read as a chunk id.
 */
const RECORD_PREFIX = 'abilityCheckpointRec';

/** Shortest window worth reporting a checkpoint-derived rate over */
const MIN_WINDOW_DAYS = 3;

const checkpoints = createDailyCheckpoints({
    storeName: STORE_NAME,
    prefix: RECORD_PREFIX,
    legacyKey: (charId) => `abilityCheckpoints_${charId}`,
    label: 'AbilityCheckpoints',
});

export { RECORD_PREFIX, MIN_WINDOW_DAYS, checkpoints };

/**
 * The series key one character's ability is recorded under.
 *
 * Exported because it is the whole safety property of this module, and a test
 * that two characters' copies of one ability stay apart has to be able to name
 * both keys.
 *
 * @param {string} characterId - Whose ability
 * @param {string} abilityHrid - Which ability
 * @returns {string|null} `<characterId>|<abilityHrid>`, or null when either is missing
 */
export function seriesKey(characterId, abilityHrid) {
    if (!characterId || !abilityHrid) return null;
    return `${characterId}|${abilityHrid}`;
}

/**
 * The rate a long window of checkpoints measures, with the window attached.
 *
 * @param {Array<Object>} entries - Every checkpoint held
 * @param {string} characterId - Whose ability
 * @param {string} abilityHrid - Which ability
 * @returns {{experiencePerHour: number, days: number, daysWithGain: number, gained: number,
 *   from: string, to: string}|null} Null when the window is shorter than
 *   {@link MIN_WINDOW_DAYS}, or when no day in it recorded a gain
 */
export function checkpointRate(entries, characterId, abilityHrid) {
    const key = seriesKey(characterId, abilityHrid);
    if (!key) return null;
    return rateOverCheckpoints(entries, key, MIN_WINDOW_DAYS);
}

/**
 * How a checkpoint-derived rate must be described wherever it is shown.
 *
 * The days-with-combat count is not optional decoration. A bare per-hour figure
 * from a fortnight, three days of which had any fighting at all, reads as a
 * sustained rate and is not one; the label is what stops it being read that
 * way, so it is built here rather than left to each caller to remember.
 *
 * @param {{days: number, daysWithGain: number}} rate - From {@link checkpointRate}
 * @returns {string} e.g. `measured over 14 days, 3 with combat`
 */
export function rateWindowLabel(rate) {
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    return `measured over ${plural(rate.days, 'day')}, ${rate.daysWithGain} with combat`;
}

/**
 * The current character's checkpoint-derived rate for one ability, from memory.
 *
 * A read rather than a load: the panel redraws on a five-second timer and the
 * entries were read when the feature started. Nothing loaded yet reports null,
 * and the panel falls back to its live ten-minute rate — which is what it did
 * before this existed, so the fallback is the old behaviour rather than a hole.
 *
 * @param {string} abilityHrid - Which ability
 * @returns {{experiencePerHour: number, days: number, daysWithGain: number, gained: number,
 *   from: string, to: string}|null}
 */
export function rateFor(abilityHrid) {
    const charId = checkpoints.characterId();
    if (!charId) return null;
    return checkpointRate(checkpoints.peek(), charId, abilityHrid);
}

/**
 * The day this ability's checkpoints start, for the current character.
 * @param {string} abilityHrid - Which ability
 * @returns {string|null} Local day id, or null when nothing is recorded
 */
export function startDayFor(abilityHrid) {
    const key = seriesKey(checkpoints.characterId(), abilityHrid);
    return key ? historyStart(checkpoints.peek(), key) : null;
}

/**
 * The checkpoints held in memory for one of the current character's abilities.
 * @param {string} abilityHrid - Which ability
 * @returns {Array<Object>} Its checkpoints, oldest first
 */
export function checkpointsFor(abilityHrid) {
    const key = seriesKey(checkpoints.characterId(), abilityHrid);
    return key ? seriesOf(checkpoints.peek(), key) : [];
}

class AbilityCheckpoints {
    constructor() {
        this.isActive = false;
        this._handlers = null;
    }

    /** @returns {string|null} Whose record, or null before login */
    _currentCharId() {
        return dataManager.getCurrentCharacterId?.() || null;
    }

    /**
     * Today's reading of every ability the character has learned.
     * @param {string} charId - Whose abilities, for the series key
     * @returns {Array<{k: string, xp: number, level: number}>} Samples
     */
    _samples(charId) {
        const owned = dataManager.characterData?.characterAbilities || [];
        const samples = [];
        for (const ability of owned) {
            if (!ability?.abilityHrid || !Number.isFinite(ability.experience)) continue;
            samples.push({
                k: seriesKey(charId, ability.abilityHrid),
                xp: ability.experience,
                level: ability.level,
            });
        }
        return samples;
    }

    /**
     * Write today's checkpoints if they are missing.
     *
     * The character id is captured before the store's read and checked again
     * after it: `skills_updated` can land while a switch is in flight, and the
     * series key is built from that id — a stale one would file this
     * character's abilities under the other's key and produce exactly the
     * cross-character jump this module is keyed to prevent.
     *
     * @returns {Promise<number>} How many checkpoints were written
     */
    async _capture() {
        try {
            const charId = this._currentCharId();
            if (!charId) return 0;

            const samples = this._samples(charId);
            if (samples.length === 0) return 0;

            const written = await checkpoints.recordToday(charId, samples);
            return this._currentCharId() === charId ? written : 0;
        } catch (error) {
            console.error('[AbilityCheckpoints] Writing today’s checkpoint failed:', error);
            return 0;
        }
    }

    /**
     * Start recording.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isActive) return;

        this._handlers = {
            characterInitialized: () => {
                this._capture();
            },
            skillsUpdated: () => {
                this._capture();
            },
            abilitiesUpdated: () => {
                this._capture();
            },
            characterSwitching: () => checkpoints.forget(),
        };

        dataManager.on('character_initialized', this._handlers.characterInitialized);
        dataManager.on('skills_updated', this._handlers.skillsUpdated);
        dataManager.on('abilities_updated', this._handlers.abilitiesUpdated);
        dataManager.on('character_switching', this._handlers.characterSwitching);

        this.isActive = true;

        if (dataManager.characterData) await this._capture();
    }

    /** Stop recording and drop the listeners. */
    cleanup() {
        if (this._handlers) {
            dataManager.off('character_initialized', this._handlers.characterInitialized);
            dataManager.off('skills_updated', this._handlers.skillsUpdated);
            dataManager.off('abilities_updated', this._handlers.abilitiesUpdated);
            dataManager.off('character_switching', this._handlers.characterSwitching);
            this._handlers = null;
        }
        this.isActive = false;
    }
}

const abilityCheckpoints = new AbilityCheckpoints();

export { abilityCheckpoints };

export default {
    key: 'abilityCheckpoints',
    name: 'Daily Ability Checkpoints',
    initialize: () => abilityCheckpoints.initialize(),
    cleanup: () => abilityCheckpoints.cleanup(),
};
