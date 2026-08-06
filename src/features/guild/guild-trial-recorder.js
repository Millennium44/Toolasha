/**
 * Recording a trial while it happens, without being asked twice.
 *
 * Everything the trials feature knows is already captured as it goes — samples
 * off the panel, loadouts off the socket, damage off the battle feed. What was
 * missing is a *session*: a start, an end, and the series in between, kept
 * somewhere that survives a reload, so that after the hour is over there is
 * something to look at rather than only whatever the last render happened to
 * hold.
 *
 * ## Starting without a button
 *
 * A trial does not announce itself on the socket, so the start is inferred from
 * the two things that only happen during one, either of which is enough:
 *
 * - **A trial fight.** `guild-trial-damage.js` arms when a battle can be shown
 *   to be this week's trial encounter, and that gate is deliberately narrow.
 * - **A reading off the In Progress tab.** A tile sample with a bar on it means
 *   a trial is running and the player is looking at it.
 *
 * Polled rather than pushed for the first of those, so the damage module keeps
 * knowing nothing about this one and the dependency stays one-way.
 *
 * ## Ending without a button either
 *
 * A trial runs for an hour of active time, so a session that has seen nothing
 * for {@link IDLE_STOP_MS} or has run past {@link TRIAL_ACTIVE_MS} is over. Both
 * are recorded as the reason it ended, because "it stopped by itself" and "you
 * stopped it" are different claims about the data.
 *
 * ## What a snapshot is
 *
 * The per-player breakdown as it stood, thinned to the fields a later reading
 * wants — a full breakdown every fifteen seconds for an hour would be a
 * megabyte of repeated names. The snapshots are what make a *rate over time*
 * recoverable after the fact; the final breakdown alone cannot say whether the
 * healer was carrying the first half or the second.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import guildTrialDamage from './guild-trial-damage.js';
import guildTrialSkilling from './guild-trial-skilling.js';
import { loadLoadouts } from './guild-loadouts.js';
import { supportCoverage } from './guild-trial-support.js';
import guildMemberSkills from './guild-member-skills.js';
import { TRIAL_ACTIVE_MS, trialWeekStart } from './guild-trials-math.js';
import { loadTrialRecord } from './guild-trials-store.js';

/** Object store sessions live in — shared with the rest of the guild history */
const STORE_NAME = 'guildHistory';

/** Key prefix; the guild name is appended, as the trial record's key is */
const KEY_PREFIX = 'guildTrialSession';

/** How often the recorder looks at the trial and takes a snapshot */
export const SNAPSHOT_MS = 15_000;

/** Nothing seen for this long and the trial is over */
export const IDLE_STOP_MS = 10 * 60_000;

/** An hour of snapshots at one every fifteen seconds is 240; this is the ceiling */
export const MAX_SNAPSHOTS = 400;

/**
 * Longest a session somebody pressed Record for is left running.
 *
 * Not a rule about trials — a cycle is two of them and takes a couple of hours —
 * but a backstop against a session left open for a week by somebody who forgot.
 * The user's hand is what stops a manual session; this is only there so that
 * "forever" is not a state the recorder can be in.
 */
export const MANUAL_MAX_MS = 6 * 60 * 60 * 1000;

/** A silence longer than this, while recording, is noted as a gap in the data */
export const GAP_AFTER_MS = 3 * SNAPSHOT_MS;

/**
 * Storage key for a guild's most recent session.
 *
 * Falls back to the character rather than to one shared bucket, for the reason
 * `guildTrialsStorageKey` spells out: two characters in one tab must not read
 * each other's trials back.
 *
 * @param {string|null} guildName - Guild name, or null before it is known
 * @param {string|number|null} [characterId] - The viewing character, for the fallback key
 * @returns {string} Storage key
 */
export function trialSessionStorageKey(guildName, characterId = null) {
    if (guildName) return `${KEY_PREFIX}_${guildName}`;
    return characterId === null || characterId === undefined
        ? `${KEY_PREFIX}_default`
        : `${KEY_PREFIX}_char_${characterId}`;
}

