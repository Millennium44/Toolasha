/**
 * Named overlay layouts
 *
 * An overlay arrangement is worth an hour of fiddling, and there is more than
 * one of them worth having: the tiles you want while grinding a dungeon are not
 * the tiles you want while running the marketplace, and the only way to keep
 * both was to export one to a file and import it back an hour later.
 *
 * So layouts get names. Saving one writes the arrangement exactly as
 * `_exportLayout` writes a file — through `toOPanelConfig` — and switching reads
 * it back through `fromOPanelConfig`, which is the same code path an import
 * already takes. That is deliberate: a second way of applying a layout is a
 * second set of bugs about tiles arriving unplaced, and the import path has
 * already learned the awkward parts (native coordinates left alone, OPanel's
 * refitted).
 *
 * Everything lives under one key holding a map of name to saved file, rather
 * than a key per layout. A map is one read, one write and one place to look
 * when a name goes missing; a key per layout means a listing has to enumerate
 * the whole store and guess which keys are layouts by their prefix.
 *
 * The map operations are pure and exported separately from the storage calls,
 * because renaming, overwriting and deleting are where the mistakes live and
 * none of them need IndexedDB to be tested.
 *
 * ## Presets
 *
 * Four arrangements ship with the script, because the first thing a named
 * layout asks of you is that you already have one — and the answer to "what
 * would a combat layout even contain" is the same for everybody the first ten
 * times it is asked. They sit in the same dropdown as your own, marked, and
 * they apply through exactly the same path. They cannot be deleted or written
 * over; saving your own under a preset's name simply shadows it, which is the
 * behaviour you want from a preset you have outgrown.
 *
 * ## Which layout an activity wants
 *
 * The last part is the one that makes the rest worth having: switching by hand
 * every time you stop fighting and start milking is switching you will do twice
 * and then stop doing. {@link decideAutoSwitch} is the whole of that decision,
 * kept pure and here rather than in the panel — it is four rules about *when*
 * not to act (too soon, unlocked, already there, told not to), and every one of
 * them is a rule you can only test by lying about the clock.
 */

import { createCuratedRecord, mergeMaps } from '../../utils/persisted-record.js';
import { toOPanelConfig } from '../../utils/opanel-config.js';
import { registeredRows } from '../../utils/overlay-rows.js';
import { MAX_SPAN } from '../../utils/overlay-flow.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';

/** The one key the whole map lives under */
export const LAYOUTS_KEY = 'overlayLayouts';

/** Which object store — the same one the overlay's own settings use */
const STORE = 'settings';

/** Long enough to be descriptive, short enough to fit the dropdown */
export const MAX_NAME_LENGTH = 40;

/**
 * A name as it will be stored.
 *
 * Trimmed and capped rather than rejected on length, so a pasted name is
 * shortened instead of losing the whole save. Whitespace-only is not a name.
 *
 * @param {string} name - What the player typed
 * @returns {string} The stored form, or '' when there is nothing usable
 */
export function normalizeName(name) {
    if (typeof name !== 'string') return '';
    return name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
}

/**
 * The saved names, in the order they should be offered.
 *
 * Sorted rather than kept in insertion order: a dropdown you scan for a name
 * you already know is easier alphabetical, and insertion order is invisible
 * from the outside anyway.
 *
 * @param {Object} map - The stored map
 * @returns {string[]} Names
 */
export function layoutNames(map) {
    if (!map || typeof map !== 'object') return [];
    return Object.keys(map).sort((a, b) => a.localeCompare(b));
}

/**
 * The map with one layout added or replaced.
 *
 * Returns a new object rather than mutating, so a caller holding the old map
 * still holds the old map — which is what makes "save failed, nothing changed"
 * true rather than merely intended.
 *
 * @param {Object} map - The stored map
 * @param {string} name - Layout name; normalized here
 * @param {Object} file - What `toOPanelConfig` produced
 * @returns {Object} A new map, unchanged when the name is unusable
 */
export function putLayout(map, name, file) {
    const key = normalizeName(name);
    if (!key || !file) return { ...(map || {}) };
    return { ...(map || {}), [key]: { savedAt: Date.now(), file } };
}

