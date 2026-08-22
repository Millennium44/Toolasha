/**
 * Centralized IndexedDB Storage
 * Replaces GM storage with IndexedDB for better performance and Chromium compatibility
 * Provides debounced writes to reduce I/O operations
 */

/**
 * Soft per-store key-count budgets.
 *
 * Not a limit the database enforces — nothing here refuses a write. It is the
 * number above which a store has stopped being a rolling window and started
 * being a leak, which is a thing worth saying in a diagnostic report before the
 * quota says it for us. Only stores that grow with play are listed; anything
 * absent is unbudgeted and simply reported without a verdict.
 *
 * Three of these budgets were raised when their recorders stopped keeping their
 * history in one key and started keeping it in one record per time bucket (see
 * `utils/chunked-history.js`). The key count went up and the bytes written per
 * event went down by two or three orders of magnitude, which is the trade the
 * budget is here to permit rather than to flag — a store of many small records
 * is not the leak this number looks for.
 */
const STORE_KEY_BUDGETS = {
    settings: 500,
    // Per character: ~25 item-level detail snapshots plus one series record per
    // calendar month, capped by a year of full retention beneath the thinning
    networthHistory: 600,
    // Per character: one record per hour of play, and the log keeps 500 entries,
    // so a few dozen live records at a time plus the calibration keys
    lootLogHistory: 500,
    guildHistory: 80,
    leaderboardHistory: 80,
    xpHistory: 200,
    // Three trackers (transmute, decompose, coinify), one record per day each
    // has sessions on, per character
    alchemyHistory: 1500,
    dungeonRuns: 600,
    unifiedRuns: 600,
    teamRuns: 600,
    combatStats: 200,
    queueSnapshots: 80,
    marketListings: 2000,
};

class Storage {
    constructor() {
        this.db = null;
        this.available = false;
        this.dbName = 'ToolashaDB';
        this.dbVersion = 17; // Bumped for leaderboardHistory store
        this.saveDebounceTimers = new Map(); // Per-key debounce timers
        this.pendingWrites = new Map(); // Per-key pending write data: {value, storeName, resolvers, generation}
        this._writeGeneration = new Map(); // Per-key monotonic generation counter, for write ownership
        this.SAVE_DEBOUNCE_DELAY = 3000; // 3 seconds
        this._reconnecting = false; // Guard against concurrent reconnection attempts
        this._dbNulledReason = null; // Track why db was last set to null
        this._lastReconnectFailureAt = 0; // When a reconnect last gave up, so waits do not pile up

        /**
         * Whether a write has failed for want of space.
         *
         * The failure mode this exists to end is silent: a recorder appends to
         * an array, hands it to `set()`, the transaction aborts on quota, and
         * the feature goes on believing it is recording. Recorders read this
         * and stand down instead — see `isQuotaExceeded()`.
         */
        this.quotaExceeded = false;
        this._quotaExceededAt = null;
        this._quotaFailures = 0;
        this._lastQuotaTarget = null; // {key, storeName} of the write that failed
        this._quotaListeners = new Set();
        this._lastEstimate = null; // Cached navigator.storage.estimate() result

        /**
         * Resolves once `initialize` has run, either way.
         *
         * Anything reading at module scope needs this. Features are initialized
         * long after the libraries load, so a module-scope read lands before the
         * database is open, gets the default back, and has no way to know the
         * difference between "not stored" and "not asked yet" — which is how
         * every remembered panel quietly forgot itself.
         */
        this.ready = new Promise((resolve) => {
            this._markReady = resolve;
        });
    }

    /**
     * Initialize the storage system
     * @returns {Promise<boolean>} Success status
     */
    async initialize() {
        try {
            await this.openDatabase();
            this.available = true;
            this._markReady(true);
            return true;
        } catch (error) {
            console.error('[Storage] Initialization failed:', error);
            this.available = false;
            this._markReady(false);
            return false;
        }
    }

    /**
     * Open IndexedDB database
     * @returns {Promise<void>}
     */
    openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                console.error('[Storage] Failed to open IndexedDB', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                this._dbNulledReason = null;
                this._setupDbEventHandlers();
                resolve();
            };

