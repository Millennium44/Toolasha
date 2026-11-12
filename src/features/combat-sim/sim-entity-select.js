/** Native simulator selects with decorative artwork in browsers that support rich options. */
import { addStyles } from '../../utils/dom.js';
import { GAME_COLORS } from '../../utils/game-look.js';
import { simEntityLabelHtml } from './sim-entity-label.js';
import { enhanceSimEntitySelect, releaseSimEntitySelect } from './sim-entity-select-fallback.js';

const CLASS_NAME = 'toolasha-sim-entity-select';
const STYLE_ID = 'toolasha-sim-entity-select-styles';
const CSS_TEXT = `
    .${CLASS_NAME}, .${CLASS_NAME}::picker(select) { appearance: base-select; }
    .${CLASS_NAME}::picker(select) {
        background: ${GAME_COLORS.inputBackground};
        color: ${GAME_COLORS.text};
        border: 1px solid ${GAME_COLORS.inputBorder};
        border-radius: 4px;
        box-shadow: ${GAME_COLORS.frameGlow};
        max-height: min(360px, 60vh);
        max-width: calc(100vw - 16px);
        overflow: auto;
    }
    .${CLASS_NAME} > button { min-width: 0; font: inherit; color: inherit; }
    .${CLASS_NAME} selectedcontent { display: flex; align-items: center; min-width: 0; }
    .${CLASS_NAME} option {
        display: flex; align-items: center; gap: 4px;
        padding: 6px 10px; font: inherit;
        white-space: normal; overflow-wrap: anywhere;
    }
    .${CLASS_NAME} option::checkmark { order: 1; margin-left: auto; }
    .${CLASS_NAME} option:hover, .${CLASS_NAME} option:focus { background: ${GAME_COLORS.raisedMore}; }
    .${CLASS_NAME} [data-sim-entity-icon] { flex-shrink: 0; }
    @media (forced-colors: active) {
        .${CLASS_NAME}::picker(select), .${CLASS_NAME} option { background: Canvas; color: CanvasText; }
        .${CLASS_NAME} option:hover, .${CLASS_NAME} option:focus { background: Highlight; color: HighlightText; }
    }
`;

/**
 * Populate an existing native select without changing its identity, value contract or event listeners.
 * Rich options use native customizable selects, so selection, typeahead, keyboard navigation, dismissal
 * and accessibility remain browser-owned. Older browsers retain the original plain-text native picker.
 * The caller still owns option ordering and choosing/restoring the selected value after population.
 * @param {HTMLSelectElement} select - Existing single-select control
 * @param {{hrid: string, name: string}[]} entries - Explicit identities and plain-text labels
 */
export function populateSimEntitySelect(select, entries) {
    const rich = Boolean(globalThis.CSS?.supports?.('appearance', 'base-select'));
    select.replaceChildren();
    if (rich) releaseSimEntitySelect(select);
    select.classList.toggle(CLASS_NAME, rich);
    if (rich) {
        addStyles(CSS_TEXT, STYLE_ID);
        // The browser clones the selected option here, including after programmatic value changes.
        // This button is inert inside a customizable select, not an additional keyboard stop.
        const button = document.createElement('button');
        button.type = 'button';
        button.appendChild(document.createElement('selectedcontent'));
        select.appendChild(button);
    }
    for (const entry of entries) {
        const option = document.createElement('option');
        option.value = entry.hrid;
        if (rich) option.innerHTML = simEntityLabelHtml(entry.hrid, entry.name);
        else option.textContent = entry.name;
        select.appendChild(option);
    }
    // Browsers without customizable selects (Firefox) get a Toolasha-drawn icon dropdown over the same select.
    if (!rich) enhanceSimEntitySelect(select);
}