/**
 * Two devices' layout maps as one.
 *
 * A layout is an hour of fiddling and there is deliberately more than one of
 * them, so the map is a collection: the combat arrangement built on the desktop
 * and the marketplace one built on the laptop are two different layouts, and a
 * whole-key sync write throws one of them away outright. The union by name is
 * the point.
 *
 * On the same name the later `savedAt` wins — {@link putLayout} stamps every
 * save, so the copy stamped later is the arrangement the user most recently
 * fiddled into place. A stamp-less entry predates that field; it loses to a
 * stamped one, and two stamp-less entries fall back to last-write-wins (the
 * incoming copy), which is exactly what a whole-key write already did.
 *
 * **A deletion can come back.** The map keeps no tombstones, so "the other
 * device has never seen this layout" and "this device deleted it" are the same
 * shape on disk, and the union has to keep it. Tombstones are what would settle
 * that (`inventory/custom-tabs/custom-tabs-data.js` carries the pattern), and
 * they are not worth it here: deleting a saved layout is rare, reviving one
 * costs a second Delete, and losing the laptop's whole set of layouts to a pull
 * is the failure that actually happens.
 *
 * @param {Object|null} local - This device's map
 * @param {Object|null} incoming - The downloaded map
 * @returns {Object} The union
 */
export function mergeLayoutMaps(local, incoming) {
    const merged = { ...(local && typeof local === 'object' ? local : {}) };

    for (const [name, layout] of Object.entries(incoming && typeof incoming === 'object' ? incoming : {})) {
        const held = merged[name];
        if (!held) {
            merged[name] = layout;
            continue;
        }
        const mine = Number(held?.savedAt);
        const theirs = Number(layout?.savedAt);
        const keepMine = Number.isFinite(mine) && (!Number.isFinite(theirs) || mine > theirs);
        merged[name] = keepMine ? held : layout;
    }
    return merged;
}

/*
 * Registered so a cross-device sync PULL combines the saved layouts instead of
 * overwriting them. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: STORE,
    // One exact global key — layouts are not per character (`scoped: false`)
    key: LAYOUTS_KEY,
    merge: mergeLayoutMaps,
    label: 'Overlay layouts',
});

/**
 * The map with one layout gone.
 *
 * @param {Object} map - The stored map
 * @param {string} name - Layout name
 * @returns {Object} A new map, unchanged when the name is not in it
 */
export function removeLayout(map, name) {
    const key = normalizeName(name);
    const next = { ...(map || {}) };
    delete next[key];
    return next;
}

/**
 * The map as stored — one global record, layouts are not per character.
 *
 * An arrangement is an hour of fiddling, so this is a curated record: a read
 * that cannot be made leaves the map in hand rather than reading as empty (the
 * accident this guards against is a save reading nothing, adding one layout
 * and writing a map of one over the map of six), and no write goes out over a
 * store that could not be read first. Before the map has been read back a
 * save folds the stored map under memory by name; once it has, what is in
 * memory is the map and a delete sticks.
 */
const record = createCuratedRecord({
    base: LAYOUTS_KEY,
    store: STORE,
    scoped: false,
    empty: () => ({}),
    merge: mergeMaps(),
    immediate: true,
    label: 'OverlayLayouts',
});

/**
 * Every saved layout.
 *
 * An absent map reads as no layouts rather than as an error: the overlay still
 * has to draw its settings popover, and a control that throws takes the
 * popover with it. An unreadable one reads as the map last held, which before
 * any read is also empty.
 *
 * @returns {Promise<Object>} `{ [name]: {savedAt, file} }`
 */
export async function loadLayouts() {
    try {
        const previous = record.get();
        record.set({});
        const readable = await record.load();
        if (!readable) record.set(previous);
        const map = record.get();
        return map && typeof map === 'object' ? map : {};
    } catch (error) {
        console.error('[OverlayLayouts] Reading the saved layouts failed:', error);
        return {};
    }
}

/**
 * Write the whole map back.
 *
 * A write that does not land — the store could not be read first, or the
 * write itself failed — also puts the map in hand back as it was, so the
 * dropdown keeps showing what exists rather than a name that only ever lived
 * in memory.
 *
 * @param {Object} map - The map to store
 * @returns {Promise<boolean>} Whether it was written
 */
async function writeLayouts(map) {
    const before = record.get();
    try {
        record.set(map);
        const written = await record.save();
        if (!written) record.set(before);
        return written;
    } catch (error) {
        console.error('[OverlayLayouts] Saving the layouts failed:', error);
        record.set(before);
        return false;
    }
}

