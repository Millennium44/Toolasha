/**
 * Spawn Census
 *
 * A long-running tally of which monsters a combat wave actually contains.
 *
 * The combat simulator predicts dungeon clears several percent long, and the
 * largest identified cause is the wave-draw rule: `combat-sim/engine/zone.js`
 * reads a dungeon's `randomSpawnInfoMap` keys as exclusive ranges and draws the
 * whole wave from the single highest key reached, and 138 recorded waves of
 * Chimerical Den say that is nearly but not quite what the game does — about one
 * wave in seven is a well-formed draw from a strictly *lower* table, which the
 * current reading gives probability zero. Settling that needs many more waves
 * than 138, from more zones and more tiers.
 *
 * Diagnosing it so far has meant full tick recordings: megabytes for half an
 * hour, capped by a timer, and overwhelmingly not about spawns at all. This
 * keeps the spawn signal and nothing else, cheaply enough to leave running for
 * weeks.
 *
 * ## Counts, not a timeline
 *
 * The question is "how often does each roster occur", so the multiset of rosters
 * with their frequencies is a sufficient statistic and a timeline is not needed
 * for anything. Two waves with the same monsters at the same wave number are
 * interchangeable, so the second one costs a counter increment rather than a new
 * record, and the roster list is **sorted** so that the same monsters drawn in a
 * different order collapse onto the same row too.
 *
 * Storage then grows with the number of *distinct* rosters rather than with
 * playtime — which is the whole point, and also, honestly, does not flatten as
 * fast as one would like: see {@link MAX_ROSTER_ROWS}.
 *
 * ## What is kept beside the rosters
 *
 * - **Wave duration**, as count / sum / sum-of-squares of the milliseconds from
 *   one wave's announcement to the next, per (zone, tier, wave). Three numbers
 *   give a mean and a standard error without storing a timestamp per wave. This
 *   span **includes the respawn gap** — it is announcement to announcement, not
 *   first hit to last death — and the export says so.
 * - **Observed max hitpoints** per (zone, tier, monster), one row per species
 *   per tier, overwritten. So a later analysis need not re-derive tier scaling
 *   to check a roster's total strength against the game's cap.
 *
 * Nothing here records a character, a name, a party, or anything that came off
 * an account. A row is a zone, a tier, a wave number and a list of monsters.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { runningCombatAction } from '../../utils/combat-actions.js';

/** Object store and key. Account-wide on purpose — see below. */
const STORE = 'combatExport';
const RECORD_KEY = 'spawnCensus';

/**
 * The census is stored once for the whole account, not per character.
 *
 * A wave's roster is a property of the game's draw code, not of whoever was
 * standing in front of it. Partitioning per character would split one sample
 * into several smaller ones and make every one of them slower to converge, for
 * no question anybody is asking. (Contrast the dungeon tracker, whose runs are
 * per-character achievements and are stamped as such.)
 */
const RECORD_VERSION = 1;

/**
 * How many distinct roster rows the store will hold.
 *
 * ### Why it is a cap and not a saturation point
 *
 * The pleasant story about aggregation is that distinct rosters run out. They do
 * not, quickly, at this key. Take Chimerical Den's key-0 table: 13 species,
 * `maxSpawnCount` 4, strengths 40-65 against a 250 budget, so most waves are
 * four monsters. Four-species multisets from thirteen is C(16,4) = 1820, and
 * with the shorter waves about 2400 rosters are reachable — for **one** wave
 * number. Fifty wave numbers per difficulty tier, and the upper tables are
 * wider (16-17 species, 5 slots) rather than narrower.
 *
 * Against that, two weeks of heavy play is perhaps 1300 clears, 65,000 waves,
 * of which maybe 30,000 are distinct. So the row count is set by memory, not by
 * the combinatorics running out, and this number is chosen to bound the file:
 *
 * A row's key is `<zone>|<tier>|<wave>|<four short monster names>`, around 55
 * characters, and its value serializes as `[count, firstSeen, lastSeen]` with
 * second-resolution timestamps, around 30 more. Call it 100 bytes of JSON per
 * row with the punctuation. 10,000 rows is therefore about 1 MB — a large
 * record by this database's standards but a small one in absolute terms, read
 * once at startup and written every {@link FLUSH_MS}.
 *
 * ### What eviction costs
 *
 * Least-recently-seen. Evicting by recency rather than by count is deliberate:
 * dropping the rare rosters would bias exactly the tail the wave-draw question
 * lives in. Dropping the oldest instead is equivalent to shortening the
 * observation window — it discards early evidence uniformly across rosters,
 * which is a shorter sample and not a skewed one. The export carries
 * `evicted` and `retainedFrom` so an analyst can see the window they actually
 * have rather than assuming it starts at `startedAt`.
 */
