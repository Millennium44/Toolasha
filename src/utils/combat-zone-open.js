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
 * `GAME.COMBAT_ZONE_TABS` (now `GAME.COMBAT_PAGE_TABS`) — the selector this
 * used to click a "zone tab" by matching its text to a zone's display name —
 * turned out, on measurement, to match the Combat *page's* top-level tabs
 * ("Combat Zones", "Find Party", "Combat Sim", "Statistics"), never a
 * per-zone tab. That old use as a zone-tab fallback could never fire and is
 * not reused. It is reused for something the page tabs actually are, below.
 *
 * ## A player mid-fight has no Combat Zones list in the DOM at all
 *
 * Measured live on the maintainer's client: while fighting, the ▶ buttons and
 * the combat-task Go path did nothing, logging
 * `[DOM] Timeout waiting for: [class*="CombatZones_combatZones"]`. A class
 * dump from that same page contained `CombatPanel_combatPanel`,
 * `CombatPanel_tabsComponentContainer`, `TabsComponent_tabPanelsContainer`,
 * `TabPanel_tabPanel`, `TabPanel_hidden`, `BattlePanel_combatUnitGrid`,
 * `CombatUnit_*` — and no `CombatZones_*` whatsoever. It reproduced on the
 * test server only because the tester was never in combat: the Combat Zones
 * list is only rendered when the Combat page is showing its "Combat Zones"
 * tab, and a player mid-fight is viewing the Battle tab/panel instead.
 *
 * The fix: if the list does not appear after `navigateToAction`, look among
 * `GAME.COMBAT_PAGE_TABS` for the one labelled "Combat Zones" (matched
 * case-insensitively on rendered text, never by position) and click it, then
 * wait for the list again. Clicking a page tab is navigation, not a game
 * action — pressing "Add Queue" or "Start Now" remains off-limits everywhere
 * in this module. If no such tab is found, or the list still does not
 * appear, this refuses exactly like every other step here: an honest
 * `{opened: false, ...}` rather than a guess.
 *
 * A sequence that switches onto Combat Zones and then fails to reach a
 * usable, tier-confirmed panel clicks back to whichever tab was selected
 * before the switch — a player who pressed ▶ mid-fight and got a refusal
 * should not also be left staring at an empty zones list instead of their
 * fight. See `findSelectedCombatPageTab`'s doc-comment for what this does and
 * does not assume about how the game marks the active tab.
 *
 * ## `navigateToAction` does not land on the zone's own panel
 *
 * Measured live: `navigateToAction('/actions/combat/<zone>')` opens the
 * **Combat Zones list** (`ZONE_LIST_SELECTOR`), a grid of every zone as a
 * tile — never the zone's detail panel. The panel only mounts after that
 * zone's own tile is clicked. Every earlier version of this module (and the
 * combat-task Go path this was extracted from) skipped straight to reading
 * `PANEL_SELECTOR` after `navigateToAction`, which is why
 * `openCombatZoneAtTier` used to report `{opened: true}` with nothing open —
 * `ensureZoneAndTier` was checking a panel that did not exist yet, and a null
 * `panel` fails its own null check the same way a wrong one does. The Go path
 * in `task-profit-display.js` never had this problem: it reads the panel
 * after the GAME's own Go button (a real click on the game's DOM node, not
 * `navigateToAction`) has already opened it directly.
 *
 * The tile is matched the same way every other skill-screen tile in this
 * codebase is resolved — `resolveActionTile` (`action-panel-helper.js`),
 * which reads the tile's own name text and looks up its action hrid — rather
 * than comparing display-name strings here a second time.
 */

import dataManager from '../core/data-manager.js';
import { navigateToAction } from './item-navigation.js';
import {
    findActionInput,
    resolveDetailPanel,
    resolveActionTile,
    PANEL_SELECTOR,
    TILE_SELECTOR,
} from './action-panel-helper.js';
import { setReactInputValue } from './react-input.js';
import { waitForElement } from './dom.js';
import { GAME } from './selectors.js';

/** The Combat Zones list container `navigateToAction` actually lands on. */
const ZONE_LIST_SELECTOR = '[class*="CombatZones_combatZones"]';

/** How long to wait for the Combat Zones list to render after `navigateToAction`. */
const ZONE_LIST_TIMEOUT_MS = 5000;

