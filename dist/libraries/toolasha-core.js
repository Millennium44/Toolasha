/**
 * Toolasha Core Library
 * Core infrastructure and API clients
 * Version: 2.95.1
 * License: CC-BY-NC-SA-4.0
 */

(function () {
    'use strict';

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
            if (!this.db) {
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
         * Set a value in storage (debounced by default)
         * @param {string} key - Storage key
         * @param {*} value - Value to store
         * @param {string} storeName - Object store name (default: 'settings')
         * @param {boolean} immediate - If true, save immediately without debouncing
         * @returns {Promise<boolean>} Success status
         */
        async set(key, value, storeName = 'settings', immediate = false) {
            if (!this.db) {
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
            if (!this.db) {
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
            if (!this.db) {
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
            if (!this.db) {
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
            if (!this.db) {
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
            } finally {
                this._reconnecting = false;
            }
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

    /**
     * Bundle Bridge
     *
     * The one place cross-bundle reach-throughs live.
     *
     * The production build is several iife bundles that load in order and publish
     * their initialized singletons on `window.Toolasha.*`. A module that needs a
     * singleton from a bundle that loads after its own — or one whose import would
     * copy a second, uninitialized instance into its own bundle — cannot import it;
     * it has to read the namespace at call time. Those reads used to be ~80 bare
     * `window.Toolasha?...` expressions scattered across the codebase, invisible to
     * grep-by-intent and unmockable in tests.
     *
     * Every accessor here returns the live, initialized module the namespace holds
     * — or `null`, honestly, when the owning bundle has not loaded (or the code is
     * running off-page, as in tests and workers). No accessor caches anything: the
     * namespace is the state, this module has none, which is also why a copy of it
     * per bundle would be harmless.
     *
     * Callers keep their own fallbacks where they had them (`loadoutSnapshot() ||
     * bundledCopy` for the single-bundle dev build); the bridge only answers "what
     * does the namespace hold right now".
     */

    /**
     * The published namespace itself, or null off-page.
     * @returns {Object|null} `window.Toolasha`, or null when there is no window or no namespace
     */
    function toolashaRoot$1() {
        return globalThis.window?.Toolasha || null;
    }

    // ---------------------------------------------------------------------------
    // Combat bundle singletons
    // ---------------------------------------------------------------------------

    /**
     * The initialized loadout snapshot store. Every other bundle's copy never
     * reads storage and answers "no loadout" to everything.
     * @returns {Object|null} The store, or null when the combat bundle is absent
     */
    function loadoutSnapshot() {
        return toolashaRoot$1()?.Combat?.loadoutSnapshot || null;
    }

    /**
     * Settings Configuration
     * Organizes all script settings into logical groups for the settings UI
     */


    const settingsGroups = {
        ironCow: {
            title: 'Iron Cow Mode',
            icon: '🐄',
            settings: {
                ironCow_enabled: {
                    id: 'ironCow_enabled',
                    label: 'Iron Cow Mode',
                    type: 'checkbox',
                    default: false,
                    hidden: true,
                    help: 'Disable all market and profit features for a no-marketplace playthrough.',
                },
            },
        },

        general: {
            title: 'General Settings',
            icon: '⚙️',
            settings: {
                whatsNew_showPopup: {
                    id: 'whatsNew_showPopup',
                    label: "Show what's new after an update",
                    type: 'checkbox',
                    default: true,
                    help:
                        'Once per new version, shows what changed and lists any new settings with live switches — ' +
                        'so an update never quietly rearranges things.',
                },
                whatsNew_newDefaultsOff: {
                    id: 'whatsNew_newDefaultsOff',
                    label: 'New settings start turned off',
                    type: 'checkbox',
                    default: false,
                    help:
                        'When an update introduces a new on-by-default switch, keep it off until you turn it on ' +
                        'yourself. Numbers and dropdowns keep their defaults — only behaviour switches are held back.',
                },
                mobileMode: {
                    id: 'mobileMode',
                    label: 'Mobile mode',
                    type: 'select',
                    default: 'auto',
                    options: [
                        { value: 'auto', label: 'Auto-detect' },
                        { value: 'on', label: 'On' },
                        { value: 'off', label: 'Off' },
                    ],
                    help:
                        'Adjusts for touch screens: bigger resize grips, panels sized to the viewport. Auto-detect keys ' +
                        'on whether the primary pointer is a finger, which a touchscreen laptop can override here.',
                },
                chatCommands: {
                    id: 'chatCommands',
                    label: 'Enable chat commands (/item, /wiki, /market)',
                    type: 'checkbox',
                    default: true,
                    help: 'Type /item, /wiki, or /market followed by an item name in chat. Example: /item radiant fiber',
                },
                chat_mentionTracker: {
                    id: 'chat_mentionTracker',
                    label: 'Show badge when mentioned in chat',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays a red badge on chat tabs when someone @mentions you',
                },
                chat_profileLink: {
                    id: 'chat_profileLink',
                    label: 'Chat: Clickable names in announcements',
                    type: 'checkbox',
                    default: true,
                    help: 'Makes the player name in system announcements (e.g. "PlayerName has reached level 150 Magic!" or "PlayerName has joined the guild!") clickable — clicking it fills "/profile name" into the chat input.',
                },
                chat_popOut: {
                    id: 'chat_popOut',
                    label: 'Enable Pop-out Chat Window button',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a button to the chat panel to open chat in a separate browser window with multi-channel split view',
                },
                chatHistoryExtender: {
                    id: 'chatHistoryExtender',
                    label: 'Chat: Extend chat history',
                    type: 'checkbox',
                    default: true,
                    help: 'Preserves messages that the game removes from the live buffer, keeping them visible above the live chat',
                },
                chatHistoryExtender_maxHistory: {
                    id: 'chatHistoryExtender_maxHistory',
                    label: 'Chat: Max messages to retain per tab',
                    type: 'text',
                    default: '150',
                },
                altClickNavigation: {
                    id: 'altClickNavigation',
                    label: 'Alt+click items to navigate to crafting/gathering or dictionary',
                    type: 'checkbox',
                    default: true,
                    help: 'Hold Alt/Option and click any item to navigate to its crafting/gathering page, or item dictionary if not craftable',
                },
                collectionNavigation: {
                    id: 'collectionNavigation',
                    label: 'Add navigation buttons to collection items',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds View Action and Item Dictionary buttons when clicking collection items',
                },
                queueMonitor: {
                    id: 'queueMonitor',
                    label: 'Cross-character queue monitor',
                    type: 'checkbox',
                    default: false,
                    help: 'Shows estimated queue time remaining for your other characters in a floating widget',
                },
            },
        },

        actionBar: {
            title: 'Action Bar',
            icon: '⚡',
            settings: {
                actionBar_enabled: {
                    id: 'actionBar_enabled',
                    label: 'Action bar: Enable action bar display',
                    type: 'checkbox',
                    default: true,
                },
                actionBar_compactWidth: {
                    id: 'actionBar_compactWidth',
                    label: 'Action bar: Compact width (800px limit)',
                    type: 'checkbox',
                    default: false,
                    help: 'Limits action bar width to 800px. Useful for wide monitors.',
                },
                actionBar_showQueueCount: {
                    id: 'actionBar_showQueueCount',
                    label: 'Action bar: Queue/remaining count',
                    type: 'checkbox',
                    default: true,
                },
                actionBar_showActionDuration: {
                    id: 'actionBar_showActionDuration',
                    label: 'Action bar: Time per action (e.g. 14.94s/action)',
                    type: 'checkbox',
                    default: true,
                },
                actionBar_showActionsPerHour: {
                    id: 'actionBar_showActionsPerHour',
                    label: 'Action bar: Actions/hr and items/hr',
                    type: 'checkbox',
                    default: true,
                },
                actionBar_showTimeRemaining: {
                    id: 'actionBar_showTimeRemaining',
                    label: 'Action bar: Time remaining and completion ETA',
                    type: 'checkbox',
                    default: true,
                },
                actionBar_showRecycleTime: {
                    id: 'actionBar_showRecycleTime',
                    label: 'Action bar: Transmute recycle time estimate',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows estimated total time accounting for self-return recycling during transmute actions',
                },
                actionBar_showProfit: {
                    id: 'actionBar_showProfit',
                    label: 'Action bar: Show current action profit',
                    type: 'checkbox',
                    default: false,
                    help: 'Displays profit/hr and remaining profit for the current action (gathering and production)',
                },
                actionPanel_liveCountdown: {
                    id: 'actionPanel_liveCountdown',
                    label: 'Action bar: Live countdown timer',
                    type: 'checkbox',
                    default: false,
                    help: 'Replaces the static time display on the action progress bar with a live countdown in seconds',
                },
            },
        },

        skillPageTiles: {
            title: 'Skill Page & Tiles',
            icon: '🗃️',
            settings: {
                actionPanel_showFilter: {
                    id: 'actionPanel_showFilter',
                    label: 'Skill page: Filter actions input',
                    type: 'checkbox',
                    default: true,
                },
                actionPanel_showSort: {
                    id: 'actionPanel_showSort',
                    label: 'Skill page: Sort button',
                    type: 'checkbox',
                    default: true,
                },
                actionPanel_showPricingMode: {
                    id: 'actionPanel_showPricingMode',
                    label: 'Skill page: Pricing mode button',
                    type: 'checkbox',
                    default: true,
                },
                actionPanel_showCraftToggle: {
                    id: 'actionPanel_showCraftToggle',
                    label: 'Skill page: Craft toggle button',
                    type: 'checkbox',
                    default: true,
                },
                actionPanel_showProfitPerHour_gathering: {
                    id: 'actionPanel_showProfitPerHour_gathering',
                    label: 'Action page: Show profit/hr on gathering tiles',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays profit/hr on gathering action tiles (Foraging, Woodcutting, etc.)',
                },
                actionPanel_showProfitPerHour_production: {
                    id: 'actionPanel_showProfitPerHour_production',
                    label: 'Action page: Show profit/hr on production tiles',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays profit/hr on production action tiles (Crafting, Tailoring, etc.)',
                },
                actionPanel_showExpPerHour_gathering: {
                    id: 'actionPanel_showExpPerHour_gathering',
                    label: 'Action page: Show exp/hr on gathering tiles',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays exp/hr on gathering action tiles (Foraging, Woodcutting, etc.)',
                },
                actionPanel_showExpPerHour_production: {
                    id: 'actionPanel_showExpPerHour_production',
                    label: 'Action page: Show exp/hr on production tiles',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays exp/hr on production action tiles (Crafting, Tailoring, etc.)',
                },
                actionPanel_hideNegativeProfit: {
                    id: 'actionPanel_hideNegativeProfit',
                    label: 'Action panel: Hide actions with negative profit',
                    type: 'checkbox',
                    default: false,
                    help: 'Hides action panels that would result in a loss (negative profit/hr)',
                },
                inventoryCountDisplay: {
                    id: 'inventoryCountDisplay',
                    label: 'Action panels: Show current inventory count of output item',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows how many of the output item you currently own, on action tiles and in the action detail panel',
                },
                actions_pinnedPage: {
                    id: 'actions_pinnedPage',
                    label: 'Pinned actions: Enable pinned actions page and pin icons',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a Pinned button to the left nav bar showing all pinned actions, and shows pin icons on action tiles.',
                },
            },
        },

        actionPanel: {
            title: 'Action Panel',
            icon: '📄',
            settings: {
                actionPanel_totalTime_quickInputs: {
                    id: 'actionPanel_totalTime_quickInputs',
                    label: 'Action panel: Quick input buttons (hours, count presets, Max)',
                    type: 'checkbox',
                    default: true,
                    requiresRefresh: true,
                },
                actionPanel_quickInputs_countPresets: {
                    id: 'actionPanel_quickInputs_countPresets',
                    label: 'Action panel: Custom count presets (comma-separated, e.g. 100,1000,1000000)',
                    type: 'text',
                    default: '',
                },
                actionPanel_quickInputs_hourPresets: {
                    id: 'actionPanel_quickInputs_hourPresets',
                    label: 'Action panel: Custom hour presets (comma-separated, e.g. 0.5,1,24,168,720)',
                    type: 'text',
                    default: '',
                },
                actionPanel_foragingTotal: {
                    id: 'actionPanel_foragingTotal',
                    label: 'Action panel: Overall profit for multi-outcome foraging',
                    type: 'checkbox',
                    default: true,
                },
                actionPanel_outputTotals: {
                    id: 'actionPanel_outputTotals',
                    label: 'Action panel: Show total expected outputs below per-action outputs',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays calculated totals when you enter a quantity in the action input',
                },
                actionPanel_maxProduceable: {
                    id: 'actionPanel_maxProduceable',
                    label: 'Action panel: Show max produceable count on crafting actions',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays how many items you can make based on current inventory',
                },
                actionPanel_showProfitDetail: {
                    id: 'actionPanel_showProfitDetail',
                    label: 'Action panel: Show profitability detail',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays the profitability breakdown section inside gathering, production, and alchemy action panels',
                },
                actionPanel_showLevelProgress: {
                    id: 'actionPanel_showLevelProgress',
                    label: 'Action panel: Show level progress',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays XP and level progress estimates inside action panels',
                },
                actionPanel_showSpeedTime: {
                    id: 'actionPanel_showSpeedTime',
                    label: 'Action panel: Show action speed & time',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays speed breakdown, efficiency, and total time inside action panels',
                },
                requiredMaterials: {
                    id: 'requiredMaterials',
                    label: 'Action panel: Show total required and missing materials',
                    type: 'checkbox',
                    default: true,
                    requiresRefresh: true,
                    help: 'Displays total materials needed and shortfall when entering quantity',
                },
                actionPanel_enhanceMatLimitProtections: {
                    id: 'actionPanel_enhanceMatLimitProtections',
                    label: 'Enhancement material limit: Include protection items',
                    type: 'checkbox',
                    default: true,
                    help: 'When enabled, protection item availability is factored into the material limit estimate. Disable to see material limit based only on enhancement materials.',
                },
            },
        },

        actionQueue: {
            title: 'Action Queue',
            icon: '📌',
            settings: {
                actionQueue: {
                    id: 'actionQueue',
                    label: 'Queued actions: Show total time and completion time',
                    type: 'checkbox',
                    default: true,
                },
                actionQueue_showValue: {
                    id: 'actionQueue_showValue',
                    label: 'Queued actions: Show profit/value for queued actions',
                    type: 'checkbox',
                    default: true,
                },
                actionQueue_valueMode: {
                    id: 'actionQueue_valueMode',
                    label: 'Queued actions: Value calculation mode',
                    type: 'select',
                    default: 'profit',
                    options: [
                        { value: 'profit', label: 'Total Profit (revenue - all costs)' },
                        { value: 'estimated_value', label: 'Estimated Value (revenue after tax)' },
                    ],
                    help: 'Choose how to calculate the total value for queued actions. Profit shows net earnings after materials and drinks. Estimated Value shows gross revenue after market tax (always positive).',
                },
            },
        },

        alchemy: {
            title: 'Alchemy',
            icon: '⚗️',
            settings: {
                alchemy_profitDisplay: {
                    id: 'alchemy_profitDisplay',
                    label: 'Alchemy panel: Show profit calculator',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays profit/hour and profit/day for alchemy actions based on success rate and market prices',
                },
                alchemy_bestItems: {
                    id: 'alchemy_bestItems',
                    label: 'Alchemy panel: Show best items button',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a button to see items ranked by profit or XP for each alchemy type.',
                },
                alchemyItemPins: {
                    id: 'alchemyItemPins',
                    label: 'Alchemy panel: Pin items in the item picker',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a 📌 to each item in the Alchemize Item list that moves it to the front. Kept per action, since what is worth coinifying is rarely what is worth decomposing. Pins reorder but do not exempt: a pinned item that does not match the filter box stays hidden',
                },
                alchemy_transmuteHistory: {
                    id: 'alchemy_transmuteHistory',
                    label: 'Alchemy panel: Track and view transmute session history',
                    type: 'checkbox',
                    default: true,
                    help: 'Records transmutation sessions and displays history in a viewer tab in the Alchemy panel',
                },
                alchemy_coinifyHistory: {
                    id: 'alchemy_coinifyHistory',
                    label: 'Alchemy panel: Track and view coinify session history',
                    type: 'checkbox',
                    default: true,
                    help: 'Records coinify sessions and displays history in a viewer tab in the Alchemy panel',
                },
                alchemy_decomposeHistory: {
                    id: 'alchemy_decomposeHistory',
                    label: 'Alchemy panel: Track and view decompose session history',
                    type: 'checkbox',
                    default: true,
                    help: 'Records decompose sessions and displays history in a viewer tab in the Alchemy panel',
                },
                alchemy_actionProtection: {
                    id: 'alchemy_actionProtection',
                    label: 'Alchemy panel: Protect categories from accidental alchemy actions',
                    type: 'checkbox',
                    default: true,
                    help: 'Blocks alchemy action buttons for 3 seconds when the selected item belongs to a protected category. A shield icon appears in the alchemy panel to configure protected categories.',
                },
                alchemyItemDimming: {
                    id: 'alchemyItemDimming',
                    label: 'Alchemy panel: Dim items requiring higher level',
                    type: 'checkbox',
                    default: true,
                },
            },
        },

        missingMaterials: {
            title: 'Missing Materials & Crafting Plan',
            icon: '🛒',
            settings: {
                actionPanelLayout: {
                    id: 'actionPanelLayout',
                    label: 'Keep the action panel on screen',
                    type: 'checkbox',
                    default: true,
                    help: 'Stops the action detail panel growing past the window: it scrolls instead, and the Queue and Start buttons stay pinned to the bottom rather than falling off it. Also tightens the spacing of the added sections.',
                },
                actions_missingMaterialsButton: {
                    id: 'actions_missingMaterialsButton',
                    label: 'Show "Missing Mats Marketplace" button on production panels',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds button to production panels that opens marketplace with tabs for missing materials',
                },
                actions_missingMaterialsButton_ignoreQueue: {
                    id: 'actions_missingMaterialsButton_ignoreQueue',
                    label: 'Ignore queued actions when calculating missing materials',
                    type: 'checkbox',
                    default: false,
                    help: 'When enabled, missing materials calculation only considers current action request, ignoring materials already reserved by queued actions. Default (off) accounts for queue.',
                },
                actions_budgetCalculator: {
                    id: 'actions_budgetCalculator',
                    label: 'Action panel: Budget calculator',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a budget input below the Missing Mats button. Enter a gold budget (e.g. 50m) to calculate how many units you can produce by buying missing tradeable materials at ask price.',
                },
                actions_costSummary: {
                    id: 'actions_costSummary',
                    label: 'Action panel: Show cost summary',
                    type: 'checkbox',
                    default: true,
                    help: 'Compact 4-line cost comparison for the selected produce quantity: direct recipe cost, missing direct mats, best crafting plan, and finished item market price.',
                },
                actionPanel_bestCraftingPlan: {
                    id: 'actionPanel_bestCraftingPlan',
                    label: 'Action panel: Show best crafting plan',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows the cheapest way to obtain a crafted item by comparing buy vs craft at each material tier.',
                },
                actionPanel_craftingPlanBuyIntermediates: {
                    id: 'actionPanel_craftingPlanBuyIntermediates',
                    label: 'Action panel: Crafting plan buys raw materials only',
                    type: 'checkbox',
                    default: false,
                    help: 'Always craft items that have a recipe — only buy uncraftable raw materials from the market.',
                },
                actionPanel_craftingPlanNoProcessing: {
                    id: 'actionPanel_craftingPlanNoProcessing',
                    label: 'Action panel: Crafting plan no processing',
                    type: 'checkbox',
                    default: false,
                    help: 'Only craft the final item — buy all sub-materials from the market instead of processing them yourself.',
                },
                actionPanel_craftingPlanTaskMode: {
                    id: 'actionPanel_craftingPlanTaskMode',
                    label: 'Action panel: Crafting plan task mode',
                    type: 'checkbox',
                    default: false,
                    help: 'Forces the final craft step (for task credit) but allows buying intermediate materials if cheaper.',
                },
                actionPanel_craftingPlanTimeCost: {
                    id: 'actionPanel_craftingPlanTimeCost',
                    label: 'Action panel: Crafting plan time cost',
                    type: 'checkbox',
                    default: false,
                    help: 'Factor in the time cost of crafting when deciding buy vs craft. Uses your gold/hr value to determine if crafting is worth your time.',
                },
                actionPanel_craftingPlanGoldPerHour: {
                    id: 'actionPanel_craftingPlanGoldPerHour',
                    label: 'Action panel: Crafting plan gold/hr value',
                    type: 'number',
                    default: 0,
                    help: 'Your time value in gold per hour. Used to calculate if crafting intermediates is worth the time. Set to your typical hourly profit (e.g., 500000).',
                },
                actions_artisanMaterialMode: {
                    id: 'actions_artisanMaterialMode',
                    label: 'Missing materials: Artisan requirement mode',
                    type: 'select',
                    default: 'expected',
                    options: [
                        { value: 'expected', label: 'Expected value (average)' },
                        { value: 'worst-case', label: 'Worst-case per action (ceil per craft)' },
                    ],
                    help: 'Choose how missing materials accounts for Artisan Tea reductions when suggesting what to buy.',
                },
            },
        },

        lootLog: {
            title: 'Loot Log',
            icon: '📦',
            settings: {
                treasureTracker_popup: {
                    id: 'treasureTracker_popup',
                    label: "Treasure Tracker: Pop up what an opening paid, beside the game's loot dialog",
                    type: 'checkbox',
                    default: true,
                    help: "The game's Opened Loot dialog says what you got; this says whether it was good, item by item, against what the drop table owed",
                },
                treasureTracker: {
                    id: 'treasureTracker',
                    label: 'Treasure Tracker: Record chest openings and compare against expected value',
                    type: 'checkbox',
                    default: true,
                    help: 'Tracks what every chest you open actually paid out against what its drop table says it owes. Open the panel from the Treasure button on the settings page',
                },
                watchlist: {
                    id: 'watchlist',
                    label: "Watchlist: Track chosen items, a zone's drops, or a chest's contents",
                    type: 'checkbox',
                    default: true,
                    help: 'A list of items with what you hold and what it is worth. Tick a combat zone to add everything it drops, or a chest to add everything it contains. Tracked items get a dot in the inventory, and anything the vendor pays more for than the market is flagged. Open it from the Watchlist overlay row',
                },
                watchlist_menuButton: {
                    id: 'watchlist_menuButton',
                    label: 'Watchlist: Add a Track button to the item menu in your inventory',
                    type: 'checkbox',
                    default: false,
                    help: 'Puts a Track / Untrack button beside Sell when you click an inventory item. Off by default because it changes a menu you use for other things — the Watchlist panel has the same switch',
                },
                watchlist_inventoryDots: {
                    id: 'watchlist_inventoryDots',
                    label: 'Watchlist: Dot tracked items in the inventory',
                    type: 'checkbox',
                    default: true,
                    help: 'Puts a small dot in the corner of every inventory tile holding a tracked item. The point of a watchlist is knowing what is on it while you are looking at your inventory rather than while you are looking at the list — but it is one more mark on a busy grid, so it can be turned off. The Watchlist panel has the same switch',
                },
                equipmentSavings_menuButton: {
                    id: 'equipmentSavings_menuButton',
                    label: 'Equipment Savings: Add a Save for button to the item menu',
                    type: 'checkbox',
                    default: false,
                    help: 'Puts a Save for / Stop saving button beside Sell when you click a piece of equipment, which is how a target gets onto the Equipment Savings list. Off by default because it changes a menu you use for other things',
                },
                combatText_floating: {
                    id: 'combatText_floating',
                    label: 'Floating Combat Text: Damage numbers over the units taking them',
                    type: 'checkbox',
                    default: false,
                    help: 'A health bar tells you the state, not the event — "did that hit for 400 or 4,000" is a question a number answers and a bar does not',
                },
                combatText_scrolling: {
                    id: 'combatText_scrolling',
                    label: 'Scrolling Combat Text: Keep a log of recent hits',
                    type: 'checkbox',
                    default: false,
                    help: 'Adds a Combat Log overlay row with the last few hits, for anything that went past too fast to read',
                },
                manaTracker: {
                    id: 'manaTracker',
                    label: 'Mana Tracker: Count what your abilities cost per fight',
                    type: 'checkbox',
                    default: true,
                    help: 'Mana is the constraint nobody watches — it shows up only as the moment an ability does not fire. Adds a Mana/fight overlay row',
                },
                lootLogStats: {
                    id: 'lootLogStats',
                    label: 'Loot Log Statistics',
                    type: 'checkbox',
                    default: true,
                    help: 'Display total value, average time, and daily output in loot logs',
                },
                lootLogHistory: {
                    id: 'lootLogHistory',
                    label: 'Loot Log: Persist and display historical entries',
                    type: 'checkbox',
                    default: true,
                    help: 'Saves loot log entries and displays older entries below current ones in the loot log panel',
                },
                lootLogDropLuck: {
                    id: 'lootLogDropLuck',
                    label: 'Loot Log: Drop luck percentile for gathering runs',
                    type: 'checkbox',
                    default: true,
                    help: "Places a run's drop value in the distribution of everything those actions could have paid — 50 is typical, 5 means nineteen runs in twenty do better. Only for actions with their own drop table (gathering); combat has its own verdict and production rolls nothing",
                },
            },
        },

        tooltips: {
            title: 'Item Tooltip Enhancements',
            icon: '💬',
            settings: {
                itemTooltip_prices: {
                    id: 'itemTooltip_prices',
                    label: 'Show 24-hour average market prices',
                    type: 'checkbox',
                    default: true,
                },
                itemTooltip_effectivePrices: {
                    id: 'itemTooltip_effectivePrices',
                    label: 'Show effective (after-tax) prices',
                    type: 'checkbox',
                    default: false,
                    help: 'Shows what you actually receive after the 2% marketplace tax next to ask/bid prices in item tooltips',
                },
                itemTooltip_artisanPrices: {
                    id: 'itemTooltip_artisanPrices',
                    label: 'Adjust tooltip prices for Artisan Tea reduction',
                    type: 'checkbox',
                    default: true,
                    help: 'When viewing a recipe on an action panel, adjusts the total price to reflect actual material cost after Artisan Tea reduction',
                },
                itemTooltip_profit: {
                    id: 'itemTooltip_profit',
                    label: 'Show production cost and profit',
                    type: 'checkbox',
                    default: true,
                },
                itemTooltip_detailedProfit: {
                    id: 'itemTooltip_detailedProfit',
                    label: 'Show detailed materials breakdown in profit display',
                    type: 'checkbox',
                    default: false,
                    help: 'Shows material costs table with Ask/Bid prices, actions/hour, and profit breakdown',
                },
                itemTooltip_multiActionProfit: {
                    id: 'itemTooltip_multiActionProfit',
                    label: 'Show profit comparison for all item actions',
                    type: 'checkbox',
                    default: false,
                    help: 'Displays best profit/hr highlighted, with other alternative actions (craft, coinify, decompose, transmute) summarized below',
                },
                itemTooltip_expectedValue: {
                    id: 'itemTooltip_expectedValue',
                    label: 'Show expected value for openable containers',
                    type: 'checkbox',
                    default: true,
                },
                expectedValue_showDrops: {
                    id: 'expectedValue_showDrops',
                    label: 'Expected value drop display',
                    type: 'select',
                    default: 'All',
                    options: [
                        { value: 'Top 5', label: 'Top 5' },
                        { value: 'Top 10', label: 'Top 10' },
                        { value: 'All', label: 'All Drops' },
                        { value: 'None', label: 'Summary Only' },
                    ],
                },
                expectedValue_respectPricingMode: {
                    id: 'expectedValue_respectPricingMode',
                    label: 'Use pricing mode for expected value calculations',
                    type: 'checkbox',
                    default: true,
                },
                expectedValue_includeCowbells: {
                    id: 'expectedValue_includeCowbells',
                    label: 'Include cowbell value in expected value calculations',
                    type: 'checkbox',
                    default: true,
                },
                showConsumTips: {
                    id: 'showConsumTips',
                    label: 'HP/MP consumables: Restore speed, cost performance',
                    type: 'checkbox',
                    default: true,
                },
                dungeonTokenTooltips: {
                    id: 'dungeonTokenTooltips',
                    label: 'Currency tooltips: Show shop values for tokens, seals, and cowbells',
                    type: 'checkbox',
                    default: true,
                },
                itemTooltip_gathering: {
                    id: 'itemTooltip_gathering',
                    label: 'Show gathering sources and profit',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows gathering actions that produce this item (foraging, woodcutting, milking)',
                },
                itemTooltip_gatheringRareDrops: {
                    id: 'itemTooltip_gatheringRareDrops',
                    label: 'Show rare drops from gathering',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows rare find drops from gathering zones (e.g., Thread of Expertise from Asteroid Belt)',
                },
                itemTooltip_abilityStatus: {
                    id: 'itemTooltip_abilityStatus',
                    label: 'Show ability book status',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows whether ability is learned and current level/progress on ability book tooltips',
                },
                itemTooltip_enhancementMilestones: {
                    id: 'itemTooltip_enhancementMilestones',
                    label: 'Show enhancement milestones (+5/+7/+10/+12)',
                    type: 'checkbox',
                    default: false,
                    help: 'Shows expected cost and XP to reach +5, +7, +10, and +12 on unenhanced equipment tooltips',
                },
                itemTooltip_enhancementPath: {
                    id: 'itemTooltip_enhancementPath',
                    label: 'Show enhancement path on enhanced items',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows the optimal enhancement path cost breakdown when hovering over enhanced (+1 to +20) items',
                },
                itemTooltip_enhancementProRates: {
                    id: 'itemTooltip_enhancementProRates',
                    label: 'Quote enhancement predictions at pro rates instead of your stats',
                    type: 'checkbox',
                    default: false,
                    help: 'Prices the enhancement path and milestones as a top-end enhancer (level 140, Observatory 8, ultra + blessed tea, +13 Celestial enhancer, +10 gear) instead of your own gear and level. Also toggled from the "Yours / Pro" chip on the tooltip section header, or by pressing P while the tooltip is open.',
                },
                itemTooltip_enhancingHourlyRate: {
                    id: 'itemTooltip_enhancingHourlyRate',
                    label: 'Target hourly rate for enhancing (e.g. 50m)',
                    type: 'text',
                    default: '',
                    help: 'Adds a minimum sell price to the enhancement tooltip that covers total cost plus this rate for time spent. Leave blank to disable.',
                },
                itemTooltip_enhancingHourlyRateTax: {
                    id: 'itemTooltip_enhancingHourlyRateTax',
                    label: 'Include marketplace tax in minimum sell price',
                    type: 'checkbox',
                    default: false,
                    help: 'Accounts for the 2% marketplace seller tax so listing at minimum sell still nets your target rate after tax',
                },
                itemTooltip_pinTop: {
                    id: 'itemTooltip_pinTop',
                    label: 'Pin tooltips to top-center of screen',
                    type: 'checkbox',
                    default: false,
                    help: 'Forces item tooltips to always appear centered at the top of the screen instead of near the hovered item',
                },
                itemTooltip_hideInEnhanceSelector: {
                    id: 'itemTooltip_hideInEnhanceSelector',
                    label: 'Hide tooltip extras in enhance item selector',
                    type: 'checkbox',
                    default: false,
                    help: 'Suppresses injected tooltip content (prices, profit, milestones) when browsing items in the enhancement selector',
                },
                itemDictionary_transmuteRates: {
                    id: 'itemDictionary_transmuteRates',
                    label: 'Item Dictionary: Show transmutation success rates',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays success rate percentages in the "Transmuted From (Alchemy)" section',
                },
                itemDictionary_transmuteIncludeBaseRate: {
                    id: 'itemDictionary_transmuteIncludeBaseRate',
                    label: 'Item Dictionary: Include base success rate in transmutation percentages',
                    type: 'checkbox',
                    default: true,
                    help: 'When enabled, shows total probability (base rate × drop rate). When disabled, shows conditional probability (drop rate only, matching "Transmutes Into" section)',
                },
            },
        },

        enhancementSimulator: {
            title: 'Enhancement Simulator Settings',
            icon: '✨',
            settings: {
                enhanceSim: {
                    id: 'enhanceSim',
                    label: 'Show enhancement simulator calculations',
                    type: 'checkbox',
                    default: true,
                },
                enhanceSim_baseItemCraftingCost: {
                    id: 'enhanceSim_baseItemCraftingCost',
                    label: 'Enhancement path: Use crafting cost for base item if cheaper',
                    type: 'checkbox',
                    default: false,
                    help: 'When enabled, uses the lower of crafting cost or market price for the base item in enhancement path calculations, applied independently to both the Ask and Bid columns',
                },
                enhanceSim_autoTargetLevel: {
                    id: 'enhanceSim_autoTargetLevel',
                    label: 'Enhancement: Auto-fill target level on panel open (0 = disabled)',
                    type: 'number',
                    default: 0,
                    min: 0,
                    max: 20,
                    help: "When non-zero, automatically sets the Target Level input to this value whenever you open an item's enhancement panel. Re-applies each time you switch items.",
                },
                enhanceSim_autoProtectFrom: {
                    id: 'enhanceSim_autoProtectFrom',
                    label: 'Enhancement: Auto-fill optimal protect-from level when protection item is set',
                    type: 'checkbox',
                    default: false,
                    help: 'When enabled, automatically fills the Protect From Level input with the optimal (cheapest) value whenever a protection item is placed in the slot.',
                },
                enhanceSim_autoDetect: {
                    id: 'enhanceSim_autoDetect',
                    label: 'Auto-detect your stats (false = use settings below)',
                    type: 'checkbox',
                    default: false,
                    help: 'Most players should leave this off to see realistic professional enhancer costs',
                },
                // --- ENHANCING ---
                enhanceSim_enhancingLevel: {
                    id: 'enhanceSim_enhancingLevel',
                    label: 'Enhancing skill level',
                    type: 'number',
                    default: 140,
                    min: 1,
                    max: 200,
                    help: 'Default: 140 (professional enhancer level)',
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_houseLevel: {
                    id: 'enhanceSim_houseLevel',
                    label: 'Observatory house room level',
                    type: 'number',
                    default: 8,
                    min: 0,
                    max: 8,
                    help: 'Default: 8 (max level)',
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_achievement: {
                    id: 'enhanceSim_achievement',
                    label: 'Achievement bonus (+0.2%)',
                    type: 'checkbox',
                    default: false,
                    help: 'Include enhancing achievement success bonus',
                    disabledBy: 'enhanceSim_autoDetect',
                },
                // --- GEAR (compact rows: checkbox + optional tier + enhancement level) ---
                enhanceSim_gear_enhancer: {
                    id: 'enhanceSim_gear_enhancer',
                    label: 'Enhancer',
                    type: 'enhanceGear',
                    default: { enabled: true, tier: 'celestial', level: 13 },
                    tiers: [
                        { value: 'cheese', label: 'Cheese' },
                        { value: 'verdant', label: 'Verdant' },
                        { value: 'azure', label: 'Azure' },
                        { value: 'burble', label: 'Burble' },
                        { value: 'crimson', label: 'Crimson' },
                        { value: 'rainbow', label: 'Rainbow' },
                        { value: 'holy', label: 'Holy' },
                        { value: 'celestial', label: 'Celestial' },
                    ],
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_gear_gloves: {
                    id: 'enhanceSim_gear_gloves',
                    label: 'Gloves',
                    type: 'enhanceGear',
                    default: { enabled: true, level: 10 },
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_gear_top: {
                    id: 'enhanceSim_gear_top',
                    label: 'Top',
                    type: 'enhanceGear',
                    default: { enabled: true, level: 10 },
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_gear_bottoms: {
                    id: 'enhanceSim_gear_bottoms',
                    label: 'Bottoms',
                    type: 'enhanceGear',
                    default: { enabled: true, level: 10 },
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_gear_neck: {
                    id: 'enhanceSim_gear_neck',
                    label: 'Neck',
                    type: 'enhanceGear',
                    default: { enabled: true, tier: 'philo', level: 10 },
                    tiers: [
                        { value: 'philo', label: 'Philo' },
                        { value: 'speed', label: 'Speed' },
                    ],
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_gear_ring: {
                    id: 'enhanceSim_gear_ring',
                    label: 'Ring',
                    type: 'enhanceGear',
                    default: { enabled: true, tier: 'philo', level: 10 },
                    tiers: [
                        { value: 'philo', label: 'Philo' },
                        { value: 'rarefind', label: 'Rare Find' },
                    ],
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_gear_earring: {
                    id: 'enhanceSim_gear_earring',
                    label: 'Earring',
                    type: 'enhanceGear',
                    default: { enabled: true, tier: 'philo', level: 10 },
                    tiers: [
                        { value: 'philo', label: 'Philo' },
                        { value: 'rarefind', label: 'Rare Find' },
                    ],
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_gear_cape: {
                    id: 'enhanceSim_gear_cape',
                    label: 'Cape',
                    type: 'enhanceGear',
                    default: { enabled: true, tier: 'normal', level: 5 },
                    tiers: [
                        { value: 'normal', label: 'Normal' },
                        { value: 'refined', label: 'Refined' },
                    ],
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_gear_guzzling: {
                    id: 'enhanceSim_gear_guzzling',
                    label: 'Guzzling',
                    type: 'enhanceGear',
                    default: { enabled: true, level: 10 },
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_gear_charm: {
                    id: 'enhanceSim_gear_charm',
                    label: 'Charm',
                    type: 'enhanceGear',
                    default: { enabled: true, tier: 'grandmaster', level: 0 },
                    tiers: [
                        { value: 'trainee', label: 'Trainee' },
                        { value: 'basic', label: 'Basic' },
                        { value: 'advanced', label: 'Advanced' },
                        { value: 'expert', label: 'Expert' },
                        { value: 'master', label: 'Master' },
                        { value: 'grandmaster', label: 'Grandmaster' },
                    ],
                    disabledBy: 'enhanceSim_autoDetect',
                },
                // --- BUFFS ---
                enhanceSim_tea: {
                    id: 'enhanceSim_tea',
                    label: 'Enhancing tea',
                    type: 'select',
                    default: 'ultra',
                    options: [
                        { value: 'none', label: 'None' },
                        { value: 'basic', label: 'Enhancing Tea (+3)' },
                        { value: 'super', label: 'Super Enhancing Tea (+6)' },
                        { value: 'ultra', label: 'Ultra Enhancing Tea (+8)' },
                    ],
                    help: 'Enhancing tea provides skill level bonus',
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_blessedTea: {
                    id: 'enhanceSim_blessedTea',
                    label: 'Blessed Tea active',
                    type: 'checkbox',
                    default: true,
                    help: 'Professional enhancers use this to reduce attempts',
                    disabledBy: 'enhanceSim_autoDetect',
                },
                enhanceSim_communityBuff: {
                    id: 'enhanceSim_communityBuff',
                    label: 'Community Buff',
                    type: 'enhanceGear',
                    default: { enabled: true, level: 1 },
                    help: 'Enhancing speed community buff. Checked = auto-detect from game.',
                    checkedMeansAuto: true,
                    disabledBy: 'enhanceSim_autoDetect',
                },
            },
        },

        enhancementTracker: {
            title: 'Enhancement Tracker',
            icon: '📊',
            settings: {
                enhancementTracker: {
                    id: 'enhancementTracker',
                    label: 'Enable Enhancement Tracker',
                    type: 'checkbox',
                    default: false,
                    help: 'Track enhancement attempts, costs, and statistics',
                },
                enhancementTracker_showOnlyOnEnhancingScreen: {
                    id: 'enhancementTracker_showOnlyOnEnhancingScreen',
                    label: 'Show tracker only on Enhancing screen',
                    type: 'checkbox',
                    default: false,
                    help: 'Hide tracker when not on the Enhancing screen',
                },
                enhancementXPH: {
                    id: 'enhancementXPH',
                    label: 'Enhancement: XPH calculator',
                    type: 'checkbox',
                    default: true,
                    help: 'Ranks all enhanceable items by expected XP per hour at your current stats',
                },
                enhancementXPH_maxLevel: {
                    id: 'enhancementXPH_maxLevel',
                    label: 'Enhancement XPH: Default max enhancement level (1–20)',
                    type: 'text',
                    default: '6',
                },
                enhancementXPH_protectFrom: {
                    id: 'enhancementXPH_protectFrom',
                    label: 'Enhancement XPH: Default protect from level (0 = no protection)',
                    type: 'text',
                    default: '0',
                },
            },
        },

        marketplace: {
            title: 'Marketplace',
            icon: '🏪',
            settings: {
                sellQueue: {
                    id: 'sellQueue',
                    label: 'Sell Queue (Shift+RightClick inventory items)',
                    type: 'checkbox',
                    default: true,
                    help: 'Shift+RightClick an inventory item to open the marketplace and create a tab for it. Tabs close automatically when the item sells out.',
                },
                networkAlert: {
                    id: 'networkAlert',
                    label: 'Show alert when market price data cannot be fetched',
                    type: 'checkbox',
                    default: true,
                },
                marketFilter: {
                    id: 'marketFilter',
                    label: 'Marketplace: Filter by level, class, slot',
                    type: 'checkbox',
                    default: true,
                },
                marketSort: {
                    id: 'marketSort',
                    label: 'Marketplace: Sort items by profitability',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a button to sort marketplace items by profit/hour. Items without profit data (drop-only) appear at the end.',
                },
                fillMarketOrderPrice: {
                    id: 'fillMarketOrderPrice',
                    label: 'Auto-fill marketplace orders with optimal price',
                    type: 'checkbox',
                    default: true,
                },
                market_autoFillSellStrategy: {
                    id: 'market_autoFillSellStrategy',
                    label: 'Auto-fill sell price strategy',
                    type: 'select',
                    default: 'match',
                    options: [
                        { value: 'match', label: 'Match best sell price' },
                        { value: 'undercut', label: 'Undercut by 1 (best sell - 1)' },
                    ],
                    help: 'When creating sell listings, choose whether to match or undercut the current best sell price',
                },
                market_autoFillBuyStrategy: {
                    id: 'market_autoFillBuyStrategy',
                    label: 'Auto-fill buy price strategy',
                    type: 'select',
                    default: 'outbid',
                    options: [
                        { value: 'outbid', label: 'Outbid by 1 (best buy + 1)' },
                        { value: 'match', label: 'Match best buy price' },
                        { value: 'undercut', label: 'Undercut by 1 (best buy - 1)' },
                    ],
                    help: 'When creating buy listings, choose whether to outbid, match, or undercut the current best buy price',
                },
                market_autoClickMax: {
                    id: 'market_autoClickMax',
                    label: 'Auto-click Max button on sell listing dialogs',
                    type: 'checkbox',
                    default: true,
                    help: 'Automatically clicks the Max button in the quantity field when opening Sell listing dialogs',
                },
                market_quickInputButtons: {
                    id: 'market_quickInputButtons',
                    label: 'Marketplace: Quick input buttons on order dialogs',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds 10, 100, 1000 preset quantity buttons to buy/sell dialogs',
                },
                market_quickInputButtons_presets: {
                    id: 'market_quickInputButtons_presets',
                    label: 'Marketplace: Custom quick input presets',
                    type: 'text',
                    default: '',
                    help: 'Comma-separated preset values (e.g. 50,500,5000). Leave blank for defaults (10, 100, 1000). Max 8 values.',
                },
                market_multiplierButtons: {
                    id: 'market_multiplierButtons',
                    label: 'Marketplace: ÷2 and ×2 buttons on order dialogs',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds ÷2 and ×2 buttons to the price and quantity rows in buy/sell dialogs',
                },
                market_showOwnedInBuyModal: {
                    id: 'market_showOwnedInBuyModal',
                    label: 'Marketplace: Show owned count in buy dialogs',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays how many of the item you currently own in Buy Now and Buy Listing modals',
                },
                market_marketplaceShortcuts: {
                    id: 'market_marketplaceShortcuts',
                    label: 'Marketplace: Show "Marketplace Action" button on item menus',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a Marketplace Action dropdown to item menus with Sell Now, Buy Now, and listing shortcuts',
                },
                market_visibleItemCount: {
                    id: 'market_visibleItemCount',
                    label: 'Market: Show inventory count on items',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays how many of each item you own when browsing the market',
                },
                market_visibleItemCountOpacity: {
                    id: 'market_visibleItemCountOpacity',
                    label: 'Market: Opacity for items not in inventory',
                    type: 'slider',
                    default: 0.25,
                    min: 0,
                    max: 1,
                    step: 0.05,
                    help: 'How transparent item tiles appear when you own zero of that item',
                },
                market_visibleItemCountIncludeEquipped: {
                    id: 'market_visibleItemCountIncludeEquipped',
                    label: 'Market: Count equipped items',
                    type: 'checkbox',
                    default: true,
                    help: 'Include currently equipped items in the displayed count',
                },
                market_showListingPrices: {
                    id: 'market_showListingPrices',
                    label: 'Market: Show prices on individual listings',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays top order price and total value on each listing in My Listings table',
                },
                market_listingRefreshNavigator: {
                    id: 'market_listingRefreshNavigator',
                    label: 'Market: Show Refresh Next button on My Listings',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a "Refresh Next" button next to the Market History tab that cycles through your listings, navigating to each item\'s order book one at a time',
                },
                market_bulkSellAssistant: {
                    id: 'market_bulkSellAssistant',
                    label: 'Market: Bulk Sell Assistant',
                    type: 'checkbox',
                    default: false,
                    help: 'Adds a Bulk Sell button to the marketplace tab bar (next to Market History) that opens a floating panel for selling every tradable inventory item — most valuable stack first, optionally limited to one Toolasha inventory tab — via a prefilled sell modal for each: one confirm click per item, always in the same place. Insta-sells per the queue-age and supply-ratio rules below; otherwise posts a sell listing.',
                },
                market_bulkSellQueueDays: {
                    id: 'market_bulkSellQueueDays',
                    label: 'Market: Bulk sell insta-sell queue age (days)',
                    type: 'number',
                    default: 2,
                    min: 0,
                    max: 30,
                    help: 'If the oldest sell listing on an item has been waiting longer than this many days (the queue is not moving), the Bulk Sell Assistant insta-sells to the best bid instead of joining the queue. 0 turns this rule off. Default: 2.',
                },
                market_bulkSellSupplyRatio: {
                    id: 'market_bulkSellSupplyRatio',
                    label: 'Market: Bulk sell insta-sell supply ratio',
                    type: 'number',
                    default: 1,
                    min: 0,
                    max: 100,
                    help: 'Insta-sell when sell-order supply exceeds buy-order demand × this ratio. 1 = insta-sell whenever sell orders outnumber buy orders; 2 = only when supply is at least double demand; 0 turns this rule off (only the queue-age rule insta-sells). Default: 1.',
                },
                market_bulkSellVendorCheck: {
                    id: 'market_bulkSellVendorCheck',
                    label: 'Market: Bulk sell to vendor when market is no better',
                    type: 'checkbox',
                    default: true,
                    help: 'When the game vendor pays at least as much per item as the market would net after the 2% tax (e.g. vendor 48 vs ask 49 → 48 net), the Bulk Sell Assistant opens the item\'s inventory menu with "All" selected so one click on "Sell For … Coins" vendors the whole stack instead. Only applies to unenhanced items.',
                },
                market_bulkSellMinListingValue: {
                    id: 'market_bulkSellMinListingValue',
                    label: 'Market: Bulk sell minimum stack value for a sell listing',
                    type: 'number',
                    default: 1500000,
                    min: 0,
                    help: 'Stacks worth less than this (count × ask price) are insta-sold to the best bid instead of using up a sell listing slot. 0 turns this rule off. Default: 1,500,000.',
                },
                market_tradeHistory: {
                    id: 'market_tradeHistory',
                    label: 'Market: Show personal trade history',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays your last buy/sell prices for items in marketplace',
                },
                market_tradeHistoryComparisonMode: {
                    id: 'market_tradeHistoryComparisonMode',
                    label: 'Market: Trade history comparison mode',
                    type: 'select',
                    default: 'instant',
                    options: [
                        { value: 'instant', label: 'Instant' },
                        { value: 'listing', label: 'Orders' },
                    ],
                    help: 'Instant: Compare to instant buy/sell prices. Orders: Compare to buy/sell orders.',
                },
                market_tradeLedger: {
                    id: 'market_tradeLedger',
                    label: 'Market: Record trade ledger (realized flip profit)',
                    type: 'checkbox',
                    default: true,
                    help: 'Passively records every fill on your own listings (partial fills included) and adds a "Ledger" tab to the marketplace showing per-item realized profit — sells matched against your average recorded buy cost, proceeds net of the 2% market tax — with weekly totals and CSV export.',
                },
                market_listingPricePrecision: {
                    id: 'market_listingPricePrecision',
                    label: 'Market: Listing price decimal precision',
                    type: 'number',
                    default: 1,
                    min: 0,
                    max: 4,
                    help: 'Decimal places for the abbreviated Top Order and Total prices on My Listings (e.g. 1.2M vs 1.23M)',
                },
                market_showListingAge: {
                    id: 'market_showListingAge',
                    label: 'Market: Show listing age on My Listings',
                    type: 'checkbox',
                    default: false,
                    help: 'Display how long ago each listing was created on the My Listings tab (e.g., "3h 45m")',
                },
                market_badgeOnlyWhenFinished: {
                    id: 'market_badgeOnlyWhenFinished',
                    label: 'Market: Sidebar badge only for finished listings',
                    type: 'checkbox',
                    default: false,
                    help: 'The game badges Marketplace in the sidebar the moment anything is collectable, including a buy order that has taken 30 of 200 units and is still working — collecting those 30 does nothing except silence the badge until the next fill. This limits the sidebar badge to listings that have finished: filled completely, or cancelled and holding a refund. The badge on the My Listings tab is left alone, since once you are in the marketplace knowing there is something to collect is useful.',
                },
                market_pooledHistory: {
                    id: 'market_pooledHistory',
                    label: 'Market: Price history panel',
                    type: 'checkbox',
                    default: false,
                    help: 'Adds a History tab to the marketplace: a floating chart of an item\u2019s ask, bid, average traded price and volume over the last day to six months, plus a row of pinned items. The game shows what an item costs now and nothing about what it cost before, which makes every price impossible to judge. The data comes from the pooled dataset the mooket project (by Q7, MIT) maintains at q7.nainai.eu.org. This talks to a third party in both directions and is off until you turn it on: it tells that server which items you look up, and it sends back the order books you open, which is where the history you read comes from \u2014 reading a pooled dataset without feeding it is what empties it.',
                },
                market_showTopOrderAge: {
                    id: 'market_showTopOrderAge',
                    label: 'Market: Show top order age on My Listings',
                    type: 'checkbox',
                    default: false,
                    help: 'Display estimated age of the top competing order for each of your listings (requires estimated listing age feature to be active)',
                },
                market_showEstimatedListingAge: {
                    id: 'market_showEstimatedListingAge',
                    label: 'Market: Show estimated age on order book',
                    type: 'checkbox',
                    default: true,
                    help: 'Estimates creation time for all market listings using listing ID interpolation',
                },
                market_listingAgeFormat: {
                    id: 'market_listingAgeFormat',
                    label: 'Market: Listing age display format',
                    type: 'select',
                    default: 'datetime',
                    options: [
                        { value: 'elapsed', label: 'Elapsed Time (e.g., "3h 45m")' },
                        { value: 'datetime', label: 'Date/Time (e.g., "01-13 14:30")' },
                    ],
                    help: 'Choose how to display listing creation times',
                },
                market_listingTimeFormat: {
                    id: 'market_listingTimeFormat',
                    label: 'Time format for date/time display',
                    type: 'select',
                    default: '24hour',
                    options: [
                        { value: '24hour', label: '24-hour (14:30)' },
                        { value: '12hour', label: '12-hour (2:30 PM)' },
                    ],
                    help: 'Time format used in marketplace listings and action completion times',
                },
                market_listingDateFormat: {
                    id: 'market_listingDateFormat',
                    label: 'Date format for date/time display',
                    type: 'select',
                    default: 'MM-DD',
                    options: [
                        { value: 'MM-DD', label: 'MM-DD (01-13)' },
                        { value: 'DD-MM', label: 'DD-MM (13-01)' },
                    ],
                    help: 'Date format used in marketplace listings and action completion times',
                },
                market_showOrderTotals: {
                    id: 'market_showOrderTotals',
                    label: 'Market: Show order totals in header',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays buy orders (BO), sell orders (SO), and unclaimed coins (💰) in the header area below gold',
                },
                market_showHistoryViewer: {
                    id: 'market_showHistoryViewer',
                    label: 'Market: Show history viewer button in settings',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds "View Market History" button to settings panel for viewing and exporting all market listing history',
                },
                market_showPhiloCalculator: {
                    id: 'market_showPhiloCalculator',
                    label: 'Market: Show Philo Gamba calculator button in settings',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds "Philo Gamba" button to settings panel for calculating transmutation ROI into Philosopher\'s Stones',
                },
                market_showQueueLength: {
                    id: 'market_showQueueLength',
                    label: 'Market: Show queue length estimates',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays total quantity at best price below Buy/Sell buttons. Estimated values (20+ orders at same price) are shown in a different color.',
                },
                market_milkywayMarketLink: {
                    id: 'market_milkywayMarketLink',
                    label: 'Market: Show MilkyWay Market link',
                    type: 'checkbox',
                    default: false,
                    help: 'Adds a small link to view the current item on milkyway.market',
                },
            },
        },

        pricingProfit: {
            title: 'Pricing & Profit',
            icon: '💹',
            settings: {
                profitCalc_pricingMode: {
                    id: 'profitCalc_pricingMode',
                    label: 'Profit calculation pricing mode',
                    type: 'select',
                    default: 'hybrid',
                    options: [
                        { value: 'conservative', label: 'Buy: Ask / Sell: Bid (Instant Buy / Instant Sell)' },
                        { value: 'hybrid', label: 'Buy: Ask / Sell: Ask (Instant Buy / Patient Sell)' },
                        { value: 'optimistic', label: 'Buy: Bid / Sell: Ask (Patient Buy / Patient Sell)' },
                        { value: 'patientBuy', label: 'Buy: Bid / Sell: Bid (Patient Buy / Instant Sell)' },
                    ],
                },
                profitCalc_pricingNaming: {
                    id: 'profitCalc_pricingNaming',
                    label: 'Pricing mode naming convention',
                    type: 'checkbox',
                    default: false,
                    help: 'Show pricing modes as "Instant Buy / Instant Sell" instead of "Buy: Ask / Sell: Bid"',
                },
                profitCalc_keyPricingMode: {
                    id: 'profitCalc_keyPricingMode',
                    label: 'Key pricing mode',
                    type: 'select',
                    default: 'ask',
                    options: ['ask', 'bid'],
                    help: 'Whether to use ask (instant buy) or bid (patient buy) prices when valuing dungeon keys in tooltips, networth, and combat income calculations.',
                },
                profitCalc_liquidityCap: {
                    id: 'profitCalc_liquidityCap',
                    label: 'Profit: Cap displayed rates by market volume',
                    type: 'checkbox',
                    default: true,
                    help: 'Bounds displayed and ranked profit/hr figures (alchemy Best Items, action-bar profit, pinned actions, the all-zones combat table) by how fast each method’s outputs actually trade, using the pooled market history — a method producing more per hour than the market absorbs cannot realize its quoted rate. Capped figures carry a "vol-capped" marker naming the limiting item. Needs the Market price history panel setting to have data; with it off, nothing is bounded. Turn this off to see raw rates.',
                },
                profitCalc_customPriceOverrides: {
                    id: 'profitCalc_customPriceOverrides',
                    label: 'Custom price overrides',
                    type: 'customPriceOverrides',
                    default: {},
                    help: 'Set custom buy/sell prices for specific items. Overrides marketplace prices in profit calculations.',
                },
                profitCalc_craftUpgradeItems: {
                    id: 'profitCalc_craftUpgradeItems',
                    label: 'Profit: Use crafting cost for upgrade items if cheaper',
                    type: 'checkbox',
                    default: true,
                    help: 'When enabled, uses crafting cost instead of market price for upgrade items if cheaper, and factors crafting time into profit/hr calculations.',
                },
            },
        },

        inventoryNetWorth: {
            title: 'Inventory & Net Worth',
            icon: '💎',
            settings: {
                networth: {
                    id: 'networth',
                    label: 'Net worth tracking (and gold count in the header)',
                    type: 'checkbox',
                    default: true,
                    help: 'Master switch for the net worth calculator. Displays your current gold count next to Total Level in the page header; the inventory breakdown, history chart, and overlay rows below all need this on to have data',
                },
                invWorth: {
                    id: 'invWorth',
                    label: 'Below inventory: Show net worth breakdown',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows total net worth with a per-category breakdown (equipment, inventory, listings, houses, abilities) below the inventory panel. Requires net worth tracking to be enabled above',
                },
                invSort: {
                    id: 'invSort',
                    label: 'Sort inventory items by value',
                    type: 'checkbox',
                    default: true,
                },
                invSort_showBadges: {
                    id: 'invSort_showBadges',
                    label: 'Show stack value badges when sorting by Ask/Bid',
                    type: 'checkbox',
                    default: false,
                },
                invSort_badgesOnNone: {
                    id: 'invSort_badgesOnNone',
                    label: 'Badge type when "None" sort is selected',
                    type: 'select',
                    default: 'None',
                    options: ['None', 'Ask', 'Bid'],
                },
                invSort_netOfTax: {
                    id: 'invSort_netOfTax',
                    label: 'Show badge values net of market tax',
                    type: 'checkbox',
                    default: false,
                },
                invSort_sortEquipment: {
                    id: 'invSort_sortEquipment',
                    label: 'Enable sorting for Equipment category',
                    type: 'checkbox',
                    default: false,
                },
                invBadgePrices: {
                    id: 'invBadgePrices',
                    label: 'Show price badges on item icons',
                    type: 'checkbox',
                    default: false,
                    help: 'Displays per-item ask and bid prices on inventory items',
                },
                invCategoryTotals: {
                    id: 'invCategoryTotals',
                    label: 'Show category totals in inventory',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays the total market value of all items in each inventory category',
                },
                networth_pricingMode: {
                    id: 'networth_pricingMode',
                    label: 'Net worth pricing mode',
                    type: 'select',
                    default: 'ask',
                    options: [
                        { value: 'ask', label: 'Ask price (patient sell value)' },
                        { value: 'bid', label: 'Bid price (instant liquidation value)' },
                    ],
                    help: 'Ask shows what you could get by listing patiently. Bid shows what you could get by selling instantly.',
                },
                networth_highEnhancementUseCost: {
                    id: 'networth_highEnhancementUseCost',
                    label: 'Use enhancement cost for highly enhanced items',
                    type: 'checkbox',
                    default: true,
                    help: 'Market prices are unreliable for highly enhanced items (+13 and above). Use calculated enhancement cost instead.',
                },
                networth_highEnhancementMinLevel: {
                    id: 'networth_highEnhancementMinLevel',
                    label: 'Minimum enhancement level to use cost',
                    type: 'select',
                    default: 13,
                    options: [
                        { value: 10, label: '+10 and above' },
                        { value: 11, label: '+11 and above' },
                        { value: 12, label: '+12 and above' },
                        { value: 13, label: '+13 and above (recommended)' },
                        { value: 15, label: '+15 and above' },
                    ],
                    help: 'Enhancement level at which to stop trusting market prices',
                },
                networth_includeCowbells: {
                    id: 'networth_includeCowbells',
                    label: 'Include cowbells in net worth',
                    type: 'checkbox',
                    default: false,
                    help: 'Cowbells are not tradeable, but they have a value based on Bag of 10 Cowbells market price',
                },
                networth_includeTaskTokens: {
                    id: 'networth_includeTaskTokens',
                    label: 'Include task tokens in net worth',
                    type: 'checkbox',
                    default: true,
                    help: 'Value task tokens based on expected value from Task Shop chests. Disable to exclude them from net worth.',
                },
                networth_abilityBooksAsInventory: {
                    id: 'networth_abilityBooksAsInventory',
                    label: 'Count ability books as inventory (Current Assets)',
                    type: 'checkbox',
                    default: false,
                    help: 'Move ability books from Fixed Assets to Current Assets inventory value. Useful if you plan to sell them.',
                },
                networth_historyChart: {
                    id: 'networth_historyChart',
                    label: 'Enable net worth history chart',
                    type: 'checkbox',
                    default: true,
                    help: 'Records hourly net worth snapshots and shows a chart icon next to Total Net Worth. Disable to stop tracking and hide the chart button.',
                },
                autoAllButton: {
                    id: 'autoAllButton',
                    label: 'Auto-click "All" button when opening loot boxes',
                    type: 'checkbox',
                    default: true,
                    help: 'Automatically clicks the "All" button when opening openable containers (crates, chests, caches)',
                },
                autoAllButton_excludeSeals: {
                    id: 'autoAllButton_excludeSeals',
                    label: 'Auto-click "All": Skip Scroll of... items',
                    type: 'checkbox',
                    default: true,
                    help: 'When enabled, Scroll of... items from the Labyrinth are not auto-opened',
                },
            },
        },

        inventoryTabs: {
            title: 'Custom Inventory Tabs',
            icon: '🗂️',
            settings: {
                inventoryTabs: {
                    id: 'inventoryTabs',
                    label: 'Custom Inventory Tabs: Enable',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a Toolasha tab to the character panel where you can organize inventory items into personal tabs.',
                },
                inventoryTabs_showUnorganized: {
                    id: 'inventoryTabs_showUnorganized',
                    label: 'Custom Inventory Tabs: Show Unorganized bucket',
                    type: 'checkbox',
                    default: true,
                    help: 'Show an "Unorganized" section containing all items not assigned to any tab.',
                },
                inventoryTabs_categoryAddAll: {
                    id: 'inventoryTabs_categoryAddAll',
                    label: 'Custom Inventory Tabs: Add all items when adding category',
                    type: 'checkbox',
                    default: false,
                    hidden: true,
                    help: 'When adding a category to a tab, add every item in that category (including items not in your inventory). When disabled, only items currently in your inventory are added.',
                },
                inventoryTabs_defaultTab: {
                    id: 'inventoryTabs_defaultTab',
                    label: 'Custom Inventory Tabs: Show Toolasha tab by default',
                    type: 'checkbox',
                    default: false,
                    help: 'Hides the native Inventory tab and automatically activates the Toolasha tab whenever the character panel opens.',
                },
                inventoryTabs_tileGap: {
                    id: 'inventoryTabs_tileGap',
                    label: 'Custom Inventory Tabs: Item spacing (px)',
                    type: 'number',
                    default: 4,
                    min: 0,
                    max: 20,
                    step: 1,
                    help: 'Pixel gap between item tiles on the Toolasha tab.',
                },
                inventoryTabs_loadoutIncludeConsumables: {
                    id: 'inventoryTabs_loadoutIncludeConsumables',
                    label: 'Custom Inventory Tabs: Include food & drinks when adding from loadout',
                    type: 'checkbox',
                    default: false,
                    help: 'When adding items from a loadout to a tab, also include food and drink items.',
                },
                inventoryTabs_topTabPriority: {
                    id: 'inventoryTabs_topTabPriority',
                    label: 'Custom Inventory Tabs: Items visible in topmost tab only',
                    type: 'checkbox',
                    default: true,
                    help: 'When an item appears in multiple tabs, it only shows in the highest (topmost) tab that contains it. When disabled, collapsing a tab releases its items to lower tabs.',
                },
            },
        },

        skills: {
            title: 'Skills',
            icon: '📚',
            settings: {
                simulateScrollEffects: {
                    id: 'simulateScrollEffects',
                    label: 'Skills: Simulate missing scroll effects in calculations',
                    type: 'checkboxWithButton',
                    buttonLabel: 'Defaults...',
                    default: false,
                    help: 'When enabled, profit/XP/speed calculations show hypothetical results as if selected scrolls were active. Configure default scrolls with the button; override per-loadout from the Loadouts panel.',
                },
                xpTracker: {
                    id: 'xpTracker',
                    label: 'Left sidebar: Show XP/hr rate on skill bars',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays live XP/hr rate under each skill bar in the navigation panel',
                },
                xpTracker_timeTillLevel: {
                    id: 'xpTracker_timeTillLevel',
                    label: 'Skill tooltip: Show time till next level',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows estimated time remaining until the next level in the skill hover tooltip (based on current XP/hr)',
                },
                skillRemainingXP: {
                    id: 'skillRemainingXP',
                    label: 'Left sidebar: Show remaining XP to next level',
                    type: 'checkbox',
                    default: true,
                    requiresRefresh: true,
                    help: 'Displays how much XP needed to reach the next level under skill progress bars',
                },
                skillRemainingXP_blackBorder: {
                    id: 'skillRemainingXP_blackBorder',
                    label: 'Remaining XP: Add black text border for better visibility',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a black outline/shadow to the XP text for better readability against progress bars',
                },
                skillbook: {
                    id: 'skillbook',
                    label: 'Skill books: Show books needed to reach target level (in the ability book item dictionary window)',
                    type: 'checkbox',
                    default: true,
                },
                drinkTimer: {
                    id: 'drinkTimer',
                    label: 'Drink timer: Show remaining drink supply time in skill panels',
                    type: 'checkbox',
                    default: true,
                    requiresRefresh: true,
                    help: 'Shows how long your drink stock lasts and whether it covers the queued actions. This switch existed internally but was never in the settings panel, so the feature could not be turned off.',
                },
                drinkTimer_warningThreshold: {
                    id: 'drinkTimer_warningThreshold',
                    label: 'Drink timer: warning threshold (hours)',
                    type: 'number',
                    default: 24,
                    help: 'Show an amber warning on drink time displays when remaining supply falls below this many hours.',
                },
                skillingOptimizer: {
                    id: 'skillingOptimizer',
                    label: 'Skilling Simulator/Optimizer: Enable Optimizer tab in character panel',
                    type: 'checkbox',
                    default: true,
                    requiresRefresh: true,
                },
            },
        },

        combat: {
            title: 'Combat Features',
            icon: '⚔️',
            settings: {
                damageTracker: {
                    id: 'damageTracker',
                    label: 'Damage Tracker: Attribute damage per player and per ability',
                    type: 'checkbox',
                    default: true,
                    help: 'The game attributes nothing, so the caster is worked out from whose mana fell each tick. Feeds the Damage panel behind the DPS tile',
                },
                damageTakenTracker: {
                    id: 'damageTakenTracker',
                    label: 'Damage Taken Tracker: What is hitting you, and for how much',
                    type: 'checkbox',
                    default: true,
                    help: 'Damage taken against health regenerated, broken out per monster and per wave with hit ranges. Feeds the Deaths panel behind the deaths/hr tile',
                },
                partyLint_live: {
                    id: 'partyLint_live',
                    label: 'Party lint: Flag loadout mistakes in the live party',
                    type: 'checkbox',
                    default: true,
                    help: 'The same checks the Combat Sim runs before a party simulation — skilling gear in a combat slot, the same aura equipped twice — fired on the party you are actually fighting with, as an amber block in the Damage panel. Auras are checked for everyone; gear only for you, since the battle payload carries no one’s equipment. Parties of 2+ only',
                },
                combatRecorder_autoStart: {
                    id: 'combatRecorder_autoStart',
                    label: 'Auto-record combat on load',
                    type: 'checkbox',
                    default: false,
                    help: 'Starts the combat recorder the moment the page loads and writes the file out on its own, then switches itself back off. The Record button in the Damage panel cannot capture the first seconds of a session, which is exactly when a reload lands mid-fight and the client never sees what it is fighting. Turn it on again for each recording you want',
                },
                combatRecorder_autoStartSeconds: {
                    id: 'combatRecorder_autoStartSeconds',
                    label: 'Auto-record length (seconds)',
                    type: 'number',
                    default: 60,
                    min: 10,
                    max: 600,
                    help: 'How long the automatic recording runs before it saves itself',
                },
                replayCheck: {
                    id: 'replayCheck',
                    label: 'Sim Accuracy: Replay recorded fights against the simulator',
                    type: 'checkbox',
                    default: true,
                    help: 'Derives damage dealt, damage taken and fight length from a recorded fight, runs the simulator for the same zone, and reports the deviation with a sampling-noise margin. Feeds the Sim Accuracy overlay row and the panel behind it',
                },
                combatScore: {
                    id: 'combatScore',
                    label: 'Profile panel: Show gear score',
                    type: 'checkbox',
                    default: true,
                },
                abilitiesTriggers: {
                    id: 'abilitiesTriggers',
                    label: 'Profile panel: Show abilities & triggers',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays equipped abilities, consumables, and their combat triggers below the profile',
                },
                abilities_dictionaryButton: {
                    id: 'abilities_dictionaryButton',
                    label: 'Abilities: Add Open Item Dictionary to ability menus',
                    type: 'checkbox',
                    default: true,
                    help: "Adds an Open Item Dictionary button to the popup shown when clicking an ability, opening that ability's book entry.",
                },
                chestKeyMarketButton: {
                    id: 'chestKeyMarketButton',
                    label: 'Chests: Add Buy Keys on Marketplace to chest menus',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a button to the popup shown when clicking a keyed chest, opening its key on the marketplace.',
                },
                characterCard: {
                    id: 'characterCard',
                    label: 'Profile panel: Show View Card button',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds button to open character sheet in external viewer',
                },
                dungeonTracker: {
                    id: 'dungeonTracker',
                    label: 'Dungeon Tracker: Real-time progress tracking',
                    type: 'checkbox',
                    default: true,
                    help: 'Tracks dungeon runs with server-validated duration from party messages',
                },
                dungeonTrackerUI: {
                    id: 'dungeonTrackerUI',
                    label: 'Show Dungeon Tracker UI panel',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays dungeon progress panel with wave counter, run history, and statistics',
                },
                dungeonTrackerChatAnnotations: {
                    id: 'dungeonTrackerChatAnnotations',
                    label: 'Show run time in party chat',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds colored timer annotations to "Key counts" messages (green if fast, red if slow)',
                },
                labyrinthTracker: {
                    id: 'labyrinthTracker',
                    label: 'Labyrinth best level tracker',
                    type: 'checkbox',
                    default: true,
                    help: 'Tracks the highest recommended level enemy defeated per monster type and shows it in the Automation tab',
                },
                labyrinthShopPrices: {
                    id: 'labyrinthShopPrices',
                    label: 'Labyrinth Shop: Show market prices',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows ask/bid market prices on tradeable items in the Labyrinth Shop tab',
                },
                labyrinthClearRate: {
                    id: 'labyrinthClearRate',
                    label: 'Labyrinth clear rate calculator',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows expected clear time and success rate on labyrinth skilling room tiles',
                },
                labyrinthRecommendTargetRate: {
                    id: 'labyrinthRecommendTargetRate',
                    label: 'Labyrinth: Recommend target clear rate (%)',
                    type: 'number',
                    default: 70,
                    min: 1,
                    max: 100,
                    step: 1,
                    help: 'Default target clear rate for labyrinth skip threshold recommendations',
                },
                labyrinthSimPrecision: {
                    id: 'labyrinthSimPrecision',
                    label: 'Labyrinth: Combat sim precision (±%)',
                    type: 'number',
                    default: 1,
                    min: 0.1,
                    max: 10,
                    step: 0.5,
                    help: "A room's sim keeps fighting until its clear chance is pinned to within this many percentage points either side — the 95% confidence interval has to fit inside ±this before the run is allowed to stop. A settled room gets there in a few hundred fights and a close one needs thousands, so the work goes where the answer is still in doubt (lower = tighter interval, more fights, slower)",
                },
                labyrinthRecommendSimHours: {
                    id: 'labyrinthRecommendSimHours',
                    label: 'Labyrinth: Combat sim time ceiling (hours)',
                    type: 'number',
                    default: 3,
                    min: 1,
                    max: 100,
                    step: 1,
                    help: 'Upper bound on a single room simulation, in simulated hours. Precision normally ends a run well before this; the ceiling stops a room near a coin toss from running forever',
                },
                labyrinthPathClearThreshold: {
                    id: 'labyrinthPathClearThreshold',
                    label: 'Labyrinth: Path clearable threshold (%)',
                    type: 'number',
                    default: 70,
                    min: 1,
                    max: 100,
                    step: 1,
                    help: 'Clear chance at or above which the labyrinth path planner treats a tile as clearable without a shroud (separate from the skip recommendation target)',
                },
                labyrinthPathUnknownMode: {
                    id: 'labyrinthPathUnknownMode',
                    label: 'Labyrinth: Path treats unrevealed rooms as',
                    type: 'select',
                    default: 'shroud',
                    options: [
                        { value: 'clearable', label: 'Clearable (optimistic)' },
                        { value: 'shroud', label: 'Needing a shroud (pessimistic)' },
                        { value: 'avoid', label: 'Impassable (route revealed rooms only)' },
                    ],
                    help: 'How the labyrinth path planner costs rooms whose contents are not revealed yet',
                },
                labyrinthBeaconCount: {
                    id: 'labyrinthBeaconCount',
                    label: 'Labyrinth: Beacon plan count',
                    type: 'number',
                    default: 0,
                    min: 0,
                    max: 20,
                    step: 1,
                    help: 'Beacons the beacon planner places on the floor in view, sited to cover a revealed path to the exit first, a second independent route next, and the most rooms with what is left — 0 uses the fewest that cover a path, which every new floor resets to',
                },
                labyrinthSkipEditAutofill: {
                    id: 'labyrinthSkipEditAutofill',
                    label: 'Labyrinth: Autofill skip Edit input',
                    type: 'checkbox',
                    default: false,
                    help: "Clicking a skip threshold's Edit button fills the input with the recommended threshold (or the current value when no recommendation exists), replacing whatever is in it",
                },
                labyrinthLiveProgress: {
                    id: 'labyrinthLiveProgress',
                    label: 'Labyrinth: Show live clear chance',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows a live clear chance in the action bar during labyrinth rooms — from the actions left in a skilling or enhancing room, and from how the fight is going in a combat room',
                },
                labyrinthLiveCombatSim: {
                    id: 'labyrinthLiveCombatSim',
                    label: 'Labyrinth: Replay the live fight for a better clear chance',
                    type: 'checkbox',
                    default: false,
                    help: 'Replays the fight in progress hundreds of times from its current health and remaining time, instead of extrapolating from how fast health is being lost. Slower but far more accurate, since it runs the real combat engine',
                },
                labyrinthRoomLogs: {
                    id: 'labyrinthRoomLogs',
                    label: 'Labyrinth: Room action logs',
                    type: 'checkbox',
                    default: true,
                    help: 'Records per-action success/fail/double logs for labyrinth skilling rooms and per-attempt win/death/timeout logs for combat rooms, each set beside the clear chance the calculator predicted, grouped by floor with experience per hour. A second tab totals every room ever recorded, so you can see where the calculator is being contradicted (Logs button in the labyrinth panel)',
                },
                labyrinthRoomLogSize: {
                    id: 'labyrinthRoomLogSize',
                    label: 'Labyrinth: Rooms of history to keep',
                    type: 'number',
                    default: 120,
                    min: 20,
                    max: 500,
                    help: 'A floor is around thirty rooms, so anything near that shows barely one floor and nothing to compare it against. 120 keeps roughly three floors. Each room is a few hundred bytes, and the long-term accuracy record is kept separately and never trimmed',
                },
                labyrinthAutoCalcTiles: {
                    id: 'labyrinthAutoCalcTiles',
                    label: 'Labyrinth: Auto-calc revealed tiles',
                    type: 'checkbox',
                    default: false,
                    help: 'Automatically calculates clear chances for newly revealed labyrinth tiles without clicking Calc Tiles',
                },
                combatBattleCounter: {
                    id: 'combatBattleCounter',
                    label: 'Show battle/wave counter in current action panel during combat',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays "Battle #N" for regular zones or "Wave N" for dungeons in the top-left action panel',
                },
                combatSummary: {
                    id: 'combatSummary',
                    label: 'Combat Summary: Show detailed statistics on return',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays encounters/hour, revenue, experience rates when returning from combat',
                },
                combatDropLuck: {
                    id: 'combatDropLuck',
                    label: 'Combat Drop Luck: Show how lucky a session was on return',
                    type: 'checkbox',
                    default: true,
                    help: "Puts the session's drop value in the distribution of everything those battles could have paid, as a percentile. Skips dungeons, which pay from a reward table rather than per monster",
                },
                dropLuck_profitAdjust: {
                    id: 'dropLuck_profitAdjust',
                    label: 'Dungeon profit: value chests at my measured treasure rate',
                    type: 'checkbox',
                    default: false,
                    help: "Scales a dungeon chest's expected value in profit estimates by your own treasure rate for that chest — what your recorded openings actually returned against the drop table's expectation, both at today's prices. Only applies once a few hundred openings back the measurement, and every adjusted figure is marked (*) with the measurement in its tooltip",
                },
                combatDps: {
                    id: 'combatDps',
                    label: 'Combat DPS: Measure damage per second during a run',
                    type: 'checkbox',
                    default: true,
                    help: "Infers damage from health lost between combat ticks, since the game sends no damage figure. Overkill is not counted, and in a party it is the whole party's damage — nothing on the wire says who struck",
                },
                portraitDps: {
                    id: 'portraitDps',
                    label: 'Portrait DPS: Show each character’s damage on their battle portrait',
                    type: 'checkbox',
                    default: false,
                    help: "Draws the run's DPS and total damage over each character in the battle panel, matched by name. Off by default because the portraits are already busy with health and mana",
                },
                portraitDpsPosition: {
                    id: 'portraitDpsPosition',
                    label: 'Portrait DPS: Where to put it',
                    type: 'select',
                    default: 'above',
                    options: [
                        { value: 'above', label: 'Above the portrait' },
                        { value: 'below', label: 'Below the portrait' },
                    ],
                    help: 'Above sits over the name; below sits under the ability bar',
                },
                portraitDps_timeToKill: {
                    id: 'portraitDps_timeToKill',
                    label: 'Portrait DPS: Time-to-kill on enemy tiles',
                    type: 'checkbox',
                    default: false,
                    help: 'Adds "dead ~8s" to each enemy tile — its remaining health over the rate it is being hit at. Dashed until the fight has both a health reading and a rate; nothing is ever extrapolated from a guess',
                },
                portraitDps_waveClear: {
                    id: 'portraitDps_waveClear',
                    label: 'Portrait DPS: Wave-clear countdown',
                    type: 'checkbox',
                    default: false,
                    help: 'One "wave ~19s" figure on the topmost enemy tile: every living enemy\'s remaining health over the party\'s combined rate. Dashed until every health bar is known and a rate exists — a countdown that silently excluded a monster would lie',
                },
                portraitDps_manaRunway: {
                    id: 'portraitDps_manaRunway',
                    label: 'Portrait DPS: Mana runway per player',
                    type: 'checkbox',
                    default: false,
                    help: 'Adds "mana ~40s" to a player\'s meter when their mana is draining and under a minute from empty, measured net of regeneration and refills. Steady or rising mana shows a dash — there is nothing to warn about',
                },
                portraitDps_sustain: {
                    id: 'portraitDps_sustain',
                    label: 'Portrait DPS: Damage taken and net sustain per player',
                    type: 'checkbox',
                    default: false,
                    help: 'Adds "taken 220/s" from the incoming-damage tracker, and "net −35/s" where regeneration is measurable — red when the net is negative, which is the reading that says a zone is not survivable',
                },
                portraitDps_accuracy: {
                    id: 'portraitDps_accuracy',
                    label: 'Portrait DPS: Hit and crit rate per player',
                    type: 'checkbox',
                    default: false,
                    help: 'Adds "94% hit · 31% crit" to each player\'s meter once 20 swings back it. Fewer swings show a dash rather than one fight\'s luck dressed up as a rate',
                },
                portraitDps_enemyOutgoing: {
                    id: 'portraitDps_enemyOutgoing',
                    label: 'Portrait DPS: Enemy outgoing damage',
                    type: 'checkbox',
                    default: false,
                    help: 'A red "hits for 210/s" line on each enemy tile — what that enemy is doing to the party this fight, from the incoming-damage split. Dashed until a hit can be pinned to that enemy',
                },
                portraitDps_enrage: {
                    id: 'portraitDps_enrage',
                    label: 'Portrait DPS: Enrage countdown on enemy tiles',
                    type: 'checkbox',
                    default: false,
                    help: 'Adds "enrage 1:42" counting down when the monster\'s sheet carries an enrage timer and spawn time, amber under 30 seconds. Monsters whose sheet states no timer show a dash',
                },
                dungeonPace: {
                    id: 'dungeonPace',
                    label: 'Dungeon Tracker: Pace vs your average',
                    type: 'checkbox',
                    default: true,
                    help: 'A chip on the in-progress dungeon panel — "pace +6% vs your avg" — comparing this run\'s average wave time against your stored history for the same dungeon, green when faster. No stored history, or fewer than three waves in, shows nothing',
                },
                combatSim: {
                    id: 'combatSim',
                    label: 'Combat Simulator',
                    type: 'checkbox',
                    default: true,
                    help: 'Simulate combat encounters to estimate XP/hr, deaths, and consumable usage',
                },
                labSim: {
                    id: 'labSim',
                    label: 'Lab Simulator',
                    type: 'checkbox',
                    default: true,
                    help: 'Simulate labyrinth runs to estimate performance across skills and combat',
                },
                combatSim_defaultHours: {
                    id: 'combatSim_defaultHours',
                    label: 'Combat Simulator: Default hours (single zone)',
                    type: 'number',
                    default: 100,
                    min: 1,
                    max: 10000,
                    step: 1,
                    help: 'Default simulation duration in hours for single-zone runs',
                },
                combatSim_allZonesDefaultHours: {
                    id: 'combatSim_allZonesDefaultHours',
                    label: 'Combat Simulator: Default hours (All Zones)',
                    type: 'number',
                    default: 10,
                    min: 1,
                    max: 10000,
                    step: 1,
                    help: 'Default simulation duration in hours for All Zones runs',
                },
                combatSim_seekDefaultHours: {
                    id: 'combatSim_seekDefaultHours',
                    label: 'Combat Simulator: Default hours (Seek)',
                    type: 'number',
                    default: 10,
                    min: 1,
                    max: 10000,
                    step: 1,
                    help: 'Default simulation duration in hours for Seek Best Source runs',
                },
                combatSim_decimalMinutes: {
                    id: 'combatSim_decimalMinutes',
                    label: 'Combat Simulator: Show completion time as decimal minutes',
                    type: 'checkbox',
                    default: false,
                    help: 'Display avg completion time as "X.XX min" instead of "Xm Ys"',
                },
                combatSim_defaultLoadout: {
                    id: 'combatSim_defaultLoadout',
                    label: 'Combat Simulator: Default loadout',
                    type: 'select',
                    default: '',
                    options: () => {
                        const snapshot = loadoutSnapshot();
                        const loadouts = snapshot
                            ? snapshot
                                  .getAllSnapshots()
                                  .filter((s) => !s.actionTypeHrid || s.actionTypeHrid === '/action_types/combat')
                            : [];
                        return [
                            { value: '', label: 'Current Gear' },
                            ...loadouts.map((s) => ({ value: s.name, label: s.name })),
                        ];
                    },
                    help: 'Loadout to use by default for combat estimates instead of currently equipped gear',
                },
                combatSim_autoEstimate: {
                    id: 'combatSim_autoEstimate',
                    label: 'Combat Simulator: Auto-run estimate on task cards',
                    type: 'checkbox',
                    default: false,
                    help: 'Automatically run combat estimates using the default loadout when task cards appear',
                },
                combatSim_maxThreads: {
                    id: 'combatSim_maxThreads',
                    label: 'Combat Simulator: Max threads',
                    type: 'number',
                    default: 0,
                    min: 0,
                    max: 32,
                    help: 'Maximum Web Worker threads for simulations (0 = auto: 4, or fewer on a smaller machine)',
                },
                combatSim_uncapThreads: {
                    id: 'combatSim_uncapThreads',
                    label: 'Combat Simulator: Ignore the thread caps',
                    type: 'checkbox',
                    default: false,
                    help:
                        'Max threads is normally clamped to your core count, and an analysis runs at most 6 simulations ' +
                        'at once — each one holds its own copy of the game data, and the tab running the game needs a ' +
                        'core too. Turn this on to take the number above literally.',
                },
                labSim_keepReplacedGear: {
                    id: 'labSim_keepReplacedGear',
                    label: 'Lab Simulator: Keep gear the forced armor swaps replace',
                    type: 'checkbox',
                    default: true,
                    help: 'The labyrinth needs every element set, so the Anchorbound / elemental robe / weapon swaps price as an added purchase with no resale credit for the gear they replace. Turn off to price them as a straight swap that sells the old piece.',
                },
                combatSim_sharedSeed: {
                    id: 'combatSim_sharedSeed',
                    label: 'Combat Simulator: Shared random seed for upgrade comparisons',
                    type: 'checkbox',
                    default: true,
                    help: 'Runs the baseline and every candidate on the same random draws, so a small difference reflects the upgrade instead of luck. Turn off to give every sim independent randomness (the old behavior).',
                },
                combatStats: {
                    id: 'combatStats',
                    label: 'Combat Statistics: Show Statistics tab in Combat panel',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a Statistics button to the Combat panel showing income, profit, consumable costs, EXP, and drop details',
                },
                combatStatsChatMessage: {
                    id: 'combatStatsChatMessage',
                    label: 'Combat Statistics: Chat message format',
                    type: 'template',
                    default: [
                        { type: 'text', value: 'Combat Stats: ' },
                        { type: 'variable', key: '{duration}', label: 'Duration' },
                        { type: 'text', value: ' duration | ' },
                        { type: 'variable', key: '{encountersPerHour}', label: 'Encounters/Hour' },
                        { type: 'text', value: ' EPH | ' },
                        { type: 'variable', key: '{income}', label: 'Total Income' },
                        { type: 'text', value: ' income | ' },
                        { type: 'variable', key: '{dailyIncome}', label: 'Daily Income' },
                        { type: 'text', value: ' income/d | ' },
                        { type: 'variable', key: '{dailyConsumableCosts}', label: 'Daily Consumable Costs' },
                        { type: 'text', value: ' consumables/d | ' },
                        { type: 'variable', key: '{dailyProfit}', label: 'Daily Profit' },
                        { type: 'text', value: ' profit/d | ' },
                        { type: 'variable', key: '{exp}', label: 'EXP/Hour' },
                        { type: 'text', value: ' exp/h | ' },
                        { type: 'variable', key: '{deathCount}', label: 'Deaths' },
                        { type: 'text', value: ' deaths' },
                    ],
                    help: 'Message format when Ctrl+clicking player card in Statistics. Click "Edit Template" to customize.',
                    templateVariables: [
                        { key: '{duration}', label: 'Duration', description: 'Combat session duration' },
                        { key: '{encountersPerHour}', label: 'Encounters/Hour', description: 'Encounters per hour (EPH)' },
                        { key: '{income}', label: 'Total Income', description: 'Total income from combat' },
                        { key: '{dailyIncome}', label: 'Daily Income', description: 'Income per day' },
                        {
                            key: '{dailyConsumableCosts}',
                            label: 'Daily Consumable Costs',
                            description: 'Consumable costs per day',
                        },
                        { key: '{dailyProfit}', label: 'Daily Profit', description: 'Profit per day' },
                        { key: '{exp}', label: 'EXP/Hour', description: 'Experience per hour' },
                        { key: '{deathCount}', label: 'Deaths', description: 'Number of deaths' },
                    ],
                },
            },
        },

        tasks: {
            title: 'Tasks',
            icon: '📋',
            settings: {
                taskProfitCalculator: {
                    id: 'taskProfitCalculator',
                    label: 'Show total profit for gathering/production tasks',
                    type: 'checkbox',
                    default: true,
                },
                taskSpeedBreakdown: {
                    id: 'taskSpeedBreakdown',
                    label: 'Show expandable speed & time breakdown on tasks',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays an expandable action speed, efficiency, and timing breakdown on task cards.',
                },
                taskCombatEstimate: {
                    id: 'taskCombatEstimate',
                    label: 'Show combat estimate on combat tasks',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays a loadout dropdown and estimate button on combat task cards.',
                },
                taskEfficiencyRating: {
                    id: 'taskEfficiencyRating',
                    label: 'Show task efficiency rating (tokens/profit per hour)',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays a color-graded efficiency score based on expected completion time.',
                },
                taskMaterialsIndicator: {
                    id: 'taskMaterialsIndicator',
                    label: 'Show materials availability on production tasks',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows how many task actions you can complete with current inventory.',
                },
                taskEfficiencyRatingMode: {
                    id: 'taskEfficiencyRatingMode',
                    label: 'Efficiency algorithm',
                    type: 'select',
                    default: 'gold',
                    options: [
                        { value: 'tokens', label: 'Task tokens per hour' },
                        { value: 'gold', label: 'Task profit per hour' },
                    ],
                    help: 'Choose whether to rate by task token payout or total profit.',
                },
                taskEfficiencyGradient: {
                    id: 'taskEfficiencyGradient',
                    label: 'Use relative gradient colors',
                    type: 'checkbox',
                    default: false,
                    help: 'Colors efficiency ratings relative to visible tasks.',
                },
                taskQueuedIndicator: {
                    id: 'taskQueuedIndicator',
                    label: 'Show "Queued" indicator on task cards',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays a status message on task cards when their action is in your action queue',
                },
                taskRerollTracker: {
                    id: 'taskRerollTracker',
                    label: 'Track task reroll costs',
                    type: 'checkbox',
                    default: true,
                    requiresRefresh: true,
                    help: 'Tracks how much gold/cowbells spent rerolling each task (EXPERIMENTAL - may cause UI freezing)',
                },
                taskMapIndex: {
                    id: 'taskMapIndex',
                    label: 'Show combat zone index numbers on tasks',
                    type: 'checkbox',
                    default: true,
                },
                taskIcons: {
                    id: 'taskIcons',
                    label: 'Show visual icons on task cards',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays semi-transparent item/monster icons on task cards',
                },
                taskIconsDungeons: {
                    id: 'taskIconsDungeons',
                    label: 'Show dungeon icons on combat tasks',
                    type: 'checkbox',
                    default: false,
                    help: 'Shows which dungeons contain the monster (requires Task Icons enabled)',
                },
                taskSorter: {
                    id: 'taskSorter',
                    label: 'Task sorter: Sort tasks by skill type',
                    type: 'checkbox',
                    default: true,
                    requiresRefresh: true,
                    help: 'Adds the sort button and sorting machinery to the task panel. This switch existed internally but was never in the settings panel, so the feature could not be turned off.',
                },
                taskSorter_autoSort: {
                    id: 'taskSorter_autoSort',
                    label: 'Automatically sort tasks when opening task panel',
                    type: 'checkbox',
                    default: false,
                    help: 'Automatically sorts tasks by skill type when you open the task panel',
                },
                taskSorter_sortAfterRead: {
                    id: 'taskSorter_sortAfterRead',
                    label: 'Sort tasks after reading new ones',
                    type: 'checkbox',
                    default: false,
                    help: 'Sorts the board again once you press Read, since new tasks always arrive at the end',
                },
                taskSorter_hideButton: {
                    id: 'taskSorter_hideButton',
                    label: 'Hide Sort Tasks button',
                    type: 'checkbox',
                    default: false,
                    help: 'Hides the Sort Tasks button while keeping auto-sort functional',
                },
                taskSorter_sortMode: {
                    id: 'taskSorter_sortMode',
                    label: 'Task sort mode',
                    type: 'select',
                    default: 'skill',
                    options: [
                        { value: 'skill', label: 'Skill / Zone' },
                        { value: 'time', label: 'Time to Completion' },
                        { value: 'protection', label: 'Protection (unprotected first)' },
                    ],
                    help: 'How tasks are ordered when clicking Sort Tasks. "Time to Completion" sorts fastest tasks first; combat and completed tasks go to the bottom. "Protection" puts unprotected tasks first.',
                },
                taskInventoryHighlighter: {
                    id: 'taskInventoryHighlighter',
                    label: 'Enable Task Inventory Highlighter button',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a button to dim inventory items not needed for your current non-combat tasks',
                },
                taskStatistics: {
                    id: 'taskStatistics',
                    label: 'Show task statistics button on Tasks panel',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a Statistics button to the Tasks panel showing overflow time, expected rewards, and completion estimates',
                },
                taskClaimCollector: {
                    id: 'taskClaimCollector',
                    label: 'Move Claim Reward buttons to top of task list',
                    type: 'checkbox',
                    default: true,
                    help: 'Moves all Claim Reward buttons to a stack at the top of the task list so you can click the same spot repeatedly to claim all completed tasks',
                },
                taskGoMerge: {
                    id: 'taskGoMerge',
                    label: 'Merge duplicate tasks on Go',
                    type: 'checkbox',
                    default: true,
                    help: 'When clicking Go on a task, combines the required amounts of all in-progress tasks for the same action into a single pre-filled count',
                },
                taskRerollProtection: {
                    id: 'taskRerollProtection',
                    label: 'Task reroll protection',
                    type: 'checkbox',
                    default: true,
                    help: 'Protect specific tasks from accidental rerolling. Protected tasks get a green highlight and require a confirmation click before rerolling. A shield icon appears in the task panel to configure protected zones.',
                },
                taskRerollProtection_hideHighlight: {
                    id: 'taskRerollProtection_hideHighlight',
                    label: 'Task reroll protection: Hide green highlight',
                    type: 'checkbox',
                    default: false,
                    help: 'Removes the green outline/glow from protected tasks while keeping the reroll confirmation active.',
                },
                taskAutoReroll: {
                    id: 'taskAutoReroll',
                    label: 'Task auto-reroll reminder',
                    type: 'checkbox',
                    default: true,
                    help: 'Highlights tasks you want to reroll with a red border and reminder badge. Configure per-character via the target icon in the task panel.',
                },
            },
        },

        ui: {
            title: 'UI & Appearance',
            icon: '🎨',
            settings: {
                accountView: {
                    id: 'accountView',
                    label: 'Account view: All characters on one screen',
                    type: 'checkbox',
                    default: true,
                    help:
                        'A single panel covering the whole account rather than the character you happen to be logged in ' +
                        'as: combined networth with each character’s share of it, per-character status (what each one is ' +
                        'doing, how long is left, whether anything is idle). Reads the data each character has already ' +
                        'recorded, so a character shows up once it has been played with Toolasha running.',
                },
                overlayPanel: {
                    id: 'overlayPanel',
                    label: 'Overlay Panel: One floating panel other features add a row to',
                    type: 'checkbox',
                    default: true,
                    help: 'A configurable overlay. Open it from the Overlay tab beside Inventory, then use the gear to choose which rows show and in what order. Rows appear as features gain them. Its ⇲ button docks it below the character tabs, where it takes its own space instead of covering the game',
                },
                overlayTabButton: {
                    id: 'overlayTabButton',
                    label: 'Overlay tab button',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds an Overlay switch to the character tabs, beside Inventory and before Optimizer, so the overlay can be shown and hidden without opening settings. Needs the Overlay Panel above',
                },
                commandPalette: {
                    id: 'commandPalette',
                    label: 'Command palette (Ctrl+K)',
                    type: 'checkbox',
                    default: true,
                    requiresRefresh: true,
                    help: 'Ctrl+K (or Cmd+K) opens a search box listing every panel, every overlay row, every saved overlay layout and every setting by name — arrow keys and Enter to choose, Escape to dismiss. Ignored while you are typing in chat or any other input',
                },
                goalPlanner: {
                    id: 'goalPlanner',
                    label: 'Goal Planner: Ordered steps, cost and time to reach a goal',
                    type: 'checkbox',
                    default: true,
                    requiresRefresh: true,
                    help:
                        'A floating panel (Ctrl+K → Goal Planner) that turns a goal — 500M coins, Sinister Cape +10, ' +
                        'Enhancing 110, Observatory 8 — into the ordered steps to get there, each with its own cost and ' +
                        'time. Composes the calculators the rest of the script already uses: buy-versus-craft, the ' +
                        'enhancement path optimiser on your own stats, profit and experience per hour, house upgrade ' +
                        'costs. Press Refresh to re-price against the current market; steps you have since satisfied ' +
                        'come back struck through rather than disappearing',
                },
                ironCowFarm: {
                    // Display name is "Iron Bell Farming"; the setting id is kept as
                    // ironCowFarm since settings persist by id and renaming it would
                    // drop an existing user's saved preference.
                    id: 'ironCowFarm',
                    label: 'Iron Bell Farming: The cowbell-farming plan, and what it earns',
                    type: 'checkbox',
                    default: true,
                    requiresRefresh: true,
                    help:
                        'A floating panel (Ctrl+K → Iron Bell Farming) holding the standard iron-cow route to farming gold ' +
                        'for cowbells — the skills to level, the jewelry to craft, then the endless Star Fruit → ' +
                        'decompose → coinify loop — with each stage ticking itself off against your own levels, gear ' +
                        'and house. Costs the loop from your actual rates through the gathering and alchemy ' +
                        'calculators, and converts it to bells per hour, per day and per week at the current cowbell ' +
                        'price. All its gold is coinify output, never a market sale, because an iron cow cannot sell',
                },
                draggableModals: {
                    id: 'draggableModals',
                    label: 'Draggable modals',
                    type: 'checkbox',
                    default: true,
                    help: 'Makes game popup modals draggable. Position is remembered per modal type across sessions.',
                },
                formatting_useKMBFormat: {
                    id: 'formatting_useKMBFormat',
                    label: 'Number format mode',
                    type: 'select',
                    default: 'compact',
                    options: [
                        { value: 'full', label: 'Full (1,250,000)' },
                        { value: 'threshold', label: 'Abbreviate after 4 digits (1,250K)' },
                        { value: 'compact', label: 'Always abbreviate (1.25M)' },
                    ],
                    help: 'Controls how large numbers are displayed throughout the UI',
                },
                formatting_precision: {
                    id: 'formatting_precision',
                    label: 'Abbreviation precision (decimal digits)',
                    type: 'select',
                    default: '2',
                    options: [
                        { value: '1', label: '1 digit (1.2M)' },
                        { value: '2', label: '2 digits (1.25M)' },
                        { value: '3', label: '3 digits (1.250M)' },
                        { value: '4', label: '4 digits (1.2500M)' },
                    ],
                    help: 'Number of decimal places shown when numbers are abbreviated with K/M/B suffixes',
                },
                ui_externalLinks: {
                    id: 'ui_externalLinks',
                    label: 'Left sidebar: Show external tool links',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds quick links to Combat Sim, Market Tracker, Enhancelator, and Milkonomy',
                },
                hideLabyrinthBadge: {
                    id: 'hideLabyrinthBadge',
                    label: 'Left sidebar: Hide Labyrinth ping badge',
                    type: 'checkbox',
                    default: false,
                },
                hideGuildBadge: {
                    id: 'hideGuildBadge',
                    label: 'Left sidebar: Hide Guild notification badge',
                    type: 'checkbox',
                    default: false,
                },
                panelSizeMemory: {
                    id: 'panelSizeMemory',
                    label: 'Layout: Remember panel sizes you drag',
                    type: 'checkbox',
                    default: true,
                    help: 'The game forgets panel widths on reload. This records whatever a divider drag changes and reapplies it next session — only styles the game itself wrote in response to your own drag are replayed, and a remembered size is dropped if the layout changes shape.',
                },
                tabReorder: {
                    id: 'tabReorder',
                    label: 'Character panel: Drag-and-drop tab reordering',
                    type: 'checkbox',
                    default: true,
                    help: 'Drag tabs to rearrange the order of Inventory, Toolasha, Equipment, Houses, Abilities, and Loadout. Order persists through refresh.',
                },
                expPercentage: {
                    id: 'expPercentage',
                    label: 'Left sidebar: Show skill XP percentages',
                    type: 'checkbox',
                    default: true,
                },
                itemIconLevel: {
                    id: 'itemIconLevel',
                    label: 'Bottom left corner of icons: Show equipment level',
                    type: 'checkbox',
                    default: true,
                },
                loadoutEnhancementDisplay: {
                    id: 'loadoutEnhancementDisplay',
                    label: 'Loadout panel: Show highest-owned enhancement level on equipment icons',
                    type: 'checkbox',
                    default: true,
                },
                loadoutSnapshot: {
                    id: 'loadoutSnapshot',
                    label: 'Loadout panel: Use saved loadout snapshots in profit calculations',
                    type: 'checkbox',
                    default: true,
                    help: "When you queue an action, Toolasha predicts its XP, time, and profit using the saved loadout for that skill (skill-default → all-skills-default → any saved loadout → currently-equipped). Save your loadouts in-game so they're captured. Disable to always predict using currently-equipped gear.",
                },
                showsKeyInfoInIcon: {
                    id: 'showsKeyInfoInIcon',
                    label: 'Bottom left corner of key icons: Show zone index',
                    type: 'checkbox',
                    default: true,
                },
                mapIndex: {
                    id: 'mapIndex',
                    label: 'Combat zones: Show zone index numbers',
                    type: 'checkbox',
                    default: true,
                },
                combatScale: {
                    id: 'combatScale',
                    label: 'Battle panel: Resize the fight',
                    type: 'checkbox',
                    default: false,
                    help: 'Scale your side and the enemy side of the battle panel independently, and choose how they sit. A ten-monster wave and a solo fight get the same slab of screen, so one is cramped and the other mostly empty. Every setting below is stored per character, so each one keeps its own arrangement. Technique from Scaley Way Idle by Frotty. Turning this on or off takes a refresh; the numbers below apply as you change them',
                },
                combatScalePlayers: {
                    id: 'combatScalePlayers',
                    label: 'Battle panel: Your side (%)',
                    type: 'number',
                    default: 100,
                    min: 25,
                    max: 200,
                    help: 'Size of your own combat units. 100 leaves them as the game draws them',
                },
                combatScaleMonsters: {
                    id: 'combatScaleMonsters',
                    label: 'Battle panel: Enemy side (%)',
                    type: 'number',
                    default: 100,
                    min: 25,
                    max: 200,
                    help: 'Size of the enemy combat units, set separately from yours — a wave of ten and a single boss want opposite things',
                },
                combatScaleMethod: {
                    id: 'combatScaleMethod',
                    label: 'Battle panel: How to resize',
                    type: 'select',
                    default: 'zoom',
                    options: [
                        { value: 'zoom', label: 'Zoom — reflows, so shrinking recovers the space' },
                        { value: 'transform', label: 'Transform — scales in place, leaves a gap' },
                    ],
                    help: 'Zoom changes the layout size, so a shrunk side actually gives its space back. Transform only redraws smaller and leaves the original box behind; use it if zoom misbehaves in your browser',
                },
                combatScaleOrigin: {
                    id: 'combatScaleOrigin',
                    label: 'Battle panel: Transform anchor',
                    type: 'select',
                    default: 'top center',
                    options: [
                        { value: 'top center', label: 'Top centre' },
                        { value: 'top left', label: 'Top left' },
                        { value: 'center', label: 'Centre' },
                    ],
                    help: 'Which corner a scaled side shrinks toward. Only used when resizing by transform',
                },
                combatScaleLayout: {
                    id: 'combatScaleLayout',
                    label: 'Battle panel: Layout',
                    type: 'select',
                    default: 'game',
                    options: [
                        { value: 'game', label: "Leave the game's own layout" },
                        { value: 'side', label: 'Force side by side' },
                        { value: 'stack', label: 'Force stacked' },
                    ],
                    help: 'Forcing a layout overrides how the game arranges the two sides at your window width, so it can fight future game changes. Leave it alone unless you want the override',
                },
                combatScalePanelHeight: {
                    id: 'combatScalePanelHeight',
                    label: 'Character panel: Height (% of window, 0 = leave alone)',
                    type: 'number',
                    default: 0,
                    min: 0,
                    max: 100,
                    help: 'Height of the inventory/equipment panel beside the fight, as a percentage of the window. Set it taller to see more inventory at once, shorter to give the fight room. 0 leaves the height the game picks',
                },
                welcomeBackValue: {
                    id: 'welcomeBackValue',
                    label: 'Welcome Back modal: What the time offline was worth',
                    type: 'checkbox',
                    default: true,
                    help:
                        'Adds one line to the game’s Welcome Back modal valuing what you gained and what got consumed ' +
                        'while you were away — net coins, coins per hour offline and XP per hour — priced at market ' +
                        'using the pricing mode from the Market settings. Items with no market price are left out of ' +
                        'the total and counted instead, and the line is not drawn at all if nothing could be priced.',
                },
            },
        },

        guild: {
            title: 'Guild',
            icon: '👥',
            settings: {
                guildXPTracker: {
                    id: 'guildXPTracker',
                    label: 'Track guild and member XP over time',
                    type: 'checkbox',
                    default: true,
                    help: 'Records guild and member XP data from WebSocket messages for XP/hr calculations on the Guild panel.',
                },
                guildXPDisplay: {
                    id: 'guildXPDisplay',
                    label: 'Show XP/hr stats on Guild panel',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays XP/hr rates, rankings, and a weekly chart on the Guild Overview, Members, and Guild Leaderboard tabs. Disable the standalone Guild XP/h userscript if using this.',
                },
                guildIdleDisplay: {
                    id: 'guildIdleDisplay',
                    label: 'Guild Overview: Show idle members list',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays a list of guild members with no action running on the Guild Overview tab (actions keep running while offline, so offline members without one count too — shown dimmed). Members hiding their online status are included; only their action state is shown, never their presence.',
                },
                guildTrialSignupDisplay: {
                    id: 'guildTrialSignupDisplay',
                    label: 'Guild Trials: Show unsigned members list',
                    type: 'checkbox',
                    default: true,
                    help: "Displays which guild members have not yet signed up for the current week's skilling and combat trials.",
                },
                guildTrialWhisperTemplate: {
                    id: 'guildTrialWhisperTemplate',
                    label: 'Guild Trials: Whisper message when clicking a name',
                    type: 'text',
                    default: "/w {name} Why haven't you signed up for your trial(s) yet?!",
                    help: "Message pre-filled in chat when clicking an unsigned member's name. Use {name} for the player's name.",
                    templateVariables: [
                        { key: '{name}', label: 'Player Name', description: 'The name of the unsigned guild member' },
                    ],
                },
                guildTrialsInfo: {
                    id: 'guildTrialsInfo',
                    label: 'Guild Trials: Show rates, pace and payout on the In Progress tab',
                    type: 'checkbox',
                    default: true,
                    help:
                        'Measures the pool fill rate or party DPS off the trial cards and adds the ETA to clear the ' +
                        'current tier, how many tiers the hour is on pace for, the next tier’s projected size, and the ' +
                        'Guild Points and token payout the week’s tiers are worth.',
                },
                guildTrialAutoRecord: {
                    id: 'guildTrialAutoRecord',
                    label: 'Guild Trials: Record a trial automatically when one starts',
                    type: 'checkbox',
                    default: true,
                    help:
                        'Starts a recording session by itself when a trial fight is seen or the In Progress tab ' +
                        'shows a live reading, so the whole hour is captured without having to press anything. ' +
                        'The Record button on the trials block starts and stops one by hand either way.',
                },
                guildTrialsBuildersHallBonus: {
                    id: 'guildTrialsBuildersHallBonus',
                    label: 'Guild Trials: Builders Hall bonus override (%)',
                    type: 'number',
                    default: 0,
                    help:
                        'Guild Points are Base × (1 + Builders Hall bonus). Leave at 0 to read it from the game once ' +
                        'the guild Buildings tab has been opened; set it here if your guild knows the number and the ' +
                        'game does not expose it.',
                },
                guildTrialsTreasuryBonus: {
                    id: 'guildTrialsTreasuryBonus',
                    label: 'Guild Trials: Treasury bonus override (%)',
                    type: 'number',
                    default: 0,
                    help:
                        'Token payouts are 0.5 × TotalBasePoints × (1 + Treasury bonus). Leave at 0 to read it from ' +
                        'the game once the guild Buildings tab has been opened.',
                },
                guildMembersActivityTab: {
                    id: 'guildMembersActivityTab',
                    label: 'Guild Members: Show Activity column on',
                    type: 'select',
                    default: 'contributions',
                    options: [
                        { value: 'status', label: 'Status tab only (native)' },
                        { value: 'contributions', label: 'Contributions tab only' },
                        { value: 'both', label: 'Both tabs' },
                    ],
                    help: 'Controls where the Activity column appears. "Contributions tab only" hides the native column on Status and shows it on Contributions instead.',
                },
                guildMembersShowGameMode: {
                    id: 'guildMembersShowGameMode',
                    label: 'Guild Members: Show Game Mode column',
                    type: 'checkbox',
                    default: false,
                    help: 'Shows the MC/IC/LC game mode column (Status tab).',
                },
                guildMembersShowJoined: {
                    id: 'guildMembersShowJoined',
                    label: 'Guild Members: Show Joined column',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows the date each member joined the guild (Status tab).',
                },
                guildMembersShowLastXPH: {
                    id: 'guildMembersShowLastXPH',
                    label: 'Guild Members: Show Last XP/h column',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows recent XP/hr tracked by Toolasha (Contributions tab).',
                },
                guildMembersShowLastDayXPH: {
                    id: 'guildMembersShowLastDayXPH',
                    label: 'Guild Members: Show Last day XP/h column',
                    type: 'checkbox',
                    default: true,
                    help: 'Shows 24-hour average XP/hr tracked by Toolasha (Contributions tab).',
                },
                guildTokenCreditRate: {
                    id: 'guildTokenCreditRate',
                    label: 'Guild Shop: Guild credits received per guild token',
                    type: 'number',
                    default: 1,
                    min: 0,
                    help:
                        'Guild tokens are never listed on the market, so they are priced through the Guild Shop ' +
                        'exchange instead: credits per token × the gold value of a credit, taking whichever credit ' +
                        'colour yields the most gold. This number is now the last resort. Opening a Guild Shop ' +
                        'exchange dialog with a Guild Token selected reads that colour’s real rate off the screen ' +
                        'and remembers it, and client data wins over even that — so in normal play the live rate is ' +
                        'what gets used and this setting is never consulted. It only stands in before any dialog ' +
                        'has been opened, and every figure derived from it is labelled “assumed rate”. Run ' +
                        'Toolasha.debug.tokenExchange() in the console to see every colour’s rate and which one was ' +
                        'picked. Set to 0 to leave tokens unpriced, as they were before.',
                },
                guildCreditValue: {
                    id: 'guildCreditValue',
                    label: 'Guild Shop: Show gold cost per credit table',
                    type: 'checkbox',
                    default: true,
                    help: 'Injects a cost-efficiency table into each guild credit exchange modal, sorted cheapest first using your profit pricing mode.',
                },
                guildCreditExchangeAdvisor: {
                    id: 'guildCreditExchangeAdvisor',
                    label: 'Guild Shop: Show exchange advisor (sell → rebuy comparison)',
                    type: 'checkbox',
                    default: true,
                    help: 'When the selected item is not the cheapest option, shows whether selling it and rebuying the best item would yield more credits (accounts for 2% seller tax).',
                },
                guildShrineUpgradePlanner: {
                    id: 'guildShrineUpgradePlanner',
                    label: 'Guild Shop: Show shrine upgrade planner',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a shrine upgrade planner to the guild credit exchange panel, showing total credit and token costs to upgrade from your current level to a target level.',
                },
                guildRoster: {
                    id: 'guildRoster',
                    label: 'Guild Roster: Contribution shares and gone-quiet flags',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds a Guild Roster overlay tile and panel showing each member’s share of the XP actually observed over 7 and 30 days, who has gone quiet against their own weekly rate, and a guild level projection. Uses the XP the Guild XP Tracker has already recorded.',
                },
            },
        },

        insights: {
            title: 'Insights',
            icon: '🔍',
            settings: {
                insights_calibration: {
                    id: 'insights_calibration',
                    label: 'Prediction Calibration: Check profit forecasts against finished runs',
                    type: 'checkbox',
                    default: true,
                    help: 'Records what the profit calculators predicted for an action beside what the loot log says the run actually paid, and flags skills where the forecast is persistently off. Adds a Prediction Calibration overlay tile and panel.',
                },
            },
        },

        house: {
            title: 'House',
            icon: '🏠',
            settings: {
                houseUpgradeCosts: {
                    id: 'houseUpgradeCosts',
                    label: 'Show upgrade costs with market prices and inventory comparison',
                    type: 'checkbox',
                    default: true,
                },
            },
        },

        leaderboard: {
            title: 'Leaderboard',
            icon: '🏆',
            settings: {
                leaderboardXPTracker: {
                    id: 'leaderboardXPTracker',
                    label: 'Track player XP over time from Leaderboard',
                    type: 'checkbox',
                    default: true,
                    help: 'Records player XP from leaderboard WebSocket messages for XP/hr calculations on the Leaderboard panel.',
                },
                leaderboardXPDisplay: {
                    id: 'leaderboardXPDisplay',
                    label: 'Show XP/hr columns on Leaderboard',
                    type: 'checkbox',
                    default: true,
                    help: 'Adds Last XP/h and Last day XP/h columns to the player Leaderboard panel.',
                },
            },
        },

        notifications: {
            title: 'Notifications',
            icon: '🔔',
            settings: {
                notifications_browserEnabled: {
                    id: 'notifications_browserEnabled',
                    label: 'Allow desktop notifications',
                    type: 'checkbox',
                    default: false,
                    help: 'Master switch for the desktop-notification channel. Ticking this asks the browser for permission — the ask happens here rather than at page load, because a prompt nobody expects is usually dismissed and a dismissed prompt is remembered. With this off, or permission refused, notifications still arrive as an in-page toast when the tab is visible and as a ❗ on the tab title when it is not.',
                },
                notifiEmptyAction: {
                    id: 'notifiEmptyAction',
                    label: 'Notify when the current character queue is empty',
                    type: 'checkbox',
                    default: false,
                    help: 'Keys on the action queue going from having actions to having none, as reported by the game over the websocket. Covers only the character you are logged in as, and only while the game page is open.',
                },
                notifications_consumableLow: {
                    id: 'notifications_consumableLow',
                    label: 'Notify when drinks are running low',
                    type: 'checkbox',
                    default: false,
                    help: 'Fires when the soonest drink to run out falls below the "Drink timer: warning threshold (hours)" setting — the same crossing that turns the drink timer amber. Once per crossing, and it re-arms when you restock above the threshold. Requires the Drink Timer feature, and reads the drink slots of the skill you are currently performing plus any skill panel you have open.',
                },
                notifications_marketListingFilled: {
                    id: 'notifications_marketListingFilled',
                    label: 'Notify when a market listing finishes',
                    type: 'checkbox',
                    default: false,
                    help: 'Keys on the count of finished listings going up — an order that filled completely, or a cancelled one holding a refund. An order still partly filling is not counted, because collecting it achieves nothing. Same rule as the Marketplace badge filter, and works whether or not that filter is on.',
                },
                notifications_marketListingUndercut: {
                    id: 'notifications_marketListingUndercut',
                    label: 'Notify when a market listing of yours is undercut',
                    type: 'checkbox',
                    default: false,
                    help: 'Compares each active sell listing of yours against the current best ask for that item and enhancement level, and each buy order against the best bid — a strictly better price than yours means you have been beaten; matching the best price is still competitive and says nothing. The figures come from the market data this script already holds, which can be up to 15 minutes old: the message carries the age of the figure it used, and data older than that — or an item with no cached price at all — is treated as unknown rather than as an undercut. Once per listing per undercut, re-arming when you reprice the listing or your price is the best again.',
                },
                notifications_otherCharacterIdle: {
                    id: 'notifications_otherCharacterIdle',
                    label: 'Notify when another character has run out of queue',
                    type: 'checkbox',
                    default: false,
                    help: 'Projected, not observed. Each other character queue is captured when you switch away from it, and this fires once that much time has elapsed — it cannot see a character while you are not logged into it, so anything queued there from elsewhere is invisible to it. Characters with an unbounded action queued are skipped, and a character is announced again only after you next switch away from it.',
                },
                notifications_labyrinthRunFinished: {
                    id: 'notifications_labyrinthRunFinished',
                    label: 'Notify when a labyrinth run finishes',
                    type: 'checkbox',
                    default: false,
                    help: 'Keys on the run going from active to not active, as the server reports it — so it covers every ending: cleared out, ended on a lost fight, or exited on purpose. It does not say which, because the payload does not: there is no outcome or reason field on a labyrinth message, so the alert reports the deepest floor the run reached and leaves it at that. Once per run.',
                },
                notifications_combatDeath: {
                    id: 'notifications_combatDeath',
                    label: 'Notify when you die in combat',
                    type: 'checkbox',
                    default: false,
                    help: 'Keys on the server’s own death count for your character going up between battles — your deaths only, not the party’s. One message per cooldown rather than one per death, so a zone that is killing you repeatedly says so once and the total in the message tells you how bad it got. Deaths that happened before you switched this on are not announced.',
                },
                notifications_enhancementTarget: {
                    id: 'notifications_enhancementTarget',
                    label: 'Notify when an item reaches its enhancement target',
                    type: 'checkbox',
                    default: false,
                    help: 'Reads the “enhance until +N” you set in the game’s own enhancing panel, and the level the item is at after each attempt — so it works whether or not the Enhancement Tracker is on. Nothing is announced when no target is set, since there is no ending to announce. Once per item and target, re-arming when that item is seen below the target again.',
                },
                notifications_trialStarting: {
                    id: 'notifications_trialStarting',
                    label: 'Notify when a guild trial is about to start',
                    type: 'checkbox',
                    default: false,
                    help: 'The guild panel states the next trial’s schedule (“Scheduled Wed 04:00 PM 2h 24m”). This announces it once the countdown is inside the lead time below, and again the moment the trial actually starts. The countdown is only read while the guild panel is open — no socket message carries a trial schedule.',
                },
                notifications_trialStartLeadMinutes: {
                    id: 'notifications_trialStartLeadMinutes',
                    label: 'Guild trial warning lead time (minutes)',
                    type: 'number',
                    default: 10,
                    min: 1,
                    max: 120,
                    help: 'How long before a scheduled guild trial to announce it.',
                },
                notifications_trialResults: {
                    id: 'notifications_trialResults',
                    label: 'Notify when a guild trial finishes, with what it paid',
                    type: 'checkbox',
                    default: false,
                    help: 'Announces the Guild Points banked and the token payout — every eligible member’s share and a participant’s — as soon as the guild panel reports the cycle complete.',
                },
                notifications_taskSlotsFull: {
                    id: 'notifications_taskSlotsFull',
                    label: 'Notify before your task slots fill up',
                    type: 'checkbox',
                    default: false,
                    help: 'A task that arrives with no free slot is simply not given — there is no queue behind the board. This projects when the last free slot fills, from the server’s own slot cap, task cooldown and last-task time, so it works with the task panel closed. It is a projection, not an observation: it assumes the cadence holds and that nothing frees a slot in the meantime, and it can only be as fresh as the last message the game sent this tab. Completing, claiming or discarding a task moves the deadline and re-arms the warning. A board that is already full says so once.',
                },
                notifications_taskSlotsLeadHours: {
                    id: 'notifications_taskSlotsLeadHours',
                    label: 'Task slots warning lead time (hours)',
                    type: 'number',
                    default: 8,
                    min: 1,
                    max: 48,
                    help: 'How long before the last free task slot fills to warn you — enough notice to claim or clear something. Default: 8.',
                },
                notifications_communityBuffExpiring: {
                    id: 'notifications_communityBuffExpiring',
                    label: 'Notify before a community buff expires',
                    type: 'checkbox',
                    default: false,
                    help: 'Reads the expiry the server sends with each community buff, so the warning is timed off the real end of the buff rather than a countdown read from the screen. Fires once per expiry; a donation that extends a buff pushes the expiry out and arms the warning again for the new one. Use the per-buff switches below to pick which ones you care about.',
                },
                notifications_communityBuffLeadMinutes: {
                    id: 'notifications_communityBuffLeadMinutes',
                    label: 'Community buff warning: minutes ahead',
                    type: 'number',
                    default: 15,
                    min: 5,
                    max: 120,
                    help: 'How many minutes before a community buff’s actual expiry to warn you — enough notice to get to the Cowbell Store and donate. Default: 15.',
                },
                notifications_communityBuff_experience: {
                    id: 'notifications_communityBuff_experience',
                    label: 'Community buff: Experience',
                    type: 'checkbox',
                    default: true,
                    help: 'Include the Experience community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
                },
                notifications_communityBuff_gatheringQuantity: {
                    id: 'notifications_communityBuff_gatheringQuantity',
                    label: 'Community buff: Gathering Quantity',
                    type: 'checkbox',
                    default: true,
                    help: 'Include the Gathering Quantity community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
                },
                notifications_communityBuff_productionEfficiency: {
                    id: 'notifications_communityBuff_productionEfficiency',
                    label: 'Community buff: Production Efficiency',
                    type: 'checkbox',
                    default: true,
                    help: 'Include the Production Efficiency community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
                },
                notifications_communityBuff_enhancingSpeed: {
                    id: 'notifications_communityBuff_enhancingSpeed',
                    label: 'Community buff: Enhancing Speed',
                    type: 'checkbox',
                    default: true,
                    help: 'Include the Enhancing Speed community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
                },
                notifications_communityBuff_combatDropQuantity: {
                    id: 'notifications_communityBuff_combatDropQuantity',
                    label: 'Community buff: Combat Drop Quantity',
                    type: 'checkbox',
                    default: true,
                    help: 'Include the Combat Drop Quantity community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
                },
            },
        },

        colors: {
            title: 'Color Customization',
            icon: '🎨',
            settings: {
                color_profit: {
                    id: 'color_profit',
                    label: 'Profit/Positive Values',
                    type: 'color',
                    default: '#047857',
                    help: 'Color used for profit, gains, and positive values',
                },
                color_loss: {
                    id: 'color_loss',
                    label: 'Loss/Negative Values',
                    type: 'color',
                    default: '#f87171',
                    help: 'Color used for losses, costs, and negative values',
                },
                color_warning: {
                    id: 'color_warning',
                    label: 'Warnings',
                    type: 'color',
                    default: '#ffa500',
                    help: 'Color used for warnings and important notices',
                },
                color_info: {
                    id: 'color_info',
                    label: 'Informational',
                    type: 'color',
                    default: '#60a5fa',
                    help: 'Color used for informational text and highlights',
                },
                color_essence: {
                    id: 'color_essence',
                    label: 'Essences',
                    type: 'color',
                    default: '#c084fc',
                    help: 'Color used for essence drops and essence-related text',
                },
                color_tooltip_profit: {
                    id: 'color_tooltip_profit',
                    label: 'Tooltip Profit/Positive',
                    type: 'color',
                    default: '#047857',
                    help: 'Color for profit/positive values in tooltips (light backgrounds)',
                },
                color_tooltip_loss: {
                    id: 'color_tooltip_loss',
                    label: 'Tooltip Loss/Negative',
                    type: 'color',
                    default: '#dc2626',
                    help: 'Color for loss/negative values in tooltips (light backgrounds)',
                },
                color_tooltip_info: {
                    id: 'color_tooltip_info',
                    label: 'Tooltip Informational',
                    type: 'color',
                    default: '#2563eb',
                    help: 'Color for informational text in tooltips (light backgrounds)',
                },
                color_tooltip_warning: {
                    id: 'color_tooltip_warning',
                    label: 'Tooltip Warnings',
                    type: 'color',
                    default: '#ea580c',
                    help: 'Color for warnings in tooltips (light backgrounds)',
                },
                color_text_primary: {
                    id: 'color_text_primary',
                    label: 'Primary Text',
                    type: 'color',
                    default: '#ffffff',
                    help: 'Main text color',
                },
                color_text_secondary: {
                    id: 'color_text_secondary',
                    label: 'Secondary Text',
                    type: 'color',
                    default: '#888888',
                    help: 'Dimmed/secondary text color',
                },
                color_border: {
                    id: 'color_border',
                    label: 'Borders',
                    type: 'color',
                    default: '#444444',
                    help: 'Border and separator color',
                },
                color_gold: {
                    id: 'color_gold',
                    label: 'Gold/Currency',
                    type: 'color',
                    default: '#ffa500',
                    help: 'Color used for gold and currency displays',
                },
                color_mirror: {
                    id: 'color_mirror',
                    label: "Philosopher's Mirror",
                    type: 'color',
                    default: '#ffd700',
                    help: "Color for the Philosopher's Mirror usage line in enhancement tooltips",
                },
                color_listing_price_1m: {
                    id: 'color_listing_price_1m',
                    label: 'Listing Total: 1M+',
                    type: 'color',
                    default: '#ffd700',
                    help: 'Color for market listing total prices of 1 million or more',
                },
                color_listing_price_100k: {
                    id: 'color_listing_price_100k',
                    label: 'Listing Total: 100K+',
                    type: 'color',
                    default: '#22c55e',
                    help: 'Color for market listing total prices of 100K or more',
                },
                color_listing_price_10k: {
                    id: 'color_listing_price_10k',
                    label: 'Listing Total: 10K+',
                    type: 'color',
                    default: '#ffffff',
                    help: 'Color for market listing total prices of 10K or more',
                },
                color_listing_price_low: {
                    id: 'color_listing_price_low',
                    label: 'Listing Total: <10K',
                    type: 'color',
                    default: '#888888',
                    help: 'Color for market listing total prices under 10K',
                },
                color_accent: {
                    id: 'color_accent',
                    label: 'Script Accent Color',
                    type: 'color',
                    default: '#22c55e',
                    help: 'Primary accent color for script UI elements (buttons, headers, zone numbers, XP percentages, etc.)',
                },
                color_remaining_xp: {
                    id: 'color_remaining_xp',
                    label: 'Remaining XP Text',
                    type: 'color',
                    default: '#FFFFFF',
                    help: 'Color for remaining XP text below skill bars in left navigation',
                },
                color_xp_rate: {
                    id: 'color_xp_rate',
                    label: 'XP Rate Text',
                    type: 'color',
                    default: '#ffffff',
                    help: 'Color for XP/hr rate text on skill bars in left navigation',
                },
                color_hours_to_level: {
                    id: 'color_hours_to_level',
                    label: 'Hours to Level Text',
                    type: 'color',
                    default: '#ffffff',
                    help: 'Color for "hours till next level" text in skill tooltips',
                },
                color_inv_count: {
                    id: 'color_inv_count',
                    label: 'Inventory Count Text',
                    type: 'color',
                    default: '#ffffff',
                    help: 'Color for inventory count shown on action tiles and in the action detail panel',
                },
                color_invBadge_ask: {
                    id: 'color_invBadge_ask',
                    label: 'Inventory Badge: Ask Price',
                    type: 'color',
                    default: '#047857',
                    help: 'Color for Ask price badges on inventory items (seller asking price - better selling value)',
                },
                color_invBadge_bid: {
                    id: 'color_invBadge_bid',
                    label: 'Inventory Badge: Bid Price',
                    type: 'color',
                    default: '#60a5fa',
                    help: 'Color for Bid price badges on inventory items (buyer bid price - instant-sell value)',
                },
                color_transmute: {
                    id: 'color_transmute',
                    label: 'Transmutation Rates',
                    type: 'color',
                    default: '#ffffff',
                    help: 'Color used for transmutation success rate percentages in Item Dictionary',
                },
                color_queueLength_known: {
                    id: 'color_queueLength_known',
                    label: 'Queue Length: Known Value',
                    type: 'color',
                    default: '#ffffff',
                    help: 'Color for known queue lengths (when all visible orders are counted)',
                },
                color_queueLength_estimated: {
                    id: 'color_queueLength_estimated',
                    label: 'Queue Length: Estimated Value',
                    type: 'color',
                    default: '#60a5fa',
                    help: 'Color for estimated queue lengths (extrapolated from 20+ orders at same price)',
                },
            },
        },

        collectionFilters: {
            title: 'Collection Filters',
            icon: '⭐',
            settings: {
                collectionFilters: {
                    id: 'collectionFilters',
                    label: 'Collection Filters: Count-range, dungeon, and skilling-outfit filters',
                    type: 'checkbox',
                    default: true,
                },
                collectionFavorites: {
                    id: 'collectionFavorites',
                    label: 'Collection Favorites: Star (★) items to mark and filter favorites',
                    type: 'checkbox',
                    default: true,
                },
                collectionFavoritesSection: {
                    id: 'collectionFavoritesSection',
                    label: 'Collection Favorites: Show favorites section at top of grid',
                    type: 'checkbox',
                    default: true,
                },
                collectionFilters_skillingBadges: {
                    id: 'collectionFilters_skillingBadges',
                    label: 'Show collection count badges on skilling action tiles',
                    type: 'checkbox',
                    default: true,
                    help: 'Displays your collection count on skilling actions (open Collections once to populate counts)',
                },
            },
        },

        sync: {
            title: 'Cross-Device Sync',
            icon: '☁️',
            settings: {
                sync_enabled: {
                    id: 'sync_enabled',
                    label: 'Enable cross-device sync (GitHub gist)',
                    type: 'checkbox',
                    default: false,
                    help:
                        'Carries your Toolasha data between browsers through one private GitHub gist that you own. ' +
                        'Nothing goes to any server of ours, and nothing is sent until you press Push or turn on ' +
                        'automatic sync below.',
                },
                sync_token: {
                    id: 'sync_token',
                    label: 'GitHub personal access token',
                    type: 'password',
                    default: '',
                    placeholder: 'ghp_… or github_pat_…',
                    help:
                        'Needs the "gist" scope and nothing else — a classic token with only that box ticked, or a ' +
                        'fine-grained token with Gists set to read and write. SECURITY: the token is stored in this ' +
                        "browser's local database in plain text, exactly like every other setting, and any script or " +
                        'extension that can read this page can read it. Use a token that can only touch gists, and revoke ' +
                        'it at github.com/settings/tokens if you stop using sync. It is never written into the synced ' +
                        'payload, so pulling on another device will not plant it there.',
                },
                sync_passphrase: {
                    id: 'sync_passphrase',
                    label: 'Sync passphrase (optional encryption)',
                    type: 'password',
                    default: '',
                    placeholder: 'Leave empty to sync unencrypted',
                    help:
                        'When set, the gist holds AES-256 ciphertext instead of readable JSON, so the data is useless to ' +
                        'anyone who gets the gist URL, the token, or your GitHub account. Enter the SAME passphrase on ' +
                        'every device that shares the gist; there is no recovery — a forgotten passphrase means pushing ' +
                        'fresh from a device that still has the data. Like the token, the passphrase is stored in this ' +
                        "browser's local database in plain text, so it hides the gist from GitHub-side readers, not from " +
                        'extensions that can already read this page. It is never uploaded.',
                },
                sync_scope: {
                    id: 'sync_scope',
                    label: 'What to sync',
                    type: 'select',
                    default: 'settings',
                    options: [
                        { value: 'settings', label: 'Settings only' },
                        { value: 'everything', label: 'Everything (settings + all tracked history)' },
                    ],
                    help:
                        'Settings only is small and fast. Everything also carries dungeon runs, XP history, loot logs and ' +
                        'the rest — the same contents as "Back Up Everything" — which on a played-in account can be many ' +
                        'megabytes and is split across several files inside the gist.',
                },
                sync_auto: {
                    id: 'sync_auto',
                    label: 'Sync automatically',
                    type: 'checkbox',
                    default: false,
                    help:
                        'Pulls once shortly after the page loads if the gist is newer than what this device last synced, ' +
                        'and pushes every 15 minutes if anything changed. When both sides have changed you are asked ' +
                        'which one wins rather than the older copy being overwritten quietly.',
                },
            },
        },
    };

    /**
     * Get all setting IDs in order
     * @returns {string[]} Array of setting IDs
     */
    function getAllSettingIds() {
        const ids = [];
        for (const group of Object.values(settingsGroups)) {
            for (const settingId of Object.keys(group.settings)) {
                ids.push(settingId);
            }
        }
        return ids;
    }

    /**
     * Get a setting definition by ID
     * @param {string} settingId - Setting ID
     * @returns {Object|null} Setting definition or null
     */
    function getSettingDefinition(settingId) {
        for (const group of Object.values(settingsGroups)) {
            if (group.settings[settingId]) {
                return group.settings[settingId];
            }
        }
        return null;
    }

    /**
     * Settings Storage Module
     * Handles persistence of settings to chrome.storage.local
     */


    /**
     * Whether a schema type stores its state as a boolean (.isTrue)
     * @param {string} type - Setting type from the schema
     * @returns {boolean}
     */
    function isBooleanType(type) {
        return type === 'checkbox' || type === 'checkboxWithButton';
    }

    /**
     * Schema defaults that changed after release, and the value they changed from.
     *
     * A changed schema default only reaches a fresh install. The saved map is
     * written whole — every setting the schema had at save time is in it, chosen or
     * not — so an existing user holds the *old* default as an explicit stored
     * value, and the merge below faithfully restores it forever. That is right for
     * a setting the user actually picked and wrong for one they never touched, and
     * storage cannot tell the two apart.
     *
     * So each entry is rewritten exactly once, guarded by a persisted flag: an old
     * default is nudged to the new one on the first load that sees it, and after
     * that the user's value is theirs. Someone who deliberately re-picks the old
     * value keeps it, because the flag has already been set.
     *
     * `from` is the value being replaced — anything else stays put, since a user
     * who chose a third option was never sitting on the old default.
     */
    const DEFAULT_REWRITES = [
        // Replaying the live fight runs the real combat engine hundreds of times
        // mid-fight; it should be opt-in rather than something every player pays for
        { id: 'labyrinthLiveCombatSim', field: 'isTrue', from: true, to: false },
        // Routing unrevealed rooms as clearable sends players through rooms that
        // turn out to need a shroud they did not bring
        { id: 'labyrinthPathUnknownMode', field: 'value', from: 'clearable', to: 'shroud' },
    ];

    /** Bump the suffix when a new batch is added to DEFAULT_REWRITES */
    const DEFAULT_REWRITE_FLAG_KEY = 'settings_default_rewrites_v1';

    class SettingsStorage {
        constructor() {
            this.storageKey = 'script_settingsMap'; // Legacy global key (used as template)
            this.storageArea = 'settings';
            this.currentCharacterId = null;
            this.currentCharacterName = null;
            this.knownCharactersKey = 'known_character_ids';
        }

        /**
         * Set the current character ID and name.
         * Must be called after character_initialized event.
         * @param {string} characterId
         * @param {string} [characterName]
         */
        setCharacterId(characterId, characterName) {
            this.currentCharacterId = characterId;
            if (characterName) this.currentCharacterName = characterName;
        }

        /**
         * Get the storage key for current character
         * Falls back to global key if no character ID set
         * @returns {string} Storage key
         */
        getCharacterStorageKey() {
            if (this.currentCharacterId) {
                return `${this.storageKey}_${this.currentCharacterId}`;
            }
            return this.storageKey; // Fallback to global key
        }

        /**
         * The setting IDs the *previous* build saved, before any merging.
         *
         * The saved map is written whole, so its keys are a fingerprint of the
         * schema of whatever script wrote it — including the upstream fork, which
         * uses the same storage keys. Diffing the current schema against this is
         * how a first run tells "arrived from another build of Toolasha, with
         * settings worth respecting" from "genuinely fresh install".
         *
         * @returns {Promise<Array<string>|null>} Stored IDs, or null when nothing
         *   has ever been saved
         */
        async storedSettingIds() {
            const saved = await storage.getJSON(this.getCharacterStorageKey(), this.storageArea, null);
            return saved ? Object.keys(saved) : null;
        }

        /**
         * Load all settings from storage
         * Merges saved values with defaults from settings-schema
         * @returns {Promise<Object>} Settings map
         */
        async loadSettings() {
            const characterKey = this.getCharacterStorageKey();
            let saved = await storage.getJSON(characterKey, this.storageArea, null);

            // Migration: If this is a character-specific key and it doesn't exist
            // Copy from global template (old 'script_settingsMap' key)
            if (this.currentCharacterId && !saved) {
                const globalTemplate = await storage.getJSON(this.storageKey, this.storageArea, null);
                if (globalTemplate) {
                    // Copy global template to this character
                    saved = globalTemplate;
                    await storage.setJSON(characterKey, saved, this.storageArea, true);
                }

                // Add character to known characters list
                await this.addToKnownCharacters(this.currentCharacterId, this.currentCharacterName);
            }

            saved = await this.applyDefaultRewrites(saved, characterKey);

            const settings = {};

            // Build default settings from config
            for (const group of Object.values(settingsGroups)) {
                for (const [settingId, settingDef] of Object.entries(group.settings)) {
                    settings[settingId] = {
                        id: settingId,
                        desc: settingDef.label,
                        type: settingDef.type || 'checkbox',
                    };

                    // Set default value
                    if (isBooleanType(settingDef.type)) {
                        settings[settingId].isTrue = settingDef.default ?? false;
                    } else {
                        settings[settingId].value = settingDef.default ?? '';
                    }

                    // Copy other properties
                    if (settingDef.options && typeof settingDef.options !== 'function') {
                        settings[settingId].options = settingDef.options;
                    }
                    if (settingDef.min !== undefined) {
                        settings[settingId].min = settingDef.min;
                    }
                    if (settingDef.max !== undefined) {
                        settings[settingId].max = settingDef.max;
                    }
                    if (settingDef.step !== undefined) {
                        settings[settingId].step = settingDef.step;
                    }
                }
            }

            // Merge saved settings
            if (saved) {
                for (const [settingId, savedValue] of Object.entries(saved)) {
                    if (settings[settingId]) {
                        // Merge saved boolean values
                        if (savedValue.hasOwnProperty('isTrue')) {
                            settings[settingId].isTrue = savedValue.isTrue;
                        }
                        // Merge saved non-boolean values
                        if (savedValue.hasOwnProperty('value')) {
                            if (isBooleanType(settings[settingId].type)) {
                                // Migration: checkboxWithButton settings once persisted
                                // their boolean in .value instead of .isTrue
                                if (!savedValue.hasOwnProperty('isTrue')) {
                                    settings[settingId].isTrue = !!savedValue.value;
                                }
                            } else {
                                settings[settingId].value = savedValue.value;
                            }
                        }
                    }
                }

                // Migrate: formatting_useKMBFormat changed from checkbox to select
                const fmtSaved = saved['formatting_useKMBFormat'];
                if (fmtSaved && fmtSaved.hasOwnProperty('isTrue') && !fmtSaved.hasOwnProperty('value')) {
                    settings['formatting_useKMBFormat'].value = fmtSaved.isTrue ? 'compact' : 'full';
                }
            }

            return settings;
        }

        /**
         * Rewrite stored values still sitting on a superseded schema default, once.
         *
         * See DEFAULT_REWRITES for why this is needed at all. The flag is stored
         * per character, beside that character's settings, so each save file is
         * nudged exactly once — and is set even when there is nothing to rewrite
         * (a fresh install, which already has the new defaults), so a later change
         * of mind is never second-guessed.
         *
         * @param {Object|null} saved - The stored settings map, or null when none
         * @param {string} characterKey - Storage key the map was loaded from
         * @returns {Promise<Object|null>} The map to merge, rewrites applied
         */
        async applyDefaultRewrites(saved, characterKey) {
            const flagKey = `${DEFAULT_REWRITE_FLAG_KEY}_${characterKey}`;
            try {
                if (await storage.get(flagKey, this.storageArea, false)) return saved;

                let next = saved;
                for (const { id, field, from, to } of DEFAULT_REWRITES) {
                    const entry = saved?.[id];
                    if (!entry || entry[field] !== from) continue;
                    // Copy rather than mutate the loaded map, so a caller holding
                    // the same object does not see it change underneath them
                    next = next === saved ? { ...saved } : next;
                    next[id] = { ...entry, [field]: to };
                }

                if (next !== saved) {
                    await storage.setJSON(characterKey, next, this.storageArea, true);
                }
                await storage.set(flagKey, true, this.storageArea, true);
                return next;
            } catch (error) {
                // A failed rewrite must not cost the user their settings; the flag
                // stays unset, so the next load tries again
                console.error('[SettingsStorage] Default rewrite failed:', error);
                return saved;
            }
        }

        /**
         * Build default settings from schema without touching storage
         * Used during early initialization before character ID is known
         * @returns {Object} Settings map with schema defaults only
         */
        buildDefaults() {
            const settings = {};

            for (const group of Object.values(settingsGroups)) {
                for (const [settingId, settingDef] of Object.entries(group.settings)) {
                    settings[settingId] = {
                        id: settingId,
                        desc: settingDef.label,
                        type: settingDef.type || 'checkbox',
                    };

                    if (isBooleanType(settingDef.type)) {
                        settings[settingId].isTrue = settingDef.default ?? false;
                    } else {
                        settings[settingId].value = settingDef.default ?? '';
                    }

                    if (settingDef.options) {
                        settings[settingId].options = settingDef.options;
                    }
                    if (settingDef.min !== undefined) {
                        settings[settingId].min = settingDef.min;
                    }
                    if (settingDef.max !== undefined) {
                        settings[settingId].max = settingDef.max;
                    }
                    if (settingDef.step !== undefined) {
                        settings[settingId].step = settingDef.step;
                    }
                }
            }

            return settings;
        }

        /**
         * Save all settings to storage
         * @param {Object} settings - Settings map
         * @returns {Promise<void>}
         */
        async saveSettings(settings) {
            const characterKey = this.getCharacterStorageKey();
            await storage.setJSON(characterKey, settings, this.storageArea, true);
        }

        /**
         * Add character to known characters list, storing name alongside ID.
         * Migrates old flat-array format ([id, id]) to object format ([{id, name}]).
         * @param {string} characterId
         * @param {string} characterName
         * @returns {Promise<void>}
         */
        async addToKnownCharacters(characterId, characterName) {
            const raw = await storage.getJSON(this.knownCharactersKey, this.storageArea, []);
            const list = this._normalizeKnownCharacters(raw);
            const existing = list.find((c) => c.id === characterId);
            if (existing) {
                if (characterName && existing.name !== characterName) {
                    existing.name = characterName;
                    await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
                }
            } else {
                list.push({ id: characterId, name: characterName || characterId });
                await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
            }
        }

        /**
         * Normalise stored known-characters to [{id, name}] regardless of legacy format.
         * @param {Array} raw
         * @returns {Array<{id: string, name: string}>}
         * @private
         */
        _normalizeKnownCharacters(raw) {
            if (!Array.isArray(raw)) return [];
            return raw.map((entry) =>
                typeof entry === 'object' && entry !== null
                    ? { id: String(entry.id), name: entry.name || String(entry.id) }
                    : { id: String(entry), name: String(entry) }
            );
        }

        /**
         * Get list of known characters as [{id, name}] objects.
         * @returns {Promise<Array<{id: string, name: string}>>}
         */
        async getKnownCharacters() {
            const raw = await storage.getJSON(this.knownCharactersKey, this.storageArea, []);
            return this._normalizeKnownCharacters(raw);
        }

        /**
         * Sync current settings to a specified subset of characters.
         * @param {Object} settings - Current settings to copy
         * @param {string[]} targetIds - IDs to sync to (omit to sync to all others)
         * @returns {Promise<number>} Number of characters synced
         */
        async syncSettingsToAllCharacters(settings, targetIds) {
            const knownCharacters = await this.getKnownCharacters();
            let syncedCount = 0;

            const targets = targetIds
                ? knownCharacters.filter((c) => targetIds.includes(c.id))
                : knownCharacters.filter((c) => c.id !== this.currentCharacterId);

            for (const character of targets) {
                if (character.id === this.currentCharacterId) continue;
                const characterKey = `${this.storageKey}_${character.id}`;
                await storage.setJSON(characterKey, settings, this.storageArea, true);
                syncedCount++;
            }

            return syncedCount;
        }

        /**
         * Get a single setting value
         * @param {string} settingId - Setting ID
         * @param {*} defaultValue - Default value if not found
         * @returns {Promise<*>} Setting value
         */
        async getSetting(settingId, defaultValue = null) {
            const settings = await this.loadSettings();
            const setting = settings[settingId];

            if (!setting) {
                return defaultValue;
            }

            // Return boolean for checkbox settings
            if (isBooleanType(setting.type)) {
                return setting.isTrue ?? defaultValue;
            }

            // Return value for other settings
            return setting.value ?? defaultValue;
        }

        /**
         * Set a single setting value
         * @param {string} settingId - Setting ID
         * @param {*} value - New value
         * @returns {Promise<void>}
         */
        async setSetting(settingId, value) {
            const settings = await this.loadSettings();

            if (!settings[settingId]) {
                console.warn(`Setting '${settingId}' not found`);
                return;
            }

            // Update value
            if (isBooleanType(settings[settingId].type)) {
                settings[settingId].isTrue = value;
            } else {
                settings[settingId].value = value;
            }

            await this.saveSettings(settings);
        }

        /**
         * Reset all settings to defaults
         * @returns {Promise<void>}
         */
        async resetToDefaults() {
            // Clear per-character settings so loadSettings() returns defaults
            const characterKey = this.getCharacterStorageKey();
            await storage.delete(characterKey, this.storageArea);
        }

        /**
         * Export all settings as JSON (full dump of settings store)
         * Includes global keys and current character's keys.
         * Excludes transient cache data.
         * @returns {Promise<string>} JSON string
         */
        async exportSettings() {
            const allData = await storage.getAll(this.storageArea);

            // Exclude transient cache keys
            const EXCLUDE_PREFIXES = ['marketplace_cache'];
            const exported = {};

            for (const [key, value] of Object.entries(allData)) {
                if (EXCLUDE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
                exported[key] = value;
            }

            return JSON.stringify(exported, null, 2);
        }

        /**
         * Import settings from JSON
         * Only imports global keys and keys matching the current character ID.
         * Character-specific keys for other characters are skipped.
         * @param {string} jsonString - JSON string
         * @returns {Promise<{imported: number, skipped: number}>} Import result
         */
        async importSettings(jsonString) {
            try {
                const data = JSON.parse(jsonString);
                const currentCharId = this.currentCharacterId;
                let imported = 0;
                let skipped = 0;

                const knownCharacters = new Set((await this.getKnownCharacters()).map((character) => character.id));
                if (data[this.knownCharactersKey]) {
                    for (const character of this._normalizeKnownCharacters(data[this.knownCharactersKey])) {
                        knownCharacters.add(character.id);
                    }
                }

                for (const [key, value] of Object.entries(data)) {
                    const charIdMatch =
                        key.match(/_([0-9a-f]{24})$/i) ||
                        key.match(/_(\d{10,})$/) ||
                        this._matchKnownCharacterSuffix(key, knownCharacters);

                    if (charIdMatch) {
                        const keyCharId = charIdMatch[1];
                        if (currentCharId && keyCharId !== String(currentCharId)) {
                            skipped++;
                            continue;
                        }
                    }

                    await storage.setJSON(key, value, this.storageArea, true);
                    imported++;
                }

                return { imported, skipped };
            } catch (error) {
                console.error('[Settings Storage] Import failed:', error);
                return null;
            }
        }

        /**
         * Check if a key ends with a known character ID suffix
         * @param {string} key - Storage key
         * @param {Set<string>} knownIds - Set of known character ID strings
         * @returns {Array|null} Match array with captured ID at index 1, or null
         * @private
         */
        _matchKnownCharacterSuffix(key, knownIds) {
            const lastUnderscore = key.lastIndexOf('_');
            if (lastUnderscore === -1) return null;
            const suffix = key.substring(lastUnderscore + 1);
            if (knownIds.has(suffix)) {
                return [key, suffix];
            }
            return null;
        }
    }

    const settingsStorage = new SettingsStorage();

    /**
     * Profile Cache Module
     * Stores current profile in memory for Steam users
     */

    // Module-level variable to hold current profile in memory
    let currentProfileCache = null;

    /**
     * Set current profile in memory
     * @param {Object} profileData - Profile data from profile_shared message
     */
    function setCurrentProfile(profileData) {
        currentProfileCache = profileData;
    }

    /**
     * Get current profile from memory
     * @returns {Object|null} Current profile or null
     */
    function getCurrentProfile() {
        return currentProfileCache;
    }

    /**
     * Clear current profile from memory
     */
    function clearCurrentProfile() {
        currentProfileCache = null;
    }

    /**
     * WebSocket Hook Module
     * Intercepts WebSocket messages from the MWI game server
     *
     * Uses WebSocket constructor wrapper for better performance than MessageEvent.prototype.data hooking
     */


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
            this.recentActionCompleted = new Map(); // message content -> timestamp (50ms TTL dedup)
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

                const message = originalGet.call(this);

                hookInstance.markMessageEventProcessed(this);
                hookInstance.processMessage(message);

                return message;
            };

            Object.defineProperty(pageMessageEvent.prototype, 'data', dataProperty);

            this.isHooked = true;
        }

        /**
         * Check if a WebSocket instance belongs to the game server
         * @param {WebSocket} socket - WebSocket instance
         * @returns {boolean} True if game socket
         */
        isGameSocket(socket) {
            if (!socket || !socket.url) {
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
                if (this.isMessageEventProcessed(event)) {
                    return;
                }

                if (!event || typeof event.data !== 'string') {
                    return;
                }

                this.markMessageEventProcessed(event);
                this.processMessage(event.data);
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

            // Skip deduplication for events where consecutive messages have similar first 100 chars
            // but contain different data (counts, timestamps, etc. beyond the 100-char hash window)
            // OR events that should always trigger UI updates (profile_shared, battle_unit_fetched)
            const skipDedup =
                messageType === 'quests_updated' ||
                messageType === 'action_completed' ||
                messageType === 'actions_updated' ||
                messageType === 'items_updated' ||
                messageType === 'market_item_order_books_updated' ||
                messageType === 'market_listings_updated' ||
                messageType === 'profile_shared' ||
                messageType === 'battle_consumable_ability_updated' ||
                // Equipping and unequipping the same ability produce messages whose
                // first 100 characters are identical — type, character id and the
                // opening ability hrid fill the window, and the slotNumber that says
                // which way it went sits past it. Hashing them would drop the second
                // and leave the equipped kit stuck on the first.
                messageType === 'abilities_updated' ||
                messageType === 'battle_unit_fetched' ||
                // Consecutive combat ticks can open with identical text — same type,
                // same battle, same unit ids — and differ only in hitpoints further
                // in, so the 100-char hash would drop the update that matters
                messageType === 'battle_updated' ||
                // The guild trial's spectator stream, and the worst hash collision
                // of the lot: every tick opens `{"type":"guild_battle_updated",
                // "battleId":1,"tier":2,"pMap":{"1":{"cHP":…` — type, battle and
                // tier fill the window on their own, so consecutive ticks are
                // identical for far more than a hundred characters and only the
                // health past it differs. Hashed, a whole trial collapses to one tick
                messageType === 'guild_battle_updated' ||
                // The rest of the guild-trial family, for the same reason and worse.
                // `guild_skilling_updated` opens `{"type":"guild_skilling_updated",
                // "trialHrid":"/guild_skilling/crafting","tier":10,"currentProgress":`
                // — a hundred characters exactly, so every tick of an hour's
                // skilling trial hashes identically and only `actionCounter`, right
                // at the end, ever changes. The lifecycle four are short enough to
                // fit inside the window whole, so a second trial of the same skill
                // would silently drop its own start or end
                messageType === 'guild_skilling_updated' ||
                messageType === 'new_guild_battle' ||
                messageType === 'new_guild_skilling' ||
                messageType === 'end_guild_battle' ||
                messageType === 'end_guild_skilling' ||
                messageType === 'action_type_consumable_slots_updated' ||
                messageType === 'consumable_buffs_updated' ||
                // Two donations to the same buff in a row produce messages whose
                // first 100 characters are identical — type, buff id and hrid fill
                // the window, and the changed expireTime/level sit past it — so the
                // content hash would drop the extension and expiry alerts would
                // fire against a stale clock
                messageType === 'community_buffs_updated' ||
                messageType === 'character_info_updated' ||
                messageType === 'labyrinth_updated' ||
                messageType === 'loadouts_updated' ||
                messageType === 'setting_updated' ||
                messageType === 'labyrinth_room_progress' ||
                // Opening the same chest twice in a row produces two messages whose
                // first 100 characters are identical — same type, same chest, same
                // count — so the content hash would drop the second and the treasure
                // ledger would undercount every repeat opening
                messageType === 'loot_opened' ||
                messageType === 'leaderboard_updated';

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
                // Use a short 50ms TTL keyed on full message content to collapse these duplicates.
                // Two genuine consecutive messages of either type are far enough apart that a
                // byte-identical repeat inside 50ms is a duplicate rather than a second event.
                const now = Date.now();
                if (this.recentActionCompleted.has(message)) {
                    return; // Duplicate from second listener — skip
                }
                this.recentActionCompleted.set(message, now);
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
            webSocketHook.onSocketEvent('open', () => {
                this.setReconnecting('socket_open', { allowConnected: true });
            });

            webSocketHook.onSocketEvent('close', (event) => {
                this.setDisconnected('socket_close', event);
            });

            webSocketHook.onSocketEvent('error', (event) => {
                this.setDisconnected('socket_error', event);
            });

            webSocketHook.on('init_character_data', () => {
                this.setConnected('init_character_data');
            });
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

    /**
     * Character ability reconciliation.
     *
     * The equipped kit is not something the client is ever handed whole after login.
     * `init_character_data` carries `combatUnit.combatAbilities` once, and from then
     * on the server sends deltas: `abilities_updated` with an `endCharacterAbilities`
     * array where `slotNumber > 0` means "this ability now sits in that slot" and
     * `slotNumber <= 0` means "this ability is no longer equipped". Only the rows
     * that changed are sent, so the update has to be applied against the current
     * list rather than replacing it.
     *
     * Two things make a naive merge wrong, and both are what leaves a stale kit on
     * screen after the labyrinth (which swaps loadouts between rooms):
     *
     * - An unequip is a row, not an absence. Dropping rows whose `slotNumber` is 0
     *   instead of removing the matching ability leaves the old ability equipped.
     * - A slot holds one ability. When a new ability claims a slot, whatever was in
     *   that slot has to leave even if the server did not bother to say so.
     *
     * The helpers are pure so the message sequence can be replayed in a test.
     */

    /**
     * The learned-ability list with an update applied.
     *
     * This is the list that carries experience, so entries are merged field by field
     * rather than replaced — an update that only reports a level must not erase the
     * experience already known for that ability.
     *
     * @param {Array<Object>} owned - Current `characterAbilities` (not mutated)
     * @param {Array<Object>} updates - `endCharacterAbilities` from the message
     * @returns {Array<Object>} New list
     */
    function mergeOwnedAbilities(owned, updates) {
        const next = (Array.isArray(owned) ? owned : []).map((entry) => ({ ...entry }));
        if (!Array.isArray(updates)) return next;

        for (const update of updates) {
            const hrid = update?.abilityHrid;
            if (!hrid) continue;

            const index = next.findIndex((entry) => entry?.abilityHrid === hrid);
            if (index !== -1) {
                next[index] = { ...next[index], ...update };
            } else {
                next.push({ ...update });
            }
        }

        return next;
    }

    /**
     * The equipped kit with an `endCharacterAbilities` delta applied.
     *
     * An update with no `slotNumber` at all is treated as progress on an ability
     * that is already equipped, never as an equip: `action_completed` reports
     * experience the same way and appending those rows would fill the kit with
     * abilities the character is not actually using.
     *
     * Ordering is left alone unless every surviving entry carries a slot number, in
     * which case the array is sorted by it. The initial list from
     * `init_character_data` may not number its slots, and inventing numbers for it
     * would risk colliding with the server's own numbering — so entries already
     * present keep their position and new ones are appended.
     *
     * @param {Array<Object>} current - Current `combatUnit.combatAbilities` (not mutated)
     * @param {Array<Object>} updates - `endCharacterAbilities` from the message
     * @returns {Array<Object>} New equipped list
     */
    function reconcileEquippedAbilities(current, updates) {
        let next = (Array.isArray(current) ? current : [])
            .filter((entry) => entry?.abilityHrid)
            .map((entry) => ({ ...entry }));

        if (!Array.isArray(updates)) return next;

        for (const update of updates) {
            const hrid = update?.abilityHrid;
            if (!hrid) continue;

            const slot = Number(update.slotNumber);
            const hasSlot = Number.isFinite(slot);
            const index = next.findIndex((entry) => entry.abilityHrid === hrid);

            // An explicit non-positive slot is an unequip, and is the only thing
            // that ever removes an ability from the kit
            if (hasSlot && !(slot > 0)) {
                if (index !== -1) next.splice(index, 1);
                continue;
            }

            if (index !== -1) {
                next[index] = { ...next[index], ...update };
            } else if (hasSlot && slot > 0) {
                next.push({ ...update });
            } else {
                // Progress on an ability that is not equipped — nothing to do here
                continue;
            }

            // One ability per slot: whatever else claimed this one has been displaced
            if (hasSlot && slot > 0) {
                next = next.filter((entry) => entry.abilityHrid === hrid || Number(entry.slotNumber) !== slot);
            }
        }

        const allSlotted = next.every((entry) => Number(entry.slotNumber) > 0);
        if (allSlotted) {
            next.sort((a, b) => Number(a.slotNumber) - Number(b.slotNumber));
        }

        return next;
    }

    /**
     * Level and experience applied to a kit without touching which abilities are in it.
     *
     * `action_completed` reports ability experience during a fight. Those rows are
     * progress only — running them through the slot reconciler would let an
     * experience tick reshuffle the kit.
     *
     * @param {Array<Object>} current - Current equipped list (not mutated)
     * @param {Array<Object>} updates - `endCharacterAbilities` from the message
     * @returns {Array<Object>} New equipped list, same abilities in the same order
     */
    function applyAbilityProgress(current, updates) {
        const next = (Array.isArray(current) ? current : []).map((entry) => ({ ...entry }));
        if (!Array.isArray(updates)) return next;

        for (const update of updates) {
            const hrid = update?.abilityHrid;
            if (!hrid) continue;

            const index = next.findIndex((entry) => entry?.abilityHrid === hrid);
            if (index === -1) continue;

            if (update.level !== undefined) next[index].level = update.level;
            if (update.experience !== undefined) next[index].experience = update.experience;
        }

        return next;
    }

    /**
     * The kit the server says it is fighting with, from a `new_battle` message.
     *
     * This is the one place the equipped list arrives whole rather than as a delta,
     * which makes it the backstop for any ability change that reached the client
     * through a message shape nothing here recognises.
     *
     * @param {Object} battle - `new_battle` message
     * @param {Object} [identity]
     * @param {string|number} [identity.characterId] - Own character id
     * @param {string} [identity.characterName] - Own character name
     * @returns {Array<Object>|null} Equipped abilities, or null when the message is not about us
     */
    function equippedAbilitiesFromBattle(battle, { characterId, characterName } = {}) {
        const players = Array.isArray(battle?.players) ? battle.players : [];
        if (players.length === 0) return null;

        const me = players.find(
            (player) =>
                (characterId !== null && characterId !== undefined && player?.character?.id === characterId) ||
                (characterName && player?.character?.name === characterName)
        );

        const abilities = me?.combatDetails?.combatAbilities;
        if (!Array.isArray(abilities)) return null;

        return abilities.filter((entry) => entry?.abilityHrid).map((entry) => ({ ...entry }));
    }

    /**
     * Whether two equipped kits differ in anything worth telling a listener about.
     * @param {Array<Object>} a - One kit
     * @param {Array<Object>} b - The other
     * @returns {boolean} True when the abilities or their levels differ
     */
    function abilityKitsDiffer(a, b) {
        const signature = (list) =>
            (Array.isArray(list) ? list : [])
                .map((entry) => `${entry?.abilityHrid}@${entry?.level ?? 0}`)
                .sort()
                .join('|');
        return signature(a) !== signature(b);
    }

    /**
     * Guild shrine levels, kept past the message that carried them.
     *
     * Two maps decide what the combat sim can say about a shrine upgrade:
     *
     * - `characterGuildBuffMap` — the levels *this character* has bought in each
     *   guild buff, which is the "current level" every upgrade row steps from.
     * - `guildBuildingLevelMap` — the levels *the guild* has built each shrine to,
     *   which caps how far members are allowed to buy.
     *
     * Neither is reliably present at login. They ride along on guild traffic, which
     * for most sessions means they arrive only once the guild panel has been opened
     * — and never at all for a player who does not open it. Without them the upgrade
     * advisor cannot tell "the shrine is not built" from "nobody told us", so it
     * says so instead of guessing, and every shrine row reads as unknown.
     *
     * So whatever does arrive is written down, keyed per character, with the time it
     * was captured. On the next login the levels are hydrated from that record until
     * a live message replaces them, and `capturedAt` lets a caller say how old the
     * reading is rather than presenting it as current.
     *
     * The message type is deliberately not part of this: the maps are matched by
     * shape wherever they appear, because which message carries them has changed
     * before and the cost of looking is two property reads.
     */


    /** Object store the records live in — shared with the guild XP history */
    const STORE_NAME = 'guildHistory';

    /** Key prefix; the character id is appended so alts do not share a reading */
    const KEY_PREFIX = 'guildShrineLevels';

    /**
     * Storage key for a character's shrine record.
     * @param {string|number|null} characterId - Character id, or null before it is known
     * @returns {string} Storage key
     */
    function guildShrineStorageKey(characterId) {
        return `${KEY_PREFIX}_${characterId ?? 'default'}`;
    }

    /**
     * Whether a value is a usable map object (and not an array or null).
     * @param {*} value - Candidate
     * @returns {boolean} True when it can be read as an hrid → entry map
     */
    function isMapObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    /**
     * Count of entries in a map, tolerating anything that is not one.
     * @param {*} value - Candidate map
     * @returns {number} Number of keys, or 0
     */
    function mapSize(value) {
        return isMapObject(value) ? Object.keys(value).length : 0;
    }

    /**
     * Pull guild shrine levels out of a WebSocket message, whatever its type.
     *
     * A map is only reported when the message actually carries that key: an absent
     * `guildBuildingLevelMap` must not be read as "the guild has built nothing", or
     * a message about buff purchases would erase the building levels beside them.
     *
     * @param {Object} message - Parsed WebSocket message
     * @returns {{characterGuildBuffMap: (Object|undefined), guildBuildingLevelMap: (Object|undefined), guildId: (string|number|null)}|null}
     *   The maps present in the message, or null when it carries neither
     */
    function extractGuildShrineData(message) {
        if (!message || typeof message !== 'object') return null;

        // Fast path. This runs against every message on the socket, including the
        // battle ticks that arrive several times a second, so anything that is
        // plainly not guild traffic leaves before a single object is allocated.
        if (
            message.characterGuildBuffMap === undefined &&
            message.guildBuildingLevelMap === undefined &&
            message.guild === undefined &&
            message.characterGuild === undefined &&
            message.guildInfo === undefined
        ) {
            return null;
        }

        // Nested carriers as well as the top level — the same maps have been seen
        // hanging off the guild object rather than beside it
        const sources = [message, message.guild, message.characterGuild, message.guildInfo];

        let characterGuildBuffMap;
        let guildBuildingLevelMap;
        let guildId = null;

        for (const source of sources) {
            if (!isMapObject(source)) continue;

            if (characterGuildBuffMap === undefined && isMapObject(source.characterGuildBuffMap)) {
                characterGuildBuffMap = source.characterGuildBuffMap;
            }
            if (guildBuildingLevelMap === undefined && isMapObject(source.guildBuildingLevelMap)) {
                guildBuildingLevelMap = source.guildBuildingLevelMap;
            }
            if (guildId === null) {
                guildId = source.guildID ?? source.guildId ?? (source === message ? null : source.id) ?? null;
            }
        }

        if (characterGuildBuffMap === undefined && guildBuildingLevelMap === undefined) return null;

        return { characterGuildBuffMap, guildBuildingLevelMap, guildId };
    }

    /**
     * Read a character's persisted shrine record.
     * @param {string|number|null} characterId - Character id
     * @returns {Promise<Object|null>} The record, or null when there is none
     */
    async function loadGuildShrineLevels(characterId) {
        try {
            if (typeof storage?.getJSON !== 'function') return null;
            const record = await storage.getJSON(guildShrineStorageKey(characterId), STORE_NAME, null);
            if (!record || typeof record !== 'object') return null;
            return record;
        } catch (error) {
            console.error('[GuildShrineStore] Failed to load guild shrine levels:', error);
            return null;
        }
    }

    /**
     * Write a character's shrine record.
     *
     * A record with nothing in either map is not written: it would replace a real
     * earlier reading with the absence of one.
     *
     * @param {string|number|null} characterId - Character id
     * @param {Object} record - `{characterGuildBuffMap, guildBuildingLevelMap, guildId, capturedAt}`
     * @returns {Promise<boolean>} True when something was written
     */
    async function saveGuildShrineLevels(characterId, record) {
        try {
            if (typeof storage?.setJSON !== 'function') return false;
            if (mapSize(record?.characterGuildBuffMap) === 0 && mapSize(record?.guildBuildingLevelMap) === 0) {
                return false;
            }

            await storage.setJSON(
                guildShrineStorageKey(characterId),
                {
                    characterGuildBuffMap: record.characterGuildBuffMap || {},
                    guildBuildingLevelMap: record.guildBuildingLevelMap || {},
                    guildId: record.guildId ?? null,
                    capturedAt: record.capturedAt || Date.now(),
                },
                STORE_NAME
            );
            return true;
        } catch (error) {
            console.error('[GuildShrineStore] Failed to save guild shrine levels:', error);
            return false;
        }
    }

    /**
     * Merge market listing updates into the current list.
     * @param {Array} currentListings - Existing market listings.
     * @param {Array} updatedListings - Updated listings from WebSocket.
     * @returns {Array} New merged listings array.
     */
    const mergeMarketListings = (currentListings = [], updatedListings = []) => {
        const safeCurrent = Array.isArray(currentListings) ? currentListings : [];
        const safeUpdates = Array.isArray(updatedListings) ? updatedListings : [];

        if (safeUpdates.length === 0) {
            return [...safeCurrent];
        }

        const indexById = new Map();
        safeCurrent.forEach((listing, index) => {
            if (!listing || listing.id === undefined || listing.id === null) {
                return;
            }
            indexById.set(listing.id, index);
        });

        const merged = [...safeCurrent];

        for (const listing of safeUpdates) {
            if (!listing || listing.id === undefined || listing.id === null) {
                continue;
            }

            const existingIndex = indexById.get(listing.id);
            if (existingIndex !== undefined) {
                merged[existingIndex] = listing;
            } else {
                merged.push(listing);
            }
        }

        // Remove dead listings: cancelled/expired immediately, filled once fully claimed
        return merged.filter((listing) => {
            if (!listing) return false;
            if (
                listing.status === '/market_listing_status/cancelled' ||
                listing.status === '/market_listing_status/expired'
            ) {
                return false;
            }
            if (
                listing.status === '/market_listing_status/filled' &&
                (listing.unclaimedItemCount || 0) === 0 &&
                (listing.unclaimedCoinCount || 0) === 0
            ) {
                return false;
            }
            return true;
        });
    };

    /**
     * Scroll Buff Values
     * Hardcoded buff definitions for Labyrinth scrolls (formerly "Seals").
     * The game JSON has no consumableDetail for scroll items — values sourced from item descriptions.
     */

    const SCROLL_BUFF_VALUES = {
        '/buff_types/efficiency': 0.14,
        '/buff_types/gathering': 0.18,
        '/buff_types/wisdom': 0.2,
        '/buff_types/action_speed': 0.15,
        '/buff_types/rare_find': 0.6,
        '/buff_types/processing': 0.2,
        '/buff_types/gourmet': 0.16,
    };

    /**
     * Data Manager Module
     * Central hub for accessing game data
     *
     * Uses official API: localStorageUtil.getInitClientData()
     * Listens to WebSocket messages for player data updates
     */


    class DataManager {
        constructor() {
            this.webSocketHook = webSocketHook;

            // Static game data (items, actions, monsters, abilities, etc.)
            this.initClientData = null;

            // Player data (updated via WebSocket)
            this.characterData = null;
            this.characterSkills = null;
            this.characterItems = null;
            this.characterActions = [];
            this.characterQuests = []; // Active quests including tasks
            this.characterEquipment = new Map();
            this.characterHouseRooms = new Map(); // House room HRID -> {houseRoomHrid, level}
            this.actionTypeDrinkSlotsMap = new Map(); // Action type HRID -> array of drink items
            this.characterGuildBuffMap = {}; // Guild buff HRID -> {guildBuffHrid, level}
            this.guildBuildingLevelMap = {}; // Building/shrine HRID -> level
            this.guildShrineCapturedAt = null; // When the shrine levels above were read off the wire
            this.guildShrineHydrated = false; // True while those levels come from storage rather than a live message
            this.guildShrineHydration = null; // In-flight hydration, for callers that want to wait
            this.guildShrineGuildId = null; // Guild the persisted shrine levels belong to
            this.monsterSortIndexMap = new Map(); // Monster HRID -> combat zone sortIndex
            this.bossMonsterHrids = new Set(); // Monster HRIDs that appear in bossSpawns
            this.battleData = null; // Current battle data (for Combat Sim export on Steam)

            // Character tracking for switch detection
            this.currentCharacterId = null;
            this.currentCharacterName = null;
            this.currentCharacterGameMode = null;
            this.isCharacterSwitching = false;
            this.lastCharacterSwitchTime = 0; // Prevent rapid-fire switch loops

            // Event listeners
            this.eventListeners = new Map();

            // Achievement buff cache (action type → buff type → flat boost)
            this.achievementBuffCache = {
                source: null,
                byActionType: new Map(),
            };

            // Personal buffs from seals (personal_buffs_updated WebSocket message)
            this.personalActionTypeBuffsMap = {};

            // Per-action-type scroll simulation (Set of buffTypeHrids to simulate)
            this.scrollSimulationByActionType = {};

            // Retry interval for loading static game data
            this.loadRetryInterval = null;
            this.fallbackInterval = null;

            // Setup WebSocket message handlers
            this.setupMessageHandlers();
        }

        /**
         * Initialize the Data Manager
         * Call this after game loads (or immediately - will retry if needed)
         */
        initialize() {
            this.cleanupIntervals();

            // Try to load static game data using official API
            const success = this.tryLoadStaticData();

            // If failed, set up retry polling
            if (!success && !this.loadRetryInterval) {
                this.loadRetryInterval = setInterval(() => {
                    if (this.tryLoadStaticData()) {
                        this.cleanupIntervals();
                    }
                }, 500); // Retry every 500ms
            }

            // FALLBACK: Continuous polling for missed init_character_data (should not be needed with @run-at document-start)
            // Extended timeout for slower connections/computers (Steam, etc.)
            let fallbackAttempts = 0;
            const maxAttempts = 60; // Poll for up to 30 seconds (60 × 500ms)

            const stopFallbackInterval = () => {
                if (this.fallbackInterval) {
                    clearInterval(this.fallbackInterval);
                    this.fallbackInterval = null;
                }
            };

            this.fallbackInterval = setInterval(() => {
                fallbackAttempts++;

                // Stop if character data received via WebSocket
                if (this.characterData) {
                    stopFallbackInterval();
                    return;
                }

                // Give up after max attempts
                if (fallbackAttempts >= maxAttempts) {
                    console.error(
                        '[DataManager] Character data not received after 30 seconds. WebSocket hook may have failed.'
                    );
                    stopFallbackInterval();
                }
            }, 500); // Check every 500ms
        }

        /**
         * Cleanup polling intervals
         */
        cleanupIntervals() {
            if (this.loadRetryInterval) {
                clearInterval(this.loadRetryInterval);
                this.loadRetryInterval = null;
            }

            if (this.fallbackInterval) {
                clearInterval(this.fallbackInterval);
                this.fallbackInterval = null;
            }
        }

        /**
         * Attempt to load static game data
         * @returns {boolean} True if successful, false if needs retry
         * @private
         */
        tryLoadStaticData() {
            try {
                if (typeof localStorageUtil !== 'undefined' && typeof localStorageUtil.getInitClientData === 'function') {
                    const data = localStorageUtil.getInitClientData();
                    if (data && Object.keys(data).length > 0) {
                        this.initClientData = data;

                        // Build monster sort index map for task sorting
                        this.buildMonsterSortIndexMap();

                        return true;
                    }
                }
                return false;
            } catch (error) {
                console.error('[Data Manager] Failed to load init_client_data:', error);
                return false;
            }
        }

        /**
         * Setup WebSocket message handlers
         * Listens for game data updates
         */
        setupMessageHandlers() {
            // Handle init_character_data (player data on login/refresh)
            this.webSocketHook.on('init_character_data', async (data) => {
                // Detect character switch
                const newCharacterId = data.character?.id;
                const newCharacterName = data.character?.name;

                // Validate character data before processing
                if (!newCharacterId || !newCharacterName) {
                    console.error('[DataManager] Invalid character data received:', {
                        hasCharacter: !!data.character,
                        hasId: !!newCharacterId,
                        hasName: !!newCharacterName,
                    });
                    return; // Don't process invalid character data
                }

                // Track whether this is a character switch or first load
                let isCharacterSwitch = false;

                // Check if this is a character switch (not first load)
                if (this.currentCharacterId && this.currentCharacterId !== newCharacterId) {
                    isCharacterSwitch = true;
                    // Prevent rapid-fire character switches (loop protection)
                    const now = Date.now();
                    if (this.lastCharacterSwitchTime && now - this.lastCharacterSwitchTime < 1000) {
                        console.warn('[Toolasha] Ignoring rapid character switch (<1s since last), possible loop detected');
                        return;
                    }
                    this.lastCharacterSwitchTime = now;

                    // Flush all pending storage writes before cleanup (non-blocking)
                    // Use setTimeout to prevent main thread blocking during character switch
                    setTimeout(async () => {
                        try {
                            if (storage && typeof storage.flushAll === 'function') {
                                await storage.flushAll();
                            }
                        } catch (error) {
                            console.error('[Toolasha] Failed to flush storage before character switch:', error);
                        }
                    }, 0);

                    // Set switching flag to block feature initialization
                    this.isCharacterSwitching = true;

                    // Emit character_switching event (cleanup phase)
                    this.emit('character_switching', {
                        oldId: this.currentCharacterId,
                        newId: newCharacterId,
                        oldName: this.currentCharacterName,
                        newName: newCharacterName,
                    });

                    // Update character tracking
                    this.currentCharacterId = newCharacterId;
                    this.currentCharacterName = newCharacterName;
                    this.currentCharacterGameMode = data.character?.gameMode || null;

                    // Clear old character data
                    this.characterData = null;
                    this.characterSkills = null;
                    this.characterItems = null;
                    this.characterActions = [];
                    this.characterQuests = [];
                    this.characterEquipment.clear();
                    this.characterHouseRooms.clear();
                    this.actionTypeDrinkSlotsMap.clear();
                    this.personalActionTypeBuffsMap = {};
                    this.characterGuildBuffMap = {};
                    this.guildBuildingLevelMap = {};
                    this.guildShrineCapturedAt = null;
                    this.guildShrineHydrated = false;
                    this.guildShrineHydration = null;
                    this.guildShrineGuildId = null;
                    this.battleData = null;

                    // Reset switching flag (cleanup complete, ready for re-init)
                    this.isCharacterSwitching = false;

                    // Emit character_switched event (ready for re-init)
                    this.emit('character_switched', {
                        newId: newCharacterId,
                        newName: newCharacterName,
                    });
                } else if (!this.currentCharacterId) {
                    // First load - set character tracking
                    this.currentCharacterId = newCharacterId;
                    this.currentCharacterName = newCharacterName;
                    this.currentCharacterGameMode = data.character?.gameMode || null;
                }

                // Process new character data normally
                this.characterData = data;
                this.characterSkills = data.characterSkills;
                this.characterItems = data.characterItems;
                this.characterActions = [...data.characterActions];
                this.characterQuests = data.characterQuests || [];

                // Build equipment map
                this.updateEquipmentMap(data.characterItems);

                // Build house room map
                this.updateHouseRoomMap(data.characterHouseRoomMap);

                // Build drink slots map (tea buffs)
                this.updateDrinkSlotsMap(data.actionTypeDrinkSlotsMap);

                // Load personal buffs (seal buffs from Labyrinth, may be present on login)
                if (data.personalActionTypeBuffsMap) {
                    this.personalActionTypeBuffsMap = data.personalActionTypeBuffsMap;
                }

                // Load guild buff levels and shrine/building levels
                this.characterGuildBuffMap = data.characterGuildBuffMap || {};
                this.guildBuildingLevelMap = data.guildBuildingLevelMap || {};
                if (mapSize(this.characterGuildBuffMap) > 0 || mapSize(this.guildBuildingLevelMap) > 0) {
                    this.guildShrineCapturedAt = Date.now();
                    this.guildShrineHydrated = false;
                }

                // Login usually carries no shrine levels at all — they ride on guild
                // traffic that may never arrive this session. Fill the gap from the
                // last reading so the upgrade advisor has something to answer with;
                // a live message later overwrites it. Not awaited, so a slow
                // IndexedDB cannot hold up feature initialization.
                this.guildShrineHydration = this.hydrateGuildShrineLevels();

                // Clear switching flag
                this.isCharacterSwitching = false;

                // Emit character_initialized event (trigger feature initialization)
                // Include flag to indicate if this is a character switch vs first load
                // IMPORTANT: Mutate data object instead of spreading to avoid copying MB of data
                data._isCharacterSwitch = isCharacterSwitch;
                this.emit('character_initialized', data);
                connectionState.handleCharacterInitialized(data);
            });

            // Handle actions_updated (action queue changes)
            this.webSocketHook.on('actions_updated', (data) => {
                // Update action list
                for (const action of data.endCharacterActions) {
                    // Always remove the old entry first to prevent duplicates —
                    // endCharacterActions can contain existing actions alongside new ones.
                    this.characterActions = this.characterActions.filter((a) => a.id !== action.id);
                    if (action.isDone === false) {
                        this.characterActions.push(action);
                    }
                }

                this.emit('actions_updated', data);
            });

            // Handle action_completed (action progress)
            this.webSocketHook.on('action_completed', (data) => {
                const action = data.endCharacterAction;
                if (action.isDone === false) {
                    for (let i = 0; i < this.characterActions.length; i++) {
                        if (this.characterActions[i].id === action.id) {
                            // Replace the entire cached action with fresh data from the server
                            // This keeps primaryItemHash, enhancingMaxLevel, etc. up to date
                            this.characterActions[i] = action;
                            break;
                        }
                    }
                }

                // CRITICAL: Update inventory from action_completed (this is how inventory updates during gathering!)
                if (data.endCharacterItems && Array.isArray(data.endCharacterItems) && this.characterItems) {
                    for (const endItem of data.endCharacterItems) {
                        // Only update inventory items
                        if (endItem.itemLocationHrid !== '/item_locations/inventory') {
                            continue;
                        }

                        // Find and update the item in inventory
                        const index = this.characterItems.findIndex((invItem) => invItem.id === endItem.id);
                        if (index !== -1) {
                            // Update existing item
                            this.characterItems[index].count = endItem.count;
                        } else {
                            // Add new item to inventory
                            this.characterItems.push(endItem);
                        }
                    }

                    // Notify items_updated listeners (e.g. networth) of the inventory change
                    this.emit('items_updated', data);
                }

                // CRITICAL: Update skill experience from action_completed (this is how XP updates in real-time!)
                if (data.endCharacterSkills && Array.isArray(data.endCharacterSkills) && this.characterSkills) {
                    for (const updatedSkill of data.endCharacterSkills) {
                        const skill = this.characterSkills.find((s) => s.skillHrid === updatedSkill.skillHrid);
                        if (skill) {
                            // Update experience (and level if it changed)
                            skill.experience = updatedSkill.experience;
                            if (updatedSkill.level !== undefined) {
                                skill.level = updatedSkill.level;
                            }
                        }
                    }
                }

                // Ability experience ticks during a fight. Progress only — the kit
                // itself is never reshuffled from here (see character-abilities.js)
                if (Array.isArray(data.endCharacterAbilities) && this.characterData) {
                    this.characterData.characterAbilities = mergeOwnedAbilities(
                        this.characterData.characterAbilities,
                        data.endCharacterAbilities
                    );
                    if (this.characterData.combatUnit) {
                        this.characterData.combatUnit.combatAbilities = applyAbilityProgress(
                            this.characterData.combatUnit.combatAbilities,
                            data.endCharacterAbilities
                        );
                    }
                }

                this.emit('action_completed', data);
            });

            // Handle abilities_updated (equip, unequip, level up)
            //
            // Nothing applied these before, so `combatUnit.combatAbilities` was
            // frozen at whatever login reported and every ability change since was
            // invisible to the combat sim. That is most visible around the
            // labyrinth, which equips a loadout per room and restores on exit:
            // equipment tracked those swaps because items_updated was handled, and
            // abilities did not because this message was not.
            this.webSocketHook.on('abilities_updated', (data) => {
                if (this.applyAbilityUpdates(data.endCharacterAbilities)) {
                    this.emit('abilities_updated', data);
                }
            });

            // Handle items_updated (inventory/equipment changes)
            this.webSocketHook.on('items_updated', (data) => {
                if (data.endCharacterItems) {
                    if (!this.characterItems) {
                        this.emit('items_updated', data);
                        return;
                    }
                    // Update inventory items in-place (endCharacterItems contains only changed items, not full inventory)
                    for (const item of data.endCharacterItems) {
                        const index = this.characterItems.findIndex((invItem) => invItem.id === item.id);
                        if (index !== -1) {
                            if (item.count === 0) {
                                // count 0 means removed from this location (e.g. equipped from inventory)
                                this.characterItems.splice(index, 1);
                            } else {
                                // Update existing item (count and location may have changed, e.g. unequip)
                                this.characterItems[index] = { ...this.characterItems[index], ...item };
                            }
                        } else if (item.count > 0) {
                            // New item in inventory or equipment slot
                            this.characterItems.push(item);
                        }
                    }

                    this.updateEquipmentMap(data.endCharacterItems);
                }

                this.emit('items_updated', data);
            });

            // Handle market_listings_updated (market order changes)
            this.webSocketHook.on('market_listings_updated', (data) => {
                if (!this.characterData || !Array.isArray(data?.endMarketListings)) {
                    return;
                }

                const currentListings = Array.isArray(this.characterData.myMarketListings)
                    ? this.characterData.myMarketListings
                    : [];
                const updatedListings = mergeMarketListings(currentListings, data.endMarketListings);

                this.characterData = {
                    ...this.characterData,
                    myMarketListings: updatedListings,
                };

                this.emit('market_listings_updated', {
                    ...data,
                    myMarketListings: updatedListings,
                });
            });

            // Handle market_item_order_books_updated (order book updates)
            this.webSocketHook.on('market_item_order_books_updated', (data) => {
                this.emit('market_item_order_books_updated', data);
            });

            // Handle action_type_consumable_slots_updated (when user changes tea assignments)
            this.webSocketHook.on('action_type_consumable_slots_updated', (data) => {
                // Update drink slots map with new consumables
                if (data.actionTypeDrinkSlotsMap) {
                    this.updateDrinkSlotsMap(data.actionTypeDrinkSlotsMap);
                }

                this.emit('consumables_updated', data);
            });

            // Handle consumable_buffs_updated (when buffs expire/refresh)
            this.webSocketHook.on('consumable_buffs_updated', (data) => {
                // Buffs updated - next hover will show updated values
                this.emit('buffs_updated', data);
            });

            // Handle community_buffs_updated (anyone donating changes levels and
            // expiry). Without this, every community buff level reads as it was at
            // login — the tea optimizer, efficiency and profit calculators all go
            // quietly stale as the server buff moves.
            this.webSocketHook.on('community_buffs_updated', (data) => {
                if (this.characterData && Array.isArray(data.communityBuffs)) {
                    this.characterData.communityBuffs = data.communityBuffs;
                }
                this.emit('community_buffs_updated', data);
            });

            // Handle personal_buffs_updated (seal buffs from Labyrinth)
            this.webSocketHook.on('personal_buffs_updated', (data) => {
                if (data.personalActionTypeBuffsMap) {
                    this.personalActionTypeBuffsMap = data.personalActionTypeBuffsMap;
                }
                this.emit('personal_buffs_updated', data);
            });

            // Handle house_rooms_updated (when user upgrades house rooms)
            this.webSocketHook.on('house_rooms_updated', (data) => {
                // Update house room map with new levels
                if (data.characterHouseRoomMap) {
                    this.updateHouseRoomMap(data.characterHouseRoomMap);
                }

                this.emit('house_rooms_updated', data);
            });

            // Handle skills_updated (when user gains skill levels)
            this.webSocketHook.on('skills_updated', (data) => {
                // Update character skills with new levels
                if (data.characterSkills) {
                    this.characterSkills = data.characterSkills;
                }

                this.emit('skills_updated', data);
            });

            // Handle new_battle (combat start - for Combat Sim export on Steam)
            this.webSocketHook.on('new_battle', (data) => {
                // Store battle data (includes party consumables)
                this.battleData = data;

                // The only message that carries the equipped kit whole rather than
                // as a delta, so it is the backstop: whatever the labyrinth did to
                // the loadout, the first battle after it settles the question.
                const fromBattle = equippedAbilitiesFromBattle(data, {
                    characterId: this.currentCharacterId,
                    characterName: this.currentCharacterName,
                });
                if (fromBattle && fromBattle.length > 0) {
                    const previous = this.characterData?.combatUnit?.combatAbilities;
                    if (this.setEquippedAbilities(fromBattle) && abilityKitsDiffer(previous, fromBattle)) {
                        this.emit('abilities_updated', {
                            endCharacterAbilities: fromBattle,
                            source: 'new_battle',
                        });
                    }
                }
            });

            // Guild shrine levels arrive on whichever message the server attaches
            // them to, and usually only once the guild panel has been opened. They
            // are matched by shape rather than by message type so a rename upstream
            // cannot quietly stop the capture — the check is two property reads.
            this.webSocketHook.on('*', (data) => {
                this.captureGuildShrineData(data);
            });

            // Handle character_info_updated (task slot changes, cooldown timestamps, etc.)
            this.webSocketHook.on('character_info_updated', (data) => {
                if (this.characterData && data.characterInfo) {
                    this.characterData.characterInfo = data.characterInfo;
                }
                this.emit('character_info_updated', data);
            });

            // Handle setting_updated (labyrinth skip thresholds, crate selection, etc.)
            this.webSocketHook.on('setting_updated', (data) => {
                if (this.characterData && data.characterSetting) {
                    this.characterData.characterSetting = data.characterSetting;
                }
                this.emit('setting_updated', data);
            });

            // Handle quests_updated (keep characterQuests in sync mid-session)
            this.webSocketHook.on('quests_updated', (data) => {
                if (data.endCharacterQuests && Array.isArray(data.endCharacterQuests)) {
                    for (const updatedQuest of data.endCharacterQuests) {
                        const index = this.characterQuests.findIndex((q) => q.id === updatedQuest.id);
                        if (index !== -1) {
                            this.characterQuests[index] = updatedQuest;
                        } else {
                            this.characterQuests.push(updatedQuest);
                        }
                    }
                    // Remove claimed quests
                    this.characterQuests = this.characterQuests.filter((q) => q.status !== '/quest_status/claimed');
                }
            });
        }

        /**
         * Update equipment map from character items
         * @param {Array} items - Character items array
         */
        updateEquipmentMap(items) {
            for (const item of items) {
                if (item.itemLocationHrid !== '/item_locations/inventory') {
                    if (item.count === 0) {
                        this.characterEquipment.delete(item.itemLocationHrid);
                    } else {
                        this.characterEquipment.set(item.itemLocationHrid, item);
                    }
                }
            }
        }

        /**
         * Update house room map from character house room data
         * @param {Object} houseRoomMap - Character house room map
         */
        updateHouseRoomMap(houseRoomMap) {
            if (!houseRoomMap) {
                return;
            }

            this.characterHouseRooms.clear();
            for (const [_hrid, room] of Object.entries(houseRoomMap)) {
                this.characterHouseRooms.set(room.houseRoomHrid, room);
            }
        }

        /**
         * Update drink slots map from character data
         * @param {Object} drinkSlotsMap - Action type drink slots map
         */
        updateDrinkSlotsMap(drinkSlotsMap) {
            if (!drinkSlotsMap) {
                return;
            }

            this.actionTypeDrinkSlotsMap.clear();
            for (const [actionTypeHrid, drinks] of Object.entries(drinkSlotsMap)) {
                this.actionTypeDrinkSlotsMap.set(actionTypeHrid, drinks || []);
            }
        }

        /**
         * Apply an `endCharacterAbilities` delta to both ability views.
         *
         * The learned list (`characterAbilities`, which carries experience) and the
         * equipped kit (`combatUnit.combatAbilities`) are updated from the same
         * message, because a level-up and an equip arrive in the same shape and a
         * reader of one must not see a state the other has moved past.
         *
         * @param {Array<Object>} updates - `endCharacterAbilities` from the message
         * @returns {boolean} True when something was applied
         */
        applyAbilityUpdates(updates) {
            if (!this.characterData || !Array.isArray(updates) || updates.length === 0) return false;

            this.characterData.characterAbilities = mergeOwnedAbilities(this.characterData.characterAbilities, updates);

            if (!this.characterData.combatUnit) {
                this.characterData.combatUnit = {};
            }
            this.characterData.combatUnit.combatAbilities = reconcileEquippedAbilities(
                this.characterData.combatUnit.combatAbilities,
                updates
            );

            return true;
        }

        /**
         * Replace the equipped kit outright with a list the server sent whole.
         * @param {Array<Object>} abilities - Equipped abilities, in slot order
         * @returns {boolean} True when the kit was replaced
         */
        setEquippedAbilities(abilities) {
            if (!this.characterData || !Array.isArray(abilities)) return false;

            if (!this.characterData.combatUnit) {
                this.characterData.combatUnit = {};
            }
            this.characterData.combatUnit.combatAbilities = abilities.map((entry) => ({ ...entry }));
            this.characterData.characterAbilities = mergeOwnedAbilities(this.characterData.characterAbilities, abilities);

            return true;
        }

        /**
         * The abilities currently equipped, in slot order.
         *
         * This is the authoritative read for anything that asks "what is this
         * character fighting with" — it reflects every ability message applied since
         * login, not just the state login reported.
         *
         * @returns {Array<Object>} Copies of the equipped ability entries
         */
        getEquippedAbilities() {
            const equipped = this.characterData?.combatUnit?.combatAbilities;
            return Array.isArray(equipped) ? equipped.map((entry) => ({ ...entry })) : [];
        }

        /**
         * Every ability the character has learned, with level and experience.
         * @returns {Array<Object>} Copies of the learned ability entries
         */
        getLearnedAbilities() {
            const owned = this.characterData?.characterAbilities;
            return Array.isArray(owned) ? owned.map((entry) => ({ ...entry })) : [];
        }

        /**
         * Take guild shrine levels off any message that happens to carry them.
         * @param {Object} data - Parsed WebSocket message
         * @returns {boolean} True when live state changed
         */
        captureGuildShrineData(data) {
            const captured = extractGuildShrineData(data);
            if (!captured) return false;

            let changed = false;
            if (captured.characterGuildBuffMap !== undefined) {
                this.characterGuildBuffMap = captured.characterGuildBuffMap;
                changed = true;
            }
            if (captured.guildBuildingLevelMap !== undefined) {
                this.guildBuildingLevelMap = captured.guildBuildingLevelMap;
                changed = true;
            }
            if (!changed) return false;

            this.guildShrineCapturedAt = Date.now();
            this.guildShrineHydrated = false;
            this.guildShrineGuildId = captured.guildId ?? this.guildShrineGuildId ?? null;
            this.persistGuildShrineLevels();
            this.emit('guild_shrine_levels_updated', {
                capturedAt: this.guildShrineCapturedAt,
                fromStorage: false,
            });

            return true;
        }

        /**
         * Write the current shrine levels down so the next session starts with them.
         * @returns {Promise<boolean>} True when a record was written
         */
        async persistGuildShrineLevels() {
            return saveGuildShrineLevels(this.currentCharacterId, {
                characterGuildBuffMap: this.characterGuildBuffMap,
                guildBuildingLevelMap: this.guildBuildingLevelMap,
                guildId: this.guildShrineGuildId ?? null,
                capturedAt: this.guildShrineCapturedAt || Date.now(),
            });
        }

        /**
         * Fill empty shrine levels from the last persisted reading.
         *
         * Only the maps that are still empty are filled, and only if a live message
         * has not landed while the read was in flight — a stale reading is worth
         * having when there is nothing, and worth nothing when there is something.
         *
         * @returns {Promise<boolean>} True when anything was hydrated
         */
        async hydrateGuildShrineLevels() {
            try {
                if (mapSize(this.characterGuildBuffMap) > 0 && mapSize(this.guildBuildingLevelMap) > 0) {
                    return false;
                }

                const record = await loadGuildShrineLevels(this.currentCharacterId);
                if (!record) return false;

                let filled = false;
                if (mapSize(this.characterGuildBuffMap) === 0 && mapSize(record.characterGuildBuffMap) > 0) {
                    this.characterGuildBuffMap = record.characterGuildBuffMap;
                    filled = true;
                }
                if (mapSize(this.guildBuildingLevelMap) === 0 && mapSize(record.guildBuildingLevelMap) > 0) {
                    this.guildBuildingLevelMap = record.guildBuildingLevelMap;
                    filled = true;
                }
                if (!filled) return false;

                this.guildShrineCapturedAt = record.capturedAt || null;
                this.guildShrineHydrated = true;
                this.guildShrineGuildId = record.guildId ?? null;
                this.emit('guild_shrine_levels_updated', {
                    capturedAt: this.guildShrineCapturedAt,
                    fromStorage: true,
                });
                return true;
            } catch (error) {
                console.error('[DataManager] Failed to hydrate guild shrine levels:', error);
                return false;
            }
        }

        /**
         * When the guild shrine levels currently in memory were read off the wire.
         * @returns {number|null} Epoch milliseconds, or null when none have ever been seen
         */
        getGuildShrineCapturedAt() {
            return this.guildShrineCapturedAt;
        }

        /**
         * Whether the shrine levels in memory came from storage rather than this session.
         * @returns {boolean} True when hydrated from a persisted reading
         */
        isGuildShrineHydrated() {
            return this.guildShrineHydrated;
        }

        /**
         * Wait for the startup hydration of guild shrine levels, if one is running.
         * @returns {Promise<void>} Resolves once hydration has settled
         */
        async whenGuildShrineLevelsReady() {
            if (this.guildShrineHydration) {
                await this.guildShrineHydration;
            }
        }

        /**
         * Get static game data
         * @returns {Object} Init client data (items, actions, monsters, etc.)
         */
        getInitClientData() {
            return this.initClientData;
        }

        /**
         * Get combined game data (static + character)
         * Used for features that need both static data and player data
         * @returns {Object} Combined data object
         */
        getCombinedData() {
            if (!this.initClientData) {
                return null;
            }

            return {
                ...this.initClientData,
                // Character-specific data
                characterItems: this.characterItems || [],
                myMarketListings: this.characterData?.myMarketListings || [],
                characterHouseRoomMap: Object.fromEntries(this.characterHouseRooms),
                characterAbilities: this.characterData?.characterAbilities || [],
                combatAbilities: this.getEquippedAbilities(),
                abilityCombatTriggersMap: this.characterData?.abilityCombatTriggersMap || {},
            };
        }

        /**
         * Get item details by HRID
         * @param {string} itemHrid - Item HRID (e.g., "/items/cheese")
         * @returns {Object|null} Item details
         */
        getItemDetails(itemHrid) {
            return this.initClientData?.itemDetailMap?.[itemHrid] || null;
        }

        /**
         * Get action details by HRID
         * @param {string} actionHrid - Action HRID (e.g., "/actions/milking/cow")
         * @returns {Object|null} Action details
         */
        getActionDetails(actionHrid) {
            return this.initClientData?.actionDetailMap?.[actionHrid] || null;
        }

        /**
         * Get player's current actions
         * @returns {Array} Current action queue
         */
        getCurrentActions() {
            return [...this.characterActions];
        }

        /**
         * Get player's equipped items
         * @returns {Map} Equipment map (slot HRID -> item)
         */
        getEquipment() {
            return new Map(this.characterEquipment);
        }

        /**
         * Get MooPass buffs
         * @returns {Array} MooPass buffs array (empty if no MooPass)
         */
        getMooPassBuffs() {
            return this.characterData?.mooPassBuffs || [];
        }

        /**
         * Get player's house rooms
         * @returns {Map} House room map (room HRID -> {houseRoomHrid, level})
         */
        getHouseRooms() {
            return new Map(this.characterHouseRooms);
        }

        /**
         * Get house room level
         * @param {string} houseRoomHrid - House room HRID (e.g., "/house_rooms/brewery")
         * @returns {number} Room level (0 if not found)
         */
        getHouseRoomLevel(houseRoomHrid) {
            const room = this.characterHouseRooms.get(houseRoomHrid);
            return room?.level || 0;
        }

        /**
         * Get character's purchased level for a guild buff
         * @param {string} guildBuffHrid - Guild buff HRID (e.g., "/guild_buffs/force_combat")
         * @returns {number} Current purchased level (0 if not purchased)
         */
        getCharacterGuildBuffLevel(guildBuffHrid) {
            return this.characterGuildBuffMap[guildBuffHrid]?.level || 0;
        }

        /**
         * Get guild shrine or building level
         * @param {string} hrid - Building/shrine HRID (e.g., "/guild_shrines/force")
         * @returns {number} Current guild building level (0 if not in a guild or not built)
         */
        getGuildBuildingLevel(hrid) {
            return this.guildBuildingLevelMap[hrid] || 0;
        }

        /**
         * Get active drink items for an action type
         * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/brewing")
         * @returns {Array} Array of drink items (empty if none)
         */
        getActionDrinkSlots(actionTypeHrid) {
            return this.actionTypeDrinkSlotsMap.get(actionTypeHrid) || [];
        }

        /**
         * Get current character ID
         * @returns {string|null} Character ID or null
         */
        getCurrentCharacterId() {
            return this.currentCharacterId;
        }

        /**
         * Get current character name
         * @returns {string|null} Character name or null
         */
        getCurrentCharacterName() {
            return this.currentCharacterName;
        }

        /**
         * Get current character game mode
         * @returns {string|null} Game mode ('ironcow', 'standard', etc.) or null
         */
        getCurrentCharacterGameMode() {
            return this.currentCharacterGameMode;
        }

        /**
         * Check if character is currently switching
         * @returns {boolean} True if switching
         */
        getIsCharacterSwitching() {
            return this.isCharacterSwitching;
        }

        /**
         * Get community buff level
         * @param {string} buffTypeHrid - Buff type HRID (e.g., "/community_buff_types/production_efficiency")
         * @returns {number} Buff level (0 if not active)
         */
        getCommunityBuffLevel(buffTypeHrid) {
            if (!this.characterData?.communityBuffs) {
                return 0;
            }

            const buff = this.characterData.communityBuffs.find((b) => b.hrid === buffTypeHrid);
            return buff?.level || 0;
        }

        /**
         * Get achievement buffs for an action type
         * Achievement buffs are provided by the game based on completed achievement tiers
         * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/foraging")
         * @returns {Object} Buff object with stat bonuses (e.g., {gatheringQuantity: 0.02}) or empty object
         */
        getAchievementBuffs(actionTypeHrid) {
            if (!this.characterData?.achievementActionTypeBuffsMap) {
                return {};
            }

            return this.characterData.achievementActionTypeBuffsMap[actionTypeHrid] || {};
        }

        /**
         * Get achievement buff flat boost for an action type and buff type
         * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/foraging")
         * @param {string} buffTypeHrid - Buff type HRID (e.g., "/buff_types/wisdom")
         * @returns {number} Flat boost value (decimal) or 0 if not found
         */
        getAchievementBuffFlatBoost(actionTypeHrid, buffTypeHrid) {
            const achievementMap = this.characterData?.achievementActionTypeBuffsMap;
            if (!achievementMap) {
                return 0;
            }

            if (this.achievementBuffCache.source !== achievementMap) {
                this.achievementBuffCache = {
                    source: achievementMap,
                    byActionType: new Map(),
                };
            }

            const actionCache = this.achievementBuffCache.byActionType.get(actionTypeHrid) || new Map();
            if (actionCache.has(buffTypeHrid)) {
                return actionCache.get(buffTypeHrid);
            }

            const achievementBuffs = achievementMap[actionTypeHrid];
            if (!Array.isArray(achievementBuffs)) {
                actionCache.set(buffTypeHrid, 0);
                this.achievementBuffCache.byActionType.set(actionTypeHrid, actionCache);
                return 0;
            }

            const buff = achievementBuffs.find((entry) => entry?.typeHrid === buffTypeHrid);
            const flatBoost = buff?.flatBoost || 0;
            actionCache.set(buffTypeHrid, flatBoost);
            this.achievementBuffCache.byActionType.set(actionTypeHrid, actionCache);
            return flatBoost;
        }

        /**
         * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/enhancing")
         * @param {string} buffTypeHrid - Buff type HRID (e.g., "/buff_types/enhancing_success")
         * @returns {number} Ratio boost value (decimal) or 0 if not found
         */
        getAchievementBuffRatioBoost(actionTypeHrid, buffTypeHrid) {
            const achievementMap = this.characterData?.achievementActionTypeBuffsMap;
            if (!achievementMap) return 0;

            const achievementBuffs = achievementMap[actionTypeHrid];
            if (!Array.isArray(achievementBuffs)) return 0;

            const buff = achievementBuffs.find((entry) => entry?.typeHrid === buffTypeHrid);
            return buff?.ratioBoost || 0;
        }

        /**
         * Get personal buff flat boost for an action type and buff type (seal buffs from Labyrinth).
         * When scroll simulation is armed for this action type, returns max(active, simulated).
         * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/foraging")
         * @param {string} buffTypeHrid - Buff type HRID (e.g., "/buff_types/efficiency")
         * @returns {number} Flat boost value (decimal) or 0 if not found
         */
        getPersonalBuffFlatBoost(actionTypeHrid, buffTypeHrid) {
            const activeValue = this._getActivePersonalBuff(actionTypeHrid, buffTypeHrid);
            const simSet = this.scrollSimulationByActionType[actionTypeHrid];
            if (simSet?.has(buffTypeHrid)) {
                return Math.max(activeValue, SCROLL_BUFF_VALUES[buffTypeHrid] ?? 0);
            }
            return activeValue;
        }

        /**
         * @param {string} actionTypeHrid
         * @param {string} buffTypeHrid
         * @returns {number}
         */
        _getActivePersonalBuff(actionTypeHrid, buffTypeHrid) {
            const personalBuffs = this.personalActionTypeBuffsMap[actionTypeHrid];
            if (!Array.isArray(personalBuffs)) return 0;
            const buff = personalBuffs.find((entry) => entry?.typeHrid === buffTypeHrid);
            return buff?.flatBoost || 0;
        }

        /**
         * Arm scroll simulation for a specific action type before running calculations.
         * @param {string} actionTypeHrid
         * @param {Set<string>} buffTypeSet - Set of buffTypeHrids to simulate
         */
        setScrollSimulation(actionTypeHrid, buffTypeSet) {
            if (buffTypeSet?.size > 0) {
                this.scrollSimulationByActionType[actionTypeHrid] = buffTypeSet;
            } else {
                delete this.scrollSimulationByActionType[actionTypeHrid];
            }
        }

        /**
         * Disarm scroll simulation for a specific action type after calculations are done.
         * @param {string} actionTypeHrid
         */
        clearScrollSimulation(actionTypeHrid) {
            delete this.scrollSimulationByActionType[actionTypeHrid];
        }

        /**
         * Returns true when a scroll buff is being simulated (simulated value > active value).
         * Used by display code to decide whether to show the scroll sprite on a buff row.
         * @param {string} actionTypeHrid
         * @param {string} buffTypeHrid
         * @returns {boolean}
         */
        isBuffBeingSimulated(actionTypeHrid, buffTypeHrid) {
            const simSet = this.scrollSimulationByActionType[actionTypeHrid];
            if (!simSet?.has(buffTypeHrid)) return false;
            return (SCROLL_BUFF_VALUES[buffTypeHrid] ?? 0) > this._getActivePersonalBuff(actionTypeHrid, buffTypeHrid);
        }

        /**
         * Get player's skills
         * @returns {Array|null} Character skills
         */
        getSkills() {
            return this.characterSkills ? [...this.characterSkills] : null;
        }

        /**
         * Get player's inventory
         * @returns {Array|null} Character items
         */
        getInventory() {
            return this.characterItems ? [...this.characterItems] : null;
        }

        /**
         * Get player's market listings
         * @returns {Array} Market listings array
         */
        getMarketListings() {
            return this.characterData?.myMarketListings ? [...this.characterData.myMarketListings] : [];
        }

        /**
         * Get the current blocked character map { [characterId]: name }
         * @returns {Object} Blocked character map, or empty object if not available
         */
        getBlockedCharacterMap() {
            return this.characterData?.blockedCharacterMap || {};
        }

        /**
         * Get active task action HRIDs
         * @returns {Array<string>} Array of action HRIDs that are currently active tasks
         */
        getActiveTaskActionHrids() {
            if (!this.characterQuests || this.characterQuests.length === 0) {
                return [];
            }

            return this.characterQuests
                .filter(
                    (quest) =>
                        quest.category === '/quest_category/random_task' &&
                        quest.status === '/quest_status/in_progress' &&
                        quest.actionHrid
                )
                .map((quest) => quest.actionHrid);
        }

        /**
         * Check if an action is currently an active task
         * @param {string} actionHrid - Action HRID to check
         * @returns {boolean} True if action is an active task
         */
        isTaskAction(actionHrid) {
            const activeTasks = this.getActiveTaskActionHrids();
            return activeTasks.includes(actionHrid);
        }

        /**
         * Get task speed bonus from equipped task badges
         * @returns {number} Task speed percentage (e.g., 15 for 15%)
         */
        getTaskSpeedBonus() {
            if (!this.characterEquipment || !this.initClientData) {
                return 0;
            }

            let totalTaskSpeed = 0;

            // Task badges are in trinket slot
            const trinketLocation = '/item_locations/trinket';
            const equippedItem = this.characterEquipment.get(trinketLocation);

            if (!equippedItem || !equippedItem.itemHrid) {
                return 0;
            }

            const itemDetail = this.initClientData.itemDetailMap[equippedItem.itemHrid];
            if (!itemDetail || !itemDetail.equipmentDetail) {
                return 0;
            }

            const taskSpeed = itemDetail.equipmentDetail.noncombatStats?.taskSpeed || 0;
            if (taskSpeed === 0) {
                return 0;
            }

            // Calculate enhancement bonus
            // Note: noncombatEnhancementBonuses already includes slot multiplier (5× for trinket)
            const enhancementLevel = equippedItem.enhancementLevel || 0;
            const enhancementBonus = itemDetail.equipmentDetail.noncombatEnhancementBonuses?.taskSpeed || 0;
            const totalEnhancementBonus = enhancementBonus * enhancementLevel;

            // Total taskSpeed = base + enhancement
            totalTaskSpeed = (taskSpeed + totalEnhancementBonus) * 100; // Convert to percentage

            return totalTaskSpeed;
        }

        /**
         * Build monster-to-sortIndex mapping from combat zone data
         * Used for sorting combat tasks by zone progression order
         * @private
         */
        buildMonsterSortIndexMap() {
            if (!this.initClientData || !this.initClientData.actionDetailMap) {
                return;
            }

            this.monsterSortIndexMap.clear();
            this.bossMonsterHrids.clear();

            // Extract combat zones (non-dungeon only)
            for (const [_zoneHrid, action] of Object.entries(this.initClientData.actionDetailMap)) {
                // Skip non-combat actions and dungeons
                if (action.type !== '/action_types/combat' || action.combatZoneInfo?.isDungeon) {
                    continue;
                }

                const sortIndex = action.sortIndex;

                // Get regular spawn monsters
                const regularMonsters = action.combatZoneInfo?.fightInfo?.randomSpawnInfo?.spawns || [];

                // Get boss monsters (every 10 battles)
                const bossMonsters = action.combatZoneInfo?.fightInfo?.bossSpawns || [];

                // Track boss monster HRIDs
                for (const boss of bossMonsters) {
                    if (boss.combatMonsterHrid) {
                        this.bossMonsterHrids.add(boss.combatMonsterHrid);
                    }
                }

                // Combine all monsters from this zone
                const allMonsters = [...regularMonsters, ...bossMonsters];

                // Map each monster to this zone's sortIndex
                for (const spawn of allMonsters) {
                    const monsterHrid = spawn.combatMonsterHrid;
                    if (!monsterHrid) continue;

                    // If monster appears in multiple zones, use earliest zone (lowest sortIndex)
                    if (
                        !this.monsterSortIndexMap.has(monsterHrid) ||
                        sortIndex < this.monsterSortIndexMap.get(monsterHrid)
                    ) {
                        this.monsterSortIndexMap.set(monsterHrid, sortIndex);
                    }
                }
            }
        }

        /**
         * Find the combat zone actionHrid that contains a given monster
         * @param {string} monsterHrid - Monster HRID (e.g., "/monsters/bear")
         * @returns {string|null} Zone actionHrid or null
         */
        getCombatZoneForMonster(monsterHrid) {
            if (!this.initClientData?.actionDetailMap) return null;

            for (const [zoneHrid, action] of Object.entries(this.initClientData.actionDetailMap)) {
                if (action.type !== '/action_types/combat') continue;

                const spawns = action.combatZoneInfo?.fightInfo?.randomSpawnInfo?.spawns || [];
                const bosses = action.combatZoneInfo?.fightInfo?.bossSpawns || [];

                for (const spawn of [...spawns, ...bosses]) {
                    if (spawn.combatMonsterHrid === monsterHrid) {
                        return zoneHrid;
                    }
                }
            }
            return null;
        }

        /**
         * Get zone sortIndex for a monster (for task sorting)
         * @param {string} monsterHrid - Monster HRID (e.g., "/monsters/rat")
         * @returns {number} Zone sortIndex (999 if not found)
         */
        getMonsterSortIndex(monsterHrid) {
            return this.monsterSortIndexMap.get(monsterHrid) ?? 999;
        }

        /**
         * Check if a monster is a boss (appears in bossSpawns of any combat zone)
         * @param {string} monsterHrid - Monster HRID (e.g., "/monsters/crystal_colossus")
         * @returns {boolean} True if the monster is a boss
         */
        isBossMonster(monsterHrid) {
            return this.bossMonsterHrids.has(monsterHrid);
        }

        /**
         * Get monster HRID from display name (for task sorting)
         * @param {string} monsterName - Monster display name (e.g., "Jerry")
         * @returns {string|null} Monster HRID or null if not found
         */
        getMonsterHridFromName(monsterName) {
            if (!this.initClientData || !this.initClientData.combatMonsterDetailMap) {
                return null;
            }

            // Search for monster by display name
            for (const [hrid, monster] of Object.entries(this.initClientData.combatMonsterDetailMap)) {
                if (monster.name === monsterName) {
                    return hrid;
                }
            }

            return null;
        }

        /**
         * Register event listener
         * @param {string} event - Event name
         * @param {Function} callback - Handler function
         */
        on(event, callback) {
            if (!this.eventListeners.has(event)) {
                this.eventListeners.set(event, []);
            }
            this.eventListeners.get(event).push(callback);
        }

        /**
         * Unregister event listener
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
         * Emit event to all listeners
         * Only character_switching is critical (must run immediately for proper cleanup)
         * All other events including character_switched and character_initialized are deferred
         * @param {string} event - Event name
         * @param {*} data - Event data
         */
        emit(event, data) {
            // Snapshot at emit time. Lifecycle listeners commonly unregister themselves
            // during character_switching; iterating the live array would shift entries and
            // deterministically skip the next cleanup handler. Deferred events must also not
            // be delivered to listeners that subscribed after the event was emitted.
            const listeners = [...(this.eventListeners.get(event) || [])];

            // Only character_switching must run immediately (cleanup phase)
            // character_switched can be deferred - it just schedules re-init anyway
            const isCritical = event === 'character_switching';

            if (isCritical) {
                // Run immediately on main thread
                for (const listener of listeners) {
                    try {
                        listener(data);
                    } catch (error) {
                        console.error(`[Data Manager] Error in ${event} listener:`, error);
                    }
                }
            } else {
                // Defer all other events to prevent main thread blocking
                setTimeout(() => {
                    for (const listener of listeners) {
                        try {
                            listener(data);
                        } catch (error) {
                            console.error(`[Data Manager] Error in ${event} listener:`, error);
                        }
                    }
                }, 0);
            }
        }
    }

    const dataManager = new DataManager();

    /**
     * Configuration Module
     * Manages all script constants and user settings
     */


    /**
     * Config class manages all script configuration
     * - Constants (colors, URLs, formatters)
     * - User settings with persistence
     */
    class Config {
        constructor() {
            // Number formatting separators (locale-aware)
            this.THOUSAND_SEPARATOR = new Intl.NumberFormat().format(1111).replaceAll('1', '').at(0) || '';
            this.DECIMAL_SEPARATOR = new Intl.NumberFormat().format(1.1).replaceAll('1', '').at(0);

            // Extended color palette (configurable)
            // Dark background colors (for UI elements on dark backgrounds)
            this.COLOR_PROFIT = '#047857'; // Emerald green for positive values
            this.COLOR_LOSS = '#f87171'; // Red for negative values
            this.COLOR_WARNING = '#ffa500'; // Orange for warnings
            this.COLOR_INFO = '#60a5fa'; // Blue for informational
            this.COLOR_ESSENCE = '#c084fc'; // Purple for essences

            // Tooltip colors (for text on light/tooltip backgrounds)
            this.COLOR_TOOLTIP_PROFIT = '#047857'; // Green for tooltips
            this.COLOR_TOOLTIP_LOSS = '#dc2626'; // Darker red for tooltips
            this.COLOR_TOOLTIP_INFO = '#2563eb'; // Darker blue for tooltips
            this.COLOR_TOOLTIP_WARNING = '#ea580c'; // Darker orange for tooltips

            // General colors
            this.COLOR_TEXT_PRIMARY = '#ffffff'; // Primary text color
            this.COLOR_TEXT_SECONDARY = '#888888'; // Secondary text color
            this.COLOR_BORDER = '#444444'; // Border color
            this.COLOR_GOLD = '#ffa500'; // Gold/currency color
            this.COLOR_MIRROR = '#ffd700'; // Philosopher's Mirror highlight color
            this.COLOR_LISTING_PRICE_1M = '#ffd700'; // Listing total price 1M+
            this.COLOR_LISTING_PRICE_100K = '#22c55e'; // Listing total price 100K+
            this.COLOR_LISTING_PRICE_10K = '#ffffff'; // Listing total price 10K+
            this.COLOR_LISTING_PRICE_LOW = '#888888'; // Listing total price <10K
            this.COLOR_ACCENT = '#22c55e'; // Script accent color (green)
            this.COLOR_REMAINING_XP = '#FFFFFF'; // Remaining XP text color
            this.COLOR_XP_RATE = '#ffffff'; // XP/hr rate text color
            this.COLOR_HOURS_TO_LEVEL = '#ffffff'; // Hours to level text color
            this.COLOR_INV_COUNT = '#ffffff'; // Inventory count display color

            // Legacy color constants (mapped to COLOR_ACCENT)
            this.SCRIPT_COLOR_MAIN = this.COLOR_ACCENT;
            this.SCRIPT_COLOR_TOOLTIP = this.COLOR_ACCENT;
            this.SCRIPT_COLOR_ALERT = 'red';

            // Z-index tiers
            this.Z_HUD = 50; // In-game HUD overlays — below game interactive UI
            this.Z_FLOATING_PANEL = 1100; // Persistent panels — below MUI modals (game = ~1300)
            this.Z_POPUP = 9000; // Contextual popups / short-lived overlays
            this.Z_MODAL = 9000; // Full-screen intentional modals
            this.Z_NOTIFICATION = 99999; // Transient notifications (above everything)

            // Market API URL
            this.MARKET_API_URL = 'https://www.milkywayidle.com/game_data/marketplace.json';

            // Settings loaded from settings-schema via settings-storage.js
            this.settingsMap = {};

            // Map of setting keys to callback functions
            this.settingChangeCallbacks = {};

            // Callbacks fired whenever loadSettings() repopulates the map, regardless
            // of whether any individual value changed. A character switch clears the
            // cache and reloads it with previousMap empty, so the per-key change
            // callbacks above are all skipped — a persistent feature that never
            // re-initializes (the Action Filter) has no other signal that fresh
            // per-character settings have arrived. See onSettingsLoaded().
            this.settingsLoadedCallbacks = [];

            // Feature toggles with metadata for future UI
            this.features = {
                // Market Features
                tooltipPrices: {
                    enabled: true,
                    name: 'Market Prices in Tooltips',
                    category: 'Market',
                    description: 'Shows bid/ask prices in item tooltips',
                    settingKey: 'itemTooltip_prices',
                },
                tooltipArtisanPrices: {
                    enabled: true,
                    name: 'Artisan-Adjusted Tooltip Prices',
                    category: 'Market',
                    description: 'Adjusts tooltip price totals for Artisan Tea material reduction',
                    settingKey: 'itemTooltip_artisanPrices',
                },
                tooltipProfit: {
                    enabled: true,
                    name: 'Profit Calculator in Tooltips',
                    category: 'Market',
                    description: 'Shows production cost and profit in tooltips',
                    settingKey: 'itemTooltip_profit',
                },
                tooltipConsumables: {
                    enabled: true,
                    name: 'Consumable Effects in Tooltips',
                    category: 'Market',
                    description: 'Shows buff effects and durations for food/drinks',
                    settingKey: 'showConsumTips',
                },
                dungeonTokenTooltips: {
                    enabled: true,
                    name: 'Currency Token Tooltips',
                    category: 'Inventory',
                    description: 'Shows shop values for tokens, seals, and cowbells',
                    settingKey: 'dungeonTokenTooltips',
                },
                expectedValueCalculator: {
                    enabled: true,
                    name: 'Expected Value Calculator',
                    category: 'Market',
                    description: 'Shows EV for openable containers (crates, chests)',
                    settingKey: 'itemTooltip_expectedValue',
                },
                market_showListingPrices: {
                    enabled: true,
                    name: 'Market Listing Price Display',
                    category: 'Market',
                    description: 'Shows top order price, total value, and listing age on My Listings',
                    settingKey: 'market_showListingPrices',
                },
                market_showEstimatedListingAge: {
                    enabled: true,
                    name: 'Estimated Listing Age',
                    category: 'Market',
                    description: 'Estimates creation time for all market listings using listing ID interpolation',
                    settingKey: 'market_showEstimatedListingAge',
                },
                market_showOrderTotals: {
                    enabled: true,
                    name: 'Market Order Totals',
                    category: 'Market',
                    description: 'Shows buy orders, sell orders, and unclaimed coins in header',
                    settingKey: 'market_showOrderTotals',
                },
                market_showHistoryViewer: {
                    enabled: true,
                    name: 'Market History Viewer',
                    category: 'Market',
                    description: 'View and export all market listing history',
                    settingKey: 'market_showHistoryViewer',
                },
                market_listingRefreshNavigator: {
                    enabled: true,
                    name: 'Listing Refresh Navigator',
                    category: 'Market',
                    description: 'Cycles through My Listings navigating to each order book one at a time',
                    settingKey: 'market_listingRefreshNavigator',
                },
                market_showPhiloCalculator: {
                    enabled: true,
                    name: 'Philo Gamba Calculator',
                    category: 'Market',
                    description: "Calculate expected value of transmuting items into Philosopher's Stones",
                    settingKey: 'market_showPhiloCalculator',
                },

                // Action Features
                actionTimeDisplay: {
                    enabled: true,
                    name: 'Action Queue Time Display',
                    category: 'Actions',
                    description: 'Shows total time and completion time for queued actions',
                    settingKey: 'actionBar_enabled',
                },
                actionCountdown: {
                    enabled: true,
                    name: 'Action Bar Countdown',
                    category: 'Actions',
                    description: 'Live countdown timer on the action progress bar',
                },
                quickInputButtons: {
                    enabled: true,
                    name: 'Quick Input Buttons',
                    category: 'Actions',
                    description: 'Adds 1/10/100/1000 buttons to action inputs',
                    settingKey: 'actionPanel_totalTime_quickInputs',
                },
                actionPanelProfit: {
                    enabled: true,
                    name: 'Action Profit Display',
                    category: 'Actions',
                    description: 'Shows profit/loss for gathering and production',
                    settingKey: 'actionPanel_foragingTotal',
                },
                requiredMaterials: {
                    enabled: true,
                    name: 'Required Materials Display',
                    category: 'Actions',
                    description: 'Shows total required and missing materials for production actions',
                    settingKey: 'requiredMaterials',
                },

                drinkTimer: {
                    enabled: true,
                    name: 'Drink Timer',
                    category: 'Actions',
                    description: 'Shows remaining drink supply time and queue coverage in skill panels',
                    settingKey: 'drinkTimer',
                },

                // Combat Features
                abilityBookCalculator: {
                    enabled: true,
                    name: 'Ability Book Requirements',
                    category: 'Combat',
                    description: 'Shows books needed to reach target level',
                    settingKey: 'skillbook',
                },
                zoneIndices: {
                    enabled: true,
                    name: 'Combat Zone Indices',
                    category: 'Combat',
                    description: 'Shows zone numbers in combat location list',
                    settingKey: 'mapIndex',
                },
                taskZoneIndices: {
                    enabled: true,
                    name: 'Task Zone Indices',
                    category: 'Tasks',
                    description: 'Shows zone numbers on combat tasks',
                    settingKey: 'taskMapIndex',
                },
                combatScore: {
                    enabled: true,
                    name: 'Profile Gear Score',
                    category: 'Combat',
                    description: 'Shows gear score on profile',
                    settingKey: 'combatScore',
                },
                dungeonTracker: {
                    enabled: true,
                    name: 'Dungeon Tracker',
                    category: 'Combat',
                    description:
                        'Real-time dungeon progress tracking in top bar with wave times, statistics, and party chat completion messages',
                    settingKey: 'dungeonTracker',
                },
                combatStats: {
                    enabled: true,
                    name: 'Combat Statistics',
                    category: 'Combat',
                    description: 'Tracks combat data and consumable usage; shows Statistics tab in Combat panel',
                    settingKey: 'combatStats',
                },
                combatSimIntegration: {
                    enabled: true,
                    name: 'Combat Simulator Integration',
                    category: 'Combat',
                    description: 'Auto-import character/party data into Shykai Combat Simulator',
                    settingKey: null, // New feature, no legacy setting
                },
                enhancementSimulator: {
                    enabled: true,
                    name: 'Enhancement Simulator',
                    category: 'Market',
                    description: 'Shows enhancement cost calculations in item tooltips',
                    settingKey: 'enhanceSim',
                },

                // UI Features
                equipmentLevelDisplay: {
                    enabled: true,
                    name: 'Equipment Level on Icons',
                    category: 'UI',
                    description: 'Shows item level number on equipment icons',
                    settingKey: 'itemIconLevel',
                },
                alchemyItemDimming: {
                    enabled: true,
                    name: 'Alchemy Item Dimming',
                    category: 'UI',
                    description: 'Dims items requiring higher Alchemy level',
                    settingKey: 'alchemyItemDimming',
                },
                skillExperiencePercentage: {
                    enabled: true,
                    name: 'Skill Experience Percentage',
                    category: 'UI',
                    description: 'Shows XP progress percentage in left sidebar',
                    settingKey: 'expPercentage',
                },
                largeNumberFormatting: {
                    enabled: true,
                    name: 'Use K/M/B Number Formatting',
                    category: 'UI',
                    description: 'Display large numbers as 1.5M instead of 1,500,000',
                    settingKey: 'formatting_useKMBFormat',
                },

                // Task Features
                taskProfitDisplay: {
                    enabled: true,
                    name: 'Task Profit Calculator',
                    category: 'Tasks',
                    description: 'Shows expected profit from task rewards',
                    settingKey: 'taskProfitCalculator',
                },
                taskEfficiencyRating: {
                    enabled: true,
                    name: 'Task Efficiency Rating',
                    category: 'Tasks',
                    description: 'Shows tokens or profit per hour on task cards',
                    settingKey: 'taskEfficiencyRating',
                },
                taskRerollTracker: {
                    enabled: true,
                    name: 'Task Reroll Tracker',
                    category: 'Tasks',
                    description: 'Tracks reroll costs and history',
                    settingKey: 'taskRerollTracker',
                },
                taskSorter: {
                    enabled: true,
                    name: 'Task Sorting',
                    category: 'Tasks',
                    description: 'Adds button to sort tasks by skill type',
                    settingKey: 'taskSorter',
                },
                taskIcons: {
                    enabled: true,
                    name: 'Task Icons',
                    category: 'Tasks',
                    description: 'Shows visual icons on task cards',
                    settingKey: 'taskIcons',
                },
                taskIconsDungeons: {
                    enabled: false,
                    name: 'Task Icons - Dungeons',
                    category: 'Tasks',
                    description: 'Shows dungeon icons for combat tasks',
                    settingKey: 'taskIconsDungeons',
                    dependencies: ['taskIcons'],
                },

                // Skills Features
                skillRemainingXP: {
                    enabled: true,
                    name: 'Remaining XP Display',
                    category: 'Skills',
                    description: 'Shows remaining XP to next level on skill bars',
                    settingKey: 'skillRemainingXP',
                },
                skillingOptimizer: {
                    enabled: true,
                    name: 'Skilling Simulator/Optimizer',
                    category: 'Skills',
                    description: 'Optimizer tab in the character panel',
                    settingKey: 'skillingOptimizer',
                },

                // House Features
                houseCostDisplay: {
                    enabled: true,
                    name: 'House Upgrade Costs',
                    category: 'House',
                    description: 'Shows market value of upgrade materials',
                    settingKey: 'houseUpgradeCosts',
                },

                // Economy Features
                networth: {
                    enabled: true,
                    name: 'Net Worth Calculator',
                    category: 'Economy',
                    description: 'Shows total asset value in header (Current Assets)',
                    settingKey: 'networth',
                },
                inventorySummary: {
                    enabled: true,
                    name: 'Inventory Summary Panel',
                    category: 'Economy',
                    description: 'Shows detailed networth breakdown below inventory',
                    settingKey: 'invWorth',
                },
                inventorySort: {
                    enabled: true,
                    name: 'Inventory Sort',
                    category: 'Economy',
                    description: 'Sorts inventory by Ask/Bid price',
                    settingKey: 'invSort',
                },
                inventorySortBadges: {
                    enabled: false,
                    name: 'Inventory Sort Price Badges',
                    category: 'Economy',
                    description: 'Shows stack value badges on items when sorting',
                    settingKey: 'invSort_showBadges',
                },
                inventoryBadgePrices: {
                    enabled: false,
                    name: 'Inventory Price Badges',
                    category: 'Economy',
                    description: 'Shows stack value badges on items (independent of sorting)',
                    settingKey: 'invBadgePrices',
                },

                // Enhancement Features
                enhancementTracker: {
                    enabled: false,
                    name: 'Enhancement Tracker',
                    category: 'Enhancement',
                    description: 'Tracks enhancement attempts, costs, and statistics',
                    settingKey: 'enhancementTracker',
                },

                // Notification Features
                notifiEmptyAction: {
                    enabled: false,
                    name: 'Empty Queue Notification',
                    category: 'Notifications',
                    description: 'Browser notification when action queue becomes empty',
                    settingKey: 'notifiEmptyAction',
                },
            };

            // Note: loadSettings() must be called separately (async)
        }

        /**
         * Initialize config (async) - loads settings from storage
         * @returns {Promise<void>}
         */
        async initialize() {
            await this.loadSettings();
            this.applyColorSettings();
        }

        /**
         * Load settings from storage (async)
         * @returns {Promise<void>}
         */
        async loadSettings() {
            // Set character ID in settings storage for per-character settings
            const characterId = dataManager.getCurrentCharacterId();

            // Before character ID is known, only populate schema defaults (no storage access)
            // This prevents loading from the wrong storage key during early initialization
            if (!characterId) {
                this.settingsMap = settingsStorage.buildDefaults();
                this.characterSettingsLoaded = false;
                return;
            }

            settingsStorage.setCharacterId(characterId, dataManager.getCurrentCharacterName());

            const previousMap = this.settingsMap;

            // Load settings from settings-storage (which uses settings-schema as source of truth)
            this.settingsMap = await settingsStorage.loadSettings();
            this.characterSettingsLoaded = true;

            // Fire change callbacks for settings that differ from what was previously loaded
            for (const key of Object.keys(this.settingChangeCallbacks)) {
                const prev = previousMap[key];
                const curr = this.settingsMap[key];
                if (!prev || !curr) continue;
                const prevVal = prev.hasOwnProperty('value') ? prev.value : prev.isTrue;
                const currVal = curr.hasOwnProperty('value') ? curr.value : curr.isTrue;
                if (prevVal !== currVal) {
                    for (const cb of this.settingChangeCallbacks[key]) cb(currVal);
                }
            }

            // Fire the settings-loaded channel unconditionally: the map has just been
            // repopulated, which is the one signal a persistent feature can use to
            // resync after a character switch (when previousMap was empty and no
            // per-key change callback fired).
            for (const cb of this.settingsLoadedCallbacks) {
                try {
                    cb();
                } catch (error) {
                    console.error('[Config] settings-loaded callback failed:', error);
                }
            }
        }

        /**
         * Clear settings cache (for character switching)
         */
        clearSettingsCache() {
            this.settingsMap = {};
            this.characterSettingsLoaded = false;
        }

        /**
         * Save settings to storage (immediately)
         * @returns {Promise<void>} Resolves when the write completes
         */
        saveSettings() {
            return settingsStorage.saveSettings(this.settingsMap);
        }

        /**
         * Get a setting value.
         * Checkbox settings return their boolean; select/number/color settings return their stored value.
         * @param {string} key - Setting key
         * @param {*} [defaultValue=false] - Value returned when the setting is unknown
         * @returns {*} Setting value
         */
        getSetting(key, defaultValue = false) {
            // Check loaded settings first
            const setting = this.settingsMap[key];
            if (setting) {
                if (Object.hasOwn(setting, 'isTrue')) {
                    return setting.isTrue ?? defaultValue;
                }
                if (Object.hasOwn(setting, 'value')) {
                    return setting.value ?? defaultValue;
                }
            }

            // Fallback: Check settings-schema for default (fixes race condition on load)
            for (const group of Object.values(settingsGroups)) {
                if (group.settings[key]) {
                    return group.settings[key].default ?? defaultValue;
                }
            }

            // Ultimate fallback
            return defaultValue;
        }

        /**
         * Get the display label for a pricing mode key, respecting the naming convention setting.
         * @param {string} mode - Pricing mode key ('conservative', 'hybrid', 'optimistic', 'patientBuy')
         * @returns {string} Display label
         */
        getPricingModeLabel(mode) {
            const useInstant = this.getSetting('profitCalc_pricingNaming');
            const labels = useInstant
                ? {
                      conservative: 'Instant Buy / Instant Sell',
                      hybrid: 'Instant Buy / Patient Sell',
                      optimistic: 'Patient Buy / Patient Sell',
                      patientBuy: 'Patient Buy / Instant Sell',
                  }
                : {
                      conservative: 'Buy: Ask / Sell: Bid',
                      hybrid: 'Buy: Ask / Sell: Ask',
                      optimistic: 'Buy: Bid / Sell: Ask',
                      patientBuy: 'Buy: Bid / Sell: Bid',
                  };
            return labels[mode] || labels.hybrid;
        }

        /**
         * Get a setting value (for non-boolean settings)
         * @param {string} key - Setting key
         * @param {*} defaultValue - Default value if key doesn't exist
         * @returns {*} Setting value
         */
        /**
         * The setting IDs the previous build saved — see settingsStorage.
         * Exposed here because config already crosses the bundle boundary.
         * @returns {Promise<Array<string>|null>}
         */
        async storedSettingIds() {
            return settingsStorage.storedSettingIds();
        }

        getSettingValue(key, defaultValue = null) {
            const setting = this.settingsMap[key];
            if (!setting) {
                return defaultValue;
            }
            // Handle both boolean (isTrue) and value-based settings
            if (setting.hasOwnProperty('value')) {
                let value = setting.value;

                // Parse JSON strings for template-type settings
                if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
                    try {
                        value = JSON.parse(value);
                    } catch (e) {
                        console.warn(`[Config] Failed to parse JSON for setting '${key}':`, e);
                        // Return as-is if parsing fails
                    }
                }

                return value;
            } else if (setting.hasOwnProperty('isTrue')) {
                return setting.isTrue;
            }
            return defaultValue;
        }

        /**
         * Set a setting value (auto-saves)
         * Writes to the field the setting actually uses: isTrue for checkboxes, value otherwise.
         * @param {string} key - Setting key
         * @param {*} value - Setting value
         */
        setSetting(key, value) {
            const setting = this.settingsMap[key];
            if (setting) {
                if (Object.hasOwn(setting, 'isTrue')) {
                    setting.isTrue = value;
                } else if (Object.hasOwn(setting, 'value')) {
                    setting.value = value;
                } else if (typeof value === 'boolean') {
                    setting.isTrue = value;
                } else {
                    setting.value = value;
                }
                this.saveSettings();

                // Re-apply colors if color setting changed
                if (key === 'useOrangeAsMainColor') {
                    this.applyColorSettings();
                }

                // Trigger registered callbacks for this setting
                if (this.settingChangeCallbacks[key]) {
                    for (const cb of this.settingChangeCallbacks[key]) cb(value);
                }
            }
        }

        /**
         * Set a setting value (for non-boolean settings, auto-saves)
         * @param {string} key - Setting key
         * @param {*} value - Setting value
         */
        setSettingValue(key, value) {
            if (this.settingsMap[key]) {
                this.settingsMap[key].value = value;
                this.saveSettings();

                // Re-apply color settings if this is a color setting
                if (key.startsWith('color_')) {
                    this.applyColorSettings();
                }

                // Trigger registered callbacks for this setting
                if (this.settingChangeCallbacks[key]) {
                    for (const cb of this.settingChangeCallbacks[key]) cb(value);
                }
            }
        }

        /**
         * Register a callback to be called when a specific setting changes.
         * Multiple callbacks per key are supported.
         * @param {string} key - Setting key to watch
         * @param {Function} callback - Callback function to call when setting changes
         */
        onSettingChange(key, callback) {
            if (!this.settingChangeCallbacks[key]) {
                this.settingChangeCallbacks[key] = [];
            }
            this.settingChangeCallbacks[key].push(callback);
        }

        /**
         * Unregister a specific callback for a setting change
         * @param {string} key - Setting key to stop watching
         * @param {Function} callback - The exact callback reference to remove
         */
        offSettingChange(key, callback) {
            if (this.settingChangeCallbacks[key]) {
                this.settingChangeCallbacks[key] = this.settingChangeCallbacks[key].filter((cb) => cb !== callback);
            }
        }

        /**
         * Register a callback fired every time loadSettings() repopulates the map —
         * including a character switch, where per-key change callbacks are skipped
         * because the previous map was empty. For persistent features that never
         * re-initialize and so need to resync their UI to the new character's values.
         * @param {Function} callback - Called with no arguments after settings load
         */
        onSettingsLoaded(callback) {
            this.settingsLoadedCallbacks.push(callback);
        }

        /**
         * Unregister a settings-loaded callback.
         * @param {Function} callback - The exact callback reference to remove
         */
        offSettingsLoaded(callback) {
            this.settingsLoadedCallbacks = this.settingsLoadedCallbacks.filter((cb) => cb !== callback);
        }

        /**
         * Toggle a setting (auto-saves)
         * @param {string} key - Setting key
         * @returns {boolean} New value
         */
        toggleSetting(key) {
            const newValue = !this.getSetting(key);
            this.setSetting(key, newValue);
            return newValue;
        }

        /**
         * Get all settings as an array (useful for UI)
         * @returns {Array} Array of setting objects
         */
        getAllSettings() {
            return Object.values(this.settingsMap);
        }

        /**
         * Reset all settings to defaults
         */
        async resetToDefaults() {
            this.settingsMap = settingsStorage.buildDefaults();
            await settingsStorage.saveSettings(this.settingsMap);
            this.applyColorSettings();
        }

        /**
         * Sync current settings to all other characters
         * @returns {Promise<{success: boolean, count: number, error?: string}>} Result object
         */
        async syncSettingsToAllCharacters(targetIds) {
            try {
                const characterId = dataManager.getCurrentCharacterId();
                if (!characterId) {
                    return { success: false, count: 0, error: 'No character ID available' };
                }
                settingsStorage.setCharacterId(characterId, dataManager.getCurrentCharacterName());
                const syncedCount = await settingsStorage.syncSettingsToAllCharacters(this.settingsMap, targetIds);
                return { success: true, count: syncedCount };
            } catch (error) {
                console.error('[Config] Failed to sync settings:', error);
                return { success: false, count: 0, error: error.message };
            }
        }

        /**
         * Get list of known characters as [{id, name}] objects.
         * @returns {Promise<Array<{id: string, name: string}>>}
         */
        async getKnownCharacters() {
            try {
                return await settingsStorage.getKnownCharacters();
            } catch (error) {
                console.error('[Config] Failed to get known characters:', error);
                return [];
            }
        }

        /**
         * Get number of known characters (including current)
         * @returns {Promise<number>} Number of characters
         */
        async getKnownCharacterCount() {
            try {
                const knownCharacters = await settingsStorage.getKnownCharacters();
                return knownCharacters.length;
            } catch (error) {
                console.error('[Config] Failed to get character count:', error);
                return 0;
            }
        }

        /**
         * Apply color settings to color constants
         */
        applyColorSettings() {
            // Apply extended color palette from settings
            this.COLOR_PROFIT = this.getSettingValue('color_profit', '#047857');
            this.COLOR_LOSS = this.getSettingValue('color_loss', '#f87171');
            this.COLOR_WARNING = this.getSettingValue('color_warning', '#ffa500');
            this.COLOR_INFO = this.getSettingValue('color_info', '#60a5fa');
            this.COLOR_ESSENCE = this.getSettingValue('color_essence', '#c084fc');
            this.COLOR_TOOLTIP_PROFIT = this.getSettingValue('color_tooltip_profit', '#047857');
            this.COLOR_TOOLTIP_LOSS = this.getSettingValue('color_tooltip_loss', '#dc2626');
            this.COLOR_TOOLTIP_INFO = this.getSettingValue('color_tooltip_info', '#2563eb');
            this.COLOR_TOOLTIP_WARNING = this.getSettingValue('color_tooltip_warning', '#ea580c');
            this.COLOR_TEXT_PRIMARY = this.getSettingValue('color_text_primary', '#ffffff');
            this.COLOR_TEXT_SECONDARY = this.getSettingValue('color_text_secondary', '#888888');
            this.COLOR_BORDER = this.getSettingValue('color_border', '#444444');
            this.COLOR_GOLD = this.getSettingValue('color_gold', '#ffa500');
            this.COLOR_MIRROR = this.getSettingValue('color_mirror', '#ffd700');
            this.COLOR_LISTING_PRICE_1M = this.getSettingValue('color_listing_price_1m', '#ffd700');
            this.COLOR_LISTING_PRICE_100K = this.getSettingValue('color_listing_price_100k', '#22c55e');
            this.COLOR_LISTING_PRICE_10K = this.getSettingValue('color_listing_price_10k', '#ffffff');
            this.COLOR_LISTING_PRICE_LOW = this.getSettingValue('color_listing_price_low', '#888888');
            this.COLOR_ACCENT = this.getSettingValue('color_accent', '#22c55e');
            this.COLOR_REMAINING_XP = this.getSettingValue('color_remaining_xp', '#FFFFFF');
            this.COLOR_XP_RATE = this.getSettingValue('color_xp_rate', '#ffffff');
            this.COLOR_HOURS_TO_LEVEL = this.getSettingValue('color_hours_to_level', '#ffffff');
            this.COLOR_INV_COUNT = this.getSettingValue('color_inv_count', '#ffffff');
            this.COLOR_INVBADGE_ASK = this.getSettingValue('color_invBadge_ask', '#047857');
            this.COLOR_INVBADGE_BID = this.getSettingValue('color_invBadge_bid', '#60a5fa');
            this.COLOR_TRANSMUTE = this.getSettingValue('color_transmute', '#ffffff');

            // Set legacy SCRIPT_COLOR_MAIN to accent color
            this.SCRIPT_COLOR_MAIN = this.COLOR_ACCENT;
            this.SCRIPT_COLOR_TOOLTIP = this.COLOR_ACCENT; // Keep tooltip same as main
        }

        /**
         * Check if a feature is enabled
         * Uses legacy settingKey if available, otherwise uses feature.enabled
         * @param {string} featureKey - Feature key (e.g., 'tooltipPrices')
         * @returns {boolean} Whether feature is enabled
         */
        isFeatureEnabled(featureKey) {
            const feature = this.features?.[featureKey];
            if (!feature) {
                return true; // Default to enabled if not found
            }

            // Check legacy setting first (for backward compatibility)
            if (feature.settingKey && this.settingsMap[feature.settingKey]) {
                return this.settingsMap[feature.settingKey].isTrue ?? true;
            }

            // Otherwise use feature.enabled
            return feature.enabled ?? true;
        }

        /**
         * Enable or disable a feature
         * @param {string} featureKey - Feature key
         * @param {boolean} enabled - Enable state
         */
        async setFeatureEnabled(featureKey, enabled) {
            const feature = this.features?.[featureKey];
            if (!feature) {
                console.warn(`Feature '${featureKey}' not found`);
                return;
            }

            // Update legacy setting if it exists
            if (feature.settingKey && this.settingsMap[feature.settingKey]) {
                this.settingsMap[feature.settingKey].isTrue = enabled;
            }

            // Update feature registry
            feature.enabled = enabled;

            await this.saveSettings();
        }

        /**
         * Toggle a feature
         * @param {string} featureKey - Feature key
         * @returns {boolean} New enabled state
         */
        async toggleFeature(featureKey) {
            const current = this.isFeatureEnabled(featureKey);
            await this.setFeatureEnabled(featureKey, !current);
            return !current;
        }

        /**
         * Get all features grouped by category
         * @returns {Object} Features grouped by category
         */
        getFeaturesByCategory() {
            const grouped = {};

            for (const [key, feature] of Object.entries(this.features)) {
                const category = feature.category || 'Other';
                if (!grouped[category]) {
                    grouped[category] = [];
                }
                grouped[category].push({
                    key,
                    name: feature.name,
                    description: feature.description,
                    enabled: this.isFeatureEnabled(key),
                });
            }

            return grouped;
        }

        /**
         * Get all feature keys
         * @returns {string[]} Array of feature keys
         */
        getFeatureKeys() {
            return Object.keys(this.features || {});
        }

        /**
         * Get feature info
         * @param {string} featureKey - Feature key
         * @returns {Object|null} Feature info with current enabled state
         */
        getFeatureInfo(featureKey) {
            const feature = this.features?.[featureKey];
            if (!feature) {
                return null;
            }

            return {
                key: featureKey,
                name: feature.name,
                category: feature.category,
                description: feature.description,
                enabled: this.isFeatureEnabled(featureKey),
            };
        }
    }

    const config = new Config();

    /**
     * Performance Monitor
     * Tracks execution time of features and DOM observer handlers
     * using a rolling window for CPU percentage calculations.
     */

    const WINDOW_MS = 5000;

    /**
     * When the script started, as the clock the rest of the timings are quoted
     * against. `performance.now()` is already relative to page navigation, but the
     * userscript runs at document-start and the difference matters when the
     * question is "what happened before my feature got a turn".
     */
    const BOOT_AT = typeof performance !== 'undefined' ? performance.now() : 0;

    class PerformanceMonitor {
        constructor() {
            this.measurements = new Map();
            this.snapshots = new Map();
            // Named moments on the startup timeline, in the order they happened
            this.marks = [];
            // Work that a snapshot was made of, broken into its parts
            this.spans = new Map();
            this.bootAt = BOOT_AT;
            this.windowMs = WINDOW_MS;
            this.enabled = false;
            this._onVisibilityChange = () => {
                this._tabVisible = !document.hidden;
            };
            this._tabVisible = true;
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', this._onVisibilityChange);
            }
        }

        /**
         * Record a timing measurement
         * @param {string} name - Metric name (e.g. "dom:MarketFilter", "init:tooltipPrices")
         * @param {number} durationMs - Duration in milliseconds
         */
        record(name, durationMs) {
            if (!this.enabled || !this._tabVisible) return;
            if (!this.measurements.has(name)) {
                this.measurements.set(name, []);
            }
            this.measurements.get(name).push({ time: Date.now(), duration: durationMs });
        }

        /**
         * Store a one-time snapshot measurement that persists beyond the rolling window
         *
         * `startedAt` is what makes a startup trace readable: a feature that took six
         * seconds is one fact, and whether it took them at second two or second
         * fourteen is a different one — and only the second says what else was
         * waiting behind it.
         *
         * @param {string} name - Metric name
         * @param {number} durationMs - Duration in milliseconds
         * @param {number} [startedAt] - Milliseconds since boot when it began
         */
        snapshot(name, durationMs, startedAt) {
            this.snapshots.set(name, {
                duration: durationMs,
                time: Date.now(),
                startedAt: startedAt ?? this.sinceBoot() - durationMs,
            });
        }

        /** @returns {number} Milliseconds since the script started */
        sinceBoot() {
            return (typeof performance !== 'undefined' ? performance.now() : 0) - this.bootAt;
        }

        /**
         * Note that something happened, and when.
         *
         * Marks answer the question a list of durations cannot: where did the gaps
         * go. Half of a slow start is usually spent waiting — for IndexedDB, for the
         * game's own data to arrive — and waiting shows up in nobody's duration.
         *
         * @param {string} name - What happened, e.g. `storage:open`
         * @param {Object} [detail] - Anything worth carrying alongside
         */
        mark(name, detail = null) {
            this.marks.push({ name, at: this.sinceBoot(), detail });
        }

        /**
         * Time a part of something already being timed.
         *
         * A feature that takes six seconds is a question, not an answer. Spans are
         * how the answer gets recorded — which call inside it was the six seconds —
         * and they are always on, because the run worth profiling is the one that
         * already happened.
         *
         * @param {string} name - Parent metric, e.g. `init:networth`
         * @param {string} part - What this piece is, e.g. `recalculate`
         * @returns {Function} Call it when the piece is done
         */
        startSpan(name, part) {
            const startedAt = this.sinceBoot();
            return () => {
                const duration = this.sinceBoot() - startedAt;
                if (!this.spans.has(name)) this.spans.set(name, []);
                this.spans.get(name).push({ part, duration, startedAt });
                return duration;
            };
        }

        /**
         * Run a function, recording how long its part took.
         *
         * @param {string} name - Parent metric
         * @param {string} part - What this piece is
         * @param {Function} fn - The work
         * @returns {*} Whatever the work returned
         */
        async span(name, part, fn) {
            const end = this.startSpan(name, part);
            try {
                return await fn();
            } finally {
                end();
            }
        }

        /** @returns {Array<Object>} The parts of one metric, longest first */
        getSpans(name) {
            return [...(this.spans.get(name) || [])].sort((a, b) => b.duration - a.duration);
        }

        /** @returns {Array<Object>} Every mark, in the order they happened */
        getMarks() {
            return [...this.marks].sort((a, b) => a.at - b.at);
        }

        /**
         * Wrap a function with automatic timing
         * @param {string} name - Metric name
         * @param {Function} fn - Function to wrap
         * @returns {Function} Wrapped function
         */
        wrap(name, fn) {
            const monitor = this;
            return function (...args) {
                if (!monitor.enabled || !monitor._tabVisible) return fn.apply(this, args);
                const start = performance.now();
                try {
                    const result = fn.apply(this, args);
                    if (result && typeof result.then === 'function') {
                        return result.finally(() => monitor.record(name, performance.now() - start));
                    }
                    monitor.record(name, performance.now() - start);
                    return result;
                } catch (error) {
                    monitor.record(name, performance.now() - start);
                    throw error;
                }
            };
        }

        /**
         * Get stats for a single metric within the rolling window
         * @param {string} name - Metric name
         * @returns {{ calls: number, totalMs: number, avgMs: number, cpuPercent: number } | null}
         */
        getStats(name) {
            const entries = this.measurements.get(name);
            if (!entries || entries.length === 0) return null;

            const cutoff = Date.now() - this.windowMs;
            let calls = 0;
            let totalMs = 0;

            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].time < cutoff) break;
                calls++;
                totalMs += entries[i].duration;
            }

            if (calls === 0) return null;

            return {
                calls,
                totalMs,
                avgMs: totalMs / calls,
                cpuPercent: Math.min((totalMs / this.windowMs) * 100, 100),
            };
        }

        /**
         * Get stats for all metrics, cleaning up stale data
         * @returns {Map<string, { calls: number, totalMs: number, avgMs: number, cpuPercent: number }>}
         */
        getAllStats() {
            this._cleanup();
            const result = new Map();

            for (const [name, entries] of this.measurements) {
                if (entries.length === 0) continue;
                const stats = this.getStats(name);
                if (stats) {
                    result.set(name, stats);
                }
            }

            return result;
        }

        /**
         * Remove measurements older than the rolling window
         * @private
         */
        _cleanup() {
            const cutoff = Date.now() - this.windowMs;
            for (const [name, entries] of this.measurements) {
                let firstValid = 0;
                while (firstValid < entries.length && entries[firstValid].time < cutoff) {
                    firstValid++;
                }
                if (firstValid > 0) {
                    entries.splice(0, firstValid);
                }
                if (entries.length === 0) {
                    this.measurements.delete(name);
                }
            }
        }

        /**
         * Get all snapshot measurements
         * @returns {Map<string, { duration: number, time: number }>}
         */
        getSnapshots() {
            return new Map(this.snapshots);
        }

        /**
         * Clear all measurements
         */
        reset() {
            this.measurements.clear();
            this.snapshots.clear();
            this.spans.clear();
            // Marks are the startup trace and cannot be taken again without a
            // reload, so resetting the rolling stats leaves them alone
        }
    }

    const performanceMonitor = new PerformanceMonitor();

    /**
     * Centralized DOM Observer
     * Single MutationObserver that dispatches to registered handlers
     * Replaces 15 separate observers watching document.body
     * Supports optional debouncing to reduce CPU usage during bulk DOM changes
     */


    class DOMObserver {
        constructor() {
            this.observer = null;
            this.handlers = [];
            this.isObserving = false;
            this.debounceTimers = new Map(); // Track debounce timers per handler
            this.debouncedLatest = new Map(); // Latest {node, mutation} per handler — O(1) retention
            this.DEFAULT_DEBOUNCE_DELAY = 50; // 50ms default delay
        }

        /**
         * Start observing DOM changes
         */
        start() {
            if (this.isObserving) return;

            // Wait for document.body to exist (critical for @run-at document-start)
            const startObserver = () => {
                if (!document.body) {
                    // Body doesn't exist yet, wait and try again
                    setTimeout(startObserver, 10);
                    return;
                }

                this.observer = new MutationObserver((mutations) => {
                    for (const mutation of mutations) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType !== Node.ELEMENT_NODE) continue;

                            // Dispatch to all registered handlers
                            this.handlers.forEach((handler) => {
                                try {
                                    if (handler.debounce) {
                                        this.debouncedCallback(handler, node, mutation);
                                    } else if (performanceMonitor.enabled) {
                                        const start = performance.now();
                                        handler.callback(node, mutation);
                                        performanceMonitor.record(`dom:${handler.name}`, performance.now() - start);
                                    } else {
                                        handler.callback(node, mutation);
                                    }
                                } catch (error) {
                                    console.error(`[DOM Observer] Handler error (${handler.name}):`, error);
                                }
                            });
                        }
                    }
                });

                this.observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                });

                this.isObserving = true;
            };

            startObserver();
        }

        /**
         * Debounced callback handler
         * Collects elements and fires callback after delay
         * @private
         */
        debouncedCallback(handler, node, mutation) {
            const handlerName = handler.name;
            const delay = handler.debounceDelay || this.DEFAULT_DEBOUNCE_DELAY;

            // Only the newest node/mutation is ever handed to the callback, so overwrite
            // rather than append: under churn faster than the debounce delay the timer never
            // fires, and an array would retain every intermediate node and MutationRecord.
            this.debouncedLatest.set(handlerName, { node, mutation });

            // Clear existing timer
            if (this.debounceTimers.has(handlerName)) {
                clearTimeout(this.debounceTimers.get(handlerName));
            }

            // Set new timer
            const timer = setTimeout(() => {
                const latest = this.debouncedLatest.get(handlerName);
                this.debouncedLatest.delete(handlerName);
                this.debounceTimers.delete(handlerName);

                // Only the final state matters (e.g. a task list rewritten several times)
                if (latest) {
                    if (performanceMonitor.enabled) {
                        const start = performance.now();
                        handler.callback(latest.node, latest.mutation);
                        performanceMonitor.record(`dom:${handler.name}`, performance.now() - start);
                    } else {
                        handler.callback(latest.node, latest.mutation);
                    }
                }
            }, delay);

            this.debounceTimers.set(handlerName, timer);
        }

        /**
         * Stop observing DOM changes
         */
        stop() {
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }

            // Clear all debounce timers
            this.debounceTimers.forEach((timer) => clearTimeout(timer));
            this.debounceTimers.clear();
            this.debouncedLatest.clear();

            this.isObserving = false;
        }

        /**
         * Register a handler for DOM changes
         * @param {string} name - Handler name for debugging
         * @param {Function} callback - Function to call when nodes are added (receives node, mutation)
         * @param {Object} options - Optional configuration
         * @param {boolean} options.debounce - Enable debouncing (default: false)
         * @param {number} options.debounceDelay - Debounce delay in ms (default: 50)
         * @returns {Function} Unregister function
         */
        register(name, callback, options = {}) {
            const handler = {
                name,
                callback,
                debounce: options.debounce || false,
                debounceDelay: options.debounceDelay,
            };
            this.handlers.push(handler);

            // Return unregister function
            return () => {
                const index = this.handlers.indexOf(handler);
                if (index > -1) {
                    this.handlers.splice(index, 1);

                    // Clean up any pending debounced callbacks
                    if (this.debounceTimers.has(name)) {
                        clearTimeout(this.debounceTimers.get(name));
                        this.debounceTimers.delete(name);
                        this.debouncedLatest.delete(name);
                    }
                }
            };
        }

        /**
         * Register a handler for specific class names
         * @param {string} name - Handler name for debugging
         * @param {string|string[]} classNames - Class name(s) to watch for (supports partial matches)
         * @param {Function} callback - Function to call when matching elements appear
         * @param {Object} options - Optional configuration
         * @param {boolean} options.debounce - Enable debouncing (default: false for immediate response)
         * @param {number} options.debounceDelay - Debounce delay in ms (default: 50)
         * @returns {Function} Unregister function
         */
        onClass(name, classNames, callback, options = {}) {
            const classArray = Array.isArray(classNames) ? classNames : [classNames];

            return this.register(
                name,
                (node) => {
                    // Safely get className as string (handles SVG elements)
                    const className = typeof node.className === 'string' ? node.className : '';

                    // Check if node matches any of the target classes
                    for (const targetClass of classArray) {
                        if (className.includes(targetClass)) {
                            callback(node);
                            return; // Only call once per node
                        }
                    }

                    // Also check descendants when a container subtree is inserted.
                    // Only applies when the node has children — leaf nodes are skipped,
                    // which eliminates the bulk of querySelectorAll cost during React's
                    // init burst (thousands of individual leaf additions).
                    if (node.childElementCount > 0) {
                        for (const targetClass of classArray) {
                            const matches = node.querySelectorAll(`[class*="${targetClass}"]`);
                            matches.forEach((match) => callback(match));
                        }
                    }
                },
                options
            );
        }

        /**
         * Get stats about registered handlers
         */
        getStats() {
            return {
                isObserving: this.isObserving,
                handlerCount: this.handlers.length,
                handlers: this.handlers.map((h) => ({
                    name: h.name,
                    debounced: h.debounce || false,
                })),
                pendingCallbacks: this.debounceTimers.size,
            };
        }
    }

    const domObserver = new DOMObserver();

    /**
     * Feature Registry
     * Centralized feature initialization system
     */


    /**
     * Feature Registry
     * Populated at runtime by the entrypoint to avoid bundling feature code in core.
     */
    const featureRegistry = [];

    /**
     * Initialize all enabled features
     *
     * Returns what failed rather than only logging it. An initializer that throws
     * used to reach the player as a feature that is simply absent, with the reason
     * in a console nobody has open; the caller needs the list to be able to say so.
     *
     * @returns {Promise<Array<{key: string, name: string, reason: string}>>} Failures, in registry order
     */
    async function initializeFeatures() {
        // Block feature initialization during character switch
        if (dataManager.getIsCharacterSwitching()) {
            return [];
        }

        const errors = [];
        performanceMonitor.mark('features:start', { registered: featureRegistry.length });

        for (const feature of featureRegistry) {
            try {
                const isEnabled = feature.customCheck ? feature.customCheck() : config.isFeatureEnabled(feature.key);

                if (!isEnabled) {
                    continue;
                }

                // Initialize feature. Always await so rejections from async
                // initializers land in this try/catch even when the registry
                // entry forgot to set the async flag (awaiting sync undefined
                // is harmless).
                //
                // The timing is split on purpose. The old single wall-clock span
                // around `await feature.initialize()` blamed a feature for time
                // it merely *parked* in — a sync feature (e.g. autoAllButton) that
                // happens to `await undefined` at the moment a heavy storage read
                // resolves elsewhere would absorb that read's cost and top the
                // "slowest features" list while doing nothing. `own` is the
                // feature's synchronous work up to the point it returns/suspends;
                // `total` still spans the await so a genuinely async initializer is
                // not undercounted. A large gap between them means the cost is
                // deferred work draining here, not this feature.
                const startedAt = performanceMonitor.sinceBoot();
                const pending = feature.initialize();
                const ownMs = performanceMonitor.sinceBoot() - startedAt;
                await pending;
                const totalMs = performanceMonitor.sinceBoot() - startedAt;
                performanceMonitor.snapshot(`init:${feature.key}`, totalMs, startedAt);
                if (totalMs - ownMs >= 1) {
                    performanceMonitor.snapshot(`init:${feature.key}:own`, ownMs, startedAt);
                }
            } catch (error) {
                errors.push({
                    key: feature.key,
                    name: feature.name,
                    reason: `Initialization threw: ${error.message}`,
                });
                console.error(`[Toolasha] Failed to initialize ${feature.name}:`, error);
            }
        }

        performanceMonitor.mark('features:done', { failed: errors.length });

        // Log errors if any occurred
        if (errors.length > 0) {
            console.error(`[Toolasha] ${errors.length} feature(s) failed to initialize`, errors);
        }

        return errors;
    }

    /**
     * Get feature by key
     * @param {string} key - Feature key
     * @returns {Object|null} Feature definition or null
     */
    function getFeature(key) {
        return featureRegistry.find((f) => f.key === key) || null;
    }

    /**
     * Get all features
     * @returns {Array} Feature registry
     */
    function getAllFeatures() {
        return [...featureRegistry];
    }

    /**
     * Get features by category
     * @param {string} category - Category name
     * @returns {Array} Features in category
     */
    function getFeaturesByCategory(category) {
        return featureRegistry.filter((f) => f.category === category);
    }

    /**
     * Check health of all initialized features
     * @returns {Array<Object>} Array of failed features with details
     */
    function checkFeatureHealth() {
        const failed = [];

        for (const feature of featureRegistry) {
            // Skip if feature has no health check
            if (!feature.healthCheck) continue;

            // Skip if feature is not enabled
            const isEnabled = feature.customCheck ? feature.customCheck() : config.isFeatureEnabled(feature.key);

            if (!isEnabled) continue;

            try {
                const result = feature.healthCheck();

                // null = can't verify (DOM not ready), false = failed, true = healthy
                if (result === false) {
                    failed.push({
                        key: feature.key,
                        name: feature.name,
                        reason: 'Health check returned false',
                    });
                }
            } catch (error) {
                failed.push({
                    key: feature.key,
                    name: feature.name,
                    reason: `Health check error: ${error.message}`,
                });
            }
        }

        return failed;
    }

    /**
     * Setup character switch handler
     * Re-initializes all features when character switches
     */
    /**
     * Disable every active feature — the cleanup half of a character switch.
     * @returns {Promise<void>}
     */
    async function disableAllFeatures() {
        const cleanupPromises = [];
        for (const feature of featureRegistry) {
            try {
                const featureInstance = getFeatureInstance(feature.key);
                if (featureInstance && typeof featureInstance.disable === 'function') {
                    const result = featureInstance.disable();
                    if (result && typeof result.then === 'function') {
                        cleanupPromises.push(
                            result.catch((error) => {
                                console.error(`[FeatureRegistry] Failed to disable ${feature.name}:`, error);
                            })
                        );
                    }
                }
            } catch (error) {
                console.error(`[FeatureRegistry] Failed to disable ${feature.name}:`, error);
            }
        }
        if (cleanupPromises.length > 0) {
            await Promise.all(cleanupPromises);
        }
    }

    /**
     * Re-initialize all features when the character switches.
     *
     * The switch is driven off two events — `character_switching` (tear down) and
     * `character_switched` (reload settings, re-enable) — and rapid switches used to
     * corrupt the result two ways: a boolean "reinit scheduled" guard silently
     * *dropped* a later switch (A→B→A ended with B's per-character settings applied
     * under A), and `Promise.race([cleanup, setTimeout(500)])` let a rebuild start
     * before the previous character's teardown finished, so init overlapped cleanup.
     *
     * This serializes the whole lifecycle through one promise chain — cleanup and
     * reinit for any switch, and successive switches, run strictly in order, none
     * dropped. And each reinit verifies it is still for the current character
     * (`currentCharacterId` is updated to the new target before `character_switched`
     * fires) before and after every await, so a reinit a newer switch has
     * superseded aborts instead of clobbering the newer character's state — the
     * "latest character wins" invariant. Ported from upstream Celasha/Toolasha#622.
     */
    function setupCharacterSwitchHandler() {
        // One chain that every switch step is appended to, so no two ever overlap.
        let lifecycleChain = Promise.resolve();
        const enqueue = (step) => {
            lifecycleChain = lifecycleChain.then(step).catch((error) => {
                console.error('[FeatureRegistry] Character-switch lifecycle step failed:', error);
            });
            return lifecycleChain;
        };

        // Cleanup phase
        dataManager.on('character_switching', () => {
            // Clear the config cache synchronously, before the chain awaits anything,
            // so nothing reads the previous character's settings in the gap.
            if (config && typeof config.clearSettingsCache === 'function') {
                config.clearSettingsCache();
            }
            enqueue(() => disableAllFeatures());
        });

        // Re-initialization phase
        dataManager.on('character_switched', (data) => {
            const targetId = data?.newId ?? null;
            // Still the character this reinit is for? A newer switch updates
            // currentCharacterId synchronously, so a mismatch means this one is stale.
            const isStale = () => targetId !== null && dataManager.getCurrentCharacterId() !== targetId;

            enqueue(async () => {
                if (isStale()) return;

                // Load settings BEFORE any feature initialization so every feature
                // sees the new character's values (loadSettings reads the current id).
                await config.loadSettings();
                config.applyColorSettings();
                if (isStale()) return;

                // Small delay to let game state settle, then re-init with fresh settings
                await new Promise((resolve) => setTimeout(resolve, 50));
                if (isStale()) return;

                await initializeFeatures();
            });
        });
    }

    /**
     * Get feature instance from imported module
     * @param {string} key - Feature key
     * @returns {Object|null} Feature instance or null
     * @private
     */
    function getFeatureInstance(key) {
        const feature = getFeature(key);
        if (!feature) {
            return null;
        }

        return feature.module || feature;
    }

    /**
     * Retry initialization for specific features
     *
     * Reports back what is still broken afterwards, so a caller can tell the
     * difference between a feature that recovered on the second attempt — the
     * common case, where the game panel it anchors to had not been drawn yet — and
     * one that is genuinely not coming up. Only the second is worth interrupting
     * anybody about.
     *
     * @param {Array<Object>} failedFeatures - Array of failed feature objects
     * @returns {Promise<Array<{key: string, name: string, reason: string}>>} Those still failing
     */
    async function retryFailedFeatures(failedFeatures) {
        const stillFailed = [];

        for (const failed of failedFeatures) {
            const feature = getFeature(failed.key);
            if (!feature) continue;

            try {
                await feature.initialize();

                // Verify the retry actually worked by running health check
                if (feature.healthCheck) {
                    const healthResult = feature.healthCheck();
                    if (healthResult === false) {
                        console.warn(`[Toolasha] ${feature.name} retry completed but health check still fails`);
                        stillFailed.push({
                            key: feature.key,
                            name: feature.name,
                            reason: 'Retried, but its health check still fails',
                        });
                    }
                }
            } catch (error) {
                console.error(`[Toolasha] ${feature.name} retry failed:`, error);
                stillFailed.push({
                    key: feature.key,
                    name: feature.name,
                    reason: `Retry threw: ${error.message}`,
                });
            }
        }

        return stillFailed;
    }

    /**
     * Replace the feature registry (for library split)
     * @param {Array} newFeatures - New feature registry array
     */
    function replaceFeatures(newFeatures) {
        featureRegistry.length = 0; // Clear existing array
        featureRegistry.push(...newFeatures); // Add new features
    }

    var featureRegistry$1 = {
        initializeFeatures,
        setupCharacterSwitchHandler,
        checkFeatureHealth,
        retryFailedFeatures,
        getFeature,
        getAllFeatures,
        replaceFeatures,
        getFeaturesByCategory,
    };

    /**
     * Tooltip Observer
     * Centralized observer for tooltip/popper appearances
     * Any feature can subscribe to be notified when tooltips appear
     */


    class TooltipObserver {
        constructor() {
            this.subscribers = new Map(); // name -> callback
            this.unregisterObserver = null;
            this.isInitialized = false;
        }

        /**
         * Initialize the observer (call once)
         */
        initialize() {
            if (this.isInitialized) {
                return;
            }

            this.isInitialized = true;

            // Watch for tooltip/popper elements appearing
            // These are the common classes used by MUI tooltips/poppers
            this.unregisterObserver = domObserver.onClass('TooltipObserver', ['MuiPopper', 'MuiTooltip'], (element) => {
                this.notifySubscribers(element);
            });
        }

        /**
         * Subscribe to tooltip appearance events
         * @param {string} name - Unique subscriber name
         * @param {Function} callback - Function(element) to call when tooltip appears
         */
        subscribe(name, callback) {
            this.subscribers.set(name, callback);

            // Auto-initialize if first subscriber
            if (!this.isInitialized) {
                this.initialize();
            }
        }

        /**
         * Unsubscribe from tooltip events
         * @param {string} name - Subscriber name
         */
        unsubscribe(name) {
            this.subscribers.delete(name);

            // If no subscribers left, could optionally stop observing
            // For now, keep observer active for simplicity
        }

        /**
         * Notify all subscribers that a tooltip appeared
         * @param {Element} element - The tooltip/popper element
         * @private
         */
        notifySubscribers(element) {
            // Set up observer to detect when this specific tooltip is removed
            const removalObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const removedNode of mutation.removedNodes) {
                        if (removedNode === element) {
                            // Notify subscribers that tooltip closed
                            for (const [name, callback] of this.subscribers.entries()) {
                                try {
                                    callback(element, 'closed');
                                } catch (error) {
                                    console.error(`[TooltipObserver] Error in subscriber "${name}" (close):`, error);
                                }
                            }
                            removalObserver.disconnect();
                            return;
                        }
                    }
                }
            });

            // Watch the parent for removal of this tooltip
            if (element.parentNode) {
                removalObserver.observe(element.parentNode, {
                    childList: true,
                });
            }

            // Notify subscribers that tooltip opened
            for (const [name, callback] of this.subscribers.entries()) {
                try {
                    callback(element, 'opened');
                } catch (error) {
                    console.error(`[TooltipObserver] Error in subscriber "${name}" (open):`, error);
                }
            }
        }

        /**
         * Cleanup and disable
         */
        disable() {
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }
            this.subscribers.clear();
            this.isInitialized = false;
        }
    }

    const tooltipObserver = new TooltipObserver();

    /**
     * Network Alert Display
     * Shows a warning message when market data cannot be fetched
     */


    class NetworkAlert {
        constructor() {
            this.container = null;
            this.unregisterHandlers = [];
            this.isVisible = false;
        }

        /**
         * Initialize network alert display
         */
        initialize() {
            if (!config.getSetting('networkAlert')) {
                return;
            }

            // 1. Check if header exists already
            const existingElem = document.querySelector('[class*="Header_totalLevel"]');
            if (existingElem) {
                this.prepareContainer(existingElem);
            }

            // 2. Watch for header to appear (handles SPA navigation)
            const unregister = domObserver.onClass('NetworkAlert', 'Header_totalLevel', (elem) => {
                this.prepareContainer(elem);
            });
            this.unregisterHandlers.push(unregister);
        }

        /**
         * Prepare container but don't show yet
         * @param {Element} totalLevelElem - Total level element
         */
        prepareContainer(totalLevelElem) {
            // Check if already prepared
            if (this.container && document.body.contains(this.container)) {
                return;
            }

            // Remove any existing container
            if (this.container) {
                this.container.remove();
            }

            // Create container (hidden by default)
            this.container = document.createElement('div');
            this.container.className = 'mwi-network-alert';
            this.container.style.cssText = `
            display: none;
            font-size: 0.875rem;
            font-weight: 500;
            color: #ff4444;
            text-wrap: nowrap;
            margin-left: 16px;
        `;

            // Insert after total level (or after networth if it exists)
            const networthElem = totalLevelElem.parentElement.querySelector('.mwi-networth-header');
            if (networthElem) {
                networthElem.insertAdjacentElement('afterend', this.container);
            } else {
                totalLevelElem.insertAdjacentElement('afterend', this.container);
            }
        }

        /**
         * Show the network alert
         * @param {string} message - Alert message to display
         */
        show(message = '⚠️ Market data unavailable') {
            if (!config.getSetting('networkAlert')) {
                return;
            }

            if (!this.container || !document.body.contains(this.container)) {
                // Try to prepare container if not ready
                const totalLevelElem = document.querySelector('[class*="Header_totalLevel"]');
                if (totalLevelElem) {
                    this.prepareContainer(totalLevelElem);
                } else {
                    // Header not found, fallback to console
                    console.warn('[Network Alert]', message);
                    return;
                }
            }

            if (this.container) {
                this.container.textContent = message;
                this.container.style.display = 'block';
                this.isVisible = true;
            }
        }

        /**
         * Hide the network alert
         */
        hide() {
            if (this.container && document.body.contains(this.container)) {
                this.container.style.display = 'none';
                this.isVisible = false;
            }
        }

        /**
         * Cleanup
         */
        disable() {
            this.hide();

            if (this.container) {
                this.container.remove();
                this.container = null;
            }

            this.unregisterHandlers.forEach((unregister) => unregister());
            this.unregisterHandlers = [];
        }
    }

    const networkAlert = new NetworkAlert();

    /**
     * Marketplace API Module
     * Fetches and caches market price data from the MWI marketplace API
     */


    /**
     * MarketAPI class handles fetching and caching market price data
     */
    class MarketAPI {
        constructor() {
            // API endpoint
            this.API_URL = 'https://www.milkywayidle.com/game_data/marketplace.json';

            // Cache settings
            this.CACHE_DURATION = 15 * 60 * 1000; // 15 minutes in milliseconds
            this.CACHE_KEY_DATA = 'Toolasha_marketAPI_json';
            this.CACHE_KEY_TIMESTAMP = 'Toolasha_marketAPI_timestamp';
            this.CACHE_KEY_PATCHES = 'Toolasha_marketAPI_patches';
            this.CACHE_KEY_MIGRATION = 'Toolasha_marketAPI_migration_version';
            this.CURRENT_MIGRATION_VERSION = 1; // Increment this when patches need to be cleared

            // Current market data
            this.marketData = null;
            this.lastFetchTimestamp = null;
            this.errorLog = [];

            // Price patches from order book data (fresher than API)
            // Structure: { "itemHrid:enhLevel": { a: ask, b: bid, timestamp: ms } }
            this.pricePatchs = {};

            // Event listeners for price updates
            this.listeners = [];
        }

        /**
         * Fetch market data from API or cache
         * @param {boolean} forceFetch - Force a fresh fetch even if cache is valid
         * @returns {Promise<Object|null>} Market data object or null if failed
         */
        async fetch(forceFetch = false) {
            // Check cache first (unless force fetch)
            if (!forceFetch) {
                const cached = await this.getCachedData();
                if (cached) {
                    this.marketData = cached.data;
                    // API timestamp is in seconds, convert to milliseconds for comparison with Date.now()
                    this.lastFetchTimestamp = cached.timestamp * 1000;
                    // Load patches from storage
                    await this.loadPatches();
                    // Hide alert on successful cache load
                    networkAlert.hide();
                    // Notify listeners (initial load)
                    this.notifyListeners();
                    return this.marketData;
                }
            }

            if (!connectionState.isConnected()) {
                const cachedFallback = await storage.getJSON(this.CACHE_KEY_DATA, 'settings', null);
                if (cachedFallback?.marketData) {
                    this.marketData = cachedFallback.marketData;
                    // API timestamp is in seconds, convert to milliseconds
                    this.lastFetchTimestamp = cachedFallback.timestamp * 1000;
                    // Load patches from storage
                    await this.loadPatches();
                    console.warn('[MarketAPI] Skipping fetch; disconnected. Using cached data.');
                    return this.marketData;
                }

                console.warn('[MarketAPI] Skipping fetch; disconnected and no cache available');
                return null;
            }

            // Try to fetch fresh data
            let rateLimited = false;
            try {
                const response = await this.fetchFromAPI();

                if (response) {
                    // Cache the fresh data
                    this.cacheData(response);
                    this.marketData = response.marketData;
                    // API timestamp is in seconds, convert to milliseconds
                    this.lastFetchTimestamp = response.timestamp * 1000;
                    // Load patches from storage (they may still be fresher than new API data)
                    await this.loadPatches();
                    // Hide alert on successful fetch
                    networkAlert.hide();
                    // Notify listeners of price update
                    this.notifyListeners();
                    return this.marketData;
                }
            } catch (error) {
                // marketplace.json is rate-limited by the game: a burst of requests —
                // often several userscripts hitting it at once — trips a temporary
                // CloudFront 403 (429 is the explicit rate-limit status). Call that out
                // plainly instead of as a generic fetch failure, so a player seeing the
                // block knows what it is and that Toolasha is not the cause on its own.
                rateLimited = error?.status === 403 || error?.status === 429;
                if (rateLimited) {
                    console.warn(
                        `[MarketAPI] marketplace.json returned ${error.status} — the game rate-limits this file and a burst ` +
                            'of fetches (often several userscripts at once) trips a temporary block. Falling back to cached ' +
                            'prices; it retries on the normal 15-minute cache cadence.'
                    );
                }
                this.logError(rateLimited ? `Rate limited (${error.status})` : 'Fetch failed', error);
            }

            // Fallback: Try to use expired cache
            const expiredCache = await storage.getJSON(this.CACHE_KEY_DATA, 'settings', null);
            if (expiredCache) {
                console.warn('[MarketAPI] Using expired cache as fallback');
                this.marketData = expiredCache.marketData;
                // API timestamp is in seconds, convert to milliseconds
                this.lastFetchTimestamp = expiredCache.timestamp * 1000;
                // Load patches from storage
                await this.loadPatches();
                // Show alert when using expired cache
                networkAlert.show(
                    rateLimited ? '⚠️ Market API rate-limited — using cached prices' : '⚠️ Using outdated market data'
                );
                return this.marketData;
            }

            // Total failure - show alert
            console.error('[MarketAPI] ❌ No market data available');
            networkAlert.show(rateLimited ? '⚠️ Market API rate-limited — no market data' : '⚠️ Market data unavailable');
            return null;
        }

        /**
         * Fetch from API endpoint
         * @returns {Promise<Object|null>} API response or null
         */
        async fetchFromAPI() {
            try {
                const response = await fetch(this.API_URL);

                if (!response.ok) {
                    // Carry the status so fetch() can tell a rate-limit (403/429) from
                    // any other failure and message the player accordingly.
                    const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
                    error.status = response.status;
                    throw error;
                }

                const data = await response.json();

                // Validate response structure
                if (!data.marketData || typeof data.marketData !== 'object') {
                    throw new Error('Invalid API response structure');
                }

                return data;
            } catch (error) {
                console.error('[MarketAPI] API fetch error:', error);
                throw error;
            }
        }

        /**
         * Get cached data if valid
         * @returns {Promise<Object|null>} { data, timestamp } or null if invalid/expired
         */
        async getCachedData() {
            const cachedTimestamp = await storage.get(this.CACHE_KEY_TIMESTAMP, 'settings', null);
            const cachedData = await storage.getJSON(this.CACHE_KEY_DATA, 'settings', null);

            if (!cachedTimestamp || !cachedData) {
                return null;
            }

            // Check if cache is still valid
            const now = Date.now();
            const age = now - cachedTimestamp;

            if (age > this.CACHE_DURATION) {
                return null;
            }

            return {
                data: cachedData.marketData,
                timestamp: cachedData.timestamp,
            };
        }

        /**
         * Cache market data
         * @param {Object} data - API response to cache
         */
        cacheData(data) {
            storage.setJSON(this.CACHE_KEY_DATA, data, 'settings');
            storage.set(this.CACHE_KEY_TIMESTAMP, Date.now(), 'settings');
        }

        /**
         * Get price for an item
         * @param {string} itemHrid - Item HRID (e.g., "/items/cheese")
         * @param {number} enhancementLevel - Enhancement level (default: 0)
         * @returns {Object|null} { ask: number, bid: number } or null if not found
         */
        getPrice(itemHrid, enhancementLevel = 0) {
            const normalizeMarketPriceValue = (value) => {
                if (typeof value !== 'number') {
                    return null;
                }

                if (value < 0) {
                    return null;
                }

                return value;
            };

            // Check for fresh patch first
            const patchKey = `${itemHrid}:${enhancementLevel}`;
            const patch = this.pricePatchs[patchKey];

            if (patch && patch.timestamp > this.lastFetchTimestamp) {
                // Patch is fresher than API data - use it
                return {
                    ask: normalizeMarketPriceValue(patch.a),
                    bid: normalizeMarketPriceValue(patch.b),
                };
            }

            // Fall back to API data
            if (!this.marketData) {
                console.warn('[MarketAPI] ⚠️ No market data available');
                return null;
            }

            const priceData = this.marketData[itemHrid];

            if (!priceData || typeof priceData !== 'object') {
                // Item not in market data at all
                return null;
            }

            // Market data is organized by enhancement level
            // { 0: { a: 1000, b: 900 }, 2: { a: 5000, b: 4500 }, ... }
            const price = priceData[enhancementLevel];

            if (!price) {
                // No price data for this enhancement level
                return null;
            }

            return {
                ask: normalizeMarketPriceValue(price.a), // Sell price
                bid: normalizeMarketPriceValue(price.b), // Buy price
            };
        }

        /**
         * Get prices for multiple items
         * @param {string[]} itemHrids - Array of item HRIDs
         * @returns {Map<string, Object>} Map of HRID -> { ask, bid }
         */
        getPrices(itemHrids) {
            const prices = new Map();

            for (const hrid of itemHrids) {
                const price = this.getPrice(hrid);
                if (price) {
                    prices.set(hrid, price);
                }
            }

            return prices;
        }

        /**
         * Get prices for multiple items with enhancement levels (batch optimized)
         * @param {Array<{itemHrid: string, enhancementLevel: number}>} items - Array of items with enhancement levels
         * @returns {Map<string, Object>} Map of "hrid:level" -> { ask, bid }
         */
        getPricesBatch(items) {
            const priceMap = new Map();

            for (const { itemHrid, enhancementLevel = 0 } of items) {
                const key = `${itemHrid}:${enhancementLevel}`;
                if (!priceMap.has(key)) {
                    const price = this.getPrice(itemHrid, enhancementLevel);
                    if (price) {
                        priceMap.set(key, price);
                    }
                }
            }

            return priceMap;
        }

        /**
         * Check if market data is loaded
         * @returns {boolean} True if data is available
         */
        isLoaded() {
            return this.marketData !== null;
        }

        /**
         * Get age of current data in milliseconds
         * @returns {number|null} Age in ms or null if no data
         */
        getDataAge() {
            if (!this.lastFetchTimestamp) {
                return null;
            }

            return Date.now() - this.lastFetchTimestamp;
        }

        /**
         * Log an error
         * @param {string} message - Error message
         * @param {Error} error - Error object
         */
        logError(message, error) {
            const errorEntry = {
                timestamp: new Date().toISOString(),
                message,
                error: error?.message || String(error),
            };

            this.errorLog.push(errorEntry);
            console.error(`[MarketAPI] ${message}:`, error);
        }

        /**
         * Get error log
         * @returns {Array} Array of error entries
         */
        getErrors() {
            return [...this.errorLog];
        }

        /**
         * Clear error log
         */
        clearErrors() {
            this.errorLog = [];
        }

        /**
         * Update price from order book data (fresher than API)
         * @param {string} itemHrid - Item HRID
         * @param {number} enhancementLevel - Enhancement level
         * @param {number|null} ask - Top ask price (null if no asks)
         * @param {number|null} bid - Top bid price (null if no bids)
         */
        updatePrice(itemHrid, enhancementLevel, ask, bid) {
            const key = `${itemHrid}:${enhancementLevel}`;

            this.pricePatchs[key] = {
                a: ask,
                b: bid,
                timestamp: Date.now(),
            };

            // Save patches to storage (debounced via storage module)
            this.savePatches();

            // Notify listeners of price update
            this.notifyListeners();
        }

        /**
         * Load price patches from storage
         */
        async loadPatches() {
            try {
                // Check migration version - clear patches if old version
                const migrationVersion = await storage.get(this.CACHE_KEY_MIGRATION, 'settings', 0);

                if (migrationVersion < this.CURRENT_MIGRATION_VERSION) {
                    console.log(
                        `[MarketAPI] Migrating price patches from v${migrationVersion} to v${this.CURRENT_MIGRATION_VERSION}`
                    );
                    // Clear old patches (they may have corrupted data)
                    this.pricePatchs = {};
                    await storage.set(this.CACHE_KEY_PATCHES, {}, 'settings');
                    await storage.set(this.CACHE_KEY_MIGRATION, this.CURRENT_MIGRATION_VERSION, 'settings');
                    console.log('[MarketAPI] Price patches cleared due to migration');
                    return;
                }

                // Load patches normally
                const patches = await storage.getJSON(this.CACHE_KEY_PATCHES, 'settings', {});
                this.pricePatchs = patches || {};

                // Purge stale patches (older than API data)
                this.purgeStalePatches();
            } catch (error) {
                console.error('[MarketAPI] Failed to load price patches:', error);
                this.pricePatchs = {};
            }
        }

        /**
         * Remove patches older than the current API data
         * Called after loadPatches() to clean up stale patches
         */
        purgeStalePatches() {
            if (!this.lastFetchTimestamp) {
                return; // No API data loaded yet
            }

            let purgedCount = 0;
            const keysToDelete = [];

            for (const [key, patch] of Object.entries(this.pricePatchs)) {
                // Check for corrupted/invalid patches or stale timestamps
                if (!patch || !patch.timestamp || patch.timestamp < this.lastFetchTimestamp) {
                    keysToDelete.push(key);
                    purgedCount++;
                }
            }

            // Remove stale patches
            for (const key of keysToDelete) {
                delete this.pricePatchs[key];
            }

            if (purgedCount > 0) {
                console.log(`[MarketAPI] Purged ${purgedCount} stale price patches`);
                // Save cleaned patches
                this.savePatches();
            }
        }

        /**
         * Save price patches to storage (debounced by the storage module; pending
         * writes are flushed on unload via storage.flushAll())
         */
        savePatches() {
            storage.setJSON(this.CACHE_KEY_PATCHES, this.pricePatchs, 'settings');
        }

        /**
         * Clear cache and fetch fresh market data
         * @returns {Promise<Object|null>} Fresh market data or null if failed
         */
        async clearCacheAndRefetch() {
            // Clear storage cache
            await storage.delete(this.CACHE_KEY_DATA, 'settings');
            await storage.delete(this.CACHE_KEY_TIMESTAMP, 'settings');

            // Clear in-memory state
            this.marketData = null;
            this.lastFetchTimestamp = null;

            // Force fresh fetch
            return await this.fetch(true);
        }

        /**
         * Register a listener for price updates
         * @param {Function} callback - Called when prices update
         */
        on(callback) {
            this.listeners.push(callback);
        }

        /**
         * Unregister a listener
         * @param {Function} callback - The callback to remove
         */
        off(callback) {
            this.listeners = this.listeners.filter((cb) => cb !== callback);
        }

        /**
         * Notify all listeners that prices have been updated
         */
        notifyListeners() {
            for (const callback of this.listeners) {
                try {
                    callback();
                } catch (error) {
                    console.error('[MarketAPI] Listener error:', error);
                }
            }
        }
    }

    const marketAPI = new MarketAPI();

    /**
     * Foundation Core Library
     * Core infrastructure and API clients only (no utilities)
     *
     * Exports to: window.Toolasha.Core
     */


    // Export to global namespace
    const toolashaRoot = window.Toolasha || {};
    window.Toolasha = toolashaRoot;

    if (typeof unsafeWindow !== 'undefined') {
        unsafeWindow.Toolasha = toolashaRoot;
    }

    toolashaRoot.Core = {
        storage,
        config,
        webSocketHook,
        domObserver,
        dataManager,
        featureRegistry: featureRegistry$1,
        settingsStorage,
        settingsGroups,
        getAllSettingIds,
        getSettingDefinition,
        tooltipObserver,
        profileManager: {
            setCurrentProfile,
            getCurrentProfile,
            clearCurrentProfile,
        },
        marketAPI,
        performanceMonitor,
    };

    console.log('[Toolasha] Core library loaded');

})();
