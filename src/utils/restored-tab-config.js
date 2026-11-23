/**
 * Restored custom-tab configs, stamped as changed now.
 *
 * A tab the player deleted by hand leaves a removal record (`clearedAll`, see `removeTab` in
 * `features/inventory/custom-tabs/custom-tabs-data.js`) that deletes every copy of that id stamped before it, an
 * unstamped one included, for 30 days. A backup or settings file restored inside that window brings the tab back with
 * its old stamp (or none), and the next fold with the gist, which still carries the record, deleted it again: the
 * restore the player just chose was undone without a word. A restore IS the newest thing that happened to those tabs,
 * so every restored tab is stamped `now`, which every record and tombstone written before the restore spares.
 */

const TAB_CONFIG_KEY = 'inventoryTabs_config';

/**
 * Whether a settings key holds a custom-tab config (`<charId>_inventoryTabs_config`, or the unscoped legacy key).
 * @param {string} key
 * @returns {boolean}
 */
export function isTabConfigKey(key) {
    return typeof key === 'string' && (key === TAB_CONFIG_KEY || key.endsWith(`_${TAB_CONFIG_KEY}`));
}

/**
 * The newest deletion time the config itself carries: its removal records' `at` and its tombstones.
 * A restored tab must outlive these too, because the restoring device's clock can be behind the one that
 * wrote the backup, so `now` alone could fall below a record the tab had already survived.
 * @param {Object} config
 * @returns {number}
 */
function newestDeletion(config) {
    let newest = 0;
    const consider = (value) => {
        const at = Number(value);
        if (Number.isFinite(at) && at > newest) newest = at;
    };
    for (const record of Object.values(config.clearedAll || {})) consider(record?.at);
    for (const when of Object.values(config.removed || {})) consider(when);
    return newest;
}

/**
 * @param {Array} tabs
 * @param {number} floor - The least stamp a restored tab may carry
 * @returns {Array} Copies, every tab and descendant stamped at least `floor`, a newer own stamp kept
 */
function stampTree(tabs, floor) {
    return tabs.map((tab) => {
        if (!tab || typeof tab !== 'object') return tab;
        const own = Number(tab.updatedAt);
        const out = { ...tab, updatedAt: Number.isFinite(own) && own > floor ? own : floor };
        if (Array.isArray(tab.children)) out.children = stampTree(tab.children, floor);
        return out;
    });
}

/**
 * A restored tab config with every tab, nested ones included, stamped `now`. Anything that is not a config with a
 * tab list comes back as it was; a JSON string comes back as a string.
 * @param {*} value - The config as the backup holds it
 * @param {number} [now]
 * @returns {*} The config to write
 */
export function restampRestoredTabConfig(value, now = Date.now()) {
    let config = value;
    if (typeof value === 'string') {
        try {
            config = JSON.parse(value);
        } catch {
            return value;
        }
    }
    if (!config || typeof config !== 'object' || !Array.isArray(config.tabs)) return value;
    const out = { ...config, tabs: stampTree(config.tabs, Math.max(now, newestDeletion(config) + 1)) };
    return typeof value === 'string' ? JSON.stringify(out) : out;
}
