/**
 * Settings Storage Module
 * Handles persistence of settings to chrome.storage.local
 */

import storage from './storage.js';
import { settingsGroups } from './settings-schema.js';

/**
 * Whether a schema type stores its state as a boolean (.isTrue)
 * @param {string} type - Setting type from the schema
 * @returns {boolean}
 */
/**
 * The one value a stored or built setting entry carries: `.value` when it
 * has one, else `.isTrue`.
 * @param {Object} entry - A settings-map entry
 * @returns {*} Its value
 */
function valueOf(entry) {
    if (!entry || typeof entry !== 'object') return undefined;
    return Object.hasOwn(entry, 'value') ? entry.value : entry.isTrue;
}

function isBooleanType(type) {
    return type === 'checkbox' || type === 'checkboxWithButton';
}

/**
 * Schema defaults that changed after release, and the value they changed from.
 *
 * A changed schema default only reaches a fresh install. The saved map is
 * written whole — every setting the schema had at save time is in it, chosen or
 * not — so an existing user holds the *old* default as an explicit stored
 * value, and the merge below faithfully restores it forever. That is right for
 * a setting the user actually picked and wrong for one they never touched, and
 * storage cannot tell the two apart.
 *
 * So each entry is rewritten exactly once, guarded by a persisted flag: an old
 * default is nudged to the new one on the first load that sees it, and after
 * that the user's value is theirs. Someone who deliberately re-picks the old
 * value keeps it, because the flag has already been set.
 *
 * `from` is the value being replaced — anything else stays put, since a user
 * who chose a third option was never sitting on the old default.
 */
const DEFAULT_REWRITES = [
    // Replaying the live fight runs the real combat engine hundreds of times
    // mid-fight; it should be opt-in rather than something every player pays for
    { id: 'labyrinthLiveCombatSim', field: 'isTrue', from: true, to: false },
    // Routing unrevealed rooms as clearable sends players through rooms that
    // turn out to need a shroud they did not bring
    { id: 'labyrinthPathUnknownMode', field: 'value', from: 'clearable', to: 'shroud' },
    // enhanceSim_baseItemCraftingCost's schema default moved false -> true, but
    // this one is not the "existing user's choice" case the other entries
    // above are not touching: its only reader used to be config.isFeatureEnabled
    // via the legacy features map, which answered true for any key outside
    // that map regardless of what was stored — so the checkbox never actually
    // gated anything. A stored `false` here, whether from an untouched default
    // or from a player who ticked it off believing it did something, was
    // equally inert either way and cannot represent a real preference. Now
    // that the gate reads the schema (see config.js's isFeatureEnabled), that
    // stored false would start being honoured for the first time and silently
    // flip the enhancement path's base-item cost for every existing user.
    // Nudging it to the new default restores the behaviour everyone already
    // had.
    { id: 'enhanceSim_baseItemCraftingCost', field: 'isTrue', from: false, to: true },
];

/**
 * Pass as `saveSettings`' second argument to write the whole map, every id of
 * it, over what is stored — the deliberate reset to defaults. Named rather than
 * implied by omission so a caller that simply forgot to say what it changed
 * cannot silently get the destructive write. See `saveSettings`.
 *
 * Reached as `settingsStorage.SAVE_ALL_KEYS` rather than as a named export:
 * rollup maps this module to the `Toolasha.Core.settingsStorage` global, so a
 * caller in another bundle gets the singleton and nothing else — a named import
 * would compile to `undefined` there and quietly fall through to the scoped
 * write. Hanging it off the singleton means every bundle reads the one symbol.
 * @type {symbol}
 */
const SAVE_ALL_KEYS = Symbol('settings.saveAllKeys');

/** Bump the suffix when a new batch is added to DEFAULT_REWRITES */
const DEFAULT_REWRITE_FLAG_KEY = 'settings_default_rewrites_v2';

/**
 * Settings replaced by other settings, carried across once.
 *
 * Not a DEFAULT_REWRITES case: no default changed. A setting was split, and a
 * user who had the old one on must find the new ones on. Each `from` that is
 * stored on is copied as on into every `to` the stored map does not already
 * have a value for; a `from` that is off or absent writes nothing, which leaves
 * the new settings on their schema default.
 *
 * The old entry is left where it is. The save paths carry ids the schema no
 * longer names, so it would survive anyway — and keeping it means an older
 * build loaded on the same profile still reads the value it knows.
 *
 * Every entry carries a `once` id, and the ids that have run are recorded per
 * character, so each entry runs exactly once for a save file no matter how many
 * entries are added later. A single batch flag could not do that: adding an
 * entry meant bumping the flag, which re-ran every older entry too — harmless
 * for the seeding entries (they stand back from an id that already holds a
 * value) and not harmless at all for a reconciling one, which overwrites ids
 * the user may since have re-picked by hand. See {@link applyKeyMigrations}.
 */
const KEY_MIGRATIONS = [
    // The patient tick became one switch per side; the old one moved both
    {
        once: 'patientTickSides',
        from: 'profitCalc_patientTick',
        to: ['profitCalc_patientTickBuy', 'profitCalc_patientTickSell'],
    },
    // Eleven labyrinth sim-budget settings became three. A reconciling entry:
    // it decides for itself which ids to write, because two of the survivors
    // are ids the user already has stored
    { once: 'labyrinthSimBudget', reconcile: deriveLabyrinthSimBudget },
    // Three switches answered one question — where to show listing age — and
    // nothing stopped a player setting them incoherently. The top-order-age
    // column is one of the two My Listings age columns, so it rides that side
    {
        once: 'marketListingAge',
        from: ['market_showListingAge', 'market_showTopOrderAge', 'market_showEstimatedListingAge'],
        to: 'market_listingAge',
        derive: ([listed, topOrder, orderBook]) => {
            const mine = Boolean(listed) || Boolean(topOrder);
            const book = Boolean(orderBook);
            if (mine && book) return 'both';
            if (mine) return 'myListings';
            if (book) return 'orderBook';
            return 'off';
        },
    },
    // The stack-value badge under two sort states, plus a second badge system on
    // the same tile. Both on is not expressible: the stack value wins, because
    // the category and custom-tab totals add up exactly what it shows
    {
        once: 'inventoryValueBadges',
        from: ['invSort_showBadges', 'invSort_badgesOnNone', 'invBadgePrices'],
        to: 'inv_valueBadges',
        derive: ([whenSorting, onNone, itemPrices]) => {
            if (onNone === 'Ask') return 'alwaysAsk';
            if (onNone === 'Bid') return 'alwaysBid';
            if (whenSorting) return 'sorting';
            if (itemPrices) return 'prices';
            return 'off';
        },
    },
];

