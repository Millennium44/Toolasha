import { describe, expect, test, vi, beforeEach } from 'vitest';

let messageHandlers;
let socketHandlers;

vi.mock('./websocket.js', () => {
    messageHandlers = new Map();
    socketHandlers = new Map();

    return {
        default: {
            on: vi.fn((event, handler) => {
                messageHandlers.set(event, handler);
            }),
            onSocketEvent: vi.fn((event, handler) => {
                socketHandlers.set(event, handler);
            }),
        },
    };
});

beforeEach(() => {
    vi.resetModules();
});

describe('ConnectionState', () => {
    test('transitions to connected on init_character_data', async () => {
        // Arrange
        const { default: connectionState } = await import('./connection-state.js');
        const onReconnected = vi.fn();
        connectionState.on('reconnected', onReconnected);

        // Act
        const handler = messageHandlers.get('init_character_data');
        handler({});

        // Assert
        expect(connectionState.isConnected()).toBe(true);
        expect(onReconnected).toHaveBeenCalledTimes(1);
    });

    test('moves to reconnecting on socket open after connected', async () => {
        // Arrange
        const { default: connectionState } = await import('./connection-state.js');
        const initHandler = messageHandlers.get('init_character_data');
        const openHandler = socketHandlers.get('open');

        // Act
        initHandler({});
        openHandler({});

        // Assert
        expect(connectionState.isConnected()).toBe(false);
        expect(connectionState.getState()).toBe('reconnecting');
    });

    test('emits disconnected on socket close', async () => {
        // Arrange
        const { default: connectionState } = await import('./connection-state.js');
        const onDisconnected = vi.fn();
        connectionState.on('disconnected', onDisconnected);

        // Act
        const closeHandler = socketHandlers.get('close');
        closeHandler({ code: 1006 });

        // Assert
        expect(connectionState.getState()).toBe('disconnected');
        expect(onDisconnected).toHaveBeenCalledTimes(1);
    });

    test('a stale close from the character-switch-departing socket does not flip a live connection to disconnected', async () => {
        // During a character switch the departing socket is still open (and still
        // delivering) while the arriving socket has already opened and sent its
        // own init_character_data. webSocketHook.emitSocketEvent passes the
        // originating socket as the handler's second argument specifically so a
        // listener can tell which connection an event came from (see
        // dataManager._isFromActiveSocket for the same pattern on message
        // handlers) — but connection-state's close/error listeners discard it and
        // treat every close as "the connection is gone", regardless of which
        // socket produced it.
        const { default: connectionState } = await import('./connection-state.js');
        const oldSocket = { label: 'old' };
        const newSocket = { label: 'new' };

        const openHandler = socketHandlers.get('open');
        const closeHandler = socketHandlers.get('close');
        const initHandler = messageHandlers.get('init_character_data');

        // Old socket connects and its character logs in.
        openHandler({}, oldSocket);
        initHandler({});
        expect(connectionState.isConnected()).toBe(true);

        // A character switch opens a new socket, which promptly reports its own
        // character.
        openHandler({}, newSocket);
        initHandler({});
        expect(connectionState.isConnected()).toBe(true);

        // The old socket's close arrives late (it was still tearing down). The
        // new socket is live and already confirmed connected — this must not
        // undo that.
        closeHandler({ code: 1000 }, oldSocket);

        expect(connectionState.isConnected()).toBe(true);
        expect(connectionState.getState()).toBe('connected');
    });
});
