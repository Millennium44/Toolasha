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

import chatHistoryExtender from './chat-history-extender.js';

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
