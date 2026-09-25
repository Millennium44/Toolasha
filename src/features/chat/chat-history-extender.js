/**
 * Chat History Extender
 * Preserves chat messages that the game evicts from the live buffer,
 * keeping them visible in a history section above the live messages.
 * Based on the original script by SilkyPanda.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import chatHistoryPersistence, {
    extractStoredMessageId,
    handleRestoredClick,
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
 * @param {Element} node - A `ChatMessage_chatMessage` node
 * @returns {{sender: string, body: string}|null} Null when the node carries
 *   no sender element at all (a system message) or the extraction otherwise
 *   fails — both correctly mean "cannot be matched", not "matches anything".
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

    const fullText = node.textContent || '';
    const idx = fullText.indexOf(sender);
    if (idx === -1) return null;

    const body = fullText
        .slice(idx + sender.length)
        .replace(/^[:\s]+/, '')
        .trim();
    return { sender, body };
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
 * be a guess, and an untagged node is always the safe outcome.
 */
class PendingMessageIds {
    constructor() {
        /** @type {Map<string, Array<{id: string|number, isDeleted: boolean, sName: string, m: string, ts: number}>>} */
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
     * @param {string} [m] - Message text, as `chat_message_received` carries it
     */
    note(chan, id, isDeleted, sName, m) {
        if (!chan || id == null) return;
        let queue = this.byChannel.get(chan);
        if (!queue) {
            queue = [];
            this.byChannel.set(chan, queue);
        }
        queue.push({ id, isDeleted: !!isDeleted, sName: sName || '', m: m || '', ts: Date.now() });
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
            matches.push(i);
        }
        // Zero: nothing describes this node. More than one: two queued
        // messages this node's content cannot be told apart from — tagging
        // either would be a guess about which is which.
        if (matches.length !== 1) return null;

        return queue.splice(matches[0], 1)[0];
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
        /** Whether a restore has already been fired for this tab; see {@link _resolveTabKey}. */
        this.restoreStarted = false;

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
     * Empty the buffer of rendered messages, keeping the restore anchor.
     *
     * Used when the container stops being the tab it was: what it is showing
     * belongs to the tab that was open before, and leaving it on screen is the
     * whole reported symptom — a private conversation in a public tab's
     * scrollback. Nothing on disk is touched; both tabs' records are intact and
     * the new tab's is restored straight after.
     */
    _clearBuffer() {
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

        // A tab becoming this container's key for the first time (attach,
        // late naming, or a switch) is about to render that channel's whole
        // visible backlog as one mutation batch — see PendingMessageIds'
        // class doc for why a queue built up before this moment cannot be
        // trusted against it.
        if (key) {
            const chan = channelFromTabKey(key);
            if (chan) this.messageIds?.discardChannel(chan);
        }

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

        let stored;
        try {
            stored = (await chatHistoryPersistence.load())[tabKey];
        } catch (error) {
            console.error('[ChatHistoryExtender] Could not load stored history:', error);
            return 0;
        }
        if (!Array.isArray(stored) || !stored.length) return 0;
        // The container may have been torn down while the read was in flight
        if (!this.bufferEl.isConnected) return 0;

        let restored = 0;
        for (const html of stored) {
            try {
                // A deletion that arrived while the `load()` above was still
                // in flight has already purged `chatHistoryPersistence.tabs`
                // — a different in-memory object than the snapshot `stored`
                // was read from, and untouched by that purge (see
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

        this._trim(this.getMaxHistory());
        return restored;
    }

    /**
     * Trim the buffer to `maxHistory` messages, oldest first.
     * @param {number} maxHistory
     */
    _trim(maxHistory) {
        const nodes = this._messageNodes();
        while (nodes.length > maxHistory) {
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

        const elements = [messageNode, ...messageNode.querySelectorAll('*')];
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

        if (claimed.isDeleted) {
            node.dataset.mwiSkipStore = '1';
        } else {
            node.dataset.mwiMsgId = String(claimed.id);
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

        mutations.forEach((mut) => {
            mut.addedNodes.forEach((node) => {
                if (node.nodeType === 1 && node.className?.includes('ChatMessage_chatMessage')) {
                    this.hydrateMessage(node);
                    this._tagMessageId(node, tabKey);
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

        this.messageIds = new PendingMessageIds();
        this.deletedIds = new DeletedMessageIds();
        this._onChatMessageReceived = (data) => this._handleMessageReceived(data?.message);
        webSocketHook.on('chat_message_received', this._onChatMessageReceived);
        this._onChatMessageUpdated = (data) => this._handleMessageUpdated(data?.message);
        webSocketHook.on('chat_message_updated', this._onChatMessageUpdated);

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
            containerEl.querySelectorAll('[class*="ChatMessage_chatMessage"]').forEach((msg) => {
                handler.hydrateMessage(msg);
            });
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
     * @param {{id?: string|number, chan?: string, isDeleted?: boolean, sName?: string, m?: string}|null} message
     */
    _handleMessageReceived(message) {
        if (!message || message.id == null || !message.chan || !this.messageIds) return;
        this.messageIds.note(message.chan, message.id, !!message.isDeleted, message.sName, message.m);
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
        // awaits do — see DeletedMessageIds' class doc.
        this.deletedIds?.add(message.id);

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

    disable() {
        try {
            // Land what the session recorded before the state goes; a disable
            // is not a wipe, and the record on disk is left where it is.
            chatHistoryPersistence.flush()?.catch?.(() => {});
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
    }
}

const chatHistoryExtender = new ChatHistoryExtender();
export default chatHistoryExtender;
