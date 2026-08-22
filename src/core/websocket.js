/**
 * WebSocket Hook Module
 * Intercepts WebSocket messages from the MWI game server
 *
 * Uses WebSocket constructor wrapper for better performance than MessageEvent.prototype.data hooking
 */

import { setCurrentProfile } from './profile-manager.js';
import storage from './storage.js';

/**
 * Message types that bypass the content-hash deduplication.
 *
 * Events where consecutive messages have similar first 100 chars but contain
 * different data (counts, timestamps, etc. beyond the 100-char hash window),
 * or events that should always trigger UI updates (profile_shared,
 * battle_unit_fetched).
 *
 * - `abilities_updated`: equipping and unequipping the same ability produce
 *   messages whose first 100 characters are identical — type, character id and
 *   the opening ability hrid fill the window, and the slotNumber that says
 *   which way it went sits past it. Hashing them would drop the second and
 *   leave the equipped kit stuck on the first.
 * - `battle_updated`: consecutive combat ticks can open with identical text —
 *   same type, same battle, same unit ids — and differ only in hitpoints
 *   further in, so the 100-char hash would drop the update that matters.
 * - `new_battle`: the message every baseline is seeded from, and it opens with
 *   its type, its battle id and the first monster's hrid — a hundred
 *   characters two consecutive waves of the same zone fill identically. The
 *   `processedMessages` map evicts at a hundred entries, so a hash that
 *   collided minutes ago can be gone and back again; the one that is dropped
 *   is the one that re-baselines the fight, and everything diffed afterwards
 *   is against the wrong units.
 * - `guild_battle_updated`: the guild trial's spectator stream, and the worst
 *   hash collision of the lot: every tick opens `{"type":"guild_battle_updated",
 *   "battleId":1,"tier":2,"pMap":{"1":{"cHP":…` — type, battle and tier fill
 *   the window on their own, so consecutive ticks are identical for far more
 *   than a hundred characters and only the health past it differs. Hashed, a
 *   whole trial collapses to one tick.
 * - `guild_skilling_updated` and the guild-trial lifecycle four: the rest of
 *   the guild-trial family, for the same reason and worse.
 *   `guild_skilling_updated` opens `{"type":"guild_skilling_updated",
 *   "trialHrid":"/guild_skilling/crafting","tier":10,"currentProgress":` — a
 *   hundred characters exactly, so every tick of an hour's skilling trial
 *   hashes identically and only `actionCounter`, right at the end, ever
 *   changes. The lifecycle four are short enough to fit inside the window
 *   whole, so a second trial of the same skill would silently drop its own
 *   start or end.
 * - `community_buffs_updated`: two donations to the same buff in a row produce
 *   messages whose first 100 characters are identical — type, buff id and hrid
 *   fill the window, and the changed expireTime/level sit past it — so the
 *   content hash would drop the extension and expiry alerts would fire against
 *   a stale clock.
 * - `loot_opened`: opening the same chest twice in a row produces two messages
 *   whose first 100 characters are identical — same type, same chest, same
 *   count — so the content hash would drop the second and the treasure ledger
 *   would undercount every repeat opening.
 * - `guild_updated`: guild updates open with the same guild id and name every
 *   time; what changed (xp, level, member counts) sits past the hash window,
 *   so a quick pair would drop the second and leave the guild panels a step
 *   behind.
 *
 * One Set lookup per message, rather than a chain of string comparisons on
 * every frame the socket delivers.
 */
const SKIP_DEDUP_TYPES = new Set([
    'quests_updated',
    'action_completed',
    'actions_updated',
    'items_updated',
    'market_item_order_books_updated',
    'market_listings_updated',
    'profile_shared',
    'battle_consumable_ability_updated',
    'abilities_updated',
    'battle_unit_fetched',
    'battle_updated',
    'new_battle',
    'guild_battle_updated',
    'guild_skilling_updated',
    'new_guild_battle',
    'new_guild_skilling',
    'end_guild_battle',
    'end_guild_skilling',
    'action_type_consumable_slots_updated',
    'consumable_buffs_updated',
    'community_buffs_updated',
    'character_info_updated',
    'labyrinth_updated',
    'loadouts_updated',
    'setting_updated',
    'labyrinth_room_progress',
    'loot_opened',
    'guild_updated',
    'leaderboard_updated',
]);

