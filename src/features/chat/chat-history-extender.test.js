/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { settingValues } = vi.hoisted(() => ({
    settingValues: { chatHistoryExtender: true, chatHistoryExtender_maxHistory: null },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn((key) => settingValues[key] ?? true),
        getSettingValue: vi.fn((key) => settingValues[key]),
    },
}));

const observerReady = vi.hoisted(() => ({ handlers: [], domReady: true }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn(() => () => {}),
        // Mirrors the real DOMObserver.onReady: immediate when already attached (the default),
        // deferred until the readiness-gap test fires it by hand otherwise.
        onReady: vi.fn((name, callback) => {
            const handler = { name, callback };
            observerReady.handlers.push(handler);
            if (observerReady.domReady) callback();
            return () => {
                observerReady.handlers = observerReady.handlers.filter((h) => h !== handler);
            };
        }),
    },
}));

const wsHandlers = vi.hoisted(() => ({}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (wsHandlers[event] === handler) delete wsHandlers[event];
        },
    },
}));

// Only reached once a test gives a container a real tab strip (a `ch:`-keyed
// tab), so id correlation and deletion can go all the way through
// chat-history-persistence.js's storage calls — none of the fiber/hydration
// tests above touch this.
const db = vi.hoisted(() => ({ settings: {} }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async (key, store, fallback = null) => {
            const bucket = db[store] || {};
            return Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : fallback;
        }),
        set: vi.fn(async (key, value, store) => {
            db[store] = db[store] || {};
            db[store][key] = JSON.parse(JSON.stringify(value));
            return true;
        }),
        isQuotaExceeded: vi.fn(() => false),
    },
}));
vi.mock('../../utils/character-key.js', () => ({ characterKey: (base) => `${base}_char1` }));
vi.mock('../../core/data-manager.js', () => ({ default: { getItemDetails: vi.fn(() => null) } }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: vi.fn() }));
vi.mock('../../utils/profile-command.js', () => ({
    openPlayerProfile: vi.fn(),
    fillProfileCommand: vi.fn(),
    findChatInput: vi.fn(() => null),
    getGameCore: vi.fn(() => null),
    VALID_PLAYER_NAME_RE: /^[A-Za-z0-9_]+$/,
}));

import chatHistoryExtender, { tabKeyForChannel } from './chat-history-extender.js';
import chatHistoryPersistence, { CHAT_HISTORY_KEY_BASE } from './chat-history-persistence.js';

const STORAGE_KEY = `${CHAT_HISTORY_KEY_BASE}_char1`;

/**
 * Build a minimal fiber tree and wire it under `#root._reactRootContainer`
 * the way the post-February-2026 game does: no `__reactProps$…`/`__reactFiber$…`
 * expando keys on the DOM nodes themselves, only the root container fiber.
 * @param {Array<{stateNode: Element, props?: object, children?: Array}>} tree
 */
function installFiberTree(rootDescription) {
    function build(desc) {
        const fiber = { stateNode: desc.stateNode, memoizedProps: desc.props || null, child: null, sibling: null };
        const children = desc.children || [];
        let prevSibling = null;
        for (const childDesc of children) {
            const childFiber = build(childDesc);
            if (!fiber.child) fiber.child = childFiber;
            if (prevSibling) prevSibling.sibling = childFiber;
            prevSibling = childFiber;
        }
        return fiber;
    }
    const rootFiber = build(rootDescription);
    const rootEl = document.getElementById('root') || document.body;
    rootEl._reactRootContainer = { current: rootFiber };
    return rootFiber;
}

function buildChatContainer() {
    document.body.innerHTML = `<div id="root"></div>`;
    const container = document.createElement('div');
    container.className = 'ChatHistory_chatHistory__abc';
    document.getElementById('root').appendChild(container);
    return container;
}

