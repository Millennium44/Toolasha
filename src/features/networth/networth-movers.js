/**
 * Net worth movers: which items moved a reading.
 *
 * The history chart stores one point per reading and no item detail, so a jump of 500M cannot be traced
 * to the items behind it. Each reading also keeps a compact per-item value map here, made from the
 * breakdown the net worth calculation already produced (nothing is recalculated or fetched), and the
 * chart diffs two maps to show the items that moved it.
 *
 * Retention: the maps of the most recent {@link RECENT_READINGS} readings, plus the readings whose total
 * moved at least {@link JUMP_ABSOLUTE} or {@link JUMP_RELATIVE} from the reading before (the newest
 * {@link MAX_JUMPS} of them), each kept together with that reading before, since a change needs both ends.
 * Pruned on every write.
 *
 * Storage: one record per reading (`networthMovers_<characterId>_<t>`) and one small index per character
 * (`networthMoversIndex_<characterId>`) in the `networthHistory` store. Both are device-local: the prefix
 * is declared in `DEVICE_ONLY_STORE_KEY_PREFIXES` (sync-ownership.js), so a sync neither uploads nor
 * applies them. A write that fails costs the detail of that reading and nothing else.
 *
 * Size: a row is about 60 to 75 bytes (a hrid, a level, a count, a value). A late-game account holds
 * 300 to 500 rows, so a record is roughly 20 to 40 KB and the 24 recent readings plus the held jump pairs
 * (at most 44 records) come to about 1 MB. A record is capped at {@link MAX_ROWS} rows, which holds the
 * worst case near 3.5 MB; the rows cut are the smallest and the record says how many.
 */

import storage from '../../core/storage.js';
import config from '../../core/config.js';
import { registerCharacterScopedPrefix } from '../../utils/chunked-history.js';
import { isIronCowCharacter, getIronCowValuationMode } from '../../utils/ironcow-valuation.js';

const STORE_NAME = 'networthHistory';

/** Record key stem, `networthMovers_<characterId>_<t>`. Also the device-only prefix in sync-ownership.js. */
export const MOVERS_PREFIX = 'networthMovers';

/** Index key stem, `networthMoversIndex_<characterId>`. Begins with {@link MOVERS_PREFIX}, so it is device-only too. */
export const MOVERS_INDEX_PREFIX = 'networthMoversIndex';

registerCharacterScopedPrefix(STORE_NAME, MOVERS_PREFIX);
// The index (`networthMoversIndex_<id>`) has no chunk segment, which the per-character count cannot read, so only the records are registered

export const RECENT_READINGS = 24;
export const MAX_JUMPS = 10;
export const JUMP_ABSOLUTE = 100_000_000;
export const JUMP_RELATIVE = 0.01;
export const MAX_ROWS = 1200;
export const TOP_COUNT = 10;

const FLAG_UNPRICED = 1;
const FLAG_PARTIAL = 2;

/** A price shift smaller than this many coins on the new count is value rounding, not a price move */
const ROUNDING_COINS = 1.5;

/**
 * Whether a reading's total moved enough from the one before to keep its detail for good.
 * @param {number|null|undefined} prevTotal - Total of the reading before
 * @param {number} total - Total of this reading
 * @returns {boolean} True when the move is at least 100M or 1%
 */
export function isBigJump(prevTotal, total) {
    if (!Number.isFinite(prevTotal) || !Number.isFinite(total)) return false;
    const move = Math.abs(total - prevTotal);
    return move >= JUMP_ABSOLUTE || (prevTotal > 0 && move / prevTotal >= JUMP_RELATIVE);
}

/**
 * Which readings keep their maps.
 * @param {Array<{t: number, prevT: number|null, jump: boolean}>} index - Every reading held, any order
 * @param {{recent?: number, maxJumps?: number}} [limits] - Overrides for tests
 * @returns {Set<number>} The `t` of each reading to keep
 */
export function selectKept(index, { recent = RECENT_READINGS, maxJumps = MAX_JUMPS } = {}) {
    const sorted = [...index].sort((a, b) => a.t - b.t);
    const held = new Set(sorted.map((entry) => entry.t));
    const keep = new Set(sorted.slice(-recent).map((entry) => entry.t));
    const jumps = sorted.filter((entry) => entry.jump).slice(-maxJumps);
    for (const entry of jumps) {
        keep.add(entry.t);
        // The reading before is half of the pair; it counts only while it is still held
        if (entry.prevT != null && held.has(entry.prevT)) keep.add(entry.prevT);
    }
    return keep;
}