/** @returns {Promise<*>} The pending writes, for tests and shutdown */
export function flushLayoutWrites() {
    return record.flushed();
}

/**
 * Save an arrangement under a name, replacing one of the same name.
 *
 * @param {string} name - Layout name
 * @param {Object} file - What `toOPanelConfig` produced
 * @returns {Promise<Object>} The map as it now stands
 */
export async function saveLayout(name, file) {
    const current = await loadLayouts();
    const next = putLayout(current, name, file);
    // The map that is actually stored, so a failed write leaves the dropdown
    // showing what exists rather than a name that only ever lived in memory
    return (await writeLayouts(next)) ? record.get() : current;
}

/**
 * Forget a saved layout.
 *
 * @param {string} name - Layout name
 * @returns {Promise<Object>} The map as it now stands
 */
export async function deleteLayout(name) {
    const current = await loadLayouts();
    const next = removeLayout(current, name);
    return (await writeLayouts(next)) ? record.get() : current;
}

/**
 * One saved layout's file, ready for `fromOPanelConfig`.
 *
 * Your own first, then the presets — which is what makes "Save As under a
 * preset's name" shadow it rather than fail.
 *
 * @param {string} name - Layout name
 * @returns {Promise<Object|null>} The saved file, or null when there is no such layout
 */
export async function getLayout(name) {
    const map = await loadLayouts();
    return map[normalizeName(name)]?.file || presetFile(name);
}

// ─── Presets ────────────────────────────────────────────────────────────────

/**
 * How a preset is marked in the dropdown.
 *
 * A suffix rather than a separate group or an icon: the dropdown is one line
 * tall in a popover that is already crowded, `optgroup` is styled by the browser
 * and looks nothing like the rest of this panel, and the one thing a reader
 * needs is to know that Delete will not offer this name.
 */
export const PRESET_SUFFIX = ' · preset';

/**
 * The activities a layout can be asked to serve.
 *
 * Three of them come from what the character is doing and the fourth from what
 * is on screen — see the panel's activity reader. `NONE` is what a layout with
 * no opinion is mapped to, and is not an activity anything is ever detected as.
 */
export const ACTIVITY = {
    COMBAT: 'combat',
    SKILLING: 'skilling',
    LABYRINTH: 'labyrinth',
    MARKET: 'market',
    NONE: 'none',
};

const DASHBOARD_PRESET = {
    activity: ACTIVITY.NONE,
    order: [
        'netWorth',
        'coins',
        'accountView',
        'buildScore',
        'combatLevel',
        'timeToLevel',
        'experiencePerHour',
        'dps',
        'deathsPerHour',
        'luck',
        'totalProfit',
        'consumables',
        'queueTimeLeft',
        'noticeLog',
    ],
    span: { accountView: 2, luck: 2, totalProfit: 2, consumables: 2, queueTimeLeft: 2, noticeLog: 2 },
    // Nine figures make three even rows; then luck and profit, supplies, and the queue beside the log
    span3: { luck: 2, consumables: 3, noticeLog: 2 },
    // Figures pair up, accounts and profit are blocks, supplies and the log are wide
    sizes: {
        accountView: 'block',
        luck: 'block',
        totalProfit: 'block',
        consumables: 'wide',
        queueTimeLeft: 'block',
        noticeLog: 'wide',
    },
};

/**
 * The maintainer's own dense overlay: twenty tiles, nine columns. Its widths at
 * nine columns are the ones in `exact`, except that Treasure takes three rather
 * than four: four left the row of inventory, treasure and build score one column
 * short and wrapped Net Worth alone beneath it, and three closes the row.
 */
