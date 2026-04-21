/**
 * Optimized EventQueue with indexed binary heap.
 *
 * Two key optimizations over the original:
 * 1. Secondary Map indexes for O(1) event lookups (replaces toArray() scans)
 * 2. Custom binary heap with position tracking for O(log n) removal
 *    (replaces heap-js whose remove() is O(n))
 */

/**
 * Binary min-heap with O(log n) removal via position tracking.
 * Each element gets a `_heapIndex` property for direct access.
 */
class IndexedMinHeap {
    constructor() {
        this.data = [];
    }

    get size() {
        return this.data.length;
    }

    push(event) {
        event._heapIndex = this.data.length;
        this.data.push(event);
        this._siftUp(this.data.length - 1);
    }

    pop() {
        if (this.data.length === 0) return undefined;
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            last._heapIndex = 0;
            this.data[0] = last;
            this._siftDown(0);
        }
        top._heapIndex = -1;
        return top;
    }

    remove(event) {
        const idx = event._heapIndex;
        if (idx === undefined || idx < 0 || idx >= this.data.length || this.data[idx] !== event) {
            return false;
        }

        if (idx === this.data.length - 1) {
            this.data.pop();
            event._heapIndex = -1;
            return true;
        }

        const last = this.data.pop();
        last._heapIndex = idx;
        this.data[idx] = last;
        event._heapIndex = -1;

        // Sift in whichever direction is needed
        this._siftUp(idx);
        this._siftDown(idx);
        return true;
    }

    _siftUp(idx) {
        const data = this.data;
        while (idx > 0) {
            const parent = (idx - 1) >> 1;
            if (data[idx].time >= data[parent].time) break;
            // Swap
            const tmp = data[parent];
            data[parent] = data[idx];
            data[idx] = tmp;
            data[parent]._heapIndex = parent;
            data[idx]._heapIndex = idx;
            idx = parent;
        }
    }

    _siftDown(idx) {
        const data = this.data;
        const len = data.length;
        while (true) {
            let smallest = idx;
            const left = 2 * idx + 1;
            const right = 2 * idx + 2;

            if (left < len && data[left].time < data[smallest].time) smallest = left;
            if (right < len && data[right].time < data[smallest].time) smallest = right;

            if (smallest === idx) break;

            const tmp = data[smallest];
            data[smallest] = data[idx];
            data[idx] = tmp;
            data[smallest]._heapIndex = smallest;
            data[idx]._heapIndex = idx;
            idx = smallest;
        }
    }

    toArray() {
        return [...this.data];
    }
}

/**
 * EventQueue with secondary Map indexes and O(log n) heap removal.
 */
class EventQueue {
    constructor() {
        this.minHeap = new IndexedMinHeap();

        /** @type {Map<string, Set<Object>>} type → Set<event> */
        this.byType = new Map();

        /** @type {Map<Object, Set<Object>>} unit → Set<event> (source) */
        this.bySource = new Map();

        /** @type {Map<Object, Set<Object>>} unit → Set<event> (target) */
        this.byTarget = new Map();

        /** @type {Map<string, Set<Object>>} `${type}|${unitRef}` → Set<event> */
        this.byTypeAndSource = new Map();

        /** @type {Map<string, Set<Object>>} `${type}|${hrid}` → Set<event> */
        this.byTypeAndHrid = new Map();
    }

    /**
     * Add event to the queue and all indexes.
     * @param {Object} event
     */
    addEvent(event) {
        this.minHeap.push(event);
        this._addToIndexes(event);
    }

    /**
     * Pop the earliest event and remove from indexes.
     * @returns {Object|undefined}
     */
    getNextEvent() {
        const event = this.minHeap.pop();
        if (event) {
            this._removeFromIndexes(event);
        }
        return event;
    }

    /**
     * Check if any event of the given type exists. O(1).
     * @param {string} type
     * @returns {boolean}
     */
    containsEventOfType(type) {
        const set = this.byType.get(type);
        return set !== undefined && set.size > 0;
    }

    /**
     * Check if an event of the given type and hrid exists. O(1).
     * @param {string} type
     * @param {string} hrid
     * @returns {boolean}
     */
    containsEventOfTypeAndHrid(type, hrid) {
        const key = `${type}|${hrid}`;
        const set = this.byTypeAndHrid.get(key);
        return set !== undefined && set.size > 0;
    }

    /**
     * Get an event matching type + source. O(1).
     * @param {string} type
     * @param {Object} source
     * @returns {Object|null}
     */
    getByTypeAndSource(type, source) {
        const key = this._typeSourceKey(type, source);
        const set = this.byTypeAndSource.get(key);
        if (!set || set.size === 0) return null;
        return set.values().next().value;
    }

    /**
     * Clear all events matching type + source. O(k log n).
     * @param {string} type
     * @param {Object} source
     * @returns {boolean} true if any events were cleared
     */
    clearByTypeAndSource(type, source) {
        const key = this._typeSourceKey(type, source);
        const set = this.byTypeAndSource.get(key);
        if (!set || set.size === 0) return false;

        const events = [...set];
        for (const event of events) {
            this.minHeap.remove(event);
            this._removeFromIndexes(event);
        }
        return true;
    }

