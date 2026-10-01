/**
 * Chat History Extender
 * Preserves chat messages that the game evicts from the live buffer,
 * keeping them visible in a history section above the live messages, and
 * records every rendered message for chat-history-persistence.js — see that
 * module's "When a message is recorded" section.
 * Based on the original script by SilkyPanda.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import { RANK_BADGE_SELECTOR } from '../../utils/rank-badge-data.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import chatHistoryPersistence, {
    extractStoredMessageId,
    handleRestoredClick,
    itemHridFrom,
    messageIdentity,
    parseStoredMessage,
    rewireRestoredMessage,
    SENDER_SELECTOR,
    senderNameFrom,
    serializeMessage,
    TAB_KEY_PREFIX,
} from './chat-history-persistence.js';

const STYLE_ID = 'mwi-chat-history-extender-css';
const CSS = `
    .mwi-history-buffer {
        display: flex;
        flex-direction: column;
        width: 100%;
        background-color: rgba(0, 0, 0, 0.45);
        border-bottom: 2px dashed #555;
        margin-bottom: 5px;
    }
    .mwi-history-buffer > div { opacity: 0.9; position: relative; }
    .mwi-history-buffer > div:hover { opacity: 1; background-color: rgba(255, 255, 255, 0.05); }
    .mwi-interactive { cursor: pointer; }
    .mwi-history-restore-anchor { display: none; }
`;

/** The tab strip. Scoped: the game has other tab widgets, and none of them is chat. */
const TAB_STRIP_SELECTOR = '[class*="Chat_tabsComponentContainer"]';

/** A chat message container — one of these, for the open tab only. */
const CHAT_CONTAINER_SELECTOR = '[class*="ChatHistory_chatHistory"]';

/**
 * The label part of a tab's key, namespaced by where it was read from.
 *
 * The two sources disagree about what a label looks like: channel tabs carry
 * `data-mention-channel` (`/chat_channel_types/global`), while the rest —
 * language rooms, Help, whispers — have none and are named by their button
 * text (`English`, `Help`, a player name). Namespacing rather than mixing them
 * into one flat label keeps a whisper from a player called `Help` out of the
 * Help tab's record; the channel form additionally cannot collide with a text
 * label, because a player name cannot contain `/`.
 *
 * The trailing-digit trim takes off the unread badge the button renders after
 * its name, which would otherwise make the key change every time a message
 * arrives.
 *
 * @param {Element} button - A tab button
 * @returns {string} The namespaced label, or '' when the button names nothing
 */
function tabLabel(button) {
    const channel = button?.getAttribute?.('data-mention-channel');
    if (channel) return `ch:${channel}`;
    const text = button?.textContent?.trim().replace(/\d+$/, '').trim();
    return text ? `name:${text}` : '';
}

/**
 * The identity of one chat tab's message container: its name, or nothing.
 *
 * The game renders a container for the **open tab only** — one container, eight
 * buttons — so the tab is named by the button carrying `aria-selected="true"`,
 * never by the container's position. Naming it by position is what this
 * function used to do, and with a single container `indexOf` was always 0, so
 * every tab's history went under the first button's name and was restored into
 * whichever tab happened to be open. That is the failure the docstring here
 * used to warn about and then commit.
 *
 * Two ways the container is tied to that button, strongest first:
 *
 * 1. `aria-controls` on the button naming the panel the container sits in. This
 *    is a real link and holds however many containers the game decides to
 *    render, so it is preferred wherever the markup provides it.
 * 2. Otherwise, the fact that exactly one container exists. This is only sound
 *    while that is true, so it is *checked* rather than assumed: two containers
 *    means the claim has stopped holding and nothing is keyed.
 *
 * There is no mid-switch window to worry about: the button's `aria-selected`
 * and the container's contents are written by the same React commit, and the
 * DOM mutations of one commit are applied before any MutationObserver callback
 * — which is every path into here — is delivered. No caller can observe half a
 * switch.
 *
 * Whispers get their own tabs and so their own keys, which is the point — every
 * tab is persisted, private ones included.
 *
 * There is deliberately no positional fallback, and nothing is guessed. An
 * unnamed tab is not keyed at all: its history is skipped until the strip names
 * it. A tab whose history is missing is recoverable; a private conversation in
 * a public tab's scrollback is not.
 *
 * @param {Element} containerEl - A `ChatHistory_chatHistory` element
 * @returns {string|null} `tab2:<label>`, or null when the tab cannot be named
 */
export function chatTabKey(containerEl) {
    try {
        if (!containerEl || !containerEl.isConnected) return null;

        const strip = document.querySelector(TAB_STRIP_SELECTOR);
        if (!strip) return null;

        const selected = [...strip.querySelectorAll('button[role="tab"]')].filter(
            (button) => button.getAttribute('aria-selected') === 'true'
        );
        // Zero means the strip has not settled; more than one means the markup
        // no longer means what this reads it as. Neither is a tab identity.
        if (selected.length !== 1) return null;

        const label = tabLabel(selected[0]);
        if (!label) return null;

        const panelId = selected[0].getAttribute('aria-controls');
        const panel = panelId ? document.getElementById(panelId) : null;
        if (panel) return panel.contains(containerEl) ? `${TAB_KEY_PREFIX}${label}` : null;

        const containers = document.querySelectorAll(CHAT_CONTAINER_SELECTOR);
        if (containers.length !== 1 || containers[0] !== containerEl) return null;
        return `${TAB_KEY_PREFIX}${label}`;
    } catch {
        return null;
    }
}

/**
 * The channel hrid a `ch:`-keyed tab names, or null.
 *
 * Only a `ch:` tab (an aggregate channel like Trade or Global, keyed off
 * `data-mention-channel`) has a channel that the websocket's `chan` field
 * also names 1:1. A `name:` tab does not — several whisper conversations
 * share one `chan` value — so {@link PendingMessageIds} is never asked about
 * one, and a message recorded from one carries no id. See the "Message
 * identity and deletion" section in chat-history-persistence.js.
 *
 * @param {string|null} tabKey - From {@link chatTabKey}
 * @returns {string|null}
 */
function channelFromTabKey(tabKey) {
    const prefix = `${TAB_KEY_PREFIX}ch:`;
    if (!tabKey || !tabKey.startsWith(prefix)) return null;
    return tabKey.slice(prefix.length);
}

/**
 * The tab key a channel's own websocket `chan` field would be recorded
 * under, were that channel's tab open. The reverse of
 * {@link channelFromTabKey}, used by the `chat_message_updated` handler to
 * find where a deleted message might be stored without needing the DOM at
 * all — a moderator can delete a message in a channel this tab is not even
 * looking at.
 *
 * @param {string} chan - A `chat_message_updated` message's `chan` field
 * @returns {string} `tab2:ch:<chan>`
 */
export function tabKeyForChannel(chan) {
    return `${TAB_KEY_PREFIX}ch:${chan}`;
}

/**
 * How long a websocket-received id waits to be claimed by the DOM node it
 * belongs to before it is dropped as unclaimed. Generous next to how fast the
 * game actually renders (well under a second): this only needs to survive a
 * slow tab, not a stalled one.
 */
const PENDING_ID_TTL_MS = 15000;

/** Ceiling per channel, so a channel whose tab is never opened cannot grow this without bound. */
const PENDING_ID_MAX_PER_CHANNEL = 50;

/**
 * How many links a `chat_message_received` message's raw `linksMetadata`
 * names — every link type (item, market listing, ability, …) renders inside
 * its own `ChatMessage_linkContainer` wrapper (confirmed against a live
 * `/chat_link_types/item` post: `ChatMessage_linkContainer > Item_itemContainer
 * > … > Item_name`), so {@link claim} compares this against the DOM's own
 * link-container count rather than trying to tell link types apart or
 * reconstruct any of their rendered label text.
 * @param {string|undefined} linksMetadataJSON - `message.linksMetadata`, as sent (a JSON string)
 * @returns {number}
 */
function countLinks(linksMetadataJSON) {
    if (!linksMetadataJSON) return 0;
    try {
        const links = JSON.parse(linksMetadataJSON);
        return Array.isArray(links) ? links.length : 0;
    } catch {
        return 0;
    }
}

/**
 * Per-link identity from a `chat_message_received` message's raw
 * `linksMetadata`, in the same order `countLinks` counts — lets {@link claim}
 * tell apart two batched, same-sender, same-prose posts that link *different*
 * items (a known gap from PR 199: identical sender+body+count alone cannot
 * tell those apart, so both used to stay untagged).
 *
 * Only an item-type link's identity can be read back off the rendered DOM
 * (see {@link linkIdentitiesFromDom}), so only `/chat_link_types/item` links
 * get a non-null entry here; every other link type is `null`, which
 * {@link linksMatch} treats as unverifiable and falls back to the
 * count-only rule for that one link — this only removes false ambiguity, it
 * never adds any.
 * @param {string|undefined} linksMetadataJSON
 * @returns {Array<string|null>}
 */