const DENSE_PRESET = {
    activity: ACTIVITY.NONE,
    order: [
        'battleTimer',
        'experiencePerHour',
        'deathsPerHour',
        'combatStatus',
        'combatRevenue',
        'timeToLevel',
        'houses',
        'totalProfit',
        'consumables',
        'equipmentWatch',
        'coins',
        'marketListings',
        'dps',
        'luck',
        'watchlist',
        'skillBooks',
        'inventoryValue',
        'treasure',
        'buildScore',
        'netWorth',
    ],
    // Blocks and the long lists take both columns, figures pair up
    span: {
        battleTimer: 2,
        combatStatus: 2,
        combatRevenue: 2,
        timeToLevel: 2,
        houses: 2,
        totalProfit: 2,
        consumables: 2,
        equipmentWatch: 2,
        dps: 2,
        treasure: 2,
    },
    // Timer; three figures; revenue; three; supplies beside the list; three; three; inventory beside treasure
    span3: { battleTimer: 3, combatRevenue: 3, equipmentWatch: 2, treasure: 2, netWorth: 2 },
    sizes: {
        battleTimer: 'block',
        combatRevenue: 'block',
        timeToLevel: 'block',
        houses: 'block',
        totalProfit: 'wide',
        consumables: 'block',
        equipmentWatch: 'wide',
        dps: 'block',
        treasure: 'block',
    },
    exact: {
        9: {
            battleTimer: 3,
            experiencePerHour: 2,
            deathsPerHour: 2,
            combatStatus: 2,
            combatRevenue: 3,
            timeToLevel: 3,
            houses: 3,
            totalProfit: 5,
            consumables: 4,
            equipmentWatch: 5,
            coins: 2,
            marketListings: 2,
            dps: 3,
            luck: 2,
            watchlist: 2,
            skillBooks: 2,
            inventoryValue: 2,
            treasure: 3,
            buildScore: 2,
            netWorth: 2,
        },
    },
};

/** Presets that resolve by name but are not offered in the Layouts switcher */
const UNLISTED_PRESETS = new Set(['Default']);

/**
 * The arrangements that ship with the script.
 *
 * Each preset is an **order and a set of spans**: the tiles it wants, in the
 * order they read, and how many columns each one takes. That is the whole of a
 * layout now — the browser derives the pixels from it every frame, at whatever
 * width the panel happens to be.
 *
 * It replaces a grid of cells, which replaced a bare list of keys, and the two
 * replacements were the same lesson learned twice. The bare list carried no
 * arrangement, so every tile arrived unplaced and was dropped wherever a packer
 * found a hole. The grid of cells carried an arrangement but had to be turned
 * into coordinates against a particular canvas, so it was correct at one width
 * and had to be rebuilt at every other. An order and a span are correct at every
 * width by construction: on a one-column panel a span of two clamps to one and
 * the order is unchanged, which is what makes these presets right on a phone
 * with no narrow-mode branch anywhere.
 *
 * The rule the grids held themselves to is kept, because it is a rule about
 * reading rather than about pixels: tiles that answer the same question sit
 * together, and a tile that carries a block rather than a figure — revenue,
 * luck, consumables — takes the full width rather than sharing a line.
 *
 * `span3` is the same arrangement for a grid of exactly three columns, where a
 * span of two beside a lone tile would leave a hole. It is applied when the
 * preset is built (see {@link presetFile}), so what is saved stays an order and
 * a flat map of spans in the shape every older build reads. Absent means the
 * flat `span` serves.
 *
 * From four columns up a preset carries `sizes` rather than a span per count:
 * each tile is a figure (the default), a block or a wide list, and
 * {@link wideSpans} turns those classes into spans that fill every row at the
 * columns there are. The flat `span` is what older builds read and what is saved
 * for one or two columns. `exact` pins the spans for one particular count.
 *
 * `activity` is what the preset answers for when auto-switching is on. A player
 * who maps one of their own layouts to the same activity takes precedence — the
 * preset is the fallback, not the rule.
 */