/**
 * The labyrinth sim budget: eleven settings reconciled into three.
 *
 * Four "Uncapped" checkboxes (floor map, Automation tab, Single Sim, Upgrade),
 * two precisions with disagreeing defaults, and five ceilings in two units all
 * described one thing — how long a labyrinth simulation may run. They are now
 * `labyrinthSimCaps`, `labyrinthSimPrecision` and `labyrinthSimMaxHours`.
 *
 * Unlike the `from`/`to` entries above, this one *reconciles* rather than
 * seeds: two of the three survivors are ids the user already has stored, so a
 * stored value is the thing being merged, not a reason to stand back. Each rule
 * below is chosen so nobody has to re-pick anything and nobody's existing run
 * gets shorter:
 *
 * - **Caps.** Any one of the four uncaps stored on means the user had asked
 *   some panel to run to precision, so the merged choice is 'precision'. All
 *   four off — or absent — is 'capped', today's default.
 * - **Precision.** `labyrinthSimPrecision` survives: it governs four surfaces
 *   to the Automation tab's one, it has a real default (1) where the
 *   automation knob's 0 was a "follow the other one" sentinel, and the schema
 *   test pins its help text. A user who tuned only the automation knob (a real
 *   value, map precision still at its default) gets that value carried across,
 *   since it was their one deliberate choice about precision.
 * - **Hours.** The largest of the three stored ceilings wins. A ceiling is a
 *   backstop rather than a target, so taking the max cannot turn an answer the
 *   user gets today into a "(capped)" one. Unattended floor passes do not pay
 *   for that generosity: they keep their own tighter bound in
 *   `labyrinth-sim-cache.js`.
 *
 * The two per-panel max-*fights* numbers are not carried: the merged capped
 * rule uses the module's standard fight budget, which is exactly what both of
 * them defaulted to.
 *
 * @param {Object} saved - The stored settings map (never null here)
 * @returns {Object<string, Object>} New entries by id, for ids that should change
 */
function deriveLabyrinthSimBudget(saved) {
    const next = {};
    const stored = (id) => (saved[id] ? valueOf(saved[id]) : undefined);

    // Caps: a brand-new id, so it is only ever written here — and only when a
    // panel was actually uncapped. All four off means 'capped', which is the
    // schema default the loader already supplies, so writing it would be churn
    // on every existing player's first load for no change in behaviour.
    const anyUncapped = [
        'labyrinthTileUncapped',
        'labyrinthAutomationUncapped',
        'labyrinthSimUncapped',
        'labyrinthUpgradeUncapped',
    ].some((id) => Boolean(stored(id)));
    if (anyUncapped && !saved.labyrinthSimCaps) {
        next.labyrinthSimCaps = { id: 'labyrinthSimCaps', type: 'select', value: 'precision' };
    }

    // Precision: the automation knob only wins when it was the only one tuned
    const mapPrecision = Number(stored('labyrinthSimPrecision'));
    const autoPrecision = Number(stored('labyrinthAutomationSimPrecision'));
    const mapUntouched = !(mapPrecision > 0) || mapPrecision === 1;
    if (autoPrecision > 0 && autoPrecision !== mapPrecision && mapUntouched) {
        next.labyrinthSimPrecision = {
            id: 'labyrinthSimPrecision',
            type: 'number',
            value: Math.min(10, Math.max(0.1, autoPrecision)),
        };
    }

    // Hours: the most generous of the ceilings the user actually had
    const hours = ['labyrinthRecommendSimHours', 'labyrinthSimMaxHours', 'labyrinthUpgradeMaxHours']
        .map((id) => Number(stored(id)))
        .filter((value) => value > 0);
    if (hours.length) {
        const merged = Math.min(100000, Math.max(1, Math.floor(Math.max(...hours))));
        if (merged !== Number(stored('labyrinthSimMaxHours'))) {
            next.labyrinthSimMaxHours = { id: 'labyrinthSimMaxHours', type: 'number', value: merged };
        }
    }

    return next;
}

/**
 * Per character, the `once` ids of the key migrations that have already run.
 *
 * Add a new entry to KEY_MIGRATIONS with a `once` id nothing has recorded and
 * it runs on the next load, for everyone, without disturbing the entries that
 * ran before it. Nothing here ever needs bumping.
 */
const KEY_MIGRATION_STATE_KEY = 'settings_key_migrations_applied';

/**
 * The batch flags earlier builds set, and what each of them means was applied.
 *
 * Read only when a save file has no record of its own — the first load on a
 * build that has this — and newest first, so a profile carrying both is read as
 * the later one. Without this a profile flagged under a batch would re-run every
 * entry that batch had already applied, which is the failure the per-entry
 * record exists to stop.
 */
const LEGACY_KEY_MIGRATION_FLAGS = [
    {
        key: 'settings_key_migrations_v2',
        entries: ['patientTickSides', 'labyrinthSimBudget', 'marketListingAge', 'inventoryValueBadges'],
    },
    { key: 'settings_key_migrations_v1', entries: ['patientTickSides'] },
];

// Task data stored per character under a `_<charId>` suffix, outside the
// settings map (task-reroll-protection.js / task-auto-reroll.js) — copied along
// with the map so "make this alt like my main" carries the task lists too
const TASK_CHARACTER_SCOPED_PREFIXES = ['taskProtectedHrids', 'taskAutoRerollHrids'];

/**
 * Key prefixes that must never travel in a settings file, in or out.
 *
 * The literal is repeated from `utils/full-backup.js`'s
 * `DEVICE_LOCAL_KEY_PREFIXES` rather than imported: this is a Core module and
 * Core loads before Utils, so a module-level import of the shared constant
 * would be undefined at load. A test pins the two lists together instead.
 *
 * `toolasha_local_` holds the preserved chat history
 * (`features/chat/chat-history-persistence.js`) — every chat tab's markup,
 * whisper tabs included. Out, because a settings export is exactly the file
 * people paste into a chat when they want help with a setting. In, because a
 * file written by an older build (or by another player) can still carry the
 * key, and importing it would plant someone else's whispers on this machine
 * exactly as if they had been typed here — the same both-directions rule the
 * sync payload and the full backup already follow.
 */
const DEVICE_LOCAL_KEY_PREFIXES = ['toolasha_local_'];

/**
 * Where the settings that belong to the account rather than to a character live.
 *
 * Deliberately under the same `script_settingsMap` prefix as the per-character
 * maps: `sync-payload.js` redacts, and preserves on the way back in, every key
 * that starts with it, so the token in here is stripped from an upload and never
 * planted by a pull for free. `_shared` is not a character id — ids are numeric —
 * so nothing that walks the known-characters roster can collide with it.
 */
const SHARED_SETTINGS_KEY = 'script_settingsMap_shared';

/**
 * Set once the one-time carry-over from the per-character maps has run and its
 * write actually landed. Device-wide, not per character: the carry-over reads
 * every character's map in one pass.
 */
const SHARED_SCOPE_FLAG_KEY = 'settings_shared_scope_v1';

/**
 * Where a carry-over that could not decide records what it found, for the sync
 * feature to show the player. See {@link SettingsStorage#migrateSharedSettings}.
 */
const SHARED_SCOPE_CONFLICT_KEY = 'settings_shared_scope_conflicts';

/**
 * Merge one stored entry onto a freshly built schema entry.
 *
 * Shared by the per-character merge and the account-wide overlay, so the two
 * cannot drift on the awkward cases below.
 *
 * @param {Object} target - Entry built from the schema, mutated in place
 * @param {Object} savedValue - The stored entry
 * @returns {void}
 */