/** How many characters from each end of a message go into the TTL dedup key */
const TTL_KEY_EDGE = 64;

/**
 * A cheap key for the short-TTL duplicate check: length plus the first and
 * last characters. Two messages of the same type that agree on all three
 * within 50 ms are a re-delivery, not two events — and keying the map on the
 * whole payload meant hashing several kilobytes of combat state per message.
 * @param {string} message - Raw message text
 * @returns {string}
 */
function ttlDedupKey(message) {
    if (message.length <= TTL_KEY_EDGE * 2) return `${message.length}:${message}`;
    return `${message.length}:${message.slice(0, TTL_KEY_EDGE)}${message.slice(-TTL_KEY_EDGE)}`;
}

class WebSocketHook {
    constructor() {
        this.isHooked = false;
        this.messageHandlers = new Map();
        this.socketEventHandlers = new Map();
        this.attachedSockets = new WeakSet();
        /**
         * Track processed message events to avoid duplicate handling when multiple hooks fire.
         *
         * We intercept messages through three paths:
         * 1) MessageEvent.prototype.data getter
         * 2) The WebSocket constructor subclass wrapper (attachSocketListeners on construct)
         * 3) Direct socket listeners in attachSocketListeners
         */
        this.processedMessageEvents = new WeakSet();

        /**
         * Track processed messages by content hash to prevent duplicate JSON.parse
         * Uses message content (first 100 chars) as key since same message can have different event objects
         */
        this.processedMessages = new Map(); // message hash -> timestamp
        this.recentActionCompleted = new Map(); // ttlDedupKey(message) -> timestamp (50ms TTL dedup)

        /** Pristine MessageEvent.data getter, fetched lazily when a foreign hook breaks (null = unobtainable) */
        this.nativeDataGet = undefined;
        /** The foreign-hook diagnostic is said once, not per message */
        this.notedForeignHookFailure = false;
        this.messageCleanupInterval = null;
        this.isSocketWrapped = false;
        this.originalWebSocket = null;
        this.currentWebSocket = null;
        this.clientDataRetryTimeout = null;
    }

    /**
     * Install the WebSocket hook
     * MUST be called before WebSocket connection is established
     * Uses MessageEvent.prototype.data hook (same method as MWI Tools)
     */
    install() {
        if (this.isHooked) {
            console.warn('[WebSocket Hook] Already installed');
            return;
        }

        this.wrapWebSocketConstructor();

        // Capture hook instance for closure
        const hookInstance = this;

        // Hook MessageEvent.prototype.data on the PAGE's prototype (via unsafeWindow)
        // Using the sandbox's MessageEvent fails when Tampermonkey isolates prototypes
        const pageMessageEvent = typeof unsafeWindow !== 'undefined' ? unsafeWindow.MessageEvent : MessageEvent;
        const dataProperty = Object.getOwnPropertyDescriptor(pageMessageEvent.prototype, 'data');
        const originalGet = dataProperty.get;

        dataProperty.get = function hookedGet() {
            const socket = this.currentTarget;

            // Only hook MWI game server (URL check handles non-WebSocket events safely)
            if (!hookInstance.isGameSocket(socket)) {
                return originalGet.call(this);
            }

            // Already processed — pass through without re-processing
            if (hookInstance.isMessageEventProcessed(this)) {
                return originalGet.call(this);
            }

            hookInstance.attachSocketListeners(socket);

            // `originalGet` is whatever the property held when Toolasha
            // installed — on a page with several userscripts that can be
            // another script's wrapper, and one of those throwing (seen live:
            // a foreign hook's character-switch teardown) would otherwise
            // break message delivery to this script and to the game alike.
            let message;
            try {
                message = originalGet.call(this);
            } catch (error) {
                message = hookInstance.readDataBypassingForeignHooks(this, error);
                if (message === undefined) throw error;
            }

            hookInstance.markMessageEventProcessed(this);
            hookInstance.processMessage(message);

            return message;
        };

        Object.defineProperty(pageMessageEvent.prototype, 'data', dataProperty);

        this.isHooked = true;
    }

