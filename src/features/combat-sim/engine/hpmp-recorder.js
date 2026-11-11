/**
 * Bounded HP/MP recording for the Combat Sim results.
 *
 * Two things come out of one sampler:
 *
 * 1. A ring of the last ~30 simulated seconds per player, taken every 0.5 s of
 *    sim time in dungeons only. A wipe copies it into its event so the card can
 *    show how the party's HP and MP ran down.
 * 2. A coarse whole-run series, a time-weighted average per bucket. Buckets start
 *    at one minute and merge pairwise whenever the run outgrows MAX_POINTS, so a
 *    ten-hour run and a ten-minute one both end up under that many points.
 *
 * The cost is one comparison per processed event, and a sample (a few reads and
 * adds per player) every 0.5 s of sim time in a dungeon, every 5 s elsewhere.
 * Everything is preallocated; nothing grows with the length of the run except
 * the run-start list, which is capped.
 */

const ONE_SECOND = 1e9;

/** Pre-wipe window length, in simulated seconds */
export const PRE_WIPE_WINDOW_SECONDS = 30;
/** Sample spacing for the pre-wipe ring (dungeons) */
export const PRE_WIPE_INTERVAL_SECONDS = 0.5;
/** Sample spacing when only the whole-run series is wanted (non-dungeon zones) */
export const RUN_ONLY_INTERVAL_SECONDS = 5;
/** Ring capacity: the window plus the forced sample taken at the wipe itself */
const RING_SIZE = Math.round(PRE_WIPE_WINDOW_SECONDS / PRE_WIPE_INTERVAL_SECONDS) + 2;
/** Most points in the whole-run series */
export const MAX_POINTS = 240;
/** First bucket width of the whole-run series, in simulated seconds */
const START_STEP_SECONDS = 60;
/** Wipe events that carry a pre-wipe sample set; the runner keeps 20 anyway */
export const MAX_WIPE_SAMPLE_SETS = 20;
/** Most dungeon run starts recorded for the whole-run chart */
export const MAX_RUN_STARTS = 240;
/** A player is "dry" below this share of their mana pool */
export const LOW_MP_FRACTION = 0.1;

/**
 * @param {number} value
 * @returns {number} Rounded to one decimal
 */
function round1(value) {
    return Math.round(value * 10) / 10;
}

export default class HpMpRecorder {
    /**
     * @param {Array<{hrid: string, combatDetails: Object}>} players - The party, in engine order
     * @param {Object} [options]
     * @param {boolean} [options.preWipe] - Keep the 30 s ring (dungeons only)
     */
    constructor(players, { preWipe = false } = {}) {
        this.players = players;
        this.count = players.length;
        this.preWipe = preWipe;
        this.intervalNs = (preWipe ? PRE_WIPE_INTERVAL_SECONDS : RUN_ONLY_INTERVAL_SECONDS) * ONE_SECOND;
        /** Sim time at which the next sample is due; the simulator compares against it */
        this.nextSampleTime = 0;
        this.wipeSetsTaken = 0;

        // Pre-wipe ring: time, then hp% and mp% per player, round-robin
        this.ringTimes = new Float64Array(RING_SIZE);
        this.ringHp = new Float32Array(RING_SIZE * this.count);
        this.ringMp = new Float32Array(RING_SIZE * this.count);
        this.ringHead = 0;
        this.ringCount = 0;

        // Whole-run series: weighted sums per bucket
        this.stepNs = START_STEP_SECONDS * ONE_SECOND;
        this.bucketWeight = new Float64Array(MAX_POINTS);
        this.bucketHp = new Float64Array(MAX_POINTS * this.count);
        this.bucketMp = new Float64Array(MAX_POINTS * this.count);
        this.lastBucket = -1;
        this.lowMpWeight = new Float64Array(this.count);
        this.totalWeight = 0;
        this.hasMp = new Array(this.count).fill(false);

        // The previous sample's values, held until the next one
        this.prevTime = null;
        this.prevHp = new Float64Array(this.count);
        this.prevMp = new Float64Array(this.count);
        this.curHp = new Float64Array(this.count);
        this.curMp = new Float64Array(this.count);

        this.runStarts = [];
    }

    /**
     * Note that a dungeon run began (the run chart marks it). Capped.
     * @param {number} timeNs
     */
    markRunStart(timeNs) {
        if (this.runStarts.length < MAX_RUN_STARTS) this.runStarts.push(round1(timeNs / ONE_SECOND));
    }