function mergeStoredEntry(target, savedValue) {
    if (!target || !savedValue || typeof savedValue !== 'object') return;
    if (Object.hasOwn(savedValue, 'isTrue')) {
        target.isTrue = savedValue.isTrue;
    }
    if (Object.hasOwn(savedValue, 'value')) {
        if (isBooleanType(target.type)) {
            // A boolean setting keeps its state in `.isTrue`, so a stored
            // `.value` beside it is not a second opinion — it is either the
            // old checkboxWithButton shape (which persisted its boolean in
            // `.value` alone) or the write of a setter that put the new
            // answer in the wrong field. Both mean `.value` holds the newer
            // intent, so it wins and the entry rebuilt from the schema keeps
            // no `.value` at all.
            //
            // The one case this gets wrong: a settings-panel change (which
            // wrote `.isTrue`) made AFTER the stray `.value` write in the
            // same session leaves `.isTrue` as the newer intent, and this
            // prefers `.value`. That window is narrow, cannot recur now the
            // setter deletes the field it did not write, and the alternative
            // is that every player who ticked a box on the buggy build stays
            // stuck with the value they tried to change.
            target.isTrue = !!savedValue.value;
        } else {
            target.value = savedValue.value;
        }
    }
}

class SettingsStorage {
    constructor() {
        this.storageKey = 'script_settingsMap'; // Legacy global key (used as template)
        this.storageArea = 'settings';
        this.currentCharacterId = null;
        this.currentCharacterName = null;
        this.knownCharactersKey = 'known_character_ids';
        /**
         * Whether the last `loadSettings()` could actually read the store.
         * `storage.getJSON` answers a read that could not be made with the
         * default, which a loader takes for "nothing saved yet" — and the
         * next whole-map write would then put the schema defaults over the
         * user's settings. `false` says the map that came back is defaults
         * standing in for settings that could not be read, not settings.
         */
        this.lastLoadReadable = true;
        /** See SAVE_ALL_KEYS — carried on the instance so it crosses bundles */
        this.SAVE_ALL_KEYS = SAVE_ALL_KEYS;
    }

    /**
     * Set the current character ID and name.
     * Must be called after character_initialized event.
     * @param {string} characterId
     * @param {string} [characterName]
     */
    setCharacterId(characterId, characterName) {
        this.currentCharacterId = characterId;
        if (characterName) this.currentCharacterName = characterName;
    }

    /**
     * Get the storage key for current character
     * Falls back to global key if no character ID set
     * @returns {string} Storage key
     */
    getCharacterStorageKey() {
        if (this.currentCharacterId) {
            return `${this.storageKey}_${this.currentCharacterId}`;
        }
        return this.storageKey; // Fallback to global key
    }

    /**
     * The setting IDs the *previous* build saved, before any merging.
     *
     * The saved map is written whole, so its keys are a fingerprint of the
     * schema of whatever script wrote it — including the upstream fork, which
     * uses the same storage keys. Diffing the current schema against this is
     * how a first run tells "arrived from another build of Toolasha, with
     * settings worth respecting" from "genuinely fresh install".
     *
     * @returns {Promise<Array<string>|null>} Stored IDs, or null when nothing
     *   has ever been saved
     */
    async storedSettingIds() {
        const saved = await storage.getJSON(this.getCharacterStorageKey(), this.storageArea, null);
        return saved ? Object.keys(saved) : null;
    }

    /**
     * Load all settings from storage
     * Merges saved values with defaults from settings-schema
     * @returns {Promise<Object>} Settings map
     */
    async loadSettings() {
        const characterKey = this.getCharacterStorageKey();
        // Whose key that is, captured with it: the migration below runs after
        // two awaits and used to read `this.currentCharacterId` afresh, so a
        // switch in the gap seeded the departing character's key and filed the
        // arriving character in the known-characters roster off the same load.
        const characterId = this.currentCharacterId;
        const characterName = this.currentCharacterName;
        // Probe first: "absent" and "could not be read" must not look alike
        // here, because the migration below treats absent as "first run for
        // this character" and writes, and the caller treats the result as
        // the settings to save back.
        //
        // The probe already read the raw value off the same key — a second
        // `getJSON` round trip just to JSON-parse it would be a redundant
        // IndexedDB transaction on every settings load, doubling this key's
        // exposure to slow transactions when the main thread or the
        // browser's IDB task queue is under load. Parse what the probe
        // already has instead.
        const probed = await storage.tryGet(characterKey, this.storageArea);
        this.lastLoadReadable = probed !== null;
        let saved = null;

        if (probed !== null) {
            saved = probed.found ? storage.parseJSON(probed.value, characterKey, null) : null;

            // Migration: If this is a character-specific key and it doesn't exist
            // Copy from global template (old 'script_settingsMap' key)
            if (characterId && !saved) {
                const globalTemplate = await storage.getJSON(this.storageKey, this.storageArea, null);
                if (globalTemplate) {
                    // Copy global template to this character
                    saved = globalTemplate;
                    await storage.setJSON(characterKey, saved, this.storageArea, true);
                }

                // Add character to known characters list
                await this.addToKnownCharacters(characterId, characterName);
            }

            saved = await this.applyDefaultRewrites(saved, characterKey);
            saved = await this.applyKeyMigrations(saved, characterKey);
            await this.migrateSharedSettings(characterKey);
        } else {
            console.warn(`[SettingsStorage] ${characterKey} could not be read; answering with schema defaults`);
        }

        const settings = {};

        // Build default settings from config
        for (const group of Object.values(settingsGroups)) {
            for (const [settingId, settingDef] of Object.entries(group.settings)) {
                settings[settingId] = {
                    id: settingId,
                    desc: settingDef.label,
                    type: settingDef.type || 'checkbox',
                };

                // Set default value
                if (isBooleanType(settingDef.type)) {
                    settings[settingId].isTrue = settingDef.default ?? false;
                } else {
                    settings[settingId].value = settingDef.default ?? '';
                }

                // Copy other properties
                if (settingDef.options && typeof settingDef.options !== 'function') {
                    settings[settingId].options = settingDef.options;
                }
                if (settingDef.min !== undefined) {
                    settings[settingId].min = settingDef.min;
                }
                if (settingDef.max !== undefined) {
                    settings[settingId].max = settingDef.max;
                }
                if (settingDef.step !== undefined) {
                    settings[settingId].step = settingDef.step;
                }
            }
        }

        // Merge saved settings
        if (saved) {
            for (const [settingId, savedValue] of Object.entries(saved)) {
                if (settings[settingId]) mergeStoredEntry(settings[settingId], savedValue);
            }

            // Migrate: formatting_useKMBFormat changed from checkbox to select
            const fmtSaved = saved['formatting_useKMBFormat'];
            if (fmtSaved && fmtSaved.hasOwnProperty('isTrue') && !fmtSaved.hasOwnProperty('value')) {
                settings['formatting_useKMBFormat'].value = fmtSaved.isTrue ? 'compact' : 'full';
            }
        }

        // The account-wide settings go on last, over whatever this character's
        // map happens to hold for them. A stale per-character copy is left
        // alone rather than cleaned up, so an older build loaded on the same
        // profile still finds the token it knows about.
        if (this.lastLoadReadable) {
            const shared = await this._loadSharedSettings();
            if (shared) {
                for (const settingId of this.sharedSettingIds()) {
                    if (settings[settingId] && shared[settingId]) {
                        mergeStoredEntry(settings[settingId], shared[settingId]);
                    }
                }
            }
        }

        return settings;
    }

    /**
     * The setting ids that belong to the account rather than to one character.
     *
     * The whole Cross-Device Sync group, taken from the schema so it cannot
     * drift. A GitHub token authenticates the *player*, not a character; the
     * passphrase unlocks a payload that is the account's; and what to sync and
     * when are decisions about this device's relationship with the gist, which
     * no character has its own answer to. Every other group stayed per
     * character — see the survey in the fork changelog.
     *
     * @returns {string[]} Setting ids stored device-wide
     */
    sharedSettingIds() {
        return Object.keys(settingsGroups.sync?.settings ?? {});
    }

