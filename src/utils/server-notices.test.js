import { describe, test, expect, vi, beforeEach } from 'vitest';

const hook = vi.hoisted(() => ({ handlers: new Map() }));
const dm = vi.hoisted(() => ({ active: true }));

vi.mock('../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            if (!hook.handlers.has(type)) hook.handlers.set(type, []);
            hook.handlers.get(type).push(handler);
        },
        off: (type, handler) => {
            hook.handlers.set(
                type,
                (hook.handlers.get(type) || []).filter((h) => h !== handler)
            );
        },
    },
}));
vi.mock('../core/data-manager.js', () => ({
    default: { isFromActiveSocket: () => dm.active },
}));

const { normalizeServerNotice, onServerNotice } = await import('./server-notices.js');
const { buildInfoNotices } = await import('../__fixtures__/wire/labyrinth.js');

// Inline fixtures follow the game's handleMessageError / handleMessageInfo:
// { type, message: i18nKey, variables: [{ name, data }] }. A captured info notice
// (party flow, test server 2026-11-01) has `variables: null` — see buildInfoNotices.
const emit = (type, data) => (hook.handlers.get(type) || []).slice().forEach((h) => h(data, { socket: {} }));

describe('normalizeServerNotice', () => {
    test('keys variables by name, falling back to position', () => {
        const notice = normalizeServerNotice({
            type: 'info',
            message: 'infoNotification.guildTrialSignupRemoved',
            variables: [{ name: 'trialHrid', data: '/guild_trials/x' }, { data: 'Bob' }],
        });
        expect(notice).toMatchObject({
            level: 'info',
            key: 'infoNotification.guildTrialSignupRemoved',
            variables: { trialHrid: '/guild_trials/x', 1: 'Bob' },
        });
    });

    test('the captured info notices carry variables: null and normalize to an empty map', () => {
        const notices = buildInfoNotices();
        expect(notices.length).toBeGreaterThan(0);
        for (const raw of notices) {
            expect(raw.variables).toBeNull();
            expect(normalizeServerNotice(raw)).toMatchObject({ level: 'info', key: raw.message, variables: {} });
        }
    });

    test('tolerates absent, empty and malformed variables', () => {
        expect(normalizeServerNotice({ type: 'error', message: 'errorNotification.itemIsLocked' }).variables).toEqual(
            {}
        );
        expect(
            normalizeServerNotice({ type: 'error', message: 'errorNotification.itemIsLocked', variables: [] }).variables
        ).toEqual({});
        expect(
            normalizeServerNotice({ type: 'error', message: 'errorNotification.itemIsLocked', variables: [null, 4] })
                .variables
        ).toEqual({});
    });

    test('rejects messages without a usable key or of another type', () => {
        expect(normalizeServerNotice(null)).toBeNull();
        expect(normalizeServerNotice({ type: 'error' })).toBeNull();
        expect(normalizeServerNotice({ type: 'error', message: '' })).toBeNull();
        expect(normalizeServerNotice({ type: 'pong', message: 'x' })).toBeNull();
    });
});

describe('onServerNotice', () => {
    beforeEach(() => {
        hook.handlers.clear();
        dm.active = true;
    });

    test('delivers error and info notices, and an unknown key passes through untouched', () => {
        const seen = [];
        onServerNotice((n) => seen.push(n));
        emit('error', { type: 'error', message: 'errorNotification.orderNotFulfilled' });
        emit('info', { type: 'info', message: 'infoNotification.somethingNew', variables: [] });
        expect(seen.map((n) => [n.level, n.key])).toEqual([
            ['error', 'errorNotification.orderNotFulfilled'],
            ['info', 'infoNotification.somethingNew'],
        ]);
    });

    test('ignores a message from a socket that is not the active one', () => {
        const handler = vi.fn();
        onServerNotice(handler);
        dm.active = false;
        emit('error', { type: 'error', message: 'errorNotification.itemIsLocked' });
        expect(handler).not.toHaveBeenCalled();
    });

    test('unsubscribe stops delivery, is idempotent, and a throwing handler does not escape', () => {
        const handler = vi.fn(() => {
            throw new Error('boom');
        });
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const off = onServerNotice(handler);
        expect(() => emit('error', { type: 'error', message: 'errorNotification.itemIsLocked' })).not.toThrow();
        expect(handler).toHaveBeenCalledTimes(1);
        off();
        off();
        emit('error', { type: 'error', message: 'errorNotification.itemIsLocked' });
        expect(handler).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});
