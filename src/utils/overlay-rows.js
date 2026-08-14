/**
 * Overlay Rows
 *
 * The registry of rows the overlay panel draws.
 *
 * Deliberately here in `utils` rather than beside the panel in `features/ui`,
 * because of how this project ships. The production build is six separate
 * bundles loaded in order — core, utils, market, actions, combat, ui — and a
 * module that is not declared shared is **copied into every bundle that imports
 * it**, each copy with its own state. A registry living in the UI bundle would
 * therefore give the combat features one row list, the market features another,
 * and the panel a third, so the panel would render nothing. Worse, ui loads
 * last, so a combat feature registering at module scope would be reaching for a
 * bundle that does not exist yet.
 *
 * Utils loads before every feature bundle and is declared shared in
 * `rollup.config.js`, so there is exactly one list and it exists before anyone
 * registers into it.
 *
 * None of this shows up in the dev standalone build, which is a single bundle
 * where every arrangement works.
 */

import { overlayPanel } from './bundle-bridge.js';

/**
 * Rows, in registration order.
 *
 * Module-level so a feature can register while the shell is still asleep — the
 * alternative is every feature having to know whether the panel has started yet.
 * @type {Array<{key: string, name: string, render: Function, defaultVisible: boolean}>}
 */
const rows = [];

/**
 * Add a row to the overlay.
 *
 * Safe to call before the panel exists, and safe to call twice — a repeated key
 * replaces the earlier definition rather than drawing the row twice, so a feature
 * that re-initialises does not double up.
 *
 * @param {Object} row - Row definition
 * @param {string} row.key - Stable identifier, used as the storage key
 * @param {string} row.name - Label in the row picker
 * @param {Function} row.render - `(container: HTMLElement) => void`, called per refresh
 * @param {boolean} [row.defaultVisible] - Whether it starts on
 * @param {Function} [row.onOpen] - Called when the row is double-clicked. A row is
 *   a summary; this is where the panel behind it opens. It should **toggle**,
 *   since the same gesture is what you reach for to dismiss what it summoned.
 *   Rows without one are simply not interactive.
 * @param {{width: number, height: number}} [row.defaultSize] - How large a tile the row
 *   needs before anyone has resized it. A row knows how much it draws; the panel
 *   does not, and guessing one size for all of them leaves half of them clipped.
 * @param {number} [row.defaultZoom] - Starting text size, as a percentage
 * @param {string} [row.empty] - What the tile says when the row draws nothing,
 *   and only where that is worth a whole tile — see {@link emptyPolicyFor}, which
 *   decides whether an empty tile says this, says its own name, or stands down.
 *   Defaults to naming the row.
 * @param {string} [row.tileClass] - One of {@link TILE_CLASS}. What kind of thing
 *   the tile shows, which is what decides how it behaves before it has anything
 *   to show. Optional: rows that do not say are classed by the table below.
 * @param {string} [row.whenEmpty] - `hide`, `compact` or `full`, when this
 *   particular row wants something other than what its class would give it.
 */
export function registerRow({
    key,
    name,
    render,
    defaultVisible = true,
    onOpen = null,
    defaultSize = null,
    defaultZoom = null,
    empty = '',
    tileClass = '',
    whenEmpty = '',
}) {
    if (!key || typeof render !== 'function') {
        console.error('[OverlayPanel] A row needs a key and a render function:', key);
        return;
    }

    const definition = {
        key,
        name: name || key,
        render,
        defaultVisible,
        onOpen,
        defaultSize,
        defaultZoom,
        empty,
        tileClass,
        whenEmpty,
    };
    const existing = rows.findIndex((row) => row.key === key);
    if (existing >= 0) rows[existing] = definition;
    else rows.push(definition);
}

/**
 * The registered rows, in the order they should be offered.
 * Exported for tests and for anything that wants to know what is available.
 * @returns {Array<Object>} Row definitions
 */
export function registeredRows() {
    return [...rows];
}

/**
 * What kind of thing a tile shows.
 *
 * The distinction only matters in one place, and it is the place the overlay was
 * worst at: what a tile does before it has anything to show. A net worth that
 * has not been counted yet will be counted in a moment, and saying so is worth a
 * dim line. A dungeon run that has not happened may never happen, and a tile
 * reserving space for it is a tile in the way — every one of those placeholders
 * is a promise the overlay is making about a number it does not have.
 */
