/**
 * Action panel layout
 *
 * Making the action detail modal fit on a screen.
 *
 * The game's panel was designed for the game's own contents: a name, the
 * inputs, the outputs and two buttons. This script adds most of a second
 * panel's worth on top — missing materials, a cost summary, a budget box,
 * action speed, level progress, the crafting plan, profitability — and the
 * modal grows to fit all of it. Past a certain recipe it grows taller than the
 * window, and what falls off the bottom is the **Start Now** button, which is
 * the one thing the panel exists to press.
 *
 * ## What this does
 *
 * Three things, all CSS:
 *
 * - **The modal stops growing at the height of the window.** It is the panel
 *   that scrolls after that, not the page, so the close button and the title
 *   stay where they are instead of drifting off the top.
 * - **The buttons stick to the bottom of the panel.** They are the panel's
 *   verbs — queue this, start this — and having to scroll to reach a verb is
 *   the failure everything else here is downstream of. A hairline and the
 *   panel's own background separate them from the content sliding underneath.
 * - **The added sections are tightened.** Eight pixels above and below seven
 *   collapsible sections is over a hundred pixels of nothing, which is most of
 *   a section on its own.
 *
 * ## Why CSS and not layout code
 *
 * Everything here is the game's own markup, which changes when the game
 * changes. A stylesheet that stops matching leaves the panel exactly as it was
 * before; layout code that stops matching leaves it broken. `:has()` narrows
 * every modal rule to modals that actually contain an action panel, so nothing
 * here reaches the marketplace or the settings dialogs.
 */

import config from '../../core/config.js';
import { addStyles, removeStyles } from '../../utils/dom.js';

const STYLE_ID = 'toolasha-action-panel-layout';

/** Room for the modal's own chrome — its padding and the close button */
const CHROME_PX = 96;

const CSS = `
    /* Only modals holding an action panel. The marketplace and the settings
       dialogs share these class names and want none of this. */
    [class*="Modal_modal__"]:has([class*="SkillActionDetail_skillActionDetail"]) {
        max-height: calc(100vh - 24px);
    }

    [class*="Modal_modal__"]:has([class*="SkillActionDetail_skillActionDetail"])
        [class*="Modal_modalContent"] {
        min-height: 0;
        overflow: hidden;
    }

    /* The panel is the scroller. Contained overscroll so reaching the bottom of
       it does not then start scrolling the page behind the modal.

       Horizontal overflow is hidden as a backstop only. The real cause was
       blocks built without box-sizing — a full-width card plus fourteen pixels
       of padding a side is a card wider than its column — and those are fixed
       where they are built rather than clipped here. */
    [class*="SkillActionDetail_skillActionDetail"] {
        max-height: calc(100vh - ${CHROME_PX}px);
        overflow-y: auto;
        overflow-x: hidden;
        overscroll-behavior: contain;
        /* Reserve the gutter whether or not the bar is showing. Without it the
           vertical scrollbar appears *after* the layout has been worked out and
           takes its width out of the column, so every row that was exactly as
           wide as the column is now wider than it — which is a horizontal
           scrollbar, caused by the vertical one. */
        scrollbar-gutter: stable;
    }

    /* The scrollbar is left as the game draws it. Recolouring it was chasing
       the wrong thing anyway: the horizontal bar was never a styling problem
       but a width one, fixed where the oversized blocks are built. */

    /* The containers between the modal and the panel scroll nothing of their
       own — the panel is the scroller — so any bar they show is the same
       artefact one level up */
    [class*="Modal_modal__"]:has([class*="SkillActionDetail_skillActionDetail"]),
    [class*="Modal_modal__"]:has([class*="SkillActionDetail_skillActionDetail"])
        [class*="Modal_modalContent"],
    [class*="Modal_modal__"]:has([class*="SkillActionDetail_skillActionDetail"])
        [class*="SkillActionDetail_content"] {
        overflow-x: hidden;
    }

    /* Nothing inside the panel may be wider than the panel — at any depth, not
       just the rows sitting directly in it. The Cost Summary card is inserted
       beside the item requirements rather than at the top level, so a rule for
       direct children walked straight past the widest thing in the panel.

       The panel is a column of rows. A row wider than its column is always the
       bug rather than the intent, so this is safe to state once for everything
       rather than hunted one element at a time. */
    [class*="SkillActionDetail_skillActionDetail"] * {
        max-width: 100%;
        box-sizing: border-box;
    }

    /* Queue and Start, always reachable. Sticky rather than fixed so it belongs
       to the panel and moves with a dragged modal.

       One neutral hairline and nothing else. A tinted line plus a shadow reads
       as a frame around the buttons rather than as the edge of the content
       sliding under them, and a frame says "this is a thing" when all it is
       meant to say is "the list stops here". */
    [class*="SkillActionDetail_skillActionDetail"] [class*="SkillActionDetail_buttonsContainer"] {
        position: sticky;
        bottom: 0;
        z-index: 2;
        margin-top: 4px;
        padding: 8px 0 4px 0;
        /* A literal, and deliberately not one of the game's themed background
           variables. The one that reads like a dark background is not one —
           that scale is a set of visible tints — so asking for it painted this
           strip blue, and the blue showing above and below the buttons was the
           box that kept coming back. It was never a border; it was this. */
        background: #0e0e16;
        border-top: 1px solid rgba(255, 255, 255, 0.10);
        /* The container measures a fraction of a pixel wider than the panel it
           sits in — 321.883 against 320 — which is enough overflow to summon a
           horizontal scrollbar across the bottom of the panel. Clipping the
           panel alone does not help while the child is still asking for width
           it cannot have. */
        max-width: 100%;
        box-sizing: border-box;
    }

    /* Ours, tightened. Seven sections at eight pixels a side is a section's
       worth of empty space. */
    [class*="SkillActionDetail_skillActionDetail"] .mwi-collapsible-section {
        margin-top: 2px;
        margin-bottom: 2px;
    }
    [class*="SkillActionDetail_skillActionDetail"] .mwi-section-header {
        padding: 1px 0;
    }
    [class*="SkillActionDetail_skillActionDetail"] #mwi-missing-mats-button {
        margin: 4px 0 6px 0;
        padding: 6px 12px;
    }
`;

const actionPanelLayout = {
    initialize() {
        if (!config.getSetting('actionPanelLayout')) return;
        addStyles(CSS, STYLE_ID);
    },

    disable() {
        removeStyles(STYLE_ID);
    },

    cleanup() {
        removeStyles(STYLE_ID);
    },
};

export default actionPanelLayout;