/**
 * A breakdown thinned to what a session wants to keep every fifteen seconds.
 *
 * Pure, and exported because it is the only part of a session with a decision in
 * it: what is worth a quarter of a minute of storage and what is not.
 *
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @param {number} at - When it was taken
 * @returns {Object} A snapshot
 */
export function thinBreakdown(breakdown, at) {
    const support = breakdown?.support?.players || [];
    const supportOf = (index) => support.find((row) => row.index === index) || null;

    return {
        t: at,
        seconds: breakdown?.seconds ?? 0,
        fights: breakdown?.fights ?? 0,
        totalDamage: breakdown?.totalDamage ?? 0,
        partyDps: breakdown?.partyDps ?? null,
        players: (breakdown?.players || []).map((player) => ({
            index: player.index,
            name: player.name,
            damage: player.damage,
            deaths: player.deaths,
            healingDone: supportOf(player.index)?.healingDone ?? 0,
            damageTaken: supportOf(player.index)?.damageTaken ?? 0,
        })),
    };
}

class GuildTrialRecorder {
    constructor() {
        this.initialized = false;
        this.timers = createTimerRegistry();
        this.watcherId = null;
        this.session = null;
        this.guildName = null;
        this.characterId = null;
        /** Last moment anything said a trial was happening */
        this.lastActivityAt = 0;
        /** Where the guild panel says the cycle is; null until one has been read */
        this.phase = null;
    }

    /**
     * Start watching for a trial to begin.
     * @param {string|null} guildName - The key sessions are stored under
     */
    initialize(guildName = null) {
        this.guildName = guildName;
        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
        if (this.initialized) return;
        this.initialized = true;

        this.watcherId = setInterval(() => this._tick(), SNAPSHOT_MS);
        this.timers.registerInterval(this.watcherId);
    }

    cleanup() {
        this.timers.clearAll();
        this.watcherId = null;
        this.initialized = false;
    }

    /** @param {string|null} guildName - The key sessions are stored under */
    setGuildName(guildName) {
        this.guildName = guildName || null;
        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
    }

    /**
     * Forget this character's session entirely.
     *
     * Called when the tab changes character: a session belongs to the character
     * that recorded it, and carrying one across would file the next guild's
     * trial under the last one's snapshots.
     */
    forget() {
        this.session = null;
        this.lastActivityAt = 0;
        this.phase = null;
        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
    }

    /** @returns {boolean} Whether a session is open */
    get recording() {
        return Boolean(this.session && !this.session.endedAt);
    }

    /**
     * Begin a session.
     *
     * Idempotent: the two auto-start signals routinely arrive together, and the
     * button is a third.
     *
     * @param {string} reason - What started it, for the export
     * @param {number} [at] - Clock
     * @returns {Object|null} The session
     */
    start(reason, at = Date.now()) {
        if (this.recording) return this.session;

        this.session = {
            startedAt: at,
            endedAt: null,
            startedBy: reason,
            endedBy: null,
            weekStart: trialWeekStart(at),
            characterId: dataManager.getCurrentCharacterId?.() ?? null,
            snapshots: [],
        };
        this.lastActivityAt = at;
        this._snapshot(at);
        return this.session;
    }

    /**
     * End the session and write it down.
     * @param {string} reason - What ended it
     * @param {number} [at] - Clock
     * @returns {Object|null} The finished session
     */
    stop(reason, at = Date.now()) {
        if (!this.session) return null;
        if (!this.session.endedAt) {
            this._snapshot(at);
            this.session.endedAt = at;
            this.session.endedBy = reason;
            this._persist();
        }
        return this.session;
    }

    /**
     * Throw the session away and begin a fresh one.
     *
     * The panel's "end and start a new record" is this, and it is one gesture
     * rather than two so that the pair cannot be left half-done.
     *
     * @param {number} [at] - Clock
     * @returns {Object|null} The new session
     */
    restart(at = Date.now()) {
        this.stop('restarted', at);
        this.session = null;
        guildTrialDamage.reset();
        return this.start('button', at);
    }

