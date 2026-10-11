/**
 * What in the database is Toolasha's, and therefore what the sync may carry.
 *
 * The IndexedDB this script uses is shared. Other userscripts open the same
 * database, create their own object stores in it, and write their own keys into
 * `settings` beside ours. That was invisible for as long as the payload was
 * built by walking `listStores()` and uploading whatever came back: a full-scope
 * push carried every store in the database and every key in it, ours or not.
 * Measured on a real account, two foreign keys in `settings` came to roughly
 * 600 KB — about a fifth of every payload, uploaded and downloaded forever, for
 * data this script cannot read and must not restore.
 *
 * So the payload is built from a declared list instead: {@link SYNCED_STORES}
 * says which stores travel, and {@link OWNED_KEY_PREFIXES} says which keys
 * travel out of the stores that are shared key-by-key. Anything else is left
 * where it is — not uploaded, and (this is the half that matters) not written
 * back on a pull, so the local value simply stays.
 *
 * ## This is NOT the local-only list
 *
 * `LOCAL_ONLY_KEY_PREFIXES` and `LOCAL_ONLY_SETTING_IDS` in `sync-payload.js`
 * name things Toolasha *owns* and deliberately keeps on one machine — a token, a
 * core count, a cache. This file names what Toolasha owns at all. A key can be
 * ours and local (a sync cursor); a key can be neither ours nor local (another
 * script's). The two lists answer different questions and both are needed.
 *
 * ## Getting this wrong in the unsafe direction
 *
 * A Toolasha key missing from the registry stops syncing, and stops *quietly*.
 * Nothing fails; the key simply never appears on the other device, and the loss
 * looks like a bug in whatever feature owns it, years later. That is worse than
 * the waste this file exists to cut, so the rule is: when in doubt, register it.
 * An over-inclusive registry syncs a few keys it need not. An under-inclusive
 * one loses history.
 *
 * `sync-ownership-coverage.test.js` is what keeps this list honest — it parses
 * `src/` for the keys the script writes and fails when one is not covered here.
 */

/**
 * Object stores whose contents the sync carries.
 *
 * Every store this script creates in `core/storage.js` except the ones another
 * script owns — see {@link FOREIGN_STORES}. A store missing from both lists
 * fails `sync-ownership.test.js`, so adding an object store forces a decision
 * about whether it syncs rather than defaulting into the payload unnoticed.
 */
export const SYNCED_STORES = [
    'settings',
    'rerollSpending',
    'dungeonRuns',
    'teamRuns',
    'combatExport',
    'unifiedRuns',
    'marketListings',
    'combatStats',
    'xpHistory',
    'alchemyHistory',
    'labyrinth',
    'guildHistory',
    'networthHistory',
    'collections',
    'queueSnapshots',
    'lootLogHistory',
    'leaderboardHistory',
    // Created for the upstream script this database is shared with, and since
    // written by this one too (`core/data-manager.js`,
    // `features/character-activity/character-activity-storage.js`), so they are
    // ours to carry.
    'actionProgress',
    'characterActivityStatus',
];

/**
 * Object stores this script creates but does not own.
 *
 * `openableAnalytics` exists only because the database version is shared: the
 * upstream script expects it at its schema version, so `core/storage.js` creates
 * it to keep upstream's transactions from failing. Nothing in `src/` reads or
 * writes it. Uploading it put another script's whole analytics record in every
 * payload, and `importEverything` wrote it back on every pull.
 */
export const FOREIGN_STORES = ['openableAnalytics'];

/**
 * Stores shared with another script at the key level, filtered key by key.
 *
 * `settings` is the one: it is where every script that uses this database puts
 * its odds and ends, and where the foreign weight was measured. The rest of
 * {@link SYNCED_STORES} are this script's own object stores, created by it for
 * one feature each, and travel whole — filtering them by prefix would buy
 * nothing and would be one more list to keep in step.
 */
export const KEY_FILTERED_STORES = ['settings'];

