/**
 * The self-use keep list: which alchemy outputs this character wants to keep.
 *
 * The self-use alchemy lines in the item tooltip (`utils/self-use-alchemy.js`)
 * used to value every output as kept — at the untaxed buy side, what you would
 * pay for it. Transmuting an ability book then priced every book it can roll at
 * the ask, as if the player wanted all of them, when they want one and sell the
 * rest. So each output is now kept only when it is on this list (valued at the
 * buy side, untaxed) and otherwise sold (bid after the character-aware tax).
 *
 * Marked from the item's own tooltip: a "Keep for self-use" chip, clickable on
 * the tooltips that stay open, and the K key while a chip is on screen — a hover
 * tooltip vanishes the moment the pointer leaves the item, so the key is what
 * makes it usable there. The same pattern as the enhancement source chip (P).
 *
 * Stored per character in the settings store as `selfUseWanted_<characterId>`
 * (an array of item hrids), which the gist sync carries
 * (`features/sync/sync-ownership.js`). The settings panel's review list (ui
 * bundle) reaches this same instance through `Toolasha.Market.selfUseWanted`
 * (rollup externals), so its edits land in the cache the tooltip reads.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';

/** Storage key base; the key is `${STORAGE_KEY_PREFIX}_${characterId}` */
export const STORAGE_KEY_PREFIX = 'selfUseWanted';

/** The chip on an item tooltip */
export const KEEP_CHIP_CLASS = 'toolasha-selfuse-keep-chip';

/** The tooltip section holding the chip */
export const KEEP_SECTION_CLASS = 'mwi-selfuse-keep';

/** The key that toggles the chip on screen */
export const KEEP_KEY = 'k';

/** Alchemy's item-wide bonus drops, which no item's own output table lists */
const BONUS_DROP_HRIDS = [
    '/items/alchemy_essence',
    '/items/small_artisans_crate',
    '/items/medium_artisans_crate',
    '/items/large_artisans_crate',
];

/** @type {Array<string>|null} The current character's list */
let cache = null;

/** Which character `cache` belongs to — a mismatch means it must be reloaded */
let cacheCharId = null;

/** Called with no arguments whenever the list changes */
const listeners = new Set();

/** Every item some decompose or transmute can yield, built once per item map */
let outputIndex = null;
let outputIndexSource = null;

/**
 * The current character id, `'default'` before login.
 * @returns {string}
 */
function currentCharId() {
    return dataManager.getCurrentCharacterId?.() || 'default';
}

/**
 * The storage key for one character.
 * @param {string} charId
 * @returns {string}
 */
function keyFor(charId) {
    return `${STORAGE_KEY_PREFIX}_${charId}`;
}

/**
 * A stored list made safe to read: unique item hrids only.
 * @param {*} value
 * @returns {Array<string>}
 */
function sanitize(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((hrid) => typeof hrid === 'string' && hrid.startsWith('/items/')))];
}

/**
 * Load the current character's list, reloading whenever the character changed
 * since the cache was filled.
 * @returns {Promise<Array<string>>}
 */
async function load() {
    watchOtherTabs();
    const charId = currentCharId();
    if (cache === null || cacheCharId !== charId) {
        const generation = cacheGeneration;
        const stored = sanitize(await storage.getJSON(keyFor(charId), 'settings', []));
        // A switch that landed during the read must not file this list under the newcomer
        if (charId !== currentCharId()) return stored;
        // A change adopted while this read was out is newer than what it read
        if (generation !== cacheGeneration && cache !== null && cacheCharId === charId) return cache;
        adopt(charId, stored);
    }
    return cache;
}

/**
 * Make a list the cache for a character.
 * @param {string} charId
 * @param {Array<string>} list
 */
function adopt(charId, list) {
    cache = list;
    cacheCharId = charId;
    cacheGeneration += 1;
}

/** Bumped on every adoption, so a read that started before one knows it is stale */
let cacheGeneration = 0;

/** Unsubscribe from `storage.onWrite`, while listening */
let unsubscribeWrites = null;

/**
 * Hear other tabs' writes to the cached character's key, and reload it when
 * one lands: a mark made in another tab otherwise never reached this tab's
 * tooltips until a reload. `storeName: null` is a page back from the bfcache,
 * which could not hear anything, so it reloads too.
 */
