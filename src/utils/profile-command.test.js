/** @vitest-environment happy-dom
 *
 * The shared "/profile <name>" chat trick.
 *
 * Extracted from guild-member-skills.js so every clickable player name — key
 * counts, party messages, run history headers, the DPS tile — fills the chat
 * box the same way. The contract is small and worth pinning: the command lands
 * in the input through the native setter, an input event tells React about it,
 * the box is focused, and a missing chat input is a false rather than a throw.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

import { fillProfileCommand, findChatInput, VALID_PLAYER_NAME_RE } from './profile-command.js';

afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('fillProfileCommand', () => {
    test('fills the input, dispatches an input event, and focuses the box', () => {
        document.body.innerHTML = '<div class="Chat_chatInputContainer__c"><input /></div>';
        const input = document.querySelector('input');
        const focus = vi.spyOn(input, 'focus');
        const inputEvents = [];
        input.addEventListener('input', (event) => inputEvents.push(event));

        expect(fillProfileCommand('Mazo')).toBe(true);

        expect(input.value).toBe('/profile Mazo');
        expect(inputEvents).toHaveLength(1);
        expect(inputEvents[0].bubbles).toBe(true);
        expect(focus).toHaveBeenCalled();
    });

    test('filled and focused, never sent — Enter stays the player’s call', () => {
        document.body.innerHTML = '<div class="Chat_chatInputContainer__c"><input /></div>';
        const input = document.querySelector('input');
        let submitted = false;
        input.addEventListener('keydown', () => (submitted = true));

        fillProfileCommand('Mazo');

        expect(submitted).toBe(false);
    });

    test('no chat input is a false, not a throw', () => {
        document.body.innerHTML = '';
        expect(fillProfileCommand('Mazo')).toBe(false);
    });

    test('a caller-supplied input is filled without searching the DOM', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);

        expect(fillProfileCommand('Mazo', input)).toBe(true);
        expect(input.value).toBe('/profile Mazo');
    });

    test('a failure logs under the caller’s own prefix and returns false', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        // dispatchEvent throwing stands in for any DOM misbehavior mid-fill
        const input = document.createElement('input');
        input.dispatchEvent = () => {
            throw new Error('boom');
        };

        expect(fillProfileCommand('Mazo', input, 'GuildMemberSkills')).toBe(false);
        expect(error).toHaveBeenCalledWith(
            '[GuildMemberSkills] Could not fill the profile command:',
            expect.any(Error)
        );
    });
});

describe('findChatInput', () => {
    test('finds the game’s chat input', () => {
        document.body.innerHTML = '<div class="Chat_chatInputContainer__c"><input /></div>';
        expect(findChatInput()).toBe(document.querySelector('input'));
    });

    test('no chat on screen is null', () => {
        document.body.innerHTML = '<div class="SomethingElse"><input /></div>';
        expect(findChatInput()).toBeNull();
    });

    test('a renamed input container is survived through the chat panel', () => {
        // The inner container's class is the game's to rename; the panel-level
        // fallbacks keep the /profile route alive when it does
        document.body.innerHTML = '<div class="Chat_chat__3D"><form><input /></form></div>';
        expect(findChatInput()).toBe(document.querySelector('input'));

        document.body.innerHTML = '<div class="GamePage_chatPanel__m"><div><input /></div></div>';
        expect(findChatInput()).toBe(document.querySelector('input'));
    });
});

describe('VALID_PLAYER_NAME_RE', () => {
    test('accepts a plain alphanumeric/underscore name', () => {
        expect(VALID_PLAYER_NAME_RE.test('Player_123')).toBe(true);
    });

    test('rejects anything that could produce a bogus /profile command', () => {
        expect(VALID_PLAYER_NAME_RE.test('Player Name')).toBe(false);
        expect(VALID_PLAYER_NAME_RE.test('<script>')).toBe(false);
        expect(VALID_PLAYER_NAME_RE.test('')).toBe(false);
    });
});