export const MAX_ROSTER_ROWS = 10000;

/**
 * How much of the store eviction clears at once, as a fraction of the cap.
 *
 * Evicting a single row per overflow would sort ten thousand rows on every wave
 * once the cap is reached. Taking a slab means the sort happens once per
 * thousand new rosters instead.
 */
const EVICT_FRACTION = 0.1;

/**
 * How often the in-memory tally is written out.
 *
 * Waves arrive every few seconds and the record is a megabyte; writing on every
 * wave would serialize it thousands of times an hour. Thirty seconds bounds the
 * loss from a hard crash to a handful of waves, which for a sample measured in
 * tens of thousands is nothing.
 */
export const FLUSH_MS = 30_000;

/**
 * Longest announcement-to-announcement span still treated as one wave's
 * duration. Beyond this the player stopped, went offline, or the tab slept, and
 * the span measures none of the things the aggregate is for.
 */
export const MAX_WAVE_SPAN_MS = 10 * 60_000;

/** The wave field for a zone that has no waves. Waves are 1-based, so this cannot collide. */
export const NO_WAVE = '-';

/** The last path segment of an hrid — `/monsters/rat` becomes `rat`. */
export function shortHrid(hrid) {
    const text = String(hrid ?? '');
    return text.slice(text.lastIndexOf('/') + 1);
}

/**
 * The monsters of a `new_battle` payload, players excluded.
 *
 * The payload's units arrive as an array (`monsters`) or as a keyed map
 * (`mMap`) depending on the message shape, and full unit snapshots have carried
 * hitpoints both at the top level and inside `combatDetails` across payload
 * versions — so both are read, exactly as `zone-uptime-harness` and
 * `combat-replay-check` do.
 *
 * @param {Object} payload - A `new_battle` message
 * @returns {Array<{hrid: string, maxHitpoints: number|null}>} Monsters, in payload order
 */
export function monstersOf(payload) {
    const units = payload?.monsters ?? payload?.mMap ?? {};
    const list = Array.isArray(units) ? units : Object.values(units);
    const monsters = [];
    for (const unit of list) {
        if (!unit || unit.isPlayer) continue;
        const hrid = unit.hrid ?? unit.combatMonsterHrid;
        if (!hrid) continue;
        const maxHp = Number(unit.combatDetails?.maxHitpoints ?? unit.maxHitpoints ?? unit.mHP);
        monsters.push({ hrid, maxHitpoints: Number.isFinite(maxHp) && maxHp > 0 ? maxHp : null });
    }
    return monsters;
}

/**
 * The identity of a roster observation.
 *
 * Sorted, so that the same monsters in a different order are one row, and
 * short-named, because the full hrids repeat the same two prefixes in every one
 * of ten thousand keys. The prefixes are kept losslessly in the record's `hrids`
 * dictionary rather than assumed, so the export can restore full hrids exactly.
 *
 * @param {string} zoneHrid - The combat action hrid
 * @param {number} difficultyTier - The zone's difficulty tier
 * @param {number|string} wave - The server's 1-based wave, or {@link NO_WAVE}
 * @param {Array<string>} monsterHrids - The wave's monsters, any order
 * @returns {string} `zone|tier|wave|a,b,c`
 */
export function rosterKey(zoneHrid, difficultyTier, wave, monsterHrids) {
    const names = (monsterHrids || []).map(shortHrid).sort();
    return `${shortHrid(zoneHrid)}|${difficultyTier}|${wave}|${names.join(',')}`;
}

