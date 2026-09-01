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
 *
 * ## Cohorts, and what a bucket can and cannot be split by
 *
 * A bucket is a running sum, not a list of fights, so it can only be split
 * along a boundary it was told about while it was accumulating. Two such
 * boundaries exist. The sim model is one — `fullKit*` counts only what was
 * folded under the full-ability sim. The build fingerprint is the other:
 * `cohortFingerprintVersion` records which fingerprint definition the current
 * `fullKit*` sums were built under, and when that definition changes the sums
 * are retired rather than added to, because a counter accumulated against a
 * fingerprint that could not see combat levels is a counter over a character
 * the current one no longer describes.
 *
 * Retired, not deleted: `legacyCohortJudged` keeps the count, so the panel says
 * how much history the migration set aside instead of appearing to lose it.
 * The raw `attempts`/`clears` are untouched by any of this — they are the
 * server's own count of what happened in a room and belong to no cohort.
 */

import { FINGERPRINT_VERSION } from './labyrinth-fingerprint.js';

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
 * A bucket with its full-kit cohort retired when the fingerprint definition it
 * accumulated under is no longer the current one.
 *
 * The cohort is a set of running sums — judged fights, expected clears, their
 * variance — accumulated against the predictions in effect at the time. Those
 * predictions were made for a character the old fingerprint described and the
 * new one does not: v1 hashed gear alone, so folds from either side of a combat
 * level-up went into the same sums as though nothing had changed. There is no
 * way to unpick which fold belongs to which side, so the whole cohort is
 * retired and a fresh one starts. Averaging across the boundary is the one
 * outcome not on offer.
 *
 * `legacyCohortJudged` accumulates what has been retired, so the count is
 * reported rather than lost. `attempts` and `clears` are the server's own count
 * of what happened in the room and belong to no cohort — they are never touched
 * here, which is why the record's raw win rates survive a migration intact.
 *
 * A bucket written before the field existed carries no version and is treated
 * as v1, which is what it is: folded under the gear-only fingerprint.
 *
 * @param {Object} bucket - An accumulator bucket
 * @param {number} [version=FINGERPRINT_VERSION] - The definition in force
 * @returns {Object} The bucket unchanged, or a copy with the cohort rotated
 */
