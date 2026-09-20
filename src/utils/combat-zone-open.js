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
 * `GAME.COMBAT_ZONE_TABS` (now `GAME.COMBAT_PAGE_TABS`) matches *every* MUI tab
 * button inside the Combat panel, and that is two different strips depending
 * on what the page is showing. Measured live, mid-fight, it matched exactly
 * four: "Combat Zones", "Find Party", "My Party", "Battle #8" — the page's own
 * top-level tabs. Measured live again with the Combat Zones tab showing, the
 * same selector additionally matched the twelve per-zone GROUP tabs ("1.
 * Smelly Planet" … "12. Dungeons").
 *
 * An earlier version of this comment concluded from the mid-fight measurement
 * alone that the selector matches page tabs "never a per-zone tab", and that
 * the old zone-tab text match "could never fire". That is wrong, and it
 * misled a later investigation: with the zones list showing, a text match
 * against this selector can absolutely land on a group tab. Anything reading
 * it must say which strip it means. `findCombatZonesPageTab` pins its strip by
 * matching one exact label; the group-tab step below deliberately does not go
 * through this selector at all, resolving a group from the tile's own DOM
 * ancestry instead (see below).
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
 *
 * ## The tile can be in the DOM and still be unreachable
 *
 * The Combat Zones list is itself a tab strip: twelve zone GROUPS ("1. Smelly
 * Planet" … "12. Dungeons"), one selected, the rest rendered into tab panels
 * carrying `TabPanel_hidden`. Measured live: the mounted list's `textContent`
 * holds every zone's name whichever group is selected, so a plain
 * `querySelectorAll(TILE_SELECTOR)` over the list happily returns a tile the
 * player cannot see. Clicking that tile opens nothing, the detail panel never
 * mounts, the sequence refuses, and the tab restore drops the player back on
 * their fight — "the ▶ button did nothing", which is exactly how this was
 * reported. It only worked when the player happened to have that zone's group
 * already selected.
 *
 * So the tile search rejects any tile under a `TabPanel_hidden` ancestor, and
 * when the only match is such a tile, the group that owns it is selected
 * first and the tile is waited for again — reachable this time.
 *
 * ### Resolving a zone's group without naming it
 *
 * The group is never derived from the zone. It is read off the tile that was
 * already found by hrid: the tile's own `TabPanel_tabPanel` ancestor is the
 * group's panel, and the tab that controls that panel is either the one its
 * `aria-labelledby` names, or — failing that attribute — the tab at the same
 * index in the strip that sits beside the panels' own container. No group
 * name, number or order is written down anywhere here, so the game renaming
 * "Sorcerer's Tower", reordering the groups, or adding a thirteenth changes
 * nothing; a dungeon like Pirate Cove needs no special case, because its tile
 * lives in the Dungeons group's panel like any other tile in any other group.
 * Index correspondence is positional, but positional *within one rendered
 * tabs component*, where the strip and the panels are two halves of the same
 * render and move together. It is checked before it is trusted: if the strip
 * and the panel list are not the same length, the mapping is not believed and
 * the sequence refuses rather than clicking whichever tab that index happens
 * to hit.
 *
 * A failed sequence clicks the previously selected GROUP tab back too, for
 * the same reason it restores the page tab: a refusal should leave the page
 * as it found it, and a player who pressed ▶ and got nothing should not also
 * find their zones list scrolled to some other group than the one they were
 * reading.
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

/**
 * How long to wait for a zone's tile to become reachable after its group tab
 * is clicked. Same budget as the list waits — the group swap is the same kind
 * of React re-render, and nothing measured suggests it is quicker.
 */
const GROUP_TILE_TIMEOUT_MS = 5000;

/** How often the reachable-tile wait re-checks, matching `waitForElement`'s own poll. */
const GROUP_TILE_POLL_MS = 100;

/** The per-group tab panels the Combat Zones list renders its tiles into. */
const TAB_PANEL_SELECTOR = '[class*="TabPanel_tabPanel"]';

/** The class the game puts on a tab panel that is rendered but not showing. */
const HIDDEN_TAB_PANEL_CLASS = 'TabPanel_hidden';

/** A MUI tab button — page tabs and per-zone group tabs are both these. */
const TAB_BUTTON_SELECTOR = 'button[class*="MuiTab-root"]';

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
 * captured, and `restoreCombatTabs` becomes a no-op — the player is left
 * on the Combat Zones tab rather than restored, which is the same
 * "leave rather than guess" refusal shape as everywhere else in this module.
 * @returns {HTMLElement|null}
 */
function findSelectedCombatPageTab() {
    return findSelectedTab(document.querySelectorAll(GAME.COMBAT_PAGE_TABS));
}

/**
 * Whichever of `tabs` is marked active — `aria-selected="true"`, mirrored in
 * the `Mui-selected` class, the convention every MUI tab strip this codebase
 * reads already uses. Null when none is marked, which callers treat as
 * "nothing captured, nothing to restore" rather than guessing at a default.
 * @param {Iterable<HTMLElement>} tabs
 * @returns {HTMLElement|null}
 */
function findSelectedTab(tabs) {
    for (const tab of tabs) {
        if (tab.getAttribute('aria-selected') === 'true' || tab.classList.contains('Mui-selected')) {
            return tab;
        }
    }
    return null;
}

/**
 * The tab currently selected in `tab`'s own strip — its `[role="tablist"]`,
 * or its parent element when the game does not mark one. Scoped to that one
 * strip on purpose: the Combat panel renders the page tabs and the zone-group
 * tabs at the same time, and a document-wide search would confuse the two.
 * @param {HTMLElement} tab
 * @returns {HTMLElement|null}
 */
function findSelectedSiblingTab(tab) {
    const strip = tab.closest('[role="tablist"]') || tab.parentElement;
    if (!strip) return null;
    return findSelectedTab(strip.querySelectorAll(TAB_BUTTON_SELECTOR));
}

/**
 * Click back to the tabs a failed sequence switched away from — the zone
 * group first, while the zones list is still showing and its strip is still
 * mounted, then the Combat page tab that takes the player back to their
 * fight. A no-op for whichever of them was never captured (nothing was
 * switched, or nothing marked a selection), and for all of them once the
 * character has switched — a tab click on the wrong character's page is worse
 * than leaving it alone.
 * @param {HTMLElement|null} previousGroupTab
 * @param {HTMLElement|null} previousPageTab
 * @param {string|null} capturedCharacterId
 * @returns {void}
 */
function restoreCombatTabs(previousGroupTab, previousPageTab, capturedCharacterId) {
    if (!previousGroupTab && !previousPageTab) return;
    if (characterIdentityChanged(capturedCharacterId)) return;
    if (previousGroupTab) previousGroupTab.click();
    if (previousPageTab) previousPageTab.click();
}

/**
 * Every Combat Zones list tile for `zoneHrid` — resolved the same way every
 * other skill-screen tile is (`resolveActionTile`), which reads the tile's
 * own rendered name and looks that up to an action hrid, rather than
 * comparing display-name text against `zoneHrid`'s name a second time here.
 * @param {HTMLElement} zoneList
 * @param {string} zoneHrid
 * @returns {HTMLElement[]}
 */
function findZoneTiles(zoneList, zoneHrid) {
    return Array.from(zoneList.querySelectorAll(TILE_SELECTOR)).filter(
        (tile) => resolveActionTile(tile).actionHrid === zoneHrid
    );
}

/**
 * True when `element` sits inside a tab panel the game has hidden — rendered,
 * findable by `querySelectorAll`, and not something the player can click. The
 * Combat Zones list keeps all twelve zone groups mounted this way, so a tile
 * found by hrid is not yet a tile that can be clicked.
 * @param {HTMLElement} element
 * @returns {boolean}
 */
function isInHiddenTabPanel(element) {
    let node = element;
    while (node) {
        if (String(node.className || '').includes(HIDDEN_TAB_PANEL_CLASS)) return true;
        node = node.parentElement;
    }
    return false;
}

/**
 * The tile for `zoneHrid` the player could actually click — the first match
 * that is not buried in a hidden group panel. Null when the zone's only tile
 * is hidden (its group is not selected) as well as when there is no tile at
 * all; the caller tells the two apart with {@link findZoneTiles}.
 * @param {HTMLElement} zoneList
 * @param {string} zoneHrid
 * @returns {HTMLElement|null}
 */
function findReachableZoneTile(zoneList, zoneHrid) {
    return findZoneTiles(zoneList, zoneHrid).find((tile) => !isInHiddenTabPanel(tile)) || null;
}

/**
 * The group tab that controls the tab panel `tile` lives in — read off the
 * tile's own ancestry, never from the zone's name or a group order written
 * down here (see the module doc-comment). Prefers the panel's own
 * `aria-labelledby`; falls back to the tab at the panel's index in the strip
 * beside the panels' container, and refuses (returns null) when the strip and
 * the panels do not correspond one-to-one, rather than clicking whichever tab
 * that index lands on.
 * @param {HTMLElement} tile
 * @returns {HTMLElement|null}
 */
function findGroupTabForTile(tile) {
    const groupPanel = tile.closest(TAB_PANEL_SELECTOR);
    if (!groupPanel) return null;

    const labelledBy = groupPanel.getAttribute('aria-labelledby');
    if (labelledBy) {
        const labelled = document.getElementById(labelledBy);
        if (labelled && labelled.matches(TAB_BUTTON_SELECTOR)) return labelled;
    }

    const panelsContainer = groupPanel.parentElement;
    if (!panelsContainer) return null;
    const panels = Array.from(panelsContainer.children).filter((child) => child.matches(TAB_PANEL_SELECTOR));
    const index = panels.indexOf(groupPanel);
    if (index < 0) return null;

    const tabs = findTabStripFor(panelsContainer);
    if (tabs.length !== panels.length) return null;
    return tabs[index];
}

/**
 * The tab buttons belonging to `panelsContainer` — the nearest ancestor's
 * worth of tabs that are not themselves inside the panels (a selected panel
 * can hold a nested tab strip of its own, and those are not this strip's).
 * @param {HTMLElement} panelsContainer
 * @returns {HTMLElement[]}
 */
function findTabStripFor(panelsContainer) {
    let scope = panelsContainer.parentElement;
    while (scope) {
        const tabs = Array.from(scope.querySelectorAll(TAB_BUTTON_SELECTOR)).filter(
            (tab) => !panelsContainer.contains(tab)
        );
        if (tabs.length > 0) return tabs;
        scope = scope.parentElement;
    }
    return [];
}

/**
 * Wait for `zoneHrid`'s tile to become reachable — polled rather than
 * observed, the same shape as `waitForElement`, because what is being waited
 * for is not an element appearing but a hidden one becoming shown. The list
 * is re-read from the document if the group swap replaced the container the
 * caller was holding.
 * @param {HTMLElement} zoneList
 * @param {string} zoneHrid
 * @param {number} timeout
 * @returns {Promise<HTMLElement|null>}
 */
function waitForReachableZoneTile(zoneList, zoneHrid, timeout) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const check = () => {
            const list = zoneList.isConnected ? zoneList : document.querySelector(ZONE_LIST_SELECTOR);
            const tile = list ? findReachableZoneTile(list, zoneHrid) : null;
            if (tile) {
                resolve(tile);
            } else if (Date.now() - startTime >= timeout) {
                resolve(null);
            } else {
                setTimeout(check, GROUP_TILE_POLL_MS);
            }
        };
        check();
    });
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
            restoreCombatTabs(null, previousPageTab, characterId);
            return result;
        }
    }

    // The zones list keeps every zone group mounted and hides all but the
    // selected one, so a tile found by hrid may be one the player cannot
    // click. Selecting its group is navigation, like the page tab above.
    let previousGroupTab = null;
    let tile = findReachableZoneTile(zoneList, zoneHrid);
    if (!tile) {
        const hiddenTile = findZoneTiles(zoneList, zoneHrid)[0];
        if (!hiddenTile) {
            restoreCombatTabs(null, previousPageTab, characterId);
            return result;
        }

        const groupTab = findGroupTabForTile(hiddenTile);
        if (!groupTab) {
            restoreCombatTabs(null, previousPageTab, characterId);
            return result;
        }

        previousGroupTab = findSelectedSiblingTab(groupTab);
        groupTab.click();

        tile = await waitForReachableZoneTile(zoneList, zoneHrid, GROUP_TILE_TIMEOUT_MS);
        if (characterIdentityChanged(characterId)) return result;
        if (!tile) {
            restoreCombatTabs(previousGroupTab, previousPageTab, characterId);
            return result;
        }
    }

    tile.click();
    result.opened = true;

    const panel = await waitForElement(PANEL_SELECTOR, PANEL_TIMEOUT_MS);
    if (characterIdentityChanged(characterId)) return result;
    const tierConfirmed = await ensureZoneAndTier(panel, zoneHrid, tier, characterId);
    result.tierConfirmed = tierConfirmed;
    if (!tierConfirmed) {
        restoreCombatTabs(previousGroupTab, previousPageTab, characterId);
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
