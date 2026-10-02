/**
 * Task Skill Groups
 *
 * Groups the game's non-combat actions by skill so the Task Reroll Protection and Task
 * Auto-Reroll popups can offer a "select all <Skill>" bulk toggle, the same way their zone
 * rows already bulk-toggle a zone's monsters. Groups are derived from the live action data
 * rather than a hardcoded recipe list. Combat is excluded: zones already cover it.
 */

/** Action types that never appear as a skill task (combat has zone toggles instead). */
const EXCLUDED_TYPES = new Set(['/action_types/combat', '/action_types/labyrinth']);

/**
 * Build the skill groups from game data.
 * @param {Object|null} gameData - dataManager.getInitClientData() result
 * @returns {Array<{type: string, label: string, hrids: string[]}>} Groups in the game's skill order
 */
export function buildSkillGroups(gameData) {
    const byType = new Map();
    for (const [hrid, action] of Object.entries(gameData?.actionDetailMap || {})) {
        const type = action?.type;
        if (!type || EXCLUDED_TYPES.has(type)) continue;
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push(hrid);
    }

    const typeDetails = gameData?.actionTypeDetailMap || {};
    const groups = [];
    for (const [type, hrids] of byType) {
        const detail = typeDetails[type];
        const fallback = type.split('/').pop() || type;
        groups.push({
            type,
            label: detail?.name || fallback.charAt(0).toUpperCase() + fallback.slice(1),
            hrids,
            sortIndex: Number.isFinite(detail?.sortIndex) ? detail.sortIndex : Infinity,
        });
    }
    groups.sort((a, b) => a.sortIndex - b.sortIndex || a.label.localeCompare(b.label));
    return groups.map(({ type, label, hrids }) => ({ type, label, hrids }));
}

/**
 * How much of a group is in the set.
 * @param {{hrids: string[]}} group
 * @param {Set<string>} selected
 * @returns {'all'|'some'|'none'}
 */
export function getSkillGroupState(group, selected) {
    let count = 0;
    for (const hrid of group.hrids) {
        if (selected.has(hrid)) count++;
    }
    if (count === 0) return 'none';
    return count === group.hrids.length ? 'all' : 'some';
}

/**
 * Toggle a whole group in place: if every action is already selected, deselect them all;
 * otherwise select them all.
 * @param {{hrids: string[]}} group
 * @param {Set<string>} selected - Mutated
 * @returns {boolean} True if the group is now fully selected
 */
export function toggleSkillGroup(group, selected) {
    const selectAll = getSkillGroupState(group, selected) !== 'all';
    for (const hrid of group.hrids) {
        if (selectAll) {
            selected.add(hrid);
        } else {
            selected.delete(hrid);
        }
    }
    return selectAll;
}

/**
 * Render the chip bar for a popup. Each chip toggles one skill via `onToggle(group)`.
 * @param {HTMLElement} bar - Container, cleared and refilled
 * @param {Array} groups - From buildSkillGroups
 * @param {Set<string>} selected
 * @param {{accent: string, tint: string, onToggle: function(Object): Promise<void>}} opts
 */
export function renderSkillBar(bar, groups, selected, { accent, tint, onToggle }) {
    bar.textContent = '';
    for (const group of groups) {
        const state = getSkillGroupState(group, selected);
        const chip = document.createElement('span');
        chip.dataset.skill = group.type;
        chip.textContent = `${group.label} (${group.hrids.length})`;
        chip.title = state === 'all' ? `Deselect all ${group.label}` : `Select all ${group.label}`;
        chip.style.cssText = `
            cursor:pointer; user-select:none; font-size:11px; padding:3px 8px; border-radius:12px;
            background:${state === 'none' ? 'rgba(255,255,255,0.06)' : tint};
            border:1px ${state === 'some' ? 'dashed' : 'solid'} ${state === 'none' ? 'rgba(255,255,255,0.15)' : accent};
            color:${state === 'none' ? '#aaa' : '#e0e0e0'};
        `;
        chip.addEventListener('click', () => onToggle(group));
        bar.appendChild(chip);
    }
}
