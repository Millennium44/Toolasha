/**
 * Leaderboard rank data for the name badges: parsing, tiers, merging.
 *
 * The badge design (tier bands, pill, the standard/ironcow board pair and the
 * server payload shape) is adapted from the leaderboard overlay in MWITools
 * (CC-BY-NC-SA-4.0, GreasyFork 494467). No code was copied — the parsing and
 * merging here is written against the shapes recorded in
 * docs/THIRD-PARTY-LICENSES.md.
 *
 * Everything here is pure. Two sources feed it and only one is trusted:
 * the game's own `leaderboard_updated` message, and the response of a
 * third-party host, which is parsed as hostile — sizes capped, only known
 * categories read, names kept as plain strings.
 */

/** Only the top of a board earns a badge */
export const RANK_BADGE_MAX_RANK = 100;

/** Player boards that carry a badge, in tie-break order (earlier wins a tied rank) */
export const RANK_CATEGORIES = Object.freeze([
    'total_level',
    'milking',
    'foraging',
    'woodcutting',
    'cheesesmithing',
    'crafting',
    'tailoring',
    'cooking',
    'brewing',
    'alchemy',
    'enhancing',
    'stamina',
    'intelligence',
    'attack',
    'defense',
    'melee',
    'ranged',
    'magic',
    'task_points',
    'labyrinth_depth',
    'fame_points',
]);

/** Board pairs, in tie-break order */
export const RANK_BOARD_TYPES = Object.freeze(['standard', 'ironcow']);

/** Steam-cohort slots: separate from the global boards, never merged into them */
export const STEAM_BOARD_TYPES = Object.freeze(['standard_steam', 'ironcow_steam']);

/** Every slot a cache may hold, in tie-break order */
export const ALL_BOARD_TYPES = Object.freeze([...RANK_BOARD_TYPES, ...STEAM_BOARD_TYPES]);

const STEAM_SUFFIX = '_steam';

/** A response larger than this is dropped unread; a real one is a few hundred KB at most */
export const MAX_SERVER_TEXT_LENGTH = 2_000_000;

/** Rows read per board — the game lists 100, so this only bounds a hostile payload */
const MAX_ROWS_READ = 500;

/** A name longer than this is not a character name */
const MAX_NAME_LENGTH = 64;

const CATEGORY_SET = new Set(RANK_CATEGORIES);

/**
 * The key a name is looked up under: case- and width-insensitive.
 * @param {*} value - A character name
 * @returns {string} Empty when there is nothing usable
 */
export function normalizeName(value) {
    if (typeof value !== 'string') return '';
    return value.normalize('NFKC').trim().toLocaleLowerCase();
}

/**
 * Which of the two boards a message or payload describes.
 * @param {*} value - `standard`, `ironcow` or the legacy `legacy_ironcow`
 * @returns {'standard'|'ironcow'|null}
 */
export function normalizeBoardType(value) {
    if (typeof value !== 'string') return null;
    const type = value.toLowerCase();
    if (type === 'ironcow' || type === 'legacy_ironcow') return 'ironcow';
    return type === 'standard' ? 'standard' : null;
}

/**
 * Readable name of a board slot.
 * @param {string} type - `standard`, `ironcow`, or a Steam slot (`standard_steam`, `ironcow_steam`)
 * @returns {string} `Standard`, `Ironcow`, `Standard (Steam)` or `Ironcow (Steam)`
 */
export function boardTypeLabel(type) {
    const steam = isSteamBoardType(type);
    const base = steam ? type.slice(0, -STEAM_SUFFIX.length) : type;
    return `${base === 'ironcow' ? 'Ironcow' : 'Standard'}${steam ? ' (Steam)' : ''}`;
}

/**
 * Whether a board slot is a Steam-cohort one.
 * @param {*} type - A board slot
 * @returns {boolean}
 */
export function isSteamBoardType(type) {
    return typeof type === 'string' && type.endsWith(STEAM_SUFFIX);
}

/**
 * Cache key of one board.
 * @param {string} type - `standard`, `ironcow` or a Steam slot
 * @param {string} category - A category slug
 * @returns {string}
 */
export function boardKey(type, category) {
    return `${type}|${category}`;
}

