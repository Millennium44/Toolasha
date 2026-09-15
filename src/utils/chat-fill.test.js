/** @vitest-environment happy-dom
 *
 * Filling the chat box. The rule this pins: text lands in the input, React is
 * told, the box is focused — and nothing is ever sent. When chat is not on
 * screen, the text goes to the clipboard and the caller is told which.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

import {
    fillChatInput,
    fillChatOrCopy,
    describeChatFill,
    CHAT_MAX_BYTES,
    utf8Length,
    truncateToUtf8Bytes,
    trimToFit,
    chatBudgetBytes,
} from './chat-fill.js';

const chat = (value = '') => {
    document.body.innerHTML = '<div class="Chat_chatInputContainer__x"><form><input /></form></div>';
    const input = document.querySelector('input');
    input.value = value;
    return input;
};

afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('fillChatInput', () => {
    test('fills, dispatches an input event and focuses', () => {
        const input = chat();
        const focus = vi.spyOn(input, 'focus');
        const events = [];
        input.addEventListener('input', (event) => events.push(event));

        expect(fillChatInput('Combat Stats: 1h duration')).toEqual({ filled: true, trimmed: false });

        expect(input.value).toBe('Combat Stats: 1h duration');
        expect(events).toHaveLength(1);
        expect(events[0].bubbles).toBe(true);
        expect(focus).toHaveBeenCalled();
    });

    test('never sends — no Enter, no submit', () => {
        const input = chat();
        let keyed = false;
        let submitted = false;
        input.addEventListener('keydown', () => (keyed = true));
        document.querySelector('form').addEventListener('submit', (event) => {
            submitted = true;
            event.preventDefault();
        });

        fillChatInput('hello');

        expect(keyed).toBe(false);
        expect(submitted).toBe(false);
    });

    test('inserts at the cursor, keeping what was already typed', () => {
        const input = chat('gg  wp');
        input.setSelectionRange(3, 3);

        fillChatInput('[stats]');

        expect(input.value).toBe('gg [stats] wp');
        expect(input.selectionStart).toBe(10);
    });

    test('replaces a selection', () => {
        const input = chat('replace ME please');
        input.setSelectionRange(8, 10);

        fillChatInput('you');

        expect(input.value).toBe('replace you please');
    });

    test('no chat on screen is false, not a throw', () => {
        document.body.innerHTML = '';
        expect(fillChatInput('hello')).toEqual({ filled: false, trimmed: false });
    });

    test('empty text fills nothing', () => {
        const input = chat('kept');
        expect(fillChatInput('')).toEqual({ filled: false, trimmed: false });
        expect(input.value).toBe('kept');
    });

    test('a DOM failure logs under the caller’s prefix and returns false', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const input = document.createElement('input');
        input.dispatchEvent = () => {
            throw new Error('boom');
        };

        expect(fillChatInput('hello', { input, logPrefix: 'Combat Stats' })).toEqual({
            filled: false,
            trimmed: false,
        });
        expect(error).toHaveBeenCalledWith('[Combat Stats] Could not fill the chat input:', expect.any(Error));
    });

    test('trims text that alone would exceed the game’s 400-byte limit', () => {
        const input = chat();
        const long = 'x'.repeat(500);

        const result = fillChatInput(long);

        expect(result).toEqual({ filled: true, trimmed: true });
        expect(utf8Length(input.value)).toBe(CHAT_MAX_BYTES);
        expect(input.value).toBe('x'.repeat(CHAT_MAX_BYTES));
    });

    test('the budget accounts for text already in the box outside the cursor', () => {
        // A player who typed "/w Name " before triggering a fill has that much
        // less than 400 bytes left for what gets inserted
        const prefix = '/w Millennium ';
        const input = chat(prefix);
        input.setSelectionRange(prefix.length, prefix.length);
        const long = 'y'.repeat(500);

        fillChatInput(long);

        expect(utf8Length(input.value)).toBe(CHAT_MAX_BYTES);
        expect(input.value.startsWith(prefix)).toBe(true);
    });

    test('a multi-byte trim never splits a code point', () => {
        // Every character here is a 3-byte UTF-8 sequence (☃, U+2603), so a
        // byte-budget slice that ignored code point boundaries would corrupt one
        const input = chat();
        const snowmen = '☃'.repeat(200); // 600 bytes — over the limit

        fillChatInput(snowmen);

        expect(utf8Length(input.value)).toBeLessThanOrEqual(CHAT_MAX_BYTES);
        // Every character that landed is a whole, valid snowman — nothing half-written
        expect([...input.value].every((ch) => ch === '☃')).toBe(true);
    });

    test('an emoji-heavy line costs more bytes than its character count suggests', () => {
        const input = chat();
        // 💬 is a 4-byte surrogate-pair emoji; 100 of them is 400 bytes exactly —
        // right at the limit even though the string is only 200 UTF-16 code units
        const emoji = '💬'.repeat(150); // 600 bytes, over budget

        fillChatInput(emoji);

        expect(utf8Length(input.value)).toBeLessThanOrEqual(CHAT_MAX_BYTES);
        expect(input.value.length % 2).toBe(0); // no lone surrogate half
    });
});

describe('truncateToUtf8Bytes', () => {
    test('leaves text under the budget alone', () => {
        expect(truncateToUtf8Bytes('hello', 400)).toBe('hello');
    });

    test('cuts ASCII to the exact byte count', () => {
        expect(truncateToUtf8Bytes('x'.repeat(10), 4)).toBe('xxxx');
    });

    test('never splits a multi-byte character', () => {
        // € is 3 bytes; a 4-byte budget fits one and not a second
        expect(truncateToUtf8Bytes('€€', 4)).toBe('€');
    });

    test('a zero or negative budget is nothing', () => {
        expect(truncateToUtf8Bytes('hello', 0)).toBe('');
        expect(truncateToUtf8Bytes('hello', -5)).toBe('');
    });
});

describe('trimToFit', () => {
    test('leaves text under the budget alone', () => {
        expect(trimToFit('short', 400)).toBe('short');
    });

    test('backs off to the previous space rather than cutting mid-word', () => {
        const text = 'Combat Stats: 1h duration | 500 income | 12 deaths';
        const trimmed = trimToFit(text, 30);

        expect(utf8Length(trimmed)).toBeLessThanOrEqual(30);
        expect(trimmed.endsWith('…')).toBe(true);
        // The character right before the ellipsis was a space in the source —
        // proof the cut backed off rather than slicing "durat" out of a word
        expect(text.startsWith(trimmed.slice(0, -1))).toBe(true);
    });

    test('a single long token with no space still gets an honest byte-accurate cut', () => {
        const trimmed = trimToFit('x'.repeat(50), 10);
        expect(utf8Length(trimmed)).toBeLessThanOrEqual(10);
        expect(trimmed.endsWith('…')).toBe(true);
    });
});

describe('fillChatOrCopy', () => {
    test('chat visible: fills, and does not touch the clipboard', async () => {
        const input = chat();
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

        expect(await fillChatOrCopy('hello')).toEqual({ outcome: 'chat', trimmed: false, chatFull: false });
        expect(input.value).toBe('hello');
        expect(write).not.toHaveBeenCalled();
    });

    test('chat hidden: copies instead', async () => {
        document.body.innerHTML = '';
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

        expect(await fillChatOrCopy('hello')).toEqual({ outcome: 'clipboard', trimmed: false, chatFull: false });
        expect(write).toHaveBeenCalledWith('hello');
    });

    test('chat hidden and the clipboard refuses: failed', async () => {
        document.body.innerHTML = '';
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

        expect(await fillChatOrCopy('hello')).toEqual({ outcome: 'failed', trimmed: false, chatFull: false });
    });

    test('chat visible but the text needed trimming: says so, and copy still gets the full text', async () => {
        chat();
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
        const long = 'x'.repeat(500);

        const result = await fillChatOrCopy(long);

        expect(result).toEqual({ outcome: 'chat', trimmed: true, chatFull: false });
        // The clipboard has no chat limit — only a fill into chat itself trims
        expect(write).not.toHaveBeenCalled();
    });
});

describe('describeChatFill', () => {
    test('says where the text went, with a count when given', () => {
        expect(describeChatFill('chat', 212)).toBe('filled chat (212 chars)');
        expect(describeChatFill('clipboard')).toBe('chat not visible — copied');
        expect(describeChatFill('failed')).toBe('could not fill chat or copy');
    });

    test('says so when the text had to be trimmed to fit', () => {
        expect(describeChatFill('chat', 400, true)).toBe('filled chat — trimmed to fit (400 chars)');
        expect(describeChatFill('chat', null, true)).toBe('filled chat — trimmed to fit');
    });
});

describe('multi-code-point emoji at the byte limit', () => {
    test('a flag is kept or dropped whole, never cut to one regional indicator', () => {
        // 🇺🇸 is two 4-byte regional indicators; a code-point cut at 4 bytes kept "🇺"
        expect(truncateToUtf8Bytes('🇺🇸', 4)).toBe('');
        expect(truncateToUtf8Bytes('a🇺🇸', 7)).toBe('a');
    });

    test('a ZWJ family is not cut down to a dangling joiner', () => {
        const family = '👨‍👩‍👧'; // 18 bytes: three 4-byte emoji joined by two 3-byte ZWJs
        expect(truncateToUtf8Bytes(`x${family}`, 12)).toBe('x');
        expect(truncateToUtf8Bytes(`x${family}`, 19)).toBe(`x${family}`);
    });

    test('a skin-toned emoji keeps its modifier or goes entirely', () => {
        expect(truncateToUtf8Bytes('👍🏽', 4)).toBe('');
    });

    test('filling past the limit ends on a whole emoji', () => {
        const input = chat('x'.repeat(394));
        fillChatInput('🇺🇸🇺🇸');
        expect(input.value).toBe('x'.repeat(394));
    });
});

describe('trimToFit under a budget smaller than the ellipsis', () => {
    test('stays within the budget rather than returning a 3-byte "…"', () => {
        expect(utf8Length(trimToFit('hello world', 2))).toBeLessThanOrEqual(2);
        expect(trimToFit('hello world', 2)).toBe('he');
        expect(trimToFit('hello world', 0)).toBe('');
    });
});

describe('a chat box already at the limit', () => {
    test('is copied and reported as full, not as chat being hidden', async () => {
        chat('z'.repeat(CHAT_MAX_BYTES));
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

        const result = await fillChatOrCopy('hello');

        expect(result).toEqual({ outcome: 'clipboard', trimmed: false, chatFull: true });
        expect(write).toHaveBeenCalledWith('hello');
        expect(describeChatFill(result.outcome, null, result.trimmed, result.chatFull)).toBe('chat is full — copied');
    });
});

describe('chatBudgetBytes', () => {
    test('the whole limit with no chat on screen', () => {
        document.body.innerHTML = '';
        expect(chatBudgetBytes()).toBe(CHAT_MAX_BYTES);
    });

    test('less whatever the box holds outside its selection', () => {
        const input = chat('/w Millennium hi');
        input.setSelectionRange(14, 16); // "hi" selected, and replaced by a fill
        expect(chatBudgetBytes()).toBe(CHAT_MAX_BYTES - 14);
    });

    test('no room left budgets for the clipboard copy instead of an empty message', () => {
        chat('z'.repeat(CHAT_MAX_BYTES));
        expect(chatBudgetBytes()).toBe(CHAT_MAX_BYTES);
        chat('€'.repeat(200)); // 600 bytes, more than the game would ever hold
        expect(chatBudgetBytes()).toBe(CHAT_MAX_BYTES);
    });
});
