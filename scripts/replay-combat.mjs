/**
 * Replay a combat recording through the attribution.
 *
 * The recording is the raw feed; this is what the panel would have made of it.
 * Running the two side by side is how an attribution disagreement gets settled:
 * the numbers here can be compared against what another tool showed for the
 * same fight, and the recording can be replayed again after a change to see
 * whether the change was an improvement or just a different wrong answer.
 *
 * Usage:
 *   node scripts/replay-combat.mjs path/to/toolasha-combat-*.json
 *   node scripts/replay-combat.mjs recording.json --no-filter
 *
 * `--no-filter` keeps damage credited while the player was idle, which is what
 * the panel's "Filter Nondamage" toggle turns off.
 */

import { readFileSync } from 'node:fs';
import {
    newAttributionState,
    noteActions,
    attributeTick,
    foldEvents,
    foldEnemies,
} from '../src/utils/damage-attribution.js';

const [, , path, ...flags] = process.argv;

if (!path) {
    console.error('Usage: node scripts/replay-combat.mjs <recording.json> [--no-filter]');
    process.exit(1);
}

const filterNonDamaging = !flags.includes('--no-filter');
const file = JSON.parse(readFileSync(path, 'utf8'));

if (file.format !== 'toolasha-combat-recording') {
    console.error(`Not a Toolasha combat recording: ${path}`);
    process.exit(1);
}

const state = newAttributionState();
const tally = {};
const enemyTally = {};
const names = {};
const monsters = {};

let seconds = 0;
let lastAt = null;

/** A tick further from the last than this is a gap rather than a long swing */
const MAX_GAP_MS = 2000;

/**
 * A monster's name, from the hrid the recording carries.
 * @param {Object} monster - From `new_battle`
 * @returns {string|null}
 */
function monsterName(monster) {
    const hrid = monster?.combatMonsterHrid || monster?.monsterHrid;
    if (hrid) return String(hrid).split('/').pop().replace(/_/g, ' ');
    return monster?.name || null;
}

for (const tick of file.ticks || []) {
    if (tick.type === 'new_battle') {
        const players = tick.payload?.players || {};
        noteActions(state, players);
        for (const [index, player] of Object.entries(players)) {
            names[index] = player?.name || player?.character?.name || names[index];
        }

        state.monstersHP = {};
        state.dmgCounter = {};
        state.critCounter = {};

        for (const [index, monster] of Object.entries(tick.payload?.monsters || {})) {
            const name = monsterName(monster);
            if (name) monsters[index] = { name };
        }
        continue;
    }

    const events = attributeTick(tick.payload, state);
    const nameOf = (index) => monsters[index]?.name || null;
    foldEvents(tally, events, { filterNonDamaging, nameOf });
    foldEnemies(enemyTally, events, nameOf);
    // After attributing, as the tracker does it
    noteActions(state, tick.payload?.pMap);

    if (lastAt !== null) {
        const gap = tick.at - lastAt;
        if (gap > 0 && gap < MAX_GAP_MS) seconds += gap / 1000;
    }
    lastAt = tick.at;
}

/**
 * @param {number} value - A figure
 * @param {number} outOf - What it is part of
 * @returns {string}
 */
const share = (value, outOf) => (outOf > 0 ? `${((value / outOf) * 100).toFixed(1)}%` : '—');

console.log(`\n${path}`);
console.log(`${file.ticks?.length || 0} ticks, ${seconds.toFixed(1)}s of battle time`);
console.log(`Filter non-damaging: ${filterNonDamaging ? 'on' : 'off'}${file.truncated ? '  (recording hit its cap)' : ''}`);

for (const [index, player] of Object.entries(tally)) {
    const swings = player.hits + player.misses;
    console.log(`\n${names[index] || `Player ${Number(index) + 1}`}`);
    console.log(
        `  ${Math.round(player.damage)} damage  ·  ${(player.damage / (seconds || 1)).toFixed(1)} dps  ·  ` +
            `${player.hits}/${swings} hit (${share(player.hits, swings)})`
    );

    const abilities = Object.entries(player.byAbility).sort((a, b) => b[1].damage - a[1].damage);
    for (const [action, stats] of abilities) {
        const attempts = stats.hits + stats.misses;
        console.log(
            `    ${action.padEnd(38)} ${String(Math.round(stats.damage)).padStart(9)}  ` +
                `${share(stats.damage, player.damage).padStart(7)}  ${stats.hits}/${attempts}`
        );
    }
}

const enemies = Object.entries(enemyTally).sort((a, b) => b[1].damage - a[1].damage);
if (enemies.length) {
    console.log('\nEnemies');
    for (const [name, stats] of enemies) {
        console.log(
            `    ${name.padEnd(38)} ${String(Math.round(stats.damage)).padStart(9)}  ` +
                `${String(stats.kills).padStart(3)} killed`
        );
    }
}
console.log('');
