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
 * Key an accumulator bucket. Level matters as much as what is in the room — the
 * same creature at level 200 and level 260 are different fights, and the same
 * skill at two levels is two different rooms.
 * @param {string} subjectHrid - Monster or skill
 * @param {number} roomLevel - Room level
 * @returns {string}
 */
export function outcomeKey(subjectHrid, roomLevel) {
    return `${subjectHrid}@${Math.max(0, Math.floor(Number(roomLevel) || 0))}`;
}

/**
 * What a bucket is about. Older records only ever held fights and named the
 * field `monsterHrid`; reading through both keeps them working rather than
 * throwing away a record to rename a key.
 * @param {Object} bucket - Accumulator bucket
 * @returns {string}
 */
export function bucketSubject(bucket) {
    return bucket?.subjectHrid || bucket?.monsterHrid || '';
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
 * Read every room out of a floor's grid.
 *
 * Deliberately not just the combat rooms. **Clearing a room strips it**: the
 * server stops sending its monster, its skill and its type, leaving a cell that
 * says only `isCleared`. Scanning for `monsterHrid` therefore sees a room for
 * every attempt you lose and never once for the attempt you win, which counts
 * every defeat and no victory at all — a record that can only ever say the sim
 * is too optimistic.
 *
 * So every cell comes back, and working out which of the stripped ones used to
 * be a fight is the fold's job, since only it remembers what was there before.
 *
 * @param {Array<Array<Object|null>>} roomData - Floor grid
 * @returns {Array<Object>} { coord, monsterHrid, skillHrid, roomLevel, entryCount, isCleared }
 */
export function readFloorRooms(roomData) {
    if (!Array.isArray(roomData)) return [];
    const rooms = [];
    for (let y = 0; y < roomData.length; y++) {
        const row = roomData[y];
        if (!Array.isArray(row)) continue;
        for (let x = 0; x < row.length; x++) {
            const room = row[x];
            if (!room) continue;
            rooms.push({
                coord: `${x},${y}`,
                monsterHrid: room.monsterHrid || '',
                skillHrid: room.skillHrid || '',
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
 * Because a cleared room is stripped of its contents, the monster credited with
 * a clear is the one last seen on that square rather than the one the room
 * still names — a cleared room names nothing. That memory is scoped to a run
 * and floor: coordinates repeat on every floor, and without the scope the first
 * update after descending would credit a fresh floor's already-cleared square
 * to whatever the last floor had standing in the same spot.
 *
 * The prediction is stamped on the bucket as the fights land, not looked up
 * when the record is read. A sim result lives in a cache keyed by loadout and
 * crates and does not survive a refresh, so a record read a week later would
 * mostly say "not simmed" — which is the one thing the record exists to avoid.
 * Comparing a fight to the number that was on screen when you walked into it is
 * also the honest comparison: that is the claim the sim actually made.
 *
 * Skilling and enhancing rooms are counted exactly like fights. A skilling room
 * is failed by running out of the two minutes rather than by dying, but it is
 * still a room the calculator gave a chance of clearing and still a room you
 * either cleared or did not, so the same entry counting answers the same
 * question about it.
 *
 * @param {Object} totals - { [key]: { attempts, clears, subjectHrid, roomLevel } }
 * @param {Object} seen - Per-room state from the last fold, keyed by coord
 * @param {Array<Object>} rooms - Output of readFloorRooms
 * @param {Object} [options] - { scope, predictedFor }
 * @param {string} [options.scope] - Run-and-floor identity of this grid
 * @param {Function} [options.predictedFor] - (subjectHrid, roomLevel, kind) => rate or null
 * @returns {{totals: Object, seen: Object, changed: boolean, seenChanged: boolean}} New state
 */
export function foldFloorOutcomes(totals, seen, rooms, options = {}) {
    const { scope = '', predictedFor } = options;
    const nextTotals = { ...totals };
    // Rebuilt from this grid rather than merged into the old one, so descending
    // a floor drops the previous floor's squares instead of accumulating a map
    // of every room of the whole run
    const nextSeen = {};
    let changed = false;
    // Reported separately because the room state has to be saved even when no
    // fight was counted — it is the only thing stopping the next session
    // counting every room's whole entry history over again
    let seenChanged = Object.keys(seen || {}).length !== rooms.length;

    for (const room of rooms) {
        const before = seen?.[room.coord];
        // The same square on the same floor of the same run. A room that still
        // names a monster must name the same one; a stripped room names none,
        // and the scope is what stops that matching anything at all.
        const roomSubject = room.monsterHrid || room.skillHrid || '';
        const continuing =
            !!before &&
            before.scope === scope &&
            (!roomSubject || !before.subjectHrid || before.subjectHrid === roomSubject);

        const subjectHrid = roomSubject || (continuing ? before.subjectHrid : '');
        const kind = room.monsterHrid ? 'combat' : room.skillHrid ? 'skilling' : continuing ? before.kind : '';
        const roomLevel = room.roomLevel || (continuing ? before.roomLevel : 0);
        const priorEntries = continuing ? before.entryCount : 0;
        const priorCleared = continuing ? before.isCleared : false;

        const next = {
            scope,
            subjectHrid,
            kind,
            roomLevel,
            // A stripped room reports no entries. Keeping the count we had stops
            // the next fold reading that drop to zero as a fresh run of attempts
            entryCount: Math.max(room.entryCount, priorEntries),
            isCleared: room.isCleared || priorCleared,
        };
        nextSeen[room.coord] = next;
        if (
            !before ||
            before.scope !== next.scope ||
            before.subjectHrid !== next.subjectHrid ||
            before.entryCount !== next.entryCount ||
            before.isCleared !== next.isCleared
        ) {
            seenChanged = true;
        }
        if (!subjectHrid) continue;

        const newEntries = Math.max(0, room.entryCount - priorEntries);
        const newClear = room.isCleared && !priorCleared ? 1 : 0;
        if (newEntries === 0 && newClear === 0) continue;

        const key = outcomeKey(subjectHrid, roomLevel);
        const bucket = nextTotals[key] || { subjectHrid, kind, roomLevel, attempts: 0, clears: 0 };
        const predicted = predictedFor ? rateOrNaN(predictedFor(subjectHrid, roomLevel, kind)) : NaN;
        const clears = bucket.clears + newClear;
        nextTotals[key] = {
            ...bucket,
            subjectHrid,
            kind: kind || bucket.kind || '',
            // A room won on the first try can clear before any update showed it
            // being entered, and a clear that outran its own attempt would give
            // a rate above 100%. The victory was an attempt whether or not the
            // entry count was ever seen to rise.
            attempts: Math.max(bucket.attempts + newEntries, clears),
            clears,
            ...(Number.isFinite(predicted) ? { predicted } : {}),
        };
        changed = true;
    }

    return { totals: nextTotals, seen: nextSeen, changed, seenChanged };
}

/**
 * Fold one finished room into the record.
 *
 * The floor's entry counts answer "did it clear", which is all a fight will
 * tell you. A skilling room says far more: the server states the success and
 * double chance it is using, and then plays out every action, so three numbers
 * can be set beside each other — what Toolasha's formula predicted, what the
 * server says the rate is, and what actually happened. The first two
 * disagreeing is a bug in the formula and needs no statistics at all; the last
 * two disagreeing needs a sample.
 *
 * Time and experience are folded in the same pass because they are only
 * knowable per finished room: the floor never says how long anything took.
 *
 * Rooms you gave up on are folded in too, for their time. A labyrinth room pays
 * only when it is completed, so an abandoned one is time spent for nothing —
 * and leaving it out would quietly raise the measured experience per hour every
 * time you walked away from a room, which is precisely backwards. Its duration
 * is kept apart from the cleared rooms' so it cannot distort what a room takes
 * to finish, which is a different question.
 *
 * @param {Object} totals - The record
 * @param {Object} result - { subjectHrid, roomLevel, kind, cleared, seconds, xp,
 *   actions, successes, doubles, predictedSeconds, predictedSuccess,
 *   predictedDouble, serverSuccess, serverDouble }
 * @returns {Object} New totals
 */
export function foldRoomResult(totals, result) {
    const subjectHrid = result?.subjectHrid;
    if (!subjectHrid) return totals || {};

    const roomLevel = Math.max(0, Math.floor(Number(result.roomLevel) || 0));
    const key = outcomeKey(subjectHrid, roomLevel);
    const bucket = (totals || {})[key] || { subjectHrid, kind: result.kind || '', roomLevel, attempts: 0, clears: 0 };
    const add = (field, value) => (bucket[field] || 0) + Math.max(0, Number(value) || 0);

    // Each room's own rate, kept as a running sum and sum of squares so a mean
    // and a spread can be recovered without storing every room.
    //
    // Pooling every action across every room is what the per-action figures used
    // to do, and a skilling room ends the moment you clear it — so a lucky room
    // contributes ten actions and an unlucky one contributes the full two
    // minutes of them. The pool is then mostly made of unlucky rooms and reads
    // several points below the rate the server states, for no reason but the
    // stopping rule.
    //
    // Doubles are counted against *successes*, because that is what they roll
    // on. Against all actions they read about a quarter of the stated rate,
    // which looked like the loudest fault in the record and was only ever a
    // denominator.
    const actions = Math.max(0, Number(result.actions) || 0);
    const successes = Math.max(0, Number(result.successes) || 0);
    const doubles = Math.max(0, Number(result.doubles) || 0);
    const ratios = {};
    if (actions > 0) {
        const rate = successes / actions;
        ratios.successRatioSum = add('successRatioSum', rate);
        ratios.successRatioSquares = add('successRatioSquares', rate * rate);
        ratios.successRatioRooms = add('successRatioRooms', 1);
    }
    if (successes > 0) {
        const rate = doubles / successes;
        ratios.doubleRatioSum = add('doubleRatioSum', rate);
        ratios.doubleRatioSquares = add('doubleRatioSquares', rate * rate);
        ratios.doubleRatioRooms = add('doubleRatioRooms', 1);
    }

    // Predictions are last-write-wins rather than averaged. They are what the
    // calculator says for the gear you have on now, and averaging today's
    // prediction with one made for gear you have since replaced produces a
    // number nothing ever claimed.
    const stamp = {};
    for (const field of ['predictedSeconds', 'predictedSuccess', 'predictedDouble', 'serverSuccess', 'serverDouble']) {
        const value = rateOrNaN(result[field]);
        if (Number.isFinite(value)) stamp[field] = value;
    }

    return {
        ...totals,
        [key]: {
            ...bucket,
            subjectHrid,
            kind: result.kind || bucket.kind || '',
            roomLevel,
            rooms: add('rooms', 1),
            seconds: add('seconds', result.seconds),
            clearedRooms: add('clearedRooms', result.cleared ? 1 : 0),
            clearedSeconds: add('clearedSeconds', result.cleared ? result.seconds : 0),
            xp: add('xp', result.xp),
            actions: add('actions', result.actions),
            successes: add('successes', result.successes),
            doubles: add('doubles', result.doubles),
            ...ratios,
            ...stamp,
        },
    };
}

/**
 * What one bucket's finished rooms measured, or null where nothing was.
 * @param {Object} bucket - Accumulator bucket
 * @returns {Object|null} { rooms, secondsPerRoom, xpPerHour, success, double, actions }
 */
export function roomMeasurements(bucket) {
    const rooms = Math.max(0, Math.floor(Number(bucket?.rooms) || 0));
    if (!rooms) return null;

    const seconds = Math.max(0, Number(bucket.seconds) || 0);
    const actions = Math.max(0, Math.floor(Number(bucket.actions) || 0));
    const xp = Math.max(0, Number(bucket.xp) || 0);
    // Older records predate the split and counted only completed rooms
    const clearedRooms = Math.max(0, Math.floor(Number(bucket.clearedRooms ?? rooms) || 0));
    const clearedSeconds = Math.max(0, Number(bucket.clearedSeconds ?? seconds) || 0);

    return {
        rooms,
        clearedRooms,
        actions,
        seconds,
        // How long the room takes to finish — a question only the rooms you
        // finished can answer
        secondsPerRoom: clearedRooms > 0 && clearedSeconds > 0 ? clearedSeconds / clearedRooms : null,
        // How long a clear costs: every second spent in the room, whether the
        // visit ended in a clear or not, divided by the clears it bought. This
        // is the figure the calculator's `expectedSeconds` is, and it is the one
        // that can be compared with it — see `roomTiming`.
        secondsPerClear: clearedRooms > 0 && seconds > 0 ? seconds / clearedRooms : null,
        // Measured throughput: real experience over all the time it cost,
        // including the attempts that paid nothing
        xpPerHour: seconds > 0 && xp > 0 ? (xp / seconds) * 3600 : null,
        successCount: Math.max(0, Math.floor(Number(bucket.successes) || 0)),
        success: actions > 0 ? (Number(bucket.successes) || 0) / actions : null,
        // Against successes, which is what a double rolls on. Against every
        // action it read about a quarter of the stated rate — a denominator
        // rather than a fault.
        double:
            Number(bucket.successes) > 0 ? (Number(bucket.doubles) || 0) / Math.max(1, Number(bucket.successes)) : null,
        perRoom: {
            success: roomMean(bucket, 'successRatio', actions),
            double: roomMean(bucket, 'doubleRatio', Math.max(0, Math.floor(Number(bucket.successes) || 0))),
        },
    };
}

/**
 * The mean of one rate across rooms, with the spread of that mean.
 *
 * A room is the unit that was actually sampled. The actions inside it are not
 * independent of how it went — a skilling room ends the moment you clear it, so
 * a lucky room contributes few actions and an unlucky one contributes the full
 * budget of them, and pooling actions therefore weights the unlucky rooms
 * heavily enough to drag the figure several points below the truth.
 *
 * The interval is the standard error of the mean rather than a Wilson interval,
 * because what is being averaged is a set of rates and not a set of coin flips.
 * One room can produce a mean but not a spread, so it gets no interval — which
 * is right: one room says nothing about how much rooms vary.
 *
 * @param {Object} bucket - Accumulator bucket
 * @param {string} prefix - `successRatio` or `doubleRatio`
 * @param {number} trials - Underlying draws, for the floor on the interval
 * @returns {{rate: number, rooms: number, low: number, high: number}|null}
 */
function roomMean(bucket, prefix, trials) {
    const rooms = Math.max(0, Math.floor(Number(bucket?.[`${prefix}Rooms`]) || 0));
    // Records predate this and hold no per-room sums; there is nothing to
    // recover them from, so the caller falls back to the pooled figure
    if (!rooms) return null;

    const sum = Number(bucket[`${prefix}Sum`]) || 0;
    const squares = Number(bucket[`${prefix}Squares`]) || 0;
    const rate = sum / rooms;

    if (rooms < 2) return { rate, rooms, low: null, high: null };

    // Sample variance from the running sums, floored at zero against the
    // rounding that the subtraction can produce when every room agreed
    const variance = Math.max(0, (squares - rooms * rate * rate) / (rooms - 1));
    const between = Math.sqrt(variance / rooms);

    // Rooms that happen to agree exactly give a variance of zero, and a
    // zero-width interval would call any difference at all a contradiction —
    // six rooms that each went 4-for-22 do not pin the rate to nine decimal
    // places. The floor is the ordinary binomial error over the same draws, so
    // the interval can never be narrower than the sample itself allows.
    const within = trials > 0 ? Math.sqrt((rate * (1 - rate)) / trials) : Infinity;
    const margin = 1.96 * Math.max(between, within);
    return { rate, rooms, low: Math.max(0, rate - margin), high: Math.min(1, rate + margin) };
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
        const subjectHrid = bucketSubject(bucket);
        const live = predictedFor ? rateOrNaN(predictedFor(subjectHrid, bucket.roomLevel, bucket.kind)) : NaN;
        const predicted = Number.isFinite(live) ? live : rateOrNaN(bucket.predicted);
        const known = Number.isFinite(predicted);
        const verdict = compareToPrediction(bucket.clears, bucket.attempts, predicted, interval);
        const measured = roomMeasurements(bucket);

        rows.push({
            subjectHrid,
            kind: bucket.kind || (subjectHrid.startsWith('/skills/') ? 'skilling' : 'combat'),
            monster: subjectHrid.split('/').pop(),
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
            measured,
            timing: roomTiming(bucket, measured),
            rates: actionRates(bucket, measured, interval),
        });
    }
    rows.sort((a, b) => b.attempts - a.attempts || b.clears - a.clears);
    return rows;
}

/**
 * How long the calculator said a clear costs, against how long one cost.
 *
 * The prediction is `expectedSeconds`, and what that means is the whole of this
 * function. It is **time per clear including the attempts you lose** — for a
 * fight, the average fight length divided by the win rate; for a skilling room,
 * the expected time of an attempt divided by the clear chance. A room you clear
 * one time in five is predicted to cost roughly five attempts' worth of
 * seconds, not one.
 *
 * It used to be compared against the mean duration of the visits that ended in
 * a clear, which is a different quantity in two compounding ways. It threw away
 * every second spent on visits that ended in defeat — the exact term the
 * prediction is mostly made of — and then it selected on the outcome, keeping
 * the visits that happened to go well. The two errors do not cancel; they point
 * opposite ways depending on how the room went, which is why the same record
 * showed first-try clears finishing in a third of the predicted time and
 * multi-attempt rooms taking three times it.
 *
 * The comparable measurement is every second spent in the room, whatever came
 * of the visit, divided by the clears those seconds bought. Nothing is
 * conditioned on and nothing is discarded, so it estimates the same ratio the
 * prediction is: total time ÷ total clears.
 *
 * A room never cleared has no figure — the cost of a clear you have not had is
 * not zero and not the time you wasted, it is unknown — and the prediction for
 * such a room is infinite anyway.
 *
 * @param {Object} bucket - Accumulator bucket
 * @param {Object} measured - From `roomMeasurements`
 * @returns {Object|null}
 */
function roomTiming(bucket, measured) {
    const predicted = rateOrNaN(bucket.predictedSeconds);
    if (!measured?.secondsPerClear || !Number.isFinite(predicted) || predicted <= 0) return null;

    const actual = measured.secondsPerClear;
    return {
        predicted,
        actual,
        ratio: actual / predicted,
        // What the figure is made of, because a ratio from two clears is a
        // different claim from one built out of forty
        clears: measured.clearedRooms,
        visits: measured.rooms,
        seconds: measured.seconds,
        // The old reading, kept so the two can be seen apart. Where they differ
        // a lot, the room is one you have been losing.
        perFinishedVisit: measured.secondsPerRoom,
    };
}

/**
 * Per-action success and double: what the calculator predicted, what the server
 * says it is using, and what the actions actually did.
 *
 * The server's own figure is the sharpest test in the whole record. It arrives
 * with every action, it needs no sample at all, and if the calculator disagrees
 * with it the formula is simply wrong — no amount of play will make a wrong
 * formula right, and no amount will reveal it either unless the two are set
 * side by side.
 */
function actionRates(bucket, measured, interval) {
    if (!measured?.actions) return null;

    const out = {};
    for (const [name, field, pooledRate, trials] of [
        ['success', 'Success', measured.success, measured.actions],
        ['double', 'Double', measured.double, measured.successCount],
    ]) {
        const predicted = rateOrNaN(bucket[`predicted${field}`]);
        const server = rateOrNaN(bucket[`server${field}`]);
        const perRoom = measured.perRoom?.[name] || null;

        // The per-room mean is the reading, and the pooled one is the fallback
        // for records written before rooms were measured separately. Where both
        // exist the pooled figure is still carried, because the gap between them
        // is itself the size of the stopping-rule bias.
        const observed = perRoom ? perRoom.rate : pooledRate;
        const pooledCheck = compareToPrediction(Math.round(pooledRate * trials), trials, server, interval);
        const low = perRoom ? perRoom.low : pooledCheck.low;
        const high = perRoom ? perRoom.high : pooledCheck.high;

        let verdict = 'consistent';
        if (!Number.isFinite(server)) verdict = 'no server rate';
        else if (low === null || high === null) verdict = 'too few rooms';
        else if (server < low) verdict = 'sim too low';
        else if (server > high) verdict = 'sim too high';

        out[name] = {
            predicted: Number.isFinite(predicted) ? predicted : null,
            server: Number.isFinite(server) ? server : null,
            observed,
            pooled: pooledRate,
            rooms: perRoom ? perRoom.rooms : 0,
            trials,
            low,
            high,
            verdict,
            // A formula that disagrees with the rate the server states is wrong
            // outright, which is a different and much louder problem than a run
            // of bad luck
            formulaOff:
                Number.isFinite(predicted) && Number.isFinite(server) ? Math.abs(predicted - server) > 0.005 : false,
        };
    }
    return out;
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
 * The record pooled by what is in the room, across every level of it.
 *
 * A per-level row is the honest unit — Crafting at 190 and Crafting at 202 are
 * different fights — but it is also a small sample, and small samples say
 * nothing. Twenty rooms of Crafting spread over six levels can be twenty rooms
 * of "consistent" while the sim is quietly ten points high on every one of
 * them, because no single level ever gathers enough fights to prove it.
 *
 * Pooling asks the other question: over everything you have ever done in a
 * Crafting room, did the sim's claims add up? The prediction is the
 * attempt-weighted average of the per-level ones, which is what "expected
 * clears ÷ attempts" means, so the comparison stays like for like.
 *
 * @param {Array<Object>} rows - Output of `accuracyRows`
 * @param {Function} interval - wilsonInterval, injected to keep this pure
 * @returns {Array<Object>} One per subject, most-fought first
 */
export function accuracyBySubject(rows, interval) {
    const groups = new Map();

    for (const row of Array.isArray(rows) ? rows : []) {
        if (!groups.has(row.subjectHrid)) {
            groups.set(row.subjectHrid, {
                subjectHrid: row.subjectHrid,
                kind: row.kind,
                monster: row.monster,
                levels: 0,
                attempts: 0,
                clears: 0,
                // Only the rows with a prediction, so the comparison is like for
                // like — folding in unsimmed rooms would credit the sim with no
                // expected clears for fights it made no claim about
                judged: 0,
                judgedClears: 0,
                expected: 0,
                lowestLevel: row.level,
                highestLevel: row.level,
            });
        }

        const group = groups.get(row.subjectHrid);
        group.levels += 1;
        group.attempts += row.attempts;
        group.clears += row.clears;
        group.lowestLevel = Math.min(group.lowestLevel, row.level);
        group.highestLevel = Math.max(group.highestLevel, row.level);

        if (row.predicted !== null) {
            group.judged += row.attempts;
            group.judgedClears += row.clears;
            group.expected += row.predicted * row.attempts;
        }
    }

    const out = [...groups.values()].map((group) => {
        const predicted = group.judged > 0 ? group.expected / group.judged : null;
        const check =
            group.judged > 0
                ? compareToPrediction(group.judgedClears, group.judged, predicted, interval)
                : { observed: null, verdict: 'not simmed' };

        return {
            ...group,
            predicted,
            observed: check.observed,
            low: check.low,
            high: check.high,
            verdict: group.judged > 0 ? check.verdict : 'not simmed',
            likelihood: group.judged > 0 ? check.likelihood : null,
            // What the pooled record says the sim owes you, in clears. The sign
            // is the thing to read: consistently negative across levels is a
            // model that is too optimistic about this room, whatever any one
            // level's interval allows for.
            offBy: group.judged > 0 ? group.judgedClears - group.expected : null,
        };
    });

    out.sort((a, b) => b.attempts - a.attempts || b.clears - a.clears);
    return out;
}

/**
 * The whole record as text, for pasting somewhere it can be looked at.
 *
 * Plain text rather than JSON: the point of handing this over is that a person
 * reads it, and a wall of braces is a worse answer to "does anything look off"
 * than a table is. Everything needed to check the arithmetic is in it — the
 * counts, not just the rates.
 *
 * @param {Object} snapshot - `{rows, summary, bySubject}`
 * @param {Object} [options] - `{ name }` for what to call each subject
 * @returns {string}
 */
export function accuracyReport({ rows = [], summary = {}, bySubject = [] } = {}, { name } = {}) {
    const label = name || ((hrid) => hrid.split('/').pop());
    const pct = (value, places = 1) => (Number.isFinite(value) ? `${(value * 100).toFixed(places)}%` : '—');
    const out = [];

    out.push('Toolasha — labyrinth sim accuracy');
    out.push(`${summary.attempts ?? 0} fights over ${summary.buckets ?? 0} room/level buckets`);
    if (summary.expected === null || summary.expected === undefined) {
        out.push('No simulated rates to compare against yet.');
    } else {
        const off = (summary.judgedClears ?? 0) - summary.expected;
        out.push(
            `Judged: ${summary.judged} fights, expected ${summary.expected.toFixed(1)} clears, ` +
                `got ${summary.judgedClears} (${off >= 0 ? '+' : ''}${off.toFixed(1)})`
        );
    }
    out.push(`Rooms the record contradicts: ${summary.contested ?? 0}`);

    out.push('');
    out.push('BY ROOM TYPE (pooled across levels)');
    out.push('subject\tkind\tlevels\tattempts\tclears\texpected\toff by\tsim\tactual\t95% band\tverdict');
    for (const group of bySubject) {
        out.push(
            [
                label(group.subjectHrid),
                group.kind,
                `${group.levels} (${group.lowestLevel}-${group.highestLevel})`,
                group.attempts,
                group.clears,
                group.judged > 0 ? group.expected.toFixed(1) : '—',
                group.offBy === null ? '—' : `${group.offBy >= 0 ? '+' : ''}${group.offBy.toFixed(1)}`,
                pct(group.predicted),
                pct(group.observed),
                group.judged > 0 ? `${pct(group.low)}-${pct(group.high)}` : '—',
                group.verdict,
            ].join('\t')
        );
    }

    out.push('');
    out.push('BY ROOM AND LEVEL');
    out.push('Seconds are per clear and include the attempts you lose, on both sides — that is');
    out.push('what the calculator predicts, so it is what the measurement has to be.');
    out.push(
        'subject\tlevel\tattempts\tclears\tsim\tactual\t95% band\tverdict\tlikelihood\t' +
            'sim secs/clear\treal secs/clear\tsecs in a winning visit'
    );
    for (const row of rows) {
        out.push(
            [
                label(row.subjectHrid),
                row.level,
                row.attempts,
                row.clears,
                pct(row.predicted),
                pct(row.observed),
                `${pct(row.low)}-${pct(row.high)}`,
                row.verdict,
                row.likelihood === null ? '—' : row.likelihood.toFixed(4),
                row.timing ? row.timing.predicted.toFixed(0) : '—',
                row.timing ? row.timing.actual.toFixed(0) : '—',
                row.timing?.perFinishedVisit ? row.timing.perFinishedVisit.toFixed(0) : '—',
            ].join('\t')
        );
    }

    // The per-action rates are the sharpest test in the record — the server
    // states its own figure, so a calculator that disagrees is wrong outright
    // rather than unlucky — and they are worth their own table for it
    const withRates = rows.filter((row) => row.rates);
    if (withRates.length) {
        out.push('');
        out.push('PER-ACTION RATES (calc vs server vs observed)');
        out.push('Success is the mean across rooms, not pooled over actions: a room ends when you');
        out.push('clear it, so pooling weights the rooms that went badly. Doubles are counted');
        out.push('against successes, which is what they roll on. "pooled" is the old reading.');
        out.push(
            'subject\tlevel\trooms\tactions\tsuccesses\t' +
                'success calc\tsuccess server\tsuccess seen\tsuccess pooled\tsuccess verdict\t' +
                'double calc\tdouble server\tdouble seen\tdouble pooled\tdouble verdict\tformula off'
        );
        for (const row of withRates) {
            const { success, double } = row.rates;
            out.push(
                [
                    label(row.subjectHrid),
                    row.level,
                    success.rooms || '—',
                    row.measured?.actions ?? 0,
                    row.measured?.successCount ?? 0,
                    pct(success.predicted),
                    pct(success.server),
                    pct(success.observed),
                    pct(success.pooled),
                    success.verdict,
                    pct(double.predicted),
                    pct(double.server),
                    pct(double.observed),
                    pct(double.pooled),
                    double.verdict,
                    success.formulaOff || double.formulaOff ? 'YES' : '',
                ].join('\t')
            );
        }
    }

    return out.join('\n');
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
