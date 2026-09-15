/**
 * Chat Fill
 *
 * Put text in the game's chat box — never send it.
 *
 * The one rule this module exists to keep: a script does not perform game
 * actions on its own, and a chat message is one. So the text is inserted at the
 * cursor through the native value setter (React only notices a change made that
 * way), an input event tells React about it, the box is focused, and pressing
 * Enter stays the player's call.
 *
 * When chat is collapsed or absent there is nothing to fill, and a fill into an
 * invisible input would look like it worked while doing nothing — so
 * {@link fillChatOrCopy} falls back to the clipboard and says which happened.
 */

import { findChatInput } from './profile-command.js';

/**
 * Insert text into the chat input at the cursor, focused and unsent.
 *
 * @param {string} text - What to insert
 * @param {Object} [options]
 * @param {Element|null} [options.input] - The input to fill; found via `findChatInput` when omitted
 * @param {string} [options.logPrefix] - Module name for the error log
 * @returns {boolean} True when the box was filled; false when chat is not visible or the fill failed
 */
export function fillChatInput(text, { input = null, logPrefix = 'ChatFill' } = {}) {
    if (!text) return false;
    try {
        const target = input || findChatInput();
        if (!target) return false;

        const current = String(target.value ?? '');
        const start = Number.isInteger(target.selectionStart) ? target.selectionStart : current.length;
        const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : start;
        const next = current.slice(0, start) + text + current.slice(end);

        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(target, next);
        else target.value = next;
        target.dispatchEvent(new Event('input', { bubbles: true }));

        target.focus();
        const caret = start + text.length;
        try {
            target.setSelectionRange?.(caret, caret);
        } catch {
            // Some input types refuse a selection; the text is in, which is what matters
        }
        return true;
    } catch (error) {
        console.error(`[${logPrefix}] Could not fill the chat input:`, error);
        return false;
    }
}

/**
 * Fill chat, or copy to the clipboard when chat is not visible.
 *
 * @param {string} text - What to share
 * @param {Object} [options]
 * @param {string} [options.logPrefix] - Module name for the error log
 * @returns {Promise<'chat'|'clipboard'|'failed'>} Where the text ended up
 */
export async function fillChatOrCopy(text, { logPrefix = 'ChatFill' } = {}) {
    if (!text) return 'failed';
    if (fillChatInput(text, { logPrefix })) return 'chat';

    try {
        if (!navigator.clipboard?.writeText) return 'failed';
        await navigator.clipboard.writeText(text);
        return 'clipboard';
    } catch (error) {
        console.error(`[${logPrefix}] Chat not visible and the clipboard refused:`, error);
        return 'failed';
    }
}

/**
 * A short phrase for where shared text went, for a button flash or a toast.
 *
 * @param {'chat'|'clipboard'|'failed'} outcome - From {@link fillChatOrCopy}
 * @param {number} [length] - Character count, appended when given
 * @returns {string}
 */
export function describeChatFill(outcome, length) {
    const chars = Number.isFinite(length) ? ` (${length} chars)` : '';
    if (outcome === 'chat') return `filled chat${chars}`;
    if (outcome === 'clipboard') return `chat not visible — copied${chars}`;
    return 'could not fill chat or copy';
}