    /**
     * Read a MessageEvent's data through a pristine native getter, sidestepping
     * a broken foreign hook.
     *
     * Several userscripts hook `MessageEvent.prototype.data` on this page, each
     * wrapping whichever getter it found — so the chain below Toolasha can
     * contain another script's wrapper, and that wrapper throwing (observed
     * live: a foreign hook's character-switch teardown raising mid-getter)
     * would silently cut message delivery to everything above it. The native
     * getter still exists untouched in a fresh same-origin frame; it is fetched
     * once, cached, and works across realms because it reads an internal slot
     * the realm does not partition.
     *
     * @param {MessageEvent} event - The event whose data the chain failed to produce
     * @param {Error} error - What the chain threw, for the one-time diagnostic
     * @returns {*} The data, or undefined when no native getter could be found
     */
    readDataBypassingForeignHooks(event, error) {
        if (this.nativeDataGet === undefined) {
            this.nativeDataGet = null;
            try {
                const iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                // Same-origin so its realm's getter works on this realm's
                // events, but NO scripts: a frame that runs scripts is a frame
                // a userscript manager may inject every matching script into,
                // booting second copies of them against shared storage for the
                // few milliseconds this helper exists
                iframe.setAttribute('sandbox', 'allow-same-origin');
                (document.documentElement || document.body).appendChild(iframe);
                try {
                    const descriptor = Object.getOwnPropertyDescriptor(
                        iframe.contentWindow.MessageEvent.prototype,
                        'data'
                    );
                    if (typeof descriptor?.get === 'function') this.nativeDataGet = descriptor.get;
                } finally {
                    // Gone whether or not the read worked — a helper frame left
                    // in the document is a frame something else may notice
                    iframe.remove();
                }
            } catch (frameError) {
                console.error('[WebSocket] Could not obtain a native data getter:', frameError);
            }
        }
        if (!this.nativeDataGet) return undefined;

        if (!this.notedForeignHookFailure) {
            this.notedForeignHookFailure = true;
            console.warn(
                "[WebSocket] Another script's MessageEvent.data hook threw; reading past it with the native getter. Its error:",
                error
            );
        }
        try {
            return this.nativeDataGet.call(event);
        } catch {
            return undefined;
        }
    }

    /**
     * Check if a socket belongs to the game server.
     *
     * Duck-typed on purpose, and it must stay that way. Several MWI userscripts
     * replace `window.WebSocket` with a constructor of their own — sometimes
     * from another realm, since a Tampermonkey sandbox and the page do not share
     * prototypes — and against one of those `socket instanceof WebSocket` is
     * silently false. A gate written that way does not fail loudly; it simply
     * stops seeing the game's traffic on whichever page load another script won
     * the constructor. What identifies the game's socket is what it *is*: a URL
     * pointing at the game's server, and something to send on.
     *
     * @param {WebSocket|Object} socket - Anything socket-shaped
     * @returns {boolean} True if game socket
     */
    isGameSocket(socket) {
        if (!socket || typeof socket.url !== 'string') {
            return false;
        }

        return (
            socket.url.indexOf('api.milkywayidle.com/ws') !== -1 ||
            socket.url.indexOf('api-test.milkywayidle.com/ws') !== -1
        );
    }

