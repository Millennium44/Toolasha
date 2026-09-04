/**
 * Party Profile Button
 *
 * In group/party/dungeon combat, clicking another player's unit opens the
 * game's battle-unit popup with "Battle Info" and "Stats" tabs — but no way to
 * jump to that player's profile without going through "My Party". This adds a
 * "Profile" button to that popup's tab row which opens the player's profile via
 * the game-native `/profile <name>` chat command.
 *
 * ## Why detection is by text, not class
 *
 * The popup is native game UI with hashed class names (`ClassName_x__hash`) that
 * are not referenced anywhere else in the codebase and change between game
 * builds. The one stable thing is the tab labels, so the popup is found by its
 * "Battle Info" / "Stats" tabs and the player by the "<name> - Lv.N" header —
 * the same selector-canary reasoning the rest of the combat features use.
 *
 * ## How the profile opens
 *
 * The game's core component exposes `handleViewProfile(name)` — the handler
 * behind clicking a player, reachable on the same fiber object as
 * `handleGoToMarketplace`. Calling it directly opens the profile modal with no
 * chat involved, so it works whether or not the chat panel is open. If a build
 * ever lacks that handler, this falls back to the `/profile <name>` chat command
 * (fill + Enter), which does need the chat input present and visible.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import { openPlayerProfile, VALID_PLAYER_NAME_RE } from '../../utils/profile-command.js';

const BUTTON_ID = 'toolasha-party-profile-button';
const OBSERVER_KEY = 'PartyProfileButton';

/**
 * The DOM this feature watches, as classes the shared observer can filter on.
 *
 * The popup is a modal, and `guild-loadout-capture.js` watches this same
 * battle-unit popup — same "<name> - Lv.N" header, same Battle Info and Stats
 * tabs — through `Modal_modalContent` / `Modal_modalContainer`. That pair is
 * therefore the one entry here backed by a shipped feature rather than by
 * inference, so it leads: whatever the tab row inside turns out to be built
 * from, the modal around it is inserted when the popup opens.
 *
 * The MUI pair is kept behind it for the narrower case of the tab strip alone
 * being rebuilt inside a modal that is already open. `findPopupTabRow` looks at
 * `[role="tablist"]` rows, and the game's tab strips are MUI Tabs — the
 * marketplace tab code matches `.MuiTabs-flexContainer[role="tablist"]`, the
 * combat panel's zone tabs are `div.MuiTabs-root.MuiTabs-vertical` — so this is
 * very probably what the popup's row is too. "Very probably" is the reason it
 * is not the only entry: a filter that is wrong here does not throw, it just
 * stops the button appearing, and nothing in the codebase names the popup's
 * inner markup.
 *
 * `Modal_modalContent` is already watched by WelcomeBackValue, so it costs the
 * shared subtree query nothing to add.
 *
 * Registered without a filter this ran for every element inserted anywhere on
 * the page, and every run swept the document for tab rows.
 */
export const POPUP_TAB_CLASSES = [
    'Modal_modalContent',
    'Modal_modalContainer',
    'MuiTabs-flexContainer',
    'MuiTabs-root',
];

/** "<name> - Lv.127" → captures the name. Accepts a hyphen or en dash. */
const NAME_LEVEL_RE = /^\s*(.+?)\s*[-–]\s*Lv\.?\s*\d+\s*$/i;

let unregister = null;

function initialize() {
    unregister = domObserver.onClass(OBSERVER_KEY, POPUP_TAB_CLASSES, tryInject, {
        debounce: true,
        debounceDelay: 150,
    });
}

function cleanup() {
    if (unregister) {
        unregister();
        unregister = null;
    }
    document.getElementById(BUTTON_ID)?.remove();
}

/**
 * The battle-unit popup's tab row, found by its labels.
 *
 * Anchored on the ARIA `role="tablist"` the game's MUI tab strip carries — a
 * stable, un-hashed attribute, and a sparse one (only a handful of open tab
 * groups exist at once), so this is cheap enough to run on every DOM change
 * without scanning the whole document the way a `[class*="tab"] > *` sweep would.
 *
 * Requires BOTH a "Battle Info" and a "Stats" tab in the row — a player's popup
 * has both, which keeps the button off tab strips elsewhere (the guild panel,
 * the marketplace) and off most monster popups.
 *
 * @returns {{row: Element, battleInfoTab: Element}|null}
 */