function watchOtherTabs() {
    if (unsubscribeWrites || typeof storage.onWrite !== 'function') return;
    unsubscribeWrites = storage.onWrite(({ storeName, keys, origin } = {}) => {
        if (origin !== 'remote' && storeName !== null) return;
        if (storeName !== null && storeName !== 'settings') return;
        if (cache === null || cacheCharId === null) return;
        if (Array.isArray(keys) && keys.length > 0 && !keys.includes(keyFor(cacheCharId))) return;
        reloadFromStorage();
    });
}

/** Stop hearing other tabs' writes (feature teardown) */
function stopWatching() {
    unsubscribeWrites?.();
    unsubscribeWrites = null;
}

/**
 * Re-read the cached character's list after another tab wrote it, and tell
 * listeners. Dropped when the character changed or a newer list was adopted
 * while the read was out.
 * @returns {Promise<void>}
 */
async function reloadFromStorage() {
    const charId = cacheCharId;
    const generation = cacheGeneration;
    try {
        const stored = sanitize(await storage.getJSON(keyFor(charId), 'settings', []));
        if (charId !== currentCharId() || charId !== cacheCharId || generation !== cacheGeneration) return;
        adopt(charId, stored);
        notify();
    } catch (error) {
        console.error('[SelfUseWanted] Reload after another tab wrote failed:', error);
    }
}

/** Tell every listener the list changed, and relabel the chips on screen */
function notify() {
    if (typeof document !== 'undefined') {
        for (const chip of document.querySelectorAll(`.${KEEP_CHIP_CLASS}`)) {
            const hrid = chip.getAttribute('data-item-hrid');
            if (hrid) chip.textContent = keepChipLabel(cache?.includes(hrid) ?? false);
        }
    }
    for (const listener of listeners) {
        try {
            listener();
        } catch (error) {
            console.error('[SelfUseWanted] Listener failed:', error);
        }
    }
}

/**
 * Write a new list for the character it was read for. The character is
 * captured before the read and checked after it: the write is a full
 * overwrite, so a switch landing in between must not put one character's list
 * over another's.
 * @param {(list: Array<string>) => Array<string>} change
 * @returns {Promise<Array<string>|null>} The saved list, null when the character changed
 */
async function update(change) {
    const charId = currentCharId();
    const list = await load();
    if (charId !== currentCharId()) {
        console.warn('[SelfUseWanted] Keep list not saved: the character changed while it loaded');
        return null;
    }
    const next = sanitize(change([...list]));
    adopt(charId, next);
    // Fire-and-forget: the cache already answers, the write persists behind it
    storage.setJSON(keyFor(charId), next, 'settings');
    notify();
    return next;
}

/**
 * Whether an item can come out of some decompose or transmute — the items a
 * keep mark changes anything for, and so the only ones whose tooltip gets the chip.
 * @param {string} itemHrid
 * @returns {boolean}
 */
function isAlchemyOutput(itemHrid) {
    const itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap;
    if (!itemDetailMap) return false;
    if (outputIndex === null || outputIndexSource !== itemDetailMap) {
        outputIndex = new Set(BONUS_DROP_HRIDS);
        for (const details of Object.values(itemDetailMap)) {
            const alchemy = details?.alchemyDetail;
            for (const output of alchemy?.decomposeItems || []) outputIndex.add(output?.itemHrid);
            for (const drop of alchemy?.transmuteDropTable || []) outputIndex.add(drop?.itemHrid);
        }
        outputIndexSource = itemDetailMap;
    }
    return outputIndex.has(itemHrid);
}

