/** @vitest-environment happy-dom */

/**
 * A character moving between guilds while the Guild pane stays mounted.
 *
 * The tab key is `Guild` before and after, so the extender cannot see the move
 * from the pane; it is told by the roster message, which may arrive before or
 * after the game re-renders the pane. Either way, no line of the old guild may
 * stay on screen beside the new one or be written into the new guild's record.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true), getSettingValue: vi.fn(() => undefined) },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn(() => () => {}),
        onReady: vi.fn((name, callback) => {
            callback();
            return () => {};
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

const db = vi.hoisted(() => ({ settings: {} }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async (key, store, fallback = null) => db[store]?.[key] ?? fallback),
        tryGet: vi.fn(async (key, store) => {
            if (db.gate) await db.gate;
            const bucket = db[store] || {};
            return key in bucket
                ? { found: true, value: JSON.parse(JSON.stringify(bucket[key])) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store) => {
            db[store] = db[store] || {};
            db[store][key] = JSON.parse(JSON.stringify(value));
            return true;
        }),
        update: vi.fn(async (key, mutate, store) => {
            db[store] = db[store] || {};
            const found = key in db[store];
            const next = mutate(found ? JSON.parse(JSON.stringify(db[store][key])) : undefined, found);
            if (next === undefined) return { written: false, value: db[store][key] };
            db[store][key] = JSON.parse(JSON.stringify(next));
            return { written: true, value: JSON.parse(JSON.stringify(next)) };
        }),
        isQuotaExceeded: vi.fn(() => false),
        onBeforeTeardown: vi.fn(() => () => {}),
    },
}));

const character = vi.hoisted(() => ({ data: null }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => '101',
        get characterData() {
            return character.data;
        },
        getItemDetails: () => null,
    },
}));
vi.mock('../../utils/character-key.js', () => ({ characterKey: (base) => `${base}_101` }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: vi.fn() }));
vi.mock('../../utils/profile-command.js', () => ({
    openPlayerProfile: vi.fn(),
    fillProfileCommand: vi.fn(),
    findChatInput: vi.fn(() => null),
    getGameCore: vi.fn(() => null),
    VALID_PLAYER_NAME_RE: /^[A-Za-z0-9_]+$/,
}));

import chatHistoryExtender from './chat-history-extender.js';
import chatHistoryPersistence, { guildRecordKey } from './chat-history-persistence.js';

const GUILD = 'tab2:ch:/chat_channel_types/guild';

const rosterFor = (guildId) => ({ guildCharacterMap: { 101: { characterID: '101', guildID: guildId } } });
const settle = async () => {
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A chat line in the game's markup; `text` is what the tests read back. */
function makeMessage(text, second) {
    const el = document.createElement('div');
    el.className = 'ChatMessage_chatMessage__xyz';
    el.innerHTML =
        `<span>[12:00:${String(second).padStart(2, '0')} PM] </span>` +
        '<span class="ChatMessage_name__1UZ8t ChatMessage_clickable__3Nt2s">' +
        '<div class="CharacterName_characterName__2FqyZ">' +
        '<div class="CharacterName_name__1amXp"><span>Ada</span></div></div></span>' +
        `<span>: ${text}</span>`;
    return el;
}

const storedLine = (text, second) => makeMessage(text, second).outerHTML;
const textOf = (el) => el.querySelector(':scope > span:last-child')?.textContent.replace(/^: /, '');
/** A record's Guild lines as plain text, one string per line. */
const recordTexts = (key) => (db.settings[key]?.tabs?.[GUILD] || []).map((html) => html.replace(/<[^>]*>/g, ''));
const recordHas = (key, text) => recordTexts(key).some((line) => line.includes(text));

