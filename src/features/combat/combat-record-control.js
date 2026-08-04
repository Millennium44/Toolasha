/**
 * Combat record control
 *
 * The Record button, as a state and an action rather than as a button.
 *
 * Two panels want to start the same recording: DPs, where a disagreement about
 * attribution is what makes you reach for one, and Sim Accuracy, which is
 * useless until a recording exists and previously could only tell you to go and
 * press the button on the other panel. A second implementation of "start, stop,
 * relabel" would be a second answer to what the button says while a recording is
 * running, and the two would drift the first time either changed.
 *
 * So the decision lives here and the panels supply only their own chrome. There
 * is one recorder and one recording, so both buttons show the same thing at the
 * same time however the recording was started — including by the auto-record
 * setting, which nobody pressed at all.
 *
 * ## Why the recorder is looked up rather than used
 *
 * In the multi-bundle build each library carries its own copy of a module, so a
 * panel in the UI bundle importing the recorder directly would start a recording
 * in a copy nothing else can see. `window.Toolasha.Combat.combatRecorder` is the
 * one the rest of the game talks to; the import is the fallback for the
 * standalone build and for tests.
 */

import combatRecorder from './combat-recorder.js';

/**
 * The recorder everything else is using.
 * @returns {Object|null} The shared recorder, or null when there is none
 */
export function recorder() {
    const shared = typeof window !== 'undefined' ? window.Toolasha?.Combat?.combatRecorder : null;
    return shared || combatRecorder || null;
}

/**
 * What a Record button should say and look like right now.
 *
 * The tick count is carried in the label because it is the only sign that a
 * recording is actually catching something: a recording started outside combat
 * sits at zero until a fight starts, and a button that says only "Recording…"
 * cannot tell that apart from a recording that is working.
 *
 * @returns {{recording: boolean, ticks: number, label: string, title: string}|null}
 *   null when no recorder is reachable, which is a panel that should draw no
 *   button at all rather than a dead one
 */
export function recordControlState() {
    const rec = recorder();
    if (!rec?.isRecording || !rec?.recordingStatus) return null;

    const recording = Boolean(rec.isRecording());
    const ticks = Number(rec.recordingStatus()?.ticks) || 0;

    if (recording) {
        return {
            recording: true,
            ticks,
            label: `Recording ${ticks}…`,
            title: 'Stop recording. Everything captured so far is kept.',
        };
    }

    return {
        recording: false,
        ticks,
        label: ticks ? `Record (${ticks} kept)` : 'Record',
        title: 'Record the combat feed. Start it during a fight — an idle recording captures nothing.',
    };
}

/**
 * Start the recording, or stop the one that is running.
 *
 * @param {Object} [options] - `download: true` writes the file out on stop,
 *   which is what a recording made to be handed over is for. A recording made to
 *   feed a check on this machine is read by whatever listened for it finishing,
 *   so nothing is written.
 * @returns {boolean|null} Whether a recording is running afterwards, or null
 *   when there was no recorder to drive
 */
export function toggleRecording({ download = false } = {}) {
    const rec = recorder();
    if (!rec?.isRecording) return null;

    if (rec.isRecording()) {
        rec.stopRecording();
        if (download) rec.downloadRecording();
        return false;
    }

    rec.startRecording();
    return true;
}