/**
 * Key prefixes Toolasha claims in a key-filtered store.
 *
 * A prefix, not a key: nearly every record here is written per character as
 * `<base>_<characterId>`, so registering the base covers every scoped form. The
 * bare base is covered too, because it is what pre-scoping builds wrote and what
 * `utils/character-key.js` still adopts.
 *
 * Grouped by the feature that owns each family so that a feature being deleted
 * takes its rows with it. Legacy names are kept even when nothing writes them
 * any more — an account that still holds one is still entitled to sync it.
 */
export const OWNED_KEY_PREFIXES = [
    // Settings themselves, and the bookkeeping that makes them load correctly
    'script_settingsMap',
    'settings_shared_scope_v3',
    'settings_shared_scope_conflicts',
    // Covers every rewrite batch's flag: v2, v3, and whatever comes next
    'settings_default_rewrites_',
    // Once-per-character flag that old defaults were pinned for existing players
    'settings_key_migrations_applied_',
    // When each setting last changed on the device that changed it, which the
    // automatic sync merge reads (`sync-payload.js` SETTING_STAMPS_PREFIX)
    'settings_changedAt_',
    'known_character_ids',
    'accountCharacterNames',
    'adoptionTargetCharacterId',
    'toolasha_settingsFingerprint_',
    'toolasha_collapsedGroups',
    'toolasha_allOffSnapshot_',
    'toolasha_characterGameModes',
    'toolasha_forkBackupPrompted',
    'toolasha_ironCowSnapshot',
    'ironCowFarmOverrides',
    'ironCowFarmPlanCollapsed',
    'ironCowFarmSnapshot',
    'whatsNew_state',
    'updateCheckIntroduced',
    'updateCheckState',

    // Panels, layout and other places the UI remembers where it was
    'panelGeometry',
    'panelOpenState',
    'panelSizeMemory',
    'modalPositions3',
    'tabOrder_',
    'overlayPanel',
    'overlayLayouts',
    'overlayAppliedLayout',
    'charmPanelFolds',
    'bulkSellPanelPosition',
    'consumablesBuyWidgetPosition',
    'queueMonitor_collapsed',
    'queueSnapshot_',
    'toolasha_local_', // device-local, but ours — see LOCAL_ONLY_KEY_PREFIXES
    'toolasha_sync_', // the sync's own bookkeeping: ours, and device-local too

    // Actions panel
    'actionSortMode_',
    'actionTimingLog_',
    'pinnedActions_',
    'quickInput_addMode',

    // Market
    'Toolasha_marketAPI_', // device-local, but ours
    'Toolasha_customPriceOverrides',
    'marketHistoryFilters',
    'marketHistoryKMBFormat',
    'mooketWatchlist',
    'mooketPanelPrefs',
    'market_volumeStats_columns',
    'bulkSellStatusExpanded',
    'watchlist',
    'tradeHistory',
    'tradeLedger',
    'marketListingTimestamps',
    'marketListingDragOrder_',
    'inventoryReservationLedger',
    'inventorySort',
    'equipmentSavings',
    'housesUntracked',
    'philoCalculatorSettings',

    // Combat, its panels and its recorders
    // A measurement of this machine's own observations of the battle stream —
    // ours, and device-local, see LOCAL_ONLY_KEY_PREFIXES
    'stunPersistenceTally',
    'waveGapTally',
    'tickPeriodTally',
    'bestiaryPointsTarget',
    'combatProfitView',
    'combatIncomeNetSalesTax',
    'combatLevelSelection',
    'combatRecordControl_target',
    'combatReplayCheck_',
    'combatStatsChatFields',
    'combatStatsChatUseCheckboxes',
    'combatSessionHistory',
    'consumablesSettings',
    'consumablesIdleLoadout',
    'consumablesIdleZone',
    'consumablesDungeonRuns',
    'consumablesLabRuns',
    'loadout_snapshots_',
    'scroll_simulation_',
    'dungeonTracker_',
    'labyrinthRoomLogs',
    'labyrinthFightOutcomes',
    'spawnCensus',
    'allZonesSnapshot',
    'playerColors',
    'playerClassOverrides',

    // Simulators
    'combatSim',
    'labSim',
    'simEditorLoadoutName',

    // Guild
    'guildShrinePlan',
    'guildTrial',
    'guildToken',
    'trialTrace',

    // Tasks
    'taskIconFilters',
    'taskIconsFilter',
    'taskEstimateMode',
    'taskCapProtection',
    'taskCapCoinThreshold',
    'taskCapCowbellThreshold',
    'taskProtectedHrids_',
    'taskAutoRerollHrids_',
    'taskReroll',

    // Alchemy, enhancement, networth, goals, briefing, notices
    'alchemyHistory_includePreFix_',
    'alchemyHistory_lastType',
    'alchemyItemPins',
    'alchemyItemSortOrder',
    'alchemyProtectedCategories_',
    // The self-use keep list (`features/market/self-use-wanted.js`)
    'selfUseWanted_',
    'enhancementItemPins',
    'enhancementTracker_',
    'networth_exclusions_',
    'networthDetail_',
    'networthChartPrefs',
    'treasureTally',
    'treasureSettings',
    'goalPlanner',
    'briefingSnapshot_',
    'briefingAwayDiffSeen_',
    'sessionBriefing',
    'noticeLog_',
];