/**
 * How long to wait for the Combat Zones list a second time, after clicking
 * the Combat page's own "Combat Zones" tab. Same budget as the first wait —
 * there is nothing measured to suggest the post-tab-click render is any
 * faster or slower than the first one.
 */
const ZONE_LIST_RETRY_TIMEOUT_MS = ZONE_LIST_TIMEOUT_MS;

/** How long to wait for the zone's own detail panel to mount after its tile is clicked. */
const PANEL_TIMEOUT_MS = 5000;

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
 * True once the character has moved on from `capturedCharacterId` — a switch
 * is in progress, or has already landed on someone else. Every await in this
 * module's sequence (list → tile → panel → tier → fill) crosses real time,
 * and a character switch during that wait leaves the game's own panel now
 * showing the NEW character's zone while a sequence started for the OLD one
 * is still mid-flight, holding a tier and count that were never meant for
 * whoever the panel now belongs to. `task-profit-display.js`'s `_applyGoEstimate`
 * (the Go path's own copy of this same "confirm zone, confirm tier, then fill"
 * sequence) checks this too, for the same reason.
 *
 * This is the standard guard this codebase's character-swap race sweep
 * established elsewhere (capture identity before the first await, verify
 * after) — this module had none of it until now, being newer than that sweep.
 * @param {string|null} capturedCharacterId - `dataManager.getCurrentCharacterId()`, read before the first await
 * @returns {boolean}
 */
export function characterIdentityChanged(capturedCharacterId) {
    return dataManager.getIsCharacterSwitching() || dataManager.getCurrentCharacterId() !== capturedCharacterId;
}

/**
 * Serializes the sequences that manipulate the zone detail panel's shared
 * Difficulty combobox and count input — `openCombatZoneAtTier`'s own
 * sequence below, and the combat-task Go path's `_applyGoEstimate`
 * (`task-profit-display.js`), which reads and writes the same panel through
 * `ensureZoneAndTier` but never goes through `openCombatZoneAtTier` itself
 * (Go's navigation already happened through the game's own button).
 *
 * Without this, a second ▶ click before the first settles, or Go firing
 * while a ▶ sequence is still mid-flight, run two "confirm zone, confirm
 * tier, fill count" sequences concurrently against the one panel the game
 * gives us — each reading state the other is in the middle of changing.
 * Queued rather than rejected: a second click during a still-settling first
 * one is an ordinary thing for a player to do, not a mistake to bounce.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runZoneOpenExclusive(fn) {
    const run = () => fn();
    const result = zoneOpenLock.then(run, run);
    zoneOpenLock = result.then(
        () => undefined,
        () => undefined
    );
    return result;
}

/** The tail of the queue {@link runZoneOpenExclusive} serializes onto. */
let zoneOpenLock = Promise.resolve();

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
 * @param {string|null} [capturedCharacterId] - The character this was started
 *   for, if the caller is guarding against a switch. Omit to skip the check.
 * @returns {Promise<boolean>} True once the combobox reads back `T{tier}`
 */
