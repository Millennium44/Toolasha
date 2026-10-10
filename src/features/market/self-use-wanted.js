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
 * What a mark means is the `selfUse_markMeaning` setting's: `sell` (default) marks items to
 * sell and keeps the rest; `keep` marks items to keep and sells the rest. Every reader goes
 * through {@link isKeptForSelfUse}; the stored marks do not change with the mode.
 *
 * Stored per character in the settings store as `selfUseWanted_<characterId>`, a stamped
 * record `{ v: 2, items: [item hrids] }`, which the gist sync carries
 * (`features/sync/sync-ownership.js`). The stamp is what makes the default flip to `sell`
 * safe: marks written before it (a bare array, or JSON text of one) were made under the old
 * "keep these" meaning and would invert silently, so an unstamped record reads as no marks,
 * and the sync merge ({@link mergeMarkRecords}) never lets one replace a stamped record. An
 * older build reads the object as no list at all (it accepts only an array), so it neither
 * crashes nor sees the new marks under its old meaning. The settings panel's review list (ui
 * bundle) reaches this same instance through `Toolasha.Market.selfUseWanted`
 * (rollup externals), so its edits land in the cache the tooltip reads.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';

/** Storage key base; the key is `${STORAGE_KEY_PREFIX}_${characterId}` */
export const STORAGE_KEY_PREFIX = 'selfUseWanted';

/** The setting that says what a K mark means: `sell` (default) or `keep` */
export const MARK_MEANING_SETTING = 'selfUse_markMeaning';

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

/** The stamp a record written under the `sell` meaning carries */
export const RECORD_VERSION = 2;

/**
 * A stored value as a JSON-decoded object: JSON text from an older write is parsed.
 * @param {*} raw
 * @returns {*}
 */
function decode(raw) {
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Whether a stored value is a stamped record. Anything else (a bare array, JSON text,
 * nothing) is pre-update data made under the old "keep these" meaning.
 * @param {*} raw
 * @returns {boolean}
 */
export function isStampedRecord(raw) {
    const value = decode(raw);
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && value.v >= RECORD_VERSION;
}

/**
 * A list as the record that is stored.
 * @param {Array<string>} list
 * @returns {{v: number, items: Array<string>}}
 */
function toRecord(list) {
    return { v: RECORD_VERSION, items: sanitize(list) };
}

/**
 * The sync fold for the marks of one character: a stamped record beats an unstamped one in
 * either order, so a device still on an older build (or a gist it last wrote) cannot bring
 * back marks made under the old meaning, and a new mark is never lost to one. Two stamped
 * records, or two unstamped ones (both read as empty), settle on the incoming one, as a
 * whole-key write did before.
 * @param {*} local - This device's stored value
 * @param {*} incoming - The downloaded (or uploading) value
 * @returns {*} One of the two, as given
 */
export function mergeMarkRecords(local, incoming) {
    if (isStampedRecord(incoming)) return incoming;
    if (isStampedRecord(local)) return local;
    return incoming;
}

registerSyncMerge({
    store: 'settings',
    base: STORAGE_KEY_PREFIX,
    merge: mergeMarkRecords,
    label: 'Self-use marks',
});

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
        const stored = parseStored(await storage.getJSON(keyFor(charId), 'settings', null));
        // A switch that landed during the read must not file this list under the newcomer
        if (charId !== currentCharId()) return stored;
        // A change adopted while this read was out is newer than what it read
        if (generation !== cacheGeneration && cache !== null && cacheCharId === charId) return cache;
        // A stop during the read (cache cleared, generation bumped) must not be undone by adopting:
        // the list would be cached with nobody listening for other tabs' marks. Return the read
        // without caching it; the next load() re-subscribes and reads afresh.
        if (generation !== cacheGeneration) return stored;
        adopt(charId, stored);
        retireOldMarks(charId);
    }
    return cache;
}

/**
 * Make a list the cache for a character.
 * @param {string} charId
 * @param {Array<string>} list
 */
function adopt(charId, list, { local = true } = {}) {
    cache = list;
    cacheCharId = charId;
    cacheGeneration += 1;
    if (local) localGeneration += 1;
}

/** Bumped on every adoption, so a read that started before one knows it is stale */
let cacheGeneration = 0;

/**
 * Bumped only when this tab adopts a list of its own (a load or a change): a
 * re-read that started before one may predate it. Re-reads adopting each
 * other's results do not count — they are ordered by {@link reloadSeq}.
 */
let localGeneration = 0;

/** Numbers each re-read as it starts; the latest-started one that resolves wins */
let reloadSeq = 0;

/** The sequence number of the re-read whose list the cache holds */
let adoptedReloadSeq = 0;

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

