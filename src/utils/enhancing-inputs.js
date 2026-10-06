/**
 * The enhancing panel's Target Level and Protect From Level inputs.
 *
 * Every reader of these used to find the input by its English label ("Target Level", "Protect
 * From Level"). On a translated client — a player may run the game in Chinese — that matched
 * nothing, and the readers fell back to defaults (the mirror summary quoted +20, the protect-from
 * readers read 0).
 *
 * The English label is still tried first: it is the shape verified against the live client. When
 * it is absent, the inputs are found by the panel's structure instead, which does not depend on
 * the language: each setting is a label beside its input in one container, Target Level first
 * and Protect From Level second, with the Repeat field in its own `maxActionCountInput`
 * container. Inputs Toolasha draws into the panel itself (anything under an `mwi-`/`toolasha`
 * id or class, or marked as a Toolasha surface) are not the game's and are skipped.
 */

import { SURFACE_ATTRIBUTE } from './surface-marker.js';

const INPUT_SELECTOR = 'input[type="number"], input[type="text"]';

const ENGLISH_LABELS = {
    target: 'Target Level',
    protectFrom: 'Protect From Level',
};

/** Position of each setting among the panel's label + input pairs */
const PAIR_INDEX = {
    target: 0,
    protectFrom: 1,
};

/**
 * Whether an element is part of something Toolasha drew, not the game.
 * @param {Element} element - Element to test
 * @returns {boolean}
 */
function isOwnUi(element) {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        if (node.hasAttribute?.(SURFACE_ATTRIBUTE)) return true;
        const id = node.id || '';
        const className = typeof node.className === 'string' ? node.className : '';
        if (/^(mwi-|toolasha)/i.test(id) || /(^|\s)(mwi-|toolasha)/i.test(className)) return true;
    }
    return false;
}

/**
 * The input beside a leaf element whose text is exactly `label`.
 * @param {Element} panel - Enhancing panel
 * @param {string} label - Label text
 * @returns {HTMLInputElement|null}
 */
function inputByLabel(panel, label) {
    const labels = Array.from(panel.querySelectorAll('*')).filter(
        (el) => el.children.length === 0 && el.textContent.trim() === label
    );
    return labels[0]?.parentElement?.querySelector(INPUT_SELECTOR) || null;
}

/**
 * The game's label + input setting pairs in the panel, in document order: inputs whose own
 * container also holds a text label, outside the Repeat field and outside Toolasha's own UI.
 * @param {Element} panel - Enhancing panel
 * @returns {Array<HTMLInputElement>}
 */
function settingInputs(panel) {
    return Array.from(panel.querySelectorAll(INPUT_SELECTOR)).filter((input) => {
        if (input.closest('[class*="maxActionCountInput"]')) return false;
        if (isOwnUi(input)) return false;
        const container = input.parentElement;
        if (!container) return false;
        return Array.from(container.querySelectorAll('*')).some(
            (el) => el !== input && el.children.length === 0 && el.textContent.trim() !== '' && !el.contains(input)
        );
    });
}

/**
 * Find one of the enhancing panel's setting inputs without depending on the client's language.
 * @param {Element} panel - Enhancing panel element
 * @param {'target'|'protectFrom'} which - The setting
 * @returns {HTMLInputElement|null}
 */
export function findEnhancingInput(panel, which) {
    if (!panel || !(which in ENGLISH_LABELS)) return null;
    const byLabel = inputByLabel(panel, ENGLISH_LABELS[which]);
    if (byLabel) return byLabel;
    return settingInputs(panel)[PAIR_INDEX[which]] || null;
}
