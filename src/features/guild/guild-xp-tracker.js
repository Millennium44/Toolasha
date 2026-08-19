/**
 * Guild XP Tracker
 * Records guild-level and per-member XP over time via WebSocket messages.
 * Stores history in IndexedDB for XP/hr rate calculations.
 *
 * Data sources:
 * - character_initialized (via dataManager) — initial snapshot on login
 * - guild_updated — guild total XP changes
 * - guild_characters_updated — per-member XP changes
 * - leaderboard_updated (category: guild) — XP for all guilds on the guild leaderboard
 */

import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import storage from '../../core/storage.js';
import config from '../../core/config.js';
import performanceMonitor from '../../utils/performance-monitor.js';
import { runInBackground } from '../../utils/background-work.js';

const STORE_NAME = 'guildHistory';
/** The guild leaderboard's own refresh cadence, as the panel states */
const LEADERBOARD_REFRESH_MS = 20 * 60 * 1000;
const WINDOW_10M = 10 * 60 * 1000;
const WINDOW_1H = 60 * 60 * 1000;
const WINDOW_1D = 24 * 60 * 60 * 1000;
const WINDOW_1W = 7 * 24 * 60 * 60 * 1000;

/**
 * Guild level experience table (same thresholds as skill levels).
 * Hardcoded because initClientData may not expose guild-specific thresholds.
 */
const LEVEL_EXPERIENCE_TABLE = [
    0, 33, 76, 132, 202, 286, 386, 503, 637, 791, 964, 1159, 1377, 1620, 1891, 2192, 2525, 2893, 3300, 3750, 4247, 4795,
    5400, 6068, 6805, 7618, 8517, 9508, 10604, 11814, 13151, 14629, 16262, 18068, 20064, 22271, 24712, 27411, 30396,
    33697, 37346, 41381, 45842, 50773, 56222, 62243, 68895, 76242, 84355, 93311, 103195, 114100, 126127, 139390, 154009,
    170118, 187863, 207403, 228914, 252584, 278623, 307256, 338731, 373318, 411311, 453030, 498824, 549074, 604193,
    664632, 730881, 803472, 882985, 970050, 1065351, 1169633, 1283701, 1408433, 1544780, 1693774, 1856536, 2034279,
    2228321, 2440088, 2671127, 2923113, 3197861, 3497335, 3823663, 4179145, 4566274, 4987741, 5446463, 5945587, 6488521,
    7078945, 7720834, 8418485, 9176537, 10000000, 11404976, 12904567, 14514400, 16242080, 18095702, 20083886, 22215808,
    24501230, 26950540, 29574787, 32385721, 35395838, 38618420, 42067584, 45758332, 49706603, 53929328, 58444489,
    63271179, 68429670, 73941479, 79829440, 86117783, 92832214, 100000000, 114406130, 130118394, 147319656, 166147618,
    186752428, 209297771, 233962072, 260939787, 290442814, 322702028, 357968938, 396517495, 438646053, 484679494,
    534971538, 589907252, 649905763, 715423218, 786955977, 865044093, 950275074, 1043287971, 1144777804, 1255500373,
    1376277458, 1508002470, 1651646566, 1808265285, 1979005730, 2165114358, 2367945418, 2588970089, 2829786381,
    3092129857, 3377885250, 3689099031, 4027993033, 4396979184, 4798675471, 5235923207, 5711805728, 6229668624,
    6793141628, 7406162301, 8073001662, 8798291902, 9587056372, 10444742007, 11377254401, 12390995728, 13492905745,
    14690506120, 15991948361, 17406065609, 18942428633, 20611406335, 22424231139, 24393069640, 26531098945, 28852589138,
    31372992363, 34109039054, 37078841860, 40302007875, 43799759843, 47595067021, 51712786465, 56179815564, 61025256696,
    66280594953, 71979889960, 78159982881, 84860719814, 92125192822, 100000000000,
];

// ─── History compaction helpers ──────────────────────────────────────────────
// Same compaction rules as src/features/skills/xp-tracker.js

/**
 * Normalize a member's inactiveTime from guild sharable data.
 * The game sends Go's zero time (0001-01-01T00:00:00Z) for members who are
 * NOT idle — a truthy string that must not count as a real timestamp.
 * @param {string|null|undefined} value
 * @returns {string|null} The timestamp, or null when the member isn't idle
 */
export function parseInactiveTime(value) {
    if (!value) return null;
    const t = new Date(value).getTime();
    return Number.isFinite(t) && t > 0 ? value : null;
}

/**
 * Append an XP data point to a history array, compacting as needed.
 * @param {Array} arr - Existing history array (mutated in place)
 * @param {{t: number, xp: number}} d - New data point
 */
