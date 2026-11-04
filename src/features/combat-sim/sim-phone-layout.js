/**
 * Phone layout for the Combat Sim and Lab Sim panels.
 *
 * Width-based (same breakpoint as the market pages), CSS only. The panels keep whatever geometry
 * they saved: the rules below override it with `!important` while the window is narrow and never
 * write it back, so a wider window gets the saved size and position again.
 */

import { MARKET_MOBILE_QUERY } from '../market/market-mobile-layout.js';
import { addStyles } from '../../utils/dom.js';

export const SIM_PHONE_STYLE_ID = 'mwi-sim-phone-layout';

/** The stylesheet text. Exported so tests can read the rules without a layout engine. */
export const SIM_PHONE_CSS = `
    @media ${MARKET_MOBILE_QUERY} {
        #mwi-labsim-crate-row { flex-wrap: wrap; }
    }
`;

/** Install the stylesheet. Safe to call whenever a sim panel is built. */
export function ensureSimPhoneStyles() {
    addStyles(SIM_PHONE_CSS, SIM_PHONE_STYLE_ID);
}
