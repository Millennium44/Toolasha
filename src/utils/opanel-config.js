/**
 * OPanel layout import and export
 *
 * Reading and writing MWI Combat Suite's OPanel configuration.
 *
 * A layout is worth an hour of fiddling and is then worth keeping. Someone
 * arriving from MCS has already spent that hour, and asking them to spend it
 * again is the main reason a second tool does not get used. The shapes are close
 * enough that this is mostly a rename.
 *
 * ## What does and does not survive
 *
 * Positions, sizes, text scales, order, which rows are on, the lock and the grid
 * all carry across unchanged — OPanel and this overlay measure them the same way.
 * Rows Toolasha has no equivalent for are **reported rather than dropped
 * silently**, because a layout that quietly arrives missing three tiles looks
 * like an import that half-worked.
 *
 * The panel's own position and size come across too, but separately: they live
 * in the geometry store rather than in the layout, so they are returned beside
 * it rather than inside it.
 *
 * ## Why the file also carries a Toolasha section
 *
 * OPanel names twenty rows. This overlay has half as many again — the watchlist,
 * charms, mana, the combat log, equipment savings — and OPanel has no key for
 * any of them. Written in OPanel's shape alone, a Toolasha layout comes back
 * missing every one of those, and rows that arrive with no position get laid out
 * wherever the packer puts them. Exporting from one character and importing on
 * another produced a jumble for exactly this reason.
 *
 * So the file carries **both**: `config` in OPanel's shape, which MCS reads and
 * this ignores when the other half is present, and `toolasha` carrying the
 * layout whole. MCS ignores keys it does not know, so the file stays readable by
 * both without either losing anything.
 *
 * Kept pure and apart from the panel so the mapping is testable without a DOM,
 * which is where a rename table's mistakes actually live.
 */

/**
 * OPanel's row keys against ours.
 *
 * Most are the same word. The ones that are not carry the name of whichever
 * script the row came from — `kollectionNetWorth`, `ewatchCoins`, `gwhizTTL` —
 * which is history rather than description, so ours are named for what they show.
 */
export const ROW_KEY_MAP = {
    battleTimer: 'battleTimer',
    combatRevenue: 'combatRevenue',
    consumables: 'consumables',
    experiencePerHour: 'experiencePerHour',
    totalProfit: 'totalProfit',
    dps: 'dps',
    overExpected: 'overExpected',
    luck: 'luck',
    deathsPerHour: 'deathsPerHour',
    houses: 'houses',
    equipmentWatch: 'equipmentWatch',
    combatStatus: 'combatStatus',
    treasure: 'treasure',
    ntallyInventory: 'inventoryValue',
    kollectionBuildScore: 'buildScore',
    kollectionNetWorth: 'netWorth',
    ewatchCoins: 'coins',
    ewatchMarket: 'marketListings',
    skillBooks: 'skillBooks',
    gwhizTTL: 'timeToLevel',
};

/**
 * Bumped only when the section's shape changes in a way a reader must know
 * about. It is written and never yet read, which is the point of writing it.
 */
const TOOLASHA_SECTION_VERSION = 1;

/** Ours back to theirs, for writing a file MCS can read */
const REVERSE_KEY_MAP = Object.fromEntries(Object.entries(ROW_KEY_MAP).map(([theirs, ours]) => [ours, theirs]));

/**
 * Does this look like an OPanel configuration?
 *
 * Checked by shape rather than by a version field, which OPanel does not write.
 * A config with rows in a known order and a sizes map is one; anything else is
 * declined rather than half-read.
 *
 * @param {Object} json - Parsed file
 * @returns {boolean}
 */
export function isOPanelConfig(json) {
    const config = json?.config;
    return !!config && (Array.isArray(config.order) || !!config.sizes || !!config.positions);
}

