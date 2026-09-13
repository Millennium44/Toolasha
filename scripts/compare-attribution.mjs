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
 *   node scripts/compare-attribution.mjs path/to/trace.ndjson.gz
 *
 * Accepts, auto-detected from the file's own content — never from its name:
 * - A Toolasha combat recording (`format: 'toolasha-combat-recording'`) or a
 *   raw personal websocket capture: an array of `{timestamp, type, data}`
 *   events, or an object with one under `ticks`, `events`, `messages` or
 *   `samples`. Replayed in personal mode (`new_battle`/`battle_updated`).
 * - A guild trial diagnostic trace (`guild-trial-trace.js`'s export): gzip or
 *   plain NDJSON, one JSON object per line, the first line a `{format:
 *   'toolasha-guild-trial-trace', …}` header. Replayed in trial mode
 *   (`new_guild_battle`/`guild_battle_updated`, plus `guild_trial_stats_updated`
 *   when the trace carries it, for the per-player error report).
 * - A plain JSON array/object of trial messages in the same shapes as above,
 *   for a capture that was not run through the trace recorder.
 *
 * Never commit a trace file, or any file this script is pointed at that
 * carries real player names — see `guild-trial-trace.js`'s own note on why the
 * feature is opt-in.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { compareRecording, RECENT_SWING_TICKS } from '../src/utils/attribution-compare.js';

const [, , path] = process.argv;

if (!path) {
    console.error('Usage: node scripts/compare-attribution.mjs <recording.json|trace.ndjson[.gz]>');
    process.exit(1);
}

/** Message names that only ever appear on a guild trial's stream */
const TRIAL_TYPES = new Set(['new_guild_battle', 'guild_battle_updated', 'guild_trial_stats_updated']);

/**
 * The file's text, gunzipped first if it looks gzipped — by content, not by
 * extension, since a trace saved without the `.gz` suffix is still gzip when
 * the browser it came from had `CompressionStream`.
 *
 * @param {string} filePath
 * @returns {string}
 */
function readText(filePath) {
    const buffer = readFileSync(filePath);
    // The gzip magic number: 0x1f 0x8b
    const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    return (isGzip ? gunzipSync(buffer) : buffer).toString('utf8');
}

/**
 * The trace NDJSON format: one JSON object per line, the first line a header
 * with no `type` of its own — `{format: 'toolasha-guild-trial-trace', …}` —
 * and every line after it `{at, rel, type, payload}`.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeTrace(text) {
    const firstLine = text.slice(0, text.indexOf('\n') > -1 ? text.indexOf('\n') : text.length);
    try {
        return JSON.parse(firstLine)?.format === 'toolasha-guild-trial-trace';
    } catch {
        return false;
    }
}

/**
 * The trace NDJSON as the tick list the comparison reads, timestamps kept —
 * the reflect rung's 33 s window is real wall-clock time, and the trace has it.
 *
 * @param {string} text
 * @returns {Array<Object>} `{type, payload, at}`
 */
function normalizeTrace(text) {
    const lines = text.split('\n').filter(Boolean);
    const ticks = [];
    // Line 0 is the header, not an event — skip it unconditionally rather than
    // re-parsing it as one
    for (const line of lines.slice(1)) {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            continue; // a truncated last line from a trace still being flushed
        }
        if (!event || typeof event.type !== 'string') continue;
        ticks.push({ type: event.type, payload: event.payload, at: event.at });
    }
    return ticks;
}

/**
 * Whatever shape a JSON capture came in, as the tick list the comparison
 * reads — personal messages, trial messages, or (harmlessly) a mix, since
 * `compareRecording` only reads the pair its own `mode` names.
 *
 * @param {Object|Array} raw - The parsed file
 * @returns {Array<Object>} `{type, payload, at}` per message, battle types only
 */
function normalizeJson(raw) {
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
        if (type !== 'new_battle' && type !== 'battle_updated' && !TRIAL_TYPES.has(type)) continue;
        const at = Number.isFinite(entry.at)
            ? entry.at
            : Number.isFinite(entry.timestamp)
              ? entry.timestamp
              : undefined;
        ticks.push({ type, payload, at });
    }
    return ticks;
}

const text = readText(path);
const isTrace = looksLikeTrace(text);
const ticks = isTrace ? normalizeTrace(text) : normalizeJson(JSON.parse(text));

