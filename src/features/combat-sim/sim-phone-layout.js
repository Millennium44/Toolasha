/**
 * Phone layout for the Combat Sim and Lab Sim panels.
 *
 * Width-based (same breakpoint as the market pages), CSS only. The panels keep whatever geometry
 * they saved: the rules below override it with `!important` while the window is narrow and never
 * write it back, so a wider window gets the saved size and position again.
 */

import { MARKET_MOBILE_QUERY } from '../market/market-mobile-layout.js';
import { addStyles } from '../../utils/dom.js';
import { GAME_COLORS } from '../../utils/game-look.js';

export const SIM_PHONE_STYLE_ID = 'mwi-sim-phone-layout';

/** The stylesheet text. Exported so tests can read the rules without a layout engine. */
export const SIM_PHONE_CSS = `
    @media ${MARKET_MOBILE_QUERY} {
        /* Ability rows: the move buttons get the same 34px tap target as the row actions, and the row wraps so the
           ability name keeps a readable width instead of being squeezed out */
        .mwi-csim-ability-row { flex-flow: row wrap; }
        .mwi-csim-ability-row > .mwi-csim-ability-name { flex: 1 1 110px !important; min-width: 110px; }
        .mwi-csim-ability-row button[data-ability-move] { min-width: 34px !important; min-height: 34px !important; }
        /* Full viewport width whatever geometry was saved; nothing is written back to storage */
        #mwi-combat-sim-panel,
        #mwi-lab-sim-panel {
            left: 0 !important;
            right: auto !important;
            width: 100vw !important;
            min-width: 0 !important;
            max-width: 100vw !important;
            box-sizing: border-box;
        }
        /* Drops and costs have six numeric columns wider than a phone. Give the item its own
           full-width line, then share the next line between the same six aligned readings. */
        .mwi-csim-loot-row {
            display: grid !important;
            grid-template-columns: repeat(6, minmax(0, 1fr));
        }
        .mwi-csim-loot-row > span {
            min-width: 0 !important;
            white-space: normal !important;
            overflow-wrap: anywhere;
        }
        .mwi-csim-loot-row > span:first-child {
            grid-column: 1 / -1;
            overflow: visible !important;
        }
        /* Tea, Coffee and Food share one line; a grid keeps each label beside its select */
        #mwi-labsim-crate-row {
            display: grid !important;
            grid-template-columns: repeat(3, auto minmax(0, 1fr));
            gap: 6px !important;
        }
        #mwi-labsim-crate-row > select { min-width: 0; width: 100%; }
        /* Results, All players: tight cells so three players fit a phone, the figure names on one line and
           pinned while the players scroll sideways, and a long player name cut short (its full name is the
           header's tooltip). The inline padding and wrap rules are overridden here, desktop keeps them. */
        .mwi-csim-all-table { font-size: 11px !important; }
        .mwi-csim-all-table th, .mwi-csim-all-table td { padding-left: 4px !important; padding-right: 4px !important; }
        .mwi-csim-all-table .mwi-csim-all-label {
            white-space: nowrap !important; max-width: 108px !important; min-width: 0 !important;
            overflow: hidden; text-overflow: ellipsis;
        }
        .mwi-csim-all-table .mwi-csim-all-name {
            max-width: 72px; overflow: hidden; text-overflow: ellipsis;
        }
        /* The Buy/Sell/Key row stays above the results and covers whatever scrolls under it */
        #mwi-csim-results-pricing {
            position: sticky; top: 0; z-index: 5; background: ${GAME_COLORS.background} !important;
            padding-bottom: 6px !important; box-sizing: border-box;
        }
        /* Zone takes a line of its own (label + select); Tier, Hours and Simulate wrap onto the next */
        #mwi-csim-zone { flex: 1 1 calc(100% - 60px) !important; }
    }
`;

/** Install the stylesheet. Safe to call whenever a sim panel is built. */
export function ensureSimPhoneStyles() {
    addStyles(SIM_PHONE_CSS, SIM_PHONE_STYLE_ID);
}