    /**
     * Clear all events matching type + hrid. O(k log n).
     * @param {string} type
     * @param {string} hrid
     * @returns {boolean}
     */
    clearByTypeAndHrid(type, hrid) {
        const key = `${type}|${hrid}`;
        const set = this.byTypeAndHrid.get(key);
        if (!set || set.size === 0) return false;

        const events = [...set];
        for (const event of events) {
            this.minHeap.remove(event);
            this._removeFromIndexes(event);
        }
        return true;
    }

    /**
     * Clear all events for a unit (as source OR target). O(k log n).
     * @param {Object} unit
     */
    clearEventsForUnit(unit) {
        const sourceSet = this.bySource.get(unit);
        const targetSet = this.byTarget.get(unit);

        const toRemove = new Set();
        if (sourceSet) {
            for (const event of sourceSet) toRemove.add(event);
        }
        if (targetSet) {
            for (const event of targetSet) toRemove.add(event);
        }

        for (const event of toRemove) {
            this.minHeap.remove(event);
            this._removeFromIndexes(event);
        }
    }

    /**
     * Clear all events of a given type. O(k log n).
     * @param {string} type
     */
    clearEventsOfType(type) {
        const set = this.byType.get(type);
        if (!set || set.size === 0) return;

        const events = [...set];
        for (const event of events) {
            this.minHeap.remove(event);
            this._removeFromIndexes(event);
        }
    }

    /**
     * Clear all events and indexes.
     */
    clear() {
        this.minHeap = new IndexedMinHeap();
        this.byType.clear();
        this.bySource.clear();
        this.byTarget.clear();
        this.byTypeAndSource.clear();
        this.byTypeAndHrid.clear();
    }

    /**
     * Generic clearMatching for complex predicates not covered by indexed methods.
     * Still O(n) but only used for rare multi-type patterns.
     * @param {Function} fn - Predicate
     * @returns {boolean}
     */
    clearMatching(fn) {
        let cleared = false;
        const heapEvents = this.minHeap.toArray();

        for (const event of heapEvents) {
            if (fn(event)) {
                this.minHeap.remove(event);
                this._removeFromIndexes(event);
                cleared = true;
            }
        }
        return cleared;
    }

    /**
     * Generic getMatching for complex predicates not covered by indexed methods.
     * Still O(n) but only used for rare multi-type patterns.
     * @param {Function} fn - Predicate
     * @returns {Object|null}
     */
    getMatching(fn) {
        const heapEvents = this.minHeap.toArray();

        for (const event of heapEvents) {
            if (fn(event)) {
                return event;
            }
        }

        return null;
    }

    // --- Internal index management ---

    /** @private */
    _addToIndexes(event) {
        // byType
        if (event.type) {
            if (!this.byType.has(event.type)) this.byType.set(event.type, new Set());
            this.byType.get(event.type).add(event);
        }

        // bySource
        if (event.source) {
            if (!this.bySource.has(event.source)) this.bySource.set(event.source, new Set());
            this.bySource.get(event.source).add(event);

            // byTypeAndSource
            if (event.type) {
                const key = this._typeSourceKey(event.type, event.source);
                if (!this.byTypeAndSource.has(key)) this.byTypeAndSource.set(key, new Set());
                this.byTypeAndSource.get(key).add(event);
            }
        }

        // byTarget
        if (event.target) {
            if (!this.byTarget.has(event.target)) this.byTarget.set(event.target, new Set());
            this.byTarget.get(event.target).add(event);
        }

        // byTypeAndHrid
        if (event.type && event.hrid) {
            const key = `${event.type}|${event.hrid}`;
            if (!this.byTypeAndHrid.has(key)) this.byTypeAndHrid.set(key, new Set());
            this.byTypeAndHrid.get(key).add(event);
        }
    }

    /** @private */
    _removeFromIndexes(event) {
        // byType
        if (event.type) {
            const set = this.byType.get(event.type);
            if (set) {
                set.delete(event);
                if (set.size === 0) this.byType.delete(event.type);
            }
        }

        // bySource
        if (event.source) {
            const set = this.bySource.get(event.source);
            if (set) {
                set.delete(event);
                if (set.size === 0) this.bySource.delete(event.source);
            }

            // byTypeAndSource
            if (event.type) {
                const key = this._typeSourceKey(event.type, event.source);
                const tsSet = this.byTypeAndSource.get(key);
                if (tsSet) {
                    tsSet.delete(event);
                    if (tsSet.size === 0) this.byTypeAndSource.delete(key);
                }
            }
        }

        // byTarget
        if (event.target) {
            const set = this.byTarget.get(event.target);
            if (set) {
                set.delete(event);
                if (set.size === 0) this.byTarget.delete(event.target);
            }
        }

        // byTypeAndHrid
        if (event.type && event.hrid) {
            const key = `${event.type}|${event.hrid}`;
            const thSet = this.byTypeAndHrid.get(key);
            if (thSet) {
                thSet.delete(event);
                if (thSet.size === 0) this.byTypeAndHrid.delete(key);
            }
        }
    }

    /**
     * Build composite key for type + source index.
     * Uses source object identity via a lazy _eqId property.
     * @private
     */
    _typeSourceKey(type, source) {
        if (!source._eqId) {
            source._eqId = ++EventQueue._idCounter;
        }
        return `${type}|${source._eqId}`;
    }
}

/** @private */
EventQueue._idCounter = 0;

export default EventQueue;
