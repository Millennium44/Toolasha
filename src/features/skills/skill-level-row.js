/**
 * Skill Level overlay row
 *
 * The Combat Level tile answers "where do I stand in combat" without opening a
 * panel. Skilling has no equivalent — the level and progress bar for whatever
 * you are training live only in the sidebar, one skill at a time, wherever the
 * queue happens to have scrolled it to. This row is that same answer for
 * whichever skill the queue is actually training right now.
 *
 * ## Which skill is "active"
 *
 * The one the front action of the queue trains — not the one gaining fastest
 * (that is `timeToLevel`'s question) and not every skill an action happens to
 * touch. An action queue is read front-to-back by `ordinal`, because
 * `dataManager.getCurrentActions()` is in insertion order rather than queue
 * order (see `action-time-display.js`'s own front-action lookup). Combat and
 * labyrinth actions do not map to a single trained skill, and an empty queue
 * trains nothing — both report empty rather than guessing.
 *
 * ## Why this reads live and keeps nothing
 *
 * Every figure — the front action, the skill's level, its experience — is
 * asked of `dataManager` fresh on every render. There is no rate to measure
 * and so no reading to keep between renders, which sidesteps the whole class of
 * bug a kept reading has: a character switch landing between two samples and
 * reporting the wrong character's skill for a few seconds. Nothing here
 * survives past the render that used it.
 */

import dataManager from '../../core/data-manager.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { experienceToNextLevel, skillName } from '../../utils/skill-progress.js';
import { levelFraction } from '../../utils/combat-level.js';

/** Action types that do not train a single skill this row can report on */
const NOT_A_TRAINED_SKILL = new Set(['/action_types/combat', '/action_types/labyrinth']);

/**
 * The skill hrid the front (most active) queued action trains.
 *
 * @returns {string|null} e.g. `/skills/tailoring`, or null when the queue is
 *   empty or the front action is combat/labyrinth
 */
function activeSkillHrid() {
    const actions = (dataManager.getCurrentActions?.() || []).filter((action) => action && !action.isDone);
    if (!actions.length) return null;

    // Insertion order is not queue order — sort needed, same as
    // action-time-display.js's own front-action lookup
    const front = actions.reduce((lowest, action) =>
        (action.ordinal ?? Infinity) < (lowest.ordinal ?? Infinity) ? action : lowest
    );

    const details = dataManager.getActionDetails?.(front.actionHrid);
    if (!details?.type || NOT_A_TRAINED_SKILL.has(details.type)) return null;

    return details.type.replace('/action_types/', '/skills/');
}

/**
 * The active skill's level and progress toward the next one.
 *
 * @returns {{name: string, hrid: string, level: number, progress: number, remaining: number|null}|null}
 *   Null when nothing is being trained or the game has not loaded enough to say
 */
export function activeSkillProgress() {
    const skills = dataManager.getSkills?.();
    const table = dataManager.getInitClientData?.()?.levelExperienceTable;
    if (!skills || !table) return null;

    const hrid = activeSkillHrid();
    if (!hrid) return null;

    const skill = skills.find((entry) => entry.skillHrid === hrid);
    if (!skill) return null;

    return {
        name: skillName(hrid),
        hrid,
        level: skill.level,
        progress: levelFraction(skill.experience, skill.level, table),
        remaining: experienceToNextLevel(skill.experience, skill.level, table),
    };
}

registerRow({
    key: 'skillLevel',
    empty: 'No skilling action',
    name: 'Skill Level',
    defaultSize: { width: 220, height: 30 },
    render: (container) => {
        const active = activeSkillProgress();
        if (!active) return blank(container);

        row(container, [
            { text: active.name, color: ROW_COLORS.dim, ellipsis: true },
            { text: String(active.level), color: ROW_COLORS.accent, bold: true },
            { text: `${(active.progress * 100).toFixed(1)}%`, color: ROW_COLORS.gold, push: true },
        ]);
        container.title =
            active.remaining === null
                ? `${active.name} is at the level cap.`
                : `${active.remaining.toLocaleString()} experience to ${active.name} ${active.level + 1}.`;
    },
});