/** The (zone, tier, wave) key the duration aggregate is filed under. */
export function waveKey(zoneHrid, difficultyTier, wave) {
    return `${shortHrid(zoneHrid)}|${difficultyTier}|${wave}`;
}

/**
 * Mean and standard error from the three running numbers.
 *
 * The variance is the population form corrected to the sample form (`n-1`),
 * computed from the sums rather than from stored samples: with one wave in
 * every few seconds for weeks, keeping the samples is the thing this module
 * exists not to do. `sd` and `stderr` are null below two observations, where
 * neither is defined.
 *
 * @param {{n: number, sum: number, sumSq: number}} aggregate
 * @returns {{n: number, meanMs: number|null, sdMs: number|null, stderrMs: number|null}}
 */
export function durationStats(aggregate) {
    const n = aggregate?.n || 0;
    if (n <= 0) return { n: 0, meanMs: null, sdMs: null, stderrMs: null };
    const mean = aggregate.sum / n;
    if (n < 2) return { n, meanMs: mean, sdMs: null, stderrMs: null };
    // Clamped at zero: floating-point cancellation can make this a very small
    // negative when every observation is identical.
    const variance = Math.max(0, (aggregate.sumSq - (aggregate.sum * aggregate.sum) / n) / (n - 1));
    const sd = Math.sqrt(variance);
    return { n, meanMs: mean, sdMs: sd, stderrMs: sd / Math.sqrt(n) };
}

class SpawnCensus {
    constructor() {
        this.initialized = false;
        this.newBattleHandler = null;
        this.timers = createTimerRegistry();
        this._reset();
    }

    _reset() {
        /** @type {Map<string, {n: number, first: number, last: number}>} */
        this.rosters = new Map();
        /** @type {Map<string, {n: number, sum: number, sumSq: number}>} */
        this.durations = new Map();
        /** @type {Map<string, number>} */
        this.monsterHp = new Map();
        /** Short name → full hrid, so the export restores exact hrids. */
        this.hrids = new Map();
        this.startedAt = null;
        this.evicted = 0;
        this.retainedFrom = null;
        this.waves = 0;
        this.dirty = false;
        /** The wave still waiting for the next announcement to close its duration. */
        this.openWave = null;
    }

    async initialize() {
        if (this.initialized) return;
        if (!config.getSetting('spawnCensus')) return;

        this.initialized = true;
        this.newBattleHandler = (data) => this._onNewBattle(data);
        webSocketHook.on('new_battle', this.newBattleHandler);
        this.timers.registerInterval(setInterval(() => this.flush(), FLUSH_MS));

        await this.load();
    }

    /** Read whatever previous sessions recorded, and carry on from it. */
    async load() {
        try {
            const record = await storage.getJSON(RECORD_KEY, STORE, null);
            this.hydrate(record);
        } catch (error) {
            console.error('[SpawnCensus] Could not read the stored census:', error);
        }
    }

    /**
     * Fold a stored record into memory.
     *
     * Separate from {@link load} so it is testable without a database, and
     * additive rather than replacing: a record read after some waves were
     * already counted (a slow startup read landing mid-fight) must not throw
     * those waves away.
     *
     * @param {Object|null} record - A previously serialized census
     */
    hydrate(record) {
        if (!record || record.version !== RECORD_VERSION) return;
        for (const [key, row] of Object.entries(record.rosters || {})) {
            const [n, first, last] = Array.isArray(row) ? row : [];
            if (!n) continue;
            const existing = this.rosters.get(key);
            if (existing) {
                existing.n += n;
                existing.first = Math.min(existing.first, first * 1000);
                existing.last = Math.max(existing.last, last * 1000);
            } else {
                this.rosters.set(key, { n, first: first * 1000, last: last * 1000 });
            }
        }
        for (const [key, row] of Object.entries(record.durations || {})) {
            const [n, sum, sumSq] = Array.isArray(row) ? row : [];
            if (!n) continue;
            const existing = this.durations.get(key) || { n: 0, sum: 0, sumSq: 0 };
            existing.n += n;
            existing.sum += sum;
            existing.sumSq += sumSq;
            this.durations.set(key, existing);
        }
        for (const [key, hp] of Object.entries(record.monsterHp || {})) {
            this.monsterHp.set(key, hp);
        }
        for (const [short, full] of Object.entries(record.hrids || {})) {
            this.hrids.set(short, full);
        }
        this.startedAt = Math.min(this.startedAt ?? Infinity, record.startedAt ?? Infinity);
        if (!Number.isFinite(this.startedAt)) this.startedAt = null;
        this.evicted += record.evicted || 0;
        this.waves += record.waves || 0;
        if (record.retainedFrom) {
            this.retainedFrom = Math.max(this.retainedFrom ?? 0, record.retainedFrom);
        }
    }

