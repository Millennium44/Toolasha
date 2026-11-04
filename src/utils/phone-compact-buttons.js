/**
 * Content-width injected buttons on phone screens.
 *
 * The Philo Gamba (Settings) and XPH Calc (Enhancing) buttons are inserted as direct children of a
 * game panel that lays its children out as a column, where a button stretches across the whole panel
 * and reads as a stray bar. Below the shared phone breakpoint they size to their label and sit at the
 * start of the line. Wider than that the stylesheet is inert and the inline look is untouched.
 */

import { addStyles } from './dom.js';

export const PHONE_COMPACT_BUTTONS_STYLE_ID = 'mwi-phone-compact-buttons';

/** The stylesheet text. Exported so tests can read the rules without a layout engine. */
export const PHONE_COMPACT_BUTTONS_CSS = `
    @media (max-width: 768px) {
        .mwi-philo-calc-button,
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
