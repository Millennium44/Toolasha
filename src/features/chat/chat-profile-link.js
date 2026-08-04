/**
 * Chat Profile Link
 * Makes player names in system chat announcements clickable — messages like
 * "PlayerName has reached level 150 Magic!" or "PlayerName has joined the
 * guild!" get the leading name wrapped in a link that autofills
 * "/profile <name>" into the chat input when clicked.
 *
 * Regular player messages already have the game's own clickable name menu,
 * so only announcement-style messages (name followed by "has …") are
 * decorated.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { addStyles } from '../../utils/dom.js';

const NAME_CLASS = 'mwi-chat-profile-name';
// "<Name> has <verb> …" announcements; names are single tokens in MWI
export const ANNOUNCE_RE =
    /^\s*(?:\[[^\]]*\]\s*)?([A-Za-z0-9_]+) has (?:reached|obtained|found|completed|defeated|earned|achieved|unlocked|opened|crafted|caught|leveled|joined|left)\b/;

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

class ChatProfileLink {
    constructor() {
        this.isInitialized = false;
        this.unregisterObserver = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('chat_profileLink')) return;
        this.isInitialized = true;

        addStyles(
            `.${NAME_CLASS} { color: #4a9eff; cursor: pointer; }
             .${NAME_CLASS}:hover { text-decoration: underline; }`,
            'mwi-chat-profile-link-style'
        );

        this.unregisterObserver = domObserver.onClass('ChatProfileLink', 'ChatMessage_chatMessage', (messageEl) =>
            this._decorateMessage(messageEl)
        );

        document.querySelectorAll('[class*="ChatMessage_chatMessage"]').forEach((el) => this._decorateMessage(el));
    }

    /**
     * Wrap the leading player name of an announcement message in a clickable
     * span. Skips messages with the game's own clickable sender name.
     */
    _decorateMessage(messageEl) {
        if (messageEl.dataset.mwiProfileLink) return;
        messageEl.dataset.mwiProfileLink = '1';

        const match = (messageEl.textContent || '').match(ANNOUNCE_RE);
        if (!match) return;
        const name = match[1];

        // Find the text node containing the name and split it around the match
        const nodeWalker = document.createTreeWalker(messageEl, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = nodeWalker.nextNode())) {
            const idx = textNode.textContent.indexOf(name);
            if (idx === -1) continue;
            // Only wrap when this occurrence is followed by " has " to avoid
            // matching the name elsewhere in the sentence
            const after = textNode.textContent.slice(idx + name.length);
            if (!after.startsWith(' has ')) continue;

            const range = document.createRange();
            range.setStart(textNode, idx);
            range.setEnd(textNode, idx + name.length);
            const span = document.createElement('span');
            span.className = NAME_CLASS;
            span.title = `Fill "/profile ${name}" into chat`;
            span.addEventListener('click', () => this._fillProfileCommand(name));
            range.surroundContents(span);
            return;
        }
    }

    /** Autofill "/profile <name>" into the chat input and focus it */
    _fillProfileCommand(name) {
        const chatInput = document.querySelector('[class*="Chat_chatInputContainer"] input');
        if (!chatInput) return;
        nativeInputValueSetter.call(chatInput, `/profile ${name}`);
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
        chatInput.focus();
    }

    disable() {
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }
        this.isInitialized = false;
    }
}

const chatProfileLink = new ChatProfileLink();

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