export const PRESET_LAYOUTS = {
    Combat: {
        activity: ACTIVITY.COMBAT,
        // What is happening, then how it is going, then what it is worth
        order: [
            'battleTimer',
            'dps',
            'deathsPerHour',
            'manaPerFight',
            'treasure',
            'combatRevenue',
            'luck',
            'combatSession',
            'consumables',
        ],
        // Treasure takes the second row's width so the five figures do not leave
        // a lone tile beside a block
        span: { treasure: 2, combatRevenue: 2, luck: 2, combatSession: 2, consumables: 2 },
        // Three figures, then mana beside treasure, revenue beside luck, and the
        // session beside the supplies block: four full rows, none of them a lone
        // block stretched across the width
        span3: { treasure: 2, combatRevenue: 2, consumables: 2 },
        sizes: { treasure: 'block', combatRevenue: 'block', consumables: 'wide' },
    },
    Skilling: {
        activity: ACTIVITY.SKILLING,
        // Where the trained skill stands and when it next levels, how fast it
        // is going and what it earns (Experience/hr and Total Profit both answer
        // for the running skilling action), then the supplies block, then the
        // queue and the purse. Every tile is one column but the supplies block,
        // so on a two-column panel the rows pair up (level and time, rate and
        // profit, queue and coins) and on a phone it is one even column.
        order: [
            'skillLevel',
            'timeToLevel',
            'experiencePerHour',
            'totalProfit',
            'consumables',
            'queueTimeLeft',
            'coins',
        ],
        span: { consumables: 2 },
        // Level, time and rate; profit beside the supplies block; queue beside coins
        span3: { consumables: 2, coins: 2 },
        sizes: { totalProfit: 'block', consumables: 'wide' },
    },
    Labyrinth: {
        activity: ACTIVITY.LABYRINTH,
        // The combat half, plus the three tiles a run is actually decided by:
        // what it is dropping, whether the sim agrees with what happened, and
        // whether you are about to run out of food
        order: ['dps', 'deathsPerHour', 'manaPerFight', 'treasure', 'combatSession', 'combatRevenue', 'consumables'],
        // Mana takes its row's width so treasure does not start below a lone tile
        span: { manaPerFight: 2, treasure: 2, combatSession: 2, combatRevenue: 2, consumables: 2 },
        // The three figures make a row, then treasure beside the session; revenue
        // and the supplies block each take their own
        span3: { treasure: 2, combatRevenue: 3, consumables: 3 },
        sizes: { treasure: 'block', combatRevenue: 'block', consumables: 'block' },
    },
    Market: {
        activity: ACTIVITY.MARKET,
        // The four figures that make up what you are worth, above the two lists
        // you keep open while trading. The lists used to carry a height hint
        // here; they now get the room from their own row's `defaultSize.height`,
        // which is where that knowledge belonged — the panel was guessing on the
        // row's behalf.
        order: ['netWorth', 'coins', 'inventoryValue', 'marketListings', 'skillBooks', 'watchlist', 'equipmentWatch'],
        span: { skillBooks: 2, watchlist: 2, equipmentWatch: 2 },
        // Worth, coins and inventory; listings beside the skill books; one list per row
        span3: { skillBooks: 2, watchlist: 3, equipmentWatch: 3 },
        sizes: { equipmentWatch: 'wide' },
    },
    /**
     * The starting dashboard, for a fresh character and for both Reset buttons.
     * Fourteen tiles that carry a character through every activity without
     * switching layouts. Mapped to `ACTIVITY.NONE`, which nothing is ever
     * detected as, so auto-switching never chooses it.
     *
     * Two columns: the six wide tiles (account, luck, profit, supplies, queue,
     * log) take both, and the eight narrow ones pair up (worth and coins, build
     * and combat level, time to level and experience rate, DPS and deaths). On a one-column panel
     * every span collapses to one.
     */
    Dashboard: DASHBOARD_PRESET,
    /** The maintainer's dense overlay: every tile on one screen, never auto-chosen (`ACTIVITY.NONE`) */
    Dense: DENSE_PRESET,
    /**
     * The old compact dashboard's name, kept resolvable and no longer offered
     * (see {@link UNLISTED_PRESETS}). It is the Dashboard itself: a character
     * whose applied layout or activity mapping says "Default" still applies
     * something sensible, and a saved layout of the same name still shadows it.
     */
    Default: DASHBOARD_PRESET,
};

/**
 * The preset names, in the order they should be offered.
 * @returns {string[]} Names
 */
export function presetNames() {
    return Object.keys(PRESET_LAYOUTS).filter((name) => !UNLISTED_PRESETS.has(name));
}

/**
 * Is this the name of a preset?
 * @param {string} name - A layout name
 * @returns {boolean}
 */
export function isPreset(name) {
    return Object.prototype.hasOwnProperty.call(PRESET_LAYOUTS, normalizeName(name));
}

