/**
 * Centralized DOM Observer
 * Single MutationObserver that dispatches to registered handlers
 * Replaces 15 separate observers watching document.body
 * Supports optional debouncing to reduce CPU usage during bulk DOM changes
 */

import performanceMonitor from '../utils/performance-monitor.js';

class DOMObserver {
    constructor() {
        this.observer = null;
        this.handlers = [];
        this.isObserving = false;
        this.debounceTimers = new Map(); // Track debounce timers per handler
        this.debouncedLatest = new Map(); // Latest {node, mutation} per handler — O(1) retention
        this.debounceMaxStart = new Map(); // When the oldest un-fired mutation arrived, for maxWait
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
        const maxWait = handler.debounceMaxWait || 0;

        // Only the newest node/mutation is ever handed to the callback, so overwrite
        // rather than append: under churn faster than the debounce delay the timer never
        // fires, and an array would retain every intermediate node and MutationRecord.
        this.debouncedLatest.set(handlerName, { node, mutation });

        const invoke = () => {
            if (this.debounceTimers.has(handlerName)) {
                clearTimeout(this.debounceTimers.get(handlerName));
                this.debounceTimers.delete(handlerName);
            }
            this.debounceMaxStart.delete(handlerName);

            const latest = this.debouncedLatest.get(handlerName);
            this.debouncedLatest.delete(handlerName);

            // Only the final state matters (e.g. a task list rewritten several times)
            if (!latest) return;
            if (performanceMonitor.enabled) {
                const start = performance.now();
                handler.callback(latest.node, latest.mutation);
                performanceMonitor.record(`dom:${handler.name}`, performance.now() - start);
            } else {
                handler.callback(latest.node, latest.mutation);
            }
        };

        // maxWait bounds the trailing debounce. A burst arriving faster than
        // `delay` keeps resetting the timer, so a handler watching a container
        // that never stops mutating — a live panel with a bar ticking every
        // second — would starve and never run. Once the oldest un-fired mutation
        // is `maxWait` old, the next one fires the callback instead of deferring
        // it again, so first paint still happens under continuous churn. Opt-in:
        // maxWait 0 (the default) is the exact prior trailing-only behaviour.
        if (maxWait > 0) {
            const startedAt = this.debounceMaxStart.get(handlerName);
            if (startedAt === undefined) {
                this.debounceMaxStart.set(handlerName, Date.now());
            } else if (Date.now() - startedAt >= maxWait) {
                invoke();
                return;
            }
        }

        // Clear existing timer and set a new one
        if (this.debounceTimers.has(handlerName)) {
            clearTimeout(this.debounceTimers.get(handlerName));
        }
        this.debounceTimers.set(handlerName, setTimeout(invoke, delay));
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
        this.debounceMaxStart.clear();

        this.isObserving = false;
    }

    /**
     * Register a handler for DOM changes
     * @param {string} name - Handler name for debugging
     * @param {Function} callback - Function to call when nodes are added (receives node, mutation)
     * @param {Object} options - Optional configuration
     * @param {boolean} options.debounce - Enable debouncing (default: false)
     * @param {number} options.debounceDelay - Debounce delay in ms (default: 50)
     * @param {number} options.debounceMaxWait - Max ms the debounce may defer under continuous churn before firing (default: 0 = unbounded)
     * @returns {Function} Unregister function
     */
    register(name, callback, options = {}) {
        const handler = {
            name,
            callback,
            debounce: options.debounce || false,
            debounceDelay: options.debounceDelay,
            debounceMaxWait: options.debounceMaxWait,
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
                this.debounceMaxStart.delete(name);
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

export default domObserver;