/**
 * The pricing context a reading was made under, so a later diff can say when it changed.
 * @returns {{pm: string, vs: string, ic: string|null}} Net worth side, value source, Iron Cow valuation or null
 */
export function currentPricingContext() {
    let ic = null;
    try {
        if (isIronCowCharacter()) ic = getIronCowValuationMode();
    } catch {
        ic = null;
    }
    return {
        pm: config.getSettingValue('networth_pricingMode') || 'ask',
        vs: config.getSettingValue('networth_valueSource') || 'orderBook',
        ic,
    };
}

/**
 * Per-item rows for one reading, from the calculation's own breakdowns.
 *
 * A row is `[kind, hrid, level, count, value, flags?]`. Kinds: `h` holdings (inventory and worn
 * together, so moving a piece between them is no change), `k` ability books held as fixed assets, `s`/`b`
 * a sell or buy listing. Rows with the same kind, hrid and level merge (duplicates, stacks), summing count
 * and value. Flags: 1 = nothing priced it (value 0), 2 = valued on a partial bill (a floor).
 * @param {Object} data - The calculator's result
 * @returns {{rows: Array<Array>, cut: number}} Rows largest first, and how many small ones were left out
 */
export function buildRows(data) {
    const merged = new Map();
    const add = (kind, hrid, level, count, value, partial) => {
        if (!hrid) return;
        const lvl = Number(level) || 0;
        const key = `${kind}|${hrid}|${lvl}`;
        const n = Number(count) || 0;
        const v = Math.round(Number(value) || 0);
        const row = merged.get(key);
        if (row) {
            row[3] += n;
            row[4] += v;
            row.partial = row.partial || partial === true;
        } else {
            merged.set(key, [kind, hrid, lvl, n, v]);
            merged.get(key).partial = partial === true;
        }
    };

    for (const item of data?.currentAssets?.inventory?.breakdown || []) {
        add('h', item.itemHrid, item.enhancementLevel, item.count || 0, item.value, item.partial);
    }
    for (const item of data?.currentAssets?.equipped?.breakdown || []) {
        add('h', item.itemHrid, item.enhancementLevel, 1, item.value, item.partial);
    }
    for (const book of data?.fixedAssets?.abilityBooks?.breakdown || []) {
        add('k', book.itemHrid, book.enhancementLevel, book.count || 1, book.value, book.partial);
    }
    for (const listing of data?.currentAssets?.listings?.breakdown || []) {
        add(
            listing.isSell ? 's' : 'b',
            listing.itemHrid,
            listing.enhancementLevel,
            listing.count ?? 1,
            listing.value,
            listing.partial
        );
    }

    const rows = [];
    for (const row of merged.values()) {
        if (row[3] <= 0 && row[4] <= 0) continue;
        let flags = 0;
        // A stack nothing priced is worth 0 here, which is not the same as worth nothing
        if (row[4] <= 0 && row[3] > 0) flags |= FLAG_UNPRICED;
        if (row.partial) flags |= FLAG_PARTIAL;
        rows.push(flags ? [...row.slice(0, 5), flags] : row.slice(0, 5));
    }
    rows.sort((a, b) => b[4] - a[4]);
    const cut = Math.max(0, rows.length - MAX_ROWS);
    return { rows: cut > 0 ? rows.slice(0, MAX_ROWS) : rows, cut };
}

/**
 * What the reading's exclusions hold back: items excluded by name (by amount, since they are not in the rows
 * but are in the total), and whether a category or asset-type exclusion hides more that cannot be attributed.
 * @param {Object} data - The calculator's result
 * @returns {{ex: Record<string, number>, exOther: boolean}} Amounts by hrid, and the unattributable flag
 */
export function exclusionsOf(data) {
    const ex = {};
    let exOther = false;
    for (const entry of data?.excluded?.items || []) {
        if (entry?.type === 'item' && entry.value)
            ex[entry.value] = (ex[entry.value] || 0) + Math.round(entry.amount || 0);
        else if (entry?.type !== 'item' && (entry?.amount || 0) !== 0) exOther = true;
    }
    return { ex, exOther };
}