export function pushXP(arr, d) {
    const last = arr[arr.length - 1];
    if (last) {
        if (d.xp < last.xp) return; // XP should never decrease
        // The leaderboard refreshes on its own 20-minute cycle, so opening the
        // panel again inside that window serves the very same snapshot. Storing
        // it puts two identical readings at the end of the history, and a rate
        // measured across those is zero — which is why every XP/h column went
        // blank after a few clicks around the leaderboard, while the own guild
        // (fed by guild_updated, whose XP really does move) kept working.
        //
        // A flat reading is only recorded once the window has passed, where it
        // means the guild genuinely earned nothing rather than that nothing was
        // asked.
        if (d.xp === last.xp && d.t - last.t < LEADERBOARD_REFRESH_MS) return;
    }
    arr.push(d);

    if (arr.length <= 2) return;

    // Rule 1: within the last 10 minutes, keep only first + last
    let recentLength = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (d.t - arr[i].t <= WINDOW_10M) {
            recentLength++;
        } else {
            break;
        }
    }
    if (recentLength > 2) {
        arr.splice(arr.length - recentLength + 1, recentLength - 2);
    }

    // Rule 2: collapse consecutive same-XP entries within 1 hour
    let sameLength = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].xp === d.xp && d.t - arr[i].t <= WINDOW_1H) {
            sameLength++;
        } else {
            break;
        }
    }
    if (sameLength > 1) {
        arr.splice(arr.length - sameLength, sameLength - 1);
    }

    // Rule 3: drop entries older than 1 week
    let oldLength = 0;
    for (let i = 0; i < arr.length; i++) {
        if (d.t - arr[i].t > WINDOW_1W) {
            oldLength++;
        } else {
            break;
        }
    }
    if (oldLength > 0) {
        arr.splice(0, oldLength);
    }
}

/**
 * Filter history to entries within a time interval from now.
 * @param {Array} arr - History array
 * @param {number} interval - Window in ms
 * @returns {Array}
 */
function inLastInterval(arr, interval) {
    const now = Date.now();
    const result = [];
    for (let i = arr.length - 1; i >= 0; i--) {
        if (now - arr[i].t <= interval) {
            result.unshift(arr[i]);
        } else {
            break;
        }
    }
    return result;
}

/**
 * Keep at most one entry per interval (for chart resolution).
 * @param {Array} arr - History array
 * @param {number} interval - Minimum gap between kept entries
 * @returns {Array}
 */
function keepOneInInterval(arr, interval) {
    const filtered = [];
    for (let i = arr.length - 1; i >= 0; i--) {
        if (filtered.length === 0) {
            filtered.unshift(arr[i]);
        } else if (filtered[0].t - arr[i].t >= interval) {
            filtered.unshift(arr[i]);
        } else if (i === 0) {
            filtered.unshift(arr[i]);
        }
    }
    return filtered;
}

/**
 * Drop readings that only repeat the one before them, healing a history
 * recorded before duplicates were rejected.
 * @param {Array} arr - [{t, xp}, ...]
 * @returns {Array} The same samples with uninformative repeats removed
 */
export function dropFlatRepeats(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return arr || [];
    const out = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
        const last = out[out.length - 1];
        if (arr[i].xp === last.xp && arr[i].t - last.t < LEADERBOARD_REFRESH_MS) continue;
        out.push(arr[i]);
    }
    return out;
}

/**
 * Calculate XP/hr between two data points.
 * @param {{t: number, xp: number}} prev
 * @param {{t: number, xp: number}} cur
 * @returns {number} XP per hour
 */
function calcXPH(prev, cur) {
    const tDeltaMs = cur.t - prev.t;
    if (tDeltaMs <= 0) return 0;
    return ((cur.xp - prev.xp) / tDeltaMs) * 3600000;
}

// ─── Stats calculation ──────────────────────────────────────────────────────

/**
 * Compute XP/hr stats for a history array.
 * @param {Array} arr - [{t, xp}, ...]
 * @returns {{lastXPH: number, lastHourXPH: number, lastDayXPH: number, chart: Array}}
 */
export function calcStats(arr) {
    const empty = { lastXPH: 0, lastHourXPH: 0, lastDayXPH: 0, chart: [] };
    if (!arr || arr.length < 2) return empty;

    // Last XP/h (between last two entries)
    const lastXPH = calcXPH(arr[arr.length - 2], arr[arr.length - 1]);

    // Last hour XP/h
    const last1h = inLastInterval(arr, WINDOW_1H);
    const lastHourXPH = last1h.length >= 2 ? calcXPH(last1h[0], last1h[last1h.length - 1]) : 0;

    // Last day XP/h
    const last1d = inLastInterval(arr, WINDOW_1D);
    const lastDayXPH = last1d.length >= 2 ? calcXPH(last1d[0], last1d[last1d.length - 1]) : 0;

    // Chart: weekly data at 10m resolution
    const last1w = inLastInterval(arr, WINDOW_1W);
    const chartData = keepOneInInterval(last1w, WINDOW_10M);
    const chart = [];
    for (let i = 1; i < chartData.length; i++) {
        const prev = chartData[i - 1];
        const cur = chartData[i];
        chart.push({
            t: cur.t,
            tD: cur.t - prev.t,
            xpH: calcXPH(prev, cur),
        });
    }

    return { lastXPH, lastHourXPH, lastDayXPH, chart };
}

