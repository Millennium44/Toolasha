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

/**
 * The units a target can be counted in, in the order the toggle cycles them.
 *
 * `noise` is a band and not a count: record until the 95% margin on the sample
 * is under this many percent. It is the unit the accuracy check's own suggestion
 * is phrased in — "±5% is where differences start being findings" — and the
 * other two are proxies for it that nobody can convert in advance.
 */
export const TARGET_UNITS = ['fights', 'minutes', 'noise'];

/** What the unit toggle shows for each */
export const UNIT_LABELS = { fights: 'fights', minutes: 'min', noise: '±%' };

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
 * A target read from disk while a recording was running, waiting for it to stop.
 *
 * `{target}` rather than the target itself, because null is a value here —
 * unlimited — and "nothing pending" has to be distinguishable from "pending
 * unlimited".
 */
let pending = null;

/**
 * Restore the persisted target, when there is a quiet moment to do it in.
 *
 * Called from the panels' redraw rather than from an initialize, so a target
 * survives a reload without anything owning one. Fire-and-forget: the panels
 * redraw on a timer, so the first draw shows unlimited and the one a moment
 * later shows the target.
 *
 * Kept separate from {@link recordControlState} on purpose — see the note there
 * on why the function every panel calls on every redraw must not write.
 */
export function primeRecordTarget() {
    // A recording in flight was started with whatever target it was started
    // with, and changing that underneath it is at best a surprise
    if (recorder()?.isRecording?.()) return;

    if (pending) {
        const { target } = pending;
        pending = null;
        recorder()?.setRecordTarget?.(target);
        return;
    }

    loadRecordTarget();
}

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
            // A recording started before this landed is already running to
            // whatever it was started with, and a target restored underneath it
            // is a rule changed mid-run — at best a surprise, at worst a stop,
            // since a stored target smaller than the fights already recorded is
            // met the moment it arrives. Held rather than dropped, so the next
            // quiet moment restores it properly.
            targetLoaded = true;
            if (recorder()?.isRecording?.()) {
                pending = { target: stored };
                return recordTarget();
            }

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
    // A target set by hand outranks one waiting to be restored from disk
    pending = null;
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
    pending = null;
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
    if (target.unit === 'minutes') {
        const minutes = Math.floor((Number(status.seconds) || 0) / 60);
        return `Recording ${minutes}m of ${target.value}m…`;
    }

    // A band is not a count, so there is no "n of m" to show — what there is is
    // where the sample stands, which is the number being waited on. Before the
    // first measurement there is nothing to show but the fights so far.
    const fights = Number(status.fights) || 0;
    const band = Number(status.marginPct);
    const at = Number.isFinite(band) && status.marginPct !== null ? `±${formatBand(band)}%` : 'measuring';
    return `Recording ${fights} fight${fights === 1 ? '' : 's'} — ${at} of ±${target.value}%…`;
}

/**
 * A margin, at the precision it is worth reading.
 *
 * @param {number} value - Percent
 * @returns {string}
 */
export function formatBand(value) {
    return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

/** Said on every idle Record button, because an idle recording catches nothing */
const START_HINT = 'Start it during a fight — an idle recording captures nothing.';

/**
 * A target in words, for the button's tooltip.
 *
 * @param {Object} target - `{value, unit}`
 * @returns {string}
 */
function targetText(target) {
    if (target.unit === 'noise') return `the sample's margin is under ±${target.value}%`;
    return `${target.value} ${target.unit}`;
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
 * ## Why it does not write anything
 *
 * It used to restore the persisted target from here, which made the one function
 * every panel calls on every redraw also the one function that mutates the
 * recorder. That is fine until something else is busy: a simulation run holds the
 * main thread and IndexedDB for long enough that a read fired before it lands
 * during it, and the value it puts back is applied to the recording *in
 * progress*. A stale twenty-fight target landing on a run already past forty
 * fights stops it at the next boundary — a recording that appears to have stopped
 * itself for no reason anybody watching could name.
 *
 * So this reads and only reads. Restoring the target is {@link primeRecordTarget},
 * called from the same places but explicitly, and it refuses to touch a recording
 * that is running — a preference is for the next recording, not the one in flight.
 *
 * @returns {{recording: boolean, ticks: number, fights: number, target: Object|null,
 *   done: boolean, marginPct: number|null, label: string, title: string}|null}
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
    const target = rec.normalizeTarget ? rec.normalizeTarget(status.target) : null;
    const done = !recording && Boolean(status.targetMet) && fights > 0;
    const caught = fights ? `${fights} fight${fights === 1 ? '' : 's'}` : null;
    const measured = Number.isFinite(Number(status.marginPct)) ? Number(status.marginPct) : null;
    // What the recording was actually asked for, said out loud on the finish:
    // "Done — 41 fights" leaves out the number the whole target was about
    const band = measured !== null && target?.unit === 'noise' ? `, ±${formatBand(measured)}%` : '';

    if (recording) {
        return {
            recording: true,
            ticks,
            fights,
            target,
            done: false,
            marginPct: measured,
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
            marginPct: measured,
            label: `Done — ${caught}${band}`,
            title: 'The recording reached its target and stopped itself at the end of a fight. Press to start another.',
        };
    }

    return {
        recording: false,
        ticks,
        fights,
        target,
        done: false,
        marginPct: measured,
        label: caught ? `Record (${caught} kept)` : ticks ? `Record (${ticks} kept)` : 'Record',
        title: target
            ? `Record the combat feed until ${targetText(target)}, then stop. ${START_HINT}`
            : `Record the combat feed. ${START_HINT}`,
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