/**
 * The stored record for one reading.
 * @param {Object} params - Inputs
 * @param {string} params.characterId - Whose reading
 * @param {Object} params.snapshot - The history point just taken
 * @param {Object} params.data - The calculator's result it was taken from
 * @param {{t: number, total: number}|null} params.prev - The reading before, from the index
 * @param {{pm: string, vs: string, ic: string|null}} params.context - Pricing context
 * @returns {Object} The record
 */
export function buildRecord({ characterId, snapshot, data, prev, context }) {
    const { rows, cut } = buildRows(data);
    return {
        v: 1,
        cid: characterId,
        t: snapshot.t,
        prevT: prev ? prev.t : null,
        jump: prev ? isBigJump(prev.total, snapshot.total) : false,
        total: snapshot.total,
        nonExcluded: snapshot.nonExcluded,
        house: snapshot.house,
        abilities: snapshot.abilities,
        shrines: snapshot.guildShrines ?? null,
        pm: context.pm,
        vs: context.vs,
        ic: context.ic,
        cut,
        rows,
        ...exclusionsOf(data),
    };
}

const rowKey = (row) => `${row[0]}|${row[1]}|${row[2]}`;

/**
 * Difference two records into the items that moved the total.
 *
 * Per item the change is split into a quantity part ((new count - old count) x old unit value) and a
 * price part ((new unit value - old unit value) x new count), which sum to the change exactly. A row with
 * nothing priced on either side is not split (a missing price is never a 0), and says so.
 * @param {Object} prev - The earlier record
 * @param {Object} cur - The later record
 * @param {number} [limit] - Rows to list
 * @returns {Object} `{state, totalDelta, top, rest, pricing}`; state is 'changed' or 'unchanged'
 */
export function diffRecords(prev, cur, limit = TOP_COUNT) {
    const before = new Map(prev.rows.map((row) => [rowKey(row), row]));
    const after = new Map(cur.rows.map((row) => [rowKey(row), row]));
    const keys = new Set([...before.keys(), ...after.keys()]);

    const changes = [];
    for (const key of keys) {
        const a = before.get(key) || null;
        const b = after.get(key) || null;
        const ref = b || a;
        const v0 = a ? a[4] : 0;
        const v1 = b ? b[4] : 0;
        const c0 = a ? a[3] : 0;
        const c1 = b ? b[3] : 0;
        const f0 = a ? a[5] || 0 : 0;
        const f1 = b ? b[5] || 0 : 0;
        const delta = v1 - v0;
        // Only a move in value or count is listed; a flag flip on an unchanged figure changes nothing
        if (delta === 0 && c0 === c1) continue;

        const change = {
            kind: ref[0],
            hrid: ref[1],
            level: ref[2],
            delta,
            countBefore: a ? c0 : null,
            countAfter: b ? c1 : null,
            unitBefore: a && c0 > 0 ? v0 / c0 : null,
            unitAfter: b && c1 > 0 ? v1 / c1 : null,
            unpricedBefore: (f0 & FLAG_UNPRICED) !== 0,
            unpricedAfter: (f1 & FLAG_UNPRICED) !== 0,
            partialBefore: (f0 & FLAG_PARTIAL) !== 0,
            partialAfter: (f1 & FLAG_PARTIAL) !== 0,
            quantityPart: 0,
            pricePart: 0,
            cause: 'price',
        };

        if (!a) {
            change.cause = change.unpricedAfter ? 'unpriced' : 'gained';
        } else if (!b) {
            change.cause = change.unpricedBefore ? 'unpriced' : 'lost';
        } else if (change.unpricedBefore || change.unpricedAfter) {
            change.cause = 'unpriced';
        } else if (c0 === c1 || change.unitBefore === null || change.unitAfter === null) {
            // Same count, or a side with no units to price (a listing that ended): the whole change is value
            change.cause = 'price';
            change.pricePart = delta;
        } else {
            change.quantityPart = (c1 - c0) * change.unitBefore;
            change.pricePart = delta - change.quantityPart;
            change.cause = Math.abs(change.pricePart) < ROUNDING_COINS ? 'quantity' : 'both';
            if (change.cause === 'quantity') {
                change.quantityPart = delta;
                change.pricePart = 0;
            }
        }
        changes.push(change);
    }

    changes.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    const top = changes.slice(0, limit);
    const itemsDelta = changes.reduce((sum, change) => sum + change.delta, 0);
    const listedDelta = top.reduce((sum, change) => sum + change.delta, 0);
    const totalDelta = cur.total - prev.total;

    // What is not itemized: houses, abilities and shrines, excluded items, and value rounding
    const house = (cur.house || 0) - (prev.house || 0);
    const abilities = (cur.abilities || 0) - (prev.abilities || 0);
    const shrines = cur.shrines != null && prev.shrines != null ? cur.shrines - prev.shrines : 0;
    const excluded = cur.total - cur.nonExcluded - (prev.total - prev.nonExcluded);
    const fixedDelta = house + abilities + shrines + excluded;

    return {
        state: totalDelta === 0 && changes.length === 0 ? 'unchanged' : 'changed',
        totalDelta,
        top,
        rest: {
            delta: totalDelta - listedDelta,
            otherItems: changes.length - top.length,
            otherItemsDelta: itemsDelta - listedDelta,
            fixedDelta,
            house,
            abilities,
            shrines,
            excluded,
            // Value rounding and anything the stored rows do not carry
            remainder: totalDelta - itemsDelta - fixedDelta,
        },
        pricing: {
            changed: prev.pm !== cur.pm || prev.vs !== cur.vs || (prev.ic || null) !== (cur.ic || null),
            before: { pm: prev.pm, vs: prev.vs, ic: prev.ic || null },
            after: { pm: cur.pm, vs: cur.vs, ic: cur.ic || null },
        },
        truncated: (prev.cut || 0) > 0 || (cur.cut || 0) > 0,
    };
}