export async function selectDifficultyTier(panel, tier, capturedCharacterId) {
    const target = `T${tier}`;
    const combobox = findDifficultyCombobox(panel);
    if (!combobox) return false;

    if ((combobox.textContent || '').trim() === target) {
        return true;
    }

    // MUI opens its menu on mousedown, not click: measured live on 2026-09-17,
    // a bare `.click()` left the listbox unopened and the tier unconfirmed, so
    // every caller refused to fill and the buttons did nothing
    // No `view`: in the userscript sandbox `window` is not the page's Window and
    // the MouseEvent constructor throws on it — measured live, it took the whole
    // open sequence down. Every other dispatch in this codebase omits it too.
    combobox.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    combobox.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    combobox.click();
    await wait(TIER_MENU_SETTLE_MS);

    const listboxId = combobox.getAttribute('aria-controls');
    const listbox = (listboxId && document.getElementById(listboxId)) || document.querySelector('[role="listbox"]');
    if (!listbox) return false;

    const option = Array.from(listbox.querySelectorAll('[role="option"]')).find(
        (opt) => (opt.textContent || '').trim() === target
    );
    if (!option) return false;

    // Picking the option is a WRITE to the panel, and the settle wait above is
    // real time a character switch can land inside. The callers' own guards
    // run only after this function returns, by which point the tier has
    // already been changed — on whatever panel the game is now showing. A
    // switch here leaves the new character's Difficulty set to the old
    // character's tier, ready for them to press Start Now against.
    if (capturedCharacterId !== undefined && characterIdentityChanged(capturedCharacterId)) return false;

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
 * @param {string|null} [capturedCharacterId] - Passed through to
 *   {@link selectDifficultyTier} so the tier is not written after a switch
 * @returns {Promise<boolean>}
 */
export async function ensureZoneAndTier(panel, zoneHrid, tier, capturedCharacterId) {
    if (!panel) return false;
    const { actionHrid } = resolveDetailPanel(panel);
    if (actionHrid !== zoneHrid) return false;
    return selectDifficultyTier(panel, tier, capturedCharacterId);
}

/**
 * The Combat page's own "Combat Zones" tab, matched by its rendered label
 * text (case-insensitively) rather than position — `GAME.COMBAT_PAGE_TABS`
 * finds every top-level page tab ("Combat Zones", "Find Party", "Combat Sim",
 * "Statistics" on the live client), and this is the one whose content is the
 * `ZONE_LIST_SELECTOR` grid. Refuses (returns null) rather than clicking an
 * arbitrary tab if none reads "combat zones" — a client whose label differs
 * gets an honest refusal, not a wrong navigation.
 * @returns {HTMLElement|null}
 */
function findCombatZonesPageTab() {
    const tabs = document.querySelectorAll(GAME.COMBAT_PAGE_TABS);
    for (const tab of tabs) {
        if ((tab.textContent || '').trim().toLowerCase() === 'combat zones') {
            return tab;
        }
    }
    return null;
}

/**
 * Whichever Combat page tab is currently selected — captured before clicking
 * "Combat Zones", so a sequence that switches tabs and then fails can put the
 * player back where they were (the Battle view, mid-fight) instead of
 * stranding them on Combat Zones with nothing open.
 *
 * Assumption, not measured on the live client: that the active tab carries
 * `aria-selected="true"` (mirrored in the `Mui-selected` class), the same
 * convention every other MUI tab strip in this codebase already reads
 * (`enhancement-display.js`, `panel-observer.js`, `tea-recommendation.js`,
 * the alchemy tab-watchers). Unverified specifically for the Combat page's
 * own tabs. If wrong, `findSelectedCombatPageTab` returns null, nothing is
 * captured, and `restoreCombatPageTab` becomes a no-op — the player is left
 * on the Combat Zones tab rather than restored, which is the same
 * "leave rather than guess" refusal shape as everywhere else in this module.
 * @returns {HTMLElement|null}
 */
function findSelectedCombatPageTab() {
    const tabs = document.querySelectorAll(GAME.COMBAT_PAGE_TABS);
    for (const tab of tabs) {
        if (tab.getAttribute('aria-selected') === 'true' || tab.classList.contains('Mui-selected')) {
            return tab;
        }
    }
    return null;
}

/**
 * Click back to `previousTab` (from {@link findSelectedCombatPageTab}) after
 * a sequence that switched onto the Combat Zones tab did not end up with a
 * usable, tier-confirmed panel open. A no-op if nothing was captured, or if
 * the character has since switched — a tab click for the wrong character's
 * page is worse than leaving it alone.
 * @param {HTMLElement|null} previousTab
 * @param {string|null} capturedCharacterId
 * @returns {void}
 */
function restoreCombatPageTab(previousTab, capturedCharacterId) {
    if (!previousTab) return;
    if (characterIdentityChanged(capturedCharacterId)) return;
    previousTab.click();
}

/**
 * Find the Combat Zones list tile for `zoneHrid` — resolved the same way
 * every other skill-screen tile is (`resolveActionTile`), which reads the
 * tile's own rendered name and looks that up to an action hrid, rather than
 * comparing display-name text against `zoneHrid`'s name a second time here.
 * @param {HTMLElement} zoneList
 * @param {string} zoneHrid
 * @returns {HTMLElement|null}
 */
function findZoneTile(zoneList, zoneHrid) {
    const tiles = zoneList.querySelectorAll(TILE_SELECTOR);
    for (const tile of tiles) {
        if (resolveActionTile(tile).actionHrid === zoneHrid) {
            return tile;
        }
    }
    return null;
}

/**
 * Navigate to a combat zone, click its tile in the Combat Zones list that
 * lands on, wait for its detail panel to mount, and set the Difficulty
 * combobox to `tier` — optionally filling the fight-count input afterward.
 * Never queues or starts anything.
 *
 * `navigateToAction` only opens the Combat Zones *list*; the zone's own
 * detail panel appears only after its tile is clicked (see the module
 * doc-comment for how this was measured). Clicking a tile and reading the
 * panel it opens are both allowed — only "Add Queue" / "Start Now" are not,
 * and this never touches either.
 *
 * Refuses at every step rather than guessing: an unknown `zoneHrid`, a failed
 * `navigateToAction`, a Combat Zones list that never renders, a tile that
 * never appears in it, a panel that never mounts or never confirms
 * `zoneHrid`, or a tier that cannot be confirmed all leave the count input
 * untouched. `count`, when given, is trusted as-is — this never recomputes it.
 *
 * @param {string} zoneHrid - Action HRID, e.g. `/actions/combat/aqua_planet`
 * @param {number} tier - Difficulty tier to open at (0+)
 * @param {Object} [options]
 * @param {number|string} [options.count] - Fight (or dungeon clear) count to fill; omit to fill nothing
 * @returns {Promise<{opened: boolean, tierConfirmed: boolean, filled: boolean}>}
 */
export async function openCombatZoneAtTier(zoneHrid, tier, options = {}) {
    // Captured HERE, at the press, not inside the sequence. The sequence does
    // not begin until whatever is ahead of it in `runZoneOpenExclusive`'s
    // queue has drained, and that wait is itself an await straddling the
    // identity read — a sequence that read the character id when its turn
    // finally came would read whoever the player had *switched to* during the
    // wait, and then happily "confirm" that nothing had changed. Every guard
    // below is only as good as the identity it compares against.
    const characterId = dataManager.getCurrentCharacterId();
    return runZoneOpenExclusive(() => openCombatZoneAtTierSequence(zoneHrid, tier, options, characterId));
}

/**
 * The actual navigate → tile → panel → tier → fill sequence, queued through
 * {@link runZoneOpenExclusive} by {@link openCombatZoneAtTier} so it never
 * runs concurrently with another one on the same shared panel.
 * @param {string} zoneHrid
 * @param {number} tier
 * @param {Object} options
 * @param {number|string} [options.count]
 * @param {string|null} characterId - Captured by {@link openCombatZoneAtTier}
 *   before this was queued, not re-read here
 * @returns {Promise<{opened: boolean, tierConfirmed: boolean, filled: boolean}>}
 */
async function openCombatZoneAtTierSequence(zoneHrid, tier, options, characterId) {
    const { count } = options;
    const result = { opened: false, tierConfirmed: false, filled: false };

    const zoneName = dataManager.getInitClientData()?.actionDetailMap?.[zoneHrid]?.name;
    if (!zoneName) return result;

    if (!navigateToAction(zoneHrid)) return result;

    let zoneList = await waitForElement(ZONE_LIST_SELECTOR, ZONE_LIST_TIMEOUT_MS);
    if (characterIdentityChanged(characterId)) return result;

    // A player mid-fight is on the Battle view, not the Combat Zones list —
    // measured live (see module doc-comment). Switching the Combat page's
    // own tab is navigation, not a game action, so it is allowed here.
    let previousPageTab = null;
    if (!zoneList) {
        const zonesTab = findCombatZonesPageTab();
        if (!zonesTab) return result;

        previousPageTab = findSelectedCombatPageTab();
        zonesTab.click();

        zoneList = await waitForElement(ZONE_LIST_SELECTOR, ZONE_LIST_RETRY_TIMEOUT_MS);
        if (characterIdentityChanged(characterId)) return result;
        if (!zoneList) {
            restoreCombatPageTab(previousPageTab, characterId);
            return result;
        }
    }

    const tile = findZoneTile(zoneList, zoneHrid);
    if (!tile) {
        restoreCombatPageTab(previousPageTab, characterId);
        return result;
    }

    tile.click();
    result.opened = true;

    const panel = await waitForElement(PANEL_SELECTOR, PANEL_TIMEOUT_MS);
    if (characterIdentityChanged(characterId)) return result;
    const tierConfirmed = await ensureZoneAndTier(panel, zoneHrid, tier, characterId);
    result.tierConfirmed = tierConfirmed;
    if (!tierConfirmed) {
        restoreCombatPageTab(previousPageTab, characterId);
        return result;
    }
    if (characterIdentityChanged(characterId)) return result;

    if (count === undefined || count === null) return result;

    const inputEl = findActionInput(panel);
    if (!inputEl) return result;

    setReactInputValue(inputEl, String(count), { focus: false });
    result.filled = true;
    return result;
}
