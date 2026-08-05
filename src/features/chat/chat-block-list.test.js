import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ blockedMap: null, handlers: {} }));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.handlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.handlers[event] === handler) delete game.handlers[event];
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getBlockedCharacterMap: () => game.blockedMap },
}));

const { chatBlockList } = await import('./chat-block-list.js');

describe('chatBlockList', () => {
    beforeEach(() => {
        game.blockedMap = null;
        game.handlers = {};
        chatBlockList.disable();
    });

    test('nothing is blocked before initialization', () => {
        expect(chatBlockList.isBlocked('Griefer')).toBe(false);
    });

    test('seeds from the character data already on hand at init', () => {
        game.blockedMap = { char1: 'Griefer', char2: 'Spammer' };
        chatBlockList.initialize();

        expect(chatBlockList.isBlocked('Griefer')).toBe(true);
        expect(chatBlockList.isBlocked('Spammer')).toBe(true);
        expect(chatBlockList.isBlocked('Innocent')).toBe(false);
    });

    test('matching ignores case', () => {
        game.blockedMap = { char1: 'GrIeFeR' };
        chatBlockList.initialize();

        expect(chatBlockList.isBlocked('griefer')).toBe(true);
        expect(chatBlockList.isBlocked('GRIEFER')).toBe(true);
    });

    test('a later character_blocks_updated event replaces the set, not adds to it', () => {
        game.blockedMap = { char1: 'Griefer' };
        chatBlockList.initialize();

        game.handlers.character_blocks_updated({ blockedCharacterMap: { char2: 'Spammer' } });

        expect(chatBlockList.isBlocked('Griefer')).toBe(false);
        expect(chatBlockList.isBlocked('Spammer')).toBe(true);
    });

    test('init_character_data also resyncs the set', () => {
        chatBlockList.initialize();

        game.handlers.init_character_data({ blockedCharacterMap: { char1: 'Newcomer' } });

        expect(chatBlockList.isBlocked('Newcomer')).toBe(true);
    });

    test('a missing or null name is never treated as blocked', () => {
        game.blockedMap = { char1: 'Griefer' };
        chatBlockList.initialize();

        expect(chatBlockList.isBlocked(null)).toBe(false);
        expect(chatBlockList.isBlocked(undefined)).toBe(false);
        expect(chatBlockList.isBlocked('')).toBe(false);
    });

    test('a second initialize does not re-register listeners or reset state', () => {
        game.blockedMap = { char1: 'Griefer' };
        chatBlockList.initialize();
        game.blockedMap = { char1: 'Someone Else' };
        chatBlockList.initialize();

        // Still blocked from the first seed — second init was a no-op
        expect(chatBlockList.isBlocked('Griefer')).toBe(true);
    });

    test('disable clears the set and listeners', () => {
        game.blockedMap = { char1: 'Griefer' };
        chatBlockList.initialize();
        chatBlockList.disable();

        expect(chatBlockList.isBlocked('Griefer')).toBe(false);
        expect(game.handlers.init_character_data).toBeUndefined();
    });

    test('an empty map yields an empty set rather than throwing', () => {
        game.blockedMap = null;
        chatBlockList.initialize();

        expect(chatBlockList.isBlocked('Anyone')).toBe(false);
    });
});