/**
 * Stop hearing other tabs' writes (feature teardown), and forget the cache:
 * whatever another tab writes while nobody listens is never announced again,
 * so the next `load()` reads the key afresh rather than trusting a list that
 * can no longer be kept current. A re-read in flight is dropped with it.
 */
function stopWatching() {
    unsubscribeWrites?.();
    unsubscribeWrites = null;
    cache = null;
    cacheCharId = null;
    cacheGeneration += 1;
}

/**
 * Re-read the cached character's list after another tab wrote it, and tell
 * listeners. Dropped when the character changed or a later-started re-read
 * already won; read again when this tab adopted its own list meanwhile.
 * @returns {Promise<void>}
 */
async function reloadFromStorage() {
    const charId = cacheCharId;
    const generation = localGeneration;
    reloadSeq += 1;
    const seq = reloadSeq;
    try {
        const stored = parseStored(await storage.getJSON(keyFor(charId), 'settings', null));
        if (charId !== currentCharId() || charId !== cacheCharId) return;
        // A re-read that started later read a list at least this new, and already won
        if (seq < adoptedReloadSeq) return;
        if (generation !== localGeneration) {
            // This tab adopted its own list while the read was out: what was read may predate
            // it, but may also hold the remote write that sent it. Read once more, after both.
            reloadFromStorage();
            return;
        }
        adoptedReloadSeq = seq;
        adopt(charId, stored, { local: false });
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
 * A stored value as a list. Only a stamped record has marks: an array or JSON text of one
 * is pre-update data made under the old "keep these" meaning, and reads as none.
 * @param {*} raw
 * @returns {Array<string>}
 */
function parseStored(raw) {
    const value = decode(raw);
    return isStampedRecord(value) ? sanitize(value.items) : [];
}

/**
 * Rewrite an unstamped record (marks from before the meaning flipped to `sell`) as an empty
 * stamped one, once, so it stops standing in for marks and the stamped record beats an
 * older device's copy in the sync fold. Leaves a record another tab stamped meanwhile, and
 * a character that has nothing stored, alone. Fire and forget: reads already treat the old
 * record as empty, so nothing waits on this.
 * @param {string} charId
 */
async function retireOldMarks(charId) {
    try {
        await storage.update(
            keyFor(charId),
            (current) => {
                if (charId !== currentCharId()) return undefined;
                if (current === undefined || current === null || isStampedRecord(current)) return undefined;
                return toRecord([]);
            },
            'settings'
        );
    } catch (error) {
        console.error('[SelfUseWanted] Clearing pre-update marks failed:', error);
    }
}

/**
 * Change the current character's list in one read-fold-write transaction
 * (`storage.update`), so the change is applied to what is stored — not to this
 * tab's cache, which another tab's mark or a second quick click may have
 * outrun — and adopt what was stored.
 *
 * The character is captured before and checked inside the transaction and
 * again after it: a switch landing in between writes nothing, and the result
 * is never filed under the newcomer.
 * @param {(list: Array<string>) => Array<string>} change
 * @returns {Promise<Array<string>|null>} The saved list, null when the character changed or the write failed
 */
async function update(change) {
    const charId = currentCharId();
    const key = keyFor(charId);
    watchOtherTabs();
    let switched = false;
    const outcome = await storage.update(
        key,
        (current) => {
            if (charId !== currentCharId()) {
                switched = true;
                return undefined;
            }
            return toRecord(change(parseStored(current)));
        },
        'settings'
    );
    if (switched || charId !== currentCharId()) {
        console.warn('[SelfUseWanted] Keep list not saved: the character changed while it was written');
        return null;
    }
    if (!outcome) {
        console.error('[SelfUseWanted] Keep list could not be saved');
        return null;
    }
    const next = parseStored(outcome.value);
    adopt(charId, next);
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
     * Whether an item carries a K mark, from the cache. What the mark means is the
     * `selfUse_markMeaning` setting's: valuations ask {@link isKeptForSelfUse} instead.
     * @param {string} itemHrid
     * @returns {boolean}
     */
    isMarked(itemHrid) {
        return cache !== null && cacheCharId === currentCharId() && cache.includes(itemHrid);
    },

    /**
     * Mark or unmark one item.
     * @param {string} itemHrid
     * @param {boolean} keep
     * @returns {Promise<boolean|null>} Whether it is now marked, null when nothing was saved
     */
    async setKept(itemHrid, keep) {
        const saved = await update((list) => (keep ? [...list, itemHrid] : list.filter((h) => h !== itemHrid)));
        return saved ? saved.includes(itemHrid) : null;
    },

    /**
     * Flip one item's mark.
     * @param {string} itemHrid
     * @returns {Promise<boolean|null>} Whether it is now marked, null when nothing was saved
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

    /** For the settings bundle, which reaches this module only through the cross-bundle global */
    MARK_MEANING_SETTING,
    getMarkMeaning,

    stopWatching,

    /** Forget the cache (tests) */
    _reset() {
        stopWatching();
        cache = null;
        cacheCharId = null;
        cacheGeneration = 0;
        localGeneration = 0;
        reloadSeq = 0;
        adoptedReloadSeq = 0;
        outputIndex = null;
        outputIndexSource = null;
        listeners.clear();
    },
};

/**
 * What a K mark means right now: `sell` (a marked output is sold, the rest kept; the
 * default) or `keep` (a marked output is kept, the rest sold).
 * @returns {'sell'|'keep'}
 */
export function getMarkMeaning() {
    try {
        return config.getSettingValue?.(MARK_MEANING_SETTING, 'sell') === 'keep' ? 'keep' : 'sell';
    } catch {
        return 'sell';
    }
}

/**
 * The one answer to "does self-use keep this output?" for every valuation, tooltip
 * line and "instead of buying" lookup. A mark means keep in `keep` mode and sell in
 * `sell` mode, so this is `marked` or `!marked`.
 * @param {string} itemHrid
 * @param {Set<string>|Array<string>} [marked] - A marked list already in hand (a snapshot a
 *   valuation was started with); the cached list when omitted
 * @returns {boolean}
 */
export function isKeptForSelfUse(itemHrid, marked) {
    const isMarked = marked
        ? Array.isArray(marked)
            ? marked.includes(itemHrid)
            : marked.has(itemHrid)
        : selfUseWanted.isMarked(itemHrid);
    return getMarkMeaning() === 'sell' ? !isMarked : isMarked;
}

/**
 * A key for everything a self-use valuation reads from the marks: the mode and the
 * marked list. A cache keyed on it is dropped by either changing.
 * @param {Set<string>|Array<string>} [marked]
 * @returns {string}
 */
export function keptSignature(marked) {
    return `${getMarkMeaning()}|${[...(marked || [])].sort().join(',')}`;
}

/**
 * The chip's text for an item.
 * @param {boolean} marked - Whether the item carries a K mark
 * @returns {string}
 */
export function keepChipLabel(marked) {
    if (getMarkMeaning() === 'sell') return marked ? '☑ Sell (not kept) (K)' : '☐ Sell (K)';
    return marked ? '☑ Kept (K)' : '☐ Keep (K)';
}

/**
 * The hover text of the chip.
 * @returns {string}
 */
export function keepChipTitle() {
    if (getMarkMeaning() === 'sell') {
        return (
            'Sell (not kept): self-use alchemy lines value a marked output as sold after tax; every other ' +
            'output is kept, valued at what you would pay for it. Click, or press K.'
        );
    }
    return (
        'Keep for self-use: self-use alchemy lines value a kept output at what you would pay for it; ' +
        'every other output is valued as sold after tax. Click, or press K.'
    );
}

/**
 * The self-use footnote under the tooltip lines.
 * @returns {string}
 */
export function selfUseFootnote() {
    if (getMarkMeaning() === 'sell') {
        return 'Self-use: marked outputs sold after tax, the rest kept at what you would pay. K on a tooltip marks it sold.';
    }
    return 'Self-use: kept outputs at what you would pay, the rest sold after tax. K on a tooltip marks it kept.';
}

/**
 * The tooltip section for one item: the compact chip, which the K key also flips.
 * @param {string} itemHrid
 * @param {boolean} marked
 * @returns {string} HTML
 */
export function buildKeepChipHTML(itemHrid, marked) {
    return (
        `<span class="${KEEP_CHIP_CLASS}" data-item-hrid="${itemHrid}" style="cursor: pointer;" ` +
        `title="${keepChipTitle()}">${keepChipLabel(marked)}</span>`
    );
}

/** Relabel every chip on screen (the mark meaning changed) */
export function relabelKeepChips() {
    if (typeof document === 'undefined') return;
    for (const chip of document.querySelectorAll(`.${KEEP_CHIP_CLASS}`)) {
        const hrid = chip.getAttribute('data-item-hrid');
        if (!hrid) continue;
        chip.textContent = keepChipLabel(cache !== null && cacheCharId === currentCharId() && cache.includes(hrid));
        chip.setAttribute('title', keepChipTitle());
    }
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
 * @param {() => boolean} [isEnabled] - Asked on every click and keypress; false makes both inert
 */
export function installKeepToggle(isEnabled = () => true) {
    if (typeof document === 'undefined' || toggleHandlers) return;

    const onClick = (event) => {
        const chip = event.target?.closest?.(`.${KEEP_CHIP_CLASS}`);
        if (!chip || !isEnabled()) return;
        event.preventDefault();
        event.stopPropagation();
        flipChip(chip);
    };

    const onKeyDown = (event) => {
        if (event.key?.toLowerCase() !== KEEP_KEY || event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.repeat || !isEnabled()) return;

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