export const TILE_CLASS = {
    /** Reads state the game already has, so it fills itself in shortly */
    VALUE: 'value',
    /** Needs something to happen first — a fight, a run, a chest opened */
    MEASUREMENT: 'measurement',
    /** Shows what you asked it to watch, and is empty until you ask */
    WATCH: 'watch',
};

/** What a tile does when it has drawn nothing */
export const EMPTY_POLICY = {
    /** Whatever the tile's class says; the setting's default */
    AUTO: 'auto',
    /** Not drawn at all until there is something to draw */
    HIDE: 'hide',
    /** A dim strip carrying the tile's own name */
    COMPACT: 'compact',
    /** The row's full placeholder line, at the tile's full size */
    FULL: 'full',
};

/**
 * Every registered row's class.
 *
 * Here rather than in the `registerRow` calls because those live across a dozen
 * feature files owned by as many features, and the classification is one
 * judgement about the overlay as a whole — it wants to be readable in one place,
 * beside the curated default set it has to agree with. A row may still say for
 * itself with `tileClass`, and anything unlisted is treated as a value, which is
 * the forgiving answer: an unrecognised tile shows a dim name rather than
 * vanishing.
 */
const TILE_CLASSES = {
    // Figures the game already knows, or knows as soon as it has loaded
    netWorth: TILE_CLASS.VALUE,
    coins: TILE_CLASS.VALUE,
    inventoryValue: TILE_CLASS.VALUE,
    marketListings: TILE_CLASS.VALUE,
    skillBooks: TILE_CLASS.VALUE,
    buildScore: TILE_CLASS.VALUE,
    combatLevel: TILE_CLASS.VALUE,
    houses: TILE_CLASS.VALUE,
    accountView: TILE_CLASS.VALUE,
    guildRoster: TILE_CLASS.VALUE,
    combatStatus: TILE_CLASS.VALUE,
    battleTimer: TILE_CLASS.VALUE,
    consumables: TILE_CLASS.VALUE,
    // The queue is state the game holds; the plan is state this script holds,
    // and both are true the moment they are read
    queueTimeLeft: TILE_CLASS.VALUE,
    goalNextStep: TILE_CLASS.VALUE,

    // Nothing to say until you have done something
    // Drop Luck and Over Expected % are one tile now, under luck's key
    luck: TILE_CLASS.MEASUREMENT,
    dps: TILE_CLASS.MEASUREMENT,
    combatRevenue: TILE_CLASS.MEASUREMENT,
    totalProfit: TILE_CLASS.MEASUREMENT,
    experiencePerHour: TILE_CLASS.MEASUREMENT,
    deathsPerHour: TILE_CLASS.MEASUREMENT,
    combatSession: TILE_CLASS.MEASUREMENT,
    manaPerFight: TILE_CLASS.MEASUREMENT,
    timeToLevel: TILE_CLASS.MEASUREMENT,
    treasure: TILE_CLASS.MEASUREMENT,
    charmValue: TILE_CLASS.MEASUREMENT,
    replayCheck: TILE_CLASS.MEASUREMENT,
    predictionCalibration: TILE_CLASS.MEASUREMENT,
    combatText: TILE_CLASS.MEASUREMENT,
    // Each waits on something being under way — an enhancement started, a task
    // board dealt, a trial tab looked at — and none of the three is a figure a
    // fresh character would ever see filled in
    enhancementSession: TILE_CLASS.MEASUREMENT,
    taskTokens: TILE_CLASS.MEASUREMENT,
    guildTrialsPace: TILE_CLASS.MEASUREMENT,

    // Empty until you put something in them
    watchlist: TILE_CLASS.WATCH,
    equipmentWatch: TILE_CLASS.WATCH,
};