    /**
     * Something happened that only happens during a trial.
     * @param {string} kind - What was seen, for the export
     * @param {number} [at] - Clock
     */
    noteActivity(kind, at = Date.now()) {
        this.lastActivityAt = at;

        // Something is happening, so whatever the panel last said about the
        // cycle is out of date. Cleared rather than set to `live`: this module
        // does not read the page and will not claim to. Leaving a stale
        // `completed` here is what would make a session start and be stopped by
        // the watcher on the same tick, forever — which is exactly the gap
        // between a skilling hour ending and the combat hour beginning.
        this.phase = null;

        if (this.recording) return;
        if (!config.getSetting('guildTrialAutoRecord', true)) return;
        this.start(kind, at);
    }

    /**
     * Where the guild panel says the cycle is.
     *
     * The recorder cannot read the page itself and will not guess. A phase it
     * has never been told is `null`, and `null` is *not* permission to record —
     * which is the bug this exists for: a session was found running on a guild
     * whose weekly trials were not on at all, because "no status seen" was
     * being treated the same as "a trial is live".
     *
     * A cycle is two trials — a skilling hour and then a combat one — and the
     * lull between them reads as `completed` and then `scheduled`. That closes
     * the skilling session, which is right, and it must not stop the *next* one
     * from arming: `noteActivity` clears the phase the moment the combat hour
     * produces a reading or a fight, so the recorder rolls over into it without
     * anybody pressing anything. A session somebody started by hand is not
     * closed at all and simply spans both.
     *
     * @param {string|null} phase - `scheduled`, `live`, `completed` or null
     * @param {number} [at] - Clock
     */
    noteLifecycle(phase, at = Date.now()) {
        this.phase = phase || null;
        if (!this.recording) return;

        // A session somebody pressed Record for is theirs to stop
        if (this.session?.startedBy === 'button') return;
        if (this.phase && this.phase !== 'live') this.stop(`the trial is ${this.phase}`, at);
    }

    /** The watcher: arm on a trial fight, snapshot while recording, stop when it is over */
    _tick() {
        try {
            const now = Date.now();
            const breakdown = guildTrialDamage.breakdown?.();
            // A fight the damage gate has armed is a trial by the gate's own
            // narrow test, which is evidence enough on its own
            if (breakdown?.active) this.noteActivity('trial-fight', now);

            if (!this.recording) return;

            this._snapshot(now);

            const automatic = this.session.startedBy !== 'button';

            // Silence is not evidence of anything. Readings only arrive while the
            // guild panel is open, so a player who closes it to go and forage
            // starves the recorder — and the ten-minute rule then stopped the
            // session they had started by hand, mid-trial, which is what was
            // reported. A gap in the data is a gap in the data; it is written
            // down rather than acted on.
            const quietFor = now - this.lastActivityAt;
            if (quietFor > GAP_AFTER_MS) this._noteGap(now, quietFor);

            // A session somebody pressed Record for stops when they say so. The
            // rules below are for the ones that armed themselves.
            const ranLong = now - this.session.startedAt > (automatic ? TRIAL_ACTIVE_MS : MANUAL_MAX_MS);
            // …and even then, not while the panel says a trial is running: an
            // open trial with a shut panel is still an open trial
            const wentQuiet = automatic && this.phase !== 'live' && quietFor > IDLE_STOP_MS;
            const notRunning = automatic && !breakdown?.active && this.phase && this.phase !== 'live';

            if (ranLong || wentQuiet || notRunning) {
                this.stop(
                    ranLong
                        ? automatic
                            ? 'the hour a trial runs for elapsed'
                            : 'left recording for six hours'
                        : notRunning
                          ? `the trial is ${this.phase}`
                          : 'nothing seen',
                    now
                );
            } else this._persist();
        } catch (error) {
            console.error('[GuildTrialRecorder] Watching the trial failed:', error);
        }
    }