/**
 * Read an OPanel configuration into overlay settings.
 *
 * @param {Object} json - Parsed OPanel config file
 * @returns {{settings: Object, geometry: Object|null, unknown: string[]}|null}
 *   `settings` merges into the overlay's own, `geometry` is the panel's frame,
 *   and `unknown` names every row of theirs we have nothing to map to. `native`
 *   says the layout came from this overlay's own section rather than from
 *   OPanel's, which is the difference between coordinates that can be used as
 *   they are and coordinates that have to be laid out again. Null when the file
 *   is not an OPanel config.
 */
export function fromOPanelConfig(json) {
    if (!isOPanelConfig(json)) return null;

    // Our own section wins when the file has one: it names every row rather than
    // the twenty OPanel knows, and a layout half of whose rows arrive without a
    // position is a layout the packer rearranges from scratch
    const native = readToolashaSection(json);
    if (native) return { settings: native, geometry: readGeometry(json), unknown: [], native: true };

    const config = json.config;
    const unknown = [];

    /**
     * @param {string} theirKey - An OPanel row key
     * @returns {string|null} Ours, recording the miss
     */
    const translate = (theirKey) => {
        const ours = ROW_KEY_MAP[theirKey];
        if (!ours && !unknown.includes(theirKey)) unknown.push(theirKey);
        return ours || null;
    };

    const visible = {};
    const positions = {};
    const sizes = {};
    const zoom = {};
    const order = [];

    for (const theirKey of config.order || []) {
        const ours = translate(theirKey);
        if (ours) order.push(ours);
    }

    // Visibility is a bare boolean beside the display sub-options in the same
    // object, so it is read from the key map rather than by walking the object —
    // `snapToGrid` is not a row
    for (const theirKey of Object.keys(ROW_KEY_MAP)) {
        if (typeof config[theirKey] === 'boolean') visible[ROW_KEY_MAP[theirKey]] = config[theirKey];
    }

    for (const [theirKey, value] of Object.entries(config.positions || {})) {
        const ours = translate(theirKey);
        if (ours && Number.isFinite(value?.x) && Number.isFinite(value?.y)) {
            positions[ours] = { x: value.x, y: value.y };
        }
    }

    for (const [theirKey, value] of Object.entries(config.sizes || {})) {
        const ours = translate(theirKey);
        if (ours && value?.width > 0 && value?.height > 0) {
            sizes[ours] = { width: value.width, height: value.height };
        }
    }

    for (const [theirKey, value] of Object.entries(json.zoom_levels || {})) {
        const ours = translate(theirKey);
        if (ours && Number.isFinite(value)) zoom[ours] = value;
    }

    const settings = { visible, order, positions, sizes, zoom };
    if (typeof config.snapToGrid === 'boolean') settings.snapToGrid = config.snapToGrid;
    if (typeof json.is_locked === 'boolean') settings.locked = json.is_locked;

    return { settings, geometry: readGeometry(json), unknown, native: false };
}

/**
 * The layout as this overlay stores it, if the file carries one.
 *
 * Validated rather than trusted: a hand-edited or truncated file should be
 * declined so the OPanel half is read instead, which is worse but not wrong.
 *
 * @param {Object} json - Parsed file
 * @returns {Object|null} Settings, or null when there is no usable section
 */
function readToolashaSection(json) {
    const saved = json?.toolasha?.settings;
    if (!saved || !Array.isArray(saved.order) || !saved.order.length) return null;

    const settings = {
        order: saved.order.filter((key) => typeof key === 'string'),
        visible: {},
        positions: {},
        sizes: {},
        zoom: {},
    };

    for (const [key, on] of Object.entries(saved.visible || {})) settings.visible[key] = !!on;

    for (const [key, value] of Object.entries(saved.positions || {})) {
        if (Number.isFinite(value?.x) && Number.isFinite(value?.y))
            settings.positions[key] = { x: value.x, y: value.y };
    }

    for (const [key, value] of Object.entries(saved.sizes || {})) {
        if (value?.width > 0 && value?.height > 0) settings.sizes[key] = { width: value.width, height: value.height };
    }

    for (const [key, value] of Object.entries(saved.zoom || {})) {
        if (Number.isFinite(value)) settings.zoom[key] = value;
    }

    if (typeof saved.snapToGrid === 'boolean') settings.snapToGrid = saved.snapToGrid;
    if (typeof saved.locked === 'boolean') settings.locked = saved.locked;
    if (typeof saved.separators === 'boolean') settings.separators = saved.separators;
    if (Number.isFinite(saved.textScale)) settings.textScale = saved.textScale;

    return settings;
}