/**
 * Which row keys exist right now.
 *
 * Only the keys, because a preset no longer needs to know how big anything is —
 * a span is a count of columns and a height is whatever the row draws. Null when
 * nothing has registered yet, which means "assume they all do" rather than "none
 * of them do": a preset built before the features have loaded must not switch
 * every row in the script off.
 *
 * @param {Array<Object>|null} rows - A registry snapshot, or null to read the live one
 * @returns {Set<string>|null} The keys, or null when the registry is empty
 */
function registryKeys(rows) {
    const registry = rows || registeredRows();
    if (!registry.length) return null;
    return new Set(registry.map((row) => row.key));
}

/** How wide each class of tile wants to be as a share of the columns, its least, and its pull on leftovers */
const SIZE_CLASSES = {
    figure: { share: 0.22, min: 1, weight: 0 },
    block: { share: 1 / 3, min: 2, weight: 1 },
    wide: { share: 0.5, min: 2, weight: 2 },
};

/**
 * Spans for a grid of four or more columns, resolved from tile classes.
 *
 * Each tile asks for its class's share of the grid (a figure about a fifth, a
 * block a third, a wide list half). Rows are filled in order, a tile that does
 * not fit starts the next row, and what is left of a row goes back to its
 * widest tiles one column at a time, so no row is left with a hole. Pure, and a
 * function of the count alone: the same preset at the same columns always gives
 * the same spans, whatever was on screen before.
 *
 * @param {string[]} order - Tiles in reading order
 * @param {Object} sizes - `{ [key]: 'figure'|'block'|'wide' }`; absent is a figure
 * @param {number} columns - Columns in the grid
 * @returns {Object} A flat span map holding only the tiles wider than one column
 */
export function wideSpans(order, sizes, columns) {
    const cols = Math.max(1, Math.min(MAX_SPAN, Math.round(columns)));
    const classOf = (key) => SIZE_CLASSES[sizes?.[key]] || SIZE_CLASSES.figure;
    const wanted = (key) => Math.min(cols, Math.max(classOf(key).min, Math.round(cols * classOf(key).share)));

    const rows = [[]];
    let used = 0;
    for (const key of order) {
        const want = wanted(key);
        if (used + want > cols && rows[rows.length - 1].length) {
            rows.push([]);
            used = 0;
        }
        rows[rows.length - 1].push({ key, span: want });
        used += want;
    }

    const span = {};
    for (const row of rows) {
        let left = cols - row.reduce((sum, tile) => sum + tile.span, 0);
        const widest = [...row].sort((a, b) => classOf(b.key).weight - classOf(a.key).weight);
        for (let at = 0; left > 0; at = (at + 1) % widest.length, left--) widest[at].span++;
        for (const tile of row) if (tile.span > 1) span[tile.key] = tile.span;
    }
    return span;
}

/**
 * The flat span map a preset uses at a given number of columns.
 *
 * Two columns take `span`, three take `span3` when there is one, four and more
 * take the preset's `exact` map for that count or else the resolved classes, and
 * a preset with no classes stays flat. One column needs nothing: spans clamp.
 *
 * @param {string} name - Preset name
 * @param {number} [columns] - Columns the grid has
 * @returns {Object|null} The spans, or null when there is no such preset
 */
export function presetSpans(name, columns = 2) {
    const preset = PRESET_LAYOUTS[normalizeName(name)];
    if (!preset) return null;
    if (columns === 3 && preset.span3) return { ...preset.span3 };
    if (columns >= 4 && preset.exact?.[columns]) return { ...preset.exact[columns] };
    if (columns >= 4 && preset.sizes) return wideSpans(preset.order, preset.sizes, columns);
    return { ...preset.span };
}

