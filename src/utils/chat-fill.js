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
 * The game's own chat length limit — measured live on the test server, not
 * assumed. `handleChatInputChanged` in the game's own bundle runs every
 * keystroke through `truncateToUTF8Bytes(text, 400)` before it ever reaches
 * React state, so 400 is a byte budget on the UTF-8 encoding of the whole
 * input value, not a character count: filling 1,020 ASCII characters left the
 * input at exactly 400 characters, but an emoji or a non-Latin item name costs
 * 3-4 bytes each and hits the wall far sooner than its character count
 * suggests.
 */
export const CHAT_MAX_BYTES = 400;

/**
 * How many UTF-8 bytes a string encodes to — what the game's own limit counts.
 * @param {string} text
 * @returns {number}
 */
export function utf8Length(text) {
    return new TextEncoder().encode(text).length;
}

/**
 * Cut a string to fit a UTF-8 byte budget without splitting a code point or a
 * surrogate pair in half — a naive slice on `.length` (UTF-16 code units) can
 * land inside a multi-byte character or a surrogate pair and hand the game a
 * value one code unit short of a real character.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string} A prefix of `text` whose UTF-8 encoding is at most `maxBytes`
 */
export function truncateToUtf8Bytes(text, maxBytes) {
    if (maxBytes <= 0) return '';
    if (utf8Length(text) <= maxBytes) return text;

    let result = '';
    let bytes = 0;
    // `for...of` walks a string by code point, so a surrogate pair (an emoji
    // outside the BMP) is one step, never split mid-pair
    for (const char of text) {
        const charBytes = utf8Length(char);
        if (bytes + charBytes > maxBytes) break;
        result += char;
        bytes += charBytes;
    }
    return result;
}

/**
 * Cut text to a byte budget, backing off to the previous space so a word or a
 * number is never sliced in half, and marking the cut with "…".
 *
 * For text that has no separator to back off to (a single long token), the
 * byte-accurate cut stands on its own — an ellipsis with nothing behind it
 * beats nothing at all.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function trimToFit(text, maxBytes) {
    if (utf8Length(text) <= maxBytes) return text;

    const ellipsis = '…';
    const budget = Math.max(maxBytes - utf8Length(ellipsis), 0);
    let cut = truncateToUtf8Bytes(text, budget);

    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);

    return cut + ellipsis;
}

/**
 * Insert text into the chat input at the cursor, focused and unsent — trimmed
 * first if it would otherwise push the box past the game's own chat limit.
 *
 * The budget is what is left after the input's own existing text (outside
 * whatever is selected, which this insertion replaces): a `/w Name ` the
 * player already typed eats into the same 400 bytes the inserted text has to
 * fit in.
 *
 * @param {string} text - What to insert
 * @param {Object} [options]
 * @param {Element|null} [options.input] - The input to fill; found via `findChatInput` when omitted
 * @param {string} [options.logPrefix] - Module name for the error log
 * @returns {{filled: boolean, trimmed: boolean}} `filled`: whether anything landed in the box.
 *   `trimmed`: whether the inserted text had to be cut to fit.
 */
export function fillChatInput(text, { input = null, logPrefix = 'ChatFill' } = {}) {
    if (!text) return { filled: false, trimmed: false };
    try {
        const target = input || findChatInput();
        if (!target) return { filled: false, trimmed: false };

        const current = String(target.value ?? '');
        const start = Number.isInteger(target.selectionStart) ? target.selectionStart : current.length;
        const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : start;
        const outside = current.slice(0, start) + current.slice(end);

        const budget = Math.max(CHAT_MAX_BYTES - utf8Length(outside), 0);
        const fits = utf8Length(text) <= budget;
        const insert = fits ? text : truncateToUtf8Bytes(text, budget);
        if (!insert) return { filled: false, trimmed: true };

        const next = current.slice(0, start) + insert + current.slice(end);

        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(target, next);
        else target.value = next;
        target.dispatchEvent(new Event('input', { bubbles: true }));

        target.focus();
        const caret = start + insert.length;
        try {
            target.setSelectionRange?.(caret, caret);
        } catch {
            // Some input types refuse a selection; the text is in, which is what matters
        }
        return { filled: true, trimmed: !fits };
    } catch (error) {
        console.error(`[${logPrefix}] Could not fill the chat input:`, error);
        return { filled: false, trimmed: false };
    }
}

/**
 * Fill chat, or copy to the clipboard when chat is not visible.
 *
 * The clipboard has no chat limit of its own, so a copy carries the full text
 * regardless of what a fill into chat would have had to trim.
 *
 * @param {string} text - What to share
 * @param {Object} [options]
 * @param {string} [options.logPrefix] - Module name for the error log
 * @returns {Promise<{outcome: 'chat'|'clipboard'|'failed', trimmed: boolean}>} Where the text
 *   ended up, and whether it had to be cut to fit the chat box
 */
export async function fillChatOrCopy(text, { logPrefix = 'ChatFill' } = {}) {
    if (!text) return { outcome: 'failed', trimmed: false };
    const filledResult = fillChatInput(text, { logPrefix });
    if (filledResult.filled) return { outcome: 'chat', trimmed: filledResult.trimmed };

    try {
        if (!navigator.clipboard?.writeText) return { outcome: 'failed', trimmed: false };
        await navigator.clipboard.writeText(text);
        return { outcome: 'clipboard', trimmed: false };
    } catch (error) {
        console.error(`[${logPrefix}] Chat not visible and the clipboard refused:`, error);
        return { outcome: 'failed', trimmed: false };
    }
}

/**
 * A short phrase for where shared text went, for a button flash or a toast.
 *
 * @param {'chat'|'clipboard'|'failed'} outcome - From {@link fillChatOrCopy}
 * @param {number} [length] - Character count, appended when given
 * @param {boolean} [trimmed] - Whether the text had to be cut to fit the chat limit
 * @returns {string}
 */
export function describeChatFill(outcome, length, trimmed = false) {
    const chars = Number.isFinite(length) ? ` (${length} chars)` : '';
    const suffix = trimmed ? ' — trimmed to fit' : '';
    if (outcome === 'chat') return `filled chat${suffix}${chars}`;
    if (outcome === 'clipboard') return `chat not visible — copied${chars}`;
    return 'could not fill chat or copy';
}
