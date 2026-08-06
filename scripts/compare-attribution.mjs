/**
 * Replay a combat recording through both attribution methods and referee them.
 *
 * "Both" is Toolasha's counter-pairing attribution and a faithful copy of
 * KikiMeter's presence method, run over the identical ticks. Totals cannot
 * separate the two — each conserves the team total by construction — so what
 * gets printed is the disagreements, each one adjudicated from the counters:
 * a credited player who provably swung confirms their method, and a credited
 * player who was only being hit refutes it.
 *
 * Usage:
 *   node scripts/compare-attribution.mjs path/to/recording.json
 *
 * Accepts a Toolasha combat recording (`format: 'toolasha-combat-recording'`)
 * or a raw websocket capture — an array of `{timestamp, type, data}` events,
 * or an object with one under `ticks`, `events`, `messages` or `samples`.
 */

import { readFileSync } from 'node:fs';
import { compareRecording, RECENT_SWING_TICKS } from '../src/utils/attribution-compare.js';

const [, , path] = process.argv;

if (!path) {
    console.error('Usage: node scripts/compare-attribution.mjs <recording.json>');
    process.exit(1);
}

const file = JSON.parse(readFileSync(path, 'utf8'));

/**
 * Whatever shape the capture came in, as the tick list the comparison reads.
 *
 * @param {Object|Array} raw - The parsed file
 * @returns {Array<Object>} `{type, payload}` per message, battle types only
 */
function normalize(raw) {
    // A sim-accuracy export nests the raw payloads per segment, in order
    const segments = raw?.recording?.segments;
    const list = Array.isArray(raw)
        ? raw
        : Array.isArray(segments)
          ? segments.flatMap((segment) => segment?.ticks || [])
          : raw?.ticks || raw?.events || raw?.messages || raw?.samples || [];
    const ticks = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const payload = entry.payload ?? entry.data ?? entry;
        const type = payload?.type ?? entry.type;
        if (type !== 'new_battle' && type !== 'battle_updated') continue;
        ticks.push({ type, payload });
    }
    return ticks;
}

const ticks = normalize(file);
if (!ticks.length) {
    console.error(`No new_battle/battle_updated messages found in ${path}`);
    process.exit(1);
}

const report = compareRecording(ticks);

/** @param {number} value - A damage figure @param {number} outOf - Its whole */
const share = (value, outOf) => (outOf > 0 ? `${((value / outOf) * 100).toFixed(1)}%` : '—');
/** @param {number} value - A damage figure */
const dmg = (value) => String(Math.round(value)).padStart(10);

console.log(`\n${path}`);
console.log(
    `${report.ticks} ticks, ${report.battles} battles, party of ${report.partySize}, ` +
        `${report.damageTicks} damage ticks (${report.missOnlyTicks} miss-only)`
);
console.log(`Monster health lost: ${Math.round(report.monsterHpLost)}`);

console.log('\nPer player (damage credited by each method)');
console.log(`    ${'player'.padEnd(24)} ${'counters'.padStart(10)} ${'presence'.padStart(10)}`);
const rows = Object.entries(report.players).sort((a, b) => b[1].ours + b[1].presence - (a[1].ours + a[1].presence));
for (const [index, row] of rows) {
    console.log(`    ${(row.name || `Player ${Number(index) + 1}`).padEnd(24)} ${dmg(row.ours)} ${dmg(row.presence)}`);
}
console.log(
    `    ${'uncredited'.padEnd(24)} ${dmg(report.totals.oursUncredited)} ${dmg(report.totals.presenceUncredited)}`
);

console.log('\nTick classes (damage is monster health lost in those ticks)');
for (const [kind, entry] of Object.entries(report.classes).sort((a, b) => b[1].damage - a[1].damage)) {
    console.log(
        `    ${kind.padEnd(24)} ${String(entry.ticks).padStart(6)} ticks ${dmg(entry.damage)}  ` +
            share(entry.damage, report.monsterHpLost)
    );
}

console.log('\nReferee verdicts on the disagreements');
const verdictLabel = {
    presenceConfirmed: 'presence right (credited player provably swung)',
    presenceVictim: 'presence wrong (credited player was only being hit)',
    oursConfirmed: 'counters right (our credited player provably swung)',
    bleed: 'bleed ticks (no counter can arbitrate)',
    unresolved: 'unresolved (no counter evidence either way)',
};
for (const [key, entry] of Object.entries(report.adjudication)) {
    if (!entry.ticks) continue;
    console.log(`    ${String(entry.ticks).padStart(6)} ticks ${dmg(entry.damage)}  ${verdictLabel[key] || key}`);
}

console.log(`\nActor-grouping claim (was a provable swinger present when a hit landed?)`);
console.log(`    hit-landed ticks:        ${report.grouping.hitTicks}`);
console.log(`    swinger present, now:    ${report.grouping.swungNow}`);
console.log(`    swinger present, ≤${RECENT_SWING_TICKS} ago: ${report.grouping.recentSwing}`);
console.log(`    only a victim present:   ${report.grouping.victimOnly}   ← the aggro-tank case`);
console.log(`    present, no signal:      ${report.grouping.presentNoSignal}`);
console.log(`    nobody present at all:   ${report.grouping.nobodyPresent}`);

if (report.samples.length) {
    console.log(`\nFirst ${report.samples.length} disagreement ticks`);
    for (const sample of report.samples) {
        const oursSaid = Object.entries(sample.ours)
            .map(([index, amount]) => `${index}:${Math.round(amount)}`)
            .join(' ');
        const presenceSaid = Object.entries(sample.presence)
            .map(([index, amount]) => `${index}:${Math.round(amount)}`)
            .join(' ');
        console.log(
            `    tick ${String(sample.tick).padStart(6)}  ${sample.kind.padEnd(16)} ${sample.verdict.padEnd(18)} ` +
                `dmg ${Math.round(sample.damage)}  ours[${oursSaid || '—'}] presence[${presenceSaid || '—'}] ` +
                `swung[${sample.swungNow.join(',') || '—'}] hit[${sample.gotHit.join(',') || '—'}]`
        );
    }
}
console.log('');