/**
 * A preset as a layout file, in exactly the shape a saved one has.
 *
 * Built through `toOPanelConfig` rather than hand-written, so a preset takes
 * the same road home as a layout you saved yourself: the same writer, the same
 * reader, the same application. A preset that arrived by a shortcut would be a
 * preset that behaves differently from everything around it in some way nobody
 * predicted.
 *
 * The arrangement travels as an order and a set of spans rather than as
 * coordinates, so there is nothing to build it against — see
 * {@link PRESET_LAYOUTS}. It is correct at whatever width it lands on.
 *
 * Everything not in `rows` is switched *off* rather than left alone. A preset
 * that only added tiles would leave whatever was up before sitting among them,
 * which is not a layout — it is the union of two.
 *
 * That has to be said **out loud, row by row**, and for a long time it was not.
 * The map carried a `true` for each of the preset's own rows and nothing at all
 * for the rest, on the assumption that an unmentioned row reads as off. It does
 * not: `resolveRows` falls back to the row's own `defaultVisible`, which is
 * `true` for nearly every row in the script. So on a character who had arranged
 * their overlay before the curated set existed — where there is no
 * `curatedDefaults` flag to catch it — applying the Skilling preset brought up
 * the seven tiles it names *and left eight others on*, unplaced, to be dropped
 * in below it. The preset's own tiles were exactly where they were designed to
 * be; the layout was still a mess, because it was the union of two after all.
 *
 * So every registered row the preset does not name is written `false`. The one
 * gap left is a row whose feature registers *after* the preset is applied: it
 * cannot be named by a map built before it existed, and comes up on its own
 * default. That is the same row a fresh update would add to any saved layout,
 * and it is one tick of the row picker to put away.
 *
 * @param {string} name - Preset name
 * @param {Object} [options] - How to build it
 * @param {Array<Object>} [options.rows] - A registry snapshot, for tests
 * @param {number} [options.columns] - The columns the grid has right now; picks `span3`, or the wide spans from four up
 * @returns {Object|null} A file for `fromOPanelConfig`, or null when there is no such preset
 */
export function presetFile(name, { rows = null, columns = 2 } = {}) {
    const preset = PRESET_LAYOUTS[normalizeName(name)];
    if (!preset) return null;

    const available = registryKeys(rows);

    // Off first, then the preset's own back on. Written this way round so that
    // adding a row to a preset cannot leave it switched off, and adding a row to
    // the script cannot leave it switched on.
    const visible = {};
    for (const key of available || []) visible[key] = false;
    for (const key of preset.order) visible[key] = true;

    return toOPanelConfig({
        version: 2,
        // Every preset is written for the two columns the default panel gives
        columns: 2,
        order: [...preset.order],
        span: presetSpans(name, columns),
        visible,
        zoom: {},
        // Applied locked. A preset is somebody else's arrangement arriving
        // under your cursor, and arriving unlocked means the first click that
        // lands on it drags a tile.
        locked: true,
        separators: true,
        textScale: 100,
    });
}

/**
 * Every name the dropdown should offer, and what kind each one is.
 *
 * A preset whose name has been taken by a saved layout is dropped rather than
 * listed twice: the saved one shadows it, and two identical names in a dropdown
 * is a dropdown that cannot be used.
 *
 * @param {Object} map - The stored map
 * @returns {Array<{name: string, preset: boolean, label: string}>} Names in offering order
 */
export function offeredLayouts(map) {
    const saved = layoutNames(map);
    const shadowed = new Set(saved);

    return [
        ...saved.map((name) => ({ name, preset: false, label: name })),
        ...presetNames()
            .filter((name) => !shadowed.has(name))
            .map((name) => ({ name, preset: true, label: `${name}${PRESET_SUFFIX}` })),
    ];
}

// ─── Auto-switching ─────────────────────────────────────────────────────────

/**
 * How long an activity has to hold before the layout follows it.
 *
 * Ten seconds, because the transitions are the problem rather than the
 * activities. A queue that runs out between two combat batches is a second of
 * "skilling" — actually of nothing — and a layout that redrew itself for it and
 * back again has cost you the tile you were reading twice. Nothing is lost by
 * waiting: an activity that lasts less than ten seconds is not one you were
 * going to read an overlay during.
 */
export const SWITCH_STABILITY_MS = 10_000;

/**
 * The state {@link decideAutoSwitch} carries between calls.
 * @returns {Object} A fresh state
 */
export function freshSwitchState() {
    return {
        /** What was last seen, and since when */
        seen: null,
        seenSince: 0,
        /** The activity the layout on screen was chosen for */
        applied: null,
        /**
         * Whether a hand-picked layout is holding auto-switching off, and what
         * was happening when it was picked. Two fields rather than one, because
         * "paused while nothing identifiable was going on" is a real state and
         * a null `pausedAt` cannot say it.
         */
        paused: false,
        pausedAt: null,
    };
}

