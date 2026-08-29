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
 * ## Which question it answers
 *
 * Two, and the second wins. On its own it reports whichever skill is going up
 * fastest. Once a target has been chosen in the Combat Level panel it reports
 * that instead — otherwise the selector drives nothing you can see, which is
 * indistinguishable from a selector that does not work.
 *
 * ## Why it keeps its own readings
 *
 * Its own instance of `skill-history`, so opening or closing the Combat Level
 * panel cannot reset this row's measurement. Readings are taken from the same
 * `characterSkills` the game keeps current, so nothing here is polled out of the
 * DOM.
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
import { row, blank, shortDuration, ROW_COLORS } from '../../utils/overlay-format.js';
import { timeToNextLevel, fastestGaining, skillName } from '../../utils/skill-progress.js';
import { createSkillHistory } from '../../utils/skill-history.js';
import { COMBAT_SKILLS } from '../../utils/combat-level.js';
import { combatLevelPanel, selectedTarget } from '../ui/combat-level-panel.js';
import { activeSkillProgress } from './skill-level-row.js';

/** How far back the rate is measured over */
const WINDOW_MS = 10 * 60 * 1000;

/** No point re-reading the skill list faster than the overlay redraws */
const SAMPLE_MS = 5000;

/**
 * This row's own record, kept apart from the Combat Level panel's.
 *
 * The awkward parts — a clock that goes backwards leaving readings stamped in
 * the future, a reading from a different character that is not a loss — live in
 * `utils/skill-history.js` rather than in a copy of the loop here. There were
 * two copies, and only one of them had been fixed.
 */
const history = createSkillHistory({ windowMs: WINDOW_MS, sampleMs: SAMPLE_MS });

// skill-history.js only self-corrects a reading that goes *backwards* — a
// switch to a character further along in a skill (an iron cow to the main,
// the ordinary direction on this account) looks exactly like a burst of real
// progress, not a different character, until the ten-minute window rolls the
// old reading out on its own. This row keeps its own history instance
// deliberately apart from combat-level-panel.js's (see the module note above),
// so combat-level-panel.js's own character_switching reset does not reach it —
// it needs the same reset for the same reason, or Time to Level can report an
// enormous xp/hr and a nonsense ETA under the arriving character's name for up
// to ten minutes after every switch.
dataManager.on('character_switching', () => history.clear());

/**
 * Take a reading of every skill, if one is due.
 *
 * Called from `render`, which is the only thing that runs on a clock here — a
 * row nobody is looking at costs nothing, which is the right trade for a figure
 * that is only ever read off the screen.
 */
function sample() {
    history.sample(dataManager.getSkills?.());
}

/**
 * The skill going up fastest, and when it levels.
 * @returns {{name: string, level: number, seconds: number|null, xpPerHour: number}|null}
 */
export function trainingSkill() {
    const skills = dataManager.getSkills?.();
    const table = dataManager.getInitClientData?.()?.levelExperienceTable;
    if (!skills || !table) return null;

    const rates = history.rates();
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
    empty: 'No experience rate yet',
    name: 'Time to Level',
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        sample();

        // The panel's Target Selector wins when it has been set. Otherwise this
        // row would keep answering about whichever skill happens to be going up
        // fastest, which is not the question you asked by choosing a target —
        // and a selector that changes nothing you can see is a selector that
        // looks broken.
        //
        // Unless the target is gaining nothing while a *skilling* skill
        // visibly climbs: then the target holds only the tooltip, not the
        // tile. A combat target pinning "Melee: —" over a week of tailoring is
        // a dead tile, which looks more broken than a selector that waits its
        // turn. Only a non-combat skill can displace it — inside combat, a
        // Defense target must keep the tile even when nothing is pointed at
        // Defense yet, which is the selector bug this row was built to fix.
        const chosen = selectedTarget();
        const training = trainingSkill();
        const skillingOver = !!training && !COMBAT_SKILLS.includes(training.name.toLowerCase());
        if (chosen && (chosen.perHour || !skillingOver)) return drawChosen(container, chosen);

        if (!training) return blank(container);

        // At the cap there is no next level, which is a different answer from
        // "not yet measurable" but reads the same on one line — the tooltip
        // carries the difference
        row(container, [
            // The level being worked towards, not the one in hand — the time
            // beside it is time until that number
            {
                text: `${training.name} ${training.seconds === null ? training.level : training.level + 1}:`,
                color: ROW_COLORS.gold,
                ellipsis: true,
            },
            {
                text: training.seconds === null ? '—' : shortDuration(training.seconds),
                color: ROW_COLORS.accent,
                push: true,
            },
        ]);
        container.title =
            `${Math.round(training.xpPerHour).toLocaleString()} xp/hr over the last ten minutes.\n` +
            (training.seconds === null ? 'No next level — this skill is at the cap.' : 'Time to the next level.') +
            (chosen ? `\nTarget ${chosen.name} ${chosen.target} is set but gaining nothing right now.` : '') +
            '\nDouble-click for every skill, with targets.';
    },
    // One line about the skill going up fastest; the panel behind it is the
    // same question asked of all of them, with targets you can move
    onOpen: () => combatLevelPanel.toggle(),
});