/**
 * Keys whose leading segment is a character id, so no prefix can catch them.
 *
 * Two features name their records `<characterId>_<what>` rather than
 * `<what>_<characterId>`. Nothing is wrong with them, but a prefix registry
 * cannot see them, and a key a registry cannot see is a key that silently stops
 * syncing — which is the failure this whole file exists to avoid. They are
 * matched by shape instead. The character id is left loose (`.+`) on purpose:
 * it has been a number, a `characterId` string and the literal `default` at
 * different times, and a pattern that pins it would quietly drop the forms it
 * did not predict.
 */
export const OWNED_KEY_PATTERNS = [/^.+_bulkSell_lastTab$/, /^.+_inventoryTabs_config$/];

/*
 * ## Keys another script opts in
 *
 * Another userscript sharing this database may ask for some of *its* keys in a
 * key-filtered store to travel with this sync — small settings and live state
 * it wants on every device, never its large derived caches. It does so through
 * `window.Toolasha.sync.registerKeys({owner, prefixes})` (see
 * `sync-external-keys.js`), which lands here. A registered prefix makes its keys
 * count as carried exactly like ours: uploaded, written back on a pull, merged
 * whole-key by the same baseline rule as any other settings key, never treated
 * as device-local.
 *
 * The registry travels in the payload (`externalKeys`, beside `stores`) and is
 * learned from every payload this device reads. That is what keeps a device
 * that never runs the other script from erasing its keys from the gist: a key
 * this device does not own is left out of its pushes and dropped from a merged
 * upload, so a device has to know the prefixes to carry the keys through — and
 * the only way a device that never runs the other script can know them is from
 * the gist itself.
 *
 * ### Withdrawing a prefix
 *
 * Every prefix an owner has ever named is an entry with a state (registered or
 * removed) and the time that state was set, and two copies of one entry settle
 * on the later state — on an exact tie, removal. So `unregisterKeys` leaves a
 * removal behind rather than forgetting the prefix: a device that still holds it
 * as registered learns the removal from the next payload instead of teaching the
 * prefix back, and registering it again later is newer than the removal and wins
 * the same way. Keys already carried under a removed prefix simply stop being
 * carried; every device keeps whatever it already stored.
 *
 * ### What may be registered
 *
 * Validation keeps a registration from reaching into keys that are not its
 * owner's:
 * - nothing that is a prefix of one of ours, or that one of ours is a prefix
 *   of, and nothing in the `toolasha` namespace. Every device-local prefix
 *   (`LOCAL_ONLY_KEY_PREFIXES` in `sync-payload.js`) is one
 *   `OWNED_KEY_PREFIXES` already claims, so a registered key is never local-only;
 * - nothing that is a prefix of, or prefixed by, a prefix registered under a
 *   different owner — so one script cannot claim another's whole namespace with
 *   a short prefix, and one prefix is never held twice. An owner's own prefixes
 *   may overlap each other: narrowing or widening its own registration is its
 *   business;
 * - at most {@link EXTERNAL_PREFIX_LIMIT} registered prefixes across every owner.
 *
 * - at most {@link EXTERNAL_ENTRY_LIMIT} prefixes ever known, registered and
 *   removed together.
 *
 * A removal is never forgotten: a forgotten one would let an older copy that
 * still lists the prefix teach it back. What bounds the registry instead is
 * that it never learns a new prefix once it holds {@link EXTERNAL_ENTRY_LIMIT}
 * entries — not as registered, and not as removed. Entries are only ever added
 * or flipped, never deleted, so a device at the limit cannot be taught a
 * prefix it does not hold, and one below it learns a removal as readily as a
 * registration. The record is therefore at most 128 entries of at most 128
 * characters each (about 20 KB), plus the device's own record loaded whole.
 *
 * The device's own remembered record is the exception: it was valid when it was
 * written, and loading it is never refused for a limit or an overlap — refusing
 * would have the next save write a smaller record than the one on disk.
 */

