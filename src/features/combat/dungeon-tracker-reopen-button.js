/**
 * The dungeon tracker's reopen button, beside the battle panel's "Per-player" button.
 *
 * The tracker's × dismisses it for the rest of a dungeon action and Ctrl+K was the only way back.
 * This is the on-screen way back: same look and size as Per-player, in the same corner, to its left. On phones
 * too: the players area reserves a thin strip at its top for the two buttons.
 * It lives here rather than in combat-dps-panel.js so the two features stay independent; the only
 * coupling is that it reads the Per-player button's width off the page to sit beside it.
 *
 * Shown only while `shouldShow()` says so (a dungeon running and the tracker UI on); removed
 * otherwise and by `stopReopenButton()`.
 */

import { styleGameButton } from '../../utils/game-look.js';
import { watchTopStrip } from '../../utils/responsive-dock.js';

export const REOPEN_BUTTON_ID = 'toolasha-dungeon-tracker-reopen-button';
// The Per-player button's id, read by id so the two modules share nothing else
const PER_PLAYER_ID = 'toolasha-combat-dps-panel-button';
const PLAYERS_AREA = '[class*="BattlePanel_playersArea"]';
const SYNC_MS = 1000;
// Per-player's width at 10px bold, used until it has been laid out and can be measured
const FALLBACK_PER_PLAYER_WIDTH = 64;
const GAP = 4;
const EDGE = 2;

let shouldShow = () => false;
let onPress = () => {};
let timer = null;
let button = null;
let area = null;
let positionedArea = null;
let detachLayout = null;

function inGuildPanel(element) {
    return Boolean(element?.closest?.('[class*="GuildPanel"]'));
}

function remove() {
    button?.remove();
    button = null;
    // Any stray copy a re-render left behind
    document.querySelectorAll(`#${REOPEN_BUTTON_ID}`).forEach((el) => el.remove());
    // After the button is gone, so the strip is only kept if Per-player still needs it
    detachLayout?.();
    detachLayout = null;
    if (positionedArea) positionedArea.style.position = '';
    positionedArea = null;
    area = null;
}

/** Keep the right offset clear of Per-player, which may come, go or resize */
function place() {
    if (!button) return;
    const perPlayer = document.getElementById(PER_PLAYER_ID);
    let right = EDGE;
    if (perPlayer?.isConnected && !inGuildPanel(perPlayer)) {
        const width = perPlayer.getBoundingClientRect().width;
        right = EDGE + (width > 0 ? width : FALLBACK_PER_PLAYER_WIDTH) + GAP;
    }
    button.style.right = `${right}px`;
}

function findArea() {
    const perPlayer = document.getElementById(PER_PLAYER_ID);
    if (perPlayer?.isConnected && !inGuildPanel(perPlayer) && perPlayer.parentElement?.matches(PLAYERS_AREA)) {
        return perPlayer.parentElement;
    }
    return Array.from(document.querySelectorAll(PLAYERS_AREA)).find((el) => !inGuildPanel(el)) || null;
}

/** Bring the button in line with what should be on screen right now. Safe to call at any time. */
export function syncReopenButton() {
    if (typeof document === 'undefined') return;
    if (!shouldShow()) {
        if (button || document.getElementById(REOPEN_BUTTON_ID)) remove();
        return;
    }
    const target = findArea();
    if (!target) {
        if (button) remove();
        return;
    }
    if (button?.isConnected && area === target) {
        place();
        return;
    }
    remove();

    const next = document.createElement('button');
    next.id = REOPEN_BUTTON_ID;
    next.textContent = 'Tracker';
    next.title = 'Show or hide the dungeon tracker (Ctrl+K).';
    styleGameButton(next, 'quiet', true);
    Object.assign(next.style, {
        position: 'absolute',
        top: `${EDGE}px`,
        right: `${EDGE}px`,
        zIndex: '5',
        fontSize: '10px',
    });
    next.addEventListener('click', (event) => {
        event.stopPropagation();
        onPress();
    });
    if (!target.style.position) {
        target.style.position = 'relative';
        positionedArea = target;
    }
    target.appendChild(next);
    button = next;
    area = target;
    // At phone width the area keeps a thin strip free at its top so the corner buttons cover no unit
    detachLayout = watchTopStrip(target, {
        buttonIds: [PER_PLAYER_ID, REOPEN_BUTTON_ID],
        measure:
            target.closest('[class*="GamePage_mainPanel"], [class*="GamePage_gamePanel"]') ||
            target.closest('[class*="BattlePanel_battleArea"]')?.parentElement ||
            target,
    });
    place();
}

/**
 * Start keeping the button in sync.
 * @param {{shouldShow: () => boolean, onPress: () => void}} options
 */
export function startReopenButton(options) {
    shouldShow = options.shouldShow;
    onPress = options.onPress;
    if (timer) clearInterval(timer);
    timer = setInterval(syncReopenButton, SYNC_MS);
    syncReopenButton();
}

/** Stop syncing and take the button off the page. */
export function stopReopenButton() {
    if (timer) clearInterval(timer);
    timer = null;
    shouldShow = () => false;
    if (typeof document !== 'undefined') remove();
}
