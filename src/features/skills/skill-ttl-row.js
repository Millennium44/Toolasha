/**
 * Time-to-level overlay row
 *
 * Which skill is going up, and when it next will.
 *
 * The game shows a progress bar with no rate behind it, so "am I an hour from
 * the next level or a week?" is a question you answer by watching the bar. The
 * XP tracker already answers it in skill tooltips; this puts it where you can
 * see it without hovering anything.
 *
 * ## Why it keeps its own readings
 *
 * The tracker's history is keyed to its own display concerns and lives behind
 * its instance. Two readings of one number is a small enough thing to keep here,
 * and keeping it here means the row works whether or not that feature is on.
 * Readings are taken from the same `characterSkills` the game keeps current, so
 * nothing here is polled out of the DOM.
 *
 * The rate is measured over a rolling window rather than since the session
 * started. A rate measured from the start of an eight-hour idle answers "how
 * fast has this gone on average", when the question is "how fast is it going
 * now" — and they differ by the whole of any break you took.
 *
 * The row is GWhiz's TTL, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import dataManager from '../../core/data-manager.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { timeReadable } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { experiencePerHour, timeToNextLevel, fastestGaining, skillName } from '../../utils/skill-progress.js';

/** How far back the rate is measured over */
const WINDOW_MS = 10 * 60 * 1000;

/** No point re-reading the skill list faster than the overlay redraws */
const SAMPLE_MS = 5000;

/** skillHrid → [{t, xp}], oldest first */
const history = new Map();
let lastSampleAt = 0;

/**
 * Take a reading of every skill, if one is due.
 *
 * Called from `render`, which is the only thing that runs on a clock here — a
 * row nobody is looking at costs nothing, which is the right trade for a figure
 * that is only ever read off the screen.
 */
function sample() {
    const now = Date.now();
    if (now - lastSampleAt < SAMPLE_MS) return;
    lastSampleAt = now;

    const skills = dataManager.getSkills?.();
    if (!skills) return;

    for (const skill of skills) {
        if (!skill?.skillHrid || !Number.isFinite(skill.experience)) continue;

        const readings = history.get(skill.skillHrid) || [];
        readings.push({ t: now, xp: skill.experience });

        // Drop everything that has fallen out of the window, but never the last
        // one before it — that reading is the far end of the measurement
        while (readings.length > 2 && readings[1].t < now - WINDOW_MS) readings.shift();
        history.set(skill.skillHrid, readings);
    }
}

/**
 * The skill going up fastest, and when it levels.
 * @returns {{name: string, level: number, seconds: number|null, xpPerHour: number}|null}
 */
export function trainingSkill() {
    const skills = dataManager.getSkills?.();
    const table = dataManager.getInitClientData?.()?.levelExperienceTable;
    if (!skills || !table) return null;

    const rates = {};
    for (const [hrid, readings] of history) {
        const rate = experiencePerHour(readings[0], readings[readings.length - 1]);
        if (rate) rates[hrid] = rate;
    }

    const hrid = fastestGaining(rates);
    if (!hrid) return null;

    const skill = skills.find((entry) => entry.skillHrid === hrid);
    if (!skill) return null;

    return {
        name: skillName(hrid),
        level: skill.level,
        xpPerHour: rates[hrid],
        seconds: timeToNextLevel({
            experience: skill.experience,
            level: skill.level,
            levelExperienceTable: table,
            xpPerHour: rates[hrid],
        }),
    };
}

registerRow({
    key: 'timeToLevel',
    name: 'Time to Level',
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        sample();

        const training = trainingSkill();
        if (!training) return blank(container);

        // At the cap there is no next level, which is a different answer from
        // "not yet measurable" but reads the same on one line — the tooltip
        // carries the difference
        row(container, [
            { text: `${training.name} ${training.level}:`, color: ROW_COLORS.gold, ellipsis: true },
            {
                text: training.seconds === null ? '—' : timeReadable(training.seconds),
                color: ROW_COLORS.accent,
                push: true,
            },
        ]);
        container.title =
            `${Math.round(training.xpPerHour).toLocaleString()} xp/hr over the last ten minutes.\n` +
            (training.seconds === null ? 'No next level — this skill is at the cap.' : 'Time to the next level.');
    },
});