/**
 * Which layout an activity should bring up.
 *
 * A layout the player mapped to the activity wins over the preset for it, which
 * is the whole point of the mapping — the preset is what "combat" means until
 * you have said what it means to you. Mappings naming a layout that has since
 * been deleted are ignored rather than applied as a missing name.
 *
 * @param {string} activity - One of {@link ACTIVITY}
 * @param {Object} mappings - `{ [layoutName]: activity }`, from the panel's settings
 * @param {string[]} [saved] - Names that actually exist
 * @returns {string|null} A layout name, or null when nothing serves this activity
 */
export function layoutForActivity(activity, mappings, saved = []) {
    if (!activity || activity === ACTIVITY.NONE) return null;

    const exists = new Set(saved);
    for (const [name, mapped] of Object.entries(mappings || {})) {
        if (mapped !== activity) continue;
        if (exists.has(name) || isPreset(name)) return name;
    }

    const preset = presetNames().find((name) => PRESET_LAYOUTS[name].activity === activity);
    return preset || null;
}

/**
 * Whether to switch layout, given what is going on.
 *
 * Four reasons not to, and they are the whole function:
 *
 * - **Too soon.** The activity has not held for {@link SWITCH_STABILITY_MS}.
 * - **Unlocked.** Tiles are being arranged, and replacing the layout underneath
 *   somebody who is dragging one is the worst thing this feature could do.
 * - **Already there.** The layout on screen was chosen for this activity.
 * - **Told not to.** A layout was applied by hand, and the activity has not
 *   changed since. Picking a layout is an instruction, and a feature that
 *   overrode it four seconds later would be a feature nobody leaves on. It
 *   resumes at the next *change* of activity rather than after a timeout,
 *   because that is the moment your choice stopped being about what you are
 *   doing now.
 *
 * Pure, and returns the next state rather than mutating: the caller runs this
 * on a one-second tick, and a decision function that keeps its own clock is one
 * that cannot be tested without waiting for it.
 *
 * @param {Object} input - Inputs
 * @param {Object} input.state - The last state, from {@link freshSwitchState}
 * @param {string|null} input.activity - What is happening now, or null when unknown
 * @param {number} input.now - Clock, in ms
 * @param {boolean} [input.enabled] - Whether auto-switching is on
 * @param {boolean} [input.locked] - Whether the layout is locked
 * @param {Object} [input.mappings] - `{ [layoutName]: activity }`
 * @param {string[]} [input.saved] - Saved layout names
 * @param {number} [input.stabilityMs] - How long an activity must hold
 * @returns {{state: Object, apply: string|null, activity: string|null}} The next state, and
 *   the layout to apply if any
 */
export function decideAutoSwitch({
    state,
    activity,
    now,
    enabled = true,
    locked = true,
    mappings = {},
    saved = [],
    stabilityMs = SWITCH_STABILITY_MS,
}) {
    const current = state || freshSwitchState();

    // A new reading restarts the clock, whether or not anything else is true —
    // the timer is about the world, not about whether we are allowed to act on
    // it, and pausing it while unlocked would make the first switch after a
    // relock take another ten seconds
    const seen = current.seen === activity ? current : { ...current, seen: activity, seenSince: now };

    // An activity that has actually changed is what releases a manual pause,
    // even when the new activity is one nothing is mapped to
    const changedSincePause = seen.paused && activity !== seen.pausedAt;
    const released = changedSincePause ? { ...seen, paused: false, pausedAt: null } : seen;

    if (!enabled || !locked || !activity) return { state: released, apply: null, activity };
    if (released.paused) return { state: released, apply: null, activity };
    if (now - released.seenSince < stabilityMs) return { state: released, apply: null, activity };
    if (released.applied === activity) return { state: released, apply: null, activity };

    const name = layoutForActivity(activity, mappings, saved);
    if (!name) return { state: released, apply: null, activity };

    return { state: { ...released, applied: activity }, apply: name, activity };
}

/**
 * Record that a layout was chosen by hand.
 *
 * @param {Object} state - The switch state
 * @param {string|null} activity - What is happening as the choice is made
 * @returns {Object} The next state
 */
export function pauseForManualChoice(state, activity) {
    const current = state || freshSwitchState();
    // `applied` is cleared as well: the layout on screen is no longer the one
    // auto-switching put there, so when the pause lifts the activity it was
    // paused during is one it may legitimately switch to again
    return { ...current, paused: true, pausedAt: activity ?? null, applied: null };
}