/**
 * Where an XP total sits on the guild level curve.
 *
 * The table is indexed from level 1 at zero XP, so the index of the first
 * threshold the total has not reached *is* the current level — a guild with 33
 * XP has crossed index 1 and is level 2, and a guild with none is level 1.
 *
 * @param {number} xp - Total guild XP
 * @returns {{level: number, currentXP: number, nextLevelXP: number|null, xpToNext: number|null}}
 */
export function guildLevelFromXP(xp) {
    const total = Number.isFinite(xp) ? xp : 0;
    const nextIndex = LEVEL_EXPERIENCE_TABLE.findIndex((threshold) => total < threshold);

    // Past the end of the table there is no next level to work towards
    if (nextIndex < 0) {
        return { level: LEVEL_EXPERIENCE_TABLE.length, currentXP: total, nextLevelXP: null, xpToNext: null };
    }

    const nextLevelXP = LEVEL_EXPERIENCE_TABLE[nextIndex];
    return { level: nextIndex, currentXP: total, nextLevelXP, xpToNext: nextLevelXP - total };
}

/**
 * Calculate time to next guild level.
 * @param {number} currentXP - Current guild XP
 * @param {number} xpPerHour - Current XP/hr rate
 * @returns {number|null} Milliseconds to next level, or null if cannot calculate
 */
function calcTimeToLevel(currentXP, xpPerHour) {
    if (xpPerHour <= 0) return null;

    const nextLvlIndex = LEVEL_EXPERIENCE_TABLE.findIndex((xp) => currentXP <= xp);
    if (nextLvlIndex < 0) return null;

    const xpTillLevel = LEVEL_EXPERIENCE_TABLE[nextLvlIndex] - currentXP;
    if (xpTillLevel <= 0) return null;

    return (xpTillLevel / xpPerHour) * 3600000;
}

// ─── Tracker class ──────────────────────────────────────────────────────────

/**
 * Drop the XP history of anybody no longer in the guild.
 *
 * Mutates the map it is given — it is the tracker's own and is about to be
 * written back — and returns who left, so the caller can say so.
 *
 * Only ever called against a **full** roster. The login snapshot carries every
 * member; `guild_characters_updated` has never been shown to, and pruning
 * against a message that turns out to be a delta would delete the guild. So the
 * routine refresh stays additive and a departure clears on the next load, which
 * is the same guarantee everything else stored here has.
 *
 * @param {Object<string, Array<Object>>} history - characterID → XP samples, mutated
 * @param {string[]} currentIds - The character ids the roster states
 * @returns {string[]} The ids that were dropped
 */
export function pruneDepartedMembers(history, currentIds) {
    if (!history || typeof history !== 'object') return [];
    // An empty roster is "not known" rather than "nobody is in this guild", and
    // pruning against it would empty the map on any message that arrived early
    if (!Array.isArray(currentIds) || !currentIds.length) return [];

    const current = new Set(currentIds.map(String));
    const departed = Object.keys(history).filter((id) => !current.has(String(id)));
    for (const id of departed) delete history[id];

    return departed;
}

/**
 * Two XP history maps folded into one, the second winning where they clash.
 *
 * Each map is `name → [{t, xp}]`. Per name the two series are unioned by
 * sample timestamp, the in-memory sample standing when both sides hold the
 * same instant, and the result is sorted by time. Nothing is compacted here:
 * the next `pushXP` tidies the tail, and a few extra samples are cheaper than
 * a rule that drops what another tab recorded. Series only one side knows —
 * a guild first seen on another tab's leaderboard, a member sampled before a
 * failed read — are kept rather than overwritten.
 * @param {Object<string, Array<{t: number, xp: number}>>} stored - As read from storage
 * @param {Object<string, Array<{t: number, xp: number}>>} memory - The fresher, in-memory map
 * @returns {Object<string, Array<{t: number, xp: number}>>} Merged map
 */
export function mergeXPHistories(stored, memory) {
    const base = stored && typeof stored === 'object' ? stored : {};
    const fresh = memory && typeof memory === 'object' ? memory : {};
    const out = {};
    for (const name of new Set([...Object.keys(base), ...Object.keys(fresh)])) {
        const storedArr = Array.isArray(base[name]) ? base[name] : [];
        const memArr = Array.isArray(fresh[name]) ? fresh[name] : [];
        if (!storedArr.length) {
            out[name] = memArr;
            continue;
        }
        const byTime = new Map();
        for (const sample of storedArr) {
            if (sample && Number.isFinite(sample.t)) byTime.set(sample.t, sample);
        }
        for (const sample of memArr) {
            if (sample && Number.isFinite(sample.t)) byTime.set(sample.t, sample);
        }
        out[name] = [...byTime.values()].sort((a, b) => a.t - b.t);
    }
    return out;
}

class GuildXPTracker {
    constructor() {
        this.initialized = false;
        this.ownGuildName = null;
        this.ownGuildID = null;
        this.guildCreatedAt = null;
        this.guildType = null;
        this.currentWeekStartAt = null;
        this.guildXPHistory = {}; // guildName → [{t, xp}]
        this.memberXPHistory = {}; // characterID → [{t, xp}]
        this.memberMeta = {}; // characterID → {name, gameMode, joinTime, invitedBy, ...}
        this.unregisterHandlers = [];
        /** One save chain per storage key, so read-merge-writes never interleave */
        this._saveChains = new Map();
    }