if (!ticks.length) {
    console.error(`No recognisable combat messages found in ${path}`);
    process.exit(1);
}

// Trial mode whenever the file carries any trial-only message — a trace
// always does; a plain JSON capture might carry either family
const mode = ticks.some((tick) => TRIAL_TYPES.has(tick.type)) ? 'trial' : 'personal';

const report = compareRecording(ticks, { mode });

/** @param {number} value - A damage figure @param {number} outOf - Its whole */
const share = (value, outOf) => (outOf > 0 ? `${((value / outOf) * 100).toFixed(1)}%` : '—');
/** @param {number} value - A damage figure */
const dmg = (value) => String(Math.round(value)).padStart(10);

console.log(`\n${path}${isTrace ? ' (diagnostic trace)' : ''} — ${mode} mode`);
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
    presenceVictim: 'presence wrong (credited player was only being hit) — the aggro-tank case',
    reflectTank: 'presence right (credited player was hit with a live reflect — the aggro-tank read does not apply)',
    oursConfirmed: 'counters right (our credited player provably swung)',
    bleed: 'bleed ticks (no counter can arbitrate)',
    unresolved: 'unresolved (no counter evidence either way)',
};
for (const [key, entry] of Object.entries(report.adjudication)) {
    if (!entry.ticks) continue;
    console.log(`    ${String(entry.ticks).padStart(6)} ticks ${dmg(entry.damage)}  ${verdictLabel[key] || key}`);
}
if (mode === 'trial' && report.adjudication.presenceVictim.ticks > 0) {
    console.log(
        '    Caveat: a presence-victim tick still includes any reflect tank this trace gave no cast to remember —\n' +
            '    a build seen only mid-fight, or a passive reflect off gear rather than Spike Shell/Retribution.'
    );
}

console.log(`\nActor-grouping claim (was a provable swinger present when a hit landed?)`);
console.log(`    hit-landed ticks:        ${report.grouping.hitTicks}`);
console.log(`    swinger present, now:    ${report.grouping.swungNow}`);
console.log(`    swinger present, ≤${RECENT_SWING_TICKS} ago: ${report.grouping.recentSwing}`);
console.log(`    only a victim present:   ${report.grouping.victimOnly}   ← the aggro-tank case`);
console.log(`    present, no signal:      ${report.grouping.presentNoSignal}`);
console.log(`    nobody present at all:   ${report.grouping.nobodyPresent}`);

if (mode === 'trial') {
    const stats = report.trialStats;
    console.log('\nGame’s own end-of-trial totals (guild_trial_stats_updated)');
    if (!stats) {
        console.log('    Not present in this file — nothing to compare our measurement against.');
    } else if (!stats.reported) {
        console.log(
            `    Ambiguous: rows for ${stats.otherEncounters.length + 1} trials arrived (` +
                `${stats.otherEncounters.join(', ')}${stats.otherEncounters.length ? ', ' : ''}unidentified) and this ` +
                'replay never named its own encounter — guessing would pin the comparison to the wrong fight.'
        );
    } else {
        console.log(`    Encounter: ${stats.encounter}`);
        if (stats.otherEncounters.length) {
            console.log(`    (also carried, not this trial's: ${stats.otherEncounters.join(', ')})`);
        }
        console.log(
            `    ${'player'.padEnd(24)} ${'reported'.padStart(10)} ${'counters'.padStart(10)} ${'err%'.padStart(7)}`
        );
        const errorRows = Object.entries(stats.errors).sort((a, b) => b[1].reportedDamage - a[1].reportedDamage);
        for (const [name, row] of errorRows) {
            const pct = row.relErrorOurs === null ? '—' : `${(row.relErrorOurs * 100).toFixed(1)}%`;
            console.log(
                `    ${name.padEnd(24)} ${dmg(row.reportedDamage)} ${dmg(row.measuredOurs)} ${pct.padStart(7)}`
            );
        }
        const headline = stats.meanAbsPercentOurs === null ? '—' : `${stats.meanAbsPercentOurs.toFixed(2)}%`;
        console.log(`    Mean absolute per-player damage error (our engine): ${headline}`);
        if (stats.meanAbsPercentPresence !== null) {
            console.log(`    Same, presence method: ${stats.meanAbsPercentPresence.toFixed(2)}%`);
        }
    }
}

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