/** Shortest prefix another script may register: anything shorter matches too much */
export const EXTERNAL_PREFIX_MIN_LENGTH = 6;

/** Longest prefix accepted — a key, not a document */
export const EXTERNAL_PREFIX_MAX_LENGTH = 128;

/** Most registered prefixes held across every owner together */
export const EXTERNAL_PREFIX_LIMIT = 32;

/** Most prefixes ever known, registered and removed together; past it nothing new is learned */
export const EXTERNAL_ENTRY_LIMIT = 128;

/** What an owner id may look like: short, printable, nothing that needs escaping */
const EXTERNAL_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** This script's own namespace, never another's to claim, in any case */
const RESERVED_NAMESPACE = 'toolasha';

/** Every entry by owner, then prefix: `{live, at}` */
const externalEntries = new Map();

/** Every registered (live) prefix, flat — what {@link ownsKey} scans */
let externalPrefixList = [];

/** Called with no arguments whenever the registry changes */
const externalListeners = new Set();

/**
 * Why a prefix may not be registered, judged on its own, or null when it may.
 * @param {*} prefix - Candidate prefix
 * @returns {string|null} The reason it is refused
 */
export function checkExternalPrefix(prefix) {
    if (typeof prefix !== 'string') return 'not a string';
    if (prefix.length < EXTERNAL_PREFIX_MIN_LENGTH) return `shorter than ${EXTERNAL_PREFIX_MIN_LENGTH} characters`;
    if (prefix.length > EXTERNAL_PREFIX_MAX_LENGTH) return `longer than ${EXTERNAL_PREFIX_MAX_LENGTH} characters`;
    // The record is a plain object keyed by prefix: `__proto__` would be taken
    // by the prototype setter and never saved, and the other built-in names
    // are not worth the doubt
    if (Object.getOwnPropertyNames(Object.prototype).includes(prefix)) return 'a reserved JavaScript property name';
    const lower = prefix.toLowerCase();
    if (lower.startsWith(RESERVED_NAMESPACE) || RESERVED_NAMESPACE.startsWith(lower)) {
        return "inside this script's own namespace";
    }
    if (OWNED_KEY_PREFIXES.some((owned) => owned.startsWith(prefix) || prefix.startsWith(owned))) {
        return 'overlaps a key this script owns';
    }
    return null;
}

/**
 * Why a prefix may not be registered for this owner given what other owners
 * hold, or null when it may.
 * @param {string} owner - The owner asking
 * @param {string} prefix - Candidate prefix
 * @returns {string|null} The reason it is refused
 */
function checkAgainstOtherOwners(owner, prefix) {
    for (const [other, entries] of externalEntries) {
        if (other === owner) continue;
        for (const [held, entry] of entries) {
            if (entry.live && (held.startsWith(prefix) || prefix.startsWith(held))) {
                return `overlaps "${held}", registered by ${other}`;
            }
        }
    }
    return null;
}

