/** @vitest-environment happy-dom */

/**
 * Persistence for the chat history buffer.
 *
 * The buffer is built from clones of nodes the game has thrown away, so before
 * this it was empty on every load. These tests pin the round trip, the fact
 * that a restored link is wired to *this script's* navigation rather than the
 * game callback it can no longer carry, and the two things that make the
 * feature safe rather than merely useful: the caps, and the exclusion from
 * anything that leaves the device (that last one lives in
 * `chat-history-sync-exclusion.test.js`, against the real payload builder).
 */

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

const db = vi.hoisted(() => ({ settings: {}, quota: false, writes: 0, closing: false, teardown: new Set() }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async (key, store, fallback = null) => {
            const bucket = db[store] || {};
            return Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : fallback;
        }),
        // The read chat history goes through: `null` when the database could
        // not be read, `{found, value}` otherwise — the real `tryGet`'s shape.
        tryGet: vi.fn(async (key, store) => {
            const bucket = db[store] || {};
            return Object.prototype.hasOwnProperty.call(bucket, key)
                ? { found: true, value: JSON.parse(JSON.stringify(bucket[key])) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store) => {
            // After `closeForTeardown()` the real `set` only queues, and on a
            // page being destroyed the queue never lands.
            if (db.closing) return true;
            db.writes += 1;
            db[store] = db[store] || {};
            // Round-trip through JSON, the way IndexedDB's structured clone
            // would: a test that shared the live object would "restore" a
            // reference and prove nothing.
            db[store][key] = JSON.parse(JSON.stringify(value));
            return true;
        }),
        // The real one is one readwrite transaction: nothing lands between its
        // read and its write. After `closeForTeardown()` it refuses.
        update: vi.fn(async (key, mutate, store) => {
            if (db.closing) return null;
            db[store] = db[store] || {};
            const found = Object.prototype.hasOwnProperty.call(db[store], key);
            const next = mutate(found ? JSON.parse(JSON.stringify(db[store][key])) : undefined, found);
            if (next === undefined) return { written: false, value: db[store][key] };
            db.writes += 1;
            db[store][key] = JSON.parse(JSON.stringify(next));
            return { written: true, value: JSON.parse(JSON.stringify(next)) };
        }),
        isQuotaExceeded: vi.fn(() => db.quota),
        onBeforeTeardown: vi.fn((listener) => {
            db.teardown.add(listener);
            return () => db.teardown.delete(listener);
        }),
        // The real one's order: listeners, then the flag that turns writes
        // into queued ones.
        closeForTeardown: vi.fn(() => {
            for (const listener of Array.from(db.teardown)) listener('pagehide');
            db.closing = true;
        }),
    },
}));

vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_char1`,
}));

const itemDb = vi.hoisted(() => ({ known: new Set(['/items/cheese']) }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: vi.fn((hrid) => (itemDb.known.has(hrid) ? { hrid, name: 'Cheese' } : null)),
    },
}));

const navigateToMarketplace = vi.hoisted(() => vi.fn());
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace }));

const openPlayerProfile = vi.hoisted(() => vi.fn());
vi.mock('../../utils/profile-command.js', () => ({
    openPlayerProfile,
    fillProfileCommand: vi.fn(),
    findChatInput: vi.fn(() => null),
    getGameCore: vi.fn(() => null),
    VALID_PLAYER_NAME_RE: /^[A-Za-z0-9_]+$/,
}));

import webSocketHook from '../../core/websocket.js';
import storage from '../../core/storage.js';
import chatHistoryExtender, { chatTabKey, tabKeyForChannel } from './chat-history-extender.js';
import chatHistoryPersistence, {
    applyCaps,
    CHAT_HISTORY_KEY_BASE,
    CHAT_HISTORY_STORE,
    extractStoredMessageId,
    messageIdentity,
    handleRestoredClick,
    MAX_LIVE_ALLOWANCE,
    MAX_MESSAGES_PER_TAB,
    MAX_TOTAL_CHARS,
    parseStoredMessage,
    PUBLIC_RECORD_KEY,
    rewireRestoredMessage,
    serializeMessage,
} from './chat-history-persistence.js';

const STORAGE_KEY = `${CHAT_HISTORY_KEY_BASE}_char1`;

/**
 * Build the chat DOM the way the game renders it: a tab strip naming every tab,
 * one of them `aria-selected`, and a message container for **that tab only**.
 *
 * One container is the load-bearing part of the fixture. The game does not
 * render a pane per tab, which is exactly why naming a container by its index
 * among the containers named every tab "Global".
 *
 * @param {Array<string>} tabNames
 * @param {number} selected - Index of the open tab
 * @returns {Array<Element>} The open tab's container, as a one-element array
 */
function buildChat(tabNames = ['Local'], selected = 0) {
    document.body.innerHTML = '<div id="root"><div class="Chat_tabsComponentContainer__x"></div></div>';
    const strip = document.querySelector('.Chat_tabsComponentContainer__x');
    tabNames.forEach((name, index) => {
        const button = document.createElement('button');
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', index === selected ? 'true' : 'false');
        button.textContent = name;
        strip.appendChild(button);
    });

    const container = document.createElement('div');
    container.className = 'ChatHistory_chatHistory__abc';
    document.getElementById('root').appendChild(container);
    return [container];
}

/**
 * Switch tabs the way the game does: the same pane node, a different button
 * selected. Returns nothing — the container from {@link buildChat} is still the
 * one on screen.
 * @param {number} index - Tab to open
 */
function selectTab(index) {
    const buttons = [...document.querySelectorAll('[class*="Chat_tabsComponentContainer"] button[role="tab"]')];
    buttons.forEach((button, i) => button.setAttribute('aria-selected', i === index ? 'true' : 'false'));
}

/**
 * A plain system message.
 * @param {string} text
 * @returns {Element}
 */
function makeMessage(text) {
    const el = document.createElement('div');
    el.className = 'ChatMessage_chatMessage__xyz';
    el.textContent = text;
    return el;
}

/**
 * A message carrying an item icon, the way a marketplace listing line does.
 * @param {string} slug - Sprite id, e.g. `cheese`
 * @returns {Element}
 */
function makeItemMessage(slug) {
    const el = document.createElement('div');
    el.className = 'ChatMessage_chatMessage__xyz';
    el.innerHTML = `<span>sold </span><div class="Item_itemContainer__1"><svg><use href="/static/media/items_sprite.svg#${slug}"></use></svg></div>`;
    return el;
}

/** Evict a live message so the buffer takes a clone of it. */
async function evict(container, node) {
    container.removeChild(node);
    await Promise.resolve();
    await Promise.resolve();
}

/** Let the fire-and-forget restore land. */
async function settle() {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('chat history persistence', () => {
    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        observerReady.handlers = [];
        observerReady.domReady = true;
        db.settings = {};
        db.quota = false;
        db.writes = 0;
        itemDb.known = new Set(['/items/cheese']);
        navigateToMarketplace.mockClear();
    });

    afterEach(async () => {
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    test('messages survive a simulated reload, in order', async () => {
        const [container] = buildChat(['Local']);
        const first = makeMessage('[1/2 10:00:00] first');
        const second = makeMessage('[1/2 10:00:01] second');
        container.append(first, second);

        chatHistoryExtender.initialize();
        await settle();

        await evict(container, first);
        await evict(container, second);
        await chatHistoryPersistence.flush();

        expect(db.settings[STORAGE_KEY]).toBeTruthy();

        // Reload: the module is torn down, the DOM is rebuilt from nothing, and
        // only what reached storage can come back. The registry awaits a
        // disable, and so does this: the next session reads after it lands.
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        const [reloaded] = buildChat(['Local']);
        chatHistoryExtender.initialize();
        await settle();

        const buffer = reloaded.querySelector('.mwi-history-buffer');
        const texts = [...buffer.querySelectorAll('[class*="ChatMessage_chatMessage"]')].map((el) => el.textContent);
        expect(texts).toEqual(['[1/2 10:00:00] first', '[1/2 10:00:01] second']);
    });

    test('a restored item link navigates through this script’s own helper', async () => {
        const [container] = buildChat(['Local']);
        const message = makeItemMessage('cheese');
        container.appendChild(message);

        chatHistoryExtender.initialize();
        await settle();
        await evict(container, message);
        await chatHistoryPersistence.flush();

        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        const [reloaded] = buildChat(['Local']);
        chatHistoryExtender.initialize();
        await settle();

        const link = reloaded.querySelector('.mwi-history-buffer [class*="Item_itemContainer"]');
        expect(link).not.toBeNull();
        expect(link.classList.contains('mwi-interactive')).toBe(true);

        link.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(navigateToMarketplace).toHaveBeenCalledWith('/items/cheese', 0);
    });

    test('a link whose markup cannot be understood renders inert rather than throwing', () => {
        // Two ways the markup can defeat us: no sprite at all (a game update
        // that stopped drawing one), and a sprite naming an item this build's
        // game data does not know.
        const noSprite = document.createElement('div');
        noSprite.className = 'ChatMessage_chatMessage__xyz';
        noSprite.innerHTML = '<div class="Item_itemContainer__1"><span>???</span></div>';

        const unknownItem = document.createElement('div');
        unknownItem.className = 'ChatMessage_chatMessage__xyz';
        unknownItem.innerHTML =
            '<div class="Item_itemContainer__1"><svg><use href="/s.svg#not_an_item"></use></svg></div>';

        for (const el of [noSprite, unknownItem]) {
            expect(() => rewireRestoredMessage(el)).not.toThrow();
            expect(rewireRestoredMessage(el)).toBe(0);
            expect(el.querySelector('.mwi-interactive')).toBeNull();
            expect(el.querySelector('[data-mwi-restored-item]')).toBeNull();
            // Still readable as text, which is the whole requirement
            expect(el.textContent).toBeDefined();
        }
    });

    test('whisper and private tabs are persisted too — the maintainer’s explicit choice', async () => {
        const [pane] = buildChat(['Local', 'Whispers'], 1);
        expect(chatTabKey(pane)).toBe('tab2:name:Whispers');

        const secret = makeMessage('[1/2 10:00:00] Alice: meet me at the tower');
        pane.appendChild(secret);

        chatHistoryExtender.initialize();
        await settle();
        await evict(pane, secret);

        // The same pane, now showing Local — the game reuses the node. The
        // switch itself is its own mutation batch; what Local evicts after it
        // is an eviction like any other.
        selectTab(0);
        const public_ = makeMessage('[1/2 10:00:00] hello');
        pane.appendChild(public_);
        await settle();
        await evict(pane, public_);
        await chatHistoryPersistence.flush();

        const stored = db.settings[STORAGE_KEY];
        expect(Object.keys(stored.tabs).sort()).toEqual(['tab2:name:Local', 'tab2:name:Whispers']);
        expect(stored.tabs['tab2:name:Whispers'][0]).toContain('meet me at the tower');
        expect(stored.tabs['tab2:name:Local'][0]).not.toContain('meet me at the tower');
    });

    test('caps trim oldest-first and hold the write bounded', () => {
        // Message cap: the newest survive, the oldest go.
        const tabs = {
            'tab2:name:Local': Array.from({ length: MAX_MESSAGES_PER_TAB + 20 }, (_, i) => `<div>${i}</div>`),
        };
        applyCaps(tabs, MAX_MESSAGES_PER_TAB);
        expect(tabs['tab2:name:Local']).toHaveLength(MAX_MESSAGES_PER_TAB);
        expect(tabs['tab2:name:Local'][0]).toBe('<div>20</div>');

        // Byte cap: many tabs of large messages, each within the message cap and
        // the per-tab count, still may not add up past the total.
        const big = 'x'.repeat(4000);
        const many = {};
        for (let t = 0; t < 12; t += 1) {
            many[`tab2:name:${t}`] = Array.from({ length: MAX_MESSAGES_PER_TAB }, () => big);
        }
        const before = JSON.stringify(many).length;
        applyCaps(many, MAX_MESSAGES_PER_TAB);
        const after = Object.values(many).reduce(
            (sum, list) => sum + list.reduce((inner, html) => inner + html.length, 0),
            0
        );
        expect(before).toBeGreaterThan(MAX_TOTAL_CHARS);
        expect(after).toBeLessThanOrEqual(MAX_TOTAL_CHARS);

        // A single message past the per-message cap is not stored at all —
        // half a message's HTML would restore as broken markup.
        const huge = document.createElement('div');
        huge.className = 'ChatMessage_chatMessage__xyz';
        huge.textContent = 'y'.repeat(20000);
        expect(serializeMessage(huge)).toBeNull();
    });

    test('with the setting off nothing is written and nothing is restored', async () => {
        // Something is already on disk, so "nothing restored" cannot pass by
        // there being nothing to restore.
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { 'tab2:name:Local': ['<div class="ChatMessage_chatMessage__z">old</div>'] },
        };
        settingValues.chatHistoryExtender = false;

        const [container] = buildChat(['Local']);
        const message = makeMessage('[1/2 10:00:00] hello');
        container.appendChild(message);

        chatHistoryExtender.initialize();
        await settle();

        expect(container.querySelector('.mwi-history-buffer')).toBeNull();
        expect(container.textContent).not.toContain('old');

        await evict(container, message);
        await chatHistoryPersistence.flush();
        expect(db.writes).toBe(0);
    });

    test('the record is keyed per character and under the device-local prefix', async () => {
        const [container] = buildChat(['Local']);
        const message = makeMessage('[1/2 10:00:00] hello');
        container.appendChild(message);

        chatHistoryExtender.initialize();
        await settle();
        await evict(container, message);
        await chatHistoryPersistence.flush();

        expect(Object.keys(db.settings)).toEqual([STORAGE_KEY]);
        expect(STORAGE_KEY.startsWith('toolasha_local_')).toBe(true);
        expect(CHAT_HISTORY_STORE).toBe('settings');
    });

    test('stale markup that no longer parses is skipped, not fatal to the rest', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: {
                'tab2:name:Local': ['', 'not markup at all', '<div class="ChatMessage_chatMessage__z">survivor</div>'],
            },
        };

        const [container] = buildChat(['Local']);
        chatHistoryExtender.initialize();
        await settle();

        const buffer = container.querySelector('.mwi-history-buffer');
        const texts = [...buffer.querySelectorAll('[class*="ChatMessage_chatMessage"]')].map((el) => el.textContent);
        expect(texts).toEqual(['survivor']);
    });

    test('restored history stays above messages this session evicts', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { 'tab2:name:Local': ['<div class="ChatMessage_chatMessage__z">older</div>'] },
        };

        const [container] = buildChat(['Local']);
        const fresh = makeMessage('newer');
        container.appendChild(fresh);

        chatHistoryExtender.initialize();
        await evict(container, fresh);
        await settle();

        const buffer = container.querySelector('.mwi-history-buffer');
        const texts = [...buffer.querySelectorAll('[class*="ChatMessage_chatMessage"]')].map((el) => el.textContent);
        expect(texts).toEqual(['older', 'newer']);
    });
});

/**
 * What a restored message may not bring back with it.
 *
 * The markup was the game's own when it was written, but it spent a session on
 * disk in between and `innerHTML` re-parses whatever it is handed. The `on*`
 * sweep was never the whole job: a URL attribute and an SMIL element both carry
 * script past an attribute-only pass, and an inline `url()` fires a request at
 * a third party with no click at all.
 */
describe('restored markup cannot execute or phone home', () => {
    test('a javascript: URL is dropped, however it is spelled', () => {
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z">' +
                '<a href="javascript:alert(1)">a</a>' +
                '<a id="padded" href="  java	script:alert(2)">b</a>' +
                '<a id="fine" href="#anchor">c</a>' +
                '</div>'
        );

        expect(el.querySelector('a').hasAttribute('href')).toBe(false);
        expect(el.querySelector('#padded').hasAttribute('href')).toBe(false);
        // A real link is left alone — the sanitizer must not eat the markup
        expect(el.querySelector('#fine').getAttribute('href')).toBe('#anchor');
    });

    test('an item icon’s sprite reference survives it', () => {
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z"><div class="Item_itemContainer__1">' +
                '<svg><use href="/static/media/items_sprite.svg#cheese"></use></svg></div></div>'
        );
        expect(rewireRestoredMessage(el)).toBe(1);
    });

    test('SMIL animation is removed — it rewrites attributes after any sweep', () => {
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z"><svg><a>' +
                '<animate attributeName="href" to="javascript:alert(1)"></animate>' +
                '<set attributeName="href" to="javascript:alert(2)"></set>' +
                '</a></svg></div>'
        );
        expect(el.querySelector('animate')).toBeNull();
        expect(el.querySelector('set')).toBeNull();
    });

    test('a base element, a meta refresh and a srcdoc are all removed', () => {
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z">' +
                '<base href="https://example.invalid/">' +
                '<meta http-equiv="refresh" content="0;url=https://example.invalid/">' +
                '<img srcdoc="<script>1</script>" alt="x">' +
                '</div>'
        );
        expect(el.querySelector('base')).toBeNull();
        expect(el.querySelector('meta')).toBeNull();
        expect(el.querySelector('img').hasAttribute('srcdoc')).toBe(false);
    });

    test('an inline style that fetches is dropped; one that only paints is kept', () => {
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z">' +
                '<span id="beacon" style="background:url(https://example.invalid/?seen)">a</span>' +
                '<span id="paint" style="color: red">b</span>' +
                '</div>'
        );
        expect(el.querySelector('#beacon').hasAttribute('style')).toBe(false);
        expect(el.querySelector('#paint').getAttribute('style')).toBe('color: red');
    });

    test('a nested chat message is marked restored too, not just the root', () => {
        // The dungeon tracker queries `[class*="ChatMessage_chatMessage"]` over
        // the whole document and skips only what carries the mark, so a nested
        // match with no mark is a restored line it reads as live.
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z">outer' +
                '<div class="ChatMessage_chatMessage__z">inner</div></div>'
        );
        expect(el.dataset.mwiRestored).toBe('1');
        expect(el.querySelector('.ChatMessage_chatMessage__z').dataset.mwiRestored).toBe('1');
    });
});

describe('a corrupt record costs its own contents and nothing else', () => {
    test('applyCaps drops entries that are not strings rather than throwing', () => {
        const tabs = { 'tab2:name:Local': ['<div>ok</div>', null, 7, undefined, '<div>also ok</div>'] };
        expect(() => applyCaps(tabs, MAX_MESSAGES_PER_TAB)).not.toThrow();
        expect(tabs['tab2:name:Local']).toEqual(['<div>ok</div>', '<div>also ok</div>']);
    });

    test('a load over such a record still resolves, and recording still works', async () => {
        db.settings[STORAGE_KEY] = { v: 1, savedAt: 1, tabs: { 'tab2:name:Local': [null, '<div>kept</div>'] } };
        chatHistoryPersistence.enable(() => MAX_MESSAGES_PER_TAB);

        await expect(chatHistoryPersistence.load()).resolves.toEqual({ 'tab2:name:Local': ['<div>kept</div>'] });
        expect(() => chatHistoryPersistence.record('tab2:name:Local', '<div>new</div>')).not.toThrow();
    });
});

/**
 * A tab is identified by its label or not at all.
 *
 * The tab strip is not always rendered when a container appears, and history
 * keyed by the container's *position* in that case restores into whichever tab
 * later sits at that index — a whisper into Global, which is exactly the thing
 * the persistence choice was not meant to cost.
 */
describe('tab identity is a name, never a position', () => {
    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        observerReady.handlers = [];
        observerReady.domReady = true;
        db.settings = {};
        db.quota = false;
        db.writes = 0;
    });

    afterEach(async () => {
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    /**
     * Chat containers with no tab strip at all — what the DOM looks like in the
     * window between the containers mounting and the strip rendering.
     * @param {number} count - How many containers
     * @returns {Array<Element>} The containers, in order
     */
    function buildChatWithoutTabStrip(count = 1) {
        document.body.innerHTML = '<div id="root"></div>';
        const root = document.getElementById('root');
        return Array.from({ length: count }, () => {
            const container = document.createElement('div');
            container.className = 'ChatHistory_chatHistory__abc';
            root.appendChild(container);
            return container;
        });
    }

    test('an unnamed tab is not keyed at all', () => {
        const [container] = buildChatWithoutTabStrip(1);
        expect(chatTabKey(container)).toBeNull();
    });

    test('an unnamed tab writes no history rather than a positional key', async () => {
        const [container] = buildChatWithoutTabStrip(2);
        const secret = makeMessage('[1/2 10:00:00] Alice: meet me at the tower');
        container.appendChild(secret);

        chatHistoryExtender.initialize();
        await settle();
        await evict(container, secret);
        await chatHistoryPersistence.flush();

        const stored = db.settings[STORAGE_KEY];
        const keys = stored ? Object.keys(stored.tabs) : [];
        expect(keys).toEqual([]);
    });

    test('a tab named only after its container appeared starts persisting under that name', async () => {
        const [container] = buildChatWithoutTabStrip(1);
        chatHistoryExtender.initialize();
        await settle();

        // The strip renders late, which is the whole reason the fallback existed
        const strip = document.createElement('div');
        strip.className = 'Chat_tabsComponentContainer__x';
        const button = document.createElement('button');
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', 'true');
        button.textContent = 'Whispers';
        strip.appendChild(button);
        document.getElementById('root').prepend(strip);

        const secret = makeMessage('[1/2 10:00:00] Alice: meet me at the tower');
        container.appendChild(secret);
        await evict(container, secret);
        await chatHistoryPersistence.flush();

        expect(Object.keys(db.settings[STORAGE_KEY].tabs)).toEqual(['tab2:name:Whispers']);
    });

    test('a record written under an older key format is discarded, not restored into whichever tab is open', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: {
                // `idx:` named a slot; `tab:` claimed to name a tab but was
                // resolved by index against a one-container strip, so it is an
                // unattributable mixture of every tab the player used.
                'idx:0': ['<div class="ChatMessage_chatMessage__z">Alice: meet me at the tower</div>'],
                'tab:/chat_channel_types/global': [
                    '<div class="ChatMessage_chatMessage__z">Bob whispers: the vault code is 1234</div>',
                ],
                'tab2:name:Local': ['<div class="ChatMessage_chatMessage__z">hello</div>'],
            },
        };

        const [general] = buildChat(['Local']);
        chatHistoryExtender.initialize();
        await settle();

        const rendered = [...document.querySelectorAll('.mwi-history-buffer [class*="ChatMessage_chatMessage"]')].map(
            (el) => el.textContent
        );
        expect(rendered).toEqual(['hello']);
        expect(general.textContent).not.toContain('meet me at the tower');
        expect(general.textContent).not.toContain('the vault code');

        // And they are gone from the record, not merely unread this session
        await chatHistoryPersistence.flush();
        expect(Object.keys(db.settings[STORAGE_KEY].tabs)).toEqual(['tab2:name:Local']);
    });

    test('the discard is a format test, so a second run cannot eat what the first left', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { 'tab:Local': ['<div class="ChatMessage_chatMessage__z">mixed</div>'] },
        };

        const [container] = buildChat(['Local']);
        chatHistoryExtender.initialize();
        await settle();
        await evict(
            container,
            (() => {
                const live = makeMessage('[1/2 10:00:00] kept');
                container.appendChild(live);
                return live;
            })()
        );
        await chatHistoryPersistence.flush();
        expect(Object.keys(db.settings[STORAGE_KEY].tabs)).toEqual(['tab2:name:Local']);

        // Reload onto the record the first run left behind: nothing more goes.
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        const [reloaded] = buildChat(['Local']);
        chatHistoryExtender.initialize();
        await settle();
        await chatHistoryPersistence.flush();

        expect(db.settings[STORAGE_KEY].tabs['tab2:name:Local']).toHaveLength(1);
        expect(reloaded.textContent).toContain('kept');
    });

    test('a key matching no current tab is skipped and renders nowhere', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: {
                'tab2:name:Whispers': ['<div class="ChatMessage_chatMessage__z">Alice: meet me at the tower</div>'],
            },
        };

        buildChat(['Local', 'Party']);
        chatHistoryExtender.initialize();
        await settle();

        expect(document.body.textContent).not.toContain('meet me at the tower');
    });
});

describe('a restored message keeps its clickable player name', () => {
    // The bug: `data-mwi-profile-name` was stripped on save while the
    // `mwi-chat-profile-name` class that styles it was kept. A restored message
    // looked exactly like a link — blue, pointer cursor, hover underline — and
    // its click handler read an empty name and returned. The decorator could not
    // repair it either, because it skips any node already carrying the class.
    const messageWithName = () => {
        const el = document.createElement('div');
        el.className = 'ChatMessage_chatMessage__2wc4V';
        const name = document.createElement('span');
        name.className = 'mwi-chat-profile-name';
        name.dataset.mwiProfileName = 'Millennium';
        name.textContent = 'Millennium';
        el.appendChild(name);
        return el;
    };

    test('the name and the class that styles it both survive serialization', () => {
        const html = serializeMessage(messageWithName());
        expect(html).toBeTruthy();

        const restored = document.createElement('div');
        restored.innerHTML = html;
        const link = restored.querySelector('.mwi-chat-profile-name');

        expect(link, 'the styled span survives').toBeTruthy();
        expect(link.dataset.mwiProfileName, 'and so does the name it needs').toBe('Millennium');
    });

    test('session-scoped handles are still stripped', () => {
        const el = messageWithName();
        el.dataset.mwiUid = 'abc123';
        el.dataset.mwiHydrated = 'true';

        const restored = document.createElement('div');
        restored.innerHTML = serializeMessage(el);
        const message = restored.firstElementChild;

        expect(message.dataset.mwiUid).toBeUndefined();
        expect(message.dataset.mwiHydrated).toBeUndefined();
    });
});

/**
 * The sender name of a restored line.
 *
 * A live chat line's sender is the game's own `ChatMessage_name
 * ChatMessage_clickable` element, made clickable by a React handler and
 * carrying no attribute of ours. Handlers do not serialize, so a restored line
 * showed a name styled exactly like a link with nothing at all behind it —
 * item links were re-wired, these were not, and `chat-profile-link.js` skips
 * them by design (it decorates announcement names, not the game's own sender).
 */
describe('a restored message’s sender name opens the profile', () => {
    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        observerReady.handlers = [];
        observerReady.domReady = true;
        db.settings = {};
        db.quota = false;
        db.writes = 0;
        openPlayerProfile.mockClear();
    });

    afterEach(async () => {
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    /**
     * The game's own markup for a player chat line — no Toolasha attributes
     * anywhere, which is also exactly what a record written before this change
     * holds.
     * @param {string} name - Sender name, as the markup shows it
     * @returns {string} HTML
     */
    const senderHTML = (name) =>
        '<div class="ChatMessage_chatMessage__2wc4V">' +
        '<span>[1/2 10:00:00] </span>' +
        '<span class="ChatMessage_name__1UZ8t ChatMessage_clickable__3Nt2s">' +
        '<div class="CharacterName_characterName__2FqyZ">' +
        `<div class="CharacterName_name__1amXp"><span>${name}</span></div></div></span>` +
        '<span>: hello</span></div>';

    /** The same thing as a live element, for the save side of the round trip. */
    const senderMessage = (name) => {
        const host = document.createElement('div');
        host.innerHTML = senderHTML(name);
        return host.firstElementChild;
    };

    const senderOf = (root) => root.querySelector('[class*="ChatMessage_name"]');

    test('a name saved this session comes back clickable', async () => {
        const [container] = buildChat(['Local']);
        const message = senderMessage('Spice');
        container.appendChild(message);

        chatHistoryExtender.initialize();
        await settle();
        await evict(container, message);
        await chatHistoryPersistence.flush();

        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        const [reloaded] = buildChat(['Local']);
        chatHistoryExtender.initialize();
        await settle();

        const sender = senderOf(reloaded.querySelector('.mwi-history-buffer'));
        expect(sender, 'the sender element survives the round trip').not.toBeNull();

        sender.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(openPlayerProfile).toHaveBeenCalledWith('Spice', expect.anything());
    });

    test('a message stored before this change works too — the name is re-read from the markup', async () => {
        // Written by hand rather than by the serializer: this is a record from
        // an older version, carrying no attribute this code could have put
        // there. It still restores clickable, which is what makes the backfill
        // free — no migration, no record-version bump.
        db.settings[STORAGE_KEY] = { v: 1, savedAt: 1, tabs: { 'tab2:name:Local': [senderHTML('Millennium')] } };
        expect(db.settings[STORAGE_KEY].tabs['tab2:name:Local'][0]).not.toContain('data-mwi');

        const [container] = buildChat(['Local']);
        chatHistoryExtender.initialize();
        await settle();

        const sender = senderOf(container.querySelector('.mwi-history-buffer'));
        expect(sender.dataset.mwiRestoredSender).toBe('Millennium');

        sender.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(openPlayerProfile).toHaveBeenCalledWith('Millennium', expect.anything());
    });

    test('a name that cannot be resolved is left inert, not falsely styled', () => {
        // A game update that stops writing the inner name element, and a name
        // that is not a name. Either way the pointer cursor has to go: on a
        // restored node `ChatMessage_clickable` is a promise nothing can keep.
        const empty = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__2wc4V">' +
                '<span class="ChatMessage_name__1UZ8t ChatMessage_clickable__3Nt2s"></span></div>'
        );
        const bogus = parseStoredMessage(senderHTML('not a name'));

        for (const el of [empty, bogus]) {
            expect(() => rewireRestoredMessage(el)).not.toThrow();
            expect(rewireRestoredMessage(el)).toBe(0);
            const sender = senderOf(el);
            expect(sender.dataset.mwiRestoredSender).toBeUndefined();
            expect(sender.className).not.toContain('ChatMessage_clickable');
            // The line still reads as text, which is the whole requirement
            expect(el.textContent).toBeDefined();
        }
    });

    test('re-processing a restored node does not wire it twice', () => {
        const el = parseStoredMessage(senderHTML('Spice'));
        expect(rewireRestoredMessage(el)).toBe(1);
        expect(rewireRestoredMessage(el)).toBe(1);

        // An attribute, not a listener — so there is exactly one of it and a
        // click cannot open two profiles.
        expect(el.querySelectorAll('[data-mwi-restored-sender]')).toHaveLength(1);
        document.body.appendChild(el);
        document.body.addEventListener('click', handleRestoredClick, true);
        senderOf(el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.body.removeEventListener('click', handleRestoredClick, true);
        expect(openPlayerProfile).toHaveBeenCalledTimes(1);
    });
});

describe('a chat tab is named by the tab that is open', () => {
    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        observerReady.handlers = [];
        observerReady.domReady = true;
        db.settings = {};
        db.quota = false;
        db.writes = 0;
    });

    afterEach(async () => {
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    /**
     * The live client's chat markup, measured: several tab buttons, exactly one
     * message container, and the open tab marked with `aria-selected`. Channel
     * tabs carry `data-mention-channel`; the rest are named by their text.
     * @param {string} openChannel - `data-mention-channel` of the open tab
     * @returns {Element} The one message container
     */
    function buildLiveChat(openChannel = '/chat_channel_types/beginner') {
        const channels = [
            '/chat_channel_types/global',
            '/chat_channel_types/beginner',
            '/chat_channel_types/trade',
            '/chat_channel_types/party',
        ];
        document.body.innerHTML = '<div id="root"><div class="Chat_tabsComponentContainer__x"></div></div>';
        const strip = document.querySelector('.Chat_tabsComponentContainer__x');
        for (const channel of channels) {
            const button = document.createElement('button');
            button.setAttribute('role', 'tab');
            button.setAttribute('data-mention-channel', channel);
            button.setAttribute('aria-selected', channel === openChannel ? 'true' : 'false');
            button.textContent = channel.split('/').pop();
            strip.appendChild(button);
        }
        const container = document.createElement('div');
        container.className = 'ChatHistory_chatHistory__abc';
        document.getElementById('root').appendChild(container);
        return container;
    }

    /** Open a different tab, the way the game does: same pane, new selection. */
    function openChannelTab(channel) {
        for (const button of document.querySelectorAll('button[role="tab"]')) {
            button.setAttribute(
                'aria-selected',
                button.getAttribute('data-mention-channel') === channel ? 'true' : 'false'
            );
        }
    }

    /**
     * The identification this module used to do: find the container's index
     * among the containers, and take the tab button at the same index. Kept
     * here, and nowhere else, to hold the bug still.
     * @param {Element} containerEl
     * @returns {string|null}
     */
    function legacyChatTabKey(containerEl) {
        const containers = [...document.querySelectorAll('[class*="ChatHistory_chatHistory"]')];
        const index = containers.indexOf(containerEl);
        if (index < 0) return null;
        const buttons = [...document.querySelectorAll('[class*="Chat_tabsComponentContainer"] button[role="tab"]')];
        const button = buttons[index];
        const label =
            button?.getAttribute('data-mention-channel') ||
            button?.textContent?.trim().replace(/\d+$/, '').trim() ||
            '';
        return label ? `tab:${label}` : null;
    }

    test('the bug: index alignment named every tab Global, because only the open tab has a container', () => {
        const container = buildLiveChat('/chat_channel_types/beginner');
        expect(document.querySelectorAll('[class*="ChatHistory_chatHistory"]')).toHaveLength(1);
        expect(document.querySelectorAll('button[role="tab"]').length).toBeGreaterThan(1);

        // What shipped: the container is always at index 0, so the key is always
        // the first button's — whatever tab is actually open.
        expect(legacyChatTabKey(container)).toBe('tab:/chat_channel_types/global');

        // What the open tab says
        expect(chatTabKey(container)).toBe('tab2:ch:/chat_channel_types/beginner');
    });

    test('a different open tab gives a different key, the same pane notwithstanding', () => {
        const container = buildLiveChat('/chat_channel_types/party');
        expect(chatTabKey(container)).toBe('tab2:ch:/chat_channel_types/party');

        openChannelTab('/chat_channel_types/trade');
        expect(chatTabKey(container)).toBe('tab2:ch:/chat_channel_types/trade');
    });

    test('no tab selected is not a tab identity', () => {
        const container = buildLiveChat('/chat_channel_types/global');
        openChannelTab('nothing');
        expect(chatTabKey(container)).toBeNull();

        // Two tabs claiming to be open is markup that no longer means what this
        // reads it as, and is no more of an identity than none.
        const buttons = [...document.querySelectorAll('button[role="tab"]')];
        buttons[0].setAttribute('aria-selected', 'true');
        buttons[1].setAttribute('aria-selected', 'true');
        expect(chatTabKey(container)).toBeNull();
    });

    test('a whisper tab gets its own key, distinct from a channel tab of the same text', () => {
        const container = buildLiveChat('/chat_channel_types/global');
        openChannelTab('nothing');

        // A whisper tab carries no channel attribute — it is named by its text
        const strip = document.querySelector('.Chat_tabsComponentContainer__x');
        const whisper = document.createElement('button');
        whisper.setAttribute('role', 'tab');
        whisper.setAttribute('aria-selected', 'true');
        whisper.textContent = 'global';
        strip.appendChild(whisper);

        // Same text as the Global channel tab, and deliberately not the same key
        expect(chatTabKey(container)).toBe('tab2:name:global');
        expect(chatTabKey(container)).not.toBe('tab2:ch:/chat_channel_types/global');
    });

    test('the unread badge on a tab button does not change its key', () => {
        const container = buildLiveChat('/chat_channel_types/global');
        openChannelTab('nothing');
        const whisper = document.createElement('button');
        whisper.setAttribute('role', 'tab');
        whisper.setAttribute('aria-selected', 'true');
        whisper.textContent = 'Alice';
        document.querySelector('.Chat_tabsComponentContainer__x').appendChild(whisper);
        expect(chatTabKey(container)).toBe('tab2:name:Alice');

        whisper.textContent = 'Alice 3';
        expect(chatTabKey(container)).toBe('tab2:name:Alice');
    });

    test('more than one container means the one-pane claim has stopped holding, so nothing is keyed', () => {
        const container = buildLiveChat('/chat_channel_types/global');
        const second = document.createElement('div');
        second.className = 'ChatHistory_chatHistory__abc';
        container.parentElement.appendChild(second);

        // With no link from the button to the pane there is no way to say which
        // of these the open tab is, and a guess is the whole bug.
        expect(chatTabKey(container)).toBeNull();
        expect(chatTabKey(second)).toBeNull();
    });

    test('aria-controls ties a pane to its tab even when several are rendered', () => {
        const container = buildLiveChat('/chat_channel_types/party');
        const open = document.querySelector('button[aria-selected="true"]');
        const panel = document.createElement('div');
        panel.id = 'chat-panel-party';
        open.setAttribute('aria-controls', panel.id);
        document.getElementById('root').appendChild(panel);
        panel.appendChild(container);

        const other = document.createElement('div');
        other.className = 'ChatHistory_chatHistory__abc';
        document.getElementById('root').appendChild(other);

        expect(chatTabKey(container)).toBe('tab2:ch:/chat_channel_types/party');
        expect(chatTabKey(other)).toBeNull();
    });

    test('switching tabs in the same pane re-keys it and does not leave the old tab on screen', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: {
                'tab2:ch:/chat_channel_types/party': [
                    '<div class="ChatMessage_chatMessage__z">Alice: meet me at the tower</div>',
                ],
            },
        };
        db.settings[PUBLIC_RECORD_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: {
                'tab2:ch:/chat_channel_types/trade': ['<div class="ChatMessage_chatMessage__z">selling cheese</div>'],
            },
        };

        const container = buildLiveChat('/chat_channel_types/party');
        chatHistoryExtender.initialize();
        await settle();
        expect(container.textContent).toContain('meet me at the tower');

        // The game swaps the pane's contents and moves the selection in one
        // commit, so the outgoing tab's live lines leave with it. They are not
        // evictions and must not be buffered or recorded under the new tab.
        const live = makeMessage('[1/2 10:00:00] Alice: and bring the key');
        container.appendChild(live);
        openChannelTab('/chat_channel_types/trade');
        await evict(container, live);
        await settle();

        expect(container.textContent).not.toContain('meet me at the tower');
        expect(container.textContent).not.toContain('and bring the key');
        expect(container.textContent).toContain('selling cheese');

        await chatHistoryPersistence.flush();
        expect(db.settings[PUBLIC_RECORD_KEY].tabs['tab2:ch:/chat_channel_types/trade']).toEqual([
            '<div class="ChatMessage_chatMessage__z">selling cheese</div>',
        ]);
        expect(JSON.stringify(db.settings)).not.toContain('bring the key');
    });
});

/**
 * A September 2026 patch lets a player delete their own Trade/Recruit
 * messages, on top of the moderator deletion that already existed. See the
 * "Message identity and deletion" section at the top of
 * chat-history-persistence.js for the whole mechanism — chat-history-extender
 * stamps a live node's game-assigned id as `data-mwi-msg-id`, which rides
 * along inside the stored HTML rather than as a field of its own.
 */
describe('message identity: extractStoredMessageId and purgeMessageById', () => {
    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        db.settings = {};
        db.quota = false;
        db.writes = 0;
    });

    afterEach(async () => {
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
    });

    test('extractStoredMessageId pulls the id back out of stored markup', () => {
        expect(
            extractStoredMessageId('<div class="ChatMessage_chatMessage__x" data-mwi-msg-id="msg-42">hi</div>')
        ).toBe('msg-42');
    });

    test('extractStoredMessageId returns null for markup carrying no id — the pre-patch shape', () => {
        expect(extractStoredMessageId('<div class="ChatMessage_chatMessage__x">hi</div>')).toBeNull();
        expect(extractStoredMessageId(null)).toBeNull();
        expect(extractStoredMessageId(undefined)).toBeNull();
    });

    test('purgeMessageById removes the one matching message and schedules a write', async () => {
        chatHistoryPersistence.enable(() => MAX_MESSAGES_PER_TAB);
        const tabKey = tabKeyForChannel('/chat_channel_types/trade');
        chatHistoryPersistence.tabs = {
            [tabKey]: [
                '<div class="ChatMessage_chatMessage__x" data-mwi-msg-id="1">first</div>',
                '<div class="ChatMessage_chatMessage__x" data-mwi-msg-id="2">second</div>',
            ],
        };

        const removed = await chatHistoryPersistence.purgeMessageById(tabKey, '1');

        expect(removed).toBe(true);
        expect(chatHistoryPersistence.tabs[tabKey]).toHaveLength(1);
        expect(chatHistoryPersistence.tabs[tabKey][0]).toContain('second');

        await chatHistoryPersistence.flush();
        // Trade is a public channel: its record is the shared one, which keeps the deletion as a tombstone.
        expect(db.settings[PUBLIC_RECORD_KEY].tabs[tabKey]).toHaveLength(1);
        expect(db.settings[PUBLIC_RECORD_KEY].deleted).toEqual(['1']);
    });

    test('purging the last message in a tab drops the tab entirely', async () => {
        chatHistoryPersistence.enable(() => MAX_MESSAGES_PER_TAB);
        const tabKey = tabKeyForChannel('/chat_channel_types/trade');
        chatHistoryPersistence.tabs = {
            [tabKey]: ['<div class="ChatMessage_chatMessage__x" data-mwi-msg-id="1">only</div>'],
        };

        await chatHistoryPersistence.purgeMessageById(tabKey, '1');

        expect(chatHistoryPersistence.tabs[tabKey]).toBeUndefined();
    });

    test('an id with nothing stored under it is a no-op, not an error', async () => {
        chatHistoryPersistence.enable(() => MAX_MESSAGES_PER_TAB);
        const tabKey = tabKeyForChannel('/chat_channel_types/trade');
        chatHistoryPersistence.tabs = {
            [tabKey]: ['<div class="ChatMessage_chatMessage__x" data-mwi-msg-id="1">first</div>'],
        };

        const removed = await chatHistoryPersistence.purgeMessageById(tabKey, 'nonexistent');

        expect(removed).toBe(false);
        expect(chatHistoryPersistence.tabs[tabKey]).toHaveLength(1);
    });

    test('a message stored without an id (older build, or a whisper/name tab) cannot be purged by id', async () => {
        chatHistoryPersistence.enable(() => MAX_MESSAGES_PER_TAB);
        const tabKey = 'tab2:name:Alice';
        chatHistoryPersistence.tabs = {
            [tabKey]: ['<div class="ChatMessage_chatMessage__x">no id here</div>'],
        };

        const removed = await chatHistoryPersistence.purgeMessageById(tabKey, 'anything');

        expect(removed).toBe(false);
        expect(chatHistoryPersistence.tabs[tabKey]).toHaveLength(1);
    });

    test('purgeMessageById on a disabled/unloaded persistence is a safe no-op', async () => {
        expect(await chatHistoryPersistence.purgeMessageById('tab2:ch:/chat_channel_types/trade', '1')).toBe(false);
    });

    test('purgeMessageById loads the record itself when nothing has called load() yet', async () => {
        // The exact gap Codex found: enable() has run (a character is loaded)
        // but no chat container has ever called restore()/load() — the game
        // is still mounting its chat UI, say — so loadPromise and tabs are
        // both still null. A deletion arriving in that window used to just
        // return false without ever touching storage; the message stored
        // from an earlier session stayed on disk, papered over only by the
        // deletion tombstone's 60-second window in chat-history-extender.js.
        const tabKey = tabKeyForChannel('/chat_channel_types/trade');
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { [tabKey]: ['<div class="ChatMessage_chatMessage__x" data-mwi-msg-id="1">selling cheese</div>'] },
        };
        chatHistoryPersistence.enable(() => MAX_MESSAGES_PER_TAB);
        expect(chatHistoryPersistence.tabs).toBeNull();

        const removed = await chatHistoryPersistence.purgeMessageById(tabKey, '1');

        expect(removed).toBe(true);
        expect(chatHistoryPersistence.tabs[tabKey]).toBeUndefined();

        await chatHistoryPersistence.flush();
        expect(db.settings[STORAGE_KEY].tabs[tabKey]).toBeUndefined();
    });
});

/**
 * The reported loss: on 9/27 a party's Sinister Circus runs between 12:52 PM
 * and 8:41 PM never reached storage. Party chat is quiet, so none of those
 * lines was ever pushed out of the game's live list, and only an eviction used
 * to be recorded. The live server then restarted for a game update, the page
 * came back with a short party history, and every line that had only ever
 * been live was gone.
 */
describe('messages that were only ever live survive a server restart', () => {
    const PARTY = '/chat_channel_types/party';
    const PARTY_KEY = tabKeyForChannel(PARTY);

    /** A chat pane showing one channel tab, the way the live client renders it. */
    function buildPartyChat(openChannel = PARTY) {
        document.body.innerHTML = '<div id="root"><div class="Chat_tabsComponentContainer__x"></div></div>';
        const strip = document.querySelector('.Chat_tabsComponentContainer__x');
        for (const channel of ['/chat_channel_types/trade', PARTY]) {
            const button = document.createElement('button');
            button.setAttribute('role', 'tab');
            button.setAttribute('data-mention-channel', channel);
            button.setAttribute('aria-selected', channel === openChannel ? 'true' : 'false');
            button.textContent = channel.split('/').pop();
            strip.appendChild(button);
        }
        const container = document.createElement('div');
        container.className = 'ChatHistory_chatHistory__abc';
        document.getElementById('root').appendChild(container);
        return container;
    }

    function openTab(channel) {
        for (const button of document.querySelectorAll('button[role="tab"]')) {
            button.setAttribute(
                'aria-selected',
                button.getAttribute('data-mention-channel') === channel ? 'true' : 'false'
            );
        }
    }

    const liveNodes = (container) =>
        [...container.children].filter((el) => el.className.includes('ChatMessage_chatMessage'));
    const bufferTexts = (container) =>
        [...container.querySelectorAll('.mwi-history-buffer [class*="ChatMessage_chatMessage"]')].map(
            (el) => el.textContent
        );
    const liveTexts = (container) => liveNodes(container).map((el) => el.textContent);
    const storedTexts = (key = PARTY_KEY) =>
        (db.settings[STORAGE_KEY]?.tabs?.[key] || []).map((html) => parseStoredMessage(html).textContent);

    const OLD = '[9/26 10:29:27 AM] Battle ended: Pirate Cove';
    const JOINED = '[9/27 12:52:34 PM] Millennium44 has joined the party.';
    const RUNS = [
        '[9/27 1:14:02 PM] Key counts: [MrChilimby - 50]',
        '[9/27 1:33:40 PM] Key counts: [MrChilimby - 48]',
        '[9/27 7:58:11 PM] Key counts: [MrChilimby - 31]',
    ];
    const AFTER_RESTART = '[9/27 8:41:39 PM] Battle started: Sinister Circus';

    /** Tear the page down; only what reached storage comes back. */
    async function reload() {
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
    }

    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        observerReady.handlers = [];
        observerReady.domReady = true;
        db.settings = {
            [STORAGE_KEY]: {
                v: 1,
                savedAt: 1,
                tabs: { [PARTY_KEY]: [`<div class="ChatMessage_chatMessage__z">${OLD}</div>`] },
            },
        };
        db.quota = false;
        db.writes = 0;
        storage.set.mockClear();
    });

    afterEach(async () => {
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    test('lines that arrived while connected and were never evicted are still there after the restart', async () => {
        // The session: the party chat already showing the join, then key
        // counts arriving one by one. Nothing is ever evicted.
        const container = buildPartyChat();
        container.appendChild(makeMessage(JOINED));
        chatHistoryExtender.initialize();
        await settle();
        for (const line of RUNS) {
            container.appendChild(makeMessage(line));
            await settle();
        }

        // The server goes down: the socket closes first, and the write that
        // was waiting on its coalescing timer goes out now.
        webSocketHook.emitSocketEvent('close', {}, null);
        await settle();
        expect(storage.set).toHaveBeenCalledWith(STORAGE_KEY, expect.any(Object), CHAT_HISTORY_STORE, true);

        // The page comes back with only what the restarted server has.
        await reload();
        const restarted = buildPartyChat();
        restarted.appendChild(makeMessage(AFTER_RESTART));
        chatHistoryExtender.initialize();
        await settle();

        expect(bufferTexts(restarted)).toEqual([OLD, JOINED, ...RUNS]);
        expect(liveTexts(restarted)).toEqual([AFTER_RESTART]);

        await chatHistoryPersistence.flush();
        expect(storedTexts()).toEqual([OLD, JOINED, ...RUNS, AFTER_RESTART]);
    });

    test('an empty history from the reconnect keeps everything too', async () => {
        const container = buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();
        container.appendChild(makeMessage(JOINED));
        await settle();
        webSocketHook.emitSocketEvent('close', {}, null);
        await settle();

        await reload();
        const restarted = buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();

        expect(bufferTexts(restarted)).toEqual([OLD, JOINED]);
    });

    test('a reload that brings the same lines back live shows each of them once', async () => {
        const container = buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();
        for (const line of RUNS) {
            container.appendChild(makeMessage(line));
            await settle();
        }
        await chatHistoryPersistence.flush();

        // No restart this time: the server still has the lines and renders
        // them live again. One is already there when the handler attaches…
        await reload();
        const reloaded = buildPartyChat();
        reloaded.appendChild(makeMessage(RUNS[0]));
        chatHistoryExtender.initialize();
        await settle();
        // …and the rest render after the restore has landed.
        reloaded.appendChild(makeMessage(RUNS[1]));
        reloaded.appendChild(makeMessage(RUNS[2]));
        await settle();

        expect(bufferTexts(reloaded)).toEqual([OLD]);
        expect(liveTexts(reloaded)).toEqual(RUNS);

        // Evicted later, each goes back to the buffer once and is stored once.
        for (const node of liveNodes(reloaded)) await evict(reloaded, node);
        await chatHistoryPersistence.flush();
        expect(bufferTexts(reloaded)).toEqual([OLD, ...RUNS]);
        expect(storedTexts()).toEqual([OLD, ...RUNS]);
    });

    test('a restored copy is taken out of the buffer when the game renders the same line live', async () => {
        db.settings[STORAGE_KEY].tabs[PARTY_KEY].push(`<div class="ChatMessage_chatMessage__z">${RUNS[0]}</div>`);

        const container = buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();
        expect(bufferTexts(container)).toEqual([OLD, RUNS[0]]);

        container.appendChild(makeMessage(RUNS[0]));
        await settle();
        expect(bufferTexts(container)).toEqual([OLD]);
        expect(liveTexts(container)).toEqual([RUNS[0]]);
    });

    test('party lines that arrived while another tab was open are saved when the party tab is opened', async () => {
        const container = buildPartyChat('/chat_channel_types/trade');
        chatHistoryExtender.initialize();
        await settle();

        // The game renders the party backlog into the same pane on the switch.
        openTab(PARTY);
        for (const line of RUNS) container.appendChild(makeMessage(line));
        await settle();
        await chatHistoryPersistence.flush();

        expect(storedTexts()).toEqual([OLD, ...RUNS]);
        expect(storedTexts(tabKeyForChannel('/chat_channel_types/trade'))).toEqual([]);
    });

    test('a page being hidden writes a waiting record at once, and nothing when none is waiting', async () => {
        const container = buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();

        window.dispatchEvent(new Event('pagehide'));
        await settle();
        expect(storage.set).not.toHaveBeenCalled();

        container.appendChild(makeMessage(JOINED));
        await settle();
        window.dispatchEvent(new Event('pagehide'));
        await settle();
        expect(storage.set).toHaveBeenCalledTimes(1);
        expect(storage.set.mock.calls[0][3]).toBe(true);
        expect(storedTexts()).toEqual([OLD, JOINED]);
    });

    /**
     * Hold the next storage read open until the returned `release` is called.
     * Every read after it answers straight away, from `db`.
     */
    function holdNextRead() {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        storage.tryGet.mockImplementationOnce(async (key, store) => {
            await gate;
            return readDb(key, store);
        });
        return () => release();
    }

    /** What the mocked `tryGet` answers when the read works. */
    function readDb(key, store) {
        const bucket = db[store] || {};
        return Object.prototype.hasOwnProperty.call(bucket, key)
            ? { found: true, value: JSON.parse(JSON.stringify(bucket[key])) }
            : { found: false, value: null };
    }

    /** A second tab's history on disk, which a partial write would wipe out. */
    const WHISPER_KEY = tabKeyForChannel('/chat_channel_types/whisper');
    const WHISPER_LINE = '[9/26 9:00:00 AM] Bob: see you at the tower';
    function seedWhisperHistory() {
        db.settings[STORAGE_KEY].tabs[WHISPER_KEY] = [`<div class="ChatMessage_chatMessage__z">${WHISPER_LINE}</div>`];
    }

    test('a disable while the first read is still open never replaces the record with the live backlog', async () => {
        seedWhisperHistory();
        const release = holdNextRead();

        // The pane already shows lines when the handler attaches; they are
        // recorded before the read of the older history has come back.
        const container = buildPartyChat();
        container.appendChild(makeMessage(JOINED));
        container.appendChild(makeMessage(RUNS[0]));
        chatHistoryExtender.initialize();
        await settle();

        // A character switch, the setting turned off, or the page going away.
        chatHistoryExtender.disable();
        await settle();

        expect(storedTexts()).toEqual([OLD, JOINED, RUNS[0]]);
        expect(storedTexts(WHISPER_KEY)).toEqual([WHISPER_LINE]);

        // The held read finally lands on a torn-down instance: nothing changes.
        release();
        await settle();
        expect(storedTexts()).toEqual([OLD, JOINED, RUNS[0]]);
        expect(storedTexts(WHISPER_KEY)).toEqual([WHISPER_LINE]);
    });

    test('a page hide or socket close while the first read is open merges with disk, then the load merges too', async () => {
        seedWhisperHistory();
        const release = holdNextRead();

        const container = buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();
        container.appendChild(makeMessage(JOINED));
        await settle();

        webSocketHook.emitSocketEvent('close', {}, null);
        await settle();
        expect(storedTexts()).toEqual([OLD, JOINED]);
        expect(storedTexts(WHISPER_KEY)).toEqual([WHISPER_LINE]);

        container.appendChild(makeMessage(RUNS[0]));
        await settle();
        release();
        await settle();
        await chatHistoryPersistence.flush();
        expect(storedTexts()).toEqual([OLD, JOINED, RUNS[0]]);
        expect(storedTexts(WHISPER_KEY)).toEqual([WHISPER_LINE]);
    });

    test('the coalescing timer never writes before the first read has merged', async () => {
        vi.useFakeTimers();
        try {
            seedWhisperHistory();
            const release = holdNextRead();

            const container = buildPartyChat();
            chatHistoryExtender.initialize();
            await settle();
            container.appendChild(makeMessage(JOINED));
            await settle();

            await vi.advanceTimersByTimeAsync(10000);
            expect(storage.set).not.toHaveBeenCalled();

            release();
            await settle();
            await vi.advanceTimersByTimeAsync(10000);
            expect(storedTexts()).toEqual([OLD, JOINED]);
            expect(storedTexts(WHISPER_KEY)).toEqual([WHISPER_LINE]);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a read that never comes back never lets a write through', async () => {
        seedWhisperHistory();
        storage.tryGet.mockImplementation(() => new Promise(() => {}));
        try {
            const container = buildPartyChat();
            container.appendChild(makeMessage(JOINED));
            chatHistoryExtender.initialize();
            await settle();

            window.dispatchEvent(new Event('pagehide'));
            chatHistoryExtender.disable();
            await settle();

            expect(storage.set).not.toHaveBeenCalled();
            expect(storedTexts()).toEqual([OLD]);
            expect(storedTexts(WHISPER_KEY)).toEqual([WHISPER_LINE]);
        } finally {
            storage.tryGet.mockReset();
            storage.tryGet.mockImplementation(async (key, store) => readDb(key, store));
        }
    });

    // `storage.get` answers a failed read, an aborted transaction or a missing
    // connection with the default — indistinguishable from "nothing stored".
    // `tryGet` answers those with null, and null has to mean "do not write".
    test('an unreadable first read is not an empty record: nothing is written until a read works', async () => {
        seedWhisperHistory();
        storage.tryGet.mockResolvedValue(null);
        try {
            const container = buildPartyChat();
            container.appendChild(makeMessage(JOINED));
            chatHistoryExtender.initialize();
            await settle();
            expect(chatHistoryPersistence.loaded).toBe(false);

            // Every writer path: an explicit flush, a page hide, a socket close.
            await chatHistoryPersistence.flush();
            window.dispatchEvent(new Event('pagehide'));
            webSocketHook.emitSocketEvent('close', {}, null);
            await settle();
            expect(storage.set).not.toHaveBeenCalled();
            expect(storedTexts()).toEqual([OLD]);
            expect(storedTexts(WHISPER_KEY)).toEqual([WHISPER_LINE]);
        } finally {
            storage.tryGet.mockReset();
            storage.tryGet.mockImplementation(async (key, store) => readDb(key, store));
        }

        // Once the database answers again, the waiting lines merge with disk.
        window.dispatchEvent(new Event('pagehide'));
        await settle();
        expect(storedTexts()).toEqual([OLD, JOINED]);
        expect(storedTexts(WHISPER_KEY)).toEqual([WHISPER_LINE]);
    });

    test('a page close lands the waiting lines before the teardown closes storage', async () => {
        // The entrypoint's own `pagehide` listener is registered long before
        // any feature's, so it runs first.
        const entrypointPageHide = () => storage.closeForTeardown('pagehide');
        window.addEventListener('pagehide', entrypointPageHide);
        try {
            const container = buildPartyChat();
            chatHistoryExtender.initialize();
            await settle();
            expect(chatHistoryPersistence.loaded).toBe(true);
            container.appendChild(makeMessage(JOINED));
            await settle();

            window.dispatchEvent(new Event('pagehide'));
            await settle();
            expect(storedTexts()).toEqual([OLD, JOINED]);
        } finally {
            window.removeEventListener('pagehide', entrypointPageHide);
            db.closing = false;
        }
    });

    test('a disable stops the pre-teardown flush', async () => {
        buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();
        expect(db.teardown.size).toBe(1);

        await chatHistoryExtender.disable();
        expect(db.teardown.size).toBe(0);
    });

    test('a disable that throws part-way still stops the pre-teardown flush', async () => {
        buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();
        expect(db.teardown.size).toBe(1);

        const spy = vi.spyOn(chatHistoryPersistence, 'flushForTeardown').mockImplementationOnce(() => {
            throw new Error('boom');
        });
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await chatHistoryExtender.disable();
            expect(db.teardown.size).toBe(0);
        } finally {
            spy.mockRestore();
            errors.mockRestore();
        }
    });

    test('a failed first read is not remembered: the next load reads again once storage answers', async () => {
        storage.tryGet.mockResolvedValueOnce(null);
        buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();
        expect(chatHistoryPersistence.loaded).toBe(false);

        // A tab mounted later, after the database has recovered.
        const stored = await chatHistoryPersistence.load();
        expect((stored[PARTY_KEY] || []).map((html) => parseStoredMessage(html).textContent)).toEqual([OLD]);
        expect(chatHistoryPersistence.loaded).toBe(true);
    });

    test('a deletion after a failed first read reaches disk once storage answers', async () => {
        db.settings[STORAGE_KEY].tabs[PARTY_KEY].push(
            '<div class="ChatMessage_chatMessage__z" data-mwi-msg-id="77">deleted later</div>'
        );
        storage.tryGet.mockResolvedValueOnce(null);
        buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();
        expect(chatHistoryPersistence.loaded).toBe(false);

        await expect(chatHistoryPersistence.purgeMessageById(PARTY_KEY, 77)).resolves.toBe(true);
        await chatHistoryPersistence.flushPending();
        expect(storedTexts()).toEqual([OLD]);
    });

    test('a failed read finishing late does not drop a newer load', async () => {
        let failFirst;
        storage.tryGet.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    failFirst = () => resolve(null);
                })
        );
        chatHistoryPersistence.enable(() => MAX_MESSAGES_PER_TAB);
        const first = chatHistoryPersistence.load();
        await settle();

        // A teardown and a fresh session start their own read meanwhile.
        chatHistoryPersistence.reset();
        chatHistoryPersistence.enable(() => MAX_MESSAGES_PER_TAB);
        const second = chatHistoryPersistence.load();
        const secondRead = chatHistoryPersistence.loadPromise;

        failFirst();
        await expect(first).resolves.toEqual({});
        expect(chatHistoryPersistence.loadPromise).toBe(secondRead);
        await second;
        expect(chatHistoryPersistence.loaded).toBe(true);
    });

    test('an unreadable merge read writes nothing, even on the way out', async () => {
        seedWhisperHistory();
        const release = holdNextRead();
        // The load also reads the public record, which answers; the merge's own
        // read of the character's record is the one that cannot be made.
        storage.tryGet.mockImplementationOnce(async (key, store) => readDb(key, store));
        storage.tryGet.mockResolvedValueOnce(null);

        const container = buildPartyChat();
        container.appendChild(makeMessage(JOINED));
        chatHistoryExtender.initialize();
        await settle();

        chatHistoryExtender.disable();
        await settle();
        expect(storage.set).not.toHaveBeenCalled();

        release();
        await settle();
        expect(storage.set).not.toHaveBeenCalled();
        expect(storedTexts()).toEqual([OLD]);
        expect(storedTexts(WHISPER_KEY)).toEqual([WHISPER_LINE]);
    });

    test('a write storage refuses leaves the record waiting, so the next flush retries it', async () => {
        const container = buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();
        container.appendChild(makeMessage(JOINED));
        await settle();

        storage.set.mockResolvedValueOnce(false);
        await expect(chatHistoryPersistence.flushPending()).resolves.toBe(false);
        expect(storedTexts()).toEqual([OLD]);

        await expect(chatHistoryPersistence.flushPending()).resolves.toBe(true);
        expect(storedTexts()).toEqual([OLD, JOINED]);
    });

    test('a refused merge-and-write before the first read has merged is retried too', async () => {
        const release = holdNextRead();
        const container = buildPartyChat();
        chatHistoryExtender.initialize();
        await settle();
        container.appendChild(makeMessage(JOINED));
        await settle();

        storage.set.mockResolvedValueOnce(false);
        await expect(chatHistoryPersistence.flushPending()).resolves.toBe(false);
        expect(storedTexts()).toEqual([OLD]);

        await expect(chatHistoryPersistence.flushPending()).resolves.toBe(true);
        expect(storedTexts()).toEqual([OLD, JOINED]);
        release();
        await settle();
    });

    test('a disable and an immediate re-init for the same character does not read a record still being written', async () => {
        // Model storage's own write debounce: a non-immediate write sits in a
        // queue a read cannot see, the way `pendingWrites` does, and a later
        // write to the same key replaces it there.
        const queued = new Map();
        storage.set.mockImplementation(async (key, value, store, immediate) => {
            if (!immediate) {
                queued.set(key, value);
                return true;
            }
            queued.delete(key);
            db[store] = db[store] || {};
            db[store][key] = JSON.parse(JSON.stringify(value));
            return true;
        });
        try {
            const container = buildPartyChat();
            chatHistoryExtender.initialize();
            await settle();
            container.appendChild(makeMessage(JOINED));
            await settle();

            // The setting toggled off and straight back on, same character.
            chatHistoryExtender.disable();
            await settle();
            // The pane no longer shows the line, so the re-init cannot pick it
            // up off the screen — only storage can bring it back.
            container.replaceChildren();
            chatHistoryExtender.initialize();
            await settle();

            container.appendChild(makeMessage(RUNS[0]));
            await settle();
            window.dispatchEvent(new Event('pagehide'));
            await settle();

            expect(queued.size).toBe(0);
            expect(storedTexts()).toEqual([OLD, JOINED, RUNS[0]]);
        } finally {
            storage.set.mockReset();
            storage.set.mockImplementation(async (key, value, store) => {
                db.writes += 1;
                db[store] = db[store] || {};
                db[store][key] = JSON.parse(JSON.stringify(value));
                return true;
            });
        }
    });

    test('a re-init waits for the final write of the session it replaces before it reads', async () => {
        // A write that takes a while: it reaches `db` only when released, the
        // way an IndexedDB transaction completes after the call that started it.
        const inFlight = [];
        storage.set.mockImplementation(async (key, value, store) => {
            const copy = JSON.parse(JSON.stringify(value));
            await new Promise((resolve) => inFlight.push(resolve));
            db[store] = db[store] || {};
            db[store][key] = copy;
            return true;
        });
        const landWrites = async () => {
            while (inFlight.length) {
                inFlight.shift()();
                await settle();
            }
        };
        try {
            const container = buildPartyChat();
            chatHistoryExtender.initialize();
            await settle();
            container.appendChild(makeMessage(JOINED));
            await settle();

            // Toggled off and straight back on, same character, before the
            // final write has landed.
            const finalFlush = chatHistoryExtender.disable();
            container.replaceChildren();
            chatHistoryExtender.initialize();
            await settle();
            expect(inFlight).toHaveLength(1);

            await landWrites();
            await expect(finalFlush).resolves.toBe(true);

            container.appendChild(makeMessage(RUNS[0]));
            await settle();
            const hidden = chatHistoryPersistence.flushPending();
            await landWrites();
            await hidden;

            expect(storedTexts()).toEqual([OLD, JOINED, RUNS[0]]);
            // The restore of the new session shows the line the old one saved.
            expect(bufferTexts(container)).toEqual([OLD, JOINED]);
        } finally {
            await landWrites();
            storage.set.mockReset();
            storage.set.mockImplementation(async (key, value, store) => {
                db.writes += 1;
                db[store] = db[store] || {};
                db[store][key] = JSON.parse(JSON.stringify(value));
                return true;
            });
        }
    });

    test('messageIdentity ignores markup, so a re-rendered or id-stamped line is the same line', () => {
        const plain = `<div class="ChatMessage_chatMessage__z"><span>${JOINED}</span></div>`;
        const stamped = `<div class="ChatMessage_chatMessage__z" data-mwi-msg-id="42" data-processed="1"><span>${JOINED}</span></div>`;
        expect(messageIdentity(plain)).toBe(messageIdentity(stamped));
        expect(messageIdentity(plain)).not.toBe(messageIdentity(`<div>${RUNS[0]}</div>`));
        expect(messageIdentity('<div></div>')).toBeNull();
    });
});

/**
 * The leaderboard rank badge (leaderboard-rank-badges.js) is a span inserted right after a line's
 * `CharacterName_name`, inside the sender element: an icon and the rank as text. It is this session's
 * decoration, so it must not be stored, and its digits must not make two sightings of one line differ.
 */
describe('a rank badge beside a sender name', () => {
    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        observerReady.handlers = [];
        observerReady.domReady = true;
        db.settings = {};
        db.quota = false;
        db.writes = 0;
        openPlayerProfile.mockClear();
    });

    afterEach(async () => {
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    const lineHTML = (name, text = 'hello') =>
        '<div class="ChatMessage_chatMessage__2wc4V">' +
        '<span>[1/2 10:00:00] </span>' +
        '<span class="ChatMessage_name__1UZ8t ChatMessage_clickable__3Nt2s">' +
        '<div class="CharacterName_characterName__2FqyZ">' +
        `<div class="CharacterName_name__1amXp"><span>${name}</span></div></div></span>` +
        `<span>: ${text}</span></div>`;

    const line = (name, text) => {
        const host = document.createElement('div');
        host.innerHTML = lineHTML(name, text);
        return host.firstElementChild;
    };

    /**
     * Put a badge after the line's name element, the way leaderboard-rank-badges.js's `decorate` does.
     * @param {Element} el - A chat line
     * @param {number} rank
     * @returns {Element} The line
     */
    const addBadge = (el, rank) => {
        const badge = document.createElement('span');
        badge.setAttribute('data-toolasha-rank-badge', 'gold');
        badge.dataset.signature = `x|standard|milking|${rank}|1`;
        badge.title = `Milking · Standard rank ${rank} (3m ago)`;
        badge.innerHTML =
            '<svg viewBox="0 0 40 40" aria-hidden="true"><use href="/static/skills.svg#milking"></use></svg>';
        badge.appendChild(document.createTextNode(String(rank)));
        el.querySelector('[class*="CharacterName_name"]').insertAdjacentElement('afterend', badge);
        return el;
    };

    test('a badged line is stored without its badge, and is the same message as the unbadged line', () => {
        const html = serializeMessage(addBadge(line('Spice'), 12));
        expect(html).not.toContain('data-toolasha-rank-badge');
        expect(messageIdentity(html)).toBe(messageIdentity(serializeMessage(line('Spice'))));
    });

    test('a record an older build stored with a badge still matches the line without one', () => {
        // Built by hand: what the serializer wrote before it left badges out
        const stored = addBadge(line('Spice'), 12).outerHTML;
        expect(stored).toContain('data-toolasha-rank-badge');
        expect(messageIdentity(stored)).toBe(messageIdentity(serializeMessage(line('Spice'))));
        expect(messageIdentity(stored)).toBe(messageIdentity(addBadge(line('Spice'), 3).outerHTML));
    });

    test('a line seen unbadged and then evicted with a badge is stored once', async () => {
        const [container] = buildChat(['Local']);
        chatHistoryExtender.initialize();
        await settle();

        // Rendered before the board was cached, so recorded unbadged; the badge arrives while it is on screen
        const message = line('Spice');
        container.appendChild(message);
        await settle();
        addBadge(message, 12);
        await evict(container, message);
        await chatHistoryPersistence.flush();

        expect(db.settings[STORAGE_KEY].tabs['tab2:name:Local']).toHaveLength(1);
    });

    test('a restored record carries no stale badge and its name is still clickable', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { 'tab2:name:Local': [addBadge(line('Spice'), 12).outerHTML] },
        };
        const [container] = buildChat(['Local']);
        chatHistoryExtender.initialize();
        await settle();

        const buffer = container.querySelector('.mwi-history-buffer');
        expect(buffer.querySelector('[data-toolasha-rank-badge]')).toBeNull();
        const sender = buffer.querySelector('[class*="ChatMessage_name"]');
        expect(sender.dataset.mwiRestoredSender).toBe('Spice');
    });

    test('a click on a badge the badge module redraws on a restored line opens the profile', async () => {
        db.settings[STORAGE_KEY] = { v: 1, savedAt: 1, tabs: { 'tab2:name:Local': [lineHTML('Spice')] } };
        const [container] = buildChat(['Local']);
        chatHistoryExtender.initialize();
        await settle();

        const restored = container.querySelector('.mwi-history-buffer [class*="ChatMessage_chatMessage"]');
        addBadge(restored, 12);
        restored
            .querySelector('[data-toolasha-rank-badge] use')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(openPlayerProfile).toHaveBeenCalledWith('Spice', expect.anything());
    });
});

/**
 * Restored history is everything older than the game's own live backlog, and only that.
 *
 * The record holds lines that were live when they were saved, so it overlaps whatever the game renders
 * after a reload, and the overlap is not always exact: a line the game no longer renders (deleted, or a
 * client-only line the server never sends back) sits in the record between lines it does render. Above the
 * live backlog it is out of order, so it is not restored.
 */
describe('restored history ends where the live backlog begins', () => {
    const GUILD = '/chat_channel_types/guild';
    const GUILD_KEY = tabKeyForChannel(GUILD);

    /** The Guild tab open, a whisper tab beside it, one pane. */
    function buildGuildChat() {
        document.body.innerHTML = '<div id="root"><div class="Chat_tabsComponentContainer__x"></div></div>';
        const strip = document.querySelector('.Chat_tabsComponentContainer__x');
        const guild = document.createElement('button');
        guild.setAttribute('role', 'tab');
        guild.setAttribute('data-mention-channel', GUILD);
        guild.setAttribute('aria-selected', 'true');
        guild.textContent = 'Guild';
        const whisper = document.createElement('button');
        whisper.setAttribute('role', 'tab');
        whisper.setAttribute('aria-selected', 'false');
        whisper.textContent = 'Whisper';
        strip.append(guild, whisper);
        const container = document.createElement('div');
        container.className = 'ChatHistory_chatHistory__abc';
        document.getElementById('root').appendChild(container);
        return container;
    }

    /** @param {'Guild'|'Whisper'} label */
    function openTab(label) {
        for (const button of document.querySelectorAll('button[role="tab"]')) {
            button.setAttribute('aria-selected', button.textContent === label ? 'true' : 'false');
        }
    }

    /**
     * A player chat line in the game's markup: timestamp, clickable sender, body.
     * @param {string} time - e.g. `9:55:47 AM`
     * @param {string} sender
     * @param {string} body
     * @returns {string} HTML
     */
    const lineHTML = (time, sender, body) =>
        '<div class="ChatMessage_chatMessage__2wc4V">' +
        `<span class="ChatMessage_timestamp__3VbX6">[10/1 ${time}]</span> ` +
        '<span class="ChatMessage_name__1UZ8t ChatMessage_clickable__3Nt2s">' +
        '<div class="CharacterName_characterName__2FqyZ">' +
        `<div class="CharacterName_name__1amXp" data-name="${sender}"><span>${sender}</span></div></div></span>` +
        `<span>: </span><span>${body}</span></div>`;

    const line = (time, sender, body) => {
        const host = document.createElement('div');
        host.innerHTML = lineHTML(time, sender, body);
        return host.firstElementChild;
    };

    const OLD_1 = ['9:55:47 AM', 'Kasvitatti', 'morning all'];
    const OLD_2 = ['9:56:17 AM', 'Kasvitatti', 'anyone up for a run'];
    const LIVE_1 = ['9:56:21 AM', 'Benny', 'sure'];
    const GONE = ['12:50:31 PM', 'Spice', 'this line is no longer sent'];
    const LIVE_2 = ['2:51:36 PM', 'Benny', 'Gzz poma'];

    const text = (parts) => line(...parts).textContent;
    const bufferTexts = (container) =>
        [...container.querySelectorAll('.mwi-history-buffer [class*="ChatMessage_chatMessage"]')].map(
            (el) => el.textContent
        );
    const liveTexts = (container) =>
        [...container.children]
            .filter((el) => el.className.includes('ChatMessage_chatMessage'))
            .map((el) => el.textContent);

    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        observerReady.handlers = [];
        observerReady.domReady = true;
        db.settings = {
            [STORAGE_KEY]: {
                v: 1,
                savedAt: 1,
                tabs: { [GUILD_KEY]: [OLD_1, OLD_2, LIVE_1, GONE, LIVE_2].map((parts) => lineHTML(...parts)) },
            },
        };
        db.quota = false;
        db.writes = 0;
        openPlayerProfile.mockClear();
    });

    afterEach(async () => {
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    test('a stored line newer than the start of the live backlog is not restored above it', async () => {
        const container = buildGuildChat();
        container.append(line(...LIVE_1), line(...LIVE_2));
        chatHistoryExtender.initialize();
        await settle();

        expect(bufferTexts(container)).toEqual([text(OLD_1), text(OLD_2)]);
        expect(liveTexts(container)).toEqual([text(LIVE_1), text(LIVE_2)]);
    });

    test('the same holds when the backlog renders after the restore has landed', async () => {
        const container = buildGuildChat();
        chatHistoryExtender.initialize();
        await settle();
        expect(bufferTexts(container)).toHaveLength(5);

        container.append(line(...LIVE_1), line(...LIVE_2));
        await settle();

        expect(bufferTexts(container)).toEqual([text(OLD_1), text(OLD_2)]);
    });

    test('a tab round trip keeps the lines this session evicted', async () => {
        // Nothing of today's on disk yet: the live lines are first seen this session
        db.settings[STORAGE_KEY].tabs[GUILD_KEY] = [OLD_1, OLD_2].map((parts) => lineHTML(...parts));
        const container = buildGuildChat();
        const live1 = line(...LIVE_1);
        const live2 = line(...LIVE_2);
        container.append(live1, live2);
        chatHistoryExtender.initialize();
        await settle();

        await evict(container, live1);
        expect(bufferTexts(container)).toEqual([text(OLD_1), text(OLD_2), text(LIVE_1)]);

        // To the whisper tab: the pane's contents are swapped in one commit
        const whisper = line('3:00:00 PM', 'Spice', 'psst');
        container.removeChild(live2);
        container.appendChild(whisper);
        openTab('Whisper');
        await settle();
        expect(bufferTexts(container)).not.toContain(text(LIVE_1));

        // And back: the game renders what it still holds, which no longer includes the evicted line
        container.removeChild(whisper);
        container.appendChild(line(...LIVE_2));
        openTab('Guild');
        await settle();

        expect(bufferTexts(container)).toEqual([text(OLD_1), text(OLD_2), text(LIVE_1)]);
        expect(liveTexts(container)).toEqual([text(LIVE_2)]);
    });

    describe('two genuine messages sharing an identity', () => {
        // Same second, sender and text: the store keeps one entry, at the earlier one's position.
        const DUP = ['9:56:21 AM', 'Benny', 'gg'];
        const MID_1 = ['9:56:21 AM', 'Kasvitatti', 'between one'];
        const MID_2 = ['9:56:21 AM', 'Spice', 'between two'];

        beforeEach(() => {
            db.settings[STORAGE_KEY].tabs[GUILD_KEY] = [OLD_1, DUP, MID_1, MID_2, LIVE_2].map((parts) =>
                lineHTML(...parts)
            );
        });

        test('the lines between the earlier copy and the live one are restored', async () => {
            const container = buildGuildChat();
            container.append(line(...DUP), line(...LIVE_2));
            chatHistoryExtender.initialize();
            await settle();

            expect(bufferTexts(container)).toEqual([text(OLD_1), text(MID_1), text(MID_2)]);
            expect(liveTexts(container)).toEqual([text(DUP), text(LIVE_2)]);
        });

        test('and when the backlog renders after the restore landed', async () => {
            const container = buildGuildChat();
            chatHistoryExtender.initialize();
            await settle();
            expect(bufferTexts(container)).toHaveLength(5);

            container.append(line(...DUP), line(...LIVE_2));
            await settle();

            expect(bufferTexts(container)).toEqual([text(OLD_1), text(MID_1), text(MID_2)]);
        });
    });

    test('a record a build before the badge fix stored each badged line in twice restores and keeps it once', async () => {
        // That build stored a line at render and again at eviction, and the badge (its rank changing in
        // between) made each copy a message of its own: two or three entries for one line, filling the cap
        const badged = (parts, rank) =>
            lineHTML(...parts).replace(
                '</div></div></span>',
                `</div><span data-toolasha-rank-badge="gold"><svg viewBox="0 0 40 40"><use href="/static/skills.svg#milking"></use></svg>${rank}</span></div></span>`
            );
        db.settings[STORAGE_KEY].tabs[GUILD_KEY] = [
            lineHTML(...OLD_1),
            badged(OLD_1, 12),
            badged(OLD_1, 11),
            lineHTML(...OLD_2),
            lineHTML(...LIVE_1),
            badged(LIVE_1, 4),
        ];
        const container = buildGuildChat();
        container.append(line(...LIVE_1));
        chatHistoryExtender.initialize();
        await settle();

        expect(bufferTexts(container)).toEqual([text(OLD_1), text(OLD_2)]);

        chatHistoryPersistence.record(GUILD_KEY, serializeMessage(line('3:00:00 PM', 'Spice', 'new')));
        await chatHistoryPersistence.flush();
        expect(db.settings[STORAGE_KEY].tabs[GUILD_KEY]).toHaveLength(4);
    });

    test('a restored sender name opens the profile, after a tab round trip too', async () => {
        const container = buildGuildChat();
        const live = line(...LIVE_1);
        container.appendChild(live);
        chatHistoryExtender.initialize();
        await settle();

        const clickName = () => {
            const name = container.querySelector('.mwi-history-buffer [class*="CharacterName_name"] span');
            name.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        };
        clickName();
        expect(openPlayerProfile).toHaveBeenCalledWith('Kasvitatti', expect.anything());

        const whisper = line('3:00:00 PM', 'Spice', 'psst');
        container.removeChild(live);
        container.appendChild(whisper);
        openTab('Whisper');
        await settle();
        container.removeChild(whisper);
        container.appendChild(line(...LIVE_1));
        openTab('Guild');
        await settle();

        openPlayerProfile.mockClear();
        clickName();
        expect(openPlayerProfile).toHaveBeenCalledWith('Kasvitatti', expect.anything());
    });
});

describe('the cap counts lines older than the game’s live backlog', () => {
    const CAP = 10;
    const LIVE = 8;
    const line = (i) => `[1/2 10:00:${String(i).padStart(2, '0')}] line ${i}`;
    const bufferTexts = (container) =>
        [...container.querySelectorAll('.mwi-history-buffer [class*="ChatMessage_chatMessage"]')].map(
            (el) => el.textContent
        );
    const html = (i) => `<div class="ChatMessage_chatMessage__z">${line(i)}</div>`;
    const KEY = 'tab2:name:Local';

    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = CAP;
        observerReady.handlers = [];
        observerReady.domReady = true;
        db.settings = {};
        db.quota = false;
        db.writes = 0;
    });

    afterEach(async () => {
        settingValues.chatHistoryExtender_maxHistory = null;
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    test('a reload restores the full cap of older lines even though LIVE lines are still on screen', async () => {
        const [container] = buildChat(['Local']);
        const nodes = Array.from({ length: CAP + LIVE }, (_, i) => makeMessage(line(i)));
        container.append(...nodes);
        chatHistoryExtender.initialize();
        await settle();

        // The game drops its oldest CAP lines and keeps LIVE.
        for (const node of nodes.slice(0, CAP)) await evict(container, node);
        await chatHistoryPersistence.flush();
        expect(db.settings[STORAGE_KEY].tabs[KEY]).toHaveLength(CAP + LIVE);

        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        const [reloaded] = buildChat(['Local']);
        reloaded.append(...nodes.slice(CAP).map((n) => makeMessage(n.textContent)));
        chatHistoryExtender.initialize();
        await settle();

        expect(bufferTexts(reloaded)).toEqual(Array.from({ length: CAP }, (_, i) => line(i)));
    });

    test('a full record keeps the whole cap of older lines when the backlog renders after the restore', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { [KEY]: Array.from({ length: CAP + LIVE }, (_, i) => html(i)) },
            live: { [KEY]: LIVE },
        };
        const [container] = buildChat(['General']);
        chatHistoryExtender.initialize();
        await settle();

        // Nothing is live yet, so the whole record is restored.
        expect(bufferTexts(container)).toHaveLength(CAP + LIVE);

        container.append(...Array.from({ length: LIVE }, (_, i) => makeMessage(line(CAP + i))));
        await settle();

        expect(bufferTexts(container)).toEqual(Array.from({ length: CAP }, (_, i) => line(i)));
    });

    test('new live lines on a full record do not push its oldest entries out', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { [KEY]: Array.from({ length: CAP + LIVE }, (_, i) => html(i)) },
            live: { [KEY]: LIVE },
        };
        const [container] = buildChat(['General']);
        container.append(...Array.from({ length: LIVE }, (_, i) => makeMessage(line(CAP + i))));
        chatHistoryExtender.initialize();
        await settle();

        // The game's backlog grows by one without evicting anything.
        container.appendChild(makeMessage(line(CAP + LIVE)));
        await settle();
        await chatHistoryPersistence.flush();

        const stored = db.settings[STORAGE_KEY].tabs[KEY];
        expect(stored).toHaveLength(CAP + LIVE + 1);
        expect(stored[0]).toBe(html(0));
        expect(db.settings[STORAGE_KEY].live[KEY]).toBe(LIVE + 1);
    });

    test('a tab that is not mounted keeps its lines, past the plain cap, through another tab’s writes', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { [KEY]: Array.from({ length: CAP + LIVE }, (_, i) => html(i)) },
            live: { [KEY]: LIVE },
        };
        const [container] = buildChat(['Local', 'Other'], 1);
        container.appendChild(makeMessage(line(99)));
        chatHistoryExtender.initialize();
        await settle();
        await chatHistoryPersistence.flush();

        expect(db.settings[STORAGE_KEY].tabs[KEY]).toHaveLength(CAP + LIVE);
        expect(db.settings[STORAGE_KEY].live[KEY]).toBe(LIVE);
    });

    test('a tab reopened with a larger backlog than it was saved with does not lose its oldest entries', async () => {
        const SAVED_LIVE = 3;
        const NOW_LIVE = 8;
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { [KEY]: Array.from({ length: CAP + SAVED_LIVE }, (_, i) => html(i)) },
            live: { [KEY]: SAVED_LIVE },
        };
        const [container] = buildChat(['General', 'Other'], 1);
        const other = makeMessage('[1/2 11:00:00] other tab line');
        container.appendChild(other);
        chatHistoryExtender.initialize();
        await settle();

        // To General, whose pane now renders more lines than it was saved with
        container.removeChild(other);
        container.append(...Array.from({ length: NOW_LIVE }, (_, i) => makeMessage(line(50 + i))));
        selectTab(0);
        await settle();
        await chatHistoryPersistence.flush();

        const stored = db.settings[STORAGE_KEY].tabs[KEY];
        // The cap is CAP older lines plus what is live now; the allowance of 3 would have cut it to CAP + 3.
        expect(stored).toHaveLength(CAP + NOW_LIVE);
        expect(stored.at(-1)).toContain(line(50 + NOW_LIVE - 1));
        expect(db.settings[STORAGE_KEY].live[KEY]).toBe(NOW_LIVE);
    });

    test('a tab with no known live count gets the full allowance, not a bare cap', () => {
        const tabs = { [KEY]: Array.from({ length: 400 }, (_, i) => `<div>${i}</div>`) };
        applyCaps(tabs, 10, {});
        expect(tabs[KEY]).toHaveLength(10 + MAX_LIVE_ALLOWANCE);
        // The newest survive.
        expect(tabs[KEY].at(-1)).toBe('<div>399</div>');
    });

    test('the ceiling holds whatever live count is claimed', async () => {
        chatHistoryPersistence.enable(() => MAX_MESSAGES_PER_TAB);
        chatHistoryPersistence.setLiveCount(KEY, 10_000);
        for (let i = 0; i < MAX_MESSAGES_PER_TAB + MAX_LIVE_ALLOWANCE + 30; i += 1) {
            chatHistoryPersistence.record(KEY, `<div class="ChatMessage_chatMessage__z">m${i}</div>`);
        }
        expect(chatHistoryPersistence.tabs[KEY]).toHaveLength(MAX_MESSAGES_PER_TAB + MAX_LIVE_ALLOWANCE);

        const tabs = { [KEY]: Array.from({ length: 1000 }, (_, i) => `<div>${i}</div>`) };
        applyCaps(tabs, 150, { [KEY]: 1e9 });
        expect(tabs[KEY]).toHaveLength(MAX_MESSAGES_PER_TAB + MAX_LIVE_ALLOWANCE);
    });

    test('without a live count, a plain applyCaps is still the plain cap', () => {
        const tabs = { [KEY]: Array.from({ length: 40 }, (_, i) => `<div>${i}</div>`) };
        applyCaps(tabs, 10);
        expect(tabs[KEY]).toHaveLength(10);
    });

    test('the merge path (a flush before the first read lands) keeps the extra lines too', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { [KEY]: Array.from({ length: CAP + LIVE }, (_, i) => html(i)) },
            live: { [KEY]: LIVE },
        };
        chatHistoryPersistence.enable(() => CAP);
        // Not loaded: this goes through _mergeIntoStored.
        chatHistoryPersistence.record('tab2:name:Other', html(500));
        await chatHistoryPersistence.flush(true);

        expect(db.settings[STORAGE_KEY].tabs[KEY]).toHaveLength(CAP + LIVE);
        expect(db.settings[STORAGE_KEY].tabs['tab2:name:Other']).toHaveLength(1);
    });

    test('a non-numeric or unmounted live count in a stored record is read as the allowance, never trusted', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { [KEY]: Array.from({ length: 60 }, (_, i) => html(i)) },
            live: { [KEY]: 'lots' },
        };
        chatHistoryPersistence.enable(() => CAP);
        await chatHistoryPersistence.load();
        expect(chatHistoryPersistence.messagesFor(KEY)).toHaveLength(60);
    });
});