    /**
     * Read every player's HP and MP now and fold it into both records.
     * @param {number} timeNs - Simulation time in nanoseconds
     */
    sample(timeNs) {
        const n = this.count;
        for (let i = 0; i < n; i++) {
            const details = this.players[i].combatDetails;
            const maxHp = details.maxHitpoints;
            const maxMp = details.maxManapoints;
            this.curHp[i] = maxHp > 0 ? (Math.max(0, details.currentHitpoints) / maxHp) * 100 : 0;
            if (maxMp > 0) {
                this.curMp[i] = (Math.max(0, details.currentManapoints) / maxMp) * 100;
                this.hasMp[i] = true;
            } else {
                this.curMp[i] = 0;
            }
        }

        if (this.preWipe) {
            const slot = this.ringHead;
            this.ringTimes[slot] = timeNs;
            for (let i = 0; i < n; i++) {
                this.ringHp[slot * n + i] = this.curHp[i];
                this.ringMp[slot * n + i] = this.hasMp[i] ? this.curMp[i] : -1;
            }
            this.ringHead = (slot + 1) % RING_SIZE;
            if (this.ringCount < RING_SIZE) this.ringCount++;
        }

        // Whole-run: the previous sample's state held for the time since then
        if (this.prevTime !== null && timeNs > this.prevTime) {
            const weight = timeNs - this.prevTime;
            // The held value covers every bucket the interval overlaps, each for
            // its own share: charging it all to the bucket it started in hid
            // low-MP time behind a boundary and could skip the final bucket
            let t = this.prevTime;
            while (t < timeNs) {
                let bucket = Math.floor(t / this.stepNs);
                while (bucket >= MAX_POINTS) {
                    this._mergeBuckets();
                    bucket = Math.floor(t / this.stepNs);
                }
                const end = Math.min(timeNs, (bucket + 1) * this.stepNs);
                const part = end - t;
                this.bucketWeight[bucket] += part;
                for (let i = 0; i < n; i++) {
                    this.bucketHp[bucket * n + i] += this.prevHp[i] * part;
                    this.bucketMp[bucket * n + i] += this.prevMp[i] * part;
                }
                if (bucket > this.lastBucket) this.lastBucket = bucket;
                t = end;
            }
            for (let i = 0; i < n; i++) {
                if (this.hasMp[i] && this.prevMp[i] < LOW_MP_FRACTION * 100) this.lowMpWeight[i] += weight;
            }
            this.totalWeight += weight;
        }
        this.prevTime = timeNs;
        this.prevHp.set(this.curHp);
        this.prevMp.set(this.curMp);

        this.nextSampleTime = timeNs + this.intervalNs;
    }

    /** Double the bucket width by adding adjacent buckets (exact for weighted sums). */
    _mergeBuckets() {
        const n = this.count;
        const half = MAX_POINTS / 2;
        for (let b = 0; b < half; b++) {
            this.bucketWeight[b] = this.bucketWeight[2 * b] + this.bucketWeight[2 * b + 1];
            for (let i = 0; i < n; i++) {
                this.bucketHp[b * n + i] = this.bucketHp[2 * b * n + i] + this.bucketHp[(2 * b + 1) * n + i];
                this.bucketMp[b * n + i] = this.bucketMp[2 * b * n + i] + this.bucketMp[(2 * b + 1) * n + i];
            }
        }
        this.bucketWeight.fill(0, half);
        this.bucketHp.fill(0, half * n);
        this.bucketMp.fill(0, half * n);
        this.stepNs *= 2;
        this.lastBucket = Math.floor(this.lastBucket / 2);
    }

    /**
     * Forget the pre-wipe ring (a wipe restarts the run; the next wipe's window
     * must not reach back into this one).
     */
    clearPreWipe() {
        this.ringCount = 0;
        this.ringHead = 0;
    }

    /**
     * Take a final sample at the wipe and copy the last 30 s out.
     * Returns null once MAX_WIPE_SAMPLE_SETS wipes already carry one, or when not recording.
     * @param {number} timeNs - Sim time of the wipe
     * @returns {{playerHrids: string[], secondsBefore: number[], hp: Array<number[]>, mp: Array<Array<number|null>>}|null}
     */
    takePreWipe(timeNs) {
        if (!this.preWipe || this.wipeSetsTaken >= MAX_WIPE_SAMPLE_SETS) return null;
        this.sample(timeNs);
        this.wipeSetsTaken++;
        const n = this.count;
        const cutoff = timeNs - PRE_WIPE_WINDOW_SECONDS * ONE_SECOND;
        const secondsBefore = [];
        const hp = Array.from({ length: n }, () => []);
        const mp = Array.from({ length: n }, () => []);
        for (let k = 0; k < this.ringCount; k++) {
            const slot = (this.ringHead - this.ringCount + k + RING_SIZE) % RING_SIZE;
            const t = this.ringTimes[slot];
            if (t < cutoff) continue;
            secondsBefore.push(round1((timeNs - t) / ONE_SECOND));
            for (let i = 0; i < n; i++) {
                hp[i].push(round1(this.ringHp[slot * n + i]));
                const m = this.ringMp[slot * n + i];
                mp[i].push(m < 0 ? null : round1(m));
            }
        }
        return { playerHrids: this.players.map((p) => p.hrid), secondsBefore, hp, mp };
    }

    /**
     * The whole-run series for the result.
     * @param {number} timeNs - Sim time at the end of the run (one last sample is taken)
     * @returns {{playerHrids: string[], stepSeconds: number, hp: Array<number[]>, mp: Array<number[]>,
     *   hasMp: boolean[], lowMpShare: Array<number|null>, runStarts: number[]}|null} null when nothing was recorded
     */
    toSeries(timeNs) {
        this.sample(timeNs);
        if (this.lastBucket < 0) return null;
        const n = this.count;
        const points = this.lastBucket + 1;
        const hp = Array.from({ length: n }, () => []);
        const mp = Array.from({ length: n }, () => []);
        for (let b = 0; b < points; b++) {
            const w = this.bucketWeight[b];
            for (let i = 0; i < n; i++) {
                // A bucket nothing landed in (a long quiet gap) is null, not 0
                hp[i].push(w > 0 ? round1(this.bucketHp[b * n + i] / w) : null);
                mp[i].push(w > 0 ? round1(this.bucketMp[b * n + i] / w) : null);
            }
        }
        return {
            playerHrids: this.players.map((p) => p.hrid),
            stepSeconds: this.stepNs / ONE_SECOND,
            hp,
            mp,
            hasMp: [...this.hasMp],
            lowMpShare: Array.from(this.lowMpWeight, (w, i) =>
                this.hasMp[i] && this.totalWeight > 0 ? w / this.totalWeight : null
            ),
            runStarts: this.runStarts,
        };
    }
}