function findPopupTabRow() {
    const rows = document.querySelectorAll('[role="tablist"]');
    for (const row of rows) {
        const tabs = Array.from(row.children);
        const battleInfoTab = tabs.find((tab) => tab.textContent.trim().toLowerCase() === 'battle info');
        if (!battleInfoTab) continue;
        const hasStats = tabs.some((tab) => tab.textContent.trim().toLowerCase() === 'stats');
        if (hasStats) return { row, battleInfoTab };
    }
    return null;
}

/**
 * The player name from the popup that owns `tabRow`, or null when it is not a
 * player popup (no "<name> - Lv.N" header, a multi-token/monster name, etc.).
 *
 * @param {Element} tabRow - The popup's tab row
 * @returns {string|null}
 */
function readPlayerName(tabRow) {
    // Ascend to the popup container — the nearest ancestor whose text carries a
    // "<name> - Lv.N" header — then read the name off that header.
    let node = tabRow;
    for (let depth = 0; depth < 8 && node; depth += 1) {
        node = node.parentElement;
        if (!node) break;
        const header = Array.from(node.querySelectorAll('*')).find((el) => {
            if (el.children.length > 0) return false; // leaf text only
            return NAME_LEVEL_RE.test(el.textContent.trim());
        });
        if (header) {
            const name = NAME_LEVEL_RE.exec(header.textContent.trim())?.[1]?.trim();
            // A real player name is one alphanumeric/underscore token; this is
            // what filters out multi-word monster names.
            if (name && VALID_PLAYER_NAME_RE.test(name)) return name;
            return null;
        }
    }
    return null;
}

/** Whether `name` is the local character (button is for other players only). */
function isSelf(name) {
    const me = dataManager.getCurrentCharacterName?.();
    return !!me && me.toLowerCase() === name.toLowerCase();
}

function tryInject() {
    if (document.getElementById(BUTTON_ID)) return;

    const found = findPopupTabRow();
    if (!found) return;

    const name = readPlayerName(found.row);
    if (!name || isSelf(name)) return;

    injectButton(found.row, found.battleInfoTab, name);
}

/**
 * Add the Profile button to the tab row, styled to sit beside the native tabs.
 * @param {Element} row - The tab row
 * @param {Element} sampleTab - A native tab to borrow layout cues from
 * @param {string} name - Player name to open
 */
function injectButton(row, sampleTab, name) {
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.textContent = 'Profile';
    button.title = `Open ${name}'s profile`;
    button.style.cssText = `
        margin-left: 8px;
        padding: 2px 10px;
        border: 0;
        border-radius: 5px;
        background-color: ${config.COLOR_ACCENT};
        color: black;
        font-size: ${sampleTab?.style?.fontSize || 'inherit'};
        font-weight: bold;
        line-height: 1.6;
        cursor: pointer;
        white-space: nowrap;
    `;

    button.addEventListener('mouseenter', () => {
        button.style.opacity = '0.8';
    });
    button.addEventListener('mouseleave', () => {
        button.style.opacity = '1';
    });

    button.addEventListener('click', (event) => {
        event.stopPropagation();
        openProfile(name, button);
    });

    row.appendChild(button);
}

/**
 * Open a player's profile via the shared helper (direct `handleViewProfile`,
 * chat fallback). Shows brief "Open chat" feedback when neither path fires.
 *
 * @param {string} name - Player name
 * @param {HTMLElement} button - Button, for transient feedback
 */
function openProfile(name, button) {
    if (openPlayerProfile(name, { logPrefix: 'PartyProfileButton' })) return;

    const original = button.textContent;
    button.textContent = 'Open chat';
    setTimeout(() => {
        button.textContent = original;
    }, 1500);
}

export default {
    name: 'Party Profile Button',
    initialize,
    cleanup,
};