    /**
     * Count one wave.
     *
     * @param {Object} data - A `new_battle` message
     */
    _onNewBattle(data) {
        try {
            const action = runningCombatAction(dataManager.getCurrentActions());
            if (!action?.actionHrid) return;

            const zoneHrid = action.actionHrid;
            const tier = action.difficultyTier || 0;
            const isDungeon = dataManager.getActionDetails(zoneHrid)?.combatZoneInfo?.isDungeon === true;
            const wave = isDungeon ? (data?.wave ?? NO_WAVE) : NO_WAVE;

            const monsters = monstersOf(data);
            const now = Date.now();

            // The duration of the wave *before* this one: this announcement is
            // the instant it ended. Only closed when the previous wave was the
            // same zone and tier — a zone change, a relog, or a long idle is
            // not a wave that took an hour.
            this._closeOpenWave(zoneHrid, tier, now);
            this.openWave = monsters.length ? { zoneHrid, tier, wave, at: now } : null;

            if (!monsters.length) return;

            this.startedAt ??= now;
            this.waves++;

            const key = rosterKey(
                zoneHrid,
                tier,
                wave,
                monsters.map((monster) => monster.hrid)
            );
            const row = this.rosters.get(key);
            if (row) {
                row.n++;
                row.last = now;
            } else {
                this.rosters.set(key, { n: 1, first: now, last: now });
                if (this.rosters.size > MAX_ROSTER_ROWS) this._evict();
            }

            this.hrids.set(shortHrid(zoneHrid), zoneHrid);
            for (const monster of monsters) {
                const short = shortHrid(monster.hrid);
                this.hrids.set(short, monster.hrid);
                if (monster.maxHitpoints !== null) {
                    this.monsterHp.set(`${shortHrid(zoneHrid)}|${tier}|${short}`, monster.maxHitpoints);
                }
            }

            this.dirty = true;
        } catch (error) {
            console.error('[SpawnCensus] Counting a wave failed:', error);
        }
    }

    /**
     * Fold the open wave's announcement-to-announcement span into its aggregate.
     * @param {string} zoneHrid - The zone announcing now
     * @param {number} tier - Its difficulty tier
     * @param {number} now - This announcement's timestamp
     */
    _closeOpenWave(zoneHrid, tier, now) {
        const open = this.openWave;
        this.openWave = null;
        if (!open) return;
        if (open.zoneHrid !== zoneHrid || open.tier !== tier) return;
        const span = now - open.at;
        if (!(span > 0) || span > MAX_WAVE_SPAN_MS) return;

        const key = waveKey(open.zoneHrid, open.tier, open.wave);
        const aggregate = this.durations.get(key) || { n: 0, sum: 0, sumSq: 0 };
        aggregate.n++;
        aggregate.sum += span;
        aggregate.sumSq += span * span;
        this.durations.set(key, aggregate);
        this.dirty = true;
    }

    /** Drop the least recently seen slab of rows. See {@link MAX_ROSTER_ROWS}. */
    _evict() {
        const drop = Math.max(1, Math.round(MAX_ROSTER_ROWS * EVICT_FRACTION));
        const byAge = [...this.rosters.entries()].sort((a, b) => a[1].last - b[1].last);
        for (let i = 0; i < drop && i < byAge.length; i++) {
            this.rosters.delete(byAge[i][0]);
            this.evicted++;
        }
        // What the retained sample now starts at, which is not `startedAt` any
        // more and which the export has to say out loud.
        let earliest = null;
        for (const row of this.rosters.values()) {
            if (earliest === null || row.first < earliest) earliest = row.first;
        }
        this.retainedFrom = earliest;
    }