/** How many entries, registered and removed, every owner holds together */
let externalEntryCount = 0;

/** Rebuild the flat list and the entry count after a change */
function settle() {
    externalPrefixList = [];
    externalEntryCount = 0;
    for (const entries of externalEntries.values()) {
        for (const [prefix, entry] of entries) {
            externalEntryCount += 1;
            if (entry.live) externalPrefixList.push(prefix);
        }
    }
}

/** The refusal for a prefix this registry has no room to learn */
const FULL = `the limit of ${EXTERNAL_ENTRY_LIMIT} prefixes ever registered is reached`;

/** Tell the listeners the registry changed */
function announce() {
    for (const listener of externalListeners) {
        try {
            listener();
        } catch (error) {
            console.error('[Sync] A key-registry listener failed:', error);
        }
    }
}

/** A refusal for a call whose owner or prefix list is malformed */
function malformed(owner, prefixes, { prefixesOptional = false } = {}) {
    if (typeof owner !== 'string' || !EXTERNAL_OWNER_PATTERN.test(owner)) {
        return 'owner must be 1-64 characters of letters, digits, "_", "." or "-"';
    }
    if (prefixesOptional && prefixes === undefined) return null;
    if (!Array.isArray(prefixes)) return 'prefixes must be an array of strings';
    return null;
}

/**
 * Register prefixes for one owner.
 *
 * An already-registered prefix is accepted again and changes nothing, so a
 * script may call this with the same list on every page load. A removed one is
 * registered again, as a change made now. A prefix past the limit is refused
 * rather than evicting an earlier one, so what is already carried never stops
 * being carried.
 *
 * @param {*} owner - Owner id
 * @param {*} prefixes - Prefixes to register
 * @param {{notify?: boolean, now?: number}} [options] - `notify: false` skips the change listeners
 * @returns {{ok: boolean, accepted: string[], added: string[], rejected: Array<{prefix: *, reason: string}>,
 *   error?: string}} What was taken, what of it was new, and what was refused and why
 */
export function addExternalKeyPrefixes(owner, prefixes, { notify = true, now = Date.now() } = {}) {
    const error = malformed(owner, prefixes);
    if (error) return { ok: false, accepted: [], added: [], rejected: [], error };

    const accepted = [];
    const added = [];
    const rejected = [];
    // Only entries that did not exist count against the lifetime limit; a
    // removal registered again reuses its own
    let created = 0;
    const entries = externalEntries.get(owner) || new Map();
    for (const prefix of prefixes) {
        const reason = checkExternalPrefix(prefix) || checkAgainstOtherOwners(owner, prefix);
        if (reason) {
            rejected.push({ prefix, reason });
            continue;
        }
        if (entries.get(prefix)?.live) {
            if (!accepted.includes(prefix)) accepted.push(prefix);
            continue;
        }
        if (externalPrefixList.length + added.length >= EXTERNAL_PREFIX_LIMIT) {
            rejected.push({ prefix, reason: `the limit of ${EXTERNAL_PREFIX_LIMIT} registered prefixes is reached` });
            continue;
        }
        const isNew = !entries.has(prefix);
        if (isNew && externalEntryCount + created >= EXTERNAL_ENTRY_LIMIT) {
            rejected.push({ prefix, reason: FULL });
            continue;
        }
        if (isNew) created += 1;
        // Later than any removal it replaces, whatever this device's clock says
        entries.set(prefix, { live: true, at: Math.max(now, (entries.get(prefix)?.at ?? 0) + 1) });
        accepted.push(prefix);
        added.push(prefix);
    }

    if (added.length > 0) {
        externalEntries.set(owner, entries);
        settle();
        if (notify) announce();
    }
    return { ok: rejected.length === 0, accepted, added, rejected };
}