    /**
     * Wrap the WebSocket constructor to attach lifecycle listeners
     */
    wrapWebSocketConstructor() {
        if (this.isSocketWrapped) {
            return;
        }

        const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (typeof targetWindow === 'undefined' || !targetWindow.WebSocket) {
            return;
        }

        const hookInstance = this;

        const wrapConstructor = (OriginalWebSocket) => {
            if (!OriginalWebSocket || OriginalWebSocket.__toolashaWrapped) {
                hookInstance.currentWebSocket = OriginalWebSocket;
                return;
            }

            // Only subclass native WebSocket constructors. Third-party wrappers
            // (other userscripts replacing window.WebSocket) are passed through
            // as-is — Toolasha still intercepts via the MessageEvent.data hook,
            // which also attaches the per-socket listener on first read.
            const isNative = /\[native code\]/.test(Function.prototype.toString.call(OriginalWebSocket));
            if (!isNative) {
                hookInstance.currentWebSocket = OriginalWebSocket;
                return;
            }

            class ToolashaWebSocket extends OriginalWebSocket {
                constructor(...args) {
                    super(...args);
                    hookInstance.attachSocketListeners(this);
                }
            }

            ToolashaWebSocket.__toolashaWrapped = true;
            ToolashaWebSocket.__toolashaOriginal = OriginalWebSocket;

            hookInstance.originalWebSocket = OriginalWebSocket;
            hookInstance.currentWebSocket = ToolashaWebSocket;
        };

        wrapConstructor(targetWindow.WebSocket);

        Object.defineProperty(targetWindow, 'WebSocket', {
            configurable: true,
            get() {
                return hookInstance.currentWebSocket;
            },
            set(nextWebSocket) {
                wrapConstructor(nextWebSocket);
            },
        });
        this.isSocketWrapped = true;
    }

    /**
     * Attach lifecycle listeners to a socket
     * @param {WebSocket} socket - WebSocket instance
     */
    attachSocketListeners(socket) {
        if (!this.isGameSocket(socket)) {
            return;
        }

        if (this.attachedSockets.has(socket)) {
            return;
        }

        this.attachedSockets.add(socket);

        const events = ['open', 'close', 'error'];
        for (const eventName of events) {
            socket.addEventListener(eventName, (event) => {
                this.emitSocketEvent(eventName, event, socket);
            });
        }

        socket.addEventListener('message', (event) => {
            if (!event || this.isMessageEventProcessed(event)) {
                return;
            }

            // Mark BEFORE the first `event.data` read. That read goes through
            // the hooked MessageEvent.data getter, and on an unmarked event the
            // getter dispatches processMessage itself — after which this
            // listener dispatched again. The content-hash dedup silently
            // absorbed the echo for most types, but everything on the
            // skip-dedup list (battle_updated among them) reached every handler
            // twice, and raw tick captures came out half duplicates.
            this.markMessageEventProcessed(event);

            // This read runs the whole hooked-getter chain, foreign wrappers
            // included; one of them throwing must not cost this message
            let data;
            try {
                data = event.data;
            } catch (error) {
                data = this.readDataBypassingForeignHooks(event, error);
                if (data === undefined) return;
            }
            if (typeof data !== 'string') {
                return;
            }

            this.processMessage(data);
        });
    }

    isMessageEventProcessed(event) {
        if (!event || typeof event !== 'object') {
            return false;
        }

        return this.processedMessageEvents.has(event);
    }

    markMessageEventProcessed(event) {
        if (!event || typeof event !== 'object') {
            return;
        }

        this.processedMessageEvents.add(event);
    }

    /**
     * Process intercepted message
     * @param {string} message - JSON string from WebSocket
     */
    processMessage(message) {
        // Parse message type first to determine deduplication strategy
        let messageType;
        try {
            // Quick parse to get type (avoid full parse for duplicates)
            const typeMatch = message.match(/"type":"([^"]+)"/);
            messageType = typeMatch ? typeMatch[1] : null;
        } catch {
            // If regex fails, skip deduplication and process normally
            messageType = null;
        }

        const skipDedup = SKIP_DEDUP_TYPES.has(messageType);