/**
 * Tier band of a rank: 1-20 rainbow, 21-50 gold, 51-80 silver, 81-100 bronze.
 * @param {*} rank - A leaderboard rank
 * @returns {'rainbow'|'gold'|'silver'|'bronze'|null} Null outside 1-100 or for a non-integer
 */
export function tierForRank(rank) {
    if (!Number.isInteger(rank) || rank < 1 || rank > RANK_BADGE_MAX_RANK) return null;
    if (rank <= 20) return 'rainbow';
    if (rank <= 50) return 'gold';
    if (rank <= 80) return 'silver';
    return 'bronze';
}

/**
 * Readable name of a category slug.
 * @param {string} category - A slug such as `total_level`
 * @returns {string} `Total Level`; fame is shown as `Fame`
 */
export function categoryLabel(category) {
    if (category === 'fame_points') return 'Fame';
    return String(category)
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * The board to open next when filling the cache by hand.
 * @param {Object} boards - The cache held
 * @param {string} type - The board slot on screen (a Steam view passes its own opened map as `boards`)
 * @param {string|null} current - The category on screen, when known
 * @returns {string|null} The first category after `current` (in {@link RANK_CATEGORIES} order, wrapping) with no
 *   cached board; when every board is cached, the one cached longest ago. Never `current` itself.
 */
export function nextBoardCategory(boards, type, current) {
    const count = RANK_CATEGORIES.length;
    const start = RANK_CATEGORIES.indexOf(current);
    const order = [];
    for (let i = 1; i <= count; i++) {
        const category = RANK_CATEGORIES[(start + i + count) % count];
        if (category !== current) order.push(category);
    }
    const missing = order.find((category) => !boards?.[boardKey(type, category)]);
    if (missing) return missing;
    let oldest = null;
    for (const category of order) {
        const at = boards[boardKey(type, category)].at;
        if (!oldest || at < oldest.at) oldest = { category, at };
    }
    return oldest ? oldest.category : null;
}

/**
 * Rows of a board as [name, rank] pairs: valid ranks only, one row per name (best rank kept).
 * @param {*} rows - Untrusted row array
 * @param {(row: Object) => *} nameOf - Picks the name field
 * @returns {Array<[string, number]>}
 */
function readRows(rows, nameOf) {
    if (!Array.isArray(rows)) return [];
    const best = new Map();
    const limit = Math.min(rows.length, MAX_ROWS_READ);
    for (let i = 0; i < limit; i++) {
        const row = rows[i];
        if (!row || typeof row !== 'object') continue;
        const name = nameOf(row);
        const rank = Number(row.rank);
        if (typeof name !== 'string') continue;
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > MAX_NAME_LENGTH) continue;
        if (!Number.isInteger(rank) || rank < 1 || rank > RANK_BADGE_MAX_RANK) continue;
        const key = normalizeName(trimmed);
        const held = best.get(key);
        if (!held || rank < held[1]) best.set(key, [trimmed, rank]);
    }
    // A board lists 100 players; more than that is not a board
    return [...best.values()].sort((a, b) => a[1] - b[1]).slice(0, RANK_BADGE_MAX_RANK);
}

/**
 * Whether a `leaderboard_updated` message is a narrowed view (a Steam cohort tab, say) rather than
 * the global board. `gameModeFilter` is the Standard/Ironcow tab, not a narrowing.
 * @param {Object} data - `leaderboard_updated` message
 * @returns {boolean} True for a filtered view
 */
export function isNarrowedBoard(data) {
    if (!data || typeof data !== 'object') return false;
    for (const key of Object.keys(data)) {
        if (key === 'gameModeFilter' || !/Filter$/.test(key)) continue;
        const value = data[key];
        if (typeof value === 'string' && value && value !== 'all') return true;
    }
    return false;
}

/**
 * Whether a narrowed message is a Steam cohort view and nothing else. Only the value `steam` is mapped; a
 * message narrowed by anything else (or by several things) is not a Steam board.
 * @param {Object} data - `leaderboard_updated` message
 * @returns {boolean}
 */
export function isSteamCohortBoard(data) {
    if (!isNarrowedBoard(data)) return false;
    const values = [];
    for (const key of Object.keys(data)) {
        if (key === 'gameModeFilter' || !/Filter$/.test(key)) continue;
        const value = data[key];
        if (typeof value === 'string' && value && value !== 'all') values.push(value.toLowerCase());
    }
    return values.length > 0 && values.every((value) => value === 'steam');
}

