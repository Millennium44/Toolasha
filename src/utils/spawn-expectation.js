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
 * latter has to mix the map's entries at those weights itself, which
 * {@link expectedSpawnsPerClear} does for a whole dungeon.
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

/**
 * Chance a dungeon wave is drawn from any one eligible table below the highest,
 * capped at an equal share. A copy of `LOWER_TABLE_RATE` in
 * `combat-sim/engine/zone.js`, whose note holds the measurement: a util may not
 * reach into a feature bundle. `zone.test.js` runs the real `Zone` against this
 * mixture, so the two cannot drift apart unnoticed.
 */
const LOWER_TABLE_RATE = 1 / 7;

/**
 * How many of each monster one whole clear of a dungeon spawns, which on a clear
 * is how many of them die: a wave only ends when all of it is down.
 *
 * Solved exactly, wave by wave, the way `Zone.getNextWave` draws them: a wave on
 * `fixedSpawnsMap` is that roster and nothing else; any other wave comes whole
 * from one table of `randomSpawnInfoMap`, each eligible lower table with
 * {@link LOWER_TABLE_RATE} and the highest eligible with the rest.
 *
 * A dungeon tier does not change these tables. A spawn's own `difficultyTier`
 * is kept apart in the answer because the game adds it to the dungeon's tier,
 * so its kills are worth more Bestiary credit.
 *
 * @param {Object} dungeonInfo - `combatZoneInfo.dungeonInfo`:
 *   `{ maxWaves, fixedSpawnsMap, randomSpawnInfoMap }`
 * @returns {Object<string, Object<number, number>>} Monster hrid → the spawn's own
 *   tier → expected count per clear. Empty when the data cannot answer.
 */
export function expectedSpawnsPerClear(dungeonInfo) {
    const out = {};
    const maxWaves = Math.floor(Number(dungeonInfo?.maxWaves)) || 0;
    if (maxWaves <= 0) return out;

    const add = (hrid, spawnTier, count) => {
        if (!hrid || !(count > 0)) return;
        if (!out[hrid]) out[hrid] = {};
        const tier = Number(spawnTier) || 0;
        out[hrid][tier] = (out[hrid][tier] || 0) + count;
    };

    const fixedMap = dungeonInfo.fixedSpawnsMap || {};
    const randomMap = dungeonInfo.randomSpawnInfoMap;
    const waveKeys =
        randomMap && typeof randomMap === 'object'
            ? Object.keys(randomMap)
                  .map(Number)
                  .sort((a, b) => a - b)
            : [];

    // One table's expectation, split by monster and spawn tier. Two rows for one
    // monster at different tiers are different draws, so each row is solved under
    // its own key and split back apart after.
    const SEPARATOR = '|';
    const perTable = new Map();
    const tableExpectation = (key) => {
        if (perTable.has(key)) return perTable.get(key);
        const table = randomMap[key];
        const expected = expectedSpawnsPerWave({
            ...table,
            spawns: (table?.spawns || []).map((spawn) => ({
                ...spawn,
                combatMonsterHrid: `${spawn.combatMonsterHrid || spawn.hrid}${SEPARATOR}${spawn.difficultyTier || 0}`,
            })),
        });
        perTable.set(key, expected);
        return expected;
    };
    const addTable = (key, weight) => {
        // A table with no spawn list falls back to the first, as the engine does
        const usable = randomMap[key]?.spawns ? key : waveKeys[0];
        if (!randomMap[usable]?.spawns) return;
        for (const [drawn, count] of Object.entries(tableExpectation(usable))) {
            const cut = drawn.lastIndexOf(SEPARATOR);
            add(drawn.slice(0, cut), drawn.slice(cut + 1), count * weight);
        }
    };

    for (let wave = 1; wave <= maxWaves; wave++) {
        const fixed = fixedMap[String(wave)];
        if (fixed) {
            for (const monster of fixed) add(monster?.combatMonsterHrid, monster?.difficultyTier, 1);
            continue;
        }
        if (!waveKeys.length) continue;

        const eligible = waveKeys.filter((key) => wave >= key);
        if (!eligible.length) {
            addTable(waveKeys[0], 1);
            continue;
        }
        const rate = Math.min(LOWER_TABLE_RATE, 1 / eligible.length);
        const lowerCount = eligible.length - 1;
        eligible.slice(0, lowerCount).forEach((key) => addTable(key, rate));
        addTable(eligible[lowerCount], 1 - rate * lowerCount);
    }

    return out;
}