            request.onblocked = () => {
                console.warn('[Storage] IndexedDB open blocked by existing connection — retrying after close');
                this._dbNulledReason = 'onblocked';
                // Attempt to close any stale connection and retry once
                if (this.db) {
                    this.db.close();
                    this.db = null;
                }
                const retry = indexedDB.open(this.dbName, this.dbVersion);
                retry.onerror = () => {
                    console.error('[Storage] Retry failed to open IndexedDB', retry.error);
                    reject(retry.error);
                };
                retry.onsuccess = () => {
                    this.db = retry.result;
                    this._dbNulledReason = null;
                    this._setupDbEventHandlers();
                    resolve();
                };
                retry.onupgradeneeded = request.onupgradeneeded;
                retry.onblocked = () => {
                    console.error('[Storage] IndexedDB still blocked after retry — DB unavailable');
                    reject(new Error('IndexedDB blocked'));
                };
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create settings store if it doesn't exist
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings');
                }

                // Create rerollSpending store if it doesn't exist (for task reroll tracker)
                if (!db.objectStoreNames.contains('rerollSpending')) {
                    db.createObjectStore('rerollSpending');
                }

                // Create dungeonRuns store if it doesn't exist (for dungeon tracker)
                if (!db.objectStoreNames.contains('dungeonRuns')) {
                    db.createObjectStore('dungeonRuns');
                }

                // Create teamRuns store if it doesn't exist (for team-based backfill)
                if (!db.objectStoreNames.contains('teamRuns')) {
                    db.createObjectStore('teamRuns');
                }

                // Create combatExport store if it doesn't exist (for combat sim/milkonomy exports)
                if (!db.objectStoreNames.contains('combatExport')) {
                    db.createObjectStore('combatExport');
                }

                // Create unifiedRuns store if it doesn't exist (for dungeon tracker unified storage)
                if (!db.objectStoreNames.contains('unifiedRuns')) {
                    db.createObjectStore('unifiedRuns');
                }

                // Create marketListings store if it doesn't exist (for estimated listing ages)
                if (!db.objectStoreNames.contains('marketListings')) {
                    db.createObjectStore('marketListings');
                }

                // Create combatStats store if it doesn't exist (for combat statistics feature)
                if (!db.objectStoreNames.contains('combatStats')) {
                    db.createObjectStore('combatStats');
                }

                // Create xpHistory store if it doesn't exist (for XP/hr tracker)
                if (!db.objectStoreNames.contains('xpHistory')) {
                    db.createObjectStore('xpHistory');
                }

                // Create alchemyHistory store if it doesn't exist (for transmute history tracker)
                if (!db.objectStoreNames.contains('alchemyHistory')) {
                    db.createObjectStore('alchemyHistory');
                }

                // Create labyrinth store if it doesn't exist (for labyrinth tracker)
                if (!db.objectStoreNames.contains('labyrinth')) {
                    db.createObjectStore('labyrinth');
                }

                // Create guildHistory store if it doesn't exist (for guild XP tracker)
                if (!db.objectStoreNames.contains('guildHistory')) {
                    db.createObjectStore('guildHistory');
                }

                // Create networthHistory store if it doesn't exist (for networth chart)
                if (!db.objectStoreNames.contains('networthHistory')) {
                    db.createObjectStore('networthHistory');
                }

                // Create collections store if it doesn't exist (for collection filters feature)
                if (!db.objectStoreNames.contains('collections')) {
                    db.createObjectStore('collections');
                }

                // Create queueSnapshots store if it doesn't exist (for cross-character queue monitor)
                if (!db.objectStoreNames.contains('queueSnapshots')) {
                    db.createObjectStore('queueSnapshots');
                }

                // Create lootLogHistory store if it doesn't exist (for extended loot log)
                if (!db.objectStoreNames.contains('lootLogHistory')) {
                    db.createObjectStore('lootLogHistory');
                }

