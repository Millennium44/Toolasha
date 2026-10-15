/**
 * Panel Size Memory
 *
 * The game's panel dividers resize by writing inline styles, and it forgets the
 * result on reload — so a panel dragged to a comfortable width is back to the
 * default next session.
 *
 * Rather than hardcode which element the divider touches (the game's class names
 * are generated and change between updates), this watches for inline size styles
 * written *while you are dragging* and remembers whatever changed. On the next
 * load it replays those declarations onto the same element. Nothing is guessed:
 * the only styles ever applied are ones the game itself wrote in response to a
 * drag you performed.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import domObserver from '../../core/dom-observer.js';

const STORAGE_KEY = 'panelSizeMemory';

/** Inline properties a divider plausibly writes; custom properties are kept too */
const SIZE_PROPERTIES = new Set([
    'width',
    'min-width',
    'max-width',
    'height',
    'min-height',
    'max-height',
    'flex-basis',
    'flex',
    'grid-template-columns',
]);

/** How far the pointer must travel before a press counts as a drag, in CSS pixels */
const DRAG_THRESHOLD_PX = 4;

/**
 * Whether an element is (or sits inside) one of the game's progress bars. Their
 * fill width is rewritten continuously while an action runs, so a press made
 * mid-action would otherwise "remember" the bar at that instant's progress and
 * replay it on every re-render, dragging the bar back and forth.
 * @param {Element} element - Element to check
 * @returns {boolean}
 */
export function isProgressBarElement(element) {
    return Boolean(element?.closest?.('[class*="ProgressBar_"]'));
}

/**
 * Size-related declarations of an element's inline style.
 * @param {HTMLElement} element - Element to read
 * @returns {Object} property → value
 */
export function readSizeStyles(element) {
    const styles = {};
    const inline = element?.style;
    if (!inline) return styles;

    for (let i = 0; i < inline.length; i++) {
        const property = inline[i];
        if (SIZE_PROPERTIES.has(property) || property.startsWith('--')) {
            styles[property] = inline.getPropertyValue(property);
        }
    }
    return styles;
}

/**
 * Structural path to an element, as tag + nth-of-type steps up to a root ID.
 * Class names are deliberately not used — the game generates them per build, so
 * a class-based path would break on every game update.
 * @param {HTMLElement} element - Element to describe
 * @param {HTMLElement} root - Ancestor to stop at
 * @returns {string|null} Path, or null when the element isn't under the root
 */
export function buildElementPath(element, root) {
    const steps = [];
    let node = element;

    while (node && node !== root) {
        const current = node;
        const parent = current.parentElement;
        if (!parent) return null;
        const tag = current.tagName.toLowerCase();
        const siblings = [...parent.children].filter((child) => child.tagName === current.tagName);
        steps.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
        node = parent;
    }

    return node === root ? steps.join('>') : null;
}

/**
 * Resolve a path built by buildElementPath.
 * @param {string} path - Stored path
 * @param {HTMLElement} root - Ancestor the path is relative to
 * @returns {HTMLElement|null}
 */
export function resolveElementPath(path, root) {
    let node = root;
    for (const step of (path || '').split('>')) {
        if (!node || !step) return null;
        const match = /^([a-z0-9-]+):nth-of-type\((\d+)\)$/.exec(step);
        if (!match) return null;
        const [, tag, index] = match;
        const candidates = [...node.children].filter((child) => child.tagName.toLowerCase() === tag);
        node = candidates[Number(index) - 1] || null;
    }
    return node === root ? null : node;
}

/**
 * A loose fingerprint of an element, used to abandon a saved size when the game's
 * layout has changed enough that the path no longer points at the same thing.
 * @param {HTMLElement} element - Element to fingerprint
 * @returns {string}
 */