    /**
     * The stored account-wide settings map, or null when there is none.
     * @returns {Promise<Object|null>}
     * @private
     */
    async _loadSharedSettings() {
        const map = await storage.getJSON(SHARED_SETTINGS_KEY, this.storageArea, null);
        return map && typeof map === 'object' ? map : null;
    }

    /**
     * Carry the account-wide settings out of the per-character maps, once.
     *
     * Before this, every alt needed its own GitHub token pasted in by hand.
     * The values already stored per character are the ones to keep, so the
     * first load on a build that has this collects them and writes them to
     * {@link SHARED_SETTINGS_KEY}.
     *
     * **The conflict rule.** Storage carries no per-key write time, so "most
     * recent" cannot be read back off disk. Instead, for each id:
     *
     * - Values equal to the schema default are ignored — an untouched default
     *   is not a choice, and letting one count would hand a fresh alt's empty
     *   token to the whole account.
     * - Every character that does hold a real value agreeing: that value wins.
     * - They disagree: **the character in session right now wins**, if it has a
     *   real value of its own. It is the profile being played, the closest
     *   thing to "most recently written" available here, and the one whose
     *   settings panel the player is about to look at.
     * - They disagree and the character in session has no value of its own:
     *   nothing is decided. The id stays per character exactly as it is today,
     *   and the player is told rather than guessed at.
     *
     * Nothing is ever deleted: the losing values stay in their own character's
     * map, so switching to that alt and pressing "Copy sync setup to my other
     * characters" re-shares from there. Every disagreement, resolved or not, is
     * recorded under {@link SHARED_SCOPE_CONFLICT_KEY} for the sync feature to
     * surface, so the outcome is never silent.
     *
     * Idempotent, and written before it is recorded: an id the shared map
     * already answers is never reconsidered, a refused write leaves the flag
     * unset so the next load tries again, and a listing that could not be made
     * declines rather than deciding off a partial view.
     *
     * @param {string} characterKey - Storage key of the character in session
     * @returns {Promise<void>}
     */
    async migrateSharedSettings(characterKey) {
        try {
            if (await storage.get(SHARED_SCOPE_FLAG_KEY, this.storageArea, false)) return;

            const keys = await storage.tryGetAllKeys(this.storageArea);
            if (!Array.isArray(keys)) return; // Could not list; decide nothing, retry next load

            const mapKeys = keys.filter(
                (key) =>
                    key !== SHARED_SETTINGS_KEY && (key === this.storageKey || key.startsWith(`${this.storageKey}_`))
            );

            const existing = (await this._loadSharedSettings()) ?? {};
            const defaults = this.buildDefaults();
            const maps = [];
            for (const key of mapKeys) {
                const map = await storage.getJSON(key, this.storageArea, null);
                if (map && typeof map === 'object') maps.push({ key, map });
            }

            const names = new Map(
                (await this.getKnownCharacters()).map((character) => [
                    `${this.storageKey}_${character.id}`,
                    character.name,
                ])
            );
            const nameFor = (key) => names.get(key) ?? key.slice(this.storageKey.length + 1) ?? key;

            const next = { ...existing };
            const conflicts = [];
            let changed = false;

            for (const settingId of this.sharedSettingIds()) {
                if (settingId in existing) continue; // Already answered — never reconsidered
                const defaultValue = valueOf(defaults[settingId]);
                const candidates = maps
                    .map(({ key, map }) => ({ key, entry: map[settingId] }))
                    .filter(({ entry }) => entry && typeof entry === 'object')
                    .map((candidate) => ({ ...candidate, value: valueOf(candidate.entry) }))
                    .filter(({ value }) => value !== undefined && value !== '' && value !== defaultValue);
                if (candidates.length === 0) continue;

                const distinct = new Set(candidates.map((candidate) => JSON.stringify(candidate.value ?? null)));
                let winner = candidates[0];
                if (distinct.size > 1) {
                    const mine = candidates.find((candidate) => candidate.key === characterKey);
                    conflicts.push({
                        id: settingId,
                        resolved: Boolean(mine),
                        winner: mine ? nameFor(mine.key) : null,
                        characters: candidates.map((candidate) => nameFor(candidate.key)),
                    });
                    if (!mine) continue; // Left per character; the player is told instead
                    winner = mine;
                }
                next[settingId] = { ...winner.entry };
                changed = true;
            }

            if (changed) {
                // Storage answers a refused or failed write with false, not a
                // throw. Recording over an unwritten map would strand every
                // character on its own token forever.
                const written = await storage.setJSON(SHARED_SETTINGS_KEY, next, this.storageArea, true);
                if (written === false) return;
            }
            if (conflicts.length > 0) {
                await storage.setJSON(SHARED_SCOPE_CONFLICT_KEY, { at: Date.now(), conflicts }, this.storageArea, true);
            }
            await storage.set(SHARED_SCOPE_FLAG_KEY, true, this.storageArea, true);
        } catch (error) {
            // Same rule as the rewrites and key migrations: a failure must not
            // cost the user a value, and an unrecorded pass retries next load
            console.error('[SettingsStorage] Shared-settings carry-over failed:', error);
        }
    }

    /**
     * What the account-wide carry-over could not decide on its own, for the
     * sync feature to show the player once.
     * @returns {Promise<{at: number, conflicts: Array<Object>}|null>}
     */
    async sharedScopeConflicts() {
        const record = await storage.getJSON(SHARED_SCOPE_CONFLICT_KEY, this.storageArea, null);
        return record && Array.isArray(record.conflicts) && record.conflicts.length > 0 ? record : null;
    }

    /**
     * Forget the carry-over's conflict record, once it has been shown.
     * @returns {Promise<void>}
     */
    async clearSharedScopeConflicts() {
        await storage.delete(SHARED_SCOPE_CONFLICT_KEY, this.storageArea);
    }

    /**
     * Write the account-wide settings this save touched to the shared map.
     *
     * Only the ids named by `settingIds` are written, over whatever is stored,
     * so a client holding a stale map cannot revert an account-wide setting
     * another character changed while it was open.
     *
     * @param {Object} settings - The caller's settings map
     * @param {Iterable<string>} settingIds - Shared ids this save is carrying
     * @returns {Promise<void>}
     * @private
     */
    async _writeSharedEntries(settings, settingIds) {
        const ids = [...settingIds].filter((id) => settings?.[id]);
        if (ids.length === 0) return;
        const stored = (await this._loadSharedSettings()) ?? {};
        const next = { ...stored };
        for (const id of ids) next[id] = { ...settings[id] };
        await storage.setJSON(SHARED_SETTINGS_KEY, next, this.storageArea, true);
    }

