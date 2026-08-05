/** @vitest-environment happy-dom
 *
 * Which chat announcements get a clickable name.
 *
 * The pattern is a list of verbs, and the list is the feature: an announcement
 * whose verb is missing gets no link and nobody files a bug about a link that
 * is not there. "has joined the guild!" sat outside the list for exactly that
 * reason.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';

// Mutable so tests can flip the setting on/off; chat-profile-link.js reads it live.
const settings = vi.hoisted(() => ({ chat_profileLink: false }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: (key) => settings[key] ?? false } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../utils/dom.js', () => ({ addStyles: () => {} }));

const {
    ANNOUNCE_RE,
    VALID_NAME_RE,
    markAsProfileLink,
    default: chatProfileLinkFeature,
} = await import('./chat-profile-link.js');

const nameIn = (message) => message.match(ANNOUNCE_RE)?.[1] ?? null;

afterEach(() => {
    settings.chat_profileLink = false;
    document.body.innerHTML = '';
});

describe('announcements that get a link', () => {
    test('a level-up names its player', () => {
        expect(nameIn('PlayerName has reached level 150 Magic!')).toBe('PlayerName');
    });

    test('joining the guild does too', () => {
        expect(nameIn('Mazo has joined the guild!')).toBe('Mazo');
    });

    test('and leaving it, which is the same sentence pointed the other way', () => {
        expect(nameIn('Mazo has left the guild.')).toBe('Mazo');
    });

    test('a channel tag in front does not hide the name', () => {
        expect(nameIn('[General] Someone has completed a task')).toBe('Someone');
    });
});

describe('messages that do not', () => {
    test('ordinary chat is not an announcement', () => {
        // Regular messages already have the game's own clickable sender
        expect(nameIn('anyone selling cheese?')).toBe(null);
    });

    test('nor is "has" mid-sentence doing ordinary work', () => {
        expect(nameIn('the market has been wild today')).toBe(null);
    });
});

describe('VALID_NAME_RE', () => {
    test('accepts a plain alphanumeric/underscore name', () => {
        expect(VALID_NAME_RE.test('Player_123')).toBe(true);
    });

    test('rejects names with spaces or markup, which could produce a bogus /profile command', () => {
        expect(VALID_NAME_RE.test('Player Name')).toBe(false);
        expect(VALID_NAME_RE.test('<script>')).toBe(false);
        expect(VALID_NAME_RE.test('')).toBe(false);
    });
});

/**
 * markAsProfileLink is what mention-popup.js and pop-out-chat.js reuse to make character
 * names *they* render clickable, instead of duplicating chat-profile-link's click/fill logic.
 */
describe('markAsProfileLink', () => {
    test('does nothing when the profile-link setting is off, so callers can call it unconditionally', () => {
        settings.chat_profileLink = false;
        const el = document.createElement('span');
        expect(markAsProfileLink(el, 'Someone')).toBe(false);
        expect(el.className).toBe('');
    });

    test('rejects a name with special characters, leaving the element undecorated', () => {
        settings.chat_profileLink = true;
        const el = document.createElement('span');
        expect(markAsProfileLink(el, 'Not A Name')).toBe(false);
        expect(el.classList.contains('mwi-chat-profile-name')).toBe(false);
    });

    test('decorates the element and fills "/profile <name>" into the chat input on click', () => {
        settings.chat_profileLink = true;
        document.body.innerHTML = '<div class="Chat_chatInputContainer"><input /></div>';
        const input = document.querySelector('input');

        const el = document.createElement('span');
        el.textContent = 'Someone';
        document.body.appendChild(el);

        expect(markAsProfileLink(el, 'Someone')).toBe(true);
        expect(el.classList.contains('mwi-chat-profile-name')).toBe(true);

        el.dispatchEvent(new Event('click', { bubbles: true }));
        expect(input.value).toBe('/profile Someone');
    });

    test('a cloned element keeps working, because the click handler is delegated rather than attached per-element', () => {
        // Mirrors what chat-history-extender.js does when it clones an evicted chat message
        // into the history buffer: cloneNode(true) copies classes and data-* attributes but
        // never copies JS listeners, so a per-element addEventListener would go dead on clone.
        settings.chat_profileLink = true;
        document.body.innerHTML = '<div class="Chat_chatInputContainer"><input /></div>';
        const input = document.querySelector('input');

        const original = document.createElement('span');
        original.textContent = 'Someone';
        markAsProfileLink(original, 'Someone');

        const clone = original.cloneNode(true);
        document.body.appendChild(clone);

        clone.dispatchEvent(new Event('click', { bubbles: true }));
        expect(input.value).toBe('/profile Someone');
    });
});

describe('end-to-end: an announcement message decorated by the feature is clickable', () => {
    test('initialize() wraps the name and clicking it fills the chat input', () => {
        settings.chat_profileLink = true;
        document.body.innerHTML =
            '<div class="Chat_chatInputContainer"><input /></div>' +
            '<div class="ChatMessage_chatMessage">Mazo has joined the guild!</div>';
        const input = document.querySelector('input');

        chatProfileLinkFeature.initialize();

        const nameSpan = document.querySelector('.mwi-chat-profile-name');
        expect(nameSpan).not.toBeNull();
        expect(nameSpan.textContent).toBe('Mazo');

        nameSpan.dispatchEvent(new Event('click', { bubbles: true }));
        expect(input.value).toBe('/profile Mazo');

        chatProfileLinkFeature.disable();
    });
});
