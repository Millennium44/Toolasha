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
 *
 * ## Where the target lives, and why it is split in two
 *
 * A recording can be asked for a set amount — so many fights, or so many minutes
 * — and two things have to agree about what that amount is: the recorder, which
 * enforces it, and both panels, which show progress towards it. The *value*
 * therefore lives on the shared recorder, for the same reason the recording
 * does: a copy per bundle would have the DPs panel counting towards a target the
 * Combat bundle is not recording to.
 *
 * The *storage* lives here, because the recorder has no business reaching into
 * IndexedDB, and because the target is a preference of the person rather than a
 * property of one sitting — it is meant to still be there tomorrow. Scoped per
 * character, since a hundred fights is an evening on one character and half a
 * day on another.
 */

import combatRecorder from './combat-recorder.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';

/**
 * The recorder everything else is using.
 * @returns {Object|null} The shared recorder, or null when there is none
 */
export function recorder() {
    const shared = typeof window !== 'undefined' ? window.Toolasha?.Combat?.combatRecorder : null;
    return shared || combatRecorder || null;
}

/**
 * Where the last-used target is kept, per character.
 *
 * The pre-scoping global value is not adopted because there was never one — the
 * key is new — but the discard keeps the scoping honest if a bare key ever
 * appears from a hand-edited store.
 */
const TARGET_KEY = 'combatRecordControl_target';

const DISCARD_LEGACY = { migrate: 'discard' };

/** The units a target can be counted in, in the order the toggle cycles them */
export const TARGET_UNITS = ['fights', 'minutes'];

/** Read once per character; a switch clears it, see {@link resetRecordTargetCache} */
let targetLoaded = false;
let targetLoading = null;

/**
 * Bumped whenever the target is set from outside a load.
 *
 * The read is fired off from the panel's redraw and lands whenever storage gets
 * round to it, which can easily be after somebody has typed a target into the
 * box. Without this, the load would helpfully put the old value back a moment
 * after the new one was set, and the box would appear to reject what was typed
 * into it.
 */
let targetGeneration = 0;

/**
 * Put the persisted target back on the recorder, once.
 *
 * Called from {@link recordControlState}, which every panel calls on every
 * redraw, so nothing has to remember to prime it — and so a target survives a
 * reload without anything owning an `initialize`. The read is fire-and-forget:
 * the panels redraw on a timer, so the first draw shows unlimited and the one a
 * moment later shows the target.
 *
 * @returns {Promise<Object|null>} The target that was restored
 */
export async function loadRecordTarget() {
    if (targetLoaded) return recordTarget();
    if (targetLoading) return targetLoading;

    targetLoading = (async () => {
        const generation = targetGeneration;
        try {
            const stored = await readScoped(TARGET_KEY, 'settings', null, DISCARD_LEGACY);
            targetLoaded = true;
            // Somebody set one while this was in the air. Theirs is newer than
            // anything on disk, and putting the disk's value back would read as
            // the box refusing what was typed into it.
            if (generation !== targetGeneration) return recordTarget();

            return recorder()?.setRecordTarget?.(stored) ?? null;
        } catch (error) {
            console.error('[RecordControl] Reading the record target failed:', error);
            targetLoaded = true;
            return null;
        } finally {
            targetLoading = null;
        }
    })();
    return targetLoading;
}

/**
 * The target now, straight off the recorder rather than off a copy.
 * @returns {{value: number, unit: string}|null} null for unlimited
 */
export function recordTarget() {
    return recorder()?.recordTarget?.() ?? null;
}

/**
 * Set the target and remember it for next time.
 *
 * @param {Object|null} target - `{value, unit}`, or null/anything malformed for unlimited
 * @returns {Promise<Object|null>} What was actually set
 */
export async function setRecordTarget(target) {
    const applied = recorder()?.setRecordTarget?.(target) ?? null;
    // Marked loaded, and the generation moved on: a target set by hand is the
    // newest word on the subject, and a load already in the air would otherwise
    // land afterwards and put the old one back
    targetLoaded = true;
    targetGeneration += 1;
    try {
        await writeScoped(TARGET_KEY, applied, 'settings');
    } catch (error) {
        console.error('[RecordControl] Remembering the record target failed:', error);
    }
    return applied;
}

/**
 * Forget which character's target was read.
 *
 * A character switch does not reload the page, and a hundred-fight target set on
 * one character is not the other one's.
 */
export function resetRecordTargetCache() {
    targetLoaded = false;
    targetLoading = null;
    // A read still in the air belongs to the character being switched away from
    targetGeneration += 1;
}

/**
 * How far along a targeted recording is, in words.
 *
 * @param {Object} target - `{value, unit}`
 * @param {Object} status - From `recordingStatus()`
 * @returns {string}
 */
function progressText(target, status) {
    if (target.unit === 'fights') {
        return `Recording ${Number(status.fights) || 0}/${target.value} fights…`;
    }
    const minutes = Math.floor((Number(status.seconds) || 0) / 60);
    return `Recording ${minutes}m of ${target.value}m…`;
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
 * ## Why a finished target says so
 *
 * A recording that stopped itself stopped while nobody was looking, and a button
 * back to reading "Record (100 fights kept)" is indistinguishable from one that
 * was never started. "Done" is the only part of this the button can say that
 * nothing else does.
 *
 * @returns {{recording: boolean, ticks: number, fights: number, target: Object|null,
 *   done: boolean, label: string, title: string}|null}
 *   null when no recorder is reachable, which is a panel that should draw no
 *   button at all rather than a dead one
 */
export function recordControlState() {
    const rec = recorder();
    if (!rec?.isRecording || !rec?.recordingStatus) return null;

    // Every panel calls this on every redraw, which makes it the one place a
    // persisted target can be restored without anything owning an initialize
    loadRecordTarget();

    const recording = Boolean(rec.isRecording());
    const status = rec.recordingStatus() || {};
    const ticks = Number(status.ticks) || 0;
    const fights = Number(status.fights) || 0;
    const target = rec.normalizeTarget ? rec.normalizeTarget(status.target) : null;
    const done = !recording && Boolean(status.targetMet) && fights > 0;
    const caught = fights ? `${fights} fight${fights === 1 ? '' : 's'}` : null;

    if (recording) {
        return {
            recording: true,
            ticks,
            fights,
            target,
            done: false,
            label: target ? progressText(target, status) : caught ? `Recording ${caught}…` : `Recording ${ticks}…`,
            title: target
                ? 'Stop recording early. Left alone it stops itself at the target, at the end of a fight rather ' +
                  'than in the middle of one.'
                : 'Stop recording. Everything captured so far is kept, and it keeps going past the tick limit — ' +
                  'long recordings are banked in segments rather than cut off.',
        };
    }

    if (done) {
        return {
            recording: false,
            ticks,
            fights,
            target,
            done: true,
            label: `Done — ${caught}`,
            title: 'The recording reached its target and stopped itself at the end of a fight. Press to start another.',
        };
    }

    return {
        recording: false,
        ticks,
        fights,
        target,
        done: false,
        label: caught ? `Record (${caught} kept)` : ticks ? `Record (${ticks} kept)` : 'Record',
        title: target
            ? `Record the combat feed until ${target.value} ${target.unit}, then stop. Start it during a fight — ` +
              'an idle recording captures nothing.'
            : 'Record the combat feed. Start it during a fight — an idle recording captures nothing.',
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