/**
 * The board slot a player-category message shows, Steam views included.
 * @param {Object} data - `leaderboard_updated` message
 * @returns {string|null} `standard`, `ironcow`, `standard_steam`, `ironcow_steam`; null for a guild or unknown
 *   category, an unattributable type, or any other narrowing
 */
export function boardViewOf(data) {
    if (!data || typeof data !== 'object') return null;
    const category = data.leaderboardCategory ?? data.leaderboard?.category;
    if (typeof category !== 'string' || !CATEGORY_SET.has(category)) return null;
    const type = normalizeBoardType(data.leaderboardType ?? data.leaderboard?.type ?? data.gameModeFilter);
    if (!type) return null;
    if (!isNarrowedBoard(data)) return type;
    return isSteamCohortBoard(data) ? `${type}${STEAM_SUFFIX}` : null;
}

/**
 * A board the player opened, from the game's `leaderboard_updated` message.
 * @param {Object} data - The message
 * @param {number} now - Timestamp to stamp the board with
 * @param {{includeSteam?: boolean}} [options] - `includeSteam` files a Steam cohort board under its own slot
 * @returns {{key: string, board: {at: number, source: 'local', rows: Array<[string, number]>}}|null}
 *   Null for a guild board, an unknown category, an unattributable board type, or no usable rows; also for any
 *   narrowed view unless it is a Steam cohort and `includeSteam` is set
 */
export function parseLocalBoard(data, now, { includeSteam = false } = {}) {
    if (!data || typeof data !== 'object') return null;
    const board = data.leaderboard;
    const category = data.leaderboardCategory ?? board?.category;
    if (typeof category !== 'string' || !CATEGORY_SET.has(category)) return null;
    // The type rides as `leaderboardType` on the wire MWITools reads and as
    // `gameModeFilter` on the tab filter the XP tracker already reads
    const type = normalizeBoardType(data.leaderboardType ?? board?.type ?? data.gameModeFilter);
    if (!type) return null;
    // Badges mean global ranks: a narrowed view lists a partial top 100 that must not replace the complete
    // snapshot. A Steam cohort gets a slot of its own when asked for; any other narrowing stays out.
    let slot = type;
    if (isNarrowedBoard(data)) {
        if (!includeSteam || !isSteamCohortBoard(data)) return null;
        slot = `${type}${STEAM_SUFFIX}`;
    }
    const rows = readRows(board?.rows, (row) => row.name ?? row.characterName);
    if (!rows.length) return null;
    return { key: boardKey(slot, category), board: { at: now, source: 'local', rows } };
}

/**
 * A `receivedAt` timestamp the server reports, trusted only as far as it is plausible.
 * @param {*} value - ISO string from the payload
 * @param {number} now - Current time
 * @returns {number} Milliseconds; `now` when missing, unparseable or in the future
 */
function readReceivedAt(value, now) {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(parsed) || parsed > now || parsed <= 0) return now;
    return parsed;
}

/**
 * The boards in one third-party payload.
 * @param {*} payload - Parsed JSON, untrusted
 * @param {'standard'|'ironcow'} type - The board pair that was requested
 * @param {number} now - Current time
 * @returns {Object<string, {at: number, source: 'server', rows: Array<[string, number]>}>} Empty when the payload
 *   is not the expected shape or names a different pair than was requested
 */
export function parseServerPayload(payload, type, now) {
    const out = {};
    if (!payload || typeof payload !== 'object' || payload.schemaVersion !== 1) return out;
    if (normalizeBoardType(payload.leaderboardType) !== type) return out;
    const categories = payload.categories;
    if (!categories || typeof categories !== 'object') return out;
    for (const category of RANK_CATEGORIES) {
        if (!Object.hasOwn(categories, category)) continue;
        const snapshot = categories[category];
        if (!snapshot || typeof snapshot !== 'object') continue;
        const rows = readRows(snapshot.rows, (row) => row.characterName ?? row.name);
        if (!rows.length) continue;
        out[boardKey(type, category)] = {
            at: readReceivedAt(snapshot.receivedAt, now),
            source: 'server',
            rows,
        };
    }
    return out;
}

