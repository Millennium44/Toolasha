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
// Guild kick line: "nutsaccio has been kicked by miku." — the only announcement
// shape with TWO player names (the kicked player and the kicker), both linkable.
// "been kicked" is deliberately outside ANNOUNCE_RE's verb allowlist ("been" is too
// generic), so this gets its own tightly anchored whole-line matcher: the kicker
// group is captured too, and the end anchor keeps a player quoting "kicked by" in
// ordinary chat from lighting up.
export const KICK_RE = /^\s*(?:\[[^\]]*\]\s*)?([A-Za-z0-9_]+) has been kicked by ([A-Za-z0-9_]+)\.?\s*$/;
// Guild building upgrade: "RICK has upgraded Guild Brewery to level 3!" — only the
// leading name links. The building name varies ("Guild Brewery", "Guild Kitchen", …)
// but always starts "Guild ", so the literal "upgraded Guild " plus the "to level N"
// tail anchors the whole line and keeps "X upgraded his sword" out. The same
// `(?!Guild has\b)` guard as ANNOUNCE_RE keeps a system "Guild has upgraded …" line
// from linking the word "Guild".
export const UPGRADE_RE =
    /^\s*(?:\[[^\]]*\]\s*)?(?!Guild has\b)([A-Za-z0-9_]+) has upgraded Guild .+? to level \d+!?\s*$/;
// MWI player names are a single alphanumeric/underscore token — reject anything else
// (spaces, punctuation, etc.) so a malformed name can't produce a broken /profile command.
export const VALID_NAME_RE = VALID_PLAYER_NAME_RE;

/**
 * The player name(s) to link in a chat line, in the order they appear, each with the
 * surrounding context needed to locate the right occurrence when wrapping. Single source
 * of truth shared by the main chat window and the pop-out (which interpolates this very
 * function into its self-contained document). Names are NOT validated here — the caller
 * runs each through {@link VALID_NAME_RE} before linking.
 * @param {string} text - Full message text
 * @returns {Array<{name: string, afterPrefixes?: string[], beforeSuffix?: string}>}
 */
export function getProfileLinkNames(text) {
    const kick = text.match(KICK_RE);
    if (kick) {
        // Kicked player leads the line; the kicker follows "kicked by ".
        return [
            { name: kick[1], afterPrefixes: [' has '] },
            { name: kick[2], beforeSuffix: 'kicked by ' },
        ];
    }
    const upgrade = text.match(UPGRADE_RE);
    if (upgrade) {
        return [{ name: upgrade[1], afterPrefixes: [' has '] }];
    }
    const announce = text.match(ANNOUNCE_RE);
    if (announce) {
        return [{ name: announce[1], afterPrefixes: [' has '] }];
    }
    const party = text.match(PARTY_RE);
    if (party) {
        return [{ name: party[1], afterPrefixes: [' has ', ' is '] }];
    }
    return [];
}

class ChatProfileLink {
    constructor() {
        this.stylesActive = false;
        this.delegatedClickHandler = null;
        this.observerActive = false;
        this.unregisterObserver = null;
        this.unregisterReady = null;
    }

    /**
     * Ensure the shared style and the delegated click listener exist. Idempotent and safe to
     * call from any feature that wants to decorate a name, independent of whether the
     * announcement-decorating observer below (`initialize`) is itself active yet.
     */
    _ensureActive() {
        if (this.stylesActive) return;
        this.stylesActive = true;

        // The packaged build carries a copy of this module in more than one
        // bundle, and each copy's markAsProfileLink can arrive here first. The
        // listener acts on shared DOM, so a second copy's listener means every
        // click opens the profile twice — the guard lives on globalThis so all
        // copies count as one.
        if (globalThis.__toolashaChatProfileLinkActive) return;
        globalThis.__toolashaChatProfileLinkActive = true;

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

        // @run-at document-start: messages rendered before the shared observer attaches to
        // document.body are invisible to the class watcher, so the catch-up scan waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterReady = domObserver.onReady('ChatProfileLinkCatchUp', () => {
            document.querySelectorAll('[class*="ChatMessage_chatMessage"]').forEach((el) => this._decorateMessage(el));
        });
    }

    /**
     * Wrap each linkable player name of an announcement or party status message
     * in a clickable span. A kick line ("X has been kicked by Y.") links both
     * names; every other shape links a single leading name. Skips messages with
     * the game's own clickable sender name. Only the names are wrapped — the
     * message's text never changes.
     */
    _decorateMessage(messageEl) {
        if (messageEl.dataset.mwiProfileLink) return;
        messageEl.dataset.mwiProfileLink = '1';

        const text = messageEl.textContent || '';
        for (const target of getProfileLinkNames(text)) {
            if (!VALID_NAME_RE.test(target.name)) continue;
            wrapNameOccurrence(messageEl, target);
        }
    }

    disable() {
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }
        if (this.unregisterReady) {
            this.unregisterReady();
            this.unregisterReady = null;
        }
        if (this.delegatedClickHandler) {
            document.removeEventListener('click', this.delegatedClickHandler);
            this.delegatedClickHandler = null;
            globalThis.__toolashaChatProfileLinkActive = false;
        }
        this.stylesActive = false;
        this.observerActive = false;
    }
}

const chatProfileLink = new ChatProfileLink();

/**
 * Wrap the first occurrence of `target.name` that satisfies its context guards in a
 * clickable profile-link span, in place. The guards disambiguate which occurrence to
 * wrap: `afterPrefixes` requires the text after the name to start with one of them,
 * `beforeSuffix` requires the text before it to end with that string. A fresh tree walk
 * per call keeps this correct when an earlier call has already split the text node
 * (e.g. wrapping the kicked player before the kicker in the same line).
 * @param {Node} root - Element to search within
 * @param {{name: string, afterPrefixes?: string[], beforeSuffix?: string}} target
 */
function wrapNameOccurrence(root, { name, afterPrefixes, beforeSuffix }) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
        if (node.parentElement?.classList.contains(NAME_CLASS)) continue;
        const content = node.textContent;
        let from = 0;
        let idx;
        while ((idx = content.indexOf(name, from)) !== -1) {
            const before = content.slice(0, idx);
            const after = content.slice(idx + name.length);
            const beforeOk = !beforeSuffix || before.endsWith(beforeSuffix);
            const afterOk = !afterPrefixes || afterPrefixes.some((prefix) => after.startsWith(prefix));
            if (beforeOk && afterOk) {
                const range = document.createRange();
                range.setStart(node, idx);
                range.setEnd(node, idx + name.length);
                const span = document.createElement('span');
                markAsProfileLink(span, name);
                range.surroundContents(span);
                return;
            }
            from = idx + name.length;
        }
    }
}

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