class NetworthMovers {
    constructor() {
        this.characterId = null;
        /** @type {Array<{t: number, prevT: number|null, jump: boolean, total: number}>} oldest first */
        this.index = [];
        this._generation = 0;
        this.ready = false;
        /** The newest record, kept so the next reading's setting-change step can be measured against it */
        this.last = null;
    }

    _recordKey(characterId, t) {
        return `${MOVERS_PREFIX}_${characterId}_${t}`;
    }

    _indexKey(characterId) {
        return `${MOVERS_INDEX_PREFIX}_${characterId}`;
    }

    /**
     * Read this character's index and drop what disagrees with the records on disk.
     * @param {string} characterId - Whose maps
     * @returns {Promise<void>}
     */
    async load(characterId) {
        this._generation += 1;
        const generation = this._generation;
        this.characterId = characterId;
        this.index = [];
        this.ready = false;
        this.last = null;
        if (!characterId) return;
        try {
            const stored = await storage.get(this._indexKey(characterId), STORE_NAME, null);
            const prefix = `${MOVERS_PREFIX}_${characterId}_`;
            const keys = (await storage.getAllKeys(STORE_NAME)).filter(
                (key) => typeof key === 'string' && key.startsWith(prefix)
            );
            if (this._generation !== generation || this.characterId !== characterId) return;

            const onDisk = new Set(keys);
            const index = Array.isArray(stored)
                ? stored.filter(
                      (entry) =>
                          entry &&
                          Number.isFinite(entry.t) &&
                          Number.isFinite(entry.total) &&
                          onDisk.has(this._recordKey(characterId, entry.t))
                  )
                : [];

            // An index lost while its records survived is rebuilt from the records
            if (index.length === 0 && keys.length > 0) {
                const records = await storage.getMany(keys, STORE_NAME);
                if (this._generation !== generation || this.characterId !== characterId) return;
                for (const key of keys) {
                    const rec = records.get(key);
                    if (rec && Number.isFinite(rec.t) && Number.isFinite(rec.total)) {
                        index.push({ t: rec.t, prevT: rec.prevT ?? null, jump: rec.jump === true, total: rec.total });
                    }
                }
            }
            index.sort((a, b) => a.t - b.t);

            const keep = selectKept(index);
            const have = new Set(index.map((entry) => entry.t));
            const doomed = keys.filter((key) => {
                const t = Number(key.slice(prefix.length));
                return !keep.has(t) || !have.has(t);
            });
            this.index = index.filter((entry) => keep.has(entry.t));
            const newest = this.index.at(-1);
            const newestRecord = newest
                ? await storage.get(this._recordKey(characterId, newest.t), STORE_NAME, null)
                : null;
            if (this._generation !== generation || this.characterId !== characterId) return;
            this.last = newestRecord && newestRecord.cid === characterId ? newestRecord : null;
            this.ready = true;
            for (const key of doomed) storage.delete(key, STORE_NAME).catch(() => {});
        } catch (error) {
            console.error('[NetworthMovers] Loading failed:', error);
            if (this._generation === generation) {
                this.index = [];
                this.ready = true;
            }
        }
    }

