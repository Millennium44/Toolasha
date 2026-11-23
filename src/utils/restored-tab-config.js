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
 * @param {Array} tabs
 * @param {number} now
 * @returns {Array} Copies, every tab and descendant stamped `now`
 */
function stampTree(tabs, now) {
    return tabs.map((tab) => {
        if (!tab || typeof tab !== 'object') return tab;
        const out = { ...tab, updatedAt: now };
        if (Array.isArray(tab.children)) out.children = stampTree(tab.children, now);
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
    const out = { ...config, tabs: stampTree(config.tabs, now) };
    return typeof value === 'string' ? JSON.stringify(out) : out;
}