/**
 * Withdraw prefixes from one owner, or all of its prefixes when none are named,
 * leaving a removal behind so no other device's copy teaches them back.
 *
 * A named prefix this device never held is recorded as removed too: another
 * device may hold it, and the removal is what reaches that device.
 *
 * @param {*} owner - Owner id
 * @param {*} [prefixes] - Prefixes to withdraw; all of the owner's when omitted
 * @param {{notify?: boolean, now?: number}} [options] - `notify: false` skips the change listeners
 * A prefix this device never held takes room in the registry; once it is
 * full, such a prefix is refused (one it holds can always be withdrawn).
 *
 * @returns {{ok: boolean, removed: string[], rejected: Array<{prefix: string, reason: string}>,
 *   error?: string}} What was withdrawn, and what could not be recorded
 */
export function removeExternalKeyPrefixes(owner, prefixes, { notify = true, now = Date.now() } = {}) {
    const error = malformed(owner, prefixes, { prefixesOptional: true });
    if (error) return { ok: false, removed: [], rejected: [], error };

    const entries = externalEntries.get(owner) || new Map();
    const named =
        prefixes === undefined
            ? Array.from(entries.keys()).filter((prefix) => entries.get(prefix).live)
            : prefixes.filter((prefix) => typeof prefix === 'string' && checkExternalPrefix(prefix) === null);
    const removed = [];
    const rejected = [];
    let created = 0;
    for (const prefix of new Set(named)) {
        const entry = entries.get(prefix);
        if (entry && !entry.live) continue;
        if (!entry && externalEntryCount + created >= EXTERNAL_ENTRY_LIMIT) {
            rejected.push({ prefix, reason: FULL });
            continue;
        }
        if (!entry) created += 1;
        entries.set(prefix, { live: false, at: Math.max(now, (entry?.at ?? 0) + 1) });
        removed.push(prefix);
    }
    if (removed.length > 0) {
        externalEntries.set(owner, entries);
        settle();
        if (notify) announce();
    }
    return { ok: rejected.length === 0, removed, rejected };
}

/**
 * One owner's entries from a record, in either shape the record has had:
 * `[prefix, …]` (registered, at time 0) or `{prefixes: {prefix: at}, removed: {prefix: at}}`.
 * @param {*} value - The owner's value in the record
 * @returns {Array<{prefix: string, live: boolean, at: number}>} The entries
 */
function readOwnerEntries(value) {
    if (Array.isArray(value)) {
        return value.filter((prefix) => typeof prefix === 'string').map((prefix) => ({ prefix, live: true, at: 0 }));
    }
    if (!value || typeof value !== 'object') return [];
    const out = [];
    for (const [field, live] of [
        ['prefixes', true],
        ['removed', false],
    ]) {
        const map = value[field];
        if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
        for (const [prefix, at] of Object.entries(map)) {
            out.push({ prefix, live, at: Number.isFinite(at) && at >= 0 ? at : 0 });
        }
    }
    return out;
}

/**
 * Learn a registry record — from this device's remembered copy, or from a
 * payload — entry by entry, the later state of each winning (a removal on a
 * tie). Anything malformed is skipped, not thrown: a record is data from
 * somewhere else, and one bad entry must not cost the rest.
 *
 * A registration learned from a payload is held to the same rules as one made
 * here (the cap, other owners' prefixes). The remembered copy (`trusted`) is not:
 * it was valid when written, and refusing part of it would have the next save
 * write a smaller record than the one on disk.
 *
 * @param {*} record - Registry record, `{owner: entries}`
 * @param {{notify?: boolean, trusted?: boolean}} [options] - Skip the listeners; skip the cap and overlap checks
 * @returns {boolean} Whether the registry changed
 */
