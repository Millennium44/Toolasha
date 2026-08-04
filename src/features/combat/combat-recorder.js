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
 * ## Why it is bounded
 *
 * Ticks arrive several times a second, so an unbounded recording is a tab that
 * quietly grows until it falls over. It stops at a fixed number of ticks and
 * says so rather than continuing to grow.
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

/** Enough for a long fight, small enough to hand to somebody */
const MAX_TICKS = 4000;

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
let onNewBattle = null;
let onBattleUpdated = null;
let full = false;
let sawNewBattle = false;
let panelSnapshots = 0;
let stopTimer = null;

/** Called with the finished file whenever a recording ends with something in it */
const completionListeners = new Set();

/**
 * Be told when a recording finishes.
 *
 * A recording is only worth anything to something that reads it, and the moment
 * it stops is the only moment anything knows it is complete — polling
 * `isRecording` would mean every reader owning a timer for an event that happens
 * a handful of times a session.
 *
 * @param {Function} listener - Called with the file, as `recordingFile()` returns it
 * @returns {Function} Call it to stop listening
 */
export function onRecordingComplete(listener) {
    completionListeners.add(listener);
    return () => completionListeners.delete(listener);
}

/** @returns {boolean} Whether a recording is in progress */
export function isRecording() {
    return recording;
}

/** @returns {{ticks: number, seconds: number, full: boolean}} How much has been captured */
export function recordingStatus() {
    return {
        ticks: ticks.length,
        seconds: startedAt ? (Date.now() - startedAt) / 1000 : 0,
        full,
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
    full = false;
    sawNewBattle = false;
    panelSnapshots = 0;
    startedAt = Date.now();
    recording = true;

    onNewBattle = (data) => {
        sawNewBattle = true;
        capture('new_battle', data);
    };
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
function capture(type, payload) {
    if (!recording) return;
    if (ticks.length >= MAX_TICKS) {
        full = true;
        stopRecording();
        return;
    }

    const entry = { at: Date.now() - startedAt, type, payload };

    // Only while the wave is unknown. Once `new_battle` has arrived the payload
    // names everything and the screen has nothing left to add.
    if (!sawNewBattle && type === 'battle_updated' && panelSnapshots < MAX_PANEL_SNAPSHOTS) {
        entry.panel = describeMonsterPanel();
        panelSnapshots += 1;
    }
    ticks.push(entry);
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
    const finished = recording && ticks.length > 0;
    recording = false;
    if (!finished) return;

    const file = recordingFile();
    for (const listener of completionListeners) {
        try {
            listener(file);
        } catch (error) {
            console.error('[CombatRecorder] A completion listener failed:', error);
        }
    }
}

/**
 * The recording, in the shape the replay script reads.
 *
 * @returns {Object}
 */
export function recordingFile() {
    return {
        format: 'toolasha-combat-recording',
        version: 1,
        seconds: startedAt ? (Date.now() - startedAt) / 1000 : 0,
        truncated: full,
        ticks,
    };
}

/**
 * Write the recording out.
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
};
