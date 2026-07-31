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
 * @param {Object} totals - { [key]: { attempts, clears, monsterHrid, roomLevel } }
 * @param {Object} seen - Per-room state from the last fold, keyed by coord
 * @param {Array<Object>} rooms - Output of readCombatRooms
 * @returns {{totals: Object, seen: Object, changed: boolean}} New state
 */
export function foldFloorOutcomes(totals, seen, rooms) {
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
        nextTotals[key] = {
            ...bucket,
            attempts: bucket.attempts + newEntries,
            clears: bucket.clears + newClear,
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