export function learnExternalKeyPrefixes(record, { notify = true, trusted = false } = {}) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const incoming = [];
    for (const owner of Object.keys(record).sort()) {
        if (!EXTERNAL_OWNER_PATTERN.test(owner)) continue;
        for (const entry of readOwnerEntries(record[owner])) incoming.push({ owner, ...entry });
    }
    // Every removal before any registration, across every owner: a payload in
    // which an owner swapped one prefix for another, or one owner withdrew a
    // prefix another then claimed, is only within the cap and free of overlap
    // once its removals have landed. Taken in name order instead, the new
    // prefix could be judged against the one it replaces and refused
    incoming.sort(
        (a, b) => Number(a.live) - Number(b.live) || a.owner.localeCompare(b.owner) || a.prefix.localeCompare(b.prefix)
    );
    let changed = false;
    for (const { owner, prefix, live, at } of incoming) {
        if (checkExternalPrefix(prefix)) continue;
        const entries = externalEntries.get(owner) || new Map();
        const held = entries.get(prefix);
        const newer = !held || at > held.at || (at === held.at && held.live && !live);
        if (!newer || (held && held.live === live && held.at === at)) continue;
        // Full: nothing it does not hold, registered or removed (see "What may be registered")
        if (!held && !trusted && externalEntryCount >= EXTERNAL_ENTRY_LIMIT) continue;
        if (live && !held?.live && !trusted) {
            if (checkAgainstOtherOwners(owner, prefix)) continue;
            if (externalPrefixList.length >= EXTERNAL_PREFIX_LIMIT) continue;
        }
        entries.set(prefix, { live, at });
        externalEntries.set(owner, entries);
        settle();
        changed = true;
    }
    if (changed && notify) announce();
    return changed;
}

/**
 * Ownership as it stands now, frozen: the registry record and an `owns` that
 * answers from the registered prefixes of this moment, whatever registers or
 * withdraws afterwards.
 *
 * For a reader that awaits between deciding what it carries and writing down
 * the registry it carried it under — a payload build reads one store at a
 * time — so the two cannot disagree.
 *
 * @returns {{record: Object, owns: (storeName: string, key: string) => boolean}} The snapshot
 */
export function ownershipSnapshot() {
    const prefixes = externalPrefixList.slice();
    return { record: externalKeyRecord(), owns: (storeName, key) => ownsKeyWith(prefixes, storeName, key) };
}

/**
 * The registered (live) prefixes by owner, sorted. Empty when nothing is registered.
 * @returns {Record<string, string[]>} Prefixes by owner
 */
export function externalKeyPrefixes() {
    const record = {};
    for (const owner of Array.from(externalEntries.keys()).sort()) {
        const live = Array.from(externalEntries.get(owner))
            .filter(([, entry]) => entry.live)
            .map(([prefix]) => prefix)
            .sort();
        if (live.length > 0) record[owner] = live;
    }
    return record;
}

/**
 * The whole registry, removals included, as the record that is remembered and
 * carried in the payload: `{owner: {prefixes: {prefix: at}, removed: {prefix: at}}}`,
 * owners and prefixes sorted, so two devices holding the same entries serialize
 * them identically (the payload fingerprint depends on that). Empty when the
 * registry has never held anything.
 * @returns {Record<string, {prefixes: Record<string, number>, removed: Record<string, number>}>} The record
 */
export function externalKeyRecord() {
    const record = {};
    for (const owner of Array.from(externalEntries.keys()).sort()) {
        const prefixes = {};
        const removed = {};
        for (const prefix of Array.from(externalEntries.get(owner).keys()).sort()) {
            const entry = externalEntries.get(owner).get(prefix);
            (entry.live ? prefixes : removed)[prefix] = entry.at;
        }
        record[owner] = { prefixes, removed };
    }
    return record;
}

/**
 * Be told when the registry changes.
 * @param {Function} listener - Called with no arguments
 * @returns {Function} Unsubscribe
 */
export function onExternalKeyPrefixesChange(listener) {
    externalListeners.add(listener);
    return () => externalListeners.delete(listener);
}

/**
 * Test seam: forget every registration and removal (listeners are kept).
 * @returns {void}
 */
export function _resetExternalKeyPrefixes() {
    externalEntries.clear();
    externalPrefixList = [];
    externalEntryCount = 0;
}

/**
 * Whether a store's contents belong in the payload at all.
 * @param {string} storeName - Object store name
 * @returns {boolean} True when the store is Toolasha's to sync
 */
export function isSyncedStore(storeName) {
    return SYNCED_STORES.includes(storeName);
}

