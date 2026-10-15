/**
 * The Combat Sim and Lab Sim panel keys a sync pull may replace under a running page.
 *
 * Every settings key without a registered merge is latched when a pull writes it, and the
 * sync then asks for a reload. These are the simulators' remembered choices and results:
 * each is registered here with a fold and marked `liveSafe`, and each panel re-reads the
 * keys it owns when a pull lands (`onSyncPullApplied` in `lab-sim-ui.js` and
 * `combat-sim-ui.js`), so the pull applies without a reload.
 *
 * Registered here rather than in the panels so a test can check the whole list without
 * building a panel. This module imports nothing but the registry.
 *
 * Keys owned by a store module register there instead: `labSimComparisonRuns` and
 * `labSimComparisonBaseline` (`lab-sim-comparison.js`), `combatSimTriggerLastResult`
 * (`trigger-result-cache.js`), `zoneSimRates` (`utils/all-zones-snapshot.js`) and
 * `labSimSkillingLoadouts` (`lab-skilling-loadouts.js`).
 */
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { stableStringify } from '../../utils/stable-stringify.js';

/** The Lab Sim panel's per-character keys, all in `settings` */
export const LAB_SIM_KEYS = Object.freeze({
    upgradeDimensions: 'labSimUpgradeDimensions',
    upgradeScope: 'labSimUpgradeScope',
    upgradeLevelSource: 'labSimUpgradeLevelSource',
    swapAuraOnly: 'labSimSwapAuraOnly',
    shrineCapToGuild: 'labSimShrineCapToGuild',
    upgradeRoomLevels: 'labSimUpgradeRoomLevels',
    upgradeTargetFloor: 'labSimUpgradeTargetFloor',
    legacyUpgradeMode: 'labSimUpgradeMode',
    skillingRoomLevels: 'labSimSkillingRoomLevels',
    skillingTargetClear: 'labSimSkillingTargetClear',
    skillingTargetFloor: 'labSimSkillingTargetFloor',
    tokenBuffLevels: 'labSimTokenBuffLevels',
    checkedSwaps: 'labSimCheckedSwaps',
});

/** The Combat Sim panel's keys in `settings`: per character unless marked global */
export const COMBAT_SIM_KEYS = Object.freeze({
    upgradeModes: 'combatSimUpgradeModes',
    triggerChoices: 'combatSimTriggerChoices',
    swapAuraOnly: 'combatSimSwapAuraOnly',
    shrineCapToGuild: 'combatSimShrineCapToGuild',
    // Global from here down
    upgradeColumns: 'combatSimUpgradeColumns',
    allZonesMaxTierFood: 'combatSimAllZonesMaxTierFood',
    allZonesScoreScale: 'combatSimAllZonesScoreScale',
    allZonesIncludeDungeons: 'combatSimAllZonesIncludeDungeons',
    bestiaryPlanHours: 'combatSimBestiaryPlanHours',
    bestiaryPlanMode: 'combatSimBestiaryPlanMode',
    bestiaryPlanPoints: 'combatSimBestiaryPlanPoints',
    bestiaryPlanTotal: 'combatSimBestiaryPlanTotal',
    bestiaryPlanTolerance: 'combatSimBestiaryPlanTolerance',
});

/** The sim editor's remembered Loadout pick, per character, in `settings` */
export const SIM_EDITOR_LOADOUT_KEY = 'simEditorLoadoutName';

/** The remembered upgrade analyses (`upgrade-results-store.js`), per character, in `combatExport` */
export const UPGRADE_RESULTS_KEYS = Object.freeze({
    combat: 'combatSimUpgradeResults',
    lab: 'labSimUpgradeResults-fullkit',
});

/**
 * The fold for a single remembered choice: the incoming value, as a whole-key write would.
 *
 * The sync's baseline already keeps this device's value when only this device moved (it
 * swaps the arguments), so this is the whole-key rule, kept, for a key that may be live.
 * @param {*} local - This device's stored value
 * @param {*} incoming - The other side's value
 * @returns {*} `incoming`
 */
export function incomingWins(local, incoming) {
    return incoming;
}

/**
 * The fold for a saved result `{savedAt, ...}`: the later save wins, a tie goes to the
 * incoming side. Anything that is not a record — a `null` written by Clear — is taken as
 * the incoming side's word, so a clear travels.
 * @param {*} local - This device's stored value
 * @param {*} incoming - The other side's value
 * @returns {*} The later record
 */
export function laterSavedAtWins(local, incoming) {
    const savedAt = (value) =>
        value && typeof value === 'object' && !Array.isArray(value) ? Number(value.savedAt) : NaN;
    const mine = savedAt(local);
    const theirs = savedAt(incoming);
    if (Number.isFinite(mine) && Number.isFinite(theirs) && mine > theirs) return local;
    return incoming;
}

/**
 * The fold for the Triggers chip's choices `{scope, include, ...}`: both sides' fields,
 * the incoming one winning a field both have.
 * @param {*} local - This device's stored value
 * @param {*} incoming - The other side's value
 * @returns {*} The combined record
 */