describe('a guild change with the Guild pane mounted', () => {
    let container;
    let g1Lines;

    /** Everything the pane shows: restored and evicted history above the live lines. */
    const shown = () => [...container.querySelectorAll('.ChatMessage_chatMessage__xyz')].map(textOf);

    beforeEach(async () => {
        db.settings = {
            [guildRecordKey('g2')]: { v: 1, savedAt: 1, tabs: { [GUILD]: [storedLine('g2 history', 1)] }, live: {} },
        };
        character.data = {
            character: { id: '101' },
            guild: { id: 'g1' },
            guildCharacterMap: { 101: { characterID: '101', guildID: 'g1' } },
        };
        document.body.innerHTML = '<div id="root"><div class="Chat_tabsComponentContainer__x"></div></div>';
        const button = document.createElement('button');
        button.setAttribute('role', 'tab');
        button.setAttribute('data-mention-channel', '/chat_channel_types/guild');
        button.setAttribute('aria-selected', 'true');
        button.textContent = 'Guild';
        document.querySelector('.Chat_tabsComponentContainer__x').appendChild(button);
        container = document.createElement('div');
        container.className = 'ChatHistory_chatHistory__abc';
        document.getElementById('root').appendChild(container);
        g1Lines = [makeMessage('g1 one', 10), makeMessage('g1 two', 11)];
        g1Lines.forEach((el) => container.appendChild(el));

        chatHistoryExtender.initialize();
        await settle();
    });

    afterEach(async () => {
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    /** The game replaces the old guild's lines with the new guild's backlog. */
    const rerender = async () => {
        g1Lines.forEach((el) => el.remove());
        container.appendChild(makeMessage('g2 live', 20));
        await settle();
    };

    const expectCleanSwitch = async () => {
        await chatHistoryPersistence.flush();
        const visible = shown();
        expect(visible).not.toContain('g1 one');
        expect(visible).not.toContain('g1 two');
        expect(visible).toContain('g2 history');
        expect(visible).toContain('g2 live');
        expect(recordHas(guildRecordKey('g2'), 'g1 one')).toBe(false);
        expect(recordHas(guildRecordKey('g2'), 'g1 two')).toBe(false);
        expect(recordHas(guildRecordKey('g2'), 'g2 history')).toBe(true);
    };

    test('roster message before the pane re-renders', async () => {
        wsHandlers.guild_characters_updated(rosterFor('g2'));
        await settle();
        await rerender();
        await expectCleanSwitch();
    });

    test('roster message after the pane re-renders', async () => {
        await rerender();
        wsHandlers.guild_characters_updated(rosterFor('g2'));
        await settle();
        await expectCleanSwitch();
    });

    test('lines the new guild showed before the roster never reach the old guild record', async () => {
        await rerender();
        // The pane re-rendered first: its new lines arrive while the context still names g1.
        container.appendChild(makeMessage('g2 second', 21));
        await settle();
        await chatHistoryPersistence.flush();
        expect(recordHas(guildRecordKey('g1'), 'g2 live')).toBe(false);
        expect(recordHas(guildRecordKey('g1'), 'g2 second')).toBe(false);

        wsHandlers.guild_characters_updated(rosterFor('g2'));
        await settle();
        await chatHistoryPersistence.flush();

        for (const text of ['g2 live', 'g2 second']) {
            expect(recordHas(guildRecordKey('g1'), text)).toBe(false);
            expect(recordHas(guildRecordKey('g2'), text)).toBe(true);
        }
        // What the old guild did show is still its own.
        expect(recordHas(guildRecordKey('g1'), 'g1 one')).toBe(true);
        expect(recordHas(guildRecordKey('g2'), 'g1 one')).toBe(false);
        expect(shown()).toEqual(expect.arrayContaining(['g2 history', 'g2 live', 'g2 second']));
    });

    test('a re-render that was no guild change merges back into the same guild once the window passes', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        try {
            await rerender();
            await chatHistoryPersistence.flush();
            expect(recordHas(guildRecordKey('g1'), 'g2 live')).toBe(false);
            vi.advanceTimersByTime(20000);
            await chatHistoryPersistence.flush();
            expect(recordHas(guildRecordKey('g1'), 'g2 live')).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a roster that names the same guild releases the held lines to it', async () => {
        await rerender();
        wsHandlers.guild_characters_updated(rosterFor('g1'));
        await settle();
        await chatHistoryPersistence.flush();
        expect(recordHas(guildRecordKey('g1'), 'g2 live')).toBe(true);
    });

    test('an eviction after the switch has been handled is recorded again', async () => {
        wsHandlers.guild_characters_updated(rosterFor('g2'));
        await settle();
        await rerender();
        const live = [...container.querySelectorAll('.ChatMessage_chatMessage__xyz')].find(
            (el) => textOf(el) === 'g2 live'
        );
        live.remove();
        await settle();
        await chatHistoryPersistence.flush();
        expect(recordHas(guildRecordKey('g2'), 'g2 live')).toBe(true);
    });
});

describe('a guild change while the first read is still in flight', () => {
    afterEach(async () => {
        db.gate = null;
        await chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    test('the new guild is read once that first read lands', async () => {
        db.settings = {
            [guildRecordKey('g2')]: { v: 1, savedAt: 1, tabs: { [GUILD]: [storedLine('g2 history', 1)] }, live: {} },
        };
        character.data = {
            character: { id: '101' },
            guild: { id: 'g1' },
            guildCharacterMap: { 101: { characterID: '101', guildID: 'g1' } },
        };
        document.body.innerHTML = '<div id="root"><div class="Chat_tabsComponentContainer__x"></div></div>';
        const button = document.createElement('button');
        button.setAttribute('role', 'tab');
        button.setAttribute('data-mention-channel', '/chat_channel_types/guild');
        button.setAttribute('aria-selected', 'true');
        button.textContent = 'Guild';
        document.querySelector('.Chat_tabsComponentContainer__x').appendChild(button);
        const container = document.createElement('div');
        container.className = 'ChatHistory_chatHistory__abc';
        document.getElementById('root').appendChild(container);
        container.appendChild(makeMessage('g1 one', 10));

        let release;
        db.gate = new Promise((resolve) => {
            release = resolve;
        });
        chatHistoryExtender.initialize();
        await settle();
        // The roster moves the character while the first read is still waiting on storage
        wsHandlers.guild_characters_updated(rosterFor('g2'));
        await settle();
        release();
        await settle();

        const shown = [...container.querySelectorAll('.ChatMessage_chatMessage__xyz')].map(textOf);
        expect(shown).toContain('g2 history');
    });
});