/**
 * Whether one key in one store is Toolasha's.
 *
 * A store that is not key-filtered answers `true` for everything in it: it is
 * this script's own object store, and every key in it got there from this
 * script. Only the shared stores are read key by key.
 *
 * In a key-filtered store a key is carried when it is ours, or when another
 * script registered its prefix (see "Keys another script opts in").
 *
 * @param {string} storeName - Object store the key lives in
 * @param {string} key - Storage key
 * @returns {boolean} True when the key may be uploaded and restored
 */
export function ownsKey(storeName, key) {
    // Another script's keys it asked to have carried — see "Keys another script
    // opts in" above. Read from memory, so this stays synchronous and pure
    return ownsKeyWith(externalPrefixList, storeName, key);
}

/**
 * {@link ownsKey} against a given list of registered prefixes.
 * @param {string[]} external - Prefixes other scripts registered
 * @param {string} storeName - Object store the key lives in
 * @param {string} key - Storage key
 * @returns {boolean} True when the key may be uploaded and restored
 */
function ownsKeyWith(external, storeName, key) {
    if (!KEY_FILTERED_STORES.includes(storeName)) return isSyncedStore(storeName);
    const name = String(key);
    if (OWNED_KEY_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
    if (OWNED_KEY_PATTERNS.some((pattern) => pattern.test(name))) return true;
    return external.some((prefix) => name.startsWith(prefix));
}

/**
 * Split a store's contents into what Toolasha may carry and what it may not.
 *
 * The foreign half comes back as a count and a byte total and nothing else —
 * deliberately. This is what the push logs, and a log line is a thing people
 * paste into a chat: naming another script's keys in it would publish what that
 * script stores, which is not ours to publish. A count and a weight are enough
 * to watch the foreign share over time, which is the only thing the number is
 * for.
 *
 * @param {string} storeName - Object store the entries came from
 * @param {Record<string, *>} entries - The store's contents
 * @returns {{owned: Record<string, *>, foreignKeys: number, foreignBytes: number}}
 *   The entries that may travel, and the weight of the ones that may not
 */
export function partitionOwnedKeys(storeName, entries, owns = ownsKey) {
    const source = entries || {};
    if (!KEY_FILTERED_STORES.includes(storeName)) {
        return { owned: source, foreignKeys: 0, foreignBytes: 0 };
    }

    const keys = Object.keys(source);
    if (keys.every((key) => owns(storeName, key))) {
        return { owned: source, foreignKeys: 0, foreignBytes: 0 };
    }

    const owned = {};
    let foreignKeys = 0;
    let foreignBytes = 0;
    for (const key of keys) {
        if (owns(storeName, key)) {
            owned[key] = source[key];
            continue;
        }
        foreignKeys += 1;
        foreignBytes += weigh(source[key]) + key.length;
    }
    return { owned, foreignKeys, foreignBytes };
}

/**
 * Roughly how many bytes a stored value would occupy in the payload.
 *
 * `JSON.stringify` on a value that cannot be serialized (a cycle, something
 * exotic another script stored) throws, and a diagnostic figure is never worth
 * failing a push over — an unmeasurable value counts as zero and the summary is
 * a little low, which is the harmless direction.
 *
 * @param {*} value - Stored value
 * @returns {number} Serialized length, or 0 when it cannot be measured
 */
function weigh(value) {
    try {
        return JSON.stringify(value)?.length ?? 0;
    } catch {
        return 0;
    }
}

export default {
    SYNCED_STORES,
    FOREIGN_STORES,
    KEY_FILTERED_STORES,
    OWNED_KEY_PREFIXES,
    OWNED_KEY_PATTERNS,
    isSyncedStore,
    ownsKey,
    partitionOwnedKeys,
    checkExternalPrefix,
    addExternalKeyPrefixes,
    removeExternalKeyPrefixes,
    learnExternalKeyPrefixes,
    externalKeyPrefixes,
    externalKeyRecord,
    onExternalKeyPrefixesChange,
};