/**
 * The panel's own frame, if the file carries one.
 * @param {Object} json - Parsed OPanel config
 * @returns {Object|null} `{left, top, width, height}`
 */
function readGeometry(json) {
    const geometry = {};
    if (Number.isFinite(json?.position?.left)) geometry.left = Math.round(json.position.left);
    if (Number.isFinite(json?.position?.top)) geometry.top = Math.round(json.position.top);
    if (json?.size?.width > 0) geometry.width = Math.round(json.size.width);
    if (json?.size?.height > 0) geometry.height = Math.round(json.size.height);
    return Object.keys(geometry).length ? geometry : null;
}

/**
 * Write overlay settings out in OPanel's shape.
 *
 * Rows OPanel has no key for are left out — writing ours into their file would
 * produce something MCS reads as corrupt rather than as extended.
 *
 * @param {Object} settings - The overlay's settings
 * @param {Object} [geometry] - The panel's frame
 * @returns {Object} A file OPanel can read
 */
export function toOPanelConfig(settings, geometry = null) {
    const config = { order: [], sizes: {}, positions: {}, firstLoad: false };
    const zoomLevels = {};

    for (const ourKey of settings?.order || []) {
        const theirs = REVERSE_KEY_MAP[ourKey];
        if (theirs) config.order.push(theirs);
    }

    for (const [ourKey, on] of Object.entries(settings?.visible || {})) {
        const theirs = REVERSE_KEY_MAP[ourKey];
        if (theirs) config[theirs] = !!on;
    }

    for (const [ourKey, value] of Object.entries(settings?.positions || {})) {
        const theirs = REVERSE_KEY_MAP[ourKey];
        if (theirs) config.positions[theirs] = { x: value.x, y: value.y };
    }

    for (const [ourKey, value] of Object.entries(settings?.sizes || {})) {
        const theirs = REVERSE_KEY_MAP[ourKey];
        if (theirs) config.sizes[theirs] = { width: value.width, height: value.height };
    }

    for (const [ourKey, value] of Object.entries(settings?.zoom || {})) {
        const theirs = REVERSE_KEY_MAP[ourKey];
        if (theirs) zoomLevels[theirs] = value;
    }

    config.snapToGrid = settings?.snapToGrid !== false;

    return {
        config,
        is_locked: settings?.locked !== false,
        position: geometry ? { top: geometry.top ?? 0, left: geometry.left ?? 0 } : undefined,
        size: geometry?.width ? { width: geometry.width, height: geometry.height } : undefined,
        zoom_levels: zoomLevels,
        // The layout whole, beside the twenty rows OPanel has names for. MCS
        // ignores keys it does not know, so this costs it nothing and is the
        // difference between a Toolasha layout surviving a round trip and
        // arriving with a third of its rows unplaced.
        toolasha: { version: TOOLASHA_SECTION_VERSION, settings: nativeSection(settings) },
    };
}

/**
 * The layout as this overlay holds it, trimmed to what a file needs.
 *
 * Copied field by field rather than spread, so a future setting that has no
 * business in a layout file — a cache, a timestamp — does not silently start
 * travelling between characters.
 *
 * @param {Object} settings - The overlay's settings
 * @returns {Object}
 */
function nativeSection(settings) {
    return {
        order: [...(settings?.order || [])],
        visible: { ...(settings?.visible || {}) },
        positions: { ...(settings?.positions || {}) },
        sizes: { ...(settings?.sizes || {}) },
        zoom: { ...(settings?.zoom || {}) },
        snapToGrid: settings?.snapToGrid !== false,
        locked: settings?.locked !== false,
        separators: settings?.separators !== false,
        textScale: settings?.textScale,
    };
}