    /**
     * Turn a `storage.tryGet` probe into a history map, telling a failed read
     * apart from an absent one.
     *
     * A read that could not be made is not an empty history: taking it for one
     * and then writing it back is how a guild's week of samples used to vanish
     * over a dropped IndexedDB connection. On failure the caller's in-memory
     * map stands (the same record, kept), or an empty map when the key is a
     * record this tab has never held — which is safe only because every save
     * merges the stored map under memory first.
     * @param {{found: boolean, value: *}|null} probe - What `storage.tryGet` answered
     * @param {Object} memory - The map to keep when the read cannot be trusted
     * @param {string} key - Storage key, for the log line
     * @returns {Object} The stored map, `{}` when absent, or `memory` on failure
     */
    _resolveLoad(probe, memory, key) {
        if (probe === null) {
            console.warn(`[GuildXPTracker] ${key} could not be read; keeping the in-memory copy`);
            return memory && typeof memory === 'object' ? memory : {};
        }
        return probe.found && probe.value && typeof probe.value === 'object' ? probe.value : {};
    }

    /**
     * Read a history map, keeping `memory` when the read cannot be trusted.
     * @param {string} key - Storage key
     * @param {Object} memory - The map to keep on a failed read
     * @returns {Promise<Object>} See `_resolveLoad`
     */
    async _loadMap(key, memory) {
        return this._resolveLoad(await storage.tryGet(key, STORE_NAME), memory, key);
    }

    /**
     * Persist a history map: re-read, merge what is stored under memory, write.
     *
     * Memory wins per sample, so the stored copy only ever grows from here —
     * samples another tab recorded, or that were written before a read failed,
     * survive. When storage cannot be read the write is refused rather than made
     * blind; the next save retries. Saves to one key run one at a time, in order.
     *
     * The merge is folded into `map` in place (it keeps its identity), so a
     * guild switch that swaps the field between queue and run does not merge the
     * wrong guild's record.
     * @param {string} key - Storage key
     * @param {Object} map - The live in-memory map for that key
     * @param {Object} [options]
     * @param {boolean} [options.overwrite=false] - Write the map as-is. For the
     *   intentional losses — a reset, a prune straight after a successful load.
     * @returns {Promise<boolean>} Whether a write was queued
     */
    _persist(key, map, { overwrite = false } = {}) {
        const run = async () => {
            try {
                if (!overwrite) {
                    const probe = await storage.tryGet(key, STORE_NAME);
                    if (probe === null) {
                        console.warn(`[GuildXPTracker] ${key} not saved: storage could not be read first`);
                        return false;
                    }
                    if (probe.found && probe.value && typeof probe.value === 'object') {
                        Object.assign(map, mergeXPHistories(probe.value, map));
                    }
                }
                return await storage.set(key, map, STORE_NAME);
            } catch (error) {
                console.error(`[GuildXPTracker] Failed to save ${key}:`, error);
                return false;
            }
        };
        const chain = (this._saveChains.get(key) || Promise.resolve()).then(run, run);
        this._saveChains.set(key, chain);
        return chain;
    }

    async initialize() {
        if (this.initialized) return;
        if (!config.getSetting('guildXPTracker', true)) return;

        // Bind handlers
        this._boundOnCharacterInit = (data) => this._onCharacterInit(data);
        this._boundOnGuildUpdated = (data) => this._onGuildUpdated(data);
        this._boundOnMembersUpdated = (data) => this._onMembersUpdated(data);
        this._boundOnLeaderboardUpdated = (data) => this._onLeaderboardUpdated(data);

        // Register dataManager listener for init data
        dataManager.on('character_initialized', this._boundOnCharacterInit);
        this.unregisterHandlers.push(() => dataManager.off('character_initialized', this._boundOnCharacterInit));

        // Register WebSocket listeners
        webSocketHook.on('guild_updated', this._boundOnGuildUpdated);
        webSocketHook.on('guild_characters_updated', this._boundOnMembersUpdated);
        webSocketHook.on('leaderboard_updated', this._boundOnLeaderboardUpdated);
        this._boundOnTrialSignupUpdated = (data) => this._onTrialSignupUpdated(data);
        webSocketHook.on('guild_trial_signup_updated', this._boundOnTrialSignupUpdated);
        this.unregisterHandlers.push(() => {
            webSocketHook.off('guild_updated', this._boundOnGuildUpdated);
            webSocketHook.off('guild_characters_updated', this._boundOnMembersUpdated);
            webSocketHook.off('leaderboard_updated', this._boundOnLeaderboardUpdated);
            webSocketHook.off('guild_trial_signup_updated', this._boundOnTrialSignupUpdated);
        });

        // If character data already loaded, load the history — but not here.
        //
        // This reads a guild's whole XP history out of IndexedDB, adds a
        // reading to every member's series and writes the lot back. Nobody is
        // looking at any of it yet, and every feature after this one in the
        // registry was waiting for it: on a large guild it was six seconds of
        // the page not starting.
        //
        // `ready` is what keeps that safe. A guild_updated arriving before the
        // load finishes would otherwise append to an empty history and then be
        // overwritten by the load, so the handlers wait on it.
        if (dataManager.characterData) {
            this.ready = runInBackground('guildXPTracker', () => this._onCharacterInit(dataManager.characterData));
        }

        this.initialized = true;
    }