function linkIdentitiesFromMetadata(linksMetadataJSON) {
    if (!linksMetadataJSON) return [];
    try {
        const links = JSON.parse(linksMetadataJSON);
        if (!Array.isArray(links)) return [];
        return links.map((link) =>
            link && link.linkType === '/chat_link_types/item' && link.itemHrid ? link.itemHrid : null
        );
    } catch {
        return [];
    }
}

/**
 * Per-link identity read back off a rendered node's own
 * `ChatMessage_linkContainer` elements, in document order — the DOM-side
 * counterpart to {@link linkIdentitiesFromMetadata}. An item link wraps an
 * `Item_itemContainer` whose sprite reference {@link itemHridFrom} already
 * knows how to read (the same handle `chat-history-persistence.js` uses to
 * re-wire a restored link); a container without one — a link type this
 * build cannot identify from the DOM — contributes `null`.
 * @param {Iterable<Element>} linkContainers - `ChatMessage_linkContainer` elements, in order
 * @returns {Array<string|null>}
 */
function linkIdentitiesFromDom(linkContainers) {
    return [...linkContainers].map((container) => {
        try {
            const itemContainer = container.querySelector('[class*="Item_itemContainer"]');
            return itemContainer ? itemHridFrom(itemContainer) : null;
        } catch {
            return null;
        }
    });
}

/**
 * Whether two same-length per-link identity arrays could describe the same
 * message. A pair of positions is a mismatch only when **both** sides could
 * identify that link and disagree; a position either side could not
 * identify (`null`) is unverifiable and never blocks a match, which is what
 * keeps this a strict tightening of the old count-only rule rather than a
 * new way to reject a match the old rule accepted.
 * @param {Array<string|null>} a
 * @param {Array<string|null>} b
 * @returns {boolean}
 */
function linksMatch(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return true;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] != null && b[i] != null && a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * `chat_message_received`'s own `m` field carries a `{{N}}` placeholder
 * everywhere a link renders (`N` indexing into `linksMetadata`) — confirmed
 * against a live post: `m: "{{0}} test link, please ignore"` for a message
 * with one link. The DOM never shows `{{0}}` literally, so it has to come out
 * before any text comparison, same as the link's own rendered content does
 * (see {@link extractSenderAndBody}).
 * @param {string} text
 * @returns {string}
 */
function stripLinkPlaceholders(text) {
    return (text || '').replace(/\{\{\d+\}\}/g, '');
}

/**
 * Collapse whitespace runs to a single space and trim — applied to both
 * sides of a body comparison so that stripping a link container out of the
 * DOM, or a `{{N}}` placeholder out of `m` (see {@link extractSenderAndBody}
 * and {@link stripLinkPlaceholders}), cannot turn the resulting gap into a
 * mismatch neither side actually disagrees about.
 * @param {string} text
 * @returns {string}
 */