    /**
     * Rewrite stored values still sitting on a superseded schema default, once.
     *
     * See DEFAULT_REWRITES for why this is needed at all. The flag is stored
     * per character, beside that character's settings, so each save file is
     * nudged exactly once — and is set even when there is nothing to rewrite
     * (a fresh install, which already has the new defaults), so a later change
     * of mind is never second-guessed.
     *
     * @param {Object|null} saved - The stored settings map, or null when none
     * @param {string} characterKey - Storage key the map was loaded from
     * @returns {Promise<Object|null>} The map to merge, rewrites applied
     */
    async applyDefaultRewrites(saved, characterKey) {
        const flagKey = `${DEFAULT_REWRITE_FLAG_KEY}_${characterKey}`;
        try {
            if (await storage.get(flagKey, this.storageArea, false)) return saved;

            let next = saved;
            for (const { id, field, from, to } of DEFAULT_REWRITES) {
                const entry = saved?.[id];
                if (!entry || entry[field] !== from) continue;
                // Copy rather than mutate the loaded map, so a caller holding
                // the same object does not see it change underneath them
                next = next === saved ? { ...saved } : next;
                next[id] = { ...entry, [field]: to };
            }

            if (next !== saved) {
                // Storage answers a refused or failed write with false, not a
                // throw. The flag waits for a load whose write lands: set over an
                // unsaved map, it would stop the rewrite for good and a reload
                // would find the old default back.
                const written = await storage.setJSON(characterKey, next, this.storageArea, true);
                if (written === false) return next;
            }
            await storage.set(flagKey, true, this.storageArea, true);
            return next;
        } catch (error) {
            // A failed rewrite must not cost the user their settings; the flag
            // stays unset, so the next load tries again
            console.error('[SettingsStorage] Default rewrite failed:', error);
            return saved;
        }
    }

    /**
     * Carry replaced settings over to the settings that replaced them, once.
     *
     * See KEY_MIGRATIONS. Same shape as {@link applyDefaultRewrites}: the record
     * is stored per character beside that character's settings and written even
     * when there is nothing to carry (a fresh install has only the new
     * settings), and the migrated map is written back straight away so the new
     * ids are stored rather than living in memory until something else happens
     * to save.
     *
     * What is recorded is which entries have run, not that "the batch" has. An
     * entry that has already run is skipped while the rest of the batch still
     * goes ahead, so a reconciling entry — which by design overwrites ids that
     * already hold stored values — can never be replayed over a choice the user
     * made after it ran.
     *
     * @param {Object|null} saved - The stored settings map, or null when none
     * @param {string} characterKey - Storage key the map was loaded from
     * @returns {Promise<Object|null>} The map to merge, migrations applied
     */
    async applyKeyMigrations(saved, characterKey) {
        const stateKey = `${KEY_MIGRATION_STATE_KEY}_${characterKey}`;
        try {
            const applied = await this._appliedKeyMigrations(stateKey, characterKey);
            const pending = KEY_MIGRATIONS.filter((migration) => !applied.has(migration.once));
            if (pending.length === 0) return saved;

            let next = saved;
            for (const { from, to, derive, reconcile } of pending) {
                // A reconciling migration works out for itself which ids to
                // write — including ids that already hold a stored value, which
                // is the whole point when several old settings are being merged
                // into one of their own number. See deriveLabyrinthSimBudget.
                if (reconcile) {
                    if (!saved) continue;
                    for (const [id, entry] of Object.entries(reconcile(saved))) {
                        next = next === saved ? { ...saved } : next;
                        next[id] = entry;
                    }
                    continue;
                }

                // Several old keys folded into one new one: the new value is a
                // function of all of them, so the whole set is read at once
                if (derive) {
                    if (saved?.[to]) continue; // Already answered under the new key
                    if (!from.some((id) => saved?.[id])) continue; // Nothing stored to carry
                    const value = derive(from.map((id) => (saved?.[id] ? valueOf(saved[id]) : undefined)));
                    if (value === undefined) continue;
                    next = next === saved ? { ...saved } : next;
                    next[to] = { id: to, type: 'select', value };
                    continue;
                }

                // valueOf, and truthiness: a boolean the loader would read as on
                // (including the old `.value` shape) is on here too
                if (!saved?.[from] || !valueOf(saved[from])) continue;
                for (const id of to) {
                    // A value already stored for the new id is the newer intent
                    if (saved[id]) continue;
                    next = next === saved ? { ...saved } : next;
                    next[id] = { id, type: 'checkbox', isTrue: true };
                }
            }

            if (next !== saved) {
                // Storage answers a refused or failed write with false, not a
                // throw. The record waits for a load whose write lands: written
                // over an unsaved map, it would stop the carry for good and a
                // reload would find the new settings off.
                const written = await storage.setJSON(characterKey, next, this.storageArea, true);
                if (written === false) return next;
            }
            // The union, not just this pass: an id recorded by a build that has
            // an entry this one does not must not be forgotten, or that entry
            // would run again on the next downgrade-then-upgrade.
            const recorded = [...new Set([...applied, ...KEY_MIGRATIONS.map((migration) => migration.once)])];
            await storage.setJSON(stateKey, recorded, this.storageArea, true);
            return next;
        } catch (error) {
            // Same rule as the default rewrites: a failed migration must not
            // cost the user their settings, and an unrecorded entry retries next
            // load
            console.error('[SettingsStorage] Key migration failed:', error);
            return saved;
        }
    }

    /**
     * Which key migrations this character's save file has already had.
     *
     * @param {string} stateKey - Where the per-character record lives
     * @param {string} characterKey - Storage key of the settings map itself
     * @returns {Promise<Set<string>>} The `once` ids already applied
     * @private
     */
    async _appliedKeyMigrations(stateKey, characterKey) {
        const state = await storage.getJSON(stateKey, this.storageArea, null);
        if (Array.isArray(state)) return new Set(state);

        for (const { key, entries } of LEGACY_KEY_MIGRATION_FLAGS) {
            if (await storage.get(`${key}_${characterKey}`, this.storageArea, false)) return new Set(entries);
        }
        return new Set();
    }

    /**
     * Forget which key migrations a character's save file has had, so the next
     * load reconciles the map it now holds.
     *
     * For the paths that replace a settings map wholesale with one from
     * somewhere else — another character, or a settings file. The map is the
     * other profile's and the record is this one's, so a map written by a build
     * that predates a merge arrives carrying the retired ids and none of the
     * ids that replaced them, while this profile's record says there is nothing
     * left to carry. The settings the user chose then read as never chosen.
     *
     * Safe precisely because the record is per entry: re-running is now
     * re-running against a map that has not had these entries.
     *
     * @param {string} characterKey - Storage key of the settings map
     * @returns {Promise<void>}
     * @private
     */
    async _clearKeyMigrationState(characterKey) {
        await storage.delete(`${KEY_MIGRATION_STATE_KEY}_${characterKey}`, this.storageArea);
        for (const { key } of LEGACY_KEY_MIGRATION_FLAGS) {
            await storage.delete(`${key}_${characterKey}`, this.storageArea);
        }
    }

    /**
     * Forget the key-migration record for every settings map among `keys` that
     * landed without a migration record of its own alongside it.
     *
     * The shared half of {@link _clearKeyMigrationState}'s callers:
     * `importSettings` and sync's `applyPayload` both write a batch of storage
     * keys from somewhere else in one pass, and both need the same answer to
     * "which of the maps that just landed brought their own record, and which
     * are stuck with this profile's stale one". `copySettingsFromCharacter`
     * does not use this — it always writes exactly one map and never a record
     * beside it, so it calls {@link _clearKeyMigrationState} directly.
     *
     * @param {Iterable<string>} keys - Storage keys written in this batch
     * @returns {Promise<void>}
     */
    async reconcileKeyMigrationState(keys) {
        const landedMaps = new Set();
        const landedState = new Set();

        for (const key of keys) {
            // The account-wide map holds only ids no key migration has ever
            // touched, and has no migration record of its own to reconcile
            if (key === SHARED_SETTINGS_KEY) continue;
            if (key.startsWith(this.storageKey)) landedMaps.add(key);
            for (const prefix of [KEY_MIGRATION_STATE_KEY, ...LEGACY_KEY_MIGRATION_FLAGS.map((f) => f.key)]) {
                if (key.startsWith(`${prefix}_`)) landedState.add(key.slice(prefix.length + 1));
            }
        }

        for (const mapKey of landedMaps) {
            if (landedState.has(mapKey)) continue;
            await this._clearKeyMigrationState(mapKey);
        }
    }

