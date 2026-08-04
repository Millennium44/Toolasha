/**
 * Combat recorder
 *
 * Capturing the raw combat feed so attribution can be argued about with
 * evidence.
 *
 * Damage attribution is inferred rather than read — mana falling identifies the
 * caster, a counter rising identifies a hit — and every inference is a place to
 * be wrong. When this panel and another disagree about which ability did what,
 * there is no way to settle it from two screenshots: both are summaries of a
 * fight that has already happened, and neither can be re-run.
 *
 * So the fight is kept. A recording is the payloads exactly as they arrived,
 * which can be replayed through the attribution offline as many times as it
 * takes, and turned into a fixture that fails when a change breaks it.
 *
 * ## What is kept
 *
 * `new_battle` whole — it is one payload per fight and carries the names, the
 * health bars and the abilities. From `battle_updated`, only `pMap` and `mMap`,
 * which is everything attribution reads and none of the rest. No character
 * name, no chat, nothing about the account.
 *
 * ## Why it is bounded, and why it no longer stops
 *
 * Ticks arrive several times a second, so an unbounded buffer is a tab that
 * quietly grows until it falls over. It used to stop at a fixed number of ticks,
 * which made "how long can I record?" a question with a disappointing answer:
 * about ten minutes, and then silence.
 *
 * The buffer is still bounded, but reaching the bound now **banks the segment
 * and carries on**. A full buffer is handed to the completion listeners exactly
 * as a finished recording is — the check that reads them folds each segment into
 * the same per-zone sample — and the recorder starts a fresh buffer. Memory is
 * capped at one segment; the recording is capped by nothing.
 *
 * The rotation waits for a fight boundary. Cutting mid-fight loses that fight
 * from *both* sides of the cut: the old segment's last battle never closes, and
 * the new segment's opening ticks belong to a battle it never saw begin. So the
 * `new_battle` that triggers the rotation terminates the old segment and opens
 * the new one, and no fight is lost. A single fight that outruns the hard
 * ceiling is the one case that still cuts mid-fight, and it says so.
 *
 * ## Surviving a refresh
 *
 * A recording lives in memory and a reload is the end of it. That is fine for a
 * recording being made to hand over — you are watching it — and wrong for one
 * feeding the accuracy check, which is meant to be left running.
 *
 * So the recorder announces itself at every fight boundary, and whatever is
 * keeping the observations writes a summary of the fights so far. Not the raw
 * ticks: those are megabytes and arrive several times a second. Per fight, at
 * fight boundaries only, is a write every few seconds of a few hundred bytes.
 *
 * ## Recording the refresh
 *
 * A recording started by hand can never capture the first seconds of a session,
 * and those are the interesting ones: reload mid-fight and the client never sees
 * the message that names what you are fighting. What arrives instead, and in
 * what order, is not something to reason about from the outside.
 *
 * So it can start itself. With **Auto-record on load** on, it begins the moment
 * the feature starts, runs for a set number of seconds and writes the file out
 * without being asked. It also snapshots the battle panel on every tick until
 * the first `new_battle` arrives, because whether the names can be read off the
 * screen during that window is the other half of the same question.
 *
 * **It disarms itself once it has a file.** A switch that downloads something on
 * every page load until somebody remembers to turn it off is a switch left on by
 * accident, and the thing it is for — collecting one recording to hand over — is
 * finished the moment the file exists. Turn it on again for the next one.
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import { describeMonsterPanel } from '../../utils/battle-panel-monsters.js';

/**
 * Ticks per segment.
 *
 * Enough for a long fight, small enough to hand to somebody. Reaching it banks
 * the segment rather than ending the recording — see the module note.
 */
const MAX_TICKS = 4000;

/**
 * The point at which a segment is cut whether or not a fight has ended.
 *
 * The fight-boundary rotation depends on a fight ending. One that never does —
 * a dungeon boss, a stuck client — would grow the buffer forever, which is the
 * failure the bound exists to prevent. Twice the soft bound is far beyond any
 * real fight, so reaching it is a fault rather than a long battle, and the
 * segment is marked as having lost one.
 */
const MAX_TICKS_HARD = MAX_TICKS * 2;

