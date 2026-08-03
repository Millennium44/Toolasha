/**
 * Expected kills
 *
 * How many of each monster a run of battles should have produced.
 *
 * The count on its own says nothing. Seven Eyes is a lot or a little depending
 * entirely on how often the zone spawns them, and that is not a number anybody
 * carries around — a wave is drawn from a weighted table until the next draw
 * would break its strength budget, so a heavy monster turns up less often than
 * its weight suggests and a light one more. Against the expectation, seven
 * becomes "+21%", which is a fact about the run.
 *
 * The arithmetic that matters is already in `spawn-expectation.js`, solved
 * exactly rather than sampled. This is the thin layer that turns per-wave
 * expectations into per-run ones and names the monsters.
 *
 * ## The battle in progress does not count
 *
 * A run of seven battles has six that finished and one still being fought, and
 * the monsters of that seventh are partly dead and partly not. Counting it in
 * full would make every zone look unlucky by roughly one wave — which at seven
 * battles is fifteen per cent. It is excluded, as IHurt excludes it.
 *
 * The model is IHurt's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import { expectedSpawnsPerWave } from './spawn-expectation.js';
import { splitBattles, DEFAULT_BATTLES_PER_BOSS } from './combat-drop-model.js';

/**
 * A monster's readable name, from the game's detail map.
 *
 * @param {string} hrid - Monster hrid
 * @param {Object} monsterDetailMap - The game's `combatMonsterDetailMap`
 * @returns {string}
 */
function nameOf(hrid, monsterDetailMap) {
    return monsterDetailMap?.[hrid]?.name || String(hrid).split('/').pop().replace(/_/g, ' ');
}

/**
 * How many of each monster the zone should have spawned across a run.
 *
 * @param {Object} input - What the model needs
 * @param {Object} input.actionDetail - The zone's `actionDetailMap` entry
 * @param {Object} input.monsterDetailMap - The game's `combatMonsterDetailMap`
 * @param {number} input.battles - Battles entered, including the one in progress
 * @returns {Object<string, number>} Monster name → expected kills. Empty when the
 *   zone cannot be modelled — a dungeon, no spawn table, or nothing finished yet.
 */
export function expectedKills({ actionDetail, monsterDetailMap, battles }) {
    const zone = actionDetail?.combatZoneInfo;
    const fight = zone?.fightInfo;
    const spawnInfo = fight?.randomSpawnInfo;

    // A dungeon does not spawn from a table — it runs a fixed script and pays
    // out at the end. Better to show nothing than a number from the wrong model.
    if (!zone || zone.isDungeon) return {};
    if (!spawnInfo?.spawns?.length) return {};

    const finished = Math.max((battles || 0) - 1, 0);
    if (!finished) return {};

    const bosses = fight.bossSpawns || [];
    const battlesPerBoss = bosses.length ? fight.battlesPerBoss || DEFAULT_BATTLES_PER_BOSS : 0;
    const { normalCount, bossCount } = splitBattles(finished, battlesPerBoss);

    const expected = {};
    const add = (hrid, count) => {
        if (!hrid || !(count > 0)) return;
        const name = nameOf(hrid, monsterDetailMap);
        expected[name] = (expected[name] || 0) + count;
    };

    const perWave = expectedSpawnsPerWave(spawnInfo);
    for (const [hrid, perBattle] of Object.entries(perWave)) add(hrid, perBattle * normalCount);

    // A boss wave replaces the ordinary one rather than joining it, which is
    // already what `splitBattles` has taken out of `normalCount`
    for (const boss of bosses) add(boss.combatMonsterHrid, bossCount);

    return expected;
}

/**
 * Actual against expected, ready to draw.
 *
 * Monsters the zone expects but which have not been killed are kept, at zero.
 * Dropping them would hide the interesting case: a rare spawn you have not seen
 * once is exactly what somebody checking this panel is looking for, and a row
 * that is simply absent reads as "not in this zone".
 *
 * @param {Array<{name: string, kills: number}>} killed - What actually died
 * @param {Object<string, number>} expected - From `expectedKills`
 * @returns {Array<{name: string, kills: number, expected: number|null, share: number|null}>}
 *   Biggest actual count first. `expected` and `share` are null when the zone
 *   could not be modelled, so a caller can leave the comparison off entirely.
 */
export function killComparison(killed, expected) {
    const modelled = Object.keys(expected).length > 0;
    const seen = new Set();
    const rows = [];

    for (const enemy of killed) {
        seen.add(enemy.name);
        const due = expected[enemy.name] ?? 0;
        rows.push({
            name: enemy.name,
            kills: enemy.kills,
            expected: modelled ? due : null,
            // Null rather than zero when nothing was due: a monster the zone
            // does not spawn cannot be over or under its expectation
            share: modelled && due > 0 ? (enemy.kills - due) / due : null,
        });
    }

    for (const [name, due] of Object.entries(expected)) {
        if (seen.has(name) || !(due > 0)) continue;
        rows.push({ name, kills: 0, expected: due, share: -1 });
    }

    return rows.sort((a, b) => b.kills - a.kills || (b.expected ?? 0) - (a.expected ?? 0));
}
