/**
 * Spawn Expectation
 *
 * How many of each monster a combat wave is expected to contain.
 *
 * A wave is not a fixed roster. The game draws monsters one at a time from a
 * weighted table and stops early when the next draw would push the wave past its
 * strength budget, so the roster is a distribution rather than a list. That makes
 * "this monster drops X at rate Y" not directly usable: to turn a drop rate into
 * an expectation you first need the expected number of that monster per wave, and
 * a monster's strength changes how often the wave has room for it at all — a
 * heavy monster is rarer than its weight suggests, and a light one is commoner.
 *
 * Solved exactly rather than sampled. `combat-sim/engine/zone.js` draws real
 * random encounters because a simulation needs one concrete wave at a time; this
 * needs the mean over all of them, and there are few enough states to enumerate
 * every one. The result is exact and takes no samples to converge.
 *
 * Ported from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`.
 */

/**
 * Expected count of each monster in one wave of a random spawn table.
 *
 * The state is (strength spent so far, monsters drawn so far), and every state is
 * reachable only through draws that fit — a draw that would overflow the strength
 * budget ends the wave, so it contributes neither the monster that overflowed nor
 * anything after it. Walking the states in order of strength and then count means
 * a state is only ever read after every path into it has been added, so one pass
 * suffices.
 *
 * Spawn rates are treated as **weights and normalised**, which is what the game
 * itself does when it draws (`totalWeight * random()` in `engine/zone.js`). Read
 * as bare probabilities they only happen to work when the table sums to 1.
 *
 * ONE table. A dungeon wave does not come from one: `combat-sim/engine/zone.js`
 * draws each eligible table below the highest the wave has reached with
 * probability 1/7 and the highest with the remainder, so in a three-table
 * dungeon's top band 2/7 of waves come from a lower table. Passing a single
 * `randomSpawnInfoMap` entry here therefore answers "given the wave came from
 * this table", not "given the wave is at this depth" — a caller that wants the
 * latter has to mix the map's entries at those weights itself. Both callers
 * today (`combat-drop-model.js`, `expected-kills.js`) bail out on dungeons
 * before they get here, so nothing depends on the mixture yet.
 *
 * @param {Object} randomSpawnInfo - `combatZoneInfo.fightInfo.randomSpawnInfo`, or an
 *   entry of a dungeon's `randomSpawnInfoMap`: `{ spawns, maxSpawnCount, maxTotalStrength }`
 * @returns {Object<string, number>} Monster hrid → expected count per wave. Empty when
 *   the table is missing, weightless, or allows no draws.
 */
export function expectedSpawnsPerWave(randomSpawnInfo) {
    const spawns = randomSpawnInfo?.spawns || [];
    const maxSpawnCount = randomSpawnInfo?.maxSpawnCount ?? 0;
    const maxTotalStrength = randomSpawnInfo?.maxTotalStrength ?? 0;

    const expected = {};
    if (!spawns.length || maxSpawnCount <= 0 || maxTotalStrength < 0) return expected;

    const totalWeight = spawns.reduce((sum, spawn) => sum + (spawn.rate || 0), 0);
    if (totalWeight <= 0) return expected;

    for (const spawn of spawns) {
        const hrid = spawn.combatMonsterHrid || spawn.hrid;
        if (hrid) expected[hrid] = 0;
    }

    // reached[strength][count] — the probability the wave is in exactly that state
    const reached = [];
    for (let strength = 0; strength <= maxTotalStrength; strength++) {
        reached.push(new Array(maxSpawnCount + 1).fill(0));
    }
    reached[0][0] = 1;

    for (let strength = 0; strength <= maxTotalStrength; strength++) {
        for (let count = 0; count < maxSpawnCount; count++) {
            const here = reached[strength][count];
            if (!here) continue;

            for (const spawn of spawns) {
                const hrid = spawn.combatMonsterHrid || spawn.hrid;
                if (!hrid) continue;

                // A draw that does not fit ends the wave rather than being retried,
                // so its share of the probability simply stops here
                const nextStrength = strength + (spawn.strength || 0);
                if (nextStrength > maxTotalStrength) continue;

                const probability = here * ((spawn.rate || 0) / totalWeight);
                reached[nextStrength][count + 1] += probability;
                expected[hrid] += probability;
            }
        }
    }

    return expected;
}

/**
 * Expected count of each monster over a run of waves.
 *
 * Separate from the per-wave figure because the per-wave one is worth caching per
 * zone — it depends only on the spawn table — while the run length changes every
 * time you ask.
 *
 * @param {Object} randomSpawnInfo - Spawn table, as above
 * @param {number} waveCount - How many waves
 * @returns {Object<string, number>} Monster hrid → expected count over the run. Empty
 *   when the run length is not a count.
 */
export function expectedSpawnsOverWaves(randomSpawnInfo, waveCount) {
    if (!Number.isFinite(waveCount) || waveCount < 0) return {};

    const perWave = expectedSpawnsPerWave(randomSpawnInfo);
    const total = {};
    for (const [hrid, count] of Object.entries(perWave)) {
        total[hrid] = count * waveCount;
    }
    return total;
}