    /**
     * Handle character initialization — load persisted history and record initial snapshot.
     * @param {Object} data - Full init_character_data message
     */
    async _onCharacterInit(data) {
        const guild = data.guild;
        if (!guild) return; // Player not in a guild

        const guildName = guild.name;
        const guildXP = guild.experience;
        const previousGuildName = this.ownGuildName;
        const previousGuildID = this.ownGuildID;
        this.ownGuildName = guildName;
        this.guildCreatedAt = guild.createdAt;
        this.guildType = guild.guildType || null;
        this.currentWeekStartAt = guild.currentWeekStartAt || null;

        // Extract guild ID and member metadata
        const guildCharacterMap = data.guildCharacterMap || {};
        const sharableMap = data.guildSharableCharacterMap || {};
        this.rawSharableMap = sharableMap;

        const charIds = Object.keys(guildCharacterMap);
        if (charIds.length > 0) {
            this.ownGuildID = guildCharacterMap[charIds[0]].guildID;
        }

        // Build member metadata
        this.memberMeta = {};
        for (const [charId, sharableData] of Object.entries(sharableMap)) {
            const guildChar = guildCharacterMap[charId];
            const inviterId = guildChar?.inviterCharacterID;
            this.memberMeta[charId] = {
                name: sharableData.name,
                gameMode: sharableData.gameMode,
                joinTime: guildChar?.joinTime || null,
                invitedBy: sharableMap[inviterId]?.name || null,
                inactiveTime: parseInactiveTime(sharableData.inactiveTime),
                actionType: sharableData.actionType || '',
                isOnline: sharableData.isOnline || false,
                hideOnlineStatus: sharableData.hideOnlineStatus || false,
                signedUpSkillingTrialHrid: guildChar?.signedUpSkillingTrialHrid || '',
                signedUpCombatTrialHrid: guildChar?.signedUpCombatTrialHrid || '',
                signupWeekStartAt: guildChar?.signupWeekStartAt || null,
            };
        }

        // Load persisted histories
        const endLoad = performanceMonitor.startSpan('bg:guildXPTracker', 'load history');
        // A failed read keeps what this tab already holds for the same record;
        // a record this tab has never held starts empty, which the merge-on-save
        // below makes safe
        const guildProbe = await storage.tryGet(`guildXP_${guildName}`, STORE_NAME);
        this.guildXPHistory = this._resolveLoad(
            guildProbe,
            guildName === previousGuildName ? this.guildXPHistory : {},
            `guildXP_${guildName}`
        );
        // Histories recorded before repeats were rejected end in two identical
        // readings, which reads as a rate of zero. Heal them on the way in.
        for (const [name, arr] of Object.entries(this.guildXPHistory)) {
            this.guildXPHistory[name] = dropFlatRepeats(arr);
        }
        let membersProbe = null;
        if (this.ownGuildID) {
            membersProbe = await storage.tryGet(`memberXP_${this.ownGuildID}`, STORE_NAME);
            this.memberXPHistory = this._resolveLoad(
                membersProbe,
                this.ownGuildID === previousGuildID ? this.memberXPHistory : {},
                `memberXP_${this.ownGuildID}`
            );
            // Self-heal on the way in. The history map never forgets anybody it
            // has ever sampled, so a member who left the guild kept their weekly
            // rate, did nothing all day because they were gone, and sat in the
            // roster's "Gone quiet" list permanently — headed `#9349`, because
            // they had been dropped from the member list and there was no name
            // left to head it with. The login snapshot is the whole roster, so
            // it is the one moment this can be said with certainty.
            const departed = pruneDepartedMembers(this.memberXPHistory, Object.keys(guildCharacterMap));
            if (departed.length) {
                console.warn(
                    `[GuildXPTracker] Dropping ${departed.length} member${departed.length === 1 ? '' : 's'} ` +
                        `no longer in the guild: ${departed.slice(0, 8).join(', ')}` +
                        `${departed.length > 8 ? `, +${departed.length - 8} more` : ''}`
                );
                this._persist(`memberXP_${this.ownGuildID}`, this.memberXPHistory, { overwrite: true });
            }
        }
        endLoad();

        const t = data.currentTimestamp ? +new Date(data.currentTimestamp) : Date.now();

        // Record guild XP snapshot
        if (!this.guildXPHistory[guildName]) {
            this.guildXPHistory[guildName] = [];
        }
        pushXP(this.guildXPHistory[guildName], { t, xp: guildXP });

        // Record member XP snapshots
        for (const [charId, guildChar] of Object.entries(guildCharacterMap)) {
            if (!this.memberXPHistory[charId]) {
                this.memberXPHistory[charId] = [];
            }
            pushXP(this.memberXPHistory[charId], { t, xp: guildChar.guildExperience });
        }

        // Persist — queued, not awaited. storage.set is debounced and its
        // promise resolves only when the 3-second timer fires, so awaiting two
        // of them in series is six seconds of waiting for timers whose entire
        // purpose is to not write yet. The trace read it as a six-second save;
        // the actual write is milliseconds, and flushAll on unload covers the
        // tab closing before the timer lands.
        //
        // Straight after a successful load, memory is storage plus the heal and
        // the prune above, both of which are meant to lose entries — so that one
        // save writes as-is; a load that failed goes through the merge instead.
        const endSave = performanceMonitor.startSpan('bg:guildXPTracker', 'queue save');
        this._persist(`guildXP_${guildName}`, this.guildXPHistory, { overwrite: guildProbe !== null });
        if (this.ownGuildID) {
            this._persist(`memberXP_${this.ownGuildID}`, this.memberXPHistory, { overwrite: membersProbe !== null });
        }
        endSave();
    }