        if (!skipDedup) {
            // Deduplicate by message content to prevent 4x JSON.parse on same message
            // Use first 100 chars as hash (contains type + timestamp, unique enough)
            const messageHash = message.substring(0, 100);

            if (this.processedMessages.has(messageHash)) {
                return; // Already processed this message, skip
            }

            this.processedMessages.set(messageHash, Date.now());

            // Cleanup old entries every 100 messages to prevent memory leak
            if (this.processedMessages.size > 100) {
                this.cleanupProcessedMessages();
            }
        } else if (messageType === 'action_completed' || messageType === 'loot_opened') {
            // action_completed and loot_opened bypass the content-hash dedup (Gabriel's fix,
            // commit 1007215, and the treasure ledger respectively). The WeakSet guard catches
            // the same MessageEvent object reaching both remaining interception paths, but two
            // distinct MessageEvents wrapping the same payload (e.g. another userscript
            // re-dispatching, or a game reconnect replay) would both pass the WeakSet check and
            // call processMessage twice.
            // Use a short 50ms TTL keyed on the message's length and edges (see
            // `ttlDedupKey`) to collapse these duplicates. Two genuine consecutive
            // messages of either type are far enough apart that a repeat inside 50ms
            // is a duplicate rather than a second event.
            const now = Date.now();
            const key = ttlDedupKey(message);
            if (this.recentActionCompleted.has(key)) {
                return; // Duplicate from second listener — skip
            }
            this.recentActionCompleted.set(key, now);
            // Prune entries older than 50ms to keep memory bounded
            for (const [key, ts] of this.recentActionCompleted) {
                if (now - ts > 50) {
                    this.recentActionCompleted.delete(key);
                }
            }
        }