    /**
     * Build default settings from schema without touching storage
     * Used during early initialization before character ID is known
     * @returns {Object} Settings map with schema defaults only
     */
    buildDefaults() {
        const settings = {};

        for (const group of Object.values(settingsGroups)) {
            for (const [settingId, settingDef] of Object.entries(group.settings)) {
                settings[settingId] = {
                    id: settingId,
                    desc: settingDef.label,
                    type: settingDef.type || 'checkbox',
                };

                if (isBooleanType(settingDef.type)) {
                    settings[settingId].isTrue = settingDef.default ?? false;
                } else {
                    settings[settingId].value = settingDef.default ?? '';
                }

                if (settingDef.options) {
                    settings[settingId].options = settingDef.options;
                }
                if (settingDef.min !== undefined) {
                    settings[settingId].min = settingDef.min;
                }
                if (settingDef.max !== undefined) {
                    settings[settingId].max = settingDef.max;
                }
                if (settingDef.step !== undefined) {
                    settings[settingId].step = settingDef.step;
                }
            }
        }

        return settings;
    }

    /**
     * Save all settings to storage, keeping entries this build does not know.
     *
     * `loadSettings()` builds its map from the schema and merges saved values
     * onto it, so a stored id the current schema has no entry for never reaches
     * the map — and this write is whole, so the next save erased it. That is
     * fine for a setting genuinely retired, and wrong for the case that
     * actually happens: a device on an older build pulls settings written by a
     * newer one (`sync-payload.js` folds the incoming map onto the local one,
     * so the newer ids DO land on disk), and the first toggle on the old build
     * strips every one of them. Upgrading that device later then finds those
     * settings back at their shipped defaults, with no sign they were ever
     * chosen. The same applies to the upstream fork, which writes its own ids
     * to these very keys.
     *
     * So an id the caller's map does not mention is carried over from what is
     * stored rather than dropped. `loadSettings()` emits every id in the
     * schema, so the only ids that can be carried are ones this build does not
     * have — nothing the user can turn off is kept alive by this.
     *
     * A store that cannot be read still gets the write: losing the change the
     * player just made is a worse answer than losing ids this build cannot show
     * them anyway.
     *
     * `dirtyKeys` narrows the write to the ids the caller actually changed.
     * Without it this method writes the caller's whole map, which means a client
     * holding a map it loaded ten minutes ago reverts every setting another
     * client has changed since — a second tab or a second browser on the same
     * character is enough, and neither shows any sign of it. With it, what is
     * stored is the base and only the named ids (plus any id stored does not
     * have at all, so a genuinely new setting still lands) are written over it.
     *
     * @param {Object} settings - Settings map
     * @param {Iterable<string>|symbol|null} [dirtyKeys=null] - The ids this
     *   caller changed, `settingsStorage.SAVE_ALL_KEYS` to write the map whole,
     *   or null for a caller with no dirty tracking (writes whole, as it always did)
     * @returns {Promise<void>}
     */
    async saveSettings(settings, dirtyKeys = null) {
        const characterKey = this.getCharacterStorageKey();
        const probed = await storage.tryGet(characterKey, this.storageArea);

        let stored = probed?.found ? probed.value : null;
        if (typeof stored === 'string') {
            try {
                stored = JSON.parse(stored);
            } catch {
                stored = null;
            }
        }

        let toWrite = settings;
        if (stored && typeof stored === 'object') {
            const scoped = dirtyKeys !== null && dirtyKeys !== undefined && dirtyKeys !== SAVE_ALL_KEYS;
            if (scoped) {
                // Stored is the base, so every id this client did not touch keeps
                // whatever another client last wrote for it — including ids this
                // build has no schema entry for, which fall out of the loop below
                // and are therefore carried for free.
                const dirty = dirtyKeys instanceof Set ? dirtyKeys : new Set(dirtyKeys);
                toWrite = { ...stored };
                for (const [id, entry] of Object.entries(settings || {})) {
                    if (dirty.has(id) || !(id in stored)) toWrite[id] = entry;
                }
            } else {
                const foreign = Object.keys(stored).filter((id) => !(id in (settings || {})));
                if (foreign.length > 0) {
                    toWrite = { ...settings };
                    for (const id of foreign) toWrite[id] = stored[id];
                }
            }
        }

        await storage.setJSON(characterKey, toWrite, this.storageArea, true);

        // The account-wide settings go to their own key as well as staying in
        // this character's map. Staying keeps a downgrade working and adds no
        // exposure the token did not already have; the shared key is what every
        // character reads. A scoped save carries only the ids it changed; the
        // deliberate reset (SAVE_ALL_KEYS) and a caller with no dirty tracking
        // carry the lot, so "Reset to defaults" clears the account-wide
        // settings too rather than leaving a token the panel cannot explain.
        const sharedIds = this.sharedSettingIds();
        const scopedSave = dirtyKeys !== null && dirtyKeys !== undefined && dirtyKeys !== SAVE_ALL_KEYS;
        const sharedToWrite = scopedSave
            ? sharedIds.filter((id) => (dirtyKeys instanceof Set ? dirtyKeys : new Set(dirtyKeys)).has(id))
            : sharedIds;
        await this._writeSharedEntries(settings, sharedToWrite);
    }

    /**
     * Save a settings map that was never read back, without writing over what
     * the user had.
     *
     * For a map built from schema defaults because the store could not be
     * read, a key still at its default says nothing about the user's choice,
     * so the stored entry keeps it; a key moved off its default is a choice
     * made this session and wins. Refuses outright when the store cannot be
     * read now either — a blind write of defaults is the accident this exists
     * to prevent. A store with nothing under the key is written whole.
     *
     * @param {Object} settings - Settings map, as `loadSettings()` shapes it
     * @returns {Promise<boolean>} Whether a write landed
     */
    async saveSettingsKeepingStored(settings) {
        const characterKey = this.getCharacterStorageKey();
        const probed = await storage.tryGet(characterKey, this.storageArea);
        if (probed === null) {
            console.warn(`[SettingsStorage] Settings not saved: ${characterKey} could not be read first`);
            return false;
        }

        let stored = probed.found ? probed.value : null;
        if (typeof stored === 'string') {
            try {
                stored = JSON.parse(stored);
            } catch {
                stored = null;
            }
        }
        const defaults = this.buildDefaults();
        // Only a shared id this session actually moved off its default can be a
        // choice worth writing account-wide; the rest of the map is defaults
        // standing in for settings that were never read.
        const touchedShared = this.sharedSettingIds().filter(
            (id) => settings?.[id] && id in defaults && valueOf(settings[id]) !== valueOf(defaults[id])
        );

        if (!stored || typeof stored !== 'object') {
            await storage.setJSON(characterKey, settings, this.storageArea, true);
            await this._writeSharedEntries(settings, touchedShared);
            return true;
        }

        const merged = { ...stored };
        for (const [settingId, entry] of Object.entries(settings || {})) {
            const untouched = settingId in defaults && valueOf(entry) === valueOf(defaults[settingId]);
            if (!(settingId in merged) || !untouched) merged[settingId] = entry;
        }
        await storage.setJSON(characterKey, merged, this.storageArea, true);
        await this._writeSharedEntries(settings, touchedShared);
        return true;
    }