/**
 * The shared hook instance.
 *
 * In the multi-bundle build each library carries its own copy of the websocket
 * module and only the Core one has `install` called, so a listener registered
 * on a bundle-local copy hears nothing at all.
 *
 * @returns {Object}
 */
function hook() {
    return (typeof window !== 'undefined' && window.Toolasha?.Core?.webSocketHook) || webSocketHook;
}

/** Panel snapshots stop once the wave is known, since the payload names it then */
const MAX_PANEL_SNAPSHOTS = 40;

let ticks = [];
let recording = false;
let startedAt = 0;
let recordingStartedAt = 0;
let onNewBattle = null;
let onBattleUpdated = null;
let lostFight = false;
let sawNewBattle = false;
let panelSnapshots = 0;
let stopTimer = null;
let segmentIndex = 0;
let completedFights = 0;
let loadout = null;

/** Called with the finished file whenever a recording ends with something in it */
const completionListeners = new Set();

/** Called with the recording so far, at every fight boundary */
const checkpointListeners = new Set();

/** Called when a recording ends by being stopped, whether or not it caught anything */
const stopListeners = new Set();

/** Called once the feature has been initialized, which is after settings have loaded */
const sessionListeners = new Set();

/**
 * What was being worn when the recording started, if anything can say.
 *
 * The recorder cannot build this itself: the loadout the simulator consumes is
 * assembled by the combat-sim adapter, which lives in another bundle, and a
 * recorder that could not run without the simulator loaded would be a recorder
 * that stops working the day the bundles are rearranged. Whoever wants a
 * snapshot supplies the means of taking one.
 */
let loadoutProvider = null;

/**
 * Say how to snapshot the loadout at the start of every segment.
 *
 * @param {Function|null} provider - Returns the snapshot, or null when it cannot
 */
export function setLoadoutProvider(provider) {
    loadoutProvider = typeof provider === 'function' ? provider : null;
}

/** @returns {Object|null} The snapshot, or null when nothing can take one */
function captureLoadout() {
    if (!loadoutProvider) return null;
    try {
        return loadoutProvider() ?? null;
    } catch (error) {
        console.error('[CombatRecorder] Snapshotting the loadout failed:', error);
        return null;
    }
}

/**
 * Be told when a recording finishes.
 *
 * A recording is only worth anything to something that reads it, and the moment
 * it stops is the only moment anything knows it is complete — polling
 * `isRecording` would mean every reader owning a timer for an event that happens
 * a handful of times a session.
 *
 * A banked segment arrives here too, and looks exactly like a finished
 * recording, because to a reader that folds fights into a sample it is one.
 *
 * @param {Function} listener - Called with the file, as `recordingFile()` returns it
 * @returns {Function} Call it to stop listening
 */
export function onRecordingComplete(listener) {
    completionListeners.add(listener);
    return () => completionListeners.delete(listener);
}

/**
 * Be told, at every fight boundary, what has been recorded so far.
 *
 * This is the hook a refresh is survived through: the listener writes a summary
 * somewhere that outlives the tab. Fired with the current segment only, and
 * fired with an empty one immediately after a rotation, so a listener that
 * persists it knows the previous checkpoint is now stale.
 *
 * @param {Function} listener - Called with the file, as `recordingFile()` returns it
 * @returns {Function} Call it to stop listening
 */
export function onRecordingCheckpoint(listener) {
    checkpointListeners.add(listener);
    return () => checkpointListeners.delete(listener);
}

/**
 * Be told when a running recording is stopped.
 *
 * Distinct from finishing: a recording stopped just after a rotation has nothing
 * to hand over and still needs whatever was checkpointed cleared, or the next
 * session recovers a prefix of a segment already folded in.
 *
 * @param {Function} listener - Called with no arguments
 * @returns {Function} Call it to stop listening
 */
export function onRecordingStopped(listener) {
    stopListeners.add(listener);
    return () => stopListeners.delete(listener);
}

/**
 * Be told once the recorder has been initialized.
 *
 * Features are initialized after settings load, which makes this the first
 * moment anything downstream can read its own switch — and so the moment to look
 * for a recording the last session was interrupted in the middle of.
 *
 * @param {Function} listener - Called with no arguments
 * @returns {Function} Call it to stop listening
 */