describe('chat-history-extender', () => {
    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        observerReady.handlers = [];
        observerReady.domReady = true;
    });

    afterEach(() => {
        chatHistoryExtender.disable();
        document.body.innerHTML = '';
    });

    test('reads click handlers via the fiber tree, not a __reactProps$ expando key', () => {
        const container = buildChatContainer();
        const message = document.createElement('div');
        message.className = 'ChatMessage_chatMessage__xyz';
        const link = document.createElement('span');
        link.textContent = 'a marketplace listing';
        message.appendChild(link);
        container.appendChild(message);

        const onClick = vi.fn();
        // Deliberately no __reactProps$/__reactFiber$ keys anywhere on these
        // nodes — that access pattern was removed by the game in Feb 2026.
        installFiberTree({
            stateNode: document.getElementById('root'),
            children: [
                {
                    stateNode: container,
                    children: [{ stateNode: message, children: [{ stateNode: link, props: { onClick } }] }],
                },
            ],
        });

        chatHistoryExtender.initialize();

        // Hydration marks the element as interactive whenever the fiber walk
        // found a handler for it — proof the lookup no longer depends on the
        // removed __reactProps$ expando key. (The live element still gets its
        // clicks from React's own delegation, not this plumbing; the emulated
        // click path is exercised once the node is evicted into the history
        // buffer, in the test below.)
        expect(link.hasAttribute('data-mwi-uid')).toBe(true);
        expect(link.classList.contains('mwi-interactive')).toBe(true);
        expect(onClick).not.toHaveBeenCalled();
    });

    test('a container mounted before the shared observer is ready is hydrated at readiness', () => {
        observerReady.domReady = false;
        const container = buildChatContainer();
        const message = document.createElement('div');
        message.className = 'ChatMessage_chatMessage__xyz';
        const link = document.createElement('span');
        message.appendChild(link);
        container.appendChild(message);

        installFiberTree({
            stateNode: document.getElementById('root'),
            children: [
                {
                    stateNode: container,
                    children: [{ stateNode: message, children: [{ stateNode: link, props: { onClick: vi.fn() } }] }],
                },
            ],
        });

        chatHistoryExtender.initialize();
        expect(link.hasAttribute('data-mwi-uid')).toBe(false);

        observerReady.handlers.forEach((h) => h.callback());
        expect(link.hasAttribute('data-mwi-uid')).toBe(true);
    });

    test('a message with no fiber-backed handlers is left un-hydrated rather than throwing', () => {
        const container = buildChatContainer();
        const message = document.createElement('div');
        message.className = 'ChatMessage_chatMessage__xyz';
        message.textContent = 'plain system message';
        container.appendChild(message);

        // No fiber tree installed at all (e.g. root not yet mounted) — the
        // lookup must degrade to "no props found", not throw.
        expect(() => chatHistoryExtender.initialize()).not.toThrow();
        expect(message.hasAttribute('data-mwi-uid')).toBe(false);
    });

    test('preserved history clone still dispatches the original React handler after the live node is removed', async () => {
        const container = buildChatContainer();
        const message = document.createElement('div');
        message.className = 'ChatMessage_chatMessage__xyz';
        const link = document.createElement('span');
        message.appendChild(link);
        container.appendChild(message);

        const onClick = vi.fn();
        installFiberTree({
            stateNode: document.getElementById('root'),
            children: [
                {
                    stateNode: container,
                    children: [{ stateNode: message, children: [{ stateNode: link, props: { onClick } }] }],
                },
            ],
        });

        chatHistoryExtender.initialize();
        expect(link.hasAttribute('data-mwi-uid')).toBe(true);

        // The game evicts the live message from its own buffer.
        container.removeChild(message);
        // MutationObserver callbacks land in a microtask.
        await Promise.resolve();
        await Promise.resolve();

        const buffer = container.querySelector('.mwi-history-buffer');
        const clonedLink = buffer.querySelector('[data-mwi-uid]');
        expect(clonedLink).not.toBeNull();

        clonedLink.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});