/**
 * A raw response body, size-capped and parsed.
 * @param {*} text - Response text
 * @param {'standard'|'ironcow'} type - The board pair that was requested
 * @param {number} now - Current time
 * @returns {Object<string, Object>} Same as {@link parseServerPayload}; empty on any failure
 */
export function parseServerText(text, type, now) {
    if (typeof text !== 'string' || !text || text.length > MAX_SERVER_TEXT_LENGTH) return {};
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        return {};
    }
    return parseServerPayload(payload, type, now);
}

/**
 * A cache read back from storage, or arriving from another device, reduced to valid boards.
 * A capture time in the future (a fast-clock device) is capped to `now`: left alone it would win every merge
 * until wall time caught up and freeze stale ranks.
 * @param {*} value - Whatever was stored
 * @param {number} [now] - Current time; the bound on `at`
 * @returns {Object<string, {at: number, source: 'local'|'server', rows: Array<[string, number]>}>}
 */
export function sanitizeBoards(value, now = Date.now()) {
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const type of ALL_BOARD_TYPES) {
        for (const category of RANK_CATEGORIES) {
            const key = boardKey(type, category);
            if (!Object.hasOwn(value, key)) continue;
            const held = value[key];
            if (!held || typeof held !== 'object' || !Number.isFinite(held.at) || held.at <= 0) continue;
            const rows = readRows(
                Array.isArray(held.rows) ? held.rows.map((pair) => ({ n: pair?.[0], rank: pair?.[1] })) : [],
                (row) => row.n
            );
            if (!rows.length) continue;
            out[key] = { at: Math.min(held.at, now), source: held.source === 'server' ? 'server' : 'local', rows };
        }
    }
    return out;
}

/**
 * Board by board, the newer snapshot wins; on a tie the game's own rows beat the server's.
 * Also the cross-device sync fold, which is why it takes two whole caches.
 * @param {Object} base - The cache held
 * @param {Object} incoming - The cache arriving
 * @param {number} [now] - Current time; future capture times are capped to it
 * @returns {Object} A new cache; neither argument is modified
 */
export function mergeBoards(base, incoming, now = Date.now()) {
    const out = { ...sanitizeBoards(base, now) };
    for (const [key, board] of Object.entries(sanitizeBoards(incoming, now))) {
        const held = out[key];
        if (
            !held ||
            board.at > held.at ||
            (board.at === held.at && board.source === 'local' && held.source !== 'local')
        ) {
            out[key] = board;
        }
    }
    return out;
}

/**
 * Every ranked entry per player, best first.
 * @param {Object} boards - The merged cache
 * @param {{includeSteam?: boolean}} [options] - Steam slots are skipped unless `includeSteam`; they stay cached
 * @returns {Map<string, Array<{type: string, category: string, rank: number, at: number, source: string}>>}
 *   Keyed by normalized name; each list sorted by rank, then category order, then board type
 */
export function buildNameIndex(boards, { includeSteam = false } = {}) {
    const index = new Map();
    const categoryOrder = new Map(RANK_CATEGORIES.map((category, position) => [category, position]));
    for (const type of includeSteam ? ALL_BOARD_TYPES : RANK_BOARD_TYPES) {
        for (const category of RANK_CATEGORIES) {
            const board = boards?.[boardKey(type, category)];
            if (!board) continue;
            for (const [name, rank] of board.rows) {
                const key = normalizeName(name);
                if (!key || !tierForRank(rank)) continue;
                const list = index.get(key) || [];
                list.push({ type, category, rank, at: board.at, source: board.source });
                index.set(key, list);
            }
        }
    }
    for (const list of index.values()) {
        list.sort(
            (a, b) =>
                a.rank - b.rank ||
                categoryOrder.get(a.category) - categoryOrder.get(b.category) ||
                ALL_BOARD_TYPES.indexOf(a.type) - ALL_BOARD_TYPES.indexOf(b.type)
        );
    }
    return index;
}

/**
 * The entry a player's badge shows: their best rank on any board.
 * @param {Array<Object>|undefined} entries - A list from {@link buildNameIndex}
 * @returns {Object|null}
 */
export function bestEntry(entries) {
    return entries?.length ? entries[0] : null;
}