function normalizeSpacing(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * A live message node's sender and message text, read the same way
 * {@link senderNameFrom} reads a restored one, plus everything that follows
 * it in document order.
 *
 * Reading the sender through its own element (rather than pattern-matching
 * the whole line) is what makes exact comparison possible at all: the line's
 * leading timestamp is formatted client-side from the user's clock settings,
 * which this script cannot reproduce, so nothing here ever tries to. Once
 * the sender's own text is found inside the node's full text, the remainder
 * — with the separator the game draws between name and message (":", ": ",
 * …) trimmed off the front — is the message body, whatever the timestamp
 * format turned out to be.
 *
 * A Trade/Recruit post naming an item (most of them do) also renders that
 * link inline, wrapped in its own `ChatMessage_linkContainer` — text
 * `chat_message_received`'s own `m` field never contained; the game sends a
 * `{{N}}` placeholder in `m` for it instead (see
 * {@link stripLinkPlaceholders}) and keeps the two fields separate on the
 * wire (the same split `resolveMessage`/`appendMessage` in pop-out-chat.js
 * draw). Comparing the whole line's rendered text against `m` verbatim would
 * therefore reject every linked message. Every `ChatMessage_linkContainer`
 * element is cut out of a clone before reading text, so the body extracted
 * here is prose only, matching what a placeholder-stripped `m` holds; how
 * many such elements the node held is returned separately, and `claim`
 * requires it to match the candidate's own link count from `linksMetadata` —
 * a structural check that does not depend on reconstructing any link's
 * exact rendered label text.
 *
 * @param {Element} node - A `ChatMessage_chatMessage` node
 * @returns {{sender: string, body: string, linkCount: number, linkIds: Array<string|null>}|null}
 *   Null when the node carries no sender element at all (a system message)
 *   or the extraction otherwise fails — both correctly mean "cannot be
 *   matched", not "matches anything".
 */
function extractSenderAndBody(node) {
    let senderEl;
    try {
        senderEl = node.querySelector(SENDER_SELECTOR);
    } catch {
        return null;
    }
    if (!senderEl) return null;

    const sender = senderNameFrom(senderEl);
    if (!sender) return null;

    let linkCount = 0;
    let linkIds = [];
    let textSource = node;
    try {
        const linkContainers = node.querySelectorAll('[class*="ChatMessage_linkContainer"]');
        linkCount = linkContainers.length;
        if (linkCount) linkIds = linkIdentitiesFromDom(linkContainers);
        // A rank badge sits between the name and the ':' and its rank would read as the start of the body
        if (linkCount || node.querySelector(RANK_BADGE_SELECTOR)) {
            const clone = node.cloneNode(true);
            clone
                .querySelectorAll(`[class*="ChatMessage_linkContainer"], ${RANK_BADGE_SELECTOR}`)
                .forEach((el) => el.remove());
            textSource = clone;
        }
    } catch {
        // Fall back to the un-stripped node; a link-bearing message just
        // will not match below, which is the safe outcome.
    }

    const fullText = textSource.textContent || '';
    const idx = fullText.indexOf(sender);
    if (idx === -1) return null;

    // Exactly one rendered separator: a body that itself starts with a colon (":D") keeps it
    const body = normalizeSpacing(fullText.slice(idx + sender.length).replace(/^\s*:\s*/, ''));
    return { sender, body, linkCount, linkIds };
}

/**
 * Matches this script's own DOM scrape of chat messages to the game's own
 * per-message `id`, so a later `chat_message_updated` deletion can find the
 * exact node — and, once stored, the exact stored entry — to remove.
 *
 * One instance per `ChatHistoryExtender` session (see its `messageIds`
 * field), fed by a `chat_message_received` listener and drained by
 * {@link ChatTabHandler#_tagMessageId} the moment a channel tab's DOM
 * actually renders the next message.
 *
 * Matching is by *exact* content, not queue position and not substring
 * search. A channel's queue can hold ids for messages that arrived while its
 * tab was not open (nothing renders them, so nothing claims them), and
 * opening — or switching to — that tab then renders its whole visible
 * backlog as one batch of `addedNodes`: a mutation batch that can mix nodes
 * the game already knew about with a genuinely new one. A blind FIFO shift
 * for every node in that batch, in DOM order, has no reason to land on the
 * node the front-of-queue id actually names.
 *
 * A substring check is not enough to fix that on its own: an earlier
 * `Bob: hi` entry is a substring match against a later node reading
 * `Bob: hi there`, and `Ann` against `Anna`, so a reordered or batched
 * render could still claim the wrong queued id for a node whose content only
 * *contains* it. {@link claim} therefore compares the sender and message
 * text {@link extractSenderAndBody} reads off the node for exact equality
 * against a candidate — never `.includes()` — and, if more than one queued
 * candidate matches exactly (two genuinely identical messages), claims
 * neither: which one is which cannot be told apart, so tagging either would
 * be a guess, and an untagged node is always the safe outcome. A message
 * naming a link also has to match on how many links it carries — see
 * {@link extractSenderAndBody} and {@link countLinks} — or a Trade post
 * (most of which name an item) would never satisfy the text comparison at
 * all, since the game keeps prose and links as separate fields on the wire.
 * Where a link's identity can be read on both sides (currently: item links,
 * via {@link linkIdentitiesFromMetadata} and {@link linkIdentitiesFromDom}),
 * {@link linksMatch} also requires it to agree — otherwise two batched posts
 * from one sender with identical prose and the same link count but
 * *different* linked items would both match every candidate and neither
 * would ever be tagged (accepted at PR 199 as a known limit; this is what
 * closes it for item links, while an unidentifiable link type still falls
 * back to the old count-only rule and keeps that ambiguity untagged).
 */
class PendingMessageIds {
    constructor() {
        /** @type {Map<string, Array<{id: string|number, isDeleted: boolean, sName: string, m: string, linkCount: number, linkIds: Array<string|null>, ts: number}>>} */
        this.byChannel = new Map();
    }

    /**
     * Record one message's id (and enough of its content to match against a
     * DOM node later) as soon as it is seen on the socket, before the node it
     * will render into exists.
     * @param {string} chan
     * @param {string|number} id
     * @param {boolean} isDeleted - True for a message that arrived pre-deleted
     * @param {string} [sName] - Sender name, as `chat_message_received` carries it
     * @param {string} [m] - Message text, as `chat_message_received` carries it — may
     *   contain `{{N}}` link placeholders, stripped before storing
     * @param {string} [linksMetadata] - Raw `linksMetadata`, as `chat_message_received` carries it
     */
    note(chan, id, isDeleted, sName, m, linksMetadata) {
        if (!chan || id == null) return;
        let queue = this.byChannel.get(chan);
        if (!queue) {
            queue = [];
            this.byChannel.set(chan, queue);
        }
        queue.push({
            id,
            isDeleted: !!isDeleted,
            sName: sName || '',
            m: normalizeSpacing(stripLinkPlaceholders(m)),
            linkCount: countLinks(linksMetadata),
            linkIds: linkIdentitiesFromMetadata(linksMetadata),
            ts: Date.now(),
        });
        if (queue.length > PENDING_ID_MAX_PER_CHANNEL) queue.shift();
    }

    /**
     * Claim the queued entry whose content matches a just-rendered node
     * *exactly*, if exactly one does — never just the front of the queue,
     * and never a substring match. See the class doc for why both of those
     * are unsafe on their own. A candidate with neither a sender nor a
     * message (a system message, whose `m` is a translation key the DOM
     * never shows verbatim) can never match, same as a node this build
     * cannot extract a sender/body from at all ({@link extractSenderAndBody}
     * returns null for it) — both correctly leave the node untagged, which
     * is always safe: see `purgeMessageById` / `findLiveMessageNode`, which
     * only ever touch a node already carrying `data-mwi-msg-id`.
     * @param {string} chan
     * @param {Element} node - The message node just added to the DOM
     * @returns {{id: string|number, isDeleted: boolean}|null}
     */
    claim(chan, node) {
        const queue = this.byChannel.get(chan);
        if (!queue || !queue.length) return null;

        const now = Date.now();
        while (queue.length && now - queue[0].ts > PENDING_ID_TTL_MS) queue.shift();
        if (!queue.length) return null;

        const rendered = extractSenderAndBody(node);
        if (!rendered) return null;

        const matches = [];
        for (let i = 0; i < queue.length; i += 1) {
            const entry = queue[i];
            if (!entry.sName && !entry.m) continue;
            if (entry.sName !== rendered.sender) continue;
            if (entry.m !== rendered.body) continue;
            if (entry.linkCount !== rendered.linkCount) continue;
            if (!linksMatch(entry.linkIds, rendered.linkIds)) continue;
            matches.push(i);
        }
        // Zero: nothing describes this node. More than one: two queued
        // messages this node's content cannot be told apart from — tagging
        // either would be a guess about which is which.
        if (matches.length !== 1) return null;

        return queue.splice(matches[0], 1)[0];
    }

    /**
     * Mark a queued entry deleted in place, without removing it from the
     * queue — a `chat_message_updated` deletion can arrive for an id before
     * the node it targets has ever rendered (see
     * `ChatHistoryExtender#_handleMessageUpdated`), and a still-pending entry
     * is exactly what `claim` will hand back to `_tagMessageId` once that
     * node finally does render. Without this, that later claim would return
     * an entry that still reads `isDeleted: false`, so `_tagMessageId` would
     * stamp an id instead of `data-mwi-skip-store` — {@link DeletedMessageIds}
     * covers that gap too, but only for the length of its own TTL, and a
     * node the game keeps showing (an author's own deleted message never
     * gets removed) can sit live for far longer than that before it is
     * finally evicted.
     *
     * Searches every channel, not just the one the update named: nothing
     * here is scoped by channel elsewhere either — {@link DeletedMessageIds}
     * is a flat id set — and an id is unique regardless of which channel a
     * caller happens to pass.
     * @param {string|number} id
     */
    markDeleted(id) {
        const key = String(id);
        for (const queue of this.byChannel.values()) {
            for (const entry of queue) {
                if (String(entry.id) === key) entry.isDeleted = true;
            }
        }
    }

    /**
     * The undo of {@link markDeleted} — a moderator's undelete arriving for
     * an id that is still only pending (never rendered) should not leave it
     * permanently flagged deleted.
     * @param {string|number} id
     */
    markUndeleted(id) {
        const key = String(id);
        for (const queue of this.byChannel.values()) {
            for (const entry of queue) {
                if (String(entry.id) === key) entry.isDeleted = false;
            }
        }
    }

    /**
     * Drop everything queued for one channel. A tab opening, or switching
     * into, that channel is about to render its whole visible backlog in one
     * batch — any id queued for it before that moment predates this
     * correlator being able to say anything useful about which node (if any)
     * it belongs to. `claim`'s content match already keeps a wrong node from
     * being tagged even without this; this just keeps a channel nobody has
     * opened from accumulating queue entries against nothing.
     * @param {string} chan
     */
    discardChannel(chan) {
        if (chan) this.byChannel.delete(chan);
    }

    /** Drop everything queued — a character switch means none of it is ours any more. */
    clear() {
        this.byChannel.clear();
    }
}

/**
 * How long a deleted message's id is remembered, so a `restore()` whose
 * `chatHistoryPersistence.load()` was already in flight when the deletion
 * arrived does not insert that message anyway.
 *
 * `chatHistoryPersistence.purgeMessageById` mutates the persistence layer's
 * working `tabs` object; a `restore()` already awaiting `load()` reads the
 * *snapshot* `load()` resolves with instead — a separate object, taken once
 * and never touched by a later purge (see chat-history-persistence.js's
 * `load()`). So the purge alone cannot stop that restore from rendering the
 * very message it just removed from storage. This tombstone is what does:
 * `restore()` skips any stored entry whose id it names. Generous next to how
 * long a single IndexedDB read actually takes — this only needs to outlive
 * one, not a whole session.
 */
const DELETED_ID_TTL_MS = 60000;

/** Ceiling on remembered deletions, so a very active moderator cannot grow this without bound. */
const DELETED_ID_MAX = 200;

/**
 * A short-lived record of ids `chat_message_updated` has marked deleted this
 * session — see {@link DELETED_ID_TTL_MS} for why `restore()` needs it.
 */
class DeletedMessageIds {
    constructor() {
        /** @type {Array<{id: string, ts: number}>} Insertion order, oldest first */
        this.entries = [];
        this.ids = new Set();
    }

    /** @param {string|number} id */
    add(id) {
        if (id == null) return;
        const key = String(id);
        if (this.ids.has(key)) return;
        this.ids.add(key);
        this.entries.push({ id: key, ts: Date.now() });
        if (this.entries.length > DELETED_ID_MAX) {
            const dropped = this.entries.shift();
            this.ids.delete(dropped.id);
        }
    }

    /**
     * @param {string|number|null} id
     * @returns {boolean}
     */
    has(id) {
        if (id == null) return false;
        this._prune();
        return this.ids.has(String(id));
    }

    /**
     * Undo one `add()` — an undelete means this id is not currently deleted
     * any more, and a stale tombstone entry would otherwise keep a live
     * node's later, ordinary eviction from being buffered/stored at all (see
     * `_onMutation`'s eviction handler, which consults this set as well as
     * the `mwiSkipStore` flag). `restore()`'s use of this set is a narrow
     * race-window catch, not a durable "is this deleted" record, so nothing
     * here needs to survive an undelete.
     * @param {string|number} id
     */
    remove(id) {
        if (id == null) return;
        const key = String(id);
        if (!this.ids.has(key)) return;
        this.ids.delete(key);
        this.entries = this.entries.filter((entry) => entry.id !== key);
    }

    _prune() {
        const now = Date.now();
        while (this.entries.length && now - this.entries[0].ts > DELETED_ID_TTL_MS) {
            const dropped = this.entries.shift();
            this.ids.delete(dropped.id);
        }
    }

    /** Drop everything remembered — a character switch means none of it is ours any more. */
    clear() {
        this.entries = [];
        this.ids.clear();
    }
}

/**
 * Read React props for a batch of DOM nodes via the fiber tree.
 *
 * The `__reactProps$…`/`__reactFiber$…` expando keys these nodes used to carry
 * were removed in the February 2026 update; `_reactRootContainer` on `#root`
 * was not, so props have to be read by walking down from there instead (same
 * pattern as `src/utils/react-click.js` and `src/features/tasks/task-card-quest.js`).
 * One tree walk serves every node in `domNodes` rather than one walk per node.
 * @param {Iterable<Element>} domNodes
 * @returns {Map<Element, object>} Only nodes whose fiber was found and had props
 */
function getReactPropsForNodes(domNodes) {
    const result = new Map();
    if (typeof document === 'undefined') return result;

    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return result;

    const targets = new Set(domNodes);
    const stack = [rootFiber];
    let guard = 0;
    while (stack.length && targets.size && guard++ < 500000) {
        const fiber = stack.pop();
        if (!fiber) continue;
        if (targets.has(fiber.stateNode)) {
            if (fiber.memoizedProps) result.set(fiber.stateNode, fiber.memoizedProps);
            targets.delete(fiber.stateNode);
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
    }
    return result;
}

/** The `[date time]` stamp an identity opens with, or null. */
function identityStamp(identity) {
    if (!identity?.startsWith('[')) return null;
    const close = identity.indexOf(']');
    return close > 0 ? identity.slice(0, close + 1) : null;
}

/**
 * How many leading stored lines come before the game's live backlog, or are
 * indistinguishable from where it begins.
 *
 * The backlog starts at its first line's LAST stored occurrence, not the
 * first: two genuine messages can share an identity (same timestamp, sender
 * and text) and the store keeps one entry, at the earlier message's position,
 * so stopping at the first match would drop every restorable line between the
 * two. The stored lines straight after that match that carry the same stamp
 * are counted too, for the same reason: they can be older than the live copy,
 * so only a later stamp proves a line newer than the backlog. A stored line
 * with a later stamp (deleted, or never sent back after a reload) still ends
 * it, so nothing provably newer is drawn above older live lines.
 *
 * @param {Array<string|null>} stored - {@link messageIdentity} of each stored line, oldest first
 * @param {Array<string|null>} live - {@link messageIdentity} of each live line, oldest first
 * @returns {number} Count of leading `stored` lines to consider, or -1 when no live line is stored
 */
export function liveBoundary(stored, live) {
    const first = live.find(Boolean);
    const at = first ? stored.lastIndexOf(first) : -1;
    if (at < 0) return -1;
    const stamp = identityStamp(first);
    let end = at + 1;
    while (stamp && end < stored.length && identityStamp(stored[end]) === stamp) end += 1;
    return end;
}

/**
 * How many leading stored lines a restore may draw.
 *
 * Ends where the live backlog begins ({@link liveBoundary}) and, whichever
 * comes first, at the first line this tab already holds in its buffer: those
 * were evicted this session, so nothing stored after them is older than they
 * are. Together these keep a line newer than the backlog from being drawn
 * above it.
 *
 * @param {Array<string|null>} stored - Stored identities, oldest first
 * @param {Array<string|null>} live - Live identities, oldest first
 * @param {Set<string>} buffered - Identities already in the buffer
 * @returns {number} Count of leading stored lines to consider
 */
function restoreBoundary(stored, live, buffered) {
    let end = liveBoundary(stored, live);
    if (end < 0) end = stored.length;
    const firstBuffered = stored.findIndex((identity) => identity && buffered.has(identity));
    return firstBuffered >= 0 ? Math.min(end, firstBuffered) : end;
}

/**
 * Manages the history buffer for a single chat tab container.
 */
class ChatTabHandler {
    /**
     * @param {Element} containerEl - The ChatHistory_chatHistory element
     * @param {Map} interactionCache - Shared cache of UID → React handlers
     * @param {() => number} getMaxHistory - Returns current max history setting
     * @param {string|null} tabKey - Persistence key for this tab, from {@link chatTabKey}
     * @param {PendingMessageIds} messageIds - Shared id correlator, from {@link ChatHistoryExtender}
     * @param {DeletedMessageIds} deletedIds - Shared deletion tombstone, from {@link ChatHistoryExtender}
     */
    constructor(containerEl, interactionCache, getMaxHistory, tabKey = null, messageIds = null, deletedIds = null) {
        this.container = containerEl;
        this.interactionCache = interactionCache;
        this.getMaxHistory = getMaxHistory;
        this.tabKey = tabKey;
        this.messageIds = messageIds;
        this.deletedIds = deletedIds;
        /**
         * Whether this tab's restore got nothing because the stored history
         * could not be read, as opposed to there being none. Cleared by the
         * next restore; read by {@link ChatTabHandler#refillIfNeeded}.
         */
        this.needsRefill = false;
        /** Saved live allowance at the last restore; read only by {@link ChatTabHandler#_pendingOverlap}. */
        this._restoredAllowance = 0;
        /** Guards the one re-run of a restore whose failed answer raced a recovery. */
        this._retriedRestore = false;
        /** Whether a restore has already been fired for this tab; see {@link _resolveTabKey}. */
        this.restoreStarted = false;
        /** @type {WeakMap<Element, string|null>} Buffered node → {@link messageIdentity}, computed once */
        this.bufferIdentities = new WeakMap();

        this.bufferEl = document.createElement('div');
        this.bufferEl.className = 'mwi-history-buffer';
        this.container.insertBefore(this.bufferEl, this.container.firstChild);

        /**
         * Where restored messages end and this session's evictions begin.
         *
         * Inserted synchronously; the restore that fills above it is async, so
         * without an anchor a message evicted in the first second would sit
         * above history older than itself. Hidden, and skipped by every count
         * and trim below, which look for message nodes rather than children.
         */
        this.restoreAnchor = document.createElement('div');
        this.restoreAnchor.className = 'mwi-history-restore-anchor';
        this.bufferEl.appendChild(this.restoreAnchor);

        const events = ['click', 'contextmenu', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout'];
        events.forEach((evt) => this.bufferEl.addEventListener(evt, this._handleEmulatedEvent.bind(this), true));
        // Restored links carry no captured React callback, so they are served by
        // this script's own navigation instead — see chat-history-persistence.js.
        this.bufferEl.addEventListener('click', handleRestoredClick, true);

        this.observer = new MutationObserver(this._onMutation.bind(this));
        this.observer.observe(this.container, { childList: true });
    }

    /**
     * The message nodes in the buffer, in order. Not `children`: the restore
     * anchor is a child too and must never be counted or trimmed.
     * @returns {Array<Element>} Buffered message elements, oldest first
     */
    _messageNodes() {
        return [...this.bufferEl.children].filter((el) => el.className?.includes?.('ChatMessage_chatMessage'));
    }

    /**
     * The game's own live message nodes in this container — everything that
     * is a message and not inside this script's buffer.
     * @returns {Array<Element>}
     */
    _liveMessageNodes() {
        return [...this.container.children].filter(
            (el) => el !== this.bufferEl && el.className?.includes?.('ChatMessage_chatMessage')
        );
    }

    /** @returns {Array<string|null>} {@link messageIdentity} of every live message, in pane order */
    _liveIdentityList() {
        return this._liveMessageNodes().map((node) => messageIdentity(serializeMessage(node)));
    }

    /** @returns {Set<string>} {@link messageIdentity} of every live message */
    _liveIdentities() {
        const identities = new Set();
        for (const node of this._liveMessageNodes()) {
            const identity = messageIdentity(serializeMessage(node));
            if (identity) identities.add(identity);
        }
        return identities;
    }

    /**
     * Record a message the game is showing live, before anything can take it
     * away — see chat-history-persistence.js, "When a message is recorded".
     *
     * Only a node still in this container is recorded: a node added and
     * removed inside one mutation batch is either an eviction (recorded there)
     * or the outgoing tab's line in a tab switch, which must not be filed
     * under the incoming tab's key.
     *
     * @param {Element} node - A `ChatMessage_chatMessage` node
     * @param {string|null} tabKey - This container's tab key
     * @returns {string|null} The node's identity, when it was recorded
     */
    _recordLive(node, tabKey) {
        if (!tabKey || !node.isConnected || node.parentNode !== this.container) return null;
        if (node.dataset.mwiSkipStore === '1') return null;
        if (node.dataset.mwiMsgId && this.deletedIds?.has(node.dataset.mwiMsgId)) return null;
        const html = serializeMessage(node);
        if (!html) return null;
        chatHistoryPersistence.record(tabKey, html);
        return messageIdentity(html);
    }

    /**
     * Drop the ids still queued for a tab's channel once its backlog has been
     * tagged, so a channel whose tab is rarely opened does not accumulate
     * entries against nothing.
     * @param {string|null} tabKey
     */
    _discardQueuedIds(tabKey) {
        const chan = channelFromTabKey(tabKey);
        if (chan) this.messageIds?.discardChannel(chan);
    }

    /**
     * {@link messageIdentity} of a buffered node, computed once per node.
     * @param {Element} node - A buffered message node
     * @returns {string|null}
     */
    _bufferIdentity(node) {
        let identity = this.bufferIdentities.get(node);
        if (identity === undefined) {
            identity = messageIdentity(serializeMessage(node));
            this.bufferIdentities.set(node, identity);
        }
        return identity;
    }

    /**
     * Take out of the buffer any message the game has just rendered live again
     * — a restored copy of a line that was still on screen when it was saved,
     * which the game re-renders after a reload or when its tab is reopened.
     * Restored lines from the start of the live backlog on go too (see
     * {@link liveBoundary}): the backlog rendered after the restore landed, and
     * those lines are not older than it.
     * @param {Set<string>} identities - Of the messages just rendered live
     */
    _dropBufferedDuplicates(identities) {
        if (!identities.size) return;
        const nodes = this._messageNodes().map((node) => ({
            node,
            restored: Boolean(node.compareDocumentPosition(this.restoreAnchor) & Node.DOCUMENT_POSITION_FOLLOWING),
            identity: this._bufferIdentity(node),
        }));
        const restoredNodes = nodes.filter((entry) => entry.restored);
        // Restored history ends where the live backlog begins, as in `restore`.
        // Every batch of a live chat passes through here, so the live pane is
        // only read once a restored line has actually come round again.
        let tailStart = Infinity;
        const firstRepeat = restoredNodes.findIndex((entry) => entry.identity && identities.has(entry.identity));
        if (firstRepeat >= 0) {
            const boundary = liveBoundary(
                restoredNodes.map((entry) => entry.identity),
                this._liveIdentityList()
            );
            tailStart = boundary >= 0 ? boundary : firstRepeat;
        }
        let restoredIndex = 0;
        for (const { node, restored, identity } of nodes) {
            const index = restored ? restoredIndex++ : -1;
            const renderedLive = Boolean(identity) && identities.has(identity);
            if (!renderedLive && !(restored && index >= tailStart)) continue;
            node.querySelectorAll('[data-mwi-uid]').forEach((u) => {
                this.interactionCache.delete(u.getAttribute('data-mwi-uid'));
            });
            if (node.hasAttribute('data-mwi-uid')) {
                this.interactionCache.delete(node.getAttribute('data-mwi-uid'));
            }
            node.remove();
        }
    }

    /**
     * Empty the buffer of rendered messages, keeping the restore anchor.
     *
     * Used when the container stops being the tab it was: what it is showing
     * belongs to the tab that was open before, and leaving it on screen is the
     * whole reported symptom — a private conversation in a public tab's
     * scrollback. Nothing on disk is touched; both tabs' records are intact and
     * the new tab's is restored straight after.
     */
    _clearBuffer() {
        this._restoredAllowance = 0;
        for (const node of this._messageNodes()) {
            node.querySelectorAll('[data-mwi-uid]').forEach((u) => {
                this.interactionCache.delete(u.getAttribute('data-mwi-uid'));
            });
            if (node.hasAttribute('data-mwi-uid')) {
                this.interactionCache.delete(node.getAttribute('data-mwi-uid'));
            }
            node.remove();
        }
    }

    /**
     * This tab's persistence key, re-read rather than remembered.
     *
     * Deliberately not cached for the life of the handler. The game renders one
     * container for the open tab, and there is no guarantee it builds a fresh
     * one per tab — React is free to reuse the node and swap its contents, in
     * which case a remembered key would file a whisper under whichever tab was
     * open when the container first appeared. The key is a property of what the
     * container is showing *now*, so it is asked for now: one scoped query per
     * mutation batch, not per message.
     *
     * Three transitions matter:
     *
     * - Unnamed → named (the tab strip rendered late): the buffer holds this
     *   tab's own evictions, so it is kept, and the restore that could not run
     *   while the tab was unnamed is fired here, once.
     * - Named → a *different* name (the container is now another tab): the
     *   buffer is emptied before anything else, and the new tab's history is
     *   restored into it.
     * - Named → unnamed (the strip stopped naming things): recording stops,
     *   because a guess is what this module exists to avoid. The buffer is left
     *   alone; the container has not changed tab, we have merely stopped being
     *   able to say which tab it is.
     *
     * @returns {string|null} `tab2:<label>`, or null while the tab is unnamed
     */
    _resolveTabKey() {
        const key = chatTabKey(this.container);
        if (key === this.tabKey) return key;

        const previous = this.tabKey;
        this.tabKey = key;

        if (previous && key && key !== previous) {
            this._clearBuffer();
            this.restoreStarted = false;
        }

        // The channel's queued ids are dropped once the batch that opens the
        // tab has been tagged (`_onMutation`), not here, before it: that
        // batch is the tab's backlog, and it is exactly the lines those ids
        // belong to. `claim()` matches on exact content and claims nothing
        // it cannot tell apart, which is what makes tagging a backlog safe.

        if (key && !this.restoreStarted) {
            this.restore(key).catch((error) => {
                console.error('[ChatHistoryExtender] Late restore failed:', error);
            });
        }
        return key;
    }

    /**
     * Put this tab's stored history back above the anchor.
     *
     * Off the critical path on purpose: the caller does not await it, so chat
     * is usable the moment the buffer exists and history arrives when the read
     * does. Any single message that will not parse or re-wire is skipped; the
     * rest still render.
     *
     * @param {string} tabKey - From {@link chatTabKey}
     * @returns {Promise<number>} How many messages were restored
     */
    async restore(tabKey) {
        if (!tabKey) return 0;
        this.restoreStarted = true;
        this.needsRefill = false;

        let loaded;
        try {
            loaded = await chatHistoryPersistence.load();
        } catch (error) {
            console.error('[ChatHistoryExtender] Could not load stored history:', error);
            this.needsRefill = true;
            return 0;
        }
        // The container may have been torn down while the read was in flight —
        // by a disable or a character switch. Nothing below may touch it, and
        // a departed handler must not refill the arriving character's tabs.
        if (!this.bufferEl.isConnected) return 0;
        // A failed read answers `{}`, the same as an empty record. Only a
        // successful one is the persistence layer's own snapshot object.
        if (!loaded || loaded !== chatHistoryPersistence.snapshot) {
            // A newer read may have succeeded while this answer was in flight,
            // before this tab was flagged for the recovery event; take its
            // snapshot rather than wait for an event that already fired.
            if (chatHistoryPersistence.snapshot && !this._retriedRestore) {
                this._retriedRestore = true;
                try {
                    return await this.restore(tabKey);
                } finally {
                    this._retriedRestore = false;
                }
            }
            this.needsRefill = true;
            return 0;
        }

        // The working record, not the first read's snapshot: a restore after a
        // tab switch has to include what this tab evicted since that read, which
        // the switch has just cleared out of the buffer.
        const stored = chatHistoryPersistence.messagesFor(tabKey) ?? loaded[tabKey];
        if (!Array.isArray(stored) || !stored.length) return 0;

        // Messages are recorded while they are still live, so what is on disk
        // overlaps what the game is showing right now. The live copy wins, and
        // so does a copy this tab already evicted into its buffer — a refill
        // runs on a tab that has been taking evictions since it mounted.
        const live = this._liveIdentities();
        const liveNow = this._liveMessageNodes().length;
        // The saved allowance says how many stored lines the game's backlog
        // will duplicate, and until that backlog renders they are all in the
        // buffer. An empty pane is not a report that nothing is live — it is
        // a backlog that has not arrived — so it must not overwrite the saved
        // figure, which the cap and the trim below both still need.
        // A pane that already shows a backlog has answered for itself: the saved
        // figure is stale, and holding it would keep the overlap of lines the
        // backlog never duplicates past the cap for good.
        this._restoredAllowance = liveNow > 0 ? liveNow : (chatHistoryPersistence.liveCountFor(tabKey) ?? 0);
        if (liveNow > 0) chatHistoryPersistence.setLiveCount(tabKey, liveNow);
        const buffered = new Set();
        for (const node of this._messageNodes()) {
            const identity = this._bufferIdentity(node);
            if (!identity) continue;
            live.add(identity);
            buffered.add(identity);
        }
        const storedIdentities = stored.map((html) => messageIdentity(html));
        const end = restoreBoundary(storedIdentities, this._liveIdentityList(), buffered);

        let restored = 0;
        for (let index = 0; index < end; index += 1) {
            const html = stored[index];
            try {
                // A copy of a line the game shows again is the live one's to
                // draw. It is skipped, not a stopping point: two messages can
                // share an identity, and the store keeps one entry at the
                // earlier message's position, ahead of lines older than the
                // live copy.
                if (live.has(storedIdentities[index])) continue;
                // A deletion that arrived while the `load()` above was still
                // in flight purges `chatHistoryPersistence.tabs` only once its
                // own wait on that read resumes, which can be after this one;
                // the snapshot fallback is never purged at all (see
                // DeletedMessageIds' class doc). Without this check, that
                // deleted message would be restored anyway.
                if (this.deletedIds?.has(extractStoredMessageId(html))) continue;

                const el = parseStoredMessage(html);
                if (!el) continue;
                rewireRestoredMessage(el);
                el.dataset.mwiRestored = '1';
                this.bufferEl.insertBefore(el, this.restoreAnchor);
                restored += 1;
            } catch (error) {
                console.error('[ChatHistoryExtender] Skipped an unrestorable message:', error);
            }
        }

        // Allows for the overlap still ahead (see `_pendingOverlap`): trimming to
        // the bare cap now and then dropping the duplicates would leave the cap
        // minus the overlap.
        this._trim(this.getMaxHistory());
        return restored;
    }

    /**
     * Restore this tab now if its own restore found the store unreadable.
     *
     * Called from the extender when the persistence layer reports a read has
     * succeeded, wherever that read came from — so a tab mounted during an
     * outage is not left empty for the session. Nothing retries on a timer.
     * Goes through {@link ChatTabHandler#restore}, so the live/buffer dedupe
     * and the deletion tombstone apply unchanged, and clears the flag first so
     * one recovery restores a tab once.
     */
    refillIfNeeded() {
        if (!this.needsRefill || !this.tabKey || !this.bufferEl.isConnected) return;
        // A container that has since become another tab restores that tab
        // itself, from `_resolveTabKey`; this key would be the old one.
        const current = chatTabKey(this.container);
        if (current && current !== this.tabKey) return;
        this.needsRefill = false;
        this.restore(this.tabKey).catch((error) => {
            console.error('[ChatHistoryExtender] Refill failed:', error);
        });
    }

    /**
     * Stored lines a restore put in the buffer that the game's backlog has not
     * yet rendered, and will duplicate when it does.
     *
     * The saved record holds the cap plus the lines that were live; a restore
     * before the backlog renders holds all of them, and
     * {@link ChatTabHandler#_dropBufferedDuplicates} then removes the live
     * suffix. The buffer may carry that many lines past the cap until it has.
     * Shrinks as live lines appear; zero once the pane shows as many as the
     * saved allowance.
     * @returns {number}
     */
    _pendingOverlap() {
        return Math.max(0, this._restoredAllowance - this._liveMessageNodes().length);
    }

    /**
     * Trim the buffer to `maxHistory` messages, oldest first, plus any lines
     * still waiting to be matched against the game's backlog.
     * @param {number} maxHistory
     */
    _trim(maxHistory) {
        const nodes = this._messageNodes();
        const limit = maxHistory + this._pendingOverlap();
        while (nodes.length > limit) {
            const oldNode = nodes.shift();
            oldNode.querySelectorAll('[data-mwi-uid]').forEach((u) => {
                this.interactionCache.delete(u.getAttribute('data-mwi-uid'));
            });
            if (oldNode.hasAttribute('data-mwi-uid')) {
                this.interactionCache.delete(oldNode.getAttribute('data-mwi-uid'));
            }
            oldNode.remove();
        }
    }

    /**
     * Hydrate a live message node by caching its React event handlers before the game removes it.
     * @param {Element} messageNode
     */
    hydrateMessage(messageNode) {
        if (messageNode.dataset.mwiHydrated) return;

        const eventsOfInterest = [
            'onClick',
            'onContextMenu',
            'onDoubleClick',
            'onMouseEnter',
            'onMouseLeave',
            'onMouseOver',
            'onMouseOut',
            'onMouseDown',
            'onMouseUp',
        ];

        // A rank badge has no fiber, and the walk only stops early once every element it was given is found
        const elements = [messageNode, ...messageNode.querySelectorAll('*')].filter(
            (el) => !el.closest(RANK_BADGE_SELECTOR)
        );
        const propsByNode = getReactPropsForNodes(elements);

        elements.forEach((el) => {
            const props = propsByNode.get(el);
            if (!props) return;

            const handlers = {};
            let hasHandler = false;

            eventsOfInterest.forEach((evtName) => {
                if (typeof props[evtName] === 'function') {
                    handlers[evtName] = props[evtName];
                    hasHandler = true;
                }
            });

            if (typeof props.goToMarketplaceHandler === 'function') {
                handlers.onClick = (e) => props.goToMarketplaceHandler(e, true);
                hasHandler = true;
            }

            if (hasHandler) {
                const uid = Date.now().toString(36) + Math.random().toString(36).substring(2);
                el.setAttribute('data-mwi-uid', uid);
                el.classList.add('mwi-interactive');
                this.interactionCache.set(uid, handlers);
            }
        });

        messageNode.dataset.mwiHydrated = 'true';
    }

    /**
     * Stamp a newly-added message node with the game's own id, when it can be
     * known — see {@link PendingMessageIds} and {@link channelFromTabKey}.
     *
     * A message that arrived already deleted (a moderator's view of a
     * channel's backlog, say) is stamped `data-mwi-skip-store` instead of an
     * id: nothing will ever need to find it by id, and `_onMutation`'s
     * eviction handler reads that flag to keep it out of both storage and
     * this script's own live buffer when it is eventually evicted or removed
     * — the same flag `ChatHistoryExtender#_handleMessageUpdated` stamps
     * onto a node that was live when a deletion arrived for it.
     *
     * @param {Element} node - A newly-added `ChatMessage_chatMessage` node
     * @param {string|null} tabKey - This container's tab key, from {@link chatTabKey}
     */
    _tagMessageId(node, tabKey) {
        if (!this.messageIds) return;
        if (node.dataset.mwiMsgId || node.dataset.mwiSkipStore) return;

        const chan = channelFromTabKey(tabKey);
        if (!chan) return;

        const claimed = this.messageIds.claim(chan, node);
        if (!claimed) return;

        // Either the pending entry itself was marked deleted (the normal
        // path — see PendingMessageIds#markDeleted) or, failing that, the
        // deletion tombstone already knows this id: a `chat_message_updated`
        // deletion that arrived before this node ever rendered adds to both,
        // but the tombstone is the one that also catches an id this build
        // never queued content for in the first place (e.g. a moderator
        // deleting a message in a channel no active handler correlated at
        // all). Checking it here, not just relying on markDeleted having
        // run, is what keeps a node from being tagged with a bare id instead
        // of skip-store if it somehow raced ahead of that.
        // The id is kept even on a skip-store node, so a moderator's later undelete can
        // still find the node and clear the flag
        node.dataset.mwiMsgId = String(claimed.id);
        if (claimed.isDeleted || this.deletedIds?.has(claimed.id)) {
            node.dataset.mwiSkipStore = '1';
        }
    }

    /**
     * Remove every buffered node carrying a given message id — a deletion
     * arriving for a message this tab already evicted into its buffer, or
     * restored from storage into it. A still-*live* node (not yet evicted) is
     * a separate case, handled by {@link ChatHistoryExtender#_handleMessageUpdated}
     * directly, because it is not this handler's to remove: it is still owned
     * by the game's own React tree.
     *
     * @param {string|number} id
     * @returns {number} How many nodes were removed
     */
    purgeMessageById(id) {
        if (id == null) return 0;
        const key = String(id);
        let removed = 0;
        for (const node of [...this.bufferEl.querySelectorAll('[data-mwi-msg-id]')]) {
            if (node.dataset.mwiMsgId !== key) continue;
            node.querySelectorAll('[data-mwi-uid]').forEach((u) => {
                this.interactionCache.delete(u.getAttribute('data-mwi-uid'));
            });
            if (node.hasAttribute('data-mwi-uid')) {
                this.interactionCache.delete(node.getAttribute('data-mwi-uid'));
            }
            node.remove();
            removed += 1;
        }
        return removed;
    }

    /**
     * The still-live (not yet evicted) node carrying a given message id, if
     * any is currently rendered by this tab.
     * @param {string} key - `String(id)`
     * @returns {Element|null}
     */
    findLiveMessageNode(key) {
        for (const node of this.container.querySelectorAll('[data-mwi-msg-id]')) {
            if (node.dataset.mwiMsgId === key && !this.bufferEl.contains(node)) return node;
        }
        return null;
    }

    /**
     * Re-emit a React synthetic event for history buffer interactions.
     * @param {Event} e
     */
    _handleEmulatedEvent(e) {
        const targetEl = e.target.closest('[data-mwi-uid]');
        if (!targetEl) return;

        const uid = targetEl.getAttribute('data-mwi-uid');
        const handlers = this.interactionCache.get(uid);
        if (!handlers) return;

        const eventMap = {
            click: 'onClick',
            contextmenu: 'onContextMenu',
            dblclick: 'onDoubleClick',
            mousedown: 'onMouseDown',
            mouseup: 'onMouseUp',
            mouseover: 'onMouseOver',
            mouseout: 'onMouseOut',
        };

        let reactEventName = eventMap[e.type];

        if (e.type === 'mouseover') {
            reactEventName = handlers.onMouseEnter ? 'onMouseEnter' : 'onMouseOver';
        }
        if (e.type === 'mouseout') {
            reactEventName = handlers.onMouseLeave ? 'onMouseLeave' : 'onMouseOut';
        }

        const handler = handlers[reactEventName];
        if (typeof handler !== 'function') return;

        const fakeEvent = {
            ...e,
            nativeEvent: e,
            target: e.target,
            currentTarget: targetEl,
            preventDefault: () => e.preventDefault(),
            stopPropagation: () => e.stopPropagation(),
            persist: () => {},
            isDefaultPrevented: () => e.defaultPrevented,
            isPropagationStopped: () => e.cancelBubble,
            type: e.type,
        };

        if (e.clientX !== undefined) {
            fakeEvent.clientX = e.clientX;
            fakeEvent.clientY = e.clientY;
        }

        try {
            handler(fakeEvent);
        } catch (err) {
            console.error('[ChatHistoryExtender] Handler failed:', err);
        }
    }

    /**
     * Handle mutations on the chat container.
     * @param {MutationRecord[]} mutations
     */
    _onMutation(mutations) {
        const isAtBottom = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 50;
        const maxHistory = this.getMaxHistory();
        // Once per batch, before anything is buffered or recorded: a tab switch
        // arrives as a batch of mutations, and a message must never be filed
        // under, or rendered beside, the tab that was open a moment ago.
        const previousKey = this.tabKey;
        const tabKey = this._resolveTabKey();
        // A switch tears the outgoing tab's messages out of the pane, and those
        // removals look exactly like evictions. They are not: the buffer has
        // just been emptied for the incoming tab, and treating them as
        // evictions would clone the outgoing tab's lines — whispers among them
        // — straight back onto the incoming tab's scrollback and into its
        // record under the incoming tab's key.
        const switched = Boolean(previousKey) && Boolean(tabKey) && tabKey !== previousKey;
        const renderedLive = new Set();
        // Before anything is recorded: the observer delivers a batch after the
        // DOM has changed, so the pane already holds the batch's new lines, and
        // each one reaches the record's cap before the end of the loop. With
        // last batch's count the cap would drop an oldest entry per new line.
        // A switch batch can leave the outgoing tab's lines in the pane, so its
        // count may only raise the incoming tab's saved allowance, never lower
        // it. Without the raise, a tab reopened with a larger backlog than it
        // was saved with records every new line against the old, smaller
        // allowance, and each one evicts an oldest entry.
        if (tabKey) {
            const count = this._liveMessageNodes().length;
            const saved = chatHistoryPersistence.liveCountFor(tabKey);
            if (!switched || saved === null || count > saved) chatHistoryPersistence.setLiveCount(tabKey, count);
        }

        mutations.forEach((mut) => {
            mut.addedNodes.forEach((node) => {
                if (node.nodeType === 1 && node.className?.includes('ChatMessage_chatMessage')) {
                    this.hydrateMessage(node);
                    this._tagMessageId(node, tabKey);
                    const identity = this._recordLive(node, tabKey);
                    if (identity) renderedLive.add(identity);
                }
            });

            // The buffer element itself still has to be kept in place below,
            // so this skips the evictions rather than the whole batch.
            if (!switched) {
                mut.removedNodes.forEach((node) => {
                    if (
                        node.nodeType === 1 &&
                        node.className?.includes('ChatMessage_chatMessage') &&
                        node !== this.bufferEl
                    ) {
                        // A deleted message reaching removedNodes at all is the
                        // ordinary case for everyone but the author (who the
                        // game keeps showing "[Message Deleted…] <text>" in
                        // place — no removal, so no eviction, nothing for this
                        // branch to do). Cloning it into the live buffer would
                        // put the deleted content right back in front of a
                        // viewer the game just hid it from — the `mwiSkipStore`
                        // check below only ever stopped it reaching *disk*.
                        //
                        // Checked two ways: the flag `_handleMessageUpdated`
                        // stamps directly onto a still-live node it can find,
                        // and — for a node removed before that lookup ever ran
                        // (or before `_tagMessageId` had tagged it with an id
                        // to look up) — the deletion tombstone by whatever id
                        // the node does carry. Neither finding it is exactly
                        // the "arrived already deleted" case _tagMessageId
                        // already handles by never assigning an id at all; see
                        // that flag's own doc.
                        const isDeleted =
                            node.dataset.mwiSkipStore === '1' ||
                            (node.dataset.mwiMsgId && this.deletedIds?.has(node.dataset.mwiMsgId));

                        if (!isDeleted) {
                            const clone = node.cloneNode(true);
                            this.bufferEl.appendChild(clone);

                            // Serialized from the clone, before the trim below can take
                            // it away again: the record is capped separately from the
                            // buffer, so a message can leave the screen and stay stored.
                            const html = serializeMessage(clone);
                            if (html && tabKey) chatHistoryPersistence.record(tabKey, html);
                        }

                        this._trim(maxHistory);
                    }
                });
            }

            if (this.container.firstChild !== this.bufferEl) {
                this.container.prepend(this.bufferEl);
            }
        });

        this._dropBufferedDuplicates(renderedLive);
        // The restore's surplus is released once the live suffix is known.
        if (renderedLive.size) this._trim(maxHistory);
        // A tab that just became this container's (a switch, late naming) has
        // had its backlog tagged above; whatever is still queued for it
        // matched nothing and never will.
        if (tabKey && tabKey !== previousKey) this._discardQueuedIds(tabKey);

        if (isAtBottom) {
            this.container.scrollTop = this.container.scrollHeight;
        }
    }

    /**
     * Disconnect the observer and remove the buffer element.
     */
    destroy() {
        this.observer.disconnect();
        this.bufferEl.querySelectorAll('[data-mwi-uid]').forEach((el) => {
            this.interactionCache.delete(el.getAttribute('data-mwi-uid'));
        });
        this.bufferEl.remove();
    }
}

class ChatHistoryExtender {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.timerRegistry = createTimerRegistry();
        this.interactionCache = new Map();
        this.tabHandlers = new WeakMap();
        this.activeHandlers = new Set();
        /** @type {PendingMessageIds|null} */
        this.messageIds = null;
        /** @type {DeletedMessageIds|null} */
        this.deletedIds = null;
        this._onChatMessageReceived = null;
        this._onChatMessageUpdated = null;
        this._onPageLeaving = null;
        this._onVisibilityChange = null;
        /** @type {Function|null} Unsubscribes the pre-teardown flush */
        this._offBeforeTeardown = null;
        /** @type {Function|null} Unsubscribes the successful-read listener */
        this._offLoaded = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('chatHistoryExtender')) return;

        this.isInitialized = true;
        addStyles(CSS, STYLE_ID);

        const getMaxHistory = () => {
            const raw = parseInt(config.getSettingValue('chatHistoryExtender_maxHistory'));
            return isFinite(raw) && raw > 0 ? raw : 150;
        };

        chatHistoryPersistence.enable(getMaxHistory);
        // Any successful read — a tab's restore or a deletion's purge — refills
        // the tabs mounted during an outage.
        this._offLoaded = chatHistoryPersistence.onLoaded(() => {
            for (const handler of [...this.activeHandlers]) handler.refillIfNeeded();
        });

        this.messageIds = new PendingMessageIds();
        this.deletedIds = new DeletedMessageIds();
        this._onChatMessageReceived = (data) => this._handleMessageReceived(data?.message);
        webSocketHook.on('chat_message_received', this._onChatMessageReceived);
        this._onChatMessageUpdated = (data) => this._handleMessageUpdated(data?.message);
        webSocketHook.on('chat_message_updated', this._onChatMessageUpdated);

        // Recording is coalesced for a few seconds; these are the moments that
        // window has to be closed early. A socket closing is how a server
        // restart announces itself, and whatever the reconnect renders may
        // not include what was on screen before it.
        this._onPageLeaving = () => {
            chatHistoryPersistence.flushPending()?.catch?.(() => {});
        };
        this._onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') this._onPageLeaving();
        };
        window.addEventListener('pagehide', this._onPageLeaving);
        window.addEventListener('beforeunload', this._onPageLeaving);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
        webSocketHook.onSocketEvent?.('close', this._onPageLeaving);
        // The `pagehide` listener above runs after the entrypoint's, which has
        // already closed the connection: its write is only queued, and on a
        // page being destroyed it never lands. This runs first. It saves only
        // a record that is loaded — one that still needs its first read merges
        // after an await, past the close, and that tail is lost with the page.
        this._offBeforeTeardown = storage.onBeforeTeardown?.(this._onPageLeaving) ?? null;

        const attachHandler = (containerEl) => {
            if (this.tabHandlers.has(containerEl)) return;
            const handler = new ChatTabHandler(
                containerEl,
                this.interactionCache,
                getMaxHistory,
                chatTabKey(containerEl),
                this.messageIds,
                this.deletedIds
            );
            this.tabHandlers.set(containerEl, handler);
            this.activeHandlers.add(handler);
            // The pane's own count, reported before the scan below records any of
            // it: the first load merges those recordings under the cap, and until
            // this is said the cap only knows the saved allowance. Only a raise,
            // as in a switch batch; an empty pane is a backlog yet to arrive, not
            // a report of none.
            if (handler.tabKey) {
                const count = handler._liveMessageNodes().length;
                const saved = chatHistoryPersistence.liveCountFor(handler.tabKey);
                if (count > 0 && (saved === null || count > saved)) {
                    chatHistoryPersistence.setLiveCount(handler.tabKey, count);
                }
            }
            containerEl.querySelectorAll('[class*="ChatMessage_chatMessage"]').forEach((msg) => {
                handler.hydrateMessage(msg);
                // Tagged before it is recorded, the same order `_onMutation`
                // uses: the id rides inside the stored markup, and a line
                // stored without it is one a later deletion cannot find.
                handler._tagMessageId(msg, handler.tabKey);
                // Already on screen when the handler arrived, so no mutation
                // will ever announce them — recorded here or not at all.
                handler._recordLive(msg, handler.tabKey);
            });
            handler._discardQueuedIds(handler.tabKey);
            // Deliberately not awaited: the read is IndexedDB and chat must be
            // usable before it lands. A failure inside is logged, not thrown.
            handler.restore(handler.tabKey).catch((error) => {
                console.error('[ChatHistoryExtender] Restore failed:', error);
            });
        };

        // Watch for new chat tab containers
        const unregister = domObserver.onClass('ChatHistoryExtender', 'ChatHistory_chatHistory', attachHandler);
        this.unregisterHandlers.push(unregister);

        // @run-at document-start: containers rendered before the shared observer attaches to
        // document.body are invisible to the class watcher, so the catch-up scan waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterHandlers.push(
            domObserver.onReady('ChatHistoryExtenderCatchUp', () => {
                document.querySelectorAll('[class*="ChatHistory_chatHistory"]').forEach(attachHandler);
            })
        );

        // Periodic cache cleanup to prevent unbounded memory growth
        const cleanupInterval = setInterval(() => {
            // Destroy handlers whose container left the DOM (also drops their cached uids)
            for (const handler of this.activeHandlers) {
                if (!document.contains(handler.container)) {
                    handler.destroy();
                    this.activeHandlers.delete(handler);
                    this.tabHandlers.delete(handler.container);
                }
            }
            // Evict only entries no longer referenced by any live/buffered node — a global
            // clear() would permanently break handlers still wired to rendered clones
            if (this.interactionCache.size > 8000) {
                const liveUids = new Set();
                document.querySelectorAll('[data-mwi-uid]').forEach((el) => {
                    liveUids.add(el.getAttribute('data-mwi-uid'));
                });
                for (const uid of this.interactionCache.keys()) {
                    if (!liveUids.has(uid)) {
                        this.interactionCache.delete(uid);
                    }
                }
            }
        }, 600000);
        this.timerRegistry.registerInterval(cleanupInterval);
    }

    /**
     * Handle `chat_message_received`: queue the id for {@link ChatTabHandler#_tagMessageId}
     * to claim once the DOM node it belongs to is actually rendered. See
     * {@link PendingMessageIds}.
     * @param {{id?: string|number, chan?: string, isDeleted?: boolean, sName?: string, m?: string, linksMetadata?: string}|null} message
     */
    _handleMessageReceived(message) {
        if (!message || message.id == null || !message.chan || !this.messageIds) return;
        this.messageIds.note(
            message.chan,
            message.id,
            !!message.isDeleted,
            message.sName,
            message.m,
            message.linksMetadata
        );
    }

    /**
     * Handle `chat_message_updated` — a deletion or undelete of a message
     * already seen. See chat-history-persistence.js's "Message identity and
     * deletion" section for the shape of the whole mechanism.
     * @param {{id?: string|number, chan?: string, isDeleted?: boolean}|null} message
     */
    async _handleMessageUpdated(message) {
        if (!message || message.id == null) return;
        const key = String(message.id);

        if (!message.isDeleted) {
            // Undelete: a moderator-only action (players cannot undo their own
            // delete) and nothing here needs restoring — a message already
            // purged from storage/buffer is gone for good, see
            // chat-history-persistence.js. What is left to correct is a
            // still-live, not-yet-evicted node that a prior delete flagged
            // `mwiSkipStore`: it should be storable (and bufferable) again
            // once it is evicted — which also means clearing this id out of
            // the deletion tombstone, or the eviction handler's tombstone
            // check would keep treating it as deleted regardless.
            this.deletedIds?.remove(message.id);
            this.messageIds?.markUndeleted(message.id);
            for (const handler of this.activeHandlers) {
                const live = handler.findLiveMessageNode(key);
                if (live) delete live.dataset.mwiSkipStore;
            }
            return;
        }

        // First, and synchronously (before any await below): a restore whose
        // `chatHistoryPersistence.load()` is already in flight reads this
        // tombstone once that await resolves, and needs to see this id
        // whether its own load() settles before or after this handler's own
        // awaits do — see DeletedMessageIds' class doc. Marking the pending
        // entry deleted too covers the id before it has even rendered a node
        // — see PendingMessageIds#markDeleted.
        this.deletedIds?.add(message.id);
        this.messageIds?.markDeleted(message.id);

        for (const handler of this.activeHandlers) {
            const live = handler.findLiveMessageNode(key);
            if (live) live.dataset.mwiSkipStore = '1';
            handler.purgeMessageById(message.id);
        }

        if (message.chan) {
            try {
                await chatHistoryPersistence.purgeMessageById(tabKeyForChannel(message.chan), message.id);
            } catch (error) {
                console.error('[ChatHistoryExtender] Could not purge a deleted message from storage:', error);
            }
        }
    }

    /**
     * Tear the feature down, and answer with the final write of what it
     * recorded.
     *
     * The teardown itself stays synchronous — handlers, listeners and the
     * persistence state are gone when this returns, so nothing can record
     * into a session that is ending and a caller may `initialize()` on the
     * next line. The final write cannot be, and it does not need to be for
     * correctness: `chatHistoryPersistence.flushForTeardown()` holds every
     * later read of the record (the next session's `load()`, a merge-and-write)
     * until it has landed, so a quick re-init for the same character cannot
     * read the record from before it. The feature registry awaits the promise
     * returned here on every disable path as well.
     *
     * @returns {Promise<boolean>} Whether the final write was accepted
     */
    disable() {
        let finalFlush = Promise.resolve(false);
        try {
            if (this._offLoaded) {
                this._offLoaded();
                this._offLoaded = null;
            }
            // First: storage outlives this feature, and a throw further down
            // would leave it calling into a torn-down session on page close.
            if (this._offBeforeTeardown) {
                this._offBeforeTeardown();
                this._offBeforeTeardown = null;
            }
            // Land what the session recorded before the state goes; a disable
            // is not a wipe, and the record on disk is left where it is.
            // Immediate, not through storage's own write debounce: a read
            // cannot see a write still queued there, and the next session's
            // first write would replace it — taking these lines with it.
            finalFlush = chatHistoryPersistence.flushForTeardown();
            chatHistoryPersistence.reset();
            for (const handler of this.activeHandlers) {
                handler.destroy();
            }
            this.activeHandlers.clear();
            this.tabHandlers = new WeakMap();
            this.unregisterHandlers.forEach((unregister) => unregister());
            this.unregisterHandlers = [];
            this.timerRegistry.clearAll();
            this.interactionCache.clear();
            if (this._onChatMessageReceived) {
                webSocketHook.off('chat_message_received', this._onChatMessageReceived);
                this._onChatMessageReceived = null;
            }
            if (this._onChatMessageUpdated) {
                webSocketHook.off('chat_message_updated', this._onChatMessageUpdated);
                this._onChatMessageUpdated = null;
            }
            if (this._onPageLeaving) {
                window.removeEventListener('pagehide', this._onPageLeaving);
                window.removeEventListener('beforeunload', this._onPageLeaving);
                webSocketHook.offSocketEvent?.('close', this._onPageLeaving);
                this._onPageLeaving = null;
            }
            if (this._onVisibilityChange) {
                document.removeEventListener('visibilitychange', this._onVisibilityChange);
                this._onVisibilityChange = null;
            }
            this.messageIds?.clear();
            this.messageIds = null;
            this.deletedIds?.clear();
            this.deletedIds = null;
            removeStyles(STYLE_ID);
            this.isInitialized = false;
        } catch (error) {
            console.error('[Chat History Extender] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
        return finalFlush;
    }
}

const chatHistoryExtender = new ChatHistoryExtender();
export default chatHistoryExtender;