/**
 * Draw the row for a target chosen in the panel.
 *
 * The number is the level being *worked towards*, never the one already held.
 * It used to show the current level whenever the target was simply the next one,
 * on the reasoning that an arrow saying "135 → 136" adds nothing — but the
 * consequence was a tile reading "Melee 135" beside a time, for a level you have
 * already got. The duration is the giveaway: it is time until the number, so the
 * number has to be the one you do not have yet.
 *
 * No arrow, even for a target several levels off. It cost three characters of a
 * tile that has none to spare — "Defense → 130:" ellipsised to "Defense → 1…"
 * and lost the very number it was introducing. The level is in the tooltip along
 * with where it came from, and the tile keeps the figure.
 *
 * @param {HTMLElement} container - The tile
 * @param {Object} chosen - From `selectedTarget`
 */
function drawChosen(container, chosen) {
    const label = `${chosen.name} ${chosen.target}:`;

    row(container, [
        { text: label, color: ROW_COLORS.gold, ellipsis: true },
        {
            text: chosen.seconds === null ? '—' : shortDuration(chosen.seconds),
            color: ROW_COLORS.accent,
            push: true,
        },
    ]);
    container.title =
        `Level ${chosen.level} → ${chosen.target}, chosen in the Combat Level panel.\n` +
        (chosen.perHour
            ? `At ${Math.round(chosen.perHour).toLocaleString()} exp/hr.`
            : 'Nothing is pointed at this skill, so there is no time to give.') +
        '\nDouble-click to change it.';
}

registerRow({
    key: 'skillTimeToLevel',
    empty: 'No skilling action',
    name: 'Skill Time to Level',
    defaultSize: { width: 200, height: 30 },
    // The same question as Time to Level, asked only of the queue. Where that
    // row follows the fastest-gaining skill — combat included — and yields to
    // the Combat Level panel's target, this one reports the skill the front
    // queued action trains and nothing else: no target can redirect it, and a
    // combat or labyrinth action blanks it rather than borrowing combat's
    // numbers. The pairing keeps combat and skilling answers on separate tiles.
    render: (container) => {
        sample();

        const active = activeSkillProgress();
        if (!active) return blank(container);

        const rate = history.rates()[active.hrid] || 0;
        const atCap = active.remaining === null;
        const seconds = !atCap && rate > 0 ? (active.remaining / rate) * 3600 : null;

        row(container, [
            // The level being worked towards, not the one in hand — except at
            // the cap, where there is no next number to introduce
            {
                text: `${active.name} ${atCap ? active.level : active.level + 1}:`,
                color: ROW_COLORS.gold,
                ellipsis: true,
            },
            {
                text: seconds === null ? '—' : shortDuration(seconds),
                color: ROW_COLORS.accent,
                push: true,
            },
        ]);
        container.title = atCap
            ? `${active.name} is at the level cap.`
            : rate > 0
              ? `${Math.round(rate).toLocaleString()} xp/hr over the last ten minutes.\nTime to ${active.name} ${active.level + 1}.`
              : 'No experience rate measured yet — it settles within a minute of skilling.';
    },
});