export function elementSignature(element) {
    if (!element) return '';
    const className = typeof element.className === 'string' ? element.className : '';
    // Generated class names carry a hash suffix that changes per build; the
    // readable prefix is the stable part
    const base = className
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => token.split('__')[0])
        .join(' ');
    return `${element.tagName.toLowerCase()}|${base}`;
}

class PanelSizeMemory {
    constructor() {
        this.isInitialized = false;
        this.dragging = false;
        this.observer = null;
        this.unregisterObserver = null;
        this.pending = null;
        this.saved = null;
        this.onPointerDown = null;
        this.onPointerUp = null;
        this.onPointerMove = null;
        this.pressAt = null;
        this.moved = false;
    }

    /**
     * Start watching for drag-driven resizes and restore the remembered size.
     *
     * The remembered size is read *after* the watchers are in place, not before.
     * Awaiting the read first meant a third of a second in which this feature —
     * and, because initializers were awaited one after another, every feature
     * behind it — did nothing at all. Nothing here needs the value to set up:
     * `restore()` is a no-op while `saved` is null, the drag watcher only ever
     * writes, and the size is replayed the moment the read lands.
     * @returns {void}
     */
    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('panelSizeMemory')) return;
        this.isInitialized = true;

        this.onPointerDown = (event) => {
            this.dragging = true;
            this.pending = null;
            this.moved = false;
            this.pressAt = { x: event?.clientX ?? 0, y: event?.clientY ?? 0 };
            this.watchInlineStyles();
        };
        this.onPointerMove = (event) => {
            if (!this.dragging || this.moved || !this.pressAt) return;
            const dx = (event?.clientX ?? 0) - this.pressAt.x;
            const dy = (event?.clientY ?? 0) - this.pressAt.y;
            if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) this.moved = true;
        };
        this.onPointerUp = () => {
            this.dragging = false;
            this.unwatchInlineStyles();
            // A press that never moved is a click, not a divider drag: whatever the
            // game restyled meanwhile (an action bar filling) is not a size the player chose
            if (this.pending && this.moved) this.persist(this.pending);
            this.pending = null;
            this.pressAt = null;
        };
        document.addEventListener('pointerdown', this.onPointerDown, true);
        document.addEventListener('pointermove', this.onPointerMove, true);
        document.addEventListener('pointerup', this.onPointerUp, true);

        this.restore();

        this._loadSaved();
    }

    /**
     * Reapply the remembered size whenever the DOM settles — the game re-renders
     * panels on navigation, which drops inline styles.
     *
     * Registered only once there is a size to reapply. This handler carries no
     * class filter, so the shared observer runs it for every element inserted
     * anywhere on the page and re-arms a 250 ms debounce — one `clearTimeout`
     * plus one `setTimeout` per inserted node, which through combat is the
     * largest single contributor to `timerCounters.domRearm`. For anyone who has
     * never dragged a panel divider that bought nothing at all: `restore()`
     * returns on its first line while `saved` is null.
     *
     * There is no filter to use instead. The element is remembered as a
     * structural path rather than by class (see `buildElementPath`), precisely
     * so a game update cannot invalidate it, so there is no class to watch.
     * @private
     */
    _watchDom() {
        if (this.unregisterObserver || !this.isInitialized) return;
        this.unregisterObserver = domObserver.register('PanelSizeMemory', () => this.restore(), {
            debounce: true,
            debounceDelay: 250,
        });
    }

    /**
     * Read the remembered size off the critical path and replay it.
     * @returns {Promise<void>} Resolves once the size has been applied
     * @private
     */
    async _loadSaved() {
        let saved = null;
        try {
            saved = await storage.get(STORAGE_KEY, 'settings', null);
        } catch (error) {
            console.error('[PanelSizeMemory] Failed to read saved size:', error);
            return;
        }
        // Torn down while the read was in flight, or a drag already produced a
        // newer size — either way the stored one is stale now.
        if (!this.isInitialized || this.saved || this.dragging) return;
        // An entry captured from a progress bar (saved before progress bars were excluded) is
        // not a panel size; replaying it fought the game's own fill. Forget it.
        if (saved?.signature?.includes('ProgressBar_')) {
            this.reset();
            return;
        }
        this.saved = saved;
        if (saved) this._watchDom();
        this.restore();
    }

    /**
     * Record inline size styles written during a drag.
     *
     * Only observed between pointerdown and pointerup: a subtree attribute
     * observer over the whole game root costs a callback for every inline
     * style the game writes, and outside a drag the callback would only bail.
     * @private
     */
    watchInlineStyles() {
        if (this.observer) return;
        const root = document.getElementById('root');
        if (!root) return;

        this.observer = new MutationObserver((mutations) => {
            if (!this.dragging) return;
            for (const mutation of mutations) {
                const element = mutation.target;
                if (!(element instanceof HTMLElement)) continue;
                if (isProgressBarElement(element)) continue;
                const styles = readSizeStyles(element);
                if (Object.keys(styles).length === 0) continue;
                const path = buildElementPath(element, root);
                if (!path) continue;
                this.pending = { path, signature: elementSignature(element), styles };
            }
        });
        this.observer.observe(root, { attributes: true, attributeFilter: ['style'], subtree: true });
    }

    /**
     * Stop watching inline styles once the drag has ended.
     * @private
     */
    unwatchInlineStyles() {
        if (!this.observer) return;
        this.observer.disconnect();
        this.observer = null;
    }

    /**
     * Save the size the drag produced.
     * @param {Object} entry - { path, signature, styles }
     * @private
     */
    async persist(entry) {
        this.saved = entry;
        this._watchDom();
        try {
            await storage.set(STORAGE_KEY, entry);
        } catch (error) {
            console.error('[PanelSizeMemory] Failed to save size:', error);
        }
    }

    /**
     * Reapply the remembered size, unless the element it was captured from is
     * gone or has changed shape — a stale path must not restyle something else.
     * @private
     */
    restore() {
        const entry = this.saved;
        if (!entry?.path || this.dragging) return;

        const root = document.getElementById('root');
        if (!root) return;

        const element = resolveElementPath(entry.path, root);
        if (!element) return;
        if (elementSignature(element) !== entry.signature) return;
        if (isProgressBarElement(element)) return;

        for (const [property, value] of Object.entries(entry.styles)) {
            if (element.style.getPropertyValue(property) === value) continue;
            element.style.setProperty(property, value);
        }
    }

    /**
     * Forget the remembered size.
     */
    async reset() {
        this.saved = null;
        try {
            await storage.set(STORAGE_KEY, null);
        } catch (error) {
            console.error('[PanelSizeMemory] Failed to clear saved size:', error);
        }
    }

    /**
     * Stop watching and release listeners.
     */
    cleanup() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }
        if (this.onPointerDown) {
            document.removeEventListener('pointerdown', this.onPointerDown, true);
            this.onPointerDown = null;
        }
        if (this.onPointerUp) {
            document.removeEventListener('pointerup', this.onPointerUp, true);
            this.onPointerUp = null;
        }
        if (this.onPointerMove) {
            document.removeEventListener('pointermove', this.onPointerMove, true);
            this.onPointerMove = null;
        }
        this.dragging = false;
        this.pending = null;
        this.saved = null;
        this.isInitialized = false;
    }
}

const panelSizeMemory = new PanelSizeMemory();

/** The singleton, exposed for tests. */
export { panelSizeMemory as _instance };

export default {
    name: 'Panel Size Memory',
    initialize: () => panelSizeMemory.initialize(),
    cleanup: () => {
        try {
            return panelSizeMemory.cleanup();
        } catch (error) {
            console.error('[Panel Size Memory] Disable failed part-way:', error);
        } finally {
            panelSizeMemory.isInitialized = false;
        }
    },
    reset: () => panelSizeMemory.reset(),
};
