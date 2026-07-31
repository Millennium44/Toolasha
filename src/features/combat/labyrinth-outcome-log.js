/**
 * Labyrinth Outcome Log
 *
 * Records how labyrinth fights actually go, so the simulated clear rates can be
 * checked against reality rather than trusted.
 *
 * The sim is a model, and a model can be wrong in ways no amount of extra
 * trials will reveal — it will happily converge to a precise wrong answer. The
 * only test is the game itself: a room says 24% and you lose it twenty-one
 * times running, which is a 1-in-350 event if the 24% is right.
 *
 * The server counts the fights for us. Every room carries `entryCount`, and a
 * cleared room carries `isCleared`, so a room you eventually beat on the fifth
 * try is one clear in five attempts. Accumulating that per monster and level
 * gives a measured rate to set beside the predicted one.
 *
 * The accumulation is pure and lives here; the storage and the display are the
 * caller's business.
 */

/**
 * Key an accumulator bucket. Level matters as much as the monster — the same
 * creature at level 200 and level 260 are different fights.
 * @param {string} monsterHrid - Monster
 * @param {number} roomLevel - Room level
 * @returns {string}
 */
export function outcomeKey(monsterHrid, roomLevel) {
    return `${monsterHrid}@${Math.max(0, Math.floor(Number(roomLevel) || 0))}`;
}

/**
 * A clear rate, or NaN when there isn't one.
 *
 * `Number(null)` is 0, and 0 is a rate a room can genuinely have — one you
 * cannot win at all. So "no prediction" has to be rejected before the coercion
 * rather than after it, or every unsimmed room would be recorded as a sim
 * claiming certain defeat.
 * @param {*} value - Raw
 * @returns {number} The rate, or NaN
 */
function rateOrNaN(value) {
    if (value === null || value === undefined || value === '') return NaN;
    return Number(value);
}

/**
 * Read the combat rooms out of a floor's grid.
 * @param {Array<Array<Object|null>>} roomData - Floor grid
 * @returns {Array<Object>} { coord, monsterHrid, roomLevel, entryCount, isCleared }
 */
export function readCombatRooms(roomData) {
    if (!Array.isArray(roomData)) return [];
    const rooms = [];
    for (let y = 0; y < roomData.length; y++) {
        const row = roomData[y];
        if (!Array.isArray(row)) continue;
        for (let x = 0; x < row.length; x++) {
            const room = row[x];
            if (!room?.monsterHrid) continue;
            rooms.push({
                coord: `${x},${y}`,
                monsterHrid: room.monsterHrid,
                roomLevel: Math.max(0, Math.floor(Number(room.recommendedLevel) || 0)),
                entryCount: Math.max(0, Math.floor(Number(room.entryCount) || 0)),
                isCleared: !!room.isCleared,
            });
        }
    }
    return rooms;
}

/**
 * Fold a floor's current state into the running totals.
 *
 * Counted as differences against what was last seen for each room, so the same
 * floor can be folded in repeatedly — `labyrinth_updated` arrives many times
 * per room — without inflating anything.
 *
 * A clear is counted once, on the transition. Attempts are counted as the
 * entry count rises. A room abandoned without a clear still contributes its
 * attempts, which is what stops the measured rate flattering itself: only
 * counting rooms you finished would drop every fight you gave up on.
 *
 * The prediction is stamped on the bucket as the fights land, not looked up
 * when the record is read. A sim result lives in a cache keyed by loadout and
 * crates and does not survive a refresh, so a record read a week later would
 * mostly say "not simmed" — which is the one thing the record exists to avoid.
 * Comparing a fight to the number that was on screen when you walked into it is
 * also the honest comparison: that is the claim the sim actually made.
 *
 * @param {Object} totals - { [key]: { attempts, clears, monsterHrid, roomLevel } }
 * @param {Object} seen - Per-room state from the last fold, keyed by coord
 * @param {Array<Object>} rooms - Output of readCombatRooms
 * @param {Function} [predictedFor] - (monsterHrid, roomLevel) => rate 0..1 or null
 * @returns {{totals: Object, seen: Object, changed: boolean}} New state
 */
export function foldFloorOutcomes(totals, seen, rooms, predictedFor) {
    const nextTotals = { ...totals };
    const nextSeen = { ...seen };
    let changed = false;

    for (const room of rooms) {
        const before = seen[room.coord];
        // A different monster on the same square means the floor moved on and
        // this is a new room that happens to share coordinates
        const continuing = before && before.monsterHrid === room.monsterHrid;
        const priorEntries = continuing ? before.entryCount : 0;
        const priorCleared = continuing ? before.isCleared : false;

        const newEntries = Math.max(0, room.entryCount - priorEntries);
        const newClear = room.isCleared && !priorCleared ? 1 : 0;
        nextSeen[room.coord] = {
            monsterHrid: room.monsterHrid,
            entryCount: room.entryCount,
            isCleared: room.isCleared,
        };
        if (newEntries === 0 && newClear === 0) continue;

        const key = outcomeKey(room.monsterHrid, room.roomLevel);
        const bucket = nextTotals[key] || {
            monsterHrid: room.monsterHrid,
            roomLevel: room.roomLevel,
            attempts: 0,
            clears: 0,
        };
        const predicted = predictedFor ? rateOrNaN(predictedFor(room.monsterHrid, room.roomLevel)) : NaN;
        nextTotals[key] = {
            ...bucket,
            attempts: bucket.attempts + newEntries,
            clears: bucket.clears + newClear,
            ...(Number.isFinite(predicted) ? { predicted } : {}),
        };
        changed = true;
    }

    return { totals: nextTotals, seen: nextSeen, changed };
}