export function mergeFieldRecord(local, incoming) {
    const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isRecord(incoming)) return isRecord(local) ? local : incoming;
    if (!isRecord(local)) return incoming;
    return { ...local, ...incoming };
}

/**
 * Register one key as live-safe.
 * @param {string} store - Object store
 * @param {string} base - The key, scoped or global (`base` matches both forms)
 * @param {Function} merge - The fold
 * @param {string} label - For the pull summary
 */
function register(store, base, merge, label) {
    registerSyncMerge({ store, base, merge, label, liveSafe: true });
}

const LAB_LABELS = {
    upgradeDimensions: 'Lab Sim upgrade sets',
    upgradeScope: 'Lab Sim upgrade fights',
    upgradeLevelSource: 'Lab Sim room level source',
    swapAuraOnly: 'Lab Sim signature swaps only',
    shrineCapToGuild: 'Lab Sim shrine cap',
    upgradeRoomLevels: 'Lab Sim room-level search',
    upgradeTargetFloor: 'Lab Sim target floor',
    legacyUpgradeMode: 'Lab Sim upgrade mode (old)',
    skillingRoomLevels: 'Lab Sim skilling room-level search',
    skillingTargetClear: 'Lab Sim skilling target clear',
    skillingTargetFloor: 'Lab Sim skilling target floor',
    tokenBuffLevels: 'Lab Sim token levels',
    checkedSwaps: 'Lab Sim checked swaps',
};
for (const [name, base] of Object.entries(LAB_SIM_KEYS)) register('settings', base, incomingWins, LAB_LABELS[name]);

const COMBAT_LABELS = {
    upgradeModes: 'Combat Sim upgrade sets',
    triggerChoices: 'Combat Sim trigger choices',
    swapAuraOnly: 'Combat Sim signature swaps only',
    shrineCapToGuild: 'Combat Sim shrine cap',
    upgradeColumns: 'Combat Sim upgrade columns',
    allZonesMaxTierFood: 'Combat Sim max-tier food',
    allZonesScoreScale: 'Combat Sim zones score scale',
    allZonesIncludeDungeons: 'Combat Sim zones include dungeons',
    bestiaryPlanHours: 'Bestiary plan hours',
    bestiaryPlanMode: 'Bestiary plan mode',
    bestiaryPlanPoints: 'Bestiary plan points',
    bestiaryPlanTotal: 'Bestiary plan total',
    bestiaryPlanTolerance: 'Bestiary plan tolerance',
};
for (const [name, base] of Object.entries(COMBAT_SIM_KEYS)) {
    register('settings', base, name === 'triggerChoices' ? mergeFieldRecord : incomingWins, COMBAT_LABELS[name]);
}

// The editor writes this only when the player picks a loadout or resets the editor, which is a
// new choice made on screen, never a cached copy put back; the next editor build reads it fresh
register('settings', SIM_EDITOR_LOADOUT_KEY, incomingWins, 'Sim editor loadout');

// Read fresh whenever a panel opens and drawn only where no table is on screen; never written
// back from memory (a save is a new run, a clear writes null)
register('combatExport', UPGRADE_RESULTS_KEYS.combat, laterSavedAtWins, 'Combat Sim remembered upgrades');
register('combatExport', UPGRADE_RESULTS_KEYS.lab, laterSavedAtWins, 'Lab Sim remembered upgrades');

/**
 * Which of a panel's keys a pull wrote, for the character on screen.
 * @param {Record<string, Array<string>>|undefined} written - The pull's keys, by store
 * @param {string} store - Object store
 * @param {Record<string, string>} keys - Name → storage key as the panel resolves it now
 * @returns {Set<string>} The names whose key the pull wrote
 */
export function pulledNames(written, store, keys) {
    const landed = new Set(written?.[store] || []);
    const names = new Set();
    for (const [name, key] of Object.entries(keys)) if (key && landed.has(key)) names.add(name);
    return names;
}

/**
 * What a panel last read from or wrote to each key of a group it saves together.
 *
 * A group save reads every control and used to write every key, so the first change
 * after a pull put this page's copy of the other keys back over the pulled ones. With
 * this memo the save writes only the keys whose value differs from what the page last
 * saw in storage — the one the player just changed.
 */
export class StoredValueMemo {
    constructor() {
        /** @type {Map<string, string>} storage key → stable text of the value */
        this._seen = new Map();
    }

    /**
     * Note the value a key holds in storage now.
     * @param {string} key - Full storage key
     * @param {*} value - Its value
     */
    remember(key, value) {
        this._seen.set(key, stableStringify(value ?? null));
    }

    /**
     * Whether writing `value` would change what the page last saw stored under `key`.
     * A key never seen counts as changed.
     * @param {string} key - Full storage key
     * @param {*} value - The value about to be written
     * @returns {boolean}
     */
    differs(key, value) {
        return this._seen.get(key) !== stableStringify(value ?? null);
    }

    /** Forget everything, e.g. on a character switch */
    clear() {
        this._seen.clear();
    }
}