        try {
            const data = JSON.parse(message);
            const parsedMessageType = data.type;

            // Save critical data to GM storage for Combat Sim export
            this.saveCombatSimData(parsedMessageType, message);

            // Call registered handlers for this message type. Snapshot the array:
            // a handler that off()s itself mid-dispatch would otherwise shift the
            // list under the loop and skip the next handler.
            const handlers = [...(this.messageHandlers.get(parsedMessageType) || [])];

            for (const handler of handlers) {
                try {
                    const result = handler(data);
                    if (result instanceof Promise) {
                        result.catch((error) => {
                            console.error(`[WebSocket] Async handler error for ${parsedMessageType}:`, error);
                        });
                    }
                } catch (error) {
                    console.error(`[WebSocket] Handler error for ${parsedMessageType}:`, error);
                }
            }

            // Call wildcard handlers (receive all messages)
            const wildcardHandlers = [...(this.messageHandlers.get('*') || [])];
            for (const handler of wildcardHandlers) {
                try {
                    const result = handler(data);
                    if (result instanceof Promise) {
                        result.catch((error) => {
                            console.error('[WebSocket] Async wildcard handler error:', error);
                        });
                    }
                } catch (error) {
                    console.error('[WebSocket] Wildcard handler error:', error);
                }
            }
        } catch (error) {
            console.error('[WebSocket] Failed to process message:', error);
        }
    }

    /**
     * Save combat sim data for export (cross-domain via GM storage + IndexedDB).
     * Character/client/battle data is saved to GM storage so the Shykai sim page can read it.
     * Profile shares are saved to IndexedDB for cross-session persistence.
     *
     * Every GM-bridged payload written here is also stamped with an ownership marker —
     * `{characterId, characterName, writtenAt}` — written to a namespaced *sibling* key
     * (`${key}_meta`) rather than wrapped around the payload itself. That keeps the raw
     * payload key byte-for-byte identical to what it always was, which matters because the
     * external Shykai combat sim page reads these exact GM keys directly (see the
     * cross-domain fallback comments on the keys below) — wrapping the payload would break
     * it. See combat-sim-integration.js / combat-sim-export.js for the read-side guard that
     * checks this stamp before trusting a GM-bridged value.
     * @param {string} messageType - Message type
     * @param {string} message - Raw message JSON string
     */
    async saveCombatSimData(messageType, message) {
        const hasGM = typeof GM_setValue !== 'undefined';
        try {
            // Save character/client/battle data to GM storage for cross-domain Shykai access
            if (hasGM && messageType === 'init_character_data') {
                // The writer's own character id/name must be read from THIS message, not from
                // dataManager: saveCombatSimData runs before dataManager's own init_character_data
                // handler (see processMessage), so dataManager.getCurrentCharacterId() would still
                // report the *previous* character during a character switch.
                try {
                    const parsedCharacter = JSON.parse(message);
                    if (parsedCharacter.character?.id) {
                        this.bridgeCharacterId = parsedCharacter.character.id;
                        this.bridgeCharacterName = parsedCharacter.character.name || null;
                    }
                } catch {
                    /* ignore — meta write below falls back to the last known bridge character */
                }
                setTimeout(() => {
                    try {
                        GM_setValue('toolasha_init_character_data', message);
                        this.writeBridgeMeta('toolasha_init_character_data_meta');
                    } catch {
                        /* ignore */
                    }
                }, 0);
            } else if (hasGM && messageType === 'init_client_data') {
                setTimeout(() => {
                    try {
                        GM_setValue('toolasha_init_client_data', message);
                        this.writeBridgeMeta('toolasha_init_client_data_meta');
                    } catch {
                        /* ignore */
                    }
                }, 0);
            } else if (hasGM && messageType === 'new_battle') {
                setTimeout(() => {
                    try {
                        GM_setValue('toolasha_new_battle', message);
                        this.writeBridgeMeta('toolasha_new_battle_meta');
                    } catch {
                        /* ignore */
                    }
                }, 0);
            }

            // Save profile shares (when opening party member profiles)
            if (messageType === 'profile_shared') {
                const parsed = JSON.parse(message);

                // Extract character info - try multiple sources for ID
                parsed.characterID =
                    parsed.profile.sharableCharacter?.id ||
                    parsed.profile.characterSkills?.[0]?.characterID ||
                    parsed.profile.character?.id;
                parsed.characterName = parsed.profile.sharableCharacter?.name || 'Unknown';
                parsed.timestamp = Date.now();

                // Validate we got a character ID
                if (!parsed.characterID) {
                    console.error('[Toolasha] Failed to extract characterID from profile:', parsed);
                    return;
                }

                // Store in memory for Steam users (works without GM storage)
                setCurrentProfile(parsed);

                // Load existing profile list from IndexedDB
                let profileList = (await storage.getJSON('profile_list', 'combatExport', null)) || [];

                // Remove old entry for same character
                profileList = profileList.filter((p) => p.characterID !== parsed.characterID);

                // Add to front of list
                profileList.unshift(parsed);

                // Keep only last 20 profiles
                if (profileList.length > 20) {
                    profileList.pop();
                }

                // Save updated profile list to IndexedDB (cross-session) and GM storage (cross-domain for Shykai)
                await storage.setJSON('profile_list', profileList, 'combatExport', true);
                if (hasGM) {
                    try {
                        GM_setValue('toolasha_profile_list', JSON.stringify(profileList));
                        this.writeBridgeMeta('toolasha_profile_list_meta');
                    } catch {
                        /* ignore */
                    }
                }
            }
        } catch (error) {
            console.error('[WebSocket] Failed to save Combat Sim data:', error);
        }
    }

    /**
     * Stamp a GM-bridged combat sim key with who wrote it and when, under a namespaced sibling
     * meta key (e.g. 'toolasha_init_character_data_meta'). Kept separate from the payload key so
     * the external Shykai sim page, which reads the raw payload key directly, is unaffected.
     * Uses the character last seen via init_character_data on this tab (`this.bridgeCharacterId` /
     * `this.bridgeCharacterName`) since that is the only writer identity reliably available
     * synchronously at write time.
     * @param {string} metaKey - Namespaced meta key to write, e.g. 'toolasha_init_character_data_meta'
     */
    writeBridgeMeta(metaKey) {
        if (typeof GM_setValue === 'undefined') return;
        try {
            GM_setValue(
                metaKey,
                JSON.stringify({
                    characterId: this.bridgeCharacterId || null,
                    characterName: this.bridgeCharacterName || null,
                    writtenAt: Date.now(),
                })
            );
        } catch {
            /* ignore */
        }
    }

    /**
     * Capture init_client_data from localStorage (fallback method)
     * Called periodically since it may not come through WebSocket
     * Uses official game API to avoid manual decompression
     */
    async captureClientDataFromLocalStorage() {
        try {
            // Use official game API instead of manual localStorage access
            if (typeof localStorageUtil === 'undefined' || typeof localStorageUtil.getInitClientData !== 'function') {
                // API not ready yet, retry
                this.scheduleClientDataRetry();
                return;
            }

            // API returns parsed object and handles decompression automatically
            const clientDataObj = localStorageUtil.getInitClientData();
            if (!clientDataObj || Object.keys(clientDataObj).length === 0) {
                // Data not available yet, retry
                this.scheduleClientDataRetry();
                return;
            }

            // Verify it's init_client_data
            if (clientDataObj?.type === 'init_client_data') {
                this.clearClientDataRetry();
            }
        } catch (error) {
            console.error('[WebSocket] Failed to capture client data from localStorage:', error);
            // Retry on error
            this.scheduleClientDataRetry();
        }
    }

    /**
     * Schedule a retry for client data capture
     */
    scheduleClientDataRetry() {
        this.clearClientDataRetry();
        this.clientDataRetryTimeout = setTimeout(() => this.captureClientDataFromLocalStorage(), 2000);
    }

    /**
     * Clear any pending client data retry
     */
    clearClientDataRetry() {
        if (this.clientDataRetryTimeout) {
            clearTimeout(this.clientDataRetryTimeout);
            this.clientDataRetryTimeout = null;
        }
    }

    /**
     * Cleanup old processed message entries (keep last 50, remove rest)
     */
    cleanupProcessedMessages() {
        const entries = Array.from(this.processedMessages.entries());
        // Sort by timestamp, keep newest 50
        entries.sort((a, b) => b[1] - a[1]);

        this.processedMessages.clear();
        for (let i = 0; i < Math.min(50, entries.length); i++) {
            this.processedMessages.set(entries[i][0], entries[i][1]);
        }
    }

    /**
     * Cleanup any pending retry timeouts
     */
    cleanup() {
        this.clearClientDataRetry();
        this.processedMessages.clear();
    }

    /**
     * Register a handler for a specific message type
     * @param {string} messageType - Message type to handle (e.g., "init_character_data")
     * @param {Function} handler - Function to call when message received
     */
    on(messageType, handler) {
        if (!this.messageHandlers.has(messageType)) {
            this.messageHandlers.set(messageType, []);
        }
        const handlers = this.messageHandlers.get(messageType);
        if (!handlers.includes(handler)) {
            handlers.push(handler);
        }
    }

    /**
     * Register a handler for WebSocket lifecycle events
     * @param {string} eventType - Event type (open, close, error)
     * @param {Function} handler - Handler function
     */
    onSocketEvent(eventType, handler) {
        if (!this.socketEventHandlers.has(eventType)) {
            this.socketEventHandlers.set(eventType, []);
        }
        this.socketEventHandlers.get(eventType).push(handler);
    }

    /**
     * Unregister a handler
     * @param {string} messageType - Message type
     * @param {Function} handler - Handler function to remove
     */
    off(messageType, handler) {
        const handlers = this.messageHandlers.get(messageType);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }

    /**
     * Unregister a WebSocket lifecycle handler
     * @param {string} eventType - Event type
     * @param {Function} handler - Handler function
     */
    offSocketEvent(eventType, handler) {
        const handlers = this.socketEventHandlers.get(eventType);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }

    emitSocketEvent(eventType, event, socket) {
        const handlers = [...(this.socketEventHandlers.get(eventType) || [])];
        for (const handler of handlers) {
            try {
                handler(event, socket);
            } catch (error) {
                console.error(`[WebSocket] ${eventType} handler error:`, error);
            }
        }
    }
}

const webSocketHook = new WebSocketHook();

export default webSocketHook;