export function rotateCohortForFingerprint(bucket, version = FINGERPRINT_VERSION) {
    const stamped = bucket?.cohortFingerprintVersion;
    const was = Number.isInteger(stamped) && stamped > 0 ? stamped : 1;
    if (was === version) return bucket;

    const judged = Math.max(0, Number(bucket?.fullKitJudged) || 0);
    const expected = Math.max(0, Number(bucket?.fullKitExpected) || 0);
    // Nothing accumulated under the old definition, so only the stamp moves.
    // The counters are left absent rather than written as zeros: absent is how
    // a bucket that never had a cohort has always read, and writing zeros would
    // make a room never simmed indistinguishable from one whose cohort was
    // retired — and would put four new fields on every bucket in the record.
    if (judged <= 0 && expected <= 0) return { ...bucket, cohortFingerprintVersion: version };

    return {
        ...bucket,
        cohortFingerprintVersion: version,
        legacyCohortJudged: (Number(bucket?.legacyCohortJudged) || 0) + judged,
        fullKitJudged: 0,
        fullKitJudgedClears: 0,
        fullKitExpected: 0,
        fullKitVariance: 0,
    };
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
        // A clear only counts for a room you actually entered. A revealed tile
        // can be cleared without a fight — a shroud, a beacon, a floor skip — and
        // the server marks it `isCleared` with `entryCount` still zero; counting
        // that booked a 1/1 at levels far above anything you could clear and
        // dragged the whole record toward "sim too low". A genuine first-try win
        // has its entry counted in the same update, so `room.entryCount` is
        // already at least one there. (The same guard the best-level tracker
        // applies in labyrinth-tracker.js.)
        const entered = room.entryCount > 0 || priorEntries > 0;
        const newClear = room.isCleared && !priorCleared && entered ? 1 : 0;
        if (newEntries === 0 && newClear === 0) continue;

        const key = outcomeKey(subjectHrid, roomLevel);
        const bucket = rotateCohortForFingerprint(
            nextTotals[key] || { subjectHrid, kind, roomLevel, attempts: 0, clears: 0 }
        );
        const predicted = predictedFor ? rateOrNaN(predictedFor(subjectHrid, roomLevel, kind)) : NaN;
        const clears = bucket.clears + newClear;
        // The full-kit cohort: attempts folded with a prediction in effect at
        // fold time, under the current (full-ability) sim model. Expected clears
        // and their variance accumulate per fold at that moment's rate, so the
        // headline judges each fight against the claim actually on screen —
        // never against one recomputed later by a newer engine. Buckets written
        // before these counters existed carry none and read as the legacy
        // cohort, which the headline excludes rather than deletes.
        //
        // Judged moves in lockstep with `attempts` below — the SAME delta, not
        // `max(newEntries, newClear)`. An entry and its clear usually arrive in
        // separate floor updates, so the old max counted every such clear as a
        // second judged attempt and banked a second expected clear for it;
        // a real record read "expected 3296 over 3927" against 2601 actual
        // fights and called itself 109 sd below the sim (2026-08-29).
        const nextAttempts = Math.max(bucket.attempts + newEntries, clears);
        const counted = nextAttempts - bucket.attempts;
        const priorJudged = Number(bucket.fullKitJudged) || 0;
        const cohort = Number.isFinite(predicted)
            ? {
                  fullKitJudged: priorJudged + counted,
                  // A clear whose attempt never entered the cohort (folded
                  // before these counters, or without a prediction) does not
                  // get its clear judged either — clears can never outnumber
                  // the attempts they are judged against
                  fullKitJudgedClears: Math.min(
                      (Number(bucket.fullKitJudgedClears) || 0) + newClear,
                      priorJudged + counted
                  ),
                  fullKitExpected: (Number(bucket.fullKitExpected) || 0) + predicted * counted,
                  fullKitVariance: (Number(bucket.fullKitVariance) || 0) + predicted * (1 - predicted) * counted,
              }
            : {};
        nextTotals[key] = {
            ...bucket,
            subjectHrid,
            kind: kind || bucket.kind || '',
            // A room won on the first try can clear before any update showed it
            // being entered, and a clear that outran its own attempt would give
            // a rate above 100%. The victory was an attempt whether or not the
            // entry count was ever seen to rise.
            attempts: nextAttempts,
            clears,
            ...(Number.isFinite(predicted) ? { predicted } : {}),
            ...cohort,
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
    for (const field of [
        'predictedSeconds',
        'predictedFightSeconds',
        'predictedSuccess',
        'predictedDouble',
        'serverSuccess',
        'serverDouble',
    ]) {
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
            fights: add('fights', result.fights),
            fightSeconds: add('fightSeconds', result.fightSeconds),
            fightSquares: add('fightSquares', result.fightSquares),
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
 * @param {Object} [options] - { predictedFor, interval, orderOf }
 * @param {Function} [options.predictedFor] - (monsterHrid, roomLevel) => rate or null
 * @param {Function} options.interval - wilsonInterval, injected to keep this pure
 * @param {Function} [options.orderOf] - (subjectHrid) => sort key, so the list can
 *   follow the game's own order rather than the size of the sample
 * @returns {Array<Object>} Rows, in the game's order when one is given and
 *   most-fought first otherwise
 */
/**
 * A bucket's full-kit cohort, with the double-count already on disk undone.
 *
 * Counters written before the lockstep fix judged most clears twice — once at
 * the entry that raised the count, once at the clear that flipped in a later
 * update — so a stored `fullKitJudged` can exceed the bucket's own attempts,
 * and `fullKitExpected` carries an extra predicted clear for each. Judged can
 * never truly exceed attempts, so the overrun IS the double-count: judged is
 * clamped to attempts and expected/variance are scaled down with it. The scale
 * assumes the doubled folds accrued at roughly the bucket's own rate — exact
 * for a bucket whose prediction held still, approximate where it drifted, and
 * either is far nearer the truth than a headline 109 sd below the sim
 * (2026-08-29). New folds count in lockstep and pass through untouched.
 *
 * @param {Object} bucket - A stored outcome bucket
 * @returns {{judged: number, clears: number, expected: number, variance: number}}
 */
function repairedCohort(bucket) {
    const judged = Math.max(0, Number(bucket.fullKitJudged) || 0);
    const clears = Math.max(0, Number(bucket.fullKitJudgedClears) || 0);
    const expected = Math.max(0, Number(bucket.fullKitExpected) || 0);
    const variance = Math.max(0, Number(bucket.fullKitVariance) || 0);
    const attempts = Math.max(0, Number(bucket.attempts) || 0);
    if (judged <= attempts || judged <= 0) {
        return { judged, clears: Math.min(clears, judged), expected, variance };
    }
    const scale = attempts / judged;
    return {
        judged: attempts,
        clears: Math.min(clears, attempts),
        expected: expected * scale,
        variance: variance * scale,
    };
}

export function accuracyRows(totals, { predictedFor, interval, orderOf } = {}) {
    const rows = [];
    for (const bucket of Object.values(totals || {})) {
        const subjectHrid = bucketSubject(bucket);
        // The cohort as the current fingerprint definition sees it — see the
        // `cohort` field below for why the read path rotates too
        const current = rotateCohortForFingerprint(bucket);
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
            fightLength: fightLength(bucket),
            rates: actionRates(bucket, measured, interval),
            // The full-kit cohort's share of this bucket, with expected clears
            // summed at the prediction in effect when each fight was folded. A
            // bucket predating the counters reads all zeros — the legacy cohort.
            //
            // Rotated on the way out as well as on the way in: a room not
            // fought since the fingerprint changed has never been through the
            // fold, so its stored cohort is still the old definition's, and
            // reading it here would put pre-migration sums into a current-
            // version headline. Rotation is idempotent, so a bucket the fold
            // already rotated passes straight through.
            cohort: repairedCohort(current),
            // How many judged fights the fingerprint migration set aside for
            // this room — reported so a thinned cohort is explained rather than
            // looking like history that vanished
            legacyCohortJudged: Math.max(0, Number(current.legacyCohortJudged) || 0),
        });
    }
    // The game's order, and within a room type by level, so a subject's rooms
    // read as a progression rather than being scattered through the list by how
    // often each happened to be fought
    if (orderOf) {
        rows.sort(
            (a, b) =>
                compareOrder(orderOf(a.subjectHrid), orderOf(b.subjectHrid)) ||
                a.level - b.level ||
                a.subjectHrid.localeCompare(b.subjectHrid)
        );
    } else {
        rows.sort((a, b) => b.attempts - a.attempts || b.clears - a.clears);
    }
    return rows;
}

/**
 * Compare two order keys, whatever the game gave us.
 *
 * `sortIndex` is a number when the client data has one and a name when it does
 * not, and a room type the data has never heard of has neither — those go last
 * rather than to the top, which is where an undefined would otherwise sort.
 *
 * @param {number|string|null} a - Order key
 * @param {number|string|null} b - Order key
 * @returns {number}
 */
function compareOrder(a, b) {
    const missing = (value) => value === null || value === undefined;
    if (missing(a) && missing(b)) return 0;
    if (missing(a)) return 1;
    if (missing(b)) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
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
 * How long a fight ran, against how long the sim thought it would.
 *
 * The sharpest thing a combat room can say. Its clear rate needs hundreds of
 * fights before an interval closes far enough to contradict anything, and a
 * room gives you ten — but every attempt has a duration, win or lose, and the
 * sim predicts one. A model that has the fight itself wrong shows up here in a
 * handful of attempts.
 *
 * Nothing is conditioned on: `avgFightSeconds` is the mean over every simulated
 * fight including the losses, and this is the mean over every attempt including
 * the losses. The spread is the sample's own, so two fights make a reading and
 * not a verdict.
 *
 * @param {Object} bucket - Accumulator bucket
 * @returns {Object|null}
 */
function fightLength(bucket) {
    const predicted = rateOrNaN(bucket?.predictedFightSeconds);
    const fights = Math.max(0, Math.floor(Number(bucket?.fights) || 0));
    const total = Math.max(0, Number(bucket?.fightSeconds) || 0);
    if (!fights || !total || !Number.isFinite(predicted) || predicted <= 0) return null;

    const actual = total / fights;
    const squares = Math.max(0, Number(bucket.fightSquares) || 0);
    const variance = fights > 1 ? Math.max(0, (squares - fights * actual * actual) / (fights - 1)) : 0;
    const margin = fights > 1 ? 1.96 * Math.sqrt(variance / fights) : null;

    const low = margin === null ? null : Math.max(0, actual - margin);
    const high = margin === null ? null : actual + margin;

    let verdict = 'consistent';
    if (low === null) verdict = 'too few fights';
    else if (predicted < low) verdict = 'sim too fast';
    else if (predicted > high) verdict = 'sim too slow';

    return { predicted, actual, fights, low, high, verdict, ratio: actual / predicted };
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
        // Both shapes of "no reading" have to be caught. A per-room mean too
        // thin to band stores null; `compareToPrediction` given no trials at all
        // returns before it computes an interval, so its bounds come back
        // undefined — and `undefined === null` is false, while `server < undefined`
        // and `server > undefined` are both false, so a strict null test let a
        // row that measured nothing fall through and print as agreeing with the
        // server. That is exactly a double rate on a room with actions but no
        // successes: no trials, no interval, and nothing to be consistent with.
        if (!Number.isFinite(server)) verdict = 'no server rate';
        else if (!Number.isFinite(low) || !Number.isFinite(high)) verdict = 'too few rooms';
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
 * The `cohort` block is the same comparison restricted to the full-kit cohort —
 * fights folded with a prediction in effect at fold time, under the current sim
 * model — which is what the headline shows by default. Fights judged only by a
 * later or legacy prediction are counted in `cohort.legacyExcluded` instead of
 * being pooled: those predictions came from a different model and pooling them
 * would test a claim nothing ever made.
 *
 * @param {Array<Object>} rows - Output of accuracyRows
 * @param {Function} [interval] - wilsonInterval, for the chance-level figures
 * @returns {{buckets: number, attempts: number, clears: number, judged: number,
 *   expected: number|null, sd: number|null, sigma: number|null,
 *   contested: number, contestedByChance: number|null,
 *   cohort: {judged: number, judgedClears: number, expected: number|null,
 *   sd: number|null, sigma: number|null, legacyExcluded: number}}}
 */
export function accuracySummary(rows, interval) {
    const list = Array.isArray(rows) ? rows : [];
    const judged = list.filter((row) => row.predicted !== null);

    const expected = judged.length ? judged.reduce((sum, row) => sum + row.predicted * row.attempts, 0) : null;
    const judgedClears = judged.reduce((sum, row) => sum + row.clears, 0);
    const judgedAttempts = judged.reduce((sum, row) => sum + row.attempts, 0);

    // How far the total is allowed to wander if every prediction is right. Most
    // rooms are near-certain and contribute almost nothing, so nearly all of it
    // comes from the handful that are genuinely uncertain — which is why "ten
    // clears below" can be a shrug or a finding and the figure alone cannot say
    // which.
    const variance = judged.reduce((sum, row) => sum + row.attempts * row.predicted * (1 - row.predicted), 0);
    const sd = judged.length && variance > 0 ? Math.sqrt(variance) : null;

    const cohortJudged = list.reduce((sum, row) => sum + (row.cohort?.judged || 0), 0);
    const cohortClears = list.reduce((sum, row) => sum + (row.cohort?.clears || 0), 0);
    const cohortExpected = list.reduce((sum, row) => sum + (row.cohort?.expected || 0), 0);
    const cohortVariance = list.reduce((sum, row) => sum + (row.cohort?.variance || 0), 0);
    const cohortSd = cohortVariance > 0 ? Math.sqrt(cohortVariance) : null;

    return {
        buckets: list.length,
        attempts: list.reduce((sum, row) => sum + row.attempts, 0),
        clears: list.reduce((sum, row) => sum + row.clears, 0),
        judged: judgedAttempts,
        judgedClears,
        expected,
        sd,
        sigma: sd && expected !== null ? (judgedClears - expected) / sd : null,
        contested: list.filter((row) => row.verdict === 'sim too high' || row.verdict === 'sim too low').length,
        contestedByChance: interval ? judged.reduce((sum, row) => sum + flagChance(row, interval), 0) : null,
        cohort: {
            judged: cohortJudged,
            judgedClears: cohortClears,
            expected: cohortJudged > 0 ? cohortExpected : null,
            sd: cohortSd,
            sigma: cohortSd ? (cohortClears - cohortExpected) / cohortSd : null,
            legacyExcluded: Math.max(0, judgedAttempts - cohortJudged),
        },
    };
}

/**
 * The chance this room would be flagged even though its prediction is right.
 *
 * A 95% interval is wrong one time in twenty by construction, so a record of two
 * hundred rooms is *expected* to contradict a handful of them and a raw count of
 * contradictions says nothing on its own. This is what that count has to be read
 * against.
 *
 * Computed rather than assumed at one in twenty, because most rooms cannot be
 * flagged at all: a room entered twice has an interval so wide that no
 * prediction falls outside it, and counting it as a test would overstate the
 * chance level several times over. Summed across rooms it gives the number of
 * false alarms to expect from this particular record.
 *
 * @param {Object} row - A row from `accuracyRows`
 * @param {Function} interval - wilsonInterval
 * @returns {number} 0..1
 */
function flagChance(row, interval) {
    const n = Math.max(0, Math.floor(row.attempts));
    const p = Math.min(1, Math.max(0, row.predicted));
    if (!n || !(p > 0) || !(p < 1)) return 0;

    let chance = 0;
    let pmf = (1 - p) ** n;
    for (let k = 0; k <= n; k++) {
        const { low, high } = interval(k, n);
        if (p < low || p > high) chance += pmf;
        // Step the binomial rather than recomputing the coefficient each time
        pmf *= ((n - k) / (k + 1)) * (p / (1 - p));
    }
    return chance;
}

/**
 * Every counter in the record, so a baseline can be subtracted field by field.
 *
 * Named rather than inferred: the buckets also carry the stamped predictions and
 * the room's identity, and subtracting a prediction from a prediction would be
 * nonsense.
 */
const COUNTERS = [
    'attempts',
    'clears',
    'rooms',
    'seconds',
    'clearedRooms',
    'clearedSeconds',
    'xp',
    'actions',
    'successes',
    'doubles',
    'fights',
    'fightSeconds',
    // The sum of squares behind the fight-length band. Left off this list, a
    // since-view kept the whole record's squares over a since-view fight count,
    // and the variance came out ~15x too wide — which is a band nothing can
    // ever fall outside, so the sharpest test in the record was silently dead
    // in exactly the view that asked for a fresh reading.
    'fightSquares',
    'successRatioSum',
    'successRatioSquares',
    'successRatioRooms',
    'doubleRatioSum',
    'doubleRatioSquares',
    'doubleRatioRooms',
    'fullKitJudged',
    'fullKitJudgedClears',
    'fullKitExpected',
    'fullKitVariance',
    // Also a running sum, so a since-view must subtract it: a migration that
    // happened before the mark is not something the period since it set aside.
    // `cohortFingerprintVersion` is deliberately NOT here — it is a stamp, not
    // a counter, and differencing it would produce a version number of zero.
    'legacyCohortJudged',
];

/**
 * The record since a mark, rather than since the beginning.
 *
 * The buckets are running totals with no timestamps in them, so "since Tuesday"
 * cannot be filtered out of them — but it can be subtracted, because every
 * figure in a bucket is a sum. A baseline is a copy of the totals taken at the
 * moment it was marked, and the difference between then and now is the record
 * since.
 *
 * That is what makes a baseline better than the Reset it sits beside: Reset
 * answers "start measuring from here" by destroying everything that came
 * before, and this answers it while keeping it.
 *
 * The stamped predictions are carried through unchanged. They are the claim
 * being tested rather than a quantity, and last-write-wins is already how they
 * behave.
 *
 * @param {Object} totals - The record now
 * @param {Object} baseline - The record when the mark was made
 * @returns {Object} Totals covering the period since
 */
export function totalsSince(totals, baseline) {
    if (!baseline) return totals || {};

    const out = {};
    for (const [key, bucket] of Object.entries(totals || {})) {
        const before = baseline[key];
        if (!before) {
            // A room first entered after the mark belongs to the period whole
            out[key] = bucket;
            continue;
        }

        // The record has gone backwards, so the mark is describing a record
        // that no longer exists — imported over, or wiped and rebuilt. Taking
        // the difference would subtract a history this bucket never had and
        // leave it looking empty, so the mark is treated as stale for it.
        if ((Number(bucket.attempts) || 0) < (Number(before.attempts) || 0)) {
            out[key] = bucket;
            continue;
        }

        const since = { ...bucket };
        for (const field of COUNTERS) {
            const now = Number(bucket[field]) || 0;
            const then = Number(before[field]) || 0;
            // Floored at zero even so: individual counters were added at
            // different times and an old record may not carry all of them
            if (now || then) since[field] = Math.max(0, now - then);
        }

        // A field-wise difference does not preserve the record's own pairings.
        // An entry and the clear that answers it arrive in separate floor
        // updates, so a mark taken between them puts the clear inside the period
        // and the attempt outside it — a bucket with more clears than attempts,
        // which the pooled headline then reports as "0 fights, expected 0.0
        // clears, got 1". A clear whose attempt is not in the period is not in
        // the period either.
        const clamp = (won, tried) => {
            const cap = Number(since[tried]) || 0;
            if ((Number(since[won]) || 0) > cap) since[won] = cap;
        };
        clamp('clears', 'attempts');
        clamp('fullKitJudgedClears', 'fullKitJudged');

        // Nothing has happened here since the mark, so it is not part of the
        // period at all — listing it would fill the panel with empty rooms
        if (!(since.attempts > 0) && !(since.rooms > 0)) continue;
        out[key] = since;
    }
    return out;
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
 * @param {Function} [orderOf] - (subjectHrid) => sort key, for the game's order
 * @returns {Array<Object>} One per subject
 */
export function accuracyBySubject(rows, interval, orderOf) {
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

    if (orderOf) {
        out.sort(
            (a, b) =>
                compareOrder(orderOf(a.subjectHrid), orderOf(b.subjectHrid)) ||
                a.subjectHrid.localeCompare(b.subjectHrid)
        );
    } else {
        out.sort((a, b) => b.attempts - a.attempts || b.clears - a.clears);
    }
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
 * @param {Object} [options] - `{ name }` for what to call each subject, `{ meta }`
 *   for provenance — `{toolashaVersion, host, isTestServer, fullKit}`
 * @returns {string}
 */
export function accuracyReport({ rows = [], summary = {}, bySubject = [] } = {}, { name, meta } = {}) {
    const label = name || ((hrid) => hrid.split('/').pop());
    const pct = (value, places = 1) => (Number.isFinite(value) ? `${(value * 100).toFixed(places)}%` : '—');
    // The raw probability, for checking the arithmetic — the pct columns round
    const raw = (value) => (Number.isFinite(value) ? String(value) : '—');
    const out = [];

    out.push('Toolasha — labyrinth sim accuracy');
    if (meta) {
        out.push(
            `Toolasha ${meta.toolashaVersion || 'unknown version'} · ${meta.host || 'unknown host'}` +
                (meta.isTestServer ? ' (test server)' : '') +
                (meta.fullKit ? ' · full-kit sim model' : '')
        );
    }
    out.push(`${summary.attempts ?? 0} fights over ${summary.buckets ?? 0} room/level buckets`);
    // The headline is the current-model cohort, judged at the prediction in
    // effect when each fight was folded; older fights are counted, not pooled
    const cohort = summary.cohort;
    if (cohort && cohort.expected !== null) {
        const off = cohort.judgedClears - cohort.expected;
        out.push(
            `Judged (current sim model): ${cohort.judged} fights, expected ${cohort.expected.toFixed(1)} clears, ` +
                `got ${cohort.judgedClears} (${off >= 0 ? '+' : ''}${off.toFixed(1)}` +
                (cohort.sd ? `, ${cohort.sigma.toFixed(1)} sd on a spread of ${cohort.sd.toFixed(1)})` : ')')
        );
    }
    if (cohort && cohort.legacyExcluded > 0) {
        out.push(`${cohort.legacyExcluded} older fights from a previous sim model excluded`);
    }
    if (summary.expected === null || summary.expected === undefined) {
        out.push('No simulated rates to compare against yet.');
    } else {
        const off = (summary.judgedClears ?? 0) - summary.expected;
        out.push(
            `All eras pooled (for reference only): ${summary.judged} fights, expected ` +
                `${summary.expected.toFixed(1)} clears, got ${summary.judgedClears} ` +
                `(${off >= 0 ? '+' : ''}${off.toFixed(1)}` +
                (summary.sd ? `, ${summary.sigma.toFixed(1)} sd on a spread of ${summary.sd.toFixed(1)})` : ')')
        );
    }
    out.push(
        `Rooms the record contradicts: ${summary.contested ?? 0}` +
            (summary.contestedByChance === null || summary.contestedByChance === undefined
                ? ''
                : ` (about ${summary.contestedByChance.toFixed(1)} expected by chance)`)
    );

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
        'subject\tlevel\tattempts\tclears\tsim\tactual\tsim raw\tactual raw\t95% band\tverdict\tlikelihood\t' +
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
                // Unrounded, so the arithmetic can be checked from the file
                raw(row.predicted),
                raw(row.observed),
                `${pct(row.low)}-${pct(row.high)}`,
                row.verdict,
                row.likelihood === null ? '—' : row.likelihood.toFixed(4),
                row.timing ? row.timing.predicted.toFixed(0) : '—',
                row.timing ? row.timing.actual.toFixed(0) : '—',
                row.timing?.perFinishedVisit ? row.timing.perFinishedVisit.toFixed(0) : '—',
            ].join('\t')
        );
    }

    const withFights = rows.filter((row) => row.fightLength);
    if (withFights.length) {
        out.push('');
        out.push('FIGHT LENGTH (combat rooms)');
        out.push('Every attempt counts, won or lost, and the sim predicts the same kind of average —');
        out.push('so this says something about a room in ten fights where a clear rate needs hundreds.');
        out.push('subject\tlevel\tfights\tsim secs\tran secs\t95% band\tratio\tverdict');
        for (const row of withFights) {
            const fl = row.fightLength;
            out.push(
                [
                    label(row.subjectHrid),
                    row.level,
                    fl.fights,
                    fl.predicted.toFixed(0),
                    fl.actual.toFixed(0),
                    fl.low === null ? '—' : `${fl.low.toFixed(0)}-${fl.high.toFixed(0)}`,
                    fl.ratio.toFixed(2),
                    fl.verdict,
                ].join('\t')
            );
        }
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