/**
 * The tiles a character who has never arranged the overlay starts with.
 *
 * Small on purpose, and grouped on purpose. Every row defaulting to on gave a
 * first open that was a wall of placeholders with three real figures buried in
 * it, and a panel where nothing is worth reading is a panel nobody opens twice.
 * So the set is curated into three clusters, and the order below is the order
 * they are placed in — left to right and wrapping — so the clusters read as
 * clusters:
 *
 *   - **Wealth**: what you are worth and carrying, true the moment the game
 *     loads.
 *   - **Character**: where you stand, also true on load.
 *   - **This session**: what you are doing and what it is earning.
 *
 * The count looks larger than the old eight, but the wall it guarded against is
 * a wall of *value* tiles — the ones that always draw. The session cluster is
 * all measurements, and a measurement hides until it has data (see
 * {@link emptyPolicyFor}). So a fresh or non-combat character sees only the five
 * value tiles; the combat figures cost nothing until a fight makes them real,
 * then fill in beside each other rather than scattering. The rest are one click
 * away in ⚙, where a list of switched-off rows reads as a menu rather than as
 * clutter — and ⚙ also has a "Reset to default tiles" that puts any character
 * back to exactly this set.
 */
export const CURATED_ROWS = [
    // Wealth — true the moment the game loads
    'netWorth',
    'coins',
    'inventoryValue',
    // Character — where you stand, also on load
    'buildScore',
    'combatLevel',
    // This session — hides until you are fighting, then fills in
    'combatStatus',
    'experiencePerHour',
    'totalProfit',
    'dps',
    'deathsPerHour',
    'luck',
    'timeToLevel',
];

/**
 * Which class a row belongs to.
 * @param {Object} row - A row definition
 * @returns {string} One of {@link TILE_CLASS}
 */
export function tileClassFor(row) {
    const declared = row?.tileClass;
    if (declared && Object.values(TILE_CLASS).includes(declared)) return declared;
    return TILE_CLASSES[row?.key] || TILE_CLASS.VALUE;
}

/**
 * What a tile that drew nothing should do about it.
 *
 * The setting wins where it has an opinion, so somebody who wants the old wall
 * of placeholders back — or wants every empty tile gone — says so once and is
 * obeyed everywhere. Left on `auto`, the class decides, and a watch tile decides
 * on top of that: "nothing watched" is only worth a line when there is something
 * you can do about it, which means the tile has to be able to open the panel you
 * would add to. A watch tile with no `onOpen` is a dead end, and stands down.
 *
 * @param {Object} row - A row definition
 * @param {string} [setting] - The panel's `emptyTiles` setting
 * @returns {string} `hide`, `compact` or `full`
 */
export function emptyPolicyFor(row, setting = EMPTY_POLICY.AUTO) {
    const forced = [EMPTY_POLICY.HIDE, EMPTY_POLICY.COMPACT, EMPTY_POLICY.FULL];
    if (forced.includes(setting)) return setting;
    if (forced.includes(row?.whenEmpty)) return row.whenEmpty;

    switch (tileClassFor(row)) {
        case TILE_CLASS.MEASUREMENT:
            return EMPTY_POLICY.HIDE;
        case TILE_CLASS.WATCH:
            return typeof row?.onOpen === 'function' ? EMPTY_POLICY.COMPACT : EMPTY_POLICY.HIDE;
        default:
            return EMPTY_POLICY.COMPACT;
    }
}

/**
 * What a compact tile says.
 *
 * Its own name, never its placeholder line. Two rows are allowed to have nothing
 * to report in the same words — "Nothing watched" belongs to both the watchlist
 * and the equipment watch, "No run measured yet" to both luck tiles — and two
 * identical strips sitting beside each other are worse than one, because now you
 * cannot even tell which feature is idle. A name is the one thing a tile has
 * that is its own.
 *
 * @param {Object} row - A row definition
 * @returns {string} The line to draw
 */
export function compactLabel(row) {
    const name = row?.name || row?.key || '';
    if (tileClassFor(row) === TILE_CLASS.WATCH && typeof row?.onOpen === 'function') return `${name} — click to add`;
    return name;
}

/**
 * What a tile is waiting for, in one short line.
 *
 * Only ever shown to somebody who has just switched the tile on by hand. The
 * auto-hiding policies above are the right *passive* default — a fresh character
 * should not open the overlay onto a wall of promises — but they are the wrong
 * answer to a gesture. Switching a tile on and watching nothing appear is not
 * "the overlay is decluttering for me", it is "the overlay is broken", and that
 * is exactly how it was reported. So the gesture gets an answer: the tile draws,
 * dim, saying what it is waiting for. The decluttering rationale survives intact
 * because nobody asked for the tiles it hides.
 *
 * @param {Object} row - A row definition
 * @returns {string} A line to draw under the row's name
 */