    /**
     * Keep the item map of a reading just taken, and prune. Never throws and never awaits a write.
     * @param {Object} params - `{characterId, snapshot, data}`
     */
    record({ characterId, snapshot, data }) {
        try {
            if (!this.ready || !characterId || characterId !== this.characterId) return;
            if (!snapshot || !Number.isFinite(snapshot.t) || !data) return;

            const generation = this._generation;
            const prev = this.index.filter((entry) => entry.t < snapshot.t).pop() || null;
            const record = buildRecord({ characterId, snapshot, data, prev, context: currentPricingContext() });
            this.last = record;

            const index = this.index.filter((entry) => entry.t !== snapshot.t);
            index.push({ t: record.t, prevT: record.prevT, jump: record.jump, total: record.total });
            index.sort((a, b) => a.t - b.t);

            const keep = selectKept(index);
            const dropped = index.filter((entry) => !keep.has(entry.t));
            this.index = index.filter((entry) => keep.has(entry.t));

            const settle = (promise) => {
                // A write that resolves after a character switch is harmless: the key names its character
                Promise.resolve(promise).catch((error) => {
                    if (this._generation === generation) console.warn('[NetworthMovers] Write failed:', error);
                });
            };
            if (keep.has(record.t)) settle(storage.set(this._recordKey(characterId, record.t), record, STORE_NAME));
            settle(storage.set(this._indexKey(characterId), this.index, STORE_NAME));
            for (const entry of dropped) settle(storage.delete(this._recordKey(characterId, entry.t), STORE_NAME));
        } catch (error) {
            console.warn('[NetworthMovers] Recording failed:', error);
        }
    }

    /**
     * What moved at one reading, against the nearest earlier reading that has a map.
     * @param {number} t - The reading's timestamp
     * @returns {Promise<Object>} `{state, ...}`: 'no-map' (this reading has none), 'no-previous', 'unreadable',
     *   'stale' (the character changed while reading), or a diff from {@link diffRecords} with `since` and `at`
     */
    async detailFor(t) {
        const characterId = this.characterId;
        const generation = this._generation;
        const entry = this.index.find((e) => e.t === t);
        if (!characterId || !entry) return { state: 'no-map' };
        const before = this.index.filter((e) => e.t < t).pop();
        try {
            const keys = [this._recordKey(characterId, t)];
            if (before) keys.push(this._recordKey(characterId, before.t));
            const records = await storage.getMany(keys, STORE_NAME);
            if (this._generation !== generation || this.characterId !== characterId) return { state: 'stale' };
            const cur = records.get(keys[0]);
            if (!cur || cur.cid !== characterId || !Array.isArray(cur.rows)) return { state: 'no-map' };
            const prev = before ? records.get(keys[1]) : null;
            if (!prev || prev.cid !== characterId || !Array.isArray(prev.rows)) return { state: 'no-previous', at: t };
            return { ...diffRecords(prev, cur), since: prev.t, at: cur.t };
        } catch (error) {
            console.warn('[NetworthMovers] Reading failed:', error);
            return { state: 'unreadable' };
        }
    }

    /** Whether a reading has a map to show */
    hasMap(t) {
        return this.index.some((entry) => entry.t === t);
    }

    /** Forget everything held for the character being left */
    reset() {
        this._generation += 1;
        this.characterId = null;
        this.index = [];
        this.ready = false;
        this.last = null;
    }
}

const networthMovers = new NetworthMovers();

export default networthMovers;
