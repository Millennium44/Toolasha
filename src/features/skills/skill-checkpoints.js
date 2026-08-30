/**
 * Daily skill checkpoints.
 *
 * One reading of every skill's experience and level per local day, kept
 * forever, so questions longer than a week have somewhere to come from.
 *
 * ## Why not widen the XP tracker
 *
 * `xp-tracker.js` keeps a week and thins it hard, and both of those are
 * load-bearing — the thinning is what a cross-device merge replays to reach the
 * same answer on both devices. Widening its window would change the shape two
 * builds have to agree on. So this is a separate, much smaller series beside
 * it: see `utils/daily-checkpoints.js` for what an entry means and why nothing
 * is ever backfilled into it.
 *
 * ## When a checkpoint is written
 *
 * Opportunistically: on init and on `skills_updated`, write today's checkpoint
 * for any skill that has not got one. There is no timer. A day the game is
 * never opened records nothing, which is a gap the surfaces name rather than
 * paper over; a day it is opened records the reading at the first moment it
 * was, which is the earliest and therefore widest anchor the day can offer.
 *
 * The character id is captured before the awaits and re-checked after them.
 * `skills_updated` can land while a switch is in flight, and a reading filed
 * under the wrong character is not a mislabelling — it is a jump of the whole
 * gap between two characters' totals, read later as a gain.
 *
 * ## The surface
 *
 * `monthToDate()` is the display math: what a skill has gained since the first
 * checkpoint of the current calendar month, together with the day that
 * measurement actually starts from and the day the whole history starts. The
 * skill tooltip in `xp-tracker.js` is the first thing to show it.
 */

import dataManager from '../../core/data-manager.js';
import {
    createDailyCheckpoints,
    localDayKey,
    gainedSince,
    historyStart,
    seriesOf,
} from '../../utils/daily-checkpoints.js';

const STORE_NAME = 'xpHistory';

/**
 * The record prefix.
 *
 * Deliberately spelled apart from the legacy stem below (`skillCheckpointRec_`
 * against `skillCheckpoints_`) so the sync registry's two matchers stay
 * disjoint — the same separation `tradeLedgerRec_`/`tradeLedgerRecords` keeps,
 * and for the same reason: a character id must never be readable as a chunk id.
 */
const RECORD_PREFIX = 'skillCheckpointRec';

const checkpoints = createDailyCheckpoints({
    storeName: STORE_NAME,
    prefix: RECORD_PREFIX,
    // Nothing was ever written here — this series is chunked from its first
    // day. It is declared because it is what gives the store its sync-merge
    // cover for the legacy shape, and because a store that cannot split (a
    // full disk) falls back to exactly this key.
    legacyKey: (charId) => `skillCheckpoints_${charId}`,
    label: 'SkillCheckpoints',
});

export { RECORD_PREFIX, checkpoints };

/**
 * What a skill has gained so far this calendar month.
 *
 * Measured from the first checkpoint on or after the first of the month to the
 * skill's live experience — so today's play is in today's figure rather than
 * waiting for tomorrow's checkpoint.
 *
 * `since` is the day the measurement genuinely starts from, which in the first
 * month is the day the history starts rather than the first of the month.
 * Every caller has to show it; a month figure that quietly covers nine days is
 * the whole failure mode this feature exists to avoid.
 *
 * @param {Array<Object>} entries - Every checkpoint held
 * @param {string} skillHrid - Which skill
 * @param {number} currentXp - Experience as it stands now
 * @param {number} [now] - Clock, injectable for tests
 * @returns {{gained: number, since: string, start: string}|null} Null when the
 *   month holds no checkpoint for this skill
 */
export function monthToDate(entries, skillHrid, currentXp, now = Date.now()) {
    const monthStart = `${localDayKey(now).slice(0, 7)}-01`;
    const gained = gainedSince(entries, skillHrid, monthStart, currentXp);
    if (!gained) return null;
    return { ...gained, start: historyStart(entries, skillHrid) };
}

/**
 * The checkpoints held in memory for one skill, oldest first.
 * @param {string} skillHrid - Which skill
 * @returns {Array<Object>} Its checkpoints
 */
export function checkpointsFor(skillHrid) {
    return seriesOf(checkpoints.peek(), skillHrid);
}

/**
 * This month's gain for one skill, from what is already in memory.
 *
 * A read, not a load: the tooltip that calls this renders synchronously while
 * the pointer is over a skill, and the entries were read at init. A character
 * whose entries have not landed yet reports nothing rather than a figure
 * measured against an empty history.
 *
 * @param {string} skillHrid - Which skill
 * @param {number} currentXp - Experience as it stands now
 * @param {number} [now] - Clock, injectable for tests
 * @returns {{gained: number, since: string, start: string}|null}
 */
export function monthToDateFor(skillHrid, currentXp, now = Date.now()) {
    return monthToDate(checkpoints.peek(), skillHrid, currentXp, now);
}

class SkillCheckpoints {
    constructor() {
        this.isActive = false;
        this._handlers = null;
    }

    /** @returns {string|null} Whose record, or null before login */
    _currentCharId() {
        return dataManager.getCurrentCharacterId?.() || null;
    }

    /**
     * Today's reading of every skill the game currently reports.
     * @returns {Array<{k: string, xp: number, level: number}>} Samples
     */
    _samples() {
        const skills = dataManager.getSkills?.() || [];
        const samples = [];
        for (const skill of skills) {
            if (!skill?.skillHrid || !Number.isFinite(skill.experience)) continue;
            samples.push({ k: skill.skillHrid, xp: skill.experience, level: skill.level });
        }
        return samples;
    }

    /**
     * Write today's checkpoints if they are missing.
     *
     * The character id is read once, before the store's read, and checked again
     * after it — `_capture` is called from an event handler that can fire while
     * a switch is in flight.
     *
     * @returns {Promise<number>} How many checkpoints were written
     */
    async _capture() {
        try {
            const charId = this._currentCharId();
            if (!charId) return 0;

            const samples = this._samples();
            if (samples.length === 0) return 0;

            const written = await checkpoints.recordToday(charId, samples);
            // The switch landed inside the write path; the store refuses the
            // write itself, and this is only here so the return value cannot
            // claim otherwise
            return this._currentCharId() === charId ? written : 0;
        } catch (error) {
            console.error('[SkillCheckpoints] Writing today’s checkpoint failed:', error);
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
            characterSwitching: () => checkpoints.forget(),
        };

        dataManager.on('character_initialized', this._handlers.characterInitialized);
        dataManager.on('skills_updated', this._handlers.skillsUpdated);
        dataManager.on('character_switching', this._handlers.characterSwitching);

        this.isActive = true;

        // Already logged in when the feature started: `character_initialized`
        // has been and gone, and waiting for the next one would cost a day
        if (dataManager.characterData) await this._capture();
    }

    /** Stop recording and drop the listeners. */
    cleanup() {
        if (this._handlers) {
            dataManager.off('character_initialized', this._handlers.characterInitialized);
            dataManager.off('skills_updated', this._handlers.skillsUpdated);
            dataManager.off('character_switching', this._handlers.characterSwitching);
            this._handlers = null;
        }
        this.isActive = false;
    }
}

const skillCheckpoints = new SkillCheckpoints();

export { skillCheckpoints };

export default {
    key: 'skillCheckpoints',
    name: 'Daily Skill Checkpoints',
    initialize: () => skillCheckpoints.initialize(),
    cleanup: () => skillCheckpoints.cleanup(),
};