    /**
     * Wait for the history load, where it matters.
     *
     * An update that lands mid-load would otherwise write into an empty history
     * and be overwritten the moment the real one arrives.
     * @returns {Promise<void>}
     */
    async whenReady() {
        if (this.ready) await this.ready;
    }

    /**
     * Handle guild_updated — record guild-level XP.
     * @param {Object} data - guild_updated message
     */
    async _onGuildUpdated(data) {
        await this.whenReady();
        const guild = data.guild;
        if (!guild) return;

        const name = guild.name;
        const previous = this.ownGuildName;
        this.ownGuildName = name;
        this.guildCreatedAt = guild.createdAt;

        // A guild change mid-session. The map in hand is the guild just left's
        // key, and `_persist` below would write the whole of it — every series
        // it holds — under `guildXP_<new guild>`. The arriving guild's own
        // record is read instead, as `_onCharacterInit` already does
        if (previous && previous !== name) {
            const loaded = await this._loadMap(`guildXP_${name}`, {});
            // Another change may have landed while the read was in flight
            if (this.ownGuildName !== name) return;
            this.guildXPHistory = loaded;
        }
        this.guildType = guild.guildType || this.guildType;
        this.currentWeekStartAt = guild.currentWeekStartAt || this.currentWeekStartAt;

        if (!this.guildXPHistory[name]) {
            this.guildXPHistory[name] = [];
        }

        const t = Date.now();
        pushXP(this.guildXPHistory[name], { t, xp: guild.experience });
        this._persist(`guildXP_${name}`, this.guildXPHistory);
    }

    /**
     * Handle guild_characters_updated — record per-member XP.
     * @param {Object} data - guild_characters_updated message
     */
    async _onMembersUpdated(data) {
        await this.whenReady();
        const guildCharacterMap = data.guildCharacterMap || {};
        const sharableMap = data.guildSharableCharacterMap || {};
        this.rawSharableMap = sharableMap;

        // Detect guild change (same character, different guild)
        const charIds = Object.keys(guildCharacterMap);
        const newGuildID = charIds.length > 0 ? guildCharacterMap[charIds[0]].guildID : null;

        if (newGuildID && this.ownGuildID && newGuildID !== this.ownGuildID) {
            // Guild switched — drop the old guild's member data and load the new
            // guild's record. A read that fails here starts the new record empty
            // rather than carrying the old guild's members into it; nothing is
            // lost because every save merges what is stored under memory first.
            this.memberXPHistory = await this._loadMap(`memberXP_${newGuildID}`, {});
            this.memberMeta = {};
        }

        if (newGuildID) {
            this.ownGuildID = newGuildID;
        }

        // A refresh that carries most of the roster is the roster, and anybody
        // missing from it has left. A *delta* — one member's XP ticking over —
        // carries one entry out of a hundred, so the majority rule separates the
        // two cleanly and fails in the safe direction: an unrecognised shape
        // prunes nobody and the login snapshot heals it on the next load.
        //
        // Whether this message is ever a delta is genuinely unknown. It produced
        // no events in the one raw capture there is, so this is a judgement about
        // an unverified shape rather than a fact about it, and it is written to
        // be wrong harmlessly.
        const held = Object.keys(this.memberMeta).length;
        const carries = Object.keys(sharableMap).length;
        if (held && carries > held / 2) {
            const gone = Object.keys(this.memberMeta).filter((charId) => !sharableMap[charId]);
            for (const charId of gone) delete this.memberMeta[charId];
            if (gone.length) {
                console.warn(`[GuildXPTracker] ${gone.length} member(s) are no longer on the guild roster`);
            }
        }

        // Update member metadata
        for (const [charId, sharableData] of Object.entries(sharableMap)) {
            const guildChar = guildCharacterMap[charId];
            const inviterId = guildChar?.inviterCharacterID;
            this.memberMeta[charId] = {
                name: sharableData.name,
                gameMode: sharableData.gameMode,
                joinTime: guildChar?.joinTime || null,
                invitedBy: sharableMap[inviterId]?.name || null,
                inactiveTime: parseInactiveTime(sharableData.inactiveTime),
                actionType: sharableData.actionType || '',
                isOnline: sharableData.isOnline || false,
                hideOnlineStatus: sharableData.hideOnlineStatus || false,
                signedUpSkillingTrialHrid: guildChar?.signedUpSkillingTrialHrid || '',
                signedUpCombatTrialHrid: guildChar?.signedUpCombatTrialHrid || '',
                signupWeekStartAt: guildChar?.signupWeekStartAt || null,
            };
        }

        const t = Date.now();

        for (const [charId, guildChar] of Object.entries(guildCharacterMap)) {
            if (!this.memberXPHistory[charId]) {
                this.memberXPHistory[charId] = [];
            }
            pushXP(this.memberXPHistory[charId], { t, xp: guildChar.guildExperience });
        }

        if (this.ownGuildID) {
            this._persist(`memberXP_${this.ownGuildID}`, this.memberXPHistory);
        }
    }

