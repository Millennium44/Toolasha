/**
 * Profile Command
 *
 * The "/profile <name>" chat trick, in one place.
 *
 * The game opens a player's profile from a chat command, and a userscript can
 * get the player one keypress away from that: write `/profile <name>` into the
 * chat input through the native value setter (so React notices the change),
 * dispatch an input event, and focus the box — the user just presses Enter.
 * Extracted from `guild-member-skills.js` so every surface that makes a player
 * name clickable fills the box the same way.
 */

/** What a real MWI player name looks like: a single alphanumeric/underscore token */
export const VALID_PLAYER_NAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * The chat input, if there is one the player can actually use.
 *
 * Hidden chat is why the visibility check matters: a fill into an input nobody
 * can see opens nothing while looking like it worked.
 *
 * @returns {Element|null} The input
 */
export function findChatInput() {
    if (typeof document === 'undefined') return null;
    // The input container's class is first choice; the panel-level fallbacks
    // survive the game renaming the inner container. A collapsed chat matches
    // nothing on any rung, and null is the honest answer there.
    const input =
        document.querySelector('[class*="Chat_chatInputContainer"] input') ||
        document.querySelector('[class*="Chat_chat__"] input') ||
        document.querySelector('[class*="GamePage_chatPanel"] input');
    if (!input) return null;

    const visible = input.offsetParent !== null || (input.getClientRects?.().length ?? 0) > 0;
    return visible ? input : null;
}

/**
 * The game's core component instance, found by walking the React fiber for the
 * `handleViewProfile` handler — the same object the chat commands reach for
 * `handleGoToMarketplace`. Null before the game has mounted.
 *
 * @returns {Object|null}
 */
export function getGameCore() {
    if (typeof document === 'undefined') return null;
    const root = document.getElementById('root');
    const fiber = root?._reactRootContainer?.current || root?._reactRootContainer?._internalRoot?.current;
    const find = (node) => {
        if (!node) return null;
        if (typeof node.stateNode?.handleViewProfile === 'function') return node.stateNode;
        return find(node.child) || find(node.sibling);
    };
    return find(fiber);
}

/**
 * Open a player's profile.
 *
 * Preferred path: call the game's own `handleViewProfile(name)` directly, which
 * opens the profile modal with no chat involvement — so it works whether or not
 * the chat panel is open. Falls back to filling `/profile <name>` in chat and
 * pressing Enter when that handler is missing.
 *
 * @param {string} name - Player name
 * @param {Object} [options]
 * @param {string} [options.logPrefix] - Module name for error logs
 * @returns {boolean} True when an open was triggered (direct or via chat)
 */
export function openPlayerProfile(name, { logPrefix = 'ProfileCommand' } = {}) {
    if (!name) return false;

    try {
        const game = getGameCore();
        if (game && typeof game.handleViewProfile === 'function') {
            game.handleViewProfile(name);
            return true;
        }
    } catch (error) {
        console.error(`[${logPrefix}] handleViewProfile failed; falling back to chat:`, error);
    }

    const input = findChatInput();
    if (!input || !fillProfileCommand(name, input, logPrefix)) return false;

    // Send on the next tick so React has processed the fill's input event first.
    setTimeout(() => {
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    }, 0);
    return true;
}

/**
 * Put `/profile <name>` in the chat box, focused and ready to send.
 *
 * @param {string} name - Player name
 * @param {Element|null} [chatInput] - The input to fill; found via {@link findChatInput} when omitted
 * @param {string} [logPrefix] - Module name for the error log, so a failure names its caller
 * @returns {boolean} True when the box was filled
 */
export function fillProfileCommand(name, chatInput = null, logPrefix = 'ProfileCommand') {
    try {
        const input = chatInput || findChatInput();
        if (!input) return false;

        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, `/profile ${name}`);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        return true;
    } catch (error) {
        console.error(`[${logPrefix}] Could not fill the profile command:`, error);
        return false;
    }
}