    /**
     * Write down that the data stopped arriving for a while.
     *
     * Expected rather than exceptional: nothing reaches this recorder while the
     * guild panel is shut, so a session that spans somebody going off to do
     * something else *will* have holes in it. A reader of the export should be
     * able to see where they are rather than reading a flat stretch as a trial
     * where nothing happened.
     *
     * @param {number} at - Clock
     * @param {number} quietFor - How long the silence has lasted
     */
    _noteGap(at, quietFor) {
        if (!this.session) return;
        const gaps = (this.session.gaps ||= []);
        const last = gaps[gaps.length - 1];

        // One gap, extended, rather than one per tick of the same silence
        if (last && at - last.to <= SNAPSHOT_MS * 2) {
            last.to = at;
            last.ms = last.to - last.from;
            return;
        }
        gaps.push({ from: at - quietFor, to: at, ms: quietFor });
        if (gaps.length > 50) gaps.shift();
    }

    /**
     * Take one snapshot, if there is anything in it worth keeping.
     * @param {number} at - Clock
     */
    _snapshot(at) {
        if (!this.session) return;

        const breakdown = guildTrialDamage.breakdown?.();
        if (!breakdown?.players?.length) return;

        const snapshot = thinBreakdown(breakdown, at);
        const previous = this.session.snapshots[this.session.snapshots.length - 1];
        // A trial nobody is fighting produces the same snapshot forever, and a
        // series of identical readings is not a series
        if (previous && previous.totalDamage === snapshot.totalDamage && previous.seconds === snapshot.seconds) return;

        this.session.snapshots.push(snapshot);
        if (this.session.snapshots.length > MAX_SNAPSHOTS) this.session.snapshots.shift();
    }

    /** Write the session down; not awaited by callers on the render path */
    async _persist() {
        try {
            if (!this.session) return;
            await storage.set(trialSessionStorageKey(this.guildName, this.characterId), this.session, STORE_NAME);
        } catch (error) {
            console.error('[GuildTrialRecorder] Saving the session failed:', error);
        }
    }

    /**
     * The session in hand, or the last one written down.
     * @returns {Promise<Object|null>} A session
     */
    async loadSession() {
        if (this.session) return this.session;
        try {
            return await storage.get(trialSessionStorageKey(this.guildName, this.characterId), STORE_NAME, null);
        } catch (error) {
            console.error('[GuildTrialRecorder] Reading the session failed:', error);
            return null;
        }
    }
}

const guildTrialRecorder = new GuildTrialRecorder();

/**
 * Everything the trials feature knows right now, as one object.
 *
 * The single builder behind both the console helper and the panel's download
 * button — the two used to be one function in the chat commands file, which is
 * where a button could not reach it.
 *
 * Additive only: every field the previous export had is still here under the
 * same name, so a bundle saved by an older build and one saved by this one can
 * be read by the same reader.
 *
 * @param {Object} [options] - Injectables, for tests
 * @param {string|null} [options.guildName] - The key the record is stored under
 * @returns {Promise<Object>} The bundle
 */
export async function buildTrialExport({ guildName = null } = {}) {
    const characterId = dataManager.getCurrentCharacterId?.() ?? null;
    const record = await loadTrialRecord(guildName, Date.now(), characterId);
    const loadouts = characterId ? await loadLoadouts(characterId) : null;
    const trialDamage = guildTrialDamage.breakdown?.() ?? null;
    const session = await guildTrialRecorder.loadSession();

    return {
        exportedAt: new Date().toISOString(),
        guildName,
        characterId,
        record,
        loadouts,
        trialDamage,
        // New, and additive: the session the recorder kept, a statement of what
        // the battle feed can and cannot say about a player, and the members'
        // skill levels the profile cycler has collected — which is the only
        // source a skilling trial's forecast has
        session,
        coverage: supportCoverage(),
        memberSkills: guildMemberSkills.all?.() ?? {},
        // What the socket said about the skilling half — the pool, the tier, the
        // participants and the per-tier personal figures, none of which needed a
        // tab to be open
        trialSkilling: guildTrialSkilling.snapshot?.() ?? null,
    };
}

/**
 * Download a bundle as a file.
 * @param {Object} bundle - From {@link buildTrialExport}
 * @returns {boolean} True when the download was started
 */
export function downloadTrialExport(bundle) {
    try {
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `toolasha-trial-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(url);
        return true;
    } catch (error) {
        console.error('[GuildTrialRecorder] Trial export download failed (data still returned):', error);
        return false;
    }
}

export default guildTrialRecorder;
export { guildTrialRecorder };
