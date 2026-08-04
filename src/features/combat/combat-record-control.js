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
 * ## Why it counts fights and not ticks
 *
 * The tick count was the only sign a recording was actually catching something:
 * a recording started outside combat sits at zero until a fight starts, and a
 * button reading only "Recording…" cannot tell that apart from one that is
 * working. It is still that sign, but only until the first fight ends.
 *
 * After that the fight count is the better one, and once the recorder started
 * banking segments it became the *only* correct one — a rotation empties the
 * tick buffer, so a label reading ticks would count up to four thousand, drop to
 * zero, and count up again on a recording that never stopped. Fights are
 * cumulative over the whole run, which is what somebody watching the button
 * means by "how much have I got".
 *
 * @returns {{recording: boolean, ticks: number, fights: number, label: string, title: string}|null}
 *   null when no recorder is reachable, which is a panel that should draw no
 *   button at all rather than a dead one
 */
export function recordControlState() {
    const rec = recorder();
    if (!rec?.isRecording || !rec?.recordingStatus) return null;

    const recording = Boolean(rec.isRecording());
    const status = rec.recordingStatus() || {};
    const ticks = Number(status.ticks) || 0;
    const fights = Number(status.fights) || 0;
    const caught = fights ? `${fights} fight${fights === 1 ? '' : 's'}` : null;

    if (recording) {
        return {
            recording: true,
            ticks,
            fights,
            label: caught ? `Recording ${caught}…` : `Recording ${ticks}…`,
            title:
                'Stop recording. Everything captured so far is kept, and it keeps going past the tick limit — ' +
                'long recordings are banked in segments rather than cut off.',
        };
    }

    return {
        recording: false,
        ticks,
        fights,
        label: caught ? `Record (${caught} kept)` : ticks ? `Record (${ticks} kept)` : 'Record',
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
