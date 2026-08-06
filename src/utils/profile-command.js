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
    const input = document.querySelector('[class*="Chat_chatInputContainer"] input');
    if (!input) return null;

    const visible = input.offsetParent !== null || (input.getClientRects?.().length ?? 0) > 0;
    return visible ? input : null;
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