    /**
     * Handle guild_trial_signup_updated — update a single member's trial signup state.
     * @param {Object} data - guild_trial_signup_updated message
     */
    _onTrialSignupUpdated(data) {
        const charId = String(data.characterId);
        const meta = this.memberMeta[charId];
        if (!meta) return;
        meta.signedUpSkillingTrialHrid = data.signedUpSkillingTrialHrid || '';
        meta.signedUpCombatTrialHrid = data.signedUpCombatTrialHrid || '';
        meta.signupWeekStartAt = data.signupWeekStartAt || null;
    }

    /**
     * Handle leaderboard_updated (category: guild) — record XP for all guilds on the guild leaderboard.
     * @param {Object} data - leaderboard_updated message
     */
    async _onLeaderboardUpdated(data) {
        await this.whenReady();
        if (data.leaderboardCategory !== 'guild') return;

        const rows = data.leaderboard?.rows;
        if (!rows || rows.length === 0) return;

        const t = Date.now();

        for (const row of rows) {
            const name = row.name;
            const xp = row.value2;
            if (!name || xp === undefined) continue;

            if (!this.guildXPHistory[name]) {
                this.guildXPHistory[name] = [];
            }
            pushXP(this.guildXPHistory[name], { t, xp });
        }

        if (this.ownGuildName) {
            this._persist(`guildXP_${this.ownGuildName}`, this.guildXPHistory);
        }
    }

    // ─── Public API (for display module) ─────────────────────────────────────

    /**
     * What the tracker actually holds, for telling "no samples yet" apart from
     * "the samples never arrived". A rate needs two readings: the leaderboard
     * refreshes every 20 minutes and only while the panel is open, so a column
     * can be legitimately blank for a long time on a fresh install.
     *
     * Console: Toolasha.Debug.guildXp()
     * @returns {Object} Sample counts and spans per guild
     */
    debugState() {
        const summary = (history) =>
            Object.entries(history)
                .map(([name, arr]) => ({
                    name,
                    samples: arr.length,
                    spanHours: arr.length > 1 ? +((arr[arr.length - 1].t - arr[0].t) / 3600000).toFixed(2) : 0,
                    newest: arr.length ? new Date(arr[arr.length - 1].t).toISOString() : null,
                }))
                .sort((a, b) => b.samples - a.samples);

        const guilds = summary(this.guildXPHistory || {});
        const members = summary(this.memberXPHistory || {});
        console.log(`[Toolasha] Guild XP history — ${guilds.length} guilds, ${members.length} members tracked`);
        console.log('Guilds with at least 2 samples can show a rate:');
        console.table(guilds.slice(0, 25));
        return { ownGuildName: this.ownGuildName, ownGuildID: this.ownGuildID, guilds, members };
    }

    /**
     * Get XP/hr stats for a guild.
     * @param {string} guildName
     * @returns {{lastXPH: number, lastHourXPH: number, lastDayXPH: number, chart: Array}}
     */
    getGuildStats(guildName) {
        return calcStats(this.guildXPHistory[guildName]);
    }

    /**
     * Get XP/hr stats for a guild member.
     * @param {string} characterID
     * @returns {{lastXPH: number, lastHourXPH: number, lastDayXPH: number, chart: Array}}
     */
    getMemberStats(characterID) {
        return calcStats(this.memberXPHistory[characterID]);
    }

    /**
     * Get metadata for a guild member.
     * @param {string} characterID
     * @returns {{name: string, gameMode: string, joinTime: string, invitedBy: string}|null}
     */
    getMemberMeta(characterID) {
        return this.memberMeta[characterID] || null;
    }

    /**
     * Get own guild name.
     * @returns {string|null}
     */
    getOwnGuildName() {
        return this.ownGuildName;
    }

    /**
     * Get own guild ID.
     * @returns {string|null}
     */
    getOwnGuildID() {
        return this.ownGuildID;
    }

    /**
     * Get guild creation date.
     * @returns {string|null}
     */
    getGuildCreatedAt() {
        return this.guildCreatedAt;
    }

    /**
     * Get the current guild trial week start timestamp.
     * @returns {string|null}
     */
    getCurrentWeekStartAt() {
        return this.currentWeekStartAt;
    }