export function onSessionStart(listener) {
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
}

/**
 * Hand a file to a set of listeners, without letting one of them stop the rest.
 *
 * @param {Set<Function>} listeners - Who to tell
 * @param {*} [payload] - What to tell them
 */
function notify(listeners, payload) {
    for (const listener of listeners) {
        try {
            listener(payload);
        } catch (error) {
            console.error('[CombatRecorder] A listener failed:', error);
        }
    }
}

/** @returns {boolean} Whether a recording is in progress */
export function isRecording() {
    return recording;
}

/**
 * How much has been captured.
 *
 * `ticks` is the current segment, because that is what is in memory. `fights` is
 * the whole recording, because that is what anybody asking "how long have I been
 * recording?" means — a rotation resets the tick count and resets nothing about
 * the run.
 *
 * @returns {{ticks: number, seconds: number, full: boolean, fights: number, segments: number}}
 */
export function recordingStatus() {
    return {
        ticks: ticks.length,
        seconds: recordingStartedAt ? (Date.now() - recordingStartedAt) / 1000 : 0,
        full: lostFight,
        fights: completedFights,
        segments: segmentIndex + 1,
    };
}

/**
 * Start keeping the combat feed.
 *
 * Anything previously captured is dropped: a recording is one sitting, and
 * appending a second run to the first would produce a file that replays as a
 * fight that never happened.
 */
export function startRecording({ seconds = 0, thenDownload = false } = {}) {
    stopRecording();

    ticks = [];
    lostFight = false;
    sawNewBattle = false;
    panelSnapshots = 0;
    segmentIndex = 0;
    completedFights = 0;
    startedAt = Date.now();
    recordingStartedAt = startedAt;
    recording = true;
    loadout = captureLoadout();

    // `capture` is what notes the wave as known, because it is also what counts
    // the fight the message closes, and the two have to agree about which
    // `new_battle` was the first one
    onNewBattle = (data) => capture('new_battle', data);
    onBattleUpdated = (data) => capture('battle_updated', { pMap: data?.pMap, mMap: data?.mMap });

    hook().on('new_battle', onNewBattle);
    hook().on('battle_updated', onBattleUpdated);

    if (seconds > 0) {
        stopTimer = setTimeout(() => {
            stopRecording();
            // Unattended by definition: nobody is watching a recording that
            // started itself, so it has to hand over the file on its own — and
            // then put the switch back, so the next load is an ordinary one
            if (!thenDownload) return;

            if (downloadRecording()) config.setSetting('combatRecorder_autoStart', false);
        }, seconds * 1000);
    }
}

/**
 * One payload, stamped so a replay can reproduce the timing.
 *
 * @param {string} type - Which message
 * @param {Object} payload - What it carried
 */
function push(type, payload) {
    const entry = { at: Date.now() - startedAt, type, payload };

    // Only while the wave is unknown. Once `new_battle` has arrived the payload
    // names everything and the screen has nothing left to add.
    if (!sawNewBattle && type === 'battle_updated' && panelSnapshots < MAX_PANEL_SNAPSHOTS) {
        entry.panel = describeMonsterPanel();
        panelSnapshots += 1;
    }
    ticks.push(entry);
}

/**
 * Bank the segment and start the next one.
 *
 * The banked segment is announced as a finished recording, because that is what
 * it is to anything folding fights into a sample. The clock restarts with it, so
 * every segment's `at` values begin near zero and a replay of one does not have
 * to know it was the fortieth.
 */
function rotateSegment() {
    const file = recordingFile();

    ticks = [];
    segmentIndex += 1;
    startedAt = Date.now();
    lostFight = false;
    loadout = captureLoadout();

    notify(completionListeners, file);
}

/**
 * Keep one payload, rotating the segment when the buffer is full.
 *
 * @param {string} type - Which message
 * @param {Object} payload - What it carried
 */
