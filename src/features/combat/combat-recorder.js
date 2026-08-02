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
 */

import webSocketHook from '../../core/websocket.js';

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

let ticks = [];
let recording = false;
let startedAt = 0;
let onNewBattle = null;
let onBattleUpdated = null;
let full = false;

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
export function startRecording() {
    stopRecording();

    ticks = [];
    full = false;
    startedAt = Date.now();
    recording = true;

    onNewBattle = (data) => capture('new_battle', data);
    onBattleUpdated = (data) => capture('battle_updated', { pMap: data?.pMap, mMap: data?.mMap });

    hook().on('new_battle', onNewBattle);
    hook().on('battle_updated', onBattleUpdated);
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
    ticks.push({ at: Date.now() - startedAt, type, payload });
}

/** Stop keeping it. What has been captured stays captured. */
export function stopRecording() {
    if (onNewBattle) hook().off('new_battle', onNewBattle);
    if (onBattleUpdated) hook().off('battle_updated', onBattleUpdated);
    onNewBattle = null;
    onBattleUpdated = null;
    recording = false;
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
    initialize: () => {},
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
};