    /**
     * Get the guild type ('standard', 'ironcow', etc.)
     * @returns {string|null}
     */
    getGuildType() {
        return this.guildType;
    }

    /**
     * Get member list with IDs.
     * @returns {Array<{characterID: string, name: string, gameMode: string, joinTime: string, invitedBy: string}>}
     */
    getMemberList() {
        return Object.entries(this.memberMeta).map(([charId, meta]) => ({
            characterID: charId,
            ...meta,
        }));
    }

    /**
     * Get the raw sharable-data entry for a guild member, for inspecting the
     * fields the game actually sends (console: Toolasha.guild.memberSample()).
     * @param {string} [name] - Member name; first member when omitted
     * @returns {Object|null}
     */
    getRawMemberSample(name) {
        const map = this.rawSharableMap || {};
        const entries = Object.values(map);
        if (!entries.length) return null;
        if (!name) return entries[0];
        return entries.find((e) => e?.name === name) || null;
    }

    /**
     * Get all guild XP histories (for guild leaderboard display).
     * @returns {Object} guildName → [{t, xp}]
     */
    getAllGuildHistories() {
        return this.guildXPHistory;
    }

    /**
     * Get current guild XP (latest recorded value).
     * @param {string} guildName
     * @returns {number|null}
     */
    getCurrentGuildXP(guildName) {
        const history = this.guildXPHistory[guildName];
        if (!history || history.length === 0) return null;
        return history[history.length - 1].xp;
    }

    /**
     * Get latest member XP.
     * @param {string} characterID
     * @returns {number|null}
     */
    getMemberXP(characterID) {
        const history = this.memberXPHistory[characterID];
        if (!history || history.length === 0) return null;
        return history[history.length - 1].xp;
    }

    /**
     * Calculate time to next guild level.
     * @param {string} guildName
     * @returns {number|null} Milliseconds, or null
     */
    getTimeToLevel(guildName) {
        const currentXP = this.getCurrentGuildXP(guildName);
        if (currentXP === null) return null;

        const stats = this.getGuildStats(guildName);
        const rate = stats.lastDayXPH > 0 ? stats.lastDayXPH : stats.lastXPH;
        return calcTimeToLevel(currentXP, rate);
    }

    /**
     * A member's recorded XP samples.
     *
     * Handed out as a copy: these arrays are appended to by the websocket
     * handlers, and a reader that holds the live array sees it change under it
     * mid-render.
     *
     * @param {string} characterID
     * @returns {Array<{t: number, xp: number}>} Oldest first; empty when untracked
     */
    getMemberSeries(characterID) {
        return [...(this.memberXPHistory[characterID] || [])];
    }

    /**
     * Every tracked member's XP samples, for anything that has to compare them
     * against each other — a share of the guild's XP is only meaningful beside
     * everybody else's.
     * @returns {Object<string, Array<{t: number, xp: number}>>} characterID → samples
     */
    getAllMemberSeries() {
        const out = {};
        for (const [charId, series] of Object.entries(this.memberXPHistory)) {
            out[charId] = [...series];
        }
        return out;
    }

    /**
     * A guild's recorded XP samples.
     * @param {string} guildName
     * @returns {Array<{t: number, xp: number}>} Oldest first; empty when untracked
     */
    getGuildSeries(guildName) {
        return [...(this.guildXPHistory[guildName] || [])];
    }

    /**
     * Where a guild sits on the level curve, from its latest recorded XP.
     * @param {string} guildName
     * @returns {{level: number, currentXP: number, nextLevelXP: number|null, xpToNext: number|null}|null}
     */
    getGuildLevelProgress(guildName) {
        const currentXP = this.getCurrentGuildXP(guildName);
        if (currentXP === null) return null;
        return guildLevelFromXP(currentXP);
    }

    /**
     * Reset member XP history for the current guild.
     * Used to clear corrupted data (e.g., after a guild switch).
     */
    async resetMemberData() {
        if (!this.ownGuildID) return;
        this.memberXPHistory = {};
        // The one member write that is meant to lose entries
        await this._persist(`memberXP_${this.ownGuildID}`, this.memberXPHistory, { overwrite: true });
    }

    /**
     * Cleanup when disabled.
     */
    disable() {
        for (const unregister of this.unregisterHandlers) {
            unregister();
        }
        this.unregisterHandlers = [];

        this.ownGuildName = null;
        this.ownGuildID = null;
        this.guildCreatedAt = null;
        this.guildXPHistory = {};
        this.memberXPHistory = {};
        this.memberMeta = {};
        this.initialized = false;
    }
}

const guildXPTracker = new GuildXPTracker();

export default {
    name: 'Guild XP Tracker',
    initialize: () => guildXPTracker.initialize(),
    cleanup: () => {
        try {
            return guildXPTracker.disable();
        } catch (error) {
            console.error('[Guild XP Tracker] Disable failed part-way:', error);
        } finally {
            guildXPTracker.initialized = false;
        }
    },
    resetMemberData: () => guildXPTracker.resetMemberData(),
    getRawMemberSample: (name) => guildXPTracker.getRawMemberSample(name),
    debugState: () => guildXPTracker.debugState(),
};

export { guildXPTracker };