/**
 * A September 2026 patch lets a player delete their own Trade/Recruit
 * messages, on top of the moderator deletion that already existed. It
 * arrives as `chat_message_updated`, carrying `{ id, chan, isDeleted }`.
 * These tests exercise the id correlation (`chat_message_received` →
 * `data-mwi-msg-id`) and the deletion/undeletion handling built on it — see
 * the "Message identity and deletion" section at the top of
 * chat-history-persistence.js.
 */
describe('chat-history-extender: message identity and deletion', () => {
    /** A live chat pane with a real tab strip — a `ch:`-keyed tab, unlike {@link buildChatContainer}. */
    function buildChannelChat(channel) {
        document.body.innerHTML = '<div id="root"><div class="Chat_tabsComponentContainer__x"></div></div>';
        const strip = document.querySelector('.Chat_tabsComponentContainer__x');
        const button = document.createElement('button');
        button.setAttribute('role', 'tab');
        button.setAttribute('data-mention-channel', channel);
        button.setAttribute('aria-selected', 'true');
        button.textContent = channel.split('/').pop();
        strip.appendChild(button);

        const container = document.createElement('div');
        container.className = 'ChatHistory_chatHistory__abc';
        document.getElementById('root').appendChild(container);
        return container;
    }

    /**
     * The game's real chat-line markup (mirrors chat-history-persistence.test.js's
     * `senderHTML`): a sender element the id correlator can find and read via
     * `senderNameFrom`, not just a flat text blob — the exact-match matcher
     * needs a real sender element to extract from.
     * @param {string} sender
     * @param {string} text
     */
    function makeMessage(sender, text) {
        const el = document.createElement('div');
        el.className = 'ChatMessage_chatMessage__xyz';
        el.innerHTML =
            '<span>[12:00:00 PM] </span>' +
            '<span class="ChatMessage_name__1UZ8t ChatMessage_clickable__3Nt2s">' +
            '<div class="CharacterName_characterName__2FqyZ">' +
            `<div class="CharacterName_name__1amXp"><span>${sender}</span></div></div></span>` +
            `<span>: ${text}</span>`;
        return el;
    }

    /**
     * A Trade/Recruit line naming an item, the way the game actually renders
     * one: prose, then an inline `Item_itemContainer` icon+label element (the
     * same class chat-history-persistence.test.js's `makeItemMessage` uses) —
     * never prose alone, which is all `chat_message_received`'s own `m` field
     * carries for such a line (see pop-out-chat.js's `resolveMessage`, which
     * keeps `m` and `renderedLinks` separate for the same reason).
     * @param {string} sender
     * @param {string} prose
     * @param {number} [itemLinks] - How many item-link elements to render
     */
    function makeLinkedMessage(sender, prose, itemLinks = 1) {
        const el = document.createElement('div');
        el.className = 'ChatMessage_chatMessage__xyz';
        const links = Array.from(
            { length: itemLinks },
            () =>
                '<div class="Item_itemContainer__1">' +
                '<svg><use href="/static/media/items_sprite.svg#cheese"></use></svg>' +
                '<span>[Cheese @ 12.3K Sell]</span></div>'
        ).join('');
        el.innerHTML =
            '<span>[12:00:00 PM] </span>' +
            '<span class="ChatMessage_name__1UZ8t ChatMessage_clickable__3Nt2s">' +
            '<div class="CharacterName_characterName__2FqyZ">' +
            `<div class="CharacterName_name__1amXp"><span>${sender}</span></div></div></span>` +
            `<span>: ${prose} </span>` +
            links;
        return el;
    }

    /**
     * `linksMetadata`, shaped the way `resolveLink()` in pop-out-chat.js
     * reads it — the one place in this codebase that already names these
     * fields for a real message — for one `/chat_link_types/market_listing`
     * entry.
     * @returns {string}
     */
    function marketListingLinksMetadata() {
        return JSON.stringify([
            {
                linkType: '/chat_link_types/market_listing',
                itemHrid: '/items/cheese',
                itemEnhancementLevel: 0,
                itemCount: 3,
                price: 12345,
                isSell: true,
            },
        ]);
    }

    async function evict(container, node) {
        container.removeChild(node);
        await Promise.resolve();
        await Promise.resolve();
    }

    /** Let a mutation batch (and any hydrate/tag work it queues) land. */
    async function settle() {
        for (let i = 0; i < 4; i += 1) await Promise.resolve();
    }

    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        observerReady.handlers = [];
        observerReady.domReady = true;
        db.settings = {};
    });

    afterEach(() => {
        chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    test('registers and unregisters chat_message_received/chat_message_updated with the feature lifecycle', () => {
        expect(wsHandlers.chat_message_received).toBeUndefined();
        expect(wsHandlers.chat_message_updated).toBeUndefined();

        chatHistoryExtender.initialize();
        expect(wsHandlers.chat_message_received).toBeTypeOf('function');
        expect(wsHandlers.chat_message_updated).toBeTypeOf('function');

        chatHistoryExtender.disable();
        expect(wsHandlers.chat_message_received).toBeUndefined();
        expect(wsHandlers.chat_message_updated).toBeUndefined();
    });

    test('a live message is tagged with the id its chat_message_received carried', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', sName: 'Alice', m: 'selling cheese' },
        });
        const node = makeMessage('Alice', 'selling cheese');
        container.appendChild(node);
        await settle();

        expect(node.dataset.mwiMsgId).toBe('msg-1');
    });

    test('a queued id is only claimed by a node whose content actually matches it', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        // Queued for the channel, but nothing renders while the tab stays open
        // showing something else — simulated here simply by never appending a
        // node for it before a second, unrelated node arrives.
        wsHandlers.chat_message_received({
            message: {
                id: 'msg-mismatch',
                chan: '/chat_channel_types/trade',
                sName: 'Bob',
                m: 'a totally different message',
            },
        });
        const node = makeMessage('Alice', 'selling cheese');
        container.appendChild(node);
        await settle();

        // The queued entry's content does not appear in this node's text, so
        // it is left untagged rather than wrongly claiming msg-mismatch's id —
        // an untagged node can never be purged by a later deletion for an id
        // it was never actually the message for.
        expect(node.dataset.mwiMsgId).toBeUndefined();
    });

    test('near-miss content (overlapping sender/text prefixes) is never claimed — exact match only', async () => {
        // Codex's exact scenario: an earlier `Bob: hi` entry is a *substring*
        // of a later `Bob: hi there` node, and `Ann` is a substring of
        // `Anna` — the old `.includes()` matcher would wrongly claim across
        // either. Exact equality on both fields must reject both.
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: { id: 'msg-bob-hi', chan: '/chat_channel_types/trade', sName: 'Bob', m: 'hi' },
        });
        const longerText = makeMessage('Bob', 'hi there');
        container.appendChild(longerText);
        await settle();
        expect(longerText.dataset.mwiMsgId).toBeUndefined();

        wsHandlers.chat_message_received({
            message: { id: 'msg-ann', chan: '/chat_channel_types/trade', sName: 'Ann', m: 'hello' },
        });
        const longerName = makeMessage('Anna', 'hello');
        container.appendChild(longerName);
        await settle();
        expect(longerName.dataset.mwiMsgId).toBeUndefined();
    });

    test('a Trade post naming an item is still tagged, even though the DOM renders more than m alone', async () => {
        // Codex's exact bug: the queued entry's m is prose-only ("selling"),
        // but the live node also renders the item's icon+label — an exact
        // whole-line comparison rejected every such message, which is most
        // Trade/Recruit traffic. The item element's own text must not count
        // against the match.
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: {
                id: 'msg-1',
                chan: '/chat_channel_types/trade',
                sName: 'Alice',
                m: 'selling',
                linksMetadata: marketListingLinksMetadata(),
            },
        });
        const node = makeLinkedMessage('Alice', 'selling', 1);
        container.appendChild(node);
        await settle();

        expect(node.dataset.mwiMsgId).toBe('msg-1');
    });

    test('an item-link count mismatch is never claimed, even with identical prose', async () => {
        // A candidate naming one item must not be claimed by a node rendering
        // a different number of item links — the structural check the item
        // case still needs, since two different linked messages can easily
        // share the same short prose ("selling").
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: {
                id: 'msg-1',
                chan: '/chat_channel_types/trade',
                sName: 'Alice',
                m: 'selling',
                linksMetadata: marketListingLinksMetadata(),
            },
        });
        const noLinkNode = makeMessage('Alice', 'selling');
        container.appendChild(noLinkNode);
        await settle();

        expect(noLinkNode.dataset.mwiMsgId).toBeUndefined();
    });

    test('a plain-text candidate is never claimed by a node that renders an item link', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', sName: 'Alice', m: 'selling' },
        });
        const linkedNode = makeLinkedMessage('Alice', 'selling', 1);
        container.appendChild(linkedNode);
        await settle();

        expect(linkedNode.dataset.mwiMsgId).toBeUndefined();
    });

    test('a tagged item-link message can still be purged by a later deletion', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: {
                id: 'msg-1',
                chan: '/chat_channel_types/trade',
                sName: 'Alice',
                m: 'selling',
                linksMetadata: marketListingLinksMetadata(),
            },
        });
        const node = makeLinkedMessage('Alice', 'selling', 1);
        container.appendChild(node);
        await settle();
        expect(node.dataset.mwiMsgId).toBe('msg-1');

        await wsHandlers.chat_message_updated({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', isDeleted: true },
        });

        expect(node.dataset.mwiSkipStore).toBe('1');
    });

    test('two queued candidates with identical sender and text are ambiguous — neither is tagged', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: { id: 'msg-dup-1', chan: '/chat_channel_types/trade', sName: 'Alice', m: 'hi' },
        });
        wsHandlers.chat_message_received({
            message: { id: 'msg-dup-2', chan: '/chat_channel_types/trade', sName: 'Alice', m: 'hi' },
        });
        const node = makeMessage('Alice', 'hi');
        container.appendChild(node);
        await settle();

        expect(node.dataset.mwiMsgId).toBeUndefined();
    });

    test("a batch of several nodes added at once cannot let one steal another's id (the reported misattribution)", async () => {
        // The exact shape a backlog render takes: several messages the
        // correlator has queued ids for, but no DOM node yet — because the
        // tab was not showing this channel while they arrived — followed by
        // every one of them appearing in a single mutation batch once the tab
        // opens. A blind FIFO claim (the pre-fix behavior) would hand the
        // first-queued id to whichever node came first in that batch,
        // regardless of which message it actually was.
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: { id: 'msg-old', chan: '/chat_channel_types/trade', sName: 'Alice', m: 'old backlog line' },
        });
        wsHandlers.chat_message_received({
            message: { id: 'msg-new', chan: '/chat_channel_types/trade', sName: 'Alice', m: 'brand new message' },
        });

        // Appended in the OPPOSITE order from how their ids were queued, and
        // synchronously — so they land in one mutation batch together, and a
        // position-based claim is provably wrong if it ever matches.
        const nodeA = makeMessage('Alice', 'brand new message');
        const nodeB = makeMessage('Alice', 'old backlog line');
        container.appendChild(nodeA);
        container.appendChild(nodeB);
        await settle();

        expect(nodeA.dataset.mwiMsgId).toBe('msg-new');
        expect(nodeB.dataset.mwiMsgId).toBe('msg-old');
    });

    test('a whisper/name tab is never tagged — no reliable channel correlation', async () => {
        document.body.innerHTML = '<div id="root"><div class="Chat_tabsComponentContainer__x"></div></div>';
        const strip = document.querySelector('.Chat_tabsComponentContainer__x');
        const button = document.createElement('button');
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', 'true');
        button.textContent = 'Alice';
        strip.appendChild(button);
        const container = document.createElement('div');
        container.className = 'ChatHistory_chatHistory__abc';
        document.getElementById('root').appendChild(container);

        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: { id: 'msg-1', chan: '/chat_channel_types/whisper', sName: 'Alice', m: 'meet me at the tower' },
        });
        const node = makeMessage('Alice', 'meet me at the tower');
        container.appendChild(node);
        await settle();

        expect(node.dataset.mwiMsgId).toBeUndefined();
    });

    test('a message that arrives already deleted is tagged skip-store, not an id', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: {
                id: 'msg-1',
                chan: '/chat_channel_types/trade',
                isDeleted: true,
                sName: 'Alice',
                m: 'a moderator sees this, deleted',
            },
        });
        const node = makeMessage('Alice', 'a moderator sees this, deleted');
        container.appendChild(node);
        await settle();

        expect(node.dataset.mwiMsgId).toBeUndefined();
        expect(node.dataset.mwiSkipStore).toBe('1');

        // Never buffered (a resurrection risk no less real than the
        // still-live case below) and never persisted, on eviction.
        await evict(container, node);
        await chatHistoryPersistence.flush();
        expect(container.querySelector('.mwi-history-buffer').textContent).not.toContain('deleted');
        expect(db.settings[Object.keys(db.settings)[0]].tabs).toEqual({});
    });

    test('deleting an id already evicted into the buffer removes it from screen and from storage', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', sName: 'Alice', m: 'selling cheese' },
        });
        const node = makeMessage('Alice', 'selling cheese');
        container.appendChild(node);
        await settle();
        await evict(container, node);
        await chatHistoryPersistence.flush();

        const tabKey = tabKeyForChannel('/chat_channel_types/trade');
        expect(db.settings[Object.keys(db.settings)[0]].tabs[tabKey][0]).toContain('selling cheese');

        await wsHandlers.chat_message_updated({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', isDeleted: true },
        });

        expect(container.querySelector('.mwi-history-buffer').textContent).not.toContain('selling cheese');
        await chatHistoryPersistence.flush();
        expect(db.settings[Object.keys(db.settings)[0]].tabs[tabKey]).toBeUndefined();
    });

    test('a deletion arriving while the initial restore is still in flight is not restored anyway', async () => {
        // Pre-populate storage the way an earlier session would have left it —
        // this is what the in-flight restore below is racing to insert.
        const tabKey = tabKeyForChannel('/chat_channel_types/trade');
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: {
                [tabKey]: ['<div class="ChatMessage_chatMessage__x" data-mwi-msg-id="msg-1">selling cheese</div>'],
            },
        };

        const container = buildChannelChat('/chat_channel_types/trade');
        // initialize() kicks off the tab handler's restore() fire-and-forget;
        // it awaits chatHistoryPersistence.load(), which awaits storage.get()
        // — both still pending microtasks at this point, nothing has
        // resolved yet.
        chatHistoryExtender.initialize();

        // The deletion's own handler runs synchronously up to its first
        // await (see _handleMessageUpdated: `this.deletedIds?.add(...)` runs
        // before anything else), so calling it here — still inside the same
        // synchronous stretch initialize() ran in, before any microtask from
        // restore()'s load() has had a chance to run — reproduces the race:
        // purgeMessageById mutates `chatHistoryPersistence.tabs`, a different
        // object than the snapshot restore() is about to read from load().
        // Only the tombstone this handler adds to can stop that snapshot's
        // stale copy from being inserted regardless.
        await wsHandlers.chat_message_updated({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', isDeleted: true },
        });
        await settle();

        expect(container.querySelector('.mwi-history-buffer').textContent).not.toContain('selling cheese');
    });

    test('deleting a still-live (not yet evicted) message flags it so eviction never stores it', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', sName: 'Alice', m: 'selling cheese' },
        });
        const node = makeMessage('Alice', 'selling cheese');
        container.appendChild(node);
        await settle();
        expect(node.dataset.mwiMsgId).toBe('msg-1');

        await wsHandlers.chat_message_updated({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', isDeleted: true },
        });
        expect(node.dataset.mwiSkipStore).toBe('1');
        // Still on screen — the game, not this script, decides whether a live node is removed.
        expect(container.contains(node)).toBe(true);

        await evict(container, node);
        await chatHistoryPersistence.flush();
        expect(db.settings[Object.keys(db.settings)[0]].tabs).toEqual({});
        // The live-verified bug: for a non-author, non-moderator viewer the
        // game removes the node outright rather than redacting it in place —
        // and that removal reaches this handler exactly like an ordinary
        // eviction. Without the mwiSkipStore check in the removedNodes
        // branch, cloning it into the buffer put the deleted content right
        // back in front of a viewer the game just hid it from.
        expect(container.querySelector('.mwi-history-buffer').textContent).not.toContain('selling cheese');
    });

    test('a node removed before it was ever marked deleted is still kept out of the buffer (tombstone fallback)', async () => {
        // The narrow race Codex flagged alongside the resurrection bug: a
        // deletion can arrive for a node this handler's own
        // findLiveMessageNode lookup fails to find at that exact moment (the
        // id correlator had not tagged it yet, or the lookup simply loses a
        // timing race) — no mwiSkipStore is ever stamped on the node, only
        // the tombstone records the id. Simulated directly: the node's own
        // `data-mwi-msg-id` is hidden from findLiveMessageNode while the
        // deletion runs (so the marking loop cannot find it, exactly as a
        // missed lookup would look from the outside), then restored — the
        // node genuinely was msg-1 all along, this only hid *when* that
        // became visible to the marking loop.
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', sName: 'Alice', m: 'selling cheese' },
        });
        const node = makeMessage('Alice', 'selling cheese');
        container.appendChild(node);
        await settle();
        expect(node.dataset.mwiMsgId).toBe('msg-1');

        delete node.dataset.mwiMsgId;
        await wsHandlers.chat_message_updated({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', isDeleted: true },
        });
        expect(node.dataset.mwiSkipStore).toBeUndefined();
        node.dataset.mwiMsgId = 'msg-1';

        await evict(container, node);
        await chatHistoryPersistence.flush();
        expect(container.querySelector('.mwi-history-buffer').textContent).not.toContain('selling cheese');
        expect(db.settings[Object.keys(db.settings)[0]]?.tabs ?? {}).toEqual({});
    });

    test('an undelete clears the skip-store flag so a later eviction stores normally', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', sName: 'Alice', m: 'selling cheese' },
        });
        const node = makeMessage('Alice', 'selling cheese');
        container.appendChild(node);
        await settle();

        await wsHandlers.chat_message_updated({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', isDeleted: true },
        });
        await wsHandlers.chat_message_updated({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', isDeleted: false },
        });
        expect(node.dataset.mwiSkipStore).toBeUndefined();

        await evict(container, node);
        await chatHistoryPersistence.flush();
        const tabKey = tabKeyForChannel('/chat_channel_types/trade');
        expect(db.settings[Object.keys(db.settings)[0]].tabs[tabKey][0]).toContain('selling cheese');
    });

    test('a deletion for a message never seen (already off disk, or from before this build) does not throw', async () => {
        buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        await expect(
            wsHandlers.chat_message_updated({
                message: { id: 'msg-nonexistent', chan: '/chat_channel_types/trade', isDeleted: true },
            })
        ).resolves.not.toThrow();
    });

    test('malformed chat_message_updated payloads are ignored, not thrown', async () => {
        chatHistoryExtender.initialize();
        await settle();

        await expect(wsHandlers.chat_message_updated({})).resolves.not.toThrow();
        await expect(wsHandlers.chat_message_updated({ message: {} })).resolves.not.toThrow();
    });
});