export const SIM_UPGRADE_PHONE_STYLE_ID = 'mwi-sim-upgrade-phone-layout';

/**
 * Phone rules for the Upgrade tab's option rows and results tables. Separate from {@link SIM_PHONE_CSS}
 * because these let things wrap and scroll. Class-based, so every table that carries `mwi-utable-wrap` gets them.
 */
export const SIM_UPGRADE_PHONE_CSS = `
    /* The detail copy of a row's actions, the arrow cue, and a detail row that holds nothing but actions exist
       only at phone width (the media block below turns them on); a wider window shows the inline buttons as before */
    .mwi-ract-detail, .mwi-ract-cue { display: none; }
    tr.mwi-ract-only { display: none !important; }
    @media ${MARKET_MOBILE_QUERY} {
        /* An include chip and the options it owns wrap inside the panel; a label stays beside its control */
        [data-mode-chip], [data-lab-mode-chip] { max-width: 100%; box-sizing: border-box; flex-wrap: wrap; }
        [data-mode-chip] [data-mode-options], [data-lab-mode-chip] [data-lab-mode-options] { flex-wrap: wrap; min-width: 0; max-width: 100%; }
        [data-mode-chip] [data-mode-options] > span:first-child,
        [data-lab-mode-chip] [data-lab-mode-options] > span:first-child { display: none; }
        [data-mode-chip] select, [data-mode-chip] input[type="number"],
        [data-lab-mode-chip] select, [data-lab-mode-chip] input[type="number"] { max-width: 100%; min-width: 0; }
        [data-mode-chip] label, [data-lab-mode-chip] label { white-space: normal; }
        /* The Combat Sim's Tune triggers section wraps the same way: selects shrink to the panel, a label may wrap */
        #mwi-csim-trigger-bar select { max-width: 100%; min-width: 0; }
        #mwi-csim-trigger-bar label { white-space: normal; }

        /* Solo zones + party dungeons: the two loadout pickers wrap instead of running off the panel */
        #mwi-csim-soloparty-loadouts { flex-wrap: wrap; max-width: 100%; }
        /* Lab skilling: Tea, Coffee and Food on one line, a label beside each select */
        #mwi-labsim-skilling-crate-row {
            display: grid !important;
            grid-template-columns: repeat(3, auto minmax(0, 1fr));
            gap: 6px !important;
        }
        #mwi-labsim-skilling-crate-row > select { min-width: 0; width: 100%; }

        /* A results table scrolls both ways inside its own wrapper, so its header can stick to the wrapper's top
           (overflow-x alone made the wrapper the header's scroll container with nothing to scroll vertically).
           A short table stays its natural height: max-height only caps it. The vh line is the fallback for a
           browser without dvh, which drops the second declaration. Nothing contains the scroll: scrolling past the end
           of the table carries on into the panel */
        .mwi-utable-wrap {
            overflow: auto; -webkit-overflow-scrolling: touch; max-width: 100%;
            max-height: 70vh; max-height: min(70vh, calc(100dvh - 260px));
        }
        /* A header may take two lines ("Hours/0.01%" over "Profit"); some tables set nowrap inline, so this wins
           with !important. The sort arrow is joined to its label by a no-break space and stays with it.
           Data cells keep their one line. */
        .mwi-utable-wrap > table:not(.mwi-utable-pick) > thead > tr > th { white-space: normal !important; min-width: 64px; }
        /* The first column names the row, so it stays put and is wide enough to read. The z-index is
           !important because a table may set its own inline (the gold table's headers are
           sticky at z-index 2): without that the later header cells paint over the pinned one while scrolling */
        .mwi-utable-wrap > table:not(.mwi-utable-pick) > thead > tr > th:first-child,
        .mwi-utable-wrap > table:not(.mwi-utable-pick) > tbody > tr > td:first-child:not([colspan]) {
            position: sticky; left: 0; z-index: 1 !important;
            box-sizing: border-box; width: 140px; min-width: 140px; max-width: 140px;
            white-space: normal !important; overflow-wrap: anywhere;
        }
        /* Header cells are solid in one fill for the whole row, the pinned one included (the gold table's own
           inline fill is this same color; the old forced panel color made its pinned cell darker). Tables whose
           headers set no fill get it here, so columns sliding under a header never show through */
        .mwi-utable-wrap > table > thead > tr > th { background: ${GAME_COLORS.raisedMore} !important; }
        /* Every header cell sticks to the top of the wrapper (top is !important because the Lab tables set -10px
           inline for the panel's own padding); the pinned first cell below also sticks sideways and sits above */
        .mwi-utable-wrap > table > thead > tr > th { position: sticky; top: 0 !important; z-index: 2 !important; }
        .mwi-utable-wrap > table:not(.mwi-utable-pick) > tbody > tr > td:first-child:not([colspan]) {
            background: ${GAME_COLORS.background} !important;
        }
        .mwi-utable-wrap > table:not(.mwi-utable-pick) > thead > tr > th:first-child { z-index: 3 !important; }
        /* Chips and buttons under a row's name wrap beneath it rather than widening the pinned column */
        .mwi-utable-wrap > table:not(.mwi-utable-pick) > tbody > tr > td:first-child:not([colspan]) button,
        .mwi-utable-wrap > table:not(.mwi-utable-pick) > tbody > tr > td:first-child:not([colspan]) span {
            white-space: normal; max-width: 100%; box-sizing: border-box; margin: 3px 4px 0 0 !important;
        }
        /* An expanded row spans the whole table: its content stays at the visible width, pinned to the left */
        .mwi-utable-wrap .mwi-utable-detail { position: sticky; left: 0; box-sizing: border-box; width: calc(100vw - 80px); max-width: 100%; }
        /* Row actions (Save for this, Watch, Market, Enhance) leave the name cell and open with the row: the inline
           set is hidden, the copy in the expanded row shows, and a small arrow says the row opens. Tags beside the
           name (fresh book, on task) are not actions and stay */
        .mwi-utable-wrap .mwi-ract-inline { display: none !important; }
        .mwi-utable-wrap .mwi-ract-cue { display: inline; color: #8ab4f8; }
        .mwi-ract-detail {
            display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px;
            position: sticky; left: 0; box-sizing: border-box; width: calc(100vw - 80px); max-width: 100%;
        }
        .mwi-ract-detail button { margin: 0 !important; padding: 6px 10px !important; font-size: 11px !important; min-height: 34px; }
        /* A row whose only detail is its actions opens now: it looks clickable, and its detail row shows once opened */
        tr.mwi-ract-row { cursor: pointer; }
        tr.mwi-ract-only[style*="table-row"] { display: table-row !important; }
        .mwi-utable-wrap .mwi-utable-detail > div[style*="grid-template-columns"] {
            grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)) !important;
        }
    }
`;

/**
 * A row's actions as they sit beside its name: the buttons (hidden at phone width) and a small arrow cue that
 * shows only there, to say the row opens. Empty for a row with no actions.
 * @param {string} actions - Markup from `upgradeRowActionsHtml`
 * @returns {string} HTML
 */
export function rowActionsInlineHtml(actions) {
    return actions
        ? `<span class="mwi-ract-inline">${actions}</span><span class="mwi-ract-cue" aria-hidden="true">▾</span>`
        : '';
}

/**
 * The same actions as a block for the row's expanded detail; shown at phone width only.
 * @param {string} actions - Markup from `upgradeRowActionsHtml`
 * @returns {string} HTML, empty when there are no actions
 */
export function rowActionsDetailHtml(actions) {
    return actions ? `<div class="mwi-ract-detail">${actions}</div>` : '';
}

/** Install the Upgrade tab's phone rules. Safe to call whenever the Combat Sim panel is built. */
export function ensureSimUpgradePhoneStyles() {
    addStyles(SIM_UPGRADE_PHONE_CSS, SIM_UPGRADE_PHONE_STYLE_ID);
}