export function waitingLine(row) {
    switch (tileClassFor(row)) {
        case TILE_CLASS.MEASUREMENT:
            return 'waiting for data';
        case TILE_CLASS.WATCH:
            return typeof row?.onOpen === 'function' ? 'waiting for something to watch' : 'nothing watched yet';
        default:
            return 'waiting for the game to load this';
    }
}

/**
 * What a row promises about when it will appear, for the ⚙ list.
 *
 * The contract a tile is under ought to be legible *before* it is switched on,
 * not discovered afterwards by its absence. Empty for the tiles that fill
 * themselves in, because a caption on every chip is a caption nobody reads.
 *
 * @param {Object} row - A row definition
 * @returns {string} A short badge, or an empty string when there is nothing to warn about
 */
export function emptyContract(row) {
    switch (tileClassFor(row)) {
        case TILE_CLASS.MEASUREMENT:
            return 'shows when it has data';
        case TILE_CLASS.WATCH:
            return 'shows what you add to it';
        default:
            return '';
    }
}

/**
 * Put saved settings and the rows that actually exist together.
 *
 * Kept pure so the awkward cases are testable: a row saved in the order but since
 * removed from the code, and a row added by an update that no saved order has
 * heard of. The first must not leave a hole and the second must not be lost at
 * the bottom of a list nobody knows to look at.
 *
 * `curatedDefaults` is what tells a character who has never touched the overlay
 * from one who arranged it before the curated set existed. It is set once, when
 * the panel finds nothing saved, and persists — so an existing layout keeps
 * answering "is this row on?" the way it always did, with each row's own
 * `defaultVisible`, and only a fresh one gets {@link CURATED_ROWS}. A row the
 * settings have an explicit opinion about beats both.
 *
 * @param {Array<Object>} available - Registered rows
 * @param {Object} saved - `{ visible: {key: bool}, order: string[], curatedDefaults: bool }`
 * @returns {Array<Object>} Rows to draw, in order, each with `visible`
 */
export function resolveRows(available, saved) {
    const order = saved?.order || [];
    const visible = saved?.visible || {};
    const curated = saved?.curatedDefaults === true;

    const known = new Map(available.map((row) => [row.key, row]));
    const ordered = [];

    for (const key of order) {
        const row = known.get(key);
        // A key left over from a row that no longer exists
        if (!row) continue;
        ordered.push(row);
        known.delete(key);
    }
    // Anything the saved order has not heard of is new, and goes at the end
    ordered.push(...known.values());

    // Nobody has arranged anything yet, so the curated set is the arrangement:
    // its tiles first and in its order, which is what the initial packing lays
    // out. Sorting is stable, so everything else keeps registration order.
    if (curated && !order.length) {
        const rank = (key) => {
            const index = CURATED_ROWS.indexOf(key);
            return index < 0 ? CURATED_ROWS.length : index;
        };
        ordered.sort((a, b) => rank(a.key) - rank(b.key));
    }

    return ordered.map((row) => ({
        ...row,
        visible: visible[row.key] ?? (curated ? CURATED_ROWS.includes(row.key) : row.defaultVisible),
    }));
}

/**
 * Move a key one place through an order.
 *
 * Works on the full order rather than only the visible rows, so hiding a row and
 * showing it again does not quietly move it.
 *
 * @param {string[]} order - Current order
 * @param {string} key - What to move
 * @param {number} delta - -1 for up, 1 for down
 * @returns {string[]} A new order
 */
export function moveRow(order, key, delta) {
    const index = order.indexOf(key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return order;

    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

/**
 * A tile's display option, as set in the overlay's own settings.
 *
 * Some tiles can be drawn more than one way — with or without the names beside
 * the figures, for one player or for the party — and OPanel keeps those choices
 * beside the row list rather than in a settings dialog, which is where somebody
 * arranging an overlay is already looking.
 *
 * Read through the global rather than imported: the panel that owns these lives
 * in the UI bundle and the rows that read them are scattered across the others,
 * so importing it would put a second copy of the panel in every one of them.
 *
 * @param {string} key - The option, e.g. `luckOnlyNumbers`
 * @returns {boolean} False when the panel is not up, which is the quiet default
 */
export function rowOption(key) {
    return Boolean(overlayPanel()?.settings?.[key]);
}