function capture(type, payload) {
    if (!recording) return;

    // A `new_battle` closes the battle before it. The first one closes nothing —
    // whatever was being fought when the recording began has no beginning here
    const closesFight = type === 'new_battle' && sawNewBattle;

    push(type, payload);
    if (type === 'new_battle') sawNewBattle = true;
    if (closesFight) completedFights += 1;

    const atBoundary = type === 'new_battle';
    const rotating = ticks.length >= MAX_TICKS && (atBoundary || ticks.length >= MAX_TICKS_HARD);

    if (!rotating) {
        // Only at a fight boundary: a checkpoint costs a re-derivation and a
        // write, and mid-fight there is nothing new to derive
        if (closesFight) notify(checkpointListeners, recordingFile());
        return;
    }

    // Cut mid-fight only because nothing ended in a whole segment's worth of
    // ticks. That fight is lost, and the file says so rather than reading as a
    // clean run that happened to be short of one battle.
    if (!atBoundary) lostFight = true;

    rotateSegment();

    // The battle that closed the old segment opens the new one. It is the same
    // payload in both, and harmless in both: the old segment reads it only as
    // the end of its last fight, the new one only as the start of its first.
    if (atBoundary) push('new_battle', payload);

    // The segment just banked is already folded in, so whatever was checkpointed
    // from it is now a duplicate waiting to happen
    notify(checkpointListeners, recordingFile());
}

/** Stop keeping it. What has been captured stays captured. */
export function stopRecording() {
    clearTimeout(stopTimer);
    stopTimer = null;
    if (onNewBattle) hook().off('new_battle', onNewBattle);
    if (onBattleUpdated) hook().off('battle_updated', onBattleUpdated);
    onNewBattle = null;
    onBattleUpdated = null;

    // Only a recording that was running and caught something has finished; a
    // second `stopRecording` on an idle module has not ended anything, and
    // announcing it would have every listener read the same run twice
    const wasRecording = recording;
    const finished = recording && ticks.length > 0;
    recording = false;
    if (finished) notify(completionListeners, recordingFile());

    // Announced even when the last segment was empty. A recording stopped just
    // after a rotation has nothing to hand over and still has a checkpoint
    // sitting in storage that nothing else will ever clear.
    if (wasRecording) notify(stopListeners);
}

/**
 * The current segment, in the shape the replay script reads.
 *
 * A segment and not the whole recording: earlier segments have already been
 * handed to the completion listeners and are not kept, which is the entire point
 * of banking them.
 *
 * @returns {Object}
 */
export function recordingFile() {
    return {
        format: 'toolasha-combat-recording',
        version: 1,
        seconds: startedAt ? (Date.now() - startedAt) / 1000 : 0,
        truncated: lostFight,
        segment: segmentIndex,
        loadout,
        // A copy, because a checkpoint listener is handed this mid-recording and
        // the buffer it was read from goes on filling up behind it
        ticks: [...ticks],
    };
}

/**
 * Write the current segment out.
 *
 * @returns {boolean} Whether there was anything to write
 */
export function downloadRecording() {
    if (!ticks.length) return false;

    try {
        const blob = new Blob([JSON.stringify(recordingFile())], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `toolasha-combat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        return true;
    } catch (error) {
        console.error('[CombatRecorder] Writing the recording failed:', error);
        return false;
    }
}

export default {
    name: 'Combat Recorder',
    initialize: () => {
        // Before the auto-start, and unconditionally: what listens for this is
        // looking for a recording the *last* session was interrupted in the
        // middle of, which has nothing to do with whether this one records
        notify(sessionListeners);

        if (!config.getSetting('combatRecorder_autoStart')) return;

        const seconds = Number(config.getSettingValue('combatRecorder_autoStartSeconds', 60)) || 60;
        startRecording({ seconds, thenDownload: true });
        console.log(`[CombatRecorder] Auto-recording the first ${seconds}s of this session`);
    },
    cleanup: () => {
        stopRecording();
        ticks = [];
    },
    isRecording,
    recordingStatus,
    startRecording,
    stopRecording,
    downloadRecording,
    recordingFile,
    onRecordingComplete,
    onRecordingCheckpoint,
    onRecordingStopped,
    onSessionStart,
    setLoadoutProvider,
};