    /**
     * The record as it goes to storage: compact arrays, second-resolution
     * timestamps. Both choices are about the megabyte, not about precision —
     * nothing here asks when a roster was seen to better than a second.
     * @returns {Object} The serializable census
     */
    serialize() {
        const rosters = {};
        for (const [key, row] of this.rosters) {
            rosters[key] = [row.n, Math.round(row.first / 1000), Math.round(row.last / 1000)];
        }
        const durations = {};
        for (const [key, aggregate] of this.durations) {
            durations[key] = [aggregate.n, Math.round(aggregate.sum), Math.round(aggregate.sumSq)];
        }
        return {
            version: RECORD_VERSION,
            startedAt: this.startedAt,
            updatedAt: Date.now(),
            waves: this.waves,
            evicted: this.evicted,
            retainedFrom: this.retainedFrom,
            rosters,
            durations,
            monsterHp: Object.fromEntries(this.monsterHp),
            hrids: Object.fromEntries(this.hrids),
        };
    }

    /** Write the tally out, if anything changed since the last write. */
    async flush() {
        if (!this.dirty) return false;
        this.dirty = false;
        try {
            await storage.setJSON(RECORD_KEY, this.serialize(), STORE, true);
            return true;
        } catch (error) {
            // Left dirty so the next flush tries again rather than losing it.
            this.dirty = true;
            console.error('[SpawnCensus] Writing the census failed:', error);
            return false;
        }
    }

    /**
     * The spawn tables in force for the zones the census has seen, straight from
     * live game data.
     *
     * Without these the counts are uninterpretable later: the question is which
     * table a wave drew from, and the tables themselves are patched from time to
     * time. Missing game data is reported as an empty map rather than guessed.
     *
     * @returns {Object} zone hrid → `{isDungeon, maxWaves, fixedSpawnsMap, randomSpawnInfoMap, randomSpawnInfo}`
     */
    spawnTables() {
        const tables = {};
        for (const key of this.rosters.keys()) {
            const zoneShort = key.slice(0, key.indexOf('|'));
            const zoneHrid = this.hrids.get(zoneShort);
            if (!zoneHrid || tables[zoneHrid]) continue;
            const zone = dataManager.getActionDetails?.(zoneHrid)?.combatZoneInfo;
            if (!zone) continue;
            tables[zoneHrid] = {
                isDungeon: zone.isDungeon === true,
                maxWaves: zone.dungeonInfo?.maxWaves ?? null,
                fixedSpawnsMap: zone.dungeonInfo?.fixedSpawnsMap ?? null,
                randomSpawnInfoMap: zone.dungeonInfo?.randomSpawnInfoMap ?? null,
                randomSpawnInfo: zone.fightInfo?.randomSpawnInfo ?? null,
            };
        }
        return tables;
    }

