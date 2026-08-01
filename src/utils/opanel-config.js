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
 *   and `unknown` names every row of theirs we have nothing to map to. Null when
 *   the file is not an OPanel config.
 */
export function fromOPanelConfig(json) {
    if (!isOPanelConfig(json)) return null;

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

    return { settings, geometry: readGeometry(json), unknown };
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
    };
}
