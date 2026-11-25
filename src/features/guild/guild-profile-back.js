/**
 * Guild Profile Back Button
 *
 * In the game, a player's profile window has a clickable guild name, and clicking it replaces the profile with
 * that guild's window with no way back. This puts a "◂ <character name>" button at the top left of the guild
 * window when it was opened from a profile; pressing it asks the game to open that profile again the normal way
 * (`handleViewProfile`), so the profile and Toolasha's profile extras come back as if the player had searched.
 *
 * The link click is the signal (a capture listener on the profile's guild link), checked against the last
 * `profile_shared` so the button names the profile the guild link belonged to. A guild window opened any other
 * way (the guild panel, chat) gets no button. The button lives inside the guild window, so it goes with it.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { showToast } from '../../utils/toast.js';

const SETTING_KEY = 'profileGuildBackButton';
const BUTTON_CLASS = 'mwi-guild-profile-back-button';
const POSITIONED_ATTR = 'data-mwi-guild-back-positioned';
/** How long after the guild link click a guild window still counts as opened from the profile */
const LINK_WINDOW_MS = 5000;
const FAILED_MESSAGE = 'Could not reopen the profile. Open it from the player list or chat instead.';

/**
 * True when the element carries a class of exactly this game prefix (`Prefix__hash`).
 * @param {Element} el
 * @param {string} prefix
 * @returns {boolean}
 */
function hasGameClass(el, prefix) {
    const classes = typeof el?.className === 'string' ? el.className.split(/\s+/) : [];
    return classes.some((c) => c.startsWith(`${prefix}__`));
}

/** The element itself or its nearest ancestor with this game class prefix */
function closestGameClass(el, prefix) {
    for (let node = el; node; node = node.parentElement) {
        if (hasGameClass(node, prefix)) return node;
    }
    return null;
}

/**
 * The game component that opens profiles: the one holding both `handleViewProfile` and
 * `handleViewGuildProfile`. Found by walking the fiber tree from the React root, never by a minified name.
 * @returns {{handleViewProfile: Function}|null}
 */
export function findGameComponent() {
    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return null;
    // Iterative, so a deep tree cannot overflow the stack
    const stack = [rootFiber];
    while (stack.length) {
        const fiber = stack.pop();
        const node = fiber.stateNode;
        if (node && typeof node.handleViewProfile === 'function' && typeof node.handleViewGuildProfile === 'function') {
            return node;
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
    }
    return null;
}

/** @type {{characterId: *, characterName: string}|null} The profile of the last `profile_shared` */
let lastProfile = null;
/** @type {{characterId: *, characterName: string, at: number}|null} Set when the profile's guild link is clicked */
let pending = null;
let unregisterGuildWindow = null;
let profileHandler = null;
let active = false;

/**
 * Press the game's own handler for opening a profile. Runs on the next task, after our click handler has
 * returned: the game ignores a message sent within 100 ms of an untrusted click, and this one follows the
 * player's own (trusted) press.
 * @param {*} characterId
 */
function openProfile(characterId) {
    setTimeout(() => {
        try {
            const component = findGameComponent();
            if (!component) {
                showToast(FAILED_MESSAGE);
                return;
            }
            component.handleViewProfile(characterId);
        } catch (error) {
            console.error('[GuildProfileBack] Reopening the profile failed:', error);
            showToast(FAILED_MESSAGE);
        }
    }, 0);
}

function createButton(profile) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.textContent = `◂ ${profile.characterName}`;
    button.title = `Back to ${profile.characterName}'s profile`;
    button.style.cssText =
        'position: absolute; top: 6px; left: 6px; z-index: 2; margin: 0; padding: 2px 10px; font: inherit; ' +
        'font-size: 13px; color: #ffffff; background: rgba(91, 141, 239, 0.15); border: none; ' +
        'box-shadow: inset 0 0 0 1px rgba(91, 141, 239, 0.5); border-radius: 6px; cursor: pointer;';
    button.addEventListener('click', () => {
        // One press is one game action
        if (button.disabled) return;
        button.disabled = true;
        openProfile(profile.characterId);
    });
    return button;
}

function removeButtons() {
    for (const button of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
        const host = button.parentElement;
        button.remove();
        if (host?.hasAttribute(POSITIONED_ATTR)) {
            host.style.position = '';
            host.removeAttribute(POSITIONED_ATTR);
        }
    }
}

/**
 * A guild window mounted: give it the button when it was opened from a profile, and take any other button off.
 * @param {Element} windowEl - The SharableGuildProfile_modalContainer element
 */
export function onGuildWindow(windowEl) {
    if (!active || !hasGameClass(windowEl, 'SharableGuildProfile_modalContainer')) return;
    removeButtons();
    const from = pending;
    pending = null;
    if (!from || Date.now() - from.at > LINK_WINDOW_MS) return;
    // The container is the full-screen overlay (live: a background and the window as its two children); the
    // button belongs in the window itself, beside its title
    const host = [...windowEl.children].find((child) => hasGameClass(child, 'SharableGuildProfile_modal')) || windowEl;
    if (getComputedStyle(host).position === 'static') {
        host.style.position = 'relative';
        host.setAttribute(POSITIONED_ATTR, '');
    }
    host.insertBefore(createButton(from), host.firstChild);
}

/** Capture listener: the profile window's guild link was clicked */
function onDocumentClick(event) {
    const link = closestGameClass(event.target, 'SharableProfile_guildInfo');
    if (!link) return;
    const modal = closestGameClass(link, 'SharableProfile_modalContainer');
    // The profile this link belongs to must be the one the last profile_shared described
    if (!lastProfile || !modal || !(modal.textContent || '').includes(lastProfile.characterName)) {
        pending = null;
        return;
    }
    pending = { ...lastProfile, at: Date.now() };
}

export function initialize() {
    if (active) return;
    if (!config.getSetting(SETTING_KEY)) return;
    active = true;
    profileHandler = (message) => {
        // The raw message is `{type, profile}` (live, 2026-11-24): the game sends no character id beside the
        // profile, and `sharableCharacter` carries the name but no id. The id is read the way websocket.js reads
        // it for the shared-profile store, from the character's own skill rows.
        const profile = message?.profile;
        const characterId =
            message?.characterID ??
            (profile?.sharableCharacter?.id || profile?.characterSkills?.[0]?.characterID || profile?.character?.id);
        const characterName = message?.characterName ?? profile?.sharableCharacter?.name;
        lastProfile =
            characterId !== undefined && characterId !== null && characterName && characterName !== 'Unknown'
                ? { characterId, characterName }
                : null;
    };
    webSocketHook.on('profile_shared', profileHandler);
    document.addEventListener('click', onDocumentClick, true);
    unregisterGuildWindow = domObserver.onClass('GuildProfileBack', 'SharableGuildProfile_modalContainer', (el) =>
        onGuildWindow(el)
    );
}

export function disable() {
    active = false;
    if (profileHandler) webSocketHook.off('profile_shared', profileHandler);
    profileHandler = null;
    document.removeEventListener('click', onDocumentClick, true);
    unregisterGuildWindow?.();
    unregisterGuildWindow = null;
    lastProfile = null;
    pending = null;
    removeButtons();
}

export default { name: 'Guild Profile Back Button', initialize, disable };