    /**
     * Add character to known characters list, storing name alongside ID.
     * Migrates old flat-array format ([id, id]) to object format ([{id, name}]).
     * @param {string} characterId
     * @param {string} characterName
     * @returns {Promise<void>}
     */
    async addToKnownCharacters(characterId, characterName) {
        // The game sends the id as a NUMBER and the stored list holds STRINGS,
        // so a strict compare against the raw value never matched — every call
        // pushed a fresh duplicate of the same character, and rosters grew into
        // the hundreds. Everything below works in strings.
        const id = String(characterId);
        const raw = await storage.getJSON(this.knownCharactersKey, this.storageArea, []);
        const list = this._normalizeKnownCharacters(raw);
        const existing = list.find((c) => c.id === id);
        if (existing) {
            if (characterName && existing.name !== characterName) {
                existing.name = characterName;
                await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
            } else if (list.length !== raw.length) {
                // The normalize pass collapsed historic duplicates — keep that
                await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
            }
        } else {
            list.push({ id, name: characterName || id });
            await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
        }
    }

    /**
     * Normalise stored known-characters to [{id, name}] regardless of legacy
     * format, one entry per id.
     *
     * Rosters written before the id-type fix hold the same character dozens of
     * times (a number-vs-string compare never found the existing entry), so
     * duplicates are collapsed here: one entry per id, keeping the best name
     * seen for it — a real name over an id echoed as one.
     *
     * @param {Array} raw
     * @returns {Array<{id: string, name: string}>}
     * @private
     */
    _normalizeKnownCharacters(raw) {
        if (!Array.isArray(raw)) return [];
        const byId = new Map();
        for (const entry of raw) {
            const normalized =
                typeof entry === 'object' && entry !== null
                    ? { id: String(entry.id), name: entry.name || String(entry.id) }
                    : { id: String(entry), name: String(entry) };
            const kept = byId.get(normalized.id);
            // Later entries win, except a real name is never replaced by an id echo
            if (!kept || normalized.name !== normalized.id || kept.name === kept.id) {
                byId.set(normalized.id, normalized);
            }
        }
        return [...byId.values()];
    }

    /**
     * Get list of known characters as [{id, name}] objects.
     *
     * Reads self-heal: a roster the duplicate bug inflated is collapsed and,
     * when that changed anything, written back, so the fix applies itself on
     * the first read after updating.
     *
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async getKnownCharacters() {
        const raw = await storage.getJSON(this.knownCharactersKey, this.storageArea, []);
        const list = this._normalizeKnownCharacters(raw);
        if (Array.isArray(raw) && list.length !== raw.length) {
            await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
        }
        return list;
    }

    /**
     * Sync current settings to a specified subset of characters.
     * @param {Object} settings - Current settings to copy
     * @param {string[]} targetIds - IDs to sync to (omit to sync to all others)
     * @returns {Promise<number>} Number of characters synced
     */
    async syncSettingsToAllCharacters(settings, targetIds) {
        // The source is whoever was current when the button was pressed — the
        // character `settings` was read off. Re-reading it after the awaits
        // below would exclude the wrong character from the targets and copy the
        // wrong character's task lists.
        const sourceId = this.currentCharacterId;
        const knownCharacters = await this.getKnownCharacters();
        let syncedCount = 0;

        const targets = targetIds
            ? knownCharacters.filter((c) => targetIds.includes(c.id))
            : knownCharacters.filter((c) => c.id !== sourceId);

        const taskScopedValues = await Promise.all(
            TASK_CHARACTER_SCOPED_PREFIXES.map((prefix) =>
                storage.getJSON(`${prefix}_${sourceId}`, this.storageArea, null)
            )
        );

        for (const character of targets) {
            if (character.id === sourceId) continue;
            const characterKey = `${this.storageKey}_${character.id}`;
            await storage.setJSON(characterKey, settings, this.storageArea, true);

            for (let i = 0; i < TASK_CHARACTER_SCOPED_PREFIXES.length; i++) {
                if (taskScopedValues[i] === null) continue;
                const targetKey = `${TASK_CHARACTER_SCOPED_PREFIXES[i]}_${character.id}`;
                await storage.setJSON(targetKey, taskScopedValues[i], this.storageArea, true);
            }
            syncedCount++;
        }

        return syncedCount;
    }

    /**
     * Merge a handful of setting entries into every other known character's
     * stored map, leaving the rest of their settings alone.
     *
     * The whole-map copies above are the "make this alt like my main" gesture;
     * this is the narrow one — a few keys that describe a device rather than a
     * playstyle, such as the sync group's token and switches.
     *
     * A known character with nothing stored is skipped rather than seeded: a
     * map holding six keys would, on that character's next load, read as a
     * settings map written by some other build of the script and set off the
     * first-run reconciliation. It is named in the result instead.
     *
     * @param {Object} entries - Setting entries by id, shaped as loadSettings() writes them
     * @returns {Promise<{copied: Array<{id: string, name: string}>, skipped: Array<{id: string, name: string}>}>}
     */
    async copySettingEntriesToOtherCharacters(entries) {
        const ids = Object.keys(entries || {});
        const copied = [];
        const skipped = [];
        if (ids.length === 0) return { copied, skipped };

        // Account-wide ids among them go to the shared map as well, which is
        // where every character reads them from — this is how the player
        // resolves a carry-over that could not decide for itself.
        await this._writeSharedEntries(
            entries,
            this.sharedSettingIds().filter((id) => ids.includes(id))
        );

        // Fixed for the whole walk: the loop awaits a read and a write per
        // character, and a switch part way through would start excluding a
        // different character from "the other characters".
        const sourceId = String(this.currentCharacterId);

        for (const character of await this.getKnownCharacters()) {
            if (String(character.id) === sourceId) continue;
            const characterKey = `${this.storageKey}_${character.id}`;
            const stored = await storage.getJSON(characterKey, this.storageArea, null);
            if (!stored || typeof stored !== 'object' || Object.keys(stored).length === 0) {
                skipped.push(character);
                continue;
            }
            const merged = { ...stored };
            for (const id of ids) merged[id] = { ...entries[id] };
            await storage.setJSON(characterKey, merged, this.storageArea, true);
            copied.push(character);
        }

        return { copied, skipped };
    }

    /**
     * Copy another character's whole settings map onto the current character.
     *
     * The inverse of the sync buttons: they push this character's settings out,
     * this pulls another character's settings in — the one-click "make this new
     * alt like my main" a fresh character wants. The map is written whole, the
     * same shape a normal save uses, so the caller only has to reload config.
     *
     * @param {string} sourceId - The character to copy settings from
     * @returns {Promise<boolean>} True when a map was found and written
     */
    async copySettingsFromCharacter(sourceId) {
        if (!sourceId || !this.currentCharacterId || String(sourceId) === String(this.currentCharacterId)) {
            return false;
        }
        // The destination is the character the user was on when they pressed
        // the button, not whoever is current when the source map comes back —
        // a switch during the read would otherwise overwrite the arriving
        // character's settings with a map they never asked for.
        const destinationKey = this.getCharacterStorageKey();
        const sourceMap = await storage.getJSON(`${this.storageKey}_${sourceId}`, this.storageArea, null);
        if (!sourceMap || typeof sourceMap !== 'object' || Object.keys(sourceMap).length === 0) {
            return false;
        }
        if (this.getCharacterStorageKey() !== destinationKey) {
            console.warn('[SettingsStorage] Settings not copied: the character changed while the source map loaded');
            return false;
        }
        await storage.setJSON(destinationKey, sourceMap, this.storageArea, true);
        // The map is the source character's; the migration record left behind is
        // this character's, and it describes a map that is no longer here. A
        // source last written by a build that predates a merge would otherwise
        // keep its retired ids forever and never gain the ids that replaced
        // them. See _clearKeyMigrationState.
        await this._clearKeyMigrationState(destinationKey);
        return true;
    }

