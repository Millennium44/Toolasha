/** @vitest-environment happy-dom
 *
 * Filling the chat box. The rule this pins: text lands in the input, React is
 * told, the box is focused — and nothing is ever sent. When chat is not on
 * screen, the text goes to the clipboard and the caller is told which.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

import { fillChatInput, fillChatOrCopy, describeChatFill } from './chat-fill.js';

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

        expect(fillChatInput('Combat Stats: 1h duration')).toBe(true);

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
        expect(fillChatInput('hello')).toBe(false);
    });

    test('empty text fills nothing', () => {
        const input = chat('kept');
        expect(fillChatInput('')).toBe(false);
        expect(input.value).toBe('kept');
    });

    test('a DOM failure logs under the caller’s prefix and returns false', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const input = document.createElement('input');
        input.dispatchEvent = () => {
            throw new Error('boom');
        };

        expect(fillChatInput('hello', { input, logPrefix: 'Combat Stats' })).toBe(false);
        expect(error).toHaveBeenCalledWith('[Combat Stats] Could not fill the chat input:', expect.any(Error));
    });
});

describe('fillChatOrCopy', () => {
    test('chat visible: fills, and does not touch the clipboard', async () => {
        const input = chat();
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

        expect(await fillChatOrCopy('hello')).toBe('chat');
        expect(input.value).toBe('hello');
        expect(write).not.toHaveBeenCalled();
    });

    test('chat hidden: copies instead', async () => {
        document.body.innerHTML = '';
        const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

        expect(await fillChatOrCopy('hello')).toBe('clipboard');
        expect(write).toHaveBeenCalledWith('hello');
    });

    test('chat hidden and the clipboard refuses: failed', async () => {
        document.body.innerHTML = '';
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

        expect(await fillChatOrCopy('hello')).toBe('failed');
    });
});

describe('describeChatFill', () => {
    test('says where the text went, with a count when given', () => {
        expect(describeChatFill('chat', 212)).toBe('filled chat (212 chars)');
        expect(describeChatFill('clipboard')).toBe('chat not visible — copied');
        expect(describeChatFill('failed')).toBe('could not fill chat or copy');
    });
});
