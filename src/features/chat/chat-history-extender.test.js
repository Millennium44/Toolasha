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
import chatHistoryPersistence from './chat-history-persistence.js';

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

    function makeMessage(text) {
        const el = document.createElement('div');
        el.className = 'ChatMessage_chatMessage__xyz';
        el.textContent = text;
        return el;
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

        wsHandlers.chat_message_received({ message: { id: 'msg-1', chan: '/chat_channel_types/trade' } });
        const node = makeMessage('selling cheese');
        container.appendChild(node);
        await settle();

        expect(node.dataset.mwiMsgId).toBe('msg-1');
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

        wsHandlers.chat_message_received({ message: { id: 'msg-1', chan: '/chat_channel_types/whisper' } });
        const node = makeMessage('meet me at the tower');
        container.appendChild(node);
        await settle();

        expect(node.dataset.mwiMsgId).toBeUndefined();
    });

    test('a message that arrives already deleted is tagged skip-store, not an id', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({
            message: { id: 'msg-1', chan: '/chat_channel_types/trade', isDeleted: true },
        });
        const node = makeMessage('a moderator sees this, deleted');
        container.appendChild(node);
        await settle();

        expect(node.dataset.mwiMsgId).toBeUndefined();
        expect(node.dataset.mwiSkipStore).toBe('1');

        // Buffered on eviction like any live message, but never persisted.
        await evict(container, node);
        await chatHistoryPersistence.flush();
        expect(container.querySelector('.mwi-history-buffer').textContent).toContain('deleted');
        expect(db.settings[Object.keys(db.settings)[0]].tabs).toEqual({});
    });

    test('deleting an id already evicted into the buffer removes it from screen and from storage', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({ message: { id: 'msg-1', chan: '/chat_channel_types/trade' } });
        const node = makeMessage('selling cheese');
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

    test('deleting a still-live (not yet evicted) message flags it so eviction never stores it', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({ message: { id: 'msg-1', chan: '/chat_channel_types/trade' } });
        const node = makeMessage('selling cheese');
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
    });

    test('an undelete clears the skip-store flag so a later eviction stores normally', async () => {
        const container = buildChannelChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        wsHandlers.chat_message_received({ message: { id: 'msg-1', chan: '/chat_channel_types/trade' } });
        const node = makeMessage('selling cheese');
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