    /**
     * The known characters, other than the current one, that actually have
     * settings saved — the only ones worth offering as a copy source.
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async charactersWithSettings() {
        const known = await this.getKnownCharacters();
        const withSettings = [];
        for (const character of known) {
            if (String(character.id) === String(this.currentCharacterId)) continue;
            const map = await storage.getJSON(`${this.storageKey}_${character.id}`, this.storageArea, null);
            if (map && typeof map === 'object' && Object.keys(map).length > 0) {
                withSettings.push(character);
            }
        }
        return withSettings;
    }

    /**
     * Get a single setting value
     * @param {string} settingId - Setting ID
     * @param {*} defaultValue - Default value if not found
     * @returns {Promise<*>} Setting value
     */
    async getSetting(settingId, defaultValue = null) {
        const settings = await this.loadSettings();
        const setting = settings[settingId];

        if (!setting) {
            return defaultValue;
        }

        // Return boolean for checkbox settings
        if (isBooleanType(setting.type)) {
            return setting.isTrue ?? defaultValue;
        }

        // Return value for other settings
        return setting.value ?? defaultValue;
    }

    /**
     * Set a single setting value
     * @param {string} settingId - Setting ID
     * @param {*} value - New value
     * @returns {Promise<void>}
     */
    async setSetting(settingId, value) {
        // Captured before the load, checked after it. `loadSettings()` reads
        // the key that was current when it started, and `saveSettings()` below
        // asks for the key that is current when it runs — so a character switch
        // landing in that gap wrote the departing character's whole settings
        // map, plus this edit, under the arriving character's key.
        const characterKey = this.getCharacterStorageKey();
        const settings = await this.loadSettings();
        if (this.getCharacterStorageKey() !== characterKey) {
            console.warn(
                `[SettingsStorage] Setting '${settingId}' not saved: the character changed while settings loaded`
            );
            return;
        }
        if (!this.lastLoadReadable) {
            // The map in hand is defaults standing in for settings that could
            // not be read; writing it back would put them over the user's
            console.warn(`[SettingsStorage] Setting '${settingId}' not saved: settings could not be read first`);
            return;
        }

        if (!settings[settingId]) {
            console.warn(`Setting '${settingId}' not found`);
            return;
        }

        // Update value
        if (isBooleanType(settings[settingId].type)) {
            settings[settingId].isTrue = value;
        } else {
            settings[settingId].value = value;
        }

        // Freshly loaded a few lines up, so a whole-map write would be correct
        // here too — but naming the one id it changed costs nothing and keeps a
        // concurrent client's change made during that gap.
        await this.saveSettings(settings, [settingId]);
    }

    /**
     * Reset all settings to defaults
     * @returns {Promise<void>}
     */
    async resetToDefaults() {
        // Clear per-character settings so loadSettings() returns defaults
        const characterKey = this.getCharacterStorageKey();
        await storage.delete(characterKey, this.storageArea);
    }

    /**
     * Export all settings as JSON (full dump of settings store)
     * Includes global keys and current character's keys.
     * Excludes transient cache data.
     * @returns {Promise<string>} JSON string
     */
    async exportSettings() {
        const allData = await storage.getAll(this.storageArea);

        // Transient caches, and anything device-local. `toolasha_local_` is the
        // prefix the sync payload and the full backup both strip
        // (`LOCAL_ONLY_KEY_PREFIXES` in features/sync/sync-payload.js,
        // `DEVICE_LOCAL_KEY_PREFIXES` in utils/full-backup.js); this export is
        // the third way the settings store leaves the machine and was the one
        // still carrying them. See DEVICE_LOCAL_KEY_PREFIXES above.
        const EXCLUDE_PREFIXES = ['marketplace_cache', ...DEVICE_LOCAL_KEY_PREFIXES];
        const exported = {};

        for (const [key, value] of Object.entries(allData)) {
            if (EXCLUDE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
            exported[key] = value;
        }

        return JSON.stringify(exported, null, 2);
    }

    /**
     * Import settings from JSON
     * Only imports global keys and keys matching the current character ID.
     * Character-specific keys for other characters are skipped.
     *
     * A settings map that arrives without a migration record of its own — a file
     * written by a build older than a merge — leaves this profile's record
     * describing a map it no longer holds, and the retired ids in the file would
     * never be carried to the ids that replaced them. The record is cleared for
     * exactly those maps, so the next load reconciles what was imported.
     *
     * @param {string} jsonString - JSON string
     * @returns {Promise<{imported: number, skipped: number}>} Import result
     */
    async importSettings(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            const currentCharId = this.currentCharacterId;
            let imported = 0;
            let skipped = 0;
            /** Keys this import actually wrote, handed to reconcileKeyMigrationState below */
            const importedKeys = [];

            const knownCharacters = new Set((await this.getKnownCharacters()).map((character) => character.id));
            if (data[this.knownCharactersKey]) {
                for (const character of this._normalizeKnownCharacters(data[this.knownCharactersKey])) {
                    knownCharacters.add(character.id);
                }
            }

            for (const [key, value] of Object.entries(data)) {
                // Excluded on the way out and just as much on the way in; see
                // DEVICE_LOCAL_KEY_PREFIXES. Not counted as skipped — skipped is
                // "belongs to another character", which the summary offers to
                // explain, and this is "never travels" with nothing to explain.
                if (DEVICE_LOCAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;

                const charIdMatch =
                    key.match(/_([0-9a-f]{24})$/i) ||
                    key.match(/_(\d{10,})$/) ||
                    this._matchKnownCharacterSuffix(key, knownCharacters);

                if (charIdMatch) {
                    const keyCharId = charIdMatch[1];
                    if (currentCharId && keyCharId !== String(currentCharId)) {
                        skipped++;
                        continue;
                    }
                }

                await storage.setJSON(key, value, this.storageArea, true);
                imported++;
                importedKeys.push(key);
            }

            await this.reconcileKeyMigrationState(importedKeys);

            return { imported, skipped };
        } catch (error) {
            console.error('[Settings Storage] Import failed:', error);
            return null;
        }
    }

    /**
     * Check if a key ends with a known character ID suffix
     * @param {string} key - Storage key
     * @param {Set<string>} knownIds - Set of known character ID strings
     * @returns {Array|null} Match array with captured ID at index 1, or null
     * @private
     */
    _matchKnownCharacterSuffix(key, knownIds) {
        const lastUnderscore = key.lastIndexOf('_');
        if (lastUnderscore === -1) return null;
        const suffix = key.substring(lastUnderscore + 1);
        if (knownIds.has(suffix)) {
            return [key, suffix];
        }
        return null;
    }
}

const settingsStorage = new SettingsStorage();

export default settingsStorage;