                // Create leaderboardHistory store if it doesn't exist (for leaderboard XP tracker)
                if (!db.objectStoreNames.contains('leaderboardHistory')) {
                    db.createObjectStore('leaderboardHistory');
                }
            };
        });
    }

    /**
     * Get a value from storage
     * @param {string} key - Storage key
     * @param {string} storeName - Object store name (default: 'settings')
     * @param {*} defaultValue - Default value if key doesn't exist
     * @returns {Promise<*>} The stored value or default
     */
    async get(key, storeName = 'settings', defaultValue = null) {
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, returning default for key: ${key}`);
            return defaultValue;
        }

        return new Promise((resolve, _reject) => {
            try {
                const transaction = this.db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.get(key);

                request.onsuccess = () => {
                    resolve(request.result != null ? request.result : defaultValue);
                };

                request.onerror = () => {
                    console.error(`[Storage] Failed to get key ${key}:`, request.error);
                    resolve(defaultValue);
                };
            } catch (error) {
                console.error(`[Storage] Get transaction failed for key ${key}:`, error);
                resolve(defaultValue);
            }
        });
    }

    /**
     * Read several keys from one store in a single readonly transaction.
     *
     * A feature that needs a handful of its own records at startup used to
     * await them one after another, paying a round trip apiece; here every
     * get is issued on the same transaction and the result arrives together.
     * Semantics per key match `get` with a null default: a key that is absent,
     * stored as null, or could not be read maps to null.
     * @param {Array<string>} keys - Storage keys
     * @param {string} storeName - Object store name (default: 'settings')
     * @returns {Promise<Map<string, *>>} key → value, null where there was nothing to read
     */
    async getMany(keys, storeName = 'settings') {
        const result = new Map();
        for (const key of keys) result.set(key, null);
        if (keys.length === 0) return result;

        if (!this.db && !(await this._awaitConnection())) {
            console.warn(
                `[Storage] Database not available, returning defaults for ${keys.length} keys in ${storeName}`
            );
            return result;
        }

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                let remaining = keys.length;
                const settleOne = () => {
                    remaining -= 1;
                    if (remaining === 0) resolve(result);
                };
                // An aborted transaction may leave some requests without an
                // event of their own; whatever was read by then is the answer
                transaction.onabort = () => resolve(result);
                transaction.onerror = () => resolve(result);

                for (const key of keys) {
                    const request = store.get(key);
                    request.onsuccess = () => {
                        if (request.result != null) result.set(key, request.result);
                        settleOne();
                    };
                    request.onerror = () => {
                        console.error(`[Storage] Failed to get key ${key}:`, request.error);
                        settleOne();
                    };
                }
            } catch (error) {
                console.error(`[Storage] getMany transaction failed for ${storeName}:`, error);
                resolve(result);
            }
        });
    }

    /**
     * Read a key and say whether the read itself worked.
     *
     * `get` folds "the key is absent" and "the database could not be read"
     * into one default value, which is the right shape for a setting and the
     * wrong shape for a history: a writer that takes a failed read for an empty
     * record and writes it back has just erased the record. This returns
     * `null` when the read could not be trusted — database unavailable, a
     * transaction that failed — so a read-merge-write caller can decline to
     * write rather than write blind.
     * @param {string} key - Storage key
     * @param {string} storeName - Object store name (default: 'settings')
     * @returns {Promise<{found: boolean, value: *}|null>} The read, or null when it could not be made
     */
    async tryGet(key, storeName = 'settings') {
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot read key: ${key}`);
            return null;
        }

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.get(key);

                request.onsuccess = () => {
                    const value = request.result;
                    resolve(value != null ? { found: true, value } : { found: false, value: null });
                };

                request.onerror = () => {
                    console.error(`[Storage] Failed to read key ${key}:`, request.error);
                    resolve(null);
                };
            } catch (error) {
                console.error(`[Storage] Read transaction failed for key ${key}:`, error);
                resolve(null);
            }
        });
    }

    /**
     * Set a value in storage (debounced by default)
     * @param {string} key - Storage key
     * @param {*} value - Value to store
     * @param {string} storeName - Object store name (default: 'settings')
     * @param {boolean} immediate - If true, save immediately without debouncing
     * @returns {Promise<boolean>} Success status
     */
    async set(key, value, storeName = 'settings', immediate = false) {
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot save key: ${key}`);
            return false;
        }

        if (immediate) {
            return this._saveToIndexedDB(key, value, storeName);
        } else {
            return this._debouncedSave(key, value, storeName);
        }
    }

    /**
     * Internal: Save to IndexedDB (immediate)
     * @private
     */
    async _saveToIndexedDB(key, value, storeName) {
        // The debounced flush reaches here without `set`'s guard; a write that
        // lands in a reconnect gap waits it out the same way (a refused
        // debounced write is requeued by the caller, so this only shortens the
        // retry) — and `this.db` is then read inside the promise, not before
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot save key: ${key}`);
            return false;
        }
        return new Promise((resolve, _reject) => {
            let settled = false;
            /**
             * Resolve once, whichever of request/transaction reports first.
             * A quota failure fires both `request.onerror` and the transaction's
             * abort, and a promise that resolves twice hides the second one.
             * @param {boolean} success - Whether the write landed
             * @param {*} error - The error to classify, if it did not
             */
            const settle = (success, error) => {
                if (settled) return;
                settled = true;
                if (!success && this._isQuotaError(error)) {
                    this._handleQuotaExceeded(key, storeName, error);
                }
                resolve(success);
            };

            try {
                const transaction = this.db.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const request = store.put(value, key);

                request.onsuccess = () => {
                    settle(true, null);
                };

                request.onerror = () => {
                    console.error(`[Storage] Failed to save key ${key}:`, request.error);
                    settle(false, request.error);
                };

                // A quota failure aborts the whole transaction; without this the
                // only signal is a request error the browser may not deliver
                transaction.onabort = () => {
                    console.error(`[Storage] Save transaction aborted for key ${key}:`, transaction.error);
                    settle(false, transaction.error);
                };
            } catch (error) {
                console.error(`[Storage] Save transaction failed for key ${key}:`, error);
                settle(false, error);
            }
        });
    }

    /**
     * Whether an error is the browser saying "no room".
     *
     * Chromium throws `QuotaExceededError`, Firefox has historically used
     * `NS_ERROR_DOM_QUOTA_REACHED`, and legacy DOMException code 22 covers the
     * rest — all three mean the same thing to everything upstream of here.
     * @param {*} error - Error from a failed request or transaction
     * @returns {boolean} True when the failure was a space failure
     * @private
     */
    _isQuotaError(error) {
        if (!error) return false;
        const name = error.name || '';
        if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
        if (error.code === 22) return true;
        return /quota|storage is full|not enough space/i.test(error.message || '');
    }

    /**
     * Record that storage is full and tell anyone who asked to be told.
     * @param {string} key - The key whose write failed
     * @param {string} storeName - The store it was going to
     * @param {*} error - The originating error
     * @private
     */
    _handleQuotaExceeded(key, storeName, error) {
        this._quotaFailures += 1;
        this._lastQuotaTarget = { key, storeName };
        const firstTime = !this.quotaExceeded;
        this.quotaExceeded = true;
        this._quotaExceededAt = Date.now();

        console.error(`[Storage] Quota exceeded writing ${storeName}:${key} — recording will stand down:`, error);

        // Refresh the numbers so whatever shows this can say how full "full" is
        this.estimate();

        if (!firstTime) return;
        for (const listener of this._quotaListeners) {
            try {
                listener({ key, storeName, at: this._quotaExceededAt, estimate: this._lastEstimate });
            } catch (listenerError) {
                console.error('[Storage] Quota listener failed:', listenerError);
            }
        }
    }

    /**
     * Whether writes are currently failing for want of space.
     *
     * Recorders of bulky history — loot log, networth snapshots, enhancement
     * sessions — check this before building a payload and skip the work when it
     * is true, so a full disk costs one failed write rather than one per event.
     * @returns {boolean} True while storage is known to be full
     */
    isQuotaExceeded() {
        return this.quotaExceeded;
    }

    /**
     * Be told, once, the first time a write fails for space.
     * @param {Function} listener - Called with {key, storeName, at, estimate}
     * @returns {Function} Unsubscribe
     */
    onQuotaExceeded(listener) {
        if (typeof listener !== 'function') return () => {};
        this._quotaListeners.add(listener);
        return () => this._quotaListeners.delete(listener);
    }

    /**
     * Forget that storage was full, so recorders resume.
     *
     * Called automatically after a successful delete, since deleting is the one
     * thing that makes the original failure untrue.
     */
    clearQuotaState() {
        this.quotaExceeded = false;
        this._lastQuotaTarget = null;
    }

    /**
     * How much of the origin's storage is used, per the browser.
     *
     * `navigator.storage.estimate()` is an estimate in the literal sense —
     * padded, and quota is what the browser is willing to give rather than what
     * is free on disk. Good enough to tell "comfortable" from "about to fail",
     * which is the only distinction anything here draws.
     * @returns {Promise<{usage: number|null, quota: number|null, percent: number|null, at: number}|null>}
     *   The estimate, or null where the API is unavailable
     */
    async estimate() {
        try {
            if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
            const { usage, quota } = await navigator.storage.estimate();
            this._lastEstimate = {
                usage: usage ?? null,
                quota: quota ?? null,
                percent: usage != null && quota ? (usage / quota) * 100 : null,
                at: Date.now(),
            };
            return this._lastEstimate;
        } catch (error) {
            console.error('[Storage] Storage estimate failed:', error);
            return null;
        }
    }

    /**
     * The last estimate taken, without taking another.
     * @returns {Object|null} Cached estimate, or null if none has been taken
     */
    lastEstimate() {
        return this._lastEstimate;
    }

    /**
     * Key counts per store, against their soft budgets.
     *
     * Counting keys is one `getAllKeys()` per store and never touches a value,
     * which is why this is affordable at all — a byte-accurate size would mean
     * reading and serializing the entire database.
     * @param {Array<string>} [storeNames] - Restrict to these stores; defaults to all
     * @returns {Promise<Array<{storeName: string, keys: number, budget: number|null, over: boolean}>>}
     *   One row per store, over-budget rows first
     */
    async budgetReport(storeNames) {
        const names = storeNames ?? (await this.listStores());
        const rows = [];

        for (const storeName of names) {
            const keys = await this.getAllKeys(storeName);
            const budget = STORE_KEY_BUDGETS[storeName] ?? null;
            rows.push({
                storeName,
                keys: keys.length,
                budget,
                over: budget !== null && keys.length > budget,
            });
        }

        rows.sort((a, b) => Number(b.over) - Number(a.over) || b.keys - a.keys);
        return rows;
    }

    /**
     * Internal: Debounced save
     *
     * The entry is removed from pendingWrites only after a confirmed success, and
     * only if no newer write has claimed the slot in the meantime. A failed write —
     * a dropped connection, an aborted transaction, a full disk — requeues the value
     * without a timer, so the next flushAll() or the next write to the same key
     * retries it instead of the value being lost.
     * @private
     */
    _debouncedSave(key, value, storeName) {
        const timerKey = `${storeName}:${key}`;

        const existing = this.pendingWrites.get(timerKey);
        const resolvers = existing?.resolvers || [];

        const generation = (this._writeGeneration.get(timerKey) || 0) + 1;
        this._writeGeneration.set(timerKey, generation);
        this.pendingWrites.set(timerKey, { value, storeName, resolvers, generation });

        if (this.saveDebounceTimers.has(timerKey)) {
            clearTimeout(this.saveDebounceTimers.get(timerKey));
        }

        return new Promise((resolve) => {
            resolvers.push(resolve);

            const timer = setTimeout(async () => {
                this.saveDebounceTimers.delete(timerKey);

                const pending = this.pendingWrites.get(timerKey);
                if (!pending || pending.generation !== generation) {
                    // A newer write owns this slot — its timer persists the value and
                    // resolves every caller coalesced into it, including ours.
                    return;
                }

                // Take ownership: remove from the queue before attempting the save so a
                // concurrent newer write can claim the slot cleanly.
                this.pendingWrites.delete(timerKey);

                const success = await this._saveToIndexedDB(key, pending.value, pending.storeName);

                if (!success) {
                    if (!this.pendingWrites.has(timerKey)) {
                        // Requeue without a timer so the value survives for the next
                        // flushAll() or the next debounced write to this key. This is also
                        // what makes a quota failure recoverable: once space is freed, the
                        // retry writes the value that would otherwise have been dropped.
                        //
                        // The requeued entry carries no resolvers: two dozen callers await
                        // storage.set(), and holding their promises open until some later
                        // flush would hang them for the rest of the session. They are told
                        // the write failed now; the value is retried regardless.
                        this.pendingWrites.set(timerKey, {
                            value: pending.value,
                            storeName: pending.storeName,
                            resolvers: [],
                            generation: pending.generation,
                        });
                    }

                    for (const r of pending.resolvers) {
                        r(false);
                    }
                    return;
                }

                for (const r of pending.resolvers) {
                    r(true);
                }
            }, this.SAVE_DEBOUNCE_DELAY);

            this.saveDebounceTimers.set(timerKey, timer);
        });
    }

    /**
     * Get a JSON object from storage
     * @param {string} key - Storage key
     * @param {string} storeName - Object store name (default: 'settings')
     * @param {*} defaultValue - Default value if key doesn't exist
     * @returns {Promise<*>} The parsed object or default
     */
    async getJSON(key, storeName = 'settings', defaultValue = null) {
        const raw = await this.get(key, storeName, null);

        if (raw === null) {
            return defaultValue;
        }

        // If it's already an object, return it
        if (typeof raw === 'object') {
            return raw;
        }

        // Otherwise, try to parse as JSON string
        try {
            return JSON.parse(raw);
        } catch (error) {
            console.error(`[Storage] Error parsing JSON from storage (key: ${key}):`, error);
            return defaultValue;
        }
    }

    /**
     * Set a JSON object in storage
     * @param {string} key - Storage key
     * @param {*} value - Object to store
     * @param {string} storeName - Object store name (default: 'settings')
     * @param {boolean} immediate - If true, save immediately
     * @returns {Promise<boolean>} Success status
     */
    async setJSON(key, value, storeName = 'settings', immediate = false) {
        // IndexedDB can store objects directly, no need to stringify
        return this.set(key, value, storeName, immediate);
    }

    /**
     * Delete a key from storage
     * @param {string} key - Storage key to delete
     * @param {string} storeName - Object store name (default: 'settings')
     * @returns {Promise<boolean>} Success status
     */
    async delete(key, storeName = 'settings') {
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot delete key: ${key}`);
            return false;
        }

        return new Promise((resolve, _reject) => {
            try {
                const transaction = this.db.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const request = store.delete(key);

                request.onsuccess = () => {
                    // Deleting is the one operation that makes "storage is full"
                    // untrue, so it is where standing-down recorders are let up
                    this.clearQuotaState();
                    resolve(true);
                };

                request.onerror = () => {
                    console.error(`[Storage] Failed to delete key ${key}:`, request.error);
                    resolve(false);
                };
            } catch (error) {
                console.error(`[Storage] Delete transaction failed for key ${key}:`, error);
                resolve(false);
            }
        });
    }

    /**
     * Check if a key exists in storage
     * @param {string} key - Storage key to check
     * @param {string} storeName - Object store name (default: 'settings')
     * @returns {Promise<boolean>} True if key exists
     */
    async has(key, storeName = 'settings') {
        if (!this.db && !(await this._awaitConnection())) {
            return false;
        }

        const value = await this.get(key, storeName, '__STORAGE_CHECK__');
        return value !== '__STORAGE_CHECK__';
    }

    /**
     * Get all keys from a store
     * @param {string} storeName - Object store name (default: 'settings')
     * @returns {Promise<Array<string>>} Array of keys
     */
    async getAllKeys(storeName = 'settings') {
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot get keys from store: ${storeName}`);
            return [];
        }

        return new Promise((resolve, _reject) => {
            try {
                const transaction = this.db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.getAllKeys();

                request.onsuccess = () => {
                    resolve(request.result || []);
                };

                request.onerror = () => {
                    console.error(`[Storage] Failed to get all keys from ${storeName}:`, request.error);
                    resolve([]);
                };
            } catch (error) {
                console.error(`[Storage] GetAllKeys transaction failed for store ${storeName}:`, error);
                resolve([]);
            }
        });
    }

    /**
     * Get all key-value pairs from an object store
     * @param {string} storeName - Object store name
     * @returns {Promise<Object>} Map of key → value
     */
    async getAll(storeName = 'settings') {
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot get all from store: ${storeName}`);
            return {};
        }

        return new Promise((resolve, _reject) => {
            try {
                const transaction = this.db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const result = {};
                const cursorRequest = store.openCursor();

                cursorRequest.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        result[cursor.key] = cursor.value;
                        cursor.continue();
                    } else {
                        resolve(result);
                    }
                };

                cursorRequest.onerror = () => {
                    console.error(`[Storage] Failed to get all from ${storeName}:`, cursorRequest.error);
                    resolve({});
                };
            } catch (error) {
                console.error(`[Storage] GetAll transaction failed for store ${storeName}:`, error);
                resolve({});
            }
        });
    }

    /**
     * List every object store name currently defined in the database.
     * @returns {Promise<Array<string>>} Array of store names
     */
    async listStores() {
        if (!this.db) {
            console.warn('[Storage] Database not available, cannot list stores');
            return [];
        }

        return Array.from(this.db.objectStoreNames);
    }

    /**
     * Write multiple key/value pairs to a store in a single immediate transaction.
     *
     * Bypasses debouncing entirely. Debounced `set()` schedules one timer per key,
     * so writing hundreds of keys serially through it would mean hundreds of pending
     * timers (or hundreds of sequential `immediate` writes). This does it in one
     * readwrite transaction instead — use it for bulk operations like restore/import.
     * @param {string} storeName - Object store name
     * @param {Record<string, *>} entries - Map of key → value to write
     * @returns {Promise<number>} Number of entries successfully written
     */
    async putAll(storeName, entries) {
        if (!this.db) {
            console.warn(`[Storage] Database not available, cannot bulk write to store: ${storeName}`);
            return 0;
        }

        const keys = Object.keys(entries || {});
        if (keys.length === 0) {
            return 0;
        }

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const written = [];

                for (const key of keys) {
                    const request = store.put(entries[key], key);
                    request.onsuccess = () => {
                        written.push(key);
                    };
                    request.onerror = () => {
                        console.error(`[Storage] Failed to bulk-write key ${key} to ${storeName}:`, request.error);
                        if (this._isQuotaError(request.error)) {
                            this._handleQuotaExceeded(key, storeName, request.error);
                        }
                    };
                }

                transaction.oncomplete = () => {
                    resolve(written.length);
                };
                transaction.onerror = () => {
                    console.error(`[Storage] Bulk write transaction failed for store ${storeName}:`, transaction.error);
                    if (this._isQuotaError(transaction.error)) {
                        this._handleQuotaExceeded(keys[0], storeName, transaction.error);
                    }
                    resolve(written.length);
                };
            } catch (error) {
                console.error(`[Storage] Bulk write transaction failed for store ${storeName}:`, error);
                resolve(0);
            }
        });
    }

    /**
     * Force immediate save of all pending debounced writes
     */
    async flushAll() {
        // Clear all timers first
        for (const timer of this.saveDebounceTimers.values()) {
            if (timer) {
                clearTimeout(timer);
            }
        }
        this.saveDebounceTimers.clear();

        // Snapshot the pending writes rather than clearing the map upfront: an entry is
        // only removed once its write is confirmed, so a failure here leaves the value
        // queued for the next flush instead of discarding it.
        const writes = Array.from(this.pendingWrites.entries());

        for (const [timerKey, pending] of writes) {
            // Skip if a newer write has already replaced this entry.
            if (this.pendingWrites.get(timerKey) !== pending) continue;

            const colonIndex = timerKey.indexOf(':');
            const key = timerKey.substring(colonIndex + 1);

            const success = await this._saveToIndexedDB(key, pending.value, pending.storeName);

            if (success) {
                // Only remove if no newer write claimed the slot while we were writing.
                if (this.pendingWrites.get(timerKey) === pending) {
                    this.pendingWrites.delete(timerKey);
                }
            }

            for (const r of pending.resolvers || []) {
                r(success);
            }
        }
    }

    /**
     * Cleanup pending debounced writes without flushing
     */
    cleanupPendingWrites() {
        for (const timer of this.saveDebounceTimers.values()) {
            if (timer) {
                clearTimeout(timer);
            }
        }
        this.saveDebounceTimers.clear();

        // Resolve all pending Promises with false before clearing
        for (const pending of this.pendingWrites.values()) {
            for (const r of pending.resolvers || []) {
                r(false);
            }
        }
        this.pendingWrites.clear();
        this._writeGeneration.clear();
    }

    /**
     * Set up event handlers on the active DB connection.
     * @private
     */
    _setupDbEventHandlers() {
        if (!this.db) return;

        this.db.onversionchange = () => {
            console.warn('[Storage] DB connection lost: onversionchange fired (another tab/instance upgraded the DB)');
            this._dbNulledReason = 'onversionchange';
            this.db.close();
            this.db = null;
            this._reconnect();
        };

        this.db.onclose = () => {
            console.warn('[Storage] DB connection lost: onclose fired (connection dropped unexpectedly)');
            this._dbNulledReason = 'onclose';
            this.db = null;
            this._reconnect();
        };
    }

    /**
     * Attempt to reconnect to IndexedDB after the connection is lost.
     * @private
     */
    async _reconnect() {
        if (this._reconnecting) return;
        this._reconnecting = true;

        // Wait a brief moment for any version upgrade to complete
        await new Promise((r) => setTimeout(r, 500));

        try {
            await this.openDatabase();
            this.available = true;
            console.log('[Storage] Successfully reconnected to IndexedDB');
        } catch (error) {
            console.error('[Storage] Reconnection failed:', error);
            this.available = false;
            this._lastReconnectFailureAt = Date.now();
        } finally {
            this._reconnecting = false;
        }
    }

    /**
     * Wait, briefly, for a lost connection to come back before an operation
     * proceeds without it.
     *
     * Chromium drops IndexedDB connections — another tab upgrading the schema,
     * memory pressure, an extension churning the database — and `_reconnect`
     * reopens it within a second or so. During that gap every read used to
     * answer with its default and every write was refused, which is how a
     * module that loads a record, finds it "empty", and writes it back erased
     * real history. A read that waits out the gap is just a slow read.
     *
     * Only a *lost* connection is waited on. Before the first open (nothing to
     * wait for) and after a reconnect has recently failed (waiting again would
     * stall every operation for the whole outage) this returns at once.
     * @param {number} [timeoutMs=5000] - Longest to wait
     * @returns {Promise<boolean>} Whether a connection is available now
     */
    async _awaitConnection(timeoutMs = 5000) {
        if (this.db) return true;
        const lost = Boolean(this._dbNulledReason) || this._reconnecting;
        if (!lost) return false;
        if (this._lastReconnectFailureAt && Date.now() - this._lastReconnectFailureAt < 30_000) return false;

        const deadline = Date.now() + timeoutMs;
        while (!this.db && Date.now() < deadline) {
            if (!this._reconnecting) {
                // Nobody is bringing it back; start, but do not await — the loop
                // below watches for the result and the timeout bounds the wait
                this._reconnect();
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (this._lastReconnectFailureAt && this._lastReconnectFailureAt > deadline - timeoutMs) break;
        }
        return Boolean(this.db);
    }

    /**
     * Return diagnostic info about current storage state.
     * @returns {Object}
     */
    diagnostics() {
        return {
            dbExists: this.db !== null,
            available: this.available,
            dbName: this.dbName,
            dbVersion: this.dbVersion,
            reconnecting: this._reconnecting,
            lastNullReason: this._dbNulledReason,
            pendingWrites: this.pendingWrites.size,
            activeTimers: this.saveDebounceTimers.size,
            quotaExceeded: this.quotaExceeded,
            quotaExceededAt: this._quotaExceededAt,
            quotaFailures: this._quotaFailures,
            lastQuotaTarget: this._lastQuotaTarget,
            estimate: this._lastEstimate,
        };
    }
}

const storage = new Storage();

export { STORE_KEY_BUDGETS };
export default storage;
