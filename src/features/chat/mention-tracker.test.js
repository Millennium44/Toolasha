/**
 * @vitest-environment happy-dom
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ setting: true, characterName: 'Millennium44', wsHandlers: {}, observers: {} }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterName: () => game.characterName },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.wsHandlers[event] === handler) delete game.wsHandlers[event];
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (id, className, callback) => {
            game.observers[className] = callback;
            return () => delete game.observers[className];
        },
    },
}));
vi.mock('./mention-popup.js', () => ({
    default: { open: vi.fn(), close: vi.fn() },
}));

const mentionTracker = (await import('./mention-tracker.js')).default;

function chatMessage(overrides = {}) {
    return {
        message: { sName: 'Someone', m: 'hello', chan: '/chat_channel_types/general', t: 1000, ...overrides },
    };
}

describe('mention tracker — detection', () => {
    beforeEach(async () => {
        game.setting = true;
        game.characterName = 'Millennium44';
        game.wsHandlers = {};
        game.observers = {};
        mentionTracker.disable();
        document.body.innerHTML = '';
        await mentionTracker.initialize();
    });

    test('disabled by setting, initialize does not subscribe', async () => {
        mentionTracker.disable();
        game.setting = false;
        await mentionTracker.initialize();

        expect(game.wsHandlers.chat_message_received).toBeUndefined();
    });

    test('without a character name yet, initialize leaves itself uninitialized for a later retry', async () => {
        mentionTracker.disable();
        game.characterName = null;
        await mentionTracker.initialize();

        expect(mentionTracker.initialized).toBe(false);
        expect(game.wsHandlers.chat_message_received).toBeUndefined();
    });

    test('a message with an @name mention is recorded', () => {
        game.wsHandlers.chat_message_received(chatMessage({ m: 'hey @Millennium44 check this out' }));

        expect(mentionTracker.mentionLog.get('/chat_channel_types/general')).toHaveLength(1);
    });

    test('the match is case-insensitive', () => {
        game.wsHandlers.chat_message_received(chatMessage({ m: '@MILLENNIUM44 hi' }));

        expect(mentionTracker.mentionLog.get('/chat_channel_types/general')).toHaveLength(1);
    });

    test('a name that is a prefix of another word is not a mention', () => {
        game.wsHandlers.chat_message_received(chatMessage({ m: '@Millennium44Junior said hi' }));

        expect(mentionTracker.mentionLog.get('/chat_channel_types/general')).toBeUndefined();
    });

    test('a message with no mention is not recorded', () => {
        game.wsHandlers.chat_message_received(chatMessage({ m: 'just chatting' }));

        expect(mentionTracker.mentionLog.get('/chat_channel_types/general')).toBeUndefined();
    });

    test('a system message never counts as a mention, even with @name text', () => {
        game.wsHandlers.chat_message_received(chatMessage({ m: '@Millennium44', isSystemMessage: true }));

        expect(mentionTracker.mentionLog.get('/chat_channel_types/general')).toBeUndefined();
    });

    test('a message with no sender name is ignored', () => {
        game.wsHandlers.chat_message_received(chatMessage({ m: '@Millennium44', sName: undefined }));

        expect(mentionTracker.mentionLog.get('/chat_channel_types/general')).toBeUndefined();
    });

    test('a null message payload does not throw', () => {
        expect(() => game.wsHandlers.chat_message_received({})).not.toThrow();
    });

    test('a character name with regex metacharacters is escaped safely', () => {
        mentionTracker.disable();
        game.characterName = 'A.B+C';
        return mentionTracker.initialize().then(() => {
            game.wsHandlers.chat_message_received(chatMessage({ m: '@A.B+C hi' }));
            expect(mentionTracker.mentionLog.get('/chat_channel_types/general')).toHaveLength(1);

            // A literal-dot match should not accidentally match "AxB+C" (dot as wildcard)
            game.wsHandlers.chat_message_received(chatMessage({ m: '@AxB+C hi', chan: '/chat_channel_types/party' }));
            expect(mentionTracker.mentionLog.get('/chat_channel_types/party')).toBeUndefined();
        });
    });

    test('mentions in different channels are tracked separately', () => {
        game.wsHandlers.chat_message_received(chatMessage({ m: '@Millennium44 a', chan: '/chat_channel_types/party' }));
        game.wsHandlers.chat_message_received(chatMessage({ m: '@Millennium44 b', chan: '/chat_channel_types/guild' }));

        expect(mentionTracker.mentionLog.get('/chat_channel_types/party')).toHaveLength(1);
        expect(mentionTracker.mentionLog.get('/chat_channel_types/guild')).toHaveLength(1);
    });
});

describe('mention tracker — tabs and badges', () => {
    function buildTabs(names) {
        const container = document.createElement('div');
        container.className = 'Chat_tabsComponentContainer__3ZoKe';
        for (const name of names) {
            const btn = document.createElement('button');
            btn.className = 'MuiButtonBase-root';
            btn.textContent = name;
            container.appendChild(btn);
        }
        document.body.appendChild(container);
        return container;
    }

    beforeEach(async () => {
        game.setting = true;
        game.characterName = 'Millennium44';
        game.wsHandlers = {};
        game.observers = {};
        mentionTracker.disable();
        document.body.innerHTML = '';
        await mentionTracker.initialize();
    });

    test('a mention adds a numeric badge to the matching tab', () => {
        const container = buildTabs(['Party', 'Guild']);
        game.observers['Chat_tabsComponentContainer'](container);

        game.wsHandlers.chat_message_received(chatMessage({ m: '@Millennium44', chan: '/chat_channel_types/party' }));

        const partyBtn = container.querySelector('[data-mention-channel="/chat_channel_types/party"]');
        expect(partyBtn.querySelector('.mwi-mention-badge').textContent).toBe('1');
    });

    test('a trailing unread-count digit on the tab name does not block channel matching', () => {
        const container = buildTabs(['General2']);
        game.observers['Chat_tabsComponentContainer'](container);

        game.wsHandlers.chat_message_received(chatMessage({ m: '@Millennium44', chan: '/chat_channel_types/general' }));

        const btn = container.querySelector('button');
        expect(btn.dataset.mentionChannel).toBe('/chat_channel_types/general');
    });

    test('an unrecognized tab name gets no channel and no badge', () => {
        const container = buildTabs(['SomeRandomTab']);
        game.observers['Chat_tabsComponentContainer'](container);

        const btn = container.querySelector('button');
        expect(btn.dataset.mentionChannel).toBeUndefined();
    });

    test('a count above 99 displays as "99+"', () => {
        const container = buildTabs(['Party']);
        game.observers['Chat_tabsComponentContainer'](container);

        for (let i = 0; i < 105; i++) {
            game.wsHandlers.chat_message_received(chatMessage({ m: '@Millennium44', chan: '/chat_channel_types/party' }));
        }

        expect(container.querySelector('.mwi-mention-badge').textContent).toBe('99+');
    });

    test('clicking the tab clears its mentions and removes the badge', () => {
        const container = buildTabs(['Party']);
        game.observers['Chat_tabsComponentContainer'](container);
        game.wsHandlers.chat_message_received(chatMessage({ m: '@Millennium44', chan: '/chat_channel_types/party' }));

        const btn = container.querySelector('button');
        btn.click();

        expect(mentionTracker.mentionLog.get('/chat_channel_types/party')).toHaveLength(0);
        expect(btn.querySelector('.mwi-mention-badge')).toBeNull();
    });

    test('clearMentions on a channel with no log entry is a no-op', () => {
        expect(() => mentionTracker.clearMentions('/chat_channel_types/nonexistent')).not.toThrow();
    });

    test('disable removes every badge and clears the log', () => {
        const container = buildTabs(['Party']);
        game.observers['Chat_tabsComponentContainer'](container);
        game.wsHandlers.chat_message_received(chatMessage({ m: '@Millennium44', chan: '/chat_channel_types/party' }));

        mentionTracker.disable();

        expect(document.querySelector('.mwi-mention-badge')).toBeNull();
        expect(mentionTracker.mentionLog.size).toBe(0);
    });
});
