/**
 * Chat Profile Link
 * Makes player names in system chat announcements clickable — messages like
 * "PlayerName has reached level 150 Magic!" or "PlayerName has joined the
 * guild!" get the leading name wrapped in a link that autofills
 * "/profile <name>" into the chat input when clicked. Party status lines
 * ("X has joined the party.", "X is ready.", "X is not ready.", "X has left
 * the party.") get the same treatment, matched against exactly those four
 * sentence shapes so nothing else is ever touched.
 *
 * Regular player messages already have the game's own clickable name menu,
 * so only announcement-style messages (name followed by "has …") are
 * decorated.
 *
 * Other chat-extension features (mention popup, pop-out chat window, chat
 * history buffer clones, …) reuse `markAsProfileLink` below to get the same
 * click behavior on the character names *they* render, instead of
 * duplicating the click/fill logic. Decoration is a plain class + data
 * attribute rather than a per-element listener, and clicks are handled by a
 * single delegated document listener — so a name stays clickable even after
 * being `cloneNode(true)`'d elsewhere (e.g. into the chat history buffer),
 * which a directly-attached listener would not survive.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { addStyles } from '../../utils/dom.js';
import { PARTY_STATUS_PHRASES } from '../../utils/game-text.js';
import { openPlayerProfile, VALID_PLAYER_NAME_RE } from '../../utils/profile-command.js';

const NAME_CLASS = 'mwi-chat-profile-name';
// "<Name> has <verb> …" announcements; names are single tokens in MWI.
// The `(?!Guild has\b)` guard skips the guild-wide broadcast "Guild has reached
// level N!" — "Guild" is the guild there, not a player, so it must not become a
// /profile link. Only the exact token "Guild" before " has" is excluded, so a
// player named "GuildMaster" still links. Add more reserved subjects to the
// lookahead as `(?!(?:Guild|Other) has\b)` if the game grows them.
export const ANNOUNCE_RE =
    /^\s*(?:\[[^\]]*\]\s*)?(?!Guild has\b)([A-Za-z0-9_]+) has (?:reached|obtained|found|completed|defeated|earned|achieved|unlocked|opened|crafted|caught|leveled|joined|left|added)\b/;
/** A phrase as a regex fragment: every character taken literally */
const escapeForRegExp = (phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Party system lines: the leading name in exactly the four sentence shapes the
// party panel writes (game-text.js), anchored at the end so "<Name> is ready
// to trade!" or any longer sentence is never touched — only the party panel's
// own status messages match.
export const PARTY_RE = new RegExp(
    `^\\s*(?:\\[[^\\]]*\\]\\s*)*([A-Za-z0-9_]+) (?:${PARTY_STATUS_PHRASES.map(escapeForRegExp).join('|')})$`
);
// MWI player names are a single alphanumeric/underscore token — reject anything else
// (spaces, punctuation, etc.) so a malformed name can't produce a broken /profile command.
export const VALID_NAME_RE = VALID_PLAYER_NAME_RE;

class ChatProfileLink {
    constructor() {
        this.stylesActive = false;
        this.delegatedClickHandler = null;
        this.observerActive = false;
        this.unregisterObserver = null;
    }

    /**
     * Ensure the shared style and the delegated click listener exist. Idempotent and safe to
     * call from any feature that wants to decorate a name, independent of whether the
     * announcement-decorating observer below (`initialize`) is itself active yet.
     */
    _ensureActive() {
        if (this.stylesActive) return;
        this.stylesActive = true;

        addStyles(
            `.${NAME_CLASS} { color: #4a9eff; cursor: pointer; }
             .${NAME_CLASS}:hover { text-decoration: underline; }`,
            'mwi-chat-profile-link-style'
        );

        this.delegatedClickHandler = (e) => {
            const target = e.target.closest(`.${NAME_CLASS}`);
            if (!target) return;
            const name = target.dataset.mwiProfileName;
            if (!name) return;
            openPlayerProfile(name, { logPrefix: 'ChatProfileLink' });
        };
        document.addEventListener('click', this.delegatedClickHandler);
    }

    initialize() {
        if (this.observerActive) return;
        if (!config.getSetting('chat_profileLink')) return;
        this.observerActive = true;
        this._ensureActive();

        this.unregisterObserver = domObserver.onClass('ChatProfileLink', 'ChatMessage_chatMessage', (messageEl) =>
            this._decorateMessage(messageEl)
        );

        document.querySelectorAll('[class*="ChatMessage_chatMessage"]').forEach((el) => this._decorateMessage(el));
    }

    /**
     * Wrap the leading player name of an announcement or party status message
     * in a clickable span. Skips messages with the game's own clickable sender
     * name. Only the name is wrapped — the message's text never changes.
     */
    _decorateMessage(messageEl) {
        if (messageEl.dataset.mwiProfileLink) return;
        messageEl.dataset.mwiProfileLink = '1';

        const text = messageEl.textContent || '';
        const match = text.match(ANNOUNCE_RE) || text.match(PARTY_RE);
        if (!match) return;
        const name = match[1];

        // Find the text node containing the name and split it around the match
        const nodeWalker = document.createTreeWalker(messageEl, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = nodeWalker.nextNode())) {
            const idx = textNode.textContent.indexOf(name);
            if (idx === -1) continue;
            // Only wrap when this occurrence is followed by " has " (announcements,
            // party join/leave) or " is " (ready states), to avoid matching the
            // name elsewhere in the sentence
            const after = textNode.textContent.slice(idx + name.length);
            if (!after.startsWith(' has ') && !after.startsWith(' is ')) continue;

            const range = document.createRange();
            range.setStart(textNode, idx);
            range.setEnd(textNode, idx + name.length);
            const span = document.createElement('span');
            markAsProfileLink(span, name);
            range.surroundContents(span);
            return;
        }
    }

    disable() {
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }
        if (this.delegatedClickHandler) {
            document.removeEventListener('click', this.delegatedClickHandler);
            this.delegatedClickHandler = null;
        }
        this.stylesActive = false;
        this.observerActive = false;
    }
}

const chatProfileLink = new ChatProfileLink();

/**
 * Style an element as a clickable "/profile <name>" link — the same click-to-fill behavior as
 * announcement names get. Intended for other chat-extension features that render character
 * names of their own (mention popup, pop-out chat, …) so they don't duplicate the click/fill
 * logic. A no-op (element left as-is) when the profile-link setting is off or `name` doesn't
 * look like a real single-token MWI player name, so callers can call it unconditionally.
 * @param {HTMLElement} el - Element to mark; its existing text/children are left alone
 * @param {string} name - Player name to fill into "/profile <name>"
 * @returns {boolean} whether the element was decorated
 */
export function markAsProfileLink(el, name) {
    if (!el || typeof name !== 'string') return false;
    if (!config.getSetting('chat_profileLink')) return false;
    if (!VALID_NAME_RE.test(name)) return false;

    chatProfileLink._ensureActive();
    el.classList.add(NAME_CLASS);
    el.dataset.mwiProfileName = name;
    if (!el.title) el.title = `Open ${name}'s profile`;
    return true;
}

export default {
    name: 'Chat Profile Link',
    initialize: () => {
        chatProfileLink.initialize();
    },
    cleanup: () => {
        chatProfileLink.disable();
    },
    disable: () => {
        chatProfileLink.disable();
    },
};
