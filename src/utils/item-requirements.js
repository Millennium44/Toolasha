/** Equipment requirements always describe the live local character, never a simulated build. */
import dataManager from '../core/data-manager.js';

const SELECTOR = '[data-item-requirement-hrid]';

/** Escape game names and hrids before putting them in markup. */
function escape(value) {
    return String(value).replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );
}

/**
 * Equipment requirements the local character is known not to meet. Missing skill data is not level zero.
 * @param {string} itemHrid - Equipment item
 * @returns {Array<{skillHrid: string, name: string, required: number, current: number}>}
 */
export function unmetItemRequirements(itemHrid) {
    const requirements = dataManager.getItemDetails?.(itemHrid)?.equipmentDetail?.levelRequirements;
    const skills = dataManager.getSkills?.();
    if (!Array.isArray(requirements) || !Array.isArray(skills)) return [];
    const names = dataManager.getInitClientData?.()?.skillDetailMap || {};
    const unmet = new Map();
    for (const requirement of requirements) {
        const { skillHrid, level } = requirement || {};
        const current = skills.find((skill) => skill.skillHrid === skillHrid)?.level;
        if (!skillHrid || !Number.isFinite(level) || level <= 0 || !Number.isFinite(current) || current < 0) continue;
        if (current >= level || (unmet.get(skillHrid)?.required || 0) >= level) continue;
        const fallback = skillHrid
            .split('/')
            .pop()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
        unmet.set(skillHrid, { skillHrid, name: names[skillHrid]?.name || fallback, required: level, current });
    }
    return [...unmet.values()];
}

/**
 * A warning's plain text, or empty when no unmet requirement is known.
 * @param {string} itemHrid - Equipment item
 * @param {Object} [options] - Whether to explicitly label the local character and the item
 * @returns {string}
 */
export function itemRequirementText(itemHrid, { forYou = false, showName = false } = {}) {
    const unmet = unmetItemRequirements(itemHrid);
    if (!unmet.length) return '';
    const needs = unmet.map(({ name, required, current }) => `Needs ${name} ${required} (you: ${current})`).join('; ');
    const name = showName ? `${dataManager.getItemDetails?.(itemHrid)?.name || itemHrid}: ` : '';
    return `${forYou ? 'For you: ' : ''}${name}${needs}`;
}

/**
 * A refreshable warning. An empty hidden slot lets late character data populate an already-open panel.
 * @param {string} itemHrid - Equipment item
 * @param {Object} [options] - Label options, as in itemRequirementText
 * @returns {string} HTML; empty for non-equipment or equipment without requirements
 */
export function itemRequirementHtml(itemHrid, { forYou = false, showName = false } = {}) {
    const requirements = dataManager.getItemDetails?.(itemHrid)?.equipmentDetail?.levelRequirements;
    if (!Array.isArray(requirements) || !requirements.length) return '';
    const text = itemRequirementText(itemHrid, { forYou, showName });
    return `<span data-item-requirement-hrid="${escape(itemHrid)}" data-requirement-for-you="${forYou}" data-requirement-name="${showName}" style="color:#ffb74d; font-size:11px; white-space:normal; margin-left:4px;"${text ? '' : ' hidden'}>${escape(text)}</span>`;
}

/**
 * All equipment in an advisor swap, including secondary slots. The warning explicitly describes YOU even
 * when the row measures a party member or an edited future build. It never changes candidate scoring.
 * @param {Object} result - Advisor result containing a candidate
 * @returns {string} HTML
 */
export function upgradeRequirementHtml(result) {
    const candidate = result?.candidate;
    if (!candidate) return '';
    const hrids = [
        ...new Set(
            [candidate.upgradeHrid, ...Object.values(candidate.addedSlots || {}).map((item) => item?.hrid)].filter(
                Boolean
            )
        ),
    ];
    return hrids
        .map((hrid) => itemRequirementHtml(hrid, { forYou: true, showName: hrids.length > 1 }))
        .filter(Boolean)
        .join('<br>');
}

/**
 * Refresh mounted warnings after the local character gains levels or changes. No cached skill snapshot.
 * @param {ParentNode} [root=document] - Root containing warning slots
 */
export function refreshItemRequirementWarnings(root = document) {
    for (const node of root.querySelectorAll(SELECTOR)) {
        const text = itemRequirementText(node.dataset.itemRequirementHrid, {
            forYou: node.dataset.requirementForYou === 'true',
            showName: node.dataset.requirementName === 'true',
        });
        if (node.textContent !== text) node.textContent = text;
        if (node.hidden !== !text) node.hidden = !text;
    }
    for (const group of root.querySelectorAll('.mwi-action-item-requirements')) {
        const hidden = !group.querySelector(`${SELECTOR}:not([hidden])`);
        if (group.hidden !== hidden) group.hidden = hidden;
    }
}
