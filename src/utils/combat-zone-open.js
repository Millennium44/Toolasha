/**
 * Combat Zone Open Helper
 *
 * Opens a combat zone's action detail panel at a specific difficulty tier —
 * navigating and, when asked, filling the game's own fight-count input.
 * Never presses Start Now, Add Queue, or anything else that commits an
 * action; the press stays the player's.
 *
 * Extracted from the combat-task Go button's estimate-fill (`task-profit-display.js`
 * `_applyGoEstimate`), which is about to gain two more callers (the all-zones
 * results table and the Bestiary plan, in `combat-sim-ui.js`). A second and
 * third hand-copy of "how the tier is chosen" is exactly the duplication this
 * codebase keeps paying down elsewhere.
 *
 * ## The tier control, measured live (not inferred from a class name)
 *
 * The zone detail panel (`PANEL_SELECTOR`) carries a "Difficulty" row whose
 * control is a MUI combobox — `[role="combobox"]` showing its current value
 * as `T0`, `T1`, … — not a native `<select>` and not a tab. Opening it pops a
 * `[role="listbox"]` of `[role="option"]` entries, found through the
 * combobox's own `aria-controls`. Matching the trigger by its *own* rendered
 * text (`/^T\d+$/`) rather than a CSS-module class name sidesteps needing to
 * know the "Difficulty" label's wrapper markup, which was never measured —
 * only the ARIA role and the value format are load-bearing here, both far
 * less likely to move under a game update than a hashed class name.
 *
 * `GAME.COMBAT_ZONE_TABS` — the selector this used to click a "zone tab" by
 * matching its text to a zone's display name — turned out, on measurement, to
 * match the Combat *page's* top-level tabs ("Combat Zones", "Find Party",
 * "Combat Sim", "Statistics"), never a per-zone tab. That fallback could never
 * fire and is not reused here; see `selectors.js` for the corrected comment.
 */

import dataManager from '../core/data-manager.js';
import { navigateToAction } from './item-navigation.js';
import { findActionInput, resolveDetailPanel, PANEL_SELECTOR } from './action-panel-helper.js';
import { setReactInputValue } from './react-input.js';

/** How long to let the game render after `navigateToAction`, before reading the panel. */
const NAVIGATE_SETTLE_MS = 300;

/** How long to let a combobox's popup (or its close, after picking an option) render. */
const TIER_MENU_SETTLE_MS = 300;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The Difficulty combobox within an open zone detail panel — found by its own
 * rendered value (`T0`, `T1`, …), not by a guessed class name. Refuses (returns
 * null) rather than picking some other combobox in the panel (e.g. Loadout) if
 * none currently shows a tier-shaped value — that only happens if the game's
 * markup has moved out from under this, and a wrong combobox is worse than none.
 * @param {HTMLElement} panel
 * @returns {HTMLElement|null}
 */
function findDifficultyCombobox(panel) {
    const comboboxes = panel.querySelectorAll('[role="combobox"]');
    for (const el of comboboxes) {
        if (/^T\d+$/.test((el.textContent || '').trim())) {
            return el;
        }
    }
    return null;
}

/**
 * Set the zone detail panel's Difficulty combobox to `tier`, verifying the
 * change actually landed rather than trusting the click.
 *
 * Refuses (returns false) at every step it cannot confirm: no Difficulty
 * combobox found, its popup did not open where `aria-controls` said it would,
 * no option reads `T{tier}`, or the combobox does not read back `T{tier}`
 * after picking it. A caller that gets false has an open zone panel showing
 * an unconfirmed tier and must not fill anything against it.
 *
 * @param {HTMLElement} panel - An already-open, already-confirmed zone detail panel
 * @param {number} tier - The difficulty tier to select (0+)
 * @returns {Promise<boolean>} True once the combobox reads back `T{tier}`
 */
export async function selectDifficultyTier(panel, tier) {
    const target = `T${tier}`;
    const combobox = findDifficultyCombobox(panel);
    if (!combobox) return false;

    if ((combobox.textContent || '').trim() === target) {
        return true;
    }

    combobox.click();
    await wait(TIER_MENU_SETTLE_MS);

    const listboxId = combobox.getAttribute('aria-controls');
    const listbox = (listboxId && document.getElementById(listboxId)) || document.querySelector('[role="listbox"]');
    if (!listbox) return false;

    const option = Array.from(listbox.querySelectorAll('[role="option"]')).find(
        (opt) => (opt.textContent || '').trim() === target
    );
    if (!option) return false;

    option.click();
    await wait(TIER_MENU_SETTLE_MS);

    return (combobox.textContent || '').trim() === target;
}

/**
 * Confirm `panel` is the detail panel for `zoneHrid`, then set its Difficulty
 * combobox to `tier`. The single seam both callers below (and `task-profit-display.js`'s
 * Go path) share: "is this the right panel, and is it now the right tier".
 * @param {HTMLElement|null} panel
 * @param {string} zoneHrid
 * @param {number} tier
 * @returns {Promise<boolean>}
 */
export async function ensureZoneAndTier(panel, zoneHrid, tier) {
    if (!panel) return false;
    const { actionHrid } = resolveDetailPanel(panel);
    if (actionHrid !== zoneHrid) return false;
    return selectDifficultyTier(panel, tier);
}

/**
 * Navigate to a combat zone's action, wait for the game to render its detail
 * panel, and set the Difficulty combobox to `tier` — optionally filling the
 * fight-count input afterward. Never queues or starts anything.
 *
 * Refuses at every step rather than guessing: an unknown `zoneHrid`, a failed
 * `navigateToAction`, a panel that never confirms `zoneHrid`, or a tier that
 * cannot be confirmed all leave the count input untouched. `count`, when
 * given, is trusted as-is — this never recomputes it.
 *
 * @param {string} zoneHrid - Action HRID, e.g. `/actions/combat/aqua_planet`
 * @param {number} tier - Difficulty tier to open at (0+)
 * @param {Object} [options]
 * @param {number|string} [options.count] - Fight (or dungeon clear) count to fill; omit to fill nothing
 * @returns {Promise<{opened: boolean, tierConfirmed: boolean, filled: boolean}>}
 */
export async function openCombatZoneAtTier(zoneHrid, tier, options = {}) {
    const { count } = options;
    const result = { opened: false, tierConfirmed: false, filled: false };

    const zoneName = dataManager.getInitClientData()?.actionDetailMap?.[zoneHrid]?.name;
    if (!zoneName) return result;

    if (!navigateToAction(zoneHrid)) return result;

    await wait(NAVIGATE_SETTLE_MS);

    const panel = document.querySelector(PANEL_SELECTOR);
    const tierConfirmed = await ensureZoneAndTier(panel, zoneHrid, tier);
    result.opened = true;
    result.tierConfirmed = tierConfirmed;
    if (!tierConfirmed) return result;

    if (count === undefined || count === null) return result;

    const inputEl = findActionInput(panel);
    if (!inputEl) return result;

    setReactInputValue(inputEl, String(count), { focus: false });
    result.filled = true;
    return result;
}