const selfUseWanted = {
    load,

    /**
     * The current character's list as a set, loaded if needed.
     * @returns {Promise<Set<string>>}
     */
    async getSet() {
        return new Set(await load());
    },

    /**
     * The cached list, synchronously (empty before the first load or right after a switch).
     * @returns {Array<string>}
     */
    getCached() {
        return cache !== null && cacheCharId === currentCharId() ? [...cache] : [];
    },

    /**
     * Whether an item is marked, from the cache.
     * @param {string} itemHrid
     * @returns {boolean}
     */
    isKept(itemHrid) {
        return cache !== null && cacheCharId === currentCharId() && cache.includes(itemHrid);
    },

    /**
     * Mark or unmark one item.
     * @param {string} itemHrid
     * @param {boolean} keep
     * @returns {Promise<boolean|null>} Whether it is now kept, null when nothing was saved
     */
    async setKept(itemHrid, keep) {
        const saved = await update((list) => (keep ? [...list, itemHrid] : list.filter((h) => h !== itemHrid)));
        return saved ? saved.includes(itemHrid) : null;
    },

    /**
     * Flip one item's mark.
     * @param {string} itemHrid
     * @returns {Promise<boolean|null>} Whether it is now kept, null when nothing was saved
     */
    async toggle(itemHrid) {
        const saved = await update((list) =>
            list.includes(itemHrid) ? list.filter((h) => h !== itemHrid) : [...list, itemHrid]
        );
        return saved ? saved.includes(itemHrid) : null;
    },

    /**
     * Unmark everything for the current character.
     * @returns {Promise<boolean>} Whether it was saved
     */
    async clear() {
        return (await update(() => [])) !== null;
    },

    /**
     * Be told when the list changes.
     * @param {() => void} listener
     * @returns {() => void} Unsubscribe
     */
    onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    isAlchemyOutput,

    stopWatching,

    /** Forget the cache (tests) */
    _reset() {
        stopWatching();
        cache = null;
        cacheCharId = null;
        cacheGeneration = 0;
        outputIndex = null;
        outputIndexSource = null;
        listeners.clear();
    },
};

/**
 * The chip's text for an item.
 * @param {boolean} kept
 * @returns {string}
 */
export function keepChipLabel(kept) {
    return kept ? '☑ Kept for self-use' : '☐ Keep for self-use';
}

/**
 * The tooltip section for one item: the chip and the key that flips it.
 * @param {string} itemHrid
 * @param {boolean} kept
 * @returns {string} HTML
 */
export function buildKeepChipHTML(itemHrid, kept) {
    return (
        `<span class="${KEEP_CHIP_CLASS}" data-item-hrid="${itemHrid}" style="cursor: pointer;" ` +
        `title="Self-use alchemy lines value a kept output at what you would pay for it; every other ` +
        `output is valued as sold after tax.">${keepChipLabel(kept)}</span>` +
        ` <span style="opacity: 0.6;">(press K)</span>`
    );
}

let toggleHandlers = null;

/**
 * Flip the mark of the item a chip names, and relabel every chip for it.
 * @param {HTMLElement} chip
 * @returns {Promise<void>}
 */
async function flipChip(chip) {
    const itemHrid = chip.getAttribute('data-item-hrid');
    if (!itemHrid) return;
    const kept = await selfUseWanted.toggle(itemHrid);
    if (kept === null) return;
    for (const other of document.querySelectorAll(`.${KEEP_CHIP_CLASS}`)) {
        if (other.getAttribute('data-item-hrid') === itemHrid) other.textContent = keepChipLabel(kept);
    }
}

/**
 * Make the chip live: a click on it, or K while one is on screen.
 */
export function installKeepToggle() {
    if (typeof document === 'undefined' || toggleHandlers) return;

    const onClick = (event) => {
        const chip = event.target?.closest?.(`.${KEEP_CHIP_CLASS}`);
        if (!chip) return;
        event.preventDefault();
        event.stopPropagation();
        flipChip(chip);
    };

    const onKeyDown = (event) => {
        if (event.key?.toLowerCase() !== KEEP_KEY || event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.repeat) return;

        // Never steal a keystroke from chat, a price box or any other field being typed into
        const target = event.target;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

        // The newest chip is the tooltip the pointer is on
        const chips = document.querySelectorAll(`.${KEEP_CHIP_CLASS}`);
        const chip = chips[chips.length - 1];
        if (!chip) return;

        event.preventDefault();
        flipChip(chip);
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    toggleHandlers = { onClick, onKeyDown };
}

/**
 * Remove the chip's listeners.
 */
export function uninstallKeepToggle() {
    if (typeof document === 'undefined' || !toggleHandlers) return;
    document.removeEventListener('click', toggleHandlers.onClick, true);
    document.removeEventListener('keydown', toggleHandlers.onKeyDown, true);
    toggleHandlers = null;
}

export default selfUseWanted;
