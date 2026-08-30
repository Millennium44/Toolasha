import webSocketHook from './websocket.js';

const CONNECTION_STATES = {
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    RECONNECTING: 'reconnecting',
};

class ConnectionState {
    constructor() {
        this.state = CONNECTION_STATES.RECONNECTING;
        this.eventListeners = new Map();
        this.lastDisconnectedAt = null;
        this.lastConnectedAt = null;

        // The socket 'open' most recently observed. webSocketHook.emitSocketEvent
        // passes the originating socket as the handler's second argument
        // precisely so a listener can tell which connection produced an event —
        // see _isFromActiveSocket for why close/error need that here.
        this.activeSocket = null;

        this.setupListeners();
    }

    /**
     * Get current connection state
     * @returns {string} Connection state (connected, disconnected, reconnecting)
     */
    getState() {
        return this.state;
    }

    /**
     * Check if currently connected
     * @returns {boolean} True if connected
     */
    isConnected() {
        return this.state === CONNECTION_STATES.CONNECTED;
    }

    /**
     * Register a listener for connection events
     * @param {string} event - Event name (disconnected, reconnected)
     * @param {Function} callback - Handler function
     */
    on(event, callback) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event).push(callback);
    }

    /**
     * Unregister a connection event listener
     * @param {string} event - Event name
     * @param {Function} callback - Handler function to remove
     */
    off(event, callback) {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            const index = listeners.indexOf(callback);
            if (index > -1) {
                listeners.splice(index, 1);
            }
        }
    }

    /**
     * Notify connection state from character initialization
     * @param {Object} data - Character initialization payload
     */
    handleCharacterInitialized(data) {
        if (!data) {
            return;
        }

        this.setConnected('character_initialized');
    }

    setupListeners() {
        webSocketHook.onSocketEvent('open', (event, socket) => {
            // A character switch opens the new socket before the old one has
            // finished closing, so "the socket that just opened" is the one
            // whose close/error should be able to affect state from here on —
            // an event from whichever socket this replaced is stale.
            this.activeSocket = socket ?? null;
            this.setReconnecting('socket_open', { allowConnected: true });
        });

        webSocketHook.onSocketEvent('close', (event, socket) => {
            if (!this._isFromActiveSocket(socket)) {
                return;
            }
            this.setDisconnected('socket_close', event);
        });

        webSocketHook.onSocketEvent('error', (event, socket) => {
            if (!this._isFromActiveSocket(socket)) {
                return;
            }
            this.setDisconnected('socket_error', event);
        });

        webSocketHook.on('init_character_data', () => {
            this.setConnected('init_character_data');
        });
    }

    /**
     * Whether a socket lifecycle event came from the most recently opened
     * socket, and so may actually affect connection state.
     *
     * During a character switch the departing socket is still open — and can
     * still fire 'close' or 'error' — while the arriving socket has already
     * opened and reported its own character. Without this check, that stale
     * event flips a live connection to 'disconnected', and since nothing but
     * a fresh 'init_character_data' brings it back, the state is then stuck
     * disconnected until the next real reconnect: `marketAPI.fetch` reads
     * `connectionState.isConnected()` and would serve stale cached prices
     * indefinitely instead of ever fetching again.
     *
     * Permissive when no socket has been observed yet, matching the same
     * fail-open pattern as dataManager._isFromActiveSocket.
     *
     * @param {Object|undefined} socket - The socket the event came from
     * @returns {boolean}
     * @private
     */
    _isFromActiveSocket(socket) {
        return !this.activeSocket || socket === this.activeSocket;
    }

    setReconnecting(reason, options = {}) {
        if (this.state === CONNECTION_STATES.CONNECTED && !options.allowConnected) {
            return;
        }

        this.updateState(CONNECTION_STATES.RECONNECTING, {
            reason,
        });
    }

    setDisconnected(reason, event) {
        if (this.state === CONNECTION_STATES.DISCONNECTED) {
            return;
        }

        this.lastDisconnectedAt = Date.now();
        this.updateState(CONNECTION_STATES.DISCONNECTED, {
            reason,
            event,
            disconnectedAt: this.lastDisconnectedAt,
        });
    }

    setConnected(reason) {
        if (this.state === CONNECTION_STATES.CONNECTED) {
            return;
        }

        this.lastConnectedAt = Date.now();
        this.updateState(CONNECTION_STATES.CONNECTED, {
            reason,
            disconnectedAt: this.lastDisconnectedAt,
            connectedAt: this.lastConnectedAt,
        });
    }

    updateState(nextState, details) {
        if (this.state === nextState) {
            return;
        }

        const previousState = this.state;
        this.state = nextState;

        if (nextState === CONNECTION_STATES.DISCONNECTED) {
            this.emit('disconnected', {
                previousState,
                ...details,
            });
            return;
        }

        if (nextState === CONNECTION_STATES.CONNECTED) {
            this.emit('reconnected', {
                previousState,
                ...details,
            });
        }
    }

    emit(event, data) {
        const listeners = this.eventListeners.get(event) || [];
        for (const listener of listeners) {
            try {
                listener(data);
            } catch (error) {
                console.error('[ConnectionState] Listener error:', error);
            }
        }
    }
}

const connectionState = new ConnectionState();

export default connectionState;
