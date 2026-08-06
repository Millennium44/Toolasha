/**
 * A startup trace somebody can read, or send.
 *
 * The panel shows what is slow right now. This answers the harder question —
 * why a page took eighteen seconds to become useful — and does it in a form that
 * survives being pasted into a chat window. A screenshot of a list of durations
 * loses the two things that actually locate a problem: when each one started,
 * and what the page was waiting for in between.
 *
 * Kept apart from the panel because the interesting part is the arithmetic, and
 * the arithmetic should be testable without a DOM.
 */

/** Time in the trace, always to the same precision so columns line up */
const ms = (value) => `${(Number(value) || 0).toFixed(0)}ms`;

/**
 * The gaps in a startup trace — the stretches where nothing was being timed.
 *
 * Feature durations add up to less than the wall clock, and the difference is
 * where the answer usually is: waiting for IndexedDB to open, waiting for the
 * game's own data to arrive, waiting for a paint. A trace that only lists work
 * makes that time invisible.
 *
 * @param {Array<{name: string, at: number}>} marks - From `getMarks()`
 * @returns {Array<{from: string, to: string, ms: number}>} Gaps, longest first
 */
export function gapsBetween(marks) {
    const ordered = [...(marks || [])].sort((a, b) => a.at - b.at);
    const gaps = [];
    for (let i = 1; i < ordered.length; i++) {
        gaps.push({ from: ordered[i - 1].name, to: ordered[i].name, ms: ordered[i].at - ordered[i - 1].at });
    }
    return gaps.sort((a, b) => b.ms - a.ms);
}

/**
 * Feature timings as a timeline rather than a leaderboard.
 *
 * Sorted by when each one started, because the question a startup trace is asked
 * is "what was everything else waiting behind", and that is answered by order,
 * not by size.
 *
 * @param {Map<string, {duration: number, startedAt: number}>} snapshots
 * @returns {Array<{name: string, ms: number, startedAt: number, endedAt: number}>}
 */
export function initTimeline(snapshots) {
    // `init:<key>:own` carries the feature's synchronous self-time; it is not
    // a row of its own but an annotation on `init:<key>`, so fold those aside
    // first and attach them, rather than letting them count as extra features.
    const ownByKey = new Map();
    for (const [name, entry] of snapshots || []) {
        if (name.startsWith('init:') && name.endsWith(':own')) {
            ownByKey.set(name.slice(0, -':own'.length), entry.duration);
        }
    }

    const rows = [];
    for (const [name, entry] of snapshots || []) {
        if (!name.startsWith('init:') && !name.startsWith('bg:')) continue;
        if (name.endsWith(':own')) continue;
        const startedAt = entry.startedAt ?? 0;
        rows.push({
            name,
            ms: entry.duration,
            ownMs: ownByKey.has(name) ? ownByKey.get(name) : null,
            startedAt,
            endedAt: startedAt + entry.duration,
            background: name.startsWith('bg:'),
        });
    }
    return rows.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * How much of the startup was spent on features at all.
 *
 * @param {Array<Object>} timeline - From `initTimeline`
 * @returns {{blocking: number, background: number, span: number, slowest: Array<Object>}}
 */
export function initSummary(timeline) {
    let blocking = 0;
    let background = 0;
    let span = 0;
    for (const row of timeline) {
        if (row.background) background += row.ms;
        else blocking += row.ms;
        span = Math.max(span, row.endedAt);
    }
    const slowest = [...timeline].sort((a, b) => b.ms - a.ms).slice(0, 10);
    return { blocking, background, span, slowest };
}

/**
 * The whole trace as text.
 *
 * Text rather than JSON because the point is that a person reads it — in a chat
 * window, on a phone, without tooling. The machine-readable copy travels beside
 * it for anyone who wants to sort it.
 *
 * @param {Object} data - `{ marks, snapshots, spans, stats, environment }`
 * @returns {string}
 */
export function formatReport({
    marks = [],
    snapshots = new Map(),
    spans = new Map(),
    stats = new Map(),
    environment = {},
} = {}) {
    const lines = [];
    const timeline = initTimeline(snapshots);
    const summary = initSummary(timeline);

    lines.push('Toolasha startup trace');
    lines.push('='.repeat(60));
    for (const [key, value] of Object.entries(environment)) {
        lines.push(`${key}: ${value}`);
    }
    lines.push('');

    lines.push(
        `Features: ${timeline.length} timed, ${ms(summary.blocking)} blocking, ${ms(summary.background)} in the background`
    );
    lines.push(`Last one finished at ${ms(summary.span)} after the script started`);
    lines.push('');

    if (marks.length) {
        lines.push('Timeline');
        lines.push('-'.repeat(60));
        for (const mark of [...marks].sort((a, b) => a.at - b.at)) {
            lines.push(
                `${ms(mark.at).padStart(9)}  ${mark.name}${mark.detail ? `  ${JSON.stringify(mark.detail)}` : ''}`
            );
        }
        lines.push('');

        const gaps = gapsBetween(marks).filter((gap) => gap.ms >= 50);
        if (gaps.length) {
            lines.push('Longest gaps between marks (where the waiting went)');
            lines.push('-'.repeat(60));
            for (const gap of gaps.slice(0, 8)) {
                lines.push(`${ms(gap.ms).padStart(9)}  ${gap.from} → ${gap.to}`);
            }
            lines.push('');
        }
    }

    if (summary.slowest.length) {
        lines.push('Slowest features');
        lines.push('-'.repeat(60));
        for (const row of summary.slowest) {
            // When a feature parked far more time in `await` than it spent on
            // its own work, say so — that time is deferred work draining here,
            // not this feature's cost.
            const drain = Number.isFinite(row.ownMs) && row.ms - row.ownMs >= 1;
            lines.push(
                `${ms(row.ms).padStart(9)}  ${row.name.padEnd(34)} started ${ms(row.startedAt)}` +
                    (row.background ? '  (background)' : '') +
                    (drain ? `  (own ${ms(row.ownMs)}, ${ms(row.ms - row.ownMs)} waiting on other work)` : '')
            );
            for (const part of (spans.get(row.name) || []).slice().sort((a, b) => b.duration - a.duration)) {
                lines.push(`${ms(part.duration).padStart(9)}      └ ${part.part}`);
            }
        }
        lines.push('');
    }

    const running = [...(stats || [])].sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, 15);
    if (running.length) {
        lines.push('Busiest since the panel opened (rolling 5s window)');
        lines.push('-'.repeat(60));
        for (const [name, stat] of running) {
            lines.push(
                `${stat.cpuPercent.toFixed(1).padStart(6)}%  ${name.padEnd(34)} ${stat.calls} calls, avg ${stat.avgMs.toFixed(2)}ms`
            );
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * The same trace as data, for anyone who would rather sort it than read it.
 *
 * @param {Object} data - Same shape as `formatReport`
 * @returns {Object} JSON-safe
 */
export function reportData({
    marks = [],
    snapshots = new Map(),
    spans = new Map(),
    stats = new Map(),
    environment = {},
} = {}) {
    return {
        environment,
        marks: [...marks].sort((a, b) => a.at - b.at),
        features: initTimeline(snapshots),
        spans: Object.fromEntries([...spans].map(([name, parts]) => [name, parts])),
        rolling: Object.fromEntries([...stats].map(([name, stat]) => [name, stat])),
    };
}
