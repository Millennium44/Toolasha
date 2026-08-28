/**
 * Combat Simulator Targets
 *
 * The external combat simulators the "Import from Toolasha" flow drives, in one place.
 *
 * Both supported simulators are forks of the same MCS lineage, so they share the export/import
 * JSON format `combat-sim-export.js` builds and (bar one id) the selectors
 * `combat-sim-integration.js` drives — the only per-simulator fact is the domain. Adding a
 * simulator is therefore a matter of listing it here, adding its `@match` to the userscript
 * headers, and adding its URL fragment to `isCombatSimulatorPage()` in `src/entrypoint.js`.
 *
 * `src/entrypoint.js` is a standalone bundle that imports nothing from `src/` (it reads the
 * @require'd libraries off `window.Toolasha`), so it cannot import this module and keeps its own
 * inline copy of the fragments. `combat-sim-targets.test.js` asserts the copies stay in sync with
 * this list and with both userscript headers, so a third simulator cannot be half-added.
 */

/**
 * @typedef {object} CombatSimTarget
 * @property {string} id Stable identifier
 * @property {string} label Nav-link label shown in the game's sidebar
 * @property {string} url Landing page opened by the nav link
 * @property {string} urlFragment Substring that identifies the simulator page at runtime
 * @property {string} match Userscript `@match` pattern granting the script access to the page
 */

/** @type {CombatSimTarget[]} */
export const COMBAT_SIM_TARGETS = [
    {
        id: 'shykai',
        label: 'Combat Sim',
        url: 'https://shykai.github.io/MWICombatSimulatorTest/dist/',
        urlFragment: 'shykai.github.io/MWICombatSimulatorTest/dist/',
        match: 'https://shykai.github.io/MWICombatSimulatorTest/dist/*',
    },
    {
        id: 'szerra',
        label: 'Combat Sim (Shrine)',
        url: 'https://szerra.github.io/mwi-shrine-combat-simulator/',
        urlFragment: 'szerra.github.io/mwi-shrine-combat-simulator/',
        match: 'https://szerra.github.io/mwi-shrine-combat-simulator/*',
    },
];

/**
 * Which supported simulator a URL belongs to, if any.
 * @param {string} [url] URL to test; defaults to the current location
 * @returns {CombatSimTarget|null} The matching target, or null when the URL is not a simulator page
 */
export function combatSimTargetForUrl(url = typeof window !== 'undefined' ? window.location.href : '') {
    if (typeof url !== 'string' || !url) return null;
    return COMBAT_SIM_TARGETS.find((target) => url.includes(target.urlFragment)) || null;
}

/**
 * Detect if a URL is a supported Combat Simulator page.
 * @param {string} [url] URL to test; defaults to the current location
 * @returns {boolean} True if on a Combat Simulator
 */
export function isCombatSimulatorPage(url) {
    return combatSimTargetForUrl(url) !== null;
}
