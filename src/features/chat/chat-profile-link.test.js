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
const observerReady = vi.hoisted(() => ({ handlers: [], domReady: true }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        // Mirrors the real DOMObserver.onReady: immediate when already attached (the default),
        // deferred until the readiness-gap test fires it by hand otherwise.
        onReady: (name, callback) => {
            const handler = { name, callback };
            observerReady.handlers.push(handler);
            if (observerReady.domReady) callback();
            return () => {
                observerReady.handlers = observerReady.handlers.filter((h) => h !== handler);
            };
        },
    },
}));
vi.mock('../../utils/dom.js', () => ({ addStyles: () => {} }));

const {
    ANNOUNCE_RE,
    PARTY_RE,
    VALID_NAME_RE,
    markAsProfileLink,
    default: chatProfileLinkFeature,
} = await import('./chat-profile-link.js');

const nameIn = (message) => message.match(ANNOUNCE_RE)?.[1] ?? null;
const partyNameIn = (message) => message.match(PARTY_RE)?.[1] ?? null;

afterEach(() => {
    settings.chat_profileLink = false;
    document.body.innerHTML = '';
    observerReady.handlers = [];
    observerReady.domReady = true;
});

describe('announcements that get a link', () => {
    test('a level-up names its player', () => {
        expect(nameIn('PlayerName has reached level 150 Magic!')).toBe('PlayerName');
    });

    test('joining the guild does too', () => {
        expect(nameIn('Player11 has joined the guild!')).toBe('Player11');
    });

    test('and leaving it, which is the same sentence pointed the other way', () => {
        expect(nameIn('Player11 has left the guild.')).toBe('Player11');
    });

    test('a channel tag in front does not hide the name', () => {
        expect(nameIn('[General] Someone has completed a task')).toBe('Someone');
    });

    test('a player whose name only starts with "Guild" still links', () => {
        expect(nameIn('GuildMaster has reached level 150 Magic!')).toBe('GuildMaster');
    });
});

describe('the guild-wide broadcast is not a player', () => {
    test('"Guild has reached level N!" gets no name', () => {
        // "Guild" is the guild, not a player — it must not become a /profile link
        expect(nameIn('Guild has reached level 148!')).toBe(null);
    });

    test('a timestamp in front does not sneak it back in', () => {
        expect(nameIn('[8/6 7:42:38 AM] Guild has reached level 148!')).toBe(null);
    });
});

describe('party status lines', () => {
    test('all four shapes name their player', () => {
        expect(partyNameIn('Briggsy99 has joined the party.')).toBe('Briggsy99');
        expect(partyNameIn('Briggsy99 has left the party.')).toBe('Briggsy99');
        expect(partyNameIn('Briggsy99 is ready.')).toBe('Briggsy99');
        expect(partyNameIn('Briggsy99 is not ready.')).toBe('Briggsy99');
    });

    test('a timestamp in front does not hide the name', () => {
        expect(partyNameIn('[08/04 10:00:00 AM] Briggsy99 is ready.')).toBe('Briggsy99');
    });

    test('anything longer than exactly those sentences is left alone', () => {
        // The end anchor is the conservatism: a player typing one of these
        // phrases mid-sentence must never grow a link
        expect(partyNameIn('Briggsy99 is ready to trade!')).toBe(null);
        expect(partyNameIn('Briggsy99 is ready. Let us go')).toBe(null);
        expect(partyNameIn('I think Briggsy99 has left the party.')).toBe(null);
        expect(partyNameIn('the party has joined the party bus')).toBe(null);
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
            '<div class="ChatMessage_chatMessage">Player11 has joined the guild!</div>';
        const input = document.querySelector('input');

        chatProfileLinkFeature.initialize();

        const nameSpan = document.querySelector('.mwi-chat-profile-name');
        expect(nameSpan).not.toBeNull();
        expect(nameSpan.textContent).toBe('Player11');

        nameSpan.dispatchEvent(new Event('click', { bubbles: true }));
        expect(input.value).toBe('/profile Player11');

        chatProfileLinkFeature.disable();
    });

    test('a party ready line gets the same treatment, and its text never changes', () => {
        settings.chat_profileLink = true;
        document.body.innerHTML =
            '<div class="Chat_chatInputContainer"><input /></div>' +
            '<div class="ChatMessage_chatMessage">Briggsy99 is not ready.</div>';
        const input = document.querySelector('input');
        const messageEl = document.querySelector('.ChatMessage_chatMessage');
        const before = messageEl.textContent;

        chatProfileLinkFeature.initialize();

        const nameSpan = document.querySelector('.mwi-chat-profile-name');
        expect(nameSpan?.textContent).toBe('Briggsy99');
        expect(messageEl.textContent).toBe(before);

        nameSpan.dispatchEvent(new Event('click', { bubbles: true }));
        expect(input.value).toBe('/profile Briggsy99');

        chatProfileLinkFeature.disable();
    });

    test('a message mounted before the shared observer is ready is decorated at readiness', () => {
        settings.chat_profileLink = true;
        observerReady.domReady = false;
        document.body.innerHTML = '<div class="ChatMessage_chatMessage">Player11 has joined the guild!</div>';

        chatProfileLinkFeature.initialize();
        expect(document.querySelector('.mwi-chat-profile-name')).toBeNull();

        observerReady.handlers.forEach((h) => h.callback());
        expect(document.querySelector('.mwi-chat-profile-name')?.textContent).toBe('Player11');

        chatProfileLinkFeature.disable();
    });
});