    /**
     * The census in the shape an analysis wants: full hrids, one object per
     * row, the tables beside the counts, and the duration convention stated
     * rather than implied.
     * @returns {Object} The export file
     */
    exportFile() {
        const expand = (short) => this.hrids.get(short) ?? short;
        const rosters = [];
        for (const [key, row] of this.rosters) {
            const [zone, tier, wave, monsters] = key.split('|');
            rosters.push({
                zoneHrid: expand(zone),
                difficultyTier: Number(tier),
                wave: wave === NO_WAVE ? null : Number(wave),
                monsterHrids: monsters ? monsters.split(',').map(expand) : [],
                count: row.n,
                firstSeen: row.first,
                lastSeen: row.last,
            });
        }
        rosters.sort((a, b) => b.count - a.count);

        const durations = [];
        for (const [key, aggregate] of this.durations) {
            const [zone, tier, wave] = key.split('|');
            durations.push({
                zoneHrid: expand(zone),
                difficultyTier: Number(tier),
                wave: wave === NO_WAVE ? null : Number(wave),
                ...durationStats(aggregate),
            });
        }

        const monsterHitpoints = [];
        for (const [key, hp] of this.monsterHp) {
            const [zone, tier, monster] = key.split('|');
            monsterHitpoints.push({
                zoneHrid: expand(zone),
                difficultyTier: Number(tier),
                monsterHrid: expand(monster),
                maxHitpoints: hp,
            });
        }

        return {
            type: 'toolasha-spawn-census',
            version: RECORD_VERSION,
            exportedAt: Date.now(),
            startedAt: this.startedAt,
            // The retained sample may start later than the census did, if the
            // row cap has evicted anything. Both are stated; neither is implied.
            retainedFrom: this.retainedFrom,
            wavesSeen: this.waves,
            distinctRosters: this.rosters.size,
            rowCap: MAX_ROSTER_ROWS,
            evictedRows: this.evicted,
            conventions: {
                roster: 'monsterHrids is sorted, so draw order is not recorded; identical rosters at the same (zone, tier, wave) are one row with a count.',
                wave: "The server's own 1-based wave number for dungeons; null for zones that have no waves.",
                duration:
                    "meanMs/sdMs/stderrMs describe the span from one wave's new_battle announcement to the next one's. This INCLUDES the respawn gap between the last monster dying and the next wave appearing — it is not fight length. Spans longer than 10 minutes are discarded as idle rather than counted.",
                eviction: `Least-recently-seen rows are dropped past ${MAX_ROSTER_ROWS} distinct rosters; evictedRows says how many, and retainedFrom is the earliest firstSeen still held.`,
            },
            spawnTables: this.spawnTables(),
            rosters,
            durations,
            monsterHitpoints,
        };
    }

    /** Write the export out as a file, the way the other combat exports do. */
    downloadExport() {
        if (!this.rosters.size) return false;
        const blob = new Blob([JSON.stringify(this.exportFile())], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `toolasha-spawn-census-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        return true;
    }

    /**
     * A console-sized readout: how much has been counted, and per (zone, tier)
     * how many waves and distinct rosters, with the duration mean.
     * @returns {{wavesSeen: number, distinctRosters: number, evictedRows: number, zones: Array<Object>}}
     */
    summary() {
        const zones = new Map();
        for (const [key, row] of this.rosters) {
            const [zone, tier] = key.split('|');
            const id = `${zone}|${tier}`;
            const entry = zones.get(id) || {
                zone: this.hrids.get(zone) ?? zone,
                tier: Number(tier),
                waves: 0,
                rosters: 0,
            };
            entry.waves += row.n;
            entry.rosters++;
            zones.set(id, entry);
        }
        for (const [key, aggregate] of this.durations) {
            const [zone, tier] = key.split('|');
            const entry = zones.get(`${zone}|${tier}`);
            if (!entry) continue;
            entry._n = (entry._n || 0) + aggregate.n;
            entry._sum = (entry._sum || 0) + aggregate.sum;
        }
        return {
            wavesSeen: this.waves,
            distinctRosters: this.rosters.size,
            evictedRows: this.evicted,
            startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
            zones: [...zones.values()]
                .map((entry) => ({
                    zone: entry.zone,
                    tier: entry.tier,
                    waves: entry.waves,
                    distinctRosters: entry.rosters,
                    meanWaveMs: entry._n ? Math.round(entry._sum / entry._n) : null,
                }))
                .sort((a, b) => b.waves - a.waves),
        };
    }

    /** Forget everything, on disk as well as in memory. */
    async clear() {
        this._reset();
        try {
            await storage.delete(RECORD_KEY, STORE);
        } catch (error) {
            console.error('[SpawnCensus] Clearing the census failed:', error);
        }
    }

    disable() {
        // Timers first and unconditionally: a later step throwing must not
        // leave a flush interval running against a feature marked disabled.
        this.timers.clearAll();
        try {
            if (this.newBattleHandler) {
                webSocketHook.off('new_battle', this.newBattleHandler);
                this.newBattleHandler = null;
            }
            // Whatever the last thirty seconds counted would otherwise be lost.
            const written = this.flush();
            this.openWave = null;
            return written;
        } catch (error) {
            console.error('[SpawnCensus] Disable failed part-way:', error);
            return Promise.resolve(false);
        } finally {
            this.initialized = false;
        }
    }
}

const spawnCensus = new SpawnCensus();

export default spawnCensus;
