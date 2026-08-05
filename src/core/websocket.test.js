/**
 * Tests for WebSocket Hook Module
 *
 * Scoped to the message-processing pipeline (isGameSocket, handler registration,
 * dedup/skip-dedup logic, cleanup) — the pieces that are pure logic once a message
 * string arrives. install()/wrapWebSocketConstructor() patch the global WebSocket and
 * MessageEvent.prototype and are integration surface better exercised manually in the
 * userscript itself.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('./profile-manager.js', () => ({
    setCurrentProfile: vi.fn(),
}));

vi.mock('./storage.js', () => ({
    default: {
        getJSON: vi.fn(async () => []),
        setJSON: vi.fn(async () => {}),
    },
}));

const { default: webSocketHook } = await import('./websocket.js');
const { setCurrentProfile } = await import('./profile-manager.js');
const storage = (await import('./storage.js')).default;

function msg(type, extra = {}) {
    return JSON.stringify({ type, ...extra });
}

beforeEach(() => {
    webSocketHook.messageHandlers.clear();
    webSocketHook.socketEventHandlers.clear();
    webSocketHook.processedMessages.clear();
    webSocketHook.recentActionCompleted.clear();
    vi.clearAllMocks();
});

describe('isGameSocket', () => {
    test('recognizes the live and test API hosts', () => {
        expect(webSocketHook.isGameSocket({ url: 'wss://api.milkywayidle.com/ws' })).toBe(true);
        expect(webSocketHook.isGameSocket({ url: 'wss://api-test.milkywayidle.com/ws' })).toBe(true);
    });

    test('rejects unrelated sockets and missing url/socket', () => {
        expect(webSocketHook.isGameSocket({ url: 'wss://example.com/ws' })).toBe(false);
        expect(webSocketHook.isGameSocket(null)).toBe(false);
        expect(webSocketHook.isGameSocket({})).toBe(false);
    });
});

describe('on / off handler registration', () => {
    test('registers and invokes a handler for its message type', () => {
        const handler = vi.fn();
        webSocketHook.on('test_type', handler);
        webSocketHook.processMessage(msg('test_type', { foo: 'bar' }));
        expect(handler).toHaveBeenCalledWith({ type: 'test_type', foo: 'bar' });
    });

    test('does not register the same handler function twice', () => {
        const handler = vi.fn();
        webSocketHook.on('test_type', handler);
        webSocketHook.on('test_type', handler);
        webSocketHook.processMessage(msg('test_type'));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('off() removes a handler so it no longer fires', () => {
        const handler = vi.fn();
        webSocketHook.on('test_type', handler);
        webSocketHook.off('test_type', handler);
        webSocketHook.processMessage(msg('test_type'));
        expect(handler).not.toHaveBeenCalled();
    });

    test('wildcard "*" handlers receive every message type', () => {
        const wildcard = vi.fn();
        webSocketHook.on('*', wildcard);
        webSocketHook.processMessage(msg('anything'));
        expect(wildcard).toHaveBeenCalledWith({ type: 'anything' });
    });

    test('a handler that throws does not stop other handlers for the same type', () => {
        const throwing = () => {
            throw new Error('boom');
        };
        const ok = vi.fn();
        webSocketHook.on('test_type', throwing);
        webSocketHook.on('test_type', ok);
        expect(() => webSocketHook.processMessage(msg('test_type'))).not.toThrow();
        expect(ok).toHaveBeenCalled();
    });

    test('a rejecting async handler does not throw synchronously', async () => {
        webSocketHook.on('test_type', async () => {
            throw new Error('async boom');
        });
        expect(() => webSocketHook.processMessage(msg('test_type'))).not.toThrow();
        // Let the rejection's .catch() handler run
        await new Promise((r) => setTimeout(r, 0));
    });

    test('malformed JSON does not throw', () => {
        expect(() => webSocketHook.processMessage('not json{')).not.toThrow();
    });
});

describe('content-hash deduplication', () => {
    test('drops a byte-identical repeat of a message type not in the skip-dedup list', () => {
        const handler = vi.fn();
        webSocketHook.on('some_generic_type', handler);
        const message = msg('some_generic_type', { value: 1 });

        webSocketHook.processMessage(message);
        webSocketHook.processMessage(message);

        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('a message with different content is not deduped even with the same type', () => {
        const handler = vi.fn();
        webSocketHook.on('some_generic_type', handler);

        webSocketHook.processMessage(msg('some_generic_type', { value: 1 }));
        webSocketHook.processMessage(msg('some_generic_type', { value: 2 }));

        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('skip-dedup message types (e.g. action_completed) are processed every time', () => {
        const handler = vi.fn();
        webSocketHook.on('quests_updated', handler);
        const message = msg('quests_updated', { value: 1 });

        webSocketHook.processMessage(message);
        webSocketHook.processMessage(message);

        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('action_completed uses a 50ms TTL dedup instead of the content hash', () => {
        const handler = vi.fn();
        webSocketHook.on('action_completed', handler);
        const message = msg('action_completed', { value: 1 });

        webSocketHook.processMessage(message);
        webSocketHook.processMessage(message); // duplicate within 50ms window -> dropped

        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('loot_opened repeats within 50ms are deduped the same way as action_completed', () => {
        const handler = vi.fn();
        webSocketHook.on('loot_opened', handler);
        const message = msg('loot_opened', { chest: 'x' });

        webSocketHook.processMessage(message);
        webSocketHook.processMessage(message);

        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('cleanupProcessedMessages trims down to the newest 50 entries once the cap is crossed', () => {
        // Cleanup triggers the instant size exceeds 100 (each message here has unique
        // content, so every one is added); the 101st push crosses the threshold and
        // trims immediately back down to 50.
        for (let i = 0; i < 101; i++) {
            webSocketHook.processMessage(msg('filler_type', { i }));
        }
        expect(webSocketHook.processedMessages.size).toBe(50);
    });
});

describe('saveCombatSimData side effects', () => {
    test('profile_shared stores the profile in memory and persists the profile list', async () => {
        const profileMessage = msg('profile_shared', {
            profile: { sharableCharacter: { id: 'char-1', name: 'Hero' } },
        });

        webSocketHook.processMessage(profileMessage);
        // saveCombatSimData is fire-and-forget async; flush microtasks
        await new Promise((r) => setTimeout(r, 0));

        expect(setCurrentProfile).toHaveBeenCalled();
        const savedProfile = setCurrentProfile.mock.calls[0][0];
        expect(savedProfile.characterID).toBe('char-1');
        expect(savedProfile.characterName).toBe('Hero');
        expect(storage.setJSON).toHaveBeenCalledWith('profile_list', expect.any(Array), 'combatExport', true);
    });

    test('a profile_shared message with no resolvable character id is skipped without throwing', async () => {
        const profileMessage = msg('profile_shared', { profile: {} });
        expect(() => webSocketHook.processMessage(profileMessage)).not.toThrow();
        await new Promise((r) => setTimeout(r, 0));
        expect(setCurrentProfile).not.toHaveBeenCalled();
    });
});

describe('saveCombatSimData GM-storage bridge stamping', () => {
    // GM_setValue only exists in the Tampermonkey sandbox; stub it per-test so saveCombatSimData's
    // `hasGM` branch runs and so we can inspect exactly what got written.
    beforeEach(() => {
        globalThis.GM_setValue = vi.fn();
    });

    afterEach(() => {
        delete globalThis.GM_setValue;
    });

    function metaWrite(key) {
        const call = globalThis.GM_setValue.mock.calls.find(([k]) => k === key);
        expect(call).toBeDefined();
        return JSON.parse(call[1]);
    }

    test('stamps toolasha_init_character_data with the writing character and a fresh writtenAt, payload untouched', async () => {
        const before = Date.now();
        const characterMessage = msg('init_character_data', { character: { id: 'char-42', name: 'Milky' } });

        webSocketHook.processMessage(characterMessage);
        await new Promise((r) => setTimeout(r, 0));

        // Payload key keeps its original raw-message shape (external Shykai sim reads it directly).
        expect(globalThis.GM_setValue).toHaveBeenCalledWith('toolasha_init_character_data', characterMessage);

        const meta = metaWrite('toolasha_init_character_data_meta');
        expect(meta).toEqual({
            characterId: 'char-42',
            characterName: 'Milky',
            writtenAt: expect.any(Number),
        });
        expect(meta.writtenAt).toBeGreaterThanOrEqual(before);
    });

    test('stamps toolasha_init_client_data and toolasha_new_battle with the last character seen on this tab', async () => {
        webSocketHook.processMessage(msg('init_character_data', { character: { id: 'char-7', name: 'Zog' } }));
        await new Promise((r) => setTimeout(r, 0));
        globalThis.GM_setValue.mockClear();

        webSocketHook.processMessage(msg('init_client_data', { levelExperienceTable: [] }));
        await new Promise((r) => setTimeout(r, 0));
        expect(metaWrite('toolasha_init_client_data_meta')).toMatchObject({ characterId: 'char-7' });

        globalThis.GM_setValue.mockClear();
        webSocketHook.processMessage(msg('new_battle', { players: [] }));
        await new Promise((r) => setTimeout(r, 0));
        expect(metaWrite('toolasha_new_battle_meta')).toMatchObject({ characterId: 'char-7' });
    });

    test('stamps toolasha_profile_list with the viewing (writer) character, not the profile being viewed', async () => {
        webSocketHook.processMessage(msg('init_character_data', { character: { id: 'char-viewer', name: 'Viewer' } }));
        await new Promise((r) => setTimeout(r, 0));
        globalThis.GM_setValue.mockClear();

        webSocketHook.processMessage(
            msg('profile_shared', { profile: { sharableCharacter: { id: 'char-other', name: 'Other' } } })
        );
        await new Promise((r) => setTimeout(r, 0));

        expect(metaWrite('toolasha_profile_list_meta')).toMatchObject({ characterId: 'char-viewer' });
    });

    test('a character switch updates the stamp used for subsequent writes', async () => {
        webSocketHook.processMessage(msg('init_character_data', { character: { id: 'char-a', name: 'A' } }));
        await new Promise((r) => setTimeout(r, 0));
        globalThis.GM_setValue.mockClear();

        webSocketHook.processMessage(msg('init_character_data', { character: { id: 'char-b', name: 'B' } }));
        await new Promise((r) => setTimeout(r, 0));

        expect(metaWrite('toolasha_init_character_data_meta')).toMatchObject({
            characterId: 'char-b',
            characterName: 'B',
        });
    });
});

describe('socket lifecycle events', () => {
    test('onSocketEvent registers a handler invoked by emitSocketEvent', () => {
        const handler = vi.fn();
        webSocketHook.onSocketEvent('open', handler);
        const fakeEvent = {};
        const fakeSocket = {};
        webSocketHook.emitSocketEvent('open', fakeEvent, fakeSocket);
        expect(handler).toHaveBeenCalledWith(fakeEvent, fakeSocket);
    });

    test('offSocketEvent removes the handler', () => {
        const handler = vi.fn();
        webSocketHook.onSocketEvent('close', handler);
        webSocketHook.offSocketEvent('close', handler);
        webSocketHook.emitSocketEvent('close', {}, {});
        expect(handler).not.toHaveBeenCalled();
    });

    test('a throwing socket event handler does not prevent emitSocketEvent from returning', () => {
        webSocketHook.onSocketEvent('error', () => {
            throw new Error('boom');
        });
        expect(() => webSocketHook.emitSocketEvent('error', {}, {})).not.toThrow();
    });
});

describe('isMessageEventProcessed / markMessageEventProcessed', () => {
    test('marks an event object as processed so it is recognized on a second check', () => {
        const event = {};
        expect(webSocketHook.isMessageEventProcessed(event)).toBe(false);
        webSocketHook.markMessageEventProcessed(event);
        expect(webSocketHook.isMessageEventProcessed(event)).toBe(true);
    });

    test('handles non-object input without throwing', () => {
        expect(webSocketHook.isMessageEventProcessed(null)).toBe(false);
        expect(() => webSocketHook.markMessageEventProcessed(null)).not.toThrow();
    });
});

describe('native WebSocket listener semantics (prototype wrapping removed)', () => {
    // The prototype patch used to wrap every addEventListener('message', ...) in a fresh
    // closure without patching removeEventListener, so callers could never remove a message
    // listener by its original reference, and re-registering one bypassed native duplicate
    // suppression. These pin the native semantics the removal restored (upstream 5824eca).
    function makeFakeWebSocket(url = 'wss://api.milkywayidle.com/ws') {
        const target = new EventTarget();
        return {
            url,
            addEventListener: target.addEventListener.bind(target),
            removeEventListener: target.removeEventListener.bind(target),
            dispatchEvent: target.dispatchEvent.bind(target),
        };
    }

    function makeMessageEvent(data) {
        return Object.assign(new Event('message'), { data });
    }

    test('the prototype-wrapping method itself is gone', () => {
        expect(webSocketHook.wrapWebSocketPrototype).toBeUndefined();
    });

    test('add then remove: listener does not fire after removal', () => {
        const socket = makeFakeWebSocket();
        const cb = vi.fn();
        socket.addEventListener('message', cb);
        socket.removeEventListener('message', cb);
        socket.dispatchEvent(makeMessageEvent('{}'));
        expect(cb).not.toHaveBeenCalled();
    });

    test('adding the same listener twice fires it only once', () => {
        const socket = makeFakeWebSocket();
        const cb = vi.fn();
        socket.addEventListener('message', cb);
        socket.addEventListener('message', cb);
        socket.dispatchEvent(makeMessageEvent('{}'));
        expect(cb).toHaveBeenCalledTimes(1);
    });

    test('non-MWI socket message does not reach processMessage', () => {
        const socket = makeFakeWebSocket('wss://unrelated.example.com/ws');
        const spy = vi.spyOn(webSocketHook, 'processMessage');
        socket.addEventListener('message', () => {});
        socket.dispatchEvent(makeMessageEvent('{"type":"test"}'));
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