/**
 * Compare a measured rate against a predicted one.
 *
 * "Off" means the measurement's own interval excludes the prediction — the
 * sample is saying something the model does not allow for. Small samples say
 * nothing, which is the point: twenty-one fights can condemn a 24% claim but
 * cannot condemn a 5% one.
 *
 * @param {number} clears - Fights won
 * @param {number} attempts - Fights had
 * @param {number} predicted - The simulated clear rate, 0..1
 * @param {Function} interval - wilsonInterval, injected to keep this pure
 * @returns {Object} { observed, low, high, verdict, likelihood }
 */
export function compareToPrediction(clears, attempts, predicted, interval) {
    const n = Math.max(0, Math.floor(attempts));
    const wins = Math.min(Math.max(0, Math.floor(clears)), n);
    if (n === 0) return { observed: null, verdict: 'no data' };

    const observed = wins / n;
    const { low, high } = interval(wins, n);
    const p = Math.min(1, Math.max(0, Number(predicted) || 0));

    let verdict = 'consistent';
    if (Number.isFinite(predicted)) {
        if (p < low) verdict = 'sim too low';
        else if (p > high) verdict = 'sim too high';
    }

    return { observed, low, high, verdict, likelihood: binomialTailLikelihood(wins, n, p) };
}

/**
 * The whole record, one row per monster and level, worst-sampled last.
 *
 * The prediction comes from the live sim cache when there is one and falls back
 * to whatever was stamped on the bucket when the fights happened. The live one
 * wins because it reflects the loadout you are wearing now, and a row compared
 * against a sim for gear you have since replaced is comparing to a claim nobody
 * is making any more.
 *
 * @param {Object} totals - The record
 * @param {Object} [options] - { predictedFor, interval }
 * @param {Function} [options.predictedFor] - (monsterHrid, roomLevel) => rate or null
 * @param {Function} options.interval - wilsonInterval, injected to keep this pure
 * @returns {Array<Object>} Rows, most-fought first
 */
export function accuracyRows(totals, { predictedFor, interval } = {}) {
    const rows = [];
    for (const bucket of Object.values(totals || {})) {
        const live = predictedFor ? rateOrNaN(predictedFor(bucket.monsterHrid, bucket.roomLevel)) : NaN;
        const predicted = Number.isFinite(live) ? live : rateOrNaN(bucket.predicted);
        const known = Number.isFinite(predicted);
        const verdict = compareToPrediction(bucket.clears, bucket.attempts, predicted, interval);

        rows.push({
            monsterHrid: bucket.monsterHrid,
            monster: String(bucket.monsterHrid || '')
                .split('/')
                .pop(),
            level: bucket.roomLevel,
            attempts: bucket.attempts,
            clears: bucket.clears,
            predicted: known ? predicted : null,
            fromCache: Number.isFinite(live),
            observed: verdict.observed,
            low: verdict.low,
            high: verdict.high,
            likelihood: known ? verdict.likelihood : null,
            verdict: known ? verdict.verdict : 'not simmed',
        });
    }
    rows.sort((a, b) => b.attempts - a.attempts || b.clears - a.clears);
    return rows;
}

/**
 * The record in one line: how many fights, and how many clears the sim owed you
 * against how many you got.
 *
 * Expected clears are summed only over rows that have a prediction, so the
 * comparison is like for like — folding in unsimmed rooms would credit the sim
 * with nought expected clears for fights it never made a claim about, and make
 * it look pessimistic in exactly the cases where it said nothing at all.
 *
 * @param {Array<Object>} rows - Output of accuracyRows
 * @returns {{buckets: number, attempts: number, clears: number, judged: number,
 *   expected: number|null, contested: number}}
 */
export function accuracySummary(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const judged = list.filter((row) => row.predicted !== null);

    return {
        buckets: list.length,
        attempts: list.reduce((sum, row) => sum + row.attempts, 0),
        clears: list.reduce((sum, row) => sum + row.clears, 0),
        judged: judged.reduce((sum, row) => sum + row.attempts, 0),
        judgedClears: judged.reduce((sum, row) => sum + row.clears, 0),
        expected: judged.length ? judged.reduce((sum, row) => sum + row.predicted * row.attempts, 0) : null,
        contested: list.filter((row) => row.verdict === 'sim too high' || row.verdict === 'sim too low').length,
    };
}

/**
 * How surprising this many wins would be if the prediction were right — the
 * probability of a result at least this extreme, in the direction observed.
 * @param {number} wins - Fights won
 * @param {number} n - Fights had
 * @param {number} p - Predicted rate
 * @returns {number} 0..1
 */
export function binomialTailLikelihood(wins, n, p) {
    if (n <= 0 || !(p > 0) || !(p < 1)) return 1;
    const pmf = (k) => {
        let logC = 0;
        for (let i = 1; i <= k; i++) logC += Math.log((n - k + i) / i);
        return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
    };
    const expected = n * p;
    let tail = 0;
    if (wins <= expected) {
        for (let k = 0; k <= wins; k++) tail += pmf(k);
    } else {
        for (let k = wins; k <= n; k++) tail += pmf(k);
    }
    return Math.min(1, tail);
}
