/**
 * Content-width injected buttons on phone screens.
 *
 * The Philo Gamba and Command Palette (Settings) and XPH Calc (Enhancing) buttons are injected children
 * of a game panel that lays its children out as a column, where a button stretches across the whole
 * panel and reads as a stray bar. They size to their label and sit at the start of the line. Settings
 * buttons stretch on desktop as well, so their rule applies at every width; XPH Calc is compact only
 * below the shared phone breakpoint, leaving its wide-screen look untouched.
 */

import { addStyles } from './dom.js';

export const PHONE_COMPACT_BUTTONS_STYLE_ID = 'mwi-phone-compact-buttons';

/** The stylesheet text. Exported so tests can read the rules without a layout engine. */
export const PHONE_COMPACT_BUTTONS_CSS = `
    .mwi-philo-calc-button,
    .mwi-palette-button {
        width: fit-content;
        max-width: 100%;
        align-self: flex-start;
        justify-self: start;
    }
    .mwi-settings-tool-buttons {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        min-width: 0;
        max-width: 100%;
    }
    @media (max-width: 768px) {
        .mwi-xph-calc-btn {
            width: fit-content;
            max-width: 100%;
            align-self: flex-start;
            justify-self: start;
        }
    }
`;

/** Install the stylesheet. Safe to call whenever one of these buttons is injected. */
export function ensurePhoneCompactButtonStyles() {
    addStyles(PHONE_COMPACT_BUTTONS_CSS, PHONE_COMPACT_BUTTONS_STYLE_ID);
}
