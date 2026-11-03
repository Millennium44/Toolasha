/**
 * A performance report somebody can read, or send: the startup trace, the stall
 * ledger, and the diagnostic extras (timers, leak canary, heap, Tampermonkey
 * traffic, other tabs).
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
 * Union length of a set of [startedAt, endedAt] intervals.
 *
 * @param {Array<{startedAt: number, endedAt: number}>} rows - Any timeline rows
 * @returns {number} Milliseconds during which at least one of them was running
 */
function coveredMs(rows) {
    const ordered = [...rows].sort((a, b) => a.startedAt - b.startedAt);
    let total = 0;
    let from = null;
    let to = null;
    for (const row of ordered) {
        if (from === null || row.startedAt > to) {
            if (from !== null) total += to - from;
            from = row.startedAt;
            to = row.endedAt;
        } else if (row.endedAt > to) {
            to = row.endedAt;
        }
    }
    if (from !== null) total += to - from;
    return total;
}

/**
 * How much of the startup was spent on features at all.
 *
 * `blocking` is how long the page was actually held up, which is the union of
 * the feature spans and not their sum: feature initializers are started
 * together and their waits overlap, so adding the durations would report six
 * features waiting one second each as six seconds of delay when the player
 * waited one. Non-overlapping spans still add up exactly as before.
 *
 * @param {Array<Object>} timeline - From `initTimeline`
 * @returns {{blocking: number, background: number, span: number, slowest: Array<Object>}}
 */
export function initSummary(timeline) {
    let background = 0;
    let span = 0;
    for (const row of timeline) {
        if (row.background) background += row.ms;
        span = Math.max(span, row.endedAt);
    }
    const blocking = coveredMs(timeline.filter((row) => !row.background));
    const slowest = [...timeline].sort((a, b) => b.ms - a.ms).slice(0, 10);
    return { blocking, background, span, slowest };
}

const NOT_COLLECTED = 'not collected by whatever built this report';

/** @param {number} bytes - A byte count @returns {string} e.g. `812 B`, `41.3 KB`, `12.40 MB` */
function bytesText(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1048576).toFixed(2)} MB`;
}

/** @param {number} value - Duration in ms @returns {string} `3d 4h`, `2h 5m` or `45s` */
function spanText(value) {
    const seconds = Math.floor((Number(value) || 0) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * A name from the traffic counters, made safe to paste.
 *
 * Storage keys and hosts are the only free text in the traffic summary. Hosts
 * already arrive without a path or query (the counters keep `URL.host`), and
 * keys are fixed names, but a per-character key carries a character id and a
 * future key could carry anything — so anything after `?`/`#`, long digit runs
 * and long opaque tokens (gist ids, hashes) are masked.
 * @param {string} name - Key or host
 * @returns {string} Masked name
 */
export function redactName(name) {
    return String(name ?? '')
        .replace(/[?#].*$/, '')
        .replace(/\d{5,}/g, '#')
        .replace(/(?:gh[a-z]_)?[A-Za-z0-9]{20,}/g, '<id>');
}

/**
 * Merge rows that mask to the same name, so masking never lists one key twice.
 * @param {Array<Object>} rows - Counter rows with `name`
 * @returns {Array<Object>} Masked rows, largest bytes first
 */
function redactRows(rows) {
    const merged = new Map();
    for (const row of rows || []) {
        const name = redactName(row.name);
        const into = merged.get(name) || { name, calls: 0, bytes: 0, errors: 0 };
        into.calls += row.calls || 0;
        into.bytes += row.bytes || 0;
        into.errors += row.errors || 0;
        merged.set(name, into);
    }
    return [...merged.values()].sort((a, b) => b.bytes - a.bytes);
}

/**
 * The traffic snapshot reduced to counts and masked names.
 * @param {Object|null} snapshot - From `getGmTrafficSnapshot()`
 * @returns {Object|null} Safe copy, or null when there is none
 */
function safeTraffic(snapshot) {
    if (!snapshot) return null;
    return {
        uptimeMs: snapshot.uptimeMs,
        rateWindowMs: snapshot.rateWindowMs,
        totals: { ...snapshot.totals },
        perHour: { ...snapshot.perHour },
        writeErrors: snapshot.writeErrors,
        unsizedWrites: snapshot.unsizedWrites,
        writesByKey: redactRows(snapshot.writesByKey),
        readsByKey: redactRows(snapshot.readsByKey),
        requestsByHost: redactRows(snapshot.requestsByHost),
        pageRequestsByHost: redactRows(snapshot.pageRequestsByHost),
    };
}

/**
 * One census row reduced to what tells tabs apart and nothing private: no
 * character id or name (a tab is named by its random id), no per-key detail.
 * @param {{self: boolean, tabId: string, summary: Object}} tab - From `getTabs()`
 * @returns {Object} Safe row
 */
function safeTab(tab) {
    const summary = tab?.summary || {};
    const totals = summary.traffic?.totals || {};
    return {
        self: Boolean(tab?.self),
        tabId: String(tab?.tabId ?? ''),
        hasCharacter: Boolean(summary.characterName),
        uptimeMs: summary.uptimeMs ?? null,
        heapMb: typeof summary.heapMb === 'number' ? summary.heapMb : null,
        stalls: summary.stalls || null,
        writeCalls: totals.writeCalls ?? 0,
        writeBytes: totals.writeBytes ?? 0,
        writeBytesPerHour: summary.traffic?.perHour?.writeBytes ?? 0,
        requestCalls: (totals.requestCalls ?? 0) + (totals.pageRequestCalls ?? 0),
    };
}

/**
 * The four optional sections, each normalized to `{ ...data, reason }` so an
 * absent one is present and says why. Shared by the text and the JSON so the
 * two cannot disagree about what was collected.
 * @param {Object} input - `{ timerCounters, leak, traffic, tabs }` as passed to the report
 * @returns {{timerCounters: Object, leak: Object, traffic: Object, tabs: Object}} Normalized
 */
function extraSections({ timerCounters, leak, traffic, tabs }) {
    return {
        timerCounters: timerCounters
            ? { counters: { ...timerCounters }, reason: null }
            : { counters: null, reason: 'the monitor publishes no timer counters' },
        leak: {
            canary: {
                rows: leak?.canary?.rows ?? null,
                reason: leak ? (leak.canary?.reason ?? null) : NOT_COLLECTED,
            },
            heap: { trend: leak?.heap?.trend ?? null, reason: leak ? (leak.heap?.reason ?? null) : NOT_COLLECTED },
        },
        traffic: {
            snapshot: safeTraffic(traffic?.snapshot),
            reason: traffic ? (traffic.reason ?? null) : NOT_COLLECTED,
        },
        tabs: {
            tabs: (tabs?.tabs || []).map(safeTab),
            reason: tabs ? (tabs.reason ?? null) : NOT_COLLECTED,
        },
    };
}

/** @param {string} title - Section title @returns {string[]} The title line and a rule */
function titled(title) {
    return [title, '-'.repeat(60)];
}

/**
 * The optional sections as text lines, each present even when empty.
 * @param {Object} extras - From `extraSections`
 * @returns {string[]} Lines
 */
function extraLines(extras) {
    const lines = [];

    lines.push(...titled('Timer churn (created since the page loaded)'));
    const counters = extras.timerCounters.counters;
    if (counters) {
        const total = counters.interval + counters.timeout;
        lines.push(
            `${total} created (${counters.timeout} timeout, ${counters.interval} interval), ` +
                `${counters.domRearm} observer debounce re-arms, ${counters.named} named`
        );
    } else {
        lines.push(`None: ${extras.timerCounters.reason}`);
    }
    lines.push('');

    lines.push(...titled('Leak canary (registry counts that only ever climb)'));
    const { canary, heap } = extras.leak;
    if (canary.rows?.length) {
        for (const row of canary.rows) {
            lines.push(
                `${row.growing ? '! ' : '  '}${String(row.source).padEnd(34)} now ${row.latest}, lowest ${row.lowest}, ` +
                    `${row.samples} readings, ${row.decreases} drops${row.growing ? '  GROWING' : ''}`
            );
        }
    } else {
        lines.push(`None: ${canary.reason || 'no readings yet'}`);
    }
    if (heap.trend) {
        const t = heap.trend;
        const sign = t.changeMb >= 0 ? '+' : '';
        lines.push(
            `Tab heap: ${t.usedMb.toFixed(1)}MB, ${sign}${t.changeMb.toFixed(1)}MB over ${(t.spanMs / 1000).toFixed(0)}s ` +
                `(${sign}${t.perMinuteMb.toFixed(1)}MB/min). Whole tab, rounded by Chrome: shows that something leaks, not whose.`
        );
    } else {
        lines.push(`Tab heap: none: ${heap.reason || 'no readings yet'}`);
    }
    lines.push('');

    lines.push(...titled('Tampermonkey traffic (Toolasha calls only; names masked)'));
    const snap = extras.traffic.snapshot;
    if (snap) {
        const rowLine = (row) =>
            `  ${row.name}: ${row.calls}x, ${bytesText(row.bytes)}${row.errors ? `, ${row.errors} failed` : ''}`;
        lines.push(
            `Writes: ${snap.totals.writeCalls} calls, ${bytesText(snap.totals.writeBytes)} - ${snap.perHour.writeCalls}/h, ` +
                `${bytesText(snap.perHour.writeBytes)}/h` +
                (snap.writeErrors ? ` - ${snap.writeErrors} threw` : '') +
                (snap.unsizedWrites ? ` - ${snap.unsizedWrites} unsized` : '') +
                (snap.totals.deleteCalls ? ` - ${snap.totals.deleteCalls} deletes` : '')
        );
        lines.push(...snap.writesByKey.slice(0, 5).map(rowLine));
        lines.push(
            `Reads: ${snap.totals.readCalls} calls, ${bytesText(snap.totals.readBytes)} returned - ${snap.perHour.readCalls}/h`
        );
        lines.push(...snap.readsByKey.slice(0, 3).map(rowLine));
        lines.push(
            `Requests: ${snap.totals.requestCalls} calls, ${bytesText(snap.totals.requestBytes)} sent, ` +
                `${bytesText(snap.totals.responseBytes)} received - ${snap.perHour.requestCalls}/h`
        );
        lines.push(...snap.requestsByHost.map(rowLine));
        lines.push(
            `Page fetches (bypass Tampermonkey): ${snap.totals.pageRequestCalls} calls, ` +
                `${bytesText(snap.totals.pageRequestBytes)} sent, ${bytesText(snap.totals.pageResponseBytes)} received`
        );
        lines.push(...snap.pageRequestsByHost.map(rowLine));
        lines.push(
            `Since this page loaded (${spanText(snap.uptimeMs)}); /h extrapolates the last ${spanText(snap.rateWindowMs)}.`
        );
        if (extras.traffic.reason) lines.push(extras.traffic.reason);
    } else {
        lines.push(`None: ${extras.traffic.reason || 'no counters'}`);
    }
    lines.push('');

    lines.push(...titled('All tabs (latest poll already held; the export does not poll)'));
    const { tabs, reason } = extras.tabs;
    for (const tab of tabs) {
        const heapText = typeof tab.heapMb === 'number' ? `, heap ${tab.heapMb.toFixed(0)}MB` : '';
        const stallText = tab.stalls ? `, ${tab.stalls.count} stalls (worst ${tab.stalls.worstMs}ms)` : '';
        lines.push(
            `${tab.self ? '> this tab' : tab.tabId}${tab.hasCharacter ? '' : ' (no character yet)'}: up ${spanText(tab.uptimeMs)}, ` +
                `writes ${bytesText(tab.writeBytes)} (${bytesText(tab.writeBytesPerHour)}/h), requests ${tab.requestCalls}` +
                `${heapText}${stallText}`
        );
    }
    if (reason) lines.push(tabs.length ? `Note: ${reason}` : `None: ${reason}`);
    lines.push('');
    return lines;
}

/**
 * The whole trace as text.
 *
 * Text rather than JSON because the point is that a person reads it — in a chat
 * window, on a phone, without tooling. The machine-readable copy travels beside
 * it for anyone who wants to sort it.
 *
 * @param {Object} data - `{ marks, snapshots, spans, stats, stalls, worstStallMs, panelDelays,
 *   timerCounters, leak, traffic, tabs, environment }`
 * @returns {string}
 */
export function formatReport({
    marks = [],
    snapshots = new Map(),
    spans = new Map(),
    stats = new Map(),
    stalls = [],
    worstStallMs = 0,
    panelDelays = [],
    timerCounters = null,
    leak = null,
    traffic = null,
    tabs = null,
    environment = {},
} = {}) {
    const lines = [];
    const timeline = initTimeline(snapshots);
    const summary = initSummary(timeline);

    // The extras are the performance panel's; a caller that passes none of them (the health report)
    // gets the startup trace it always got, without four empty sections
    const wantsExtras = Boolean(timerCounters || leak || traffic || tabs);
    lines.push(wantsExtras ? 'Toolasha performance report' : 'Toolasha startup trace');
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

    const ranked = [...(stats || [])].sort((a, b) => b[1].totalMs - a[1].totalMs);
    const runningAll = ranked.filter(([, stat]) => stat.kind !== 'elapsed');
    const running = runningAll.slice(0, 15);
    if (running.length) {
        lines.push('Busiest since the panel opened (rolling 5s window)');
        lines.push('-'.repeat(60));
        for (const [name, stat] of running) {
            lines.push(
                `${stat.cpuPercent.toFixed(1).padStart(6)}%  ${name.padEnd(34)} ${stat.calls} calls, avg ${stat.avgMs.toFixed(2)}ms`
            );
        }
        if (runningAll.length > running.length) {
            lines.push(
                `           ...and ${runningAll.length - running.length} more (all of them are in the JSON copy)`
            );
        }
        lines.push('');
    }

    // Listed apart because their percentages are not comparable with the ones
    // above: an elapsed region yields to the browser, so most of what it
    // measures is time the main thread spent on somebody else's work - or on
    // nothing. Kept, because "net worth takes half a second to settle" is worth
    // knowing; kept out of the CPU block, because it is not half a second of CPU.
    const elapsedAll = ranked.filter(([, stat]) => stat.kind === 'elapsed');
    const elapsed = elapsedAll.slice(0, 15);
    if (elapsed.length) {
        lines.push('Elapsed, not CPU - these yield to the browser (rolling 5s window)');
        lines.push('-'.repeat(60));
        for (const [name, stat] of elapsed) {
            lines.push(
                `${stat.wallPercent.toFixed(1).padStart(6)}% wall  ${name.padEnd(28)} ${stat.calls} calls, avg ${stat.avgMs.toFixed(2)}ms elapsed`
            );
        }
        if (elapsedAll.length > elapsed.length) {
            lines.push(
                `           ...and ${elapsedAll.length - elapsed.length} more (all of them are in the JSON copy)`
            );
        }
        lines.push('');
    }

    // The stalls are what a hitching progress bar feels like, and the suspects
    // beside each one are what the hunt used to start by guessing at
    if (stalls.length) {
        const windowedWorst = Math.max(...stalls.map((stall) => stall.duration));
        // The ring the panel keeps stalls in is capped, so its "worst" only
        // covers what is still in the window — a session-lifetime max is
        // tracked separately precisely so a long session's single bad stall
        // cannot silently roll off before anyone reads the report.
        const worstLine =
            worstStallMs > windowedWorst
                ? `worst ${ms(windowedWorst)} shown, ${ms(worstStallMs)} this session`
                : `worst ${ms(windowedWorst)}`;
        lines.push(`Main-thread stalls since measuring began (${stalls.length}, ${worstLine})`);
        lines.push('-'.repeat(60));
        for (const stall of stalls.slice(-15)) {
            const who = stall.suspects?.length
                ? stall.suspects.map((suspect) => `${suspect.name} ${suspect.ms}ms`).join(', ')
                : stall.recentEvents?.length
                  ? `no measured work; just after ${stall.recentEvents.join(', ')} (likely the game's own processing)` +
                    (stall.inFlight?.length ? `; ${stall.inFlight.join(', ')} was pending (async, not proven)` : '')
                  : stall.inFlight?.length
                    ? `no measured work; ${stall.inFlight.join(', ')} was pending (async, not proven)`
                    : 'nothing instrumented overlapped it';
            lines.push(`${ms(stall.duration).padStart(9)}  at ${ms(stall.sinceBoot).padStart(8)}  ${who}`);
        }
        if (stalls.length > 15) lines.push(`           ...and ${stalls.length - 15} earlier`);
        lines.push('');
    }

    // Trigger-to-draw latency, which no CPU figure above can show when the
    // work happens in await continuations
    if (panelDelays.length) {
        lines.push('Panel delays (trigger to the panel on screen)');
        lines.push('-'.repeat(60));
        for (const row of panelDelays) {
            lines.push(
                `${ms(row.worst).padStart(9)}  ${row.name.padEnd(28)} ${row.count}x, last ${ms(row.last)}, median ${ms(row.median)}` +
                    (row.worst >= 1000 ? '  (slow)' : '')
            );
        }
        lines.push('');
    }

    if (wantsExtras) lines.push(...extraLines(extraSections({ timerCounters, leak, traffic, tabs })));

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
    stalls = [],
    worstStallMs = 0,
    panelDelays = [],
    timerCounters = null,
    leak = null,
    traffic = null,
    tabs = null,
    environment = {},
} = {}) {
    return {
        environment,
        ...(timerCounters || leak || traffic || tabs ? extraSections({ timerCounters, leak, traffic, tabs }) : {}),
        stalls,
        panelDelays,
        worstStallMs,
        marks: [...marks].sort((a, b) => a.at - b.at),
        features: initTimeline(snapshots),
        spans: Object.fromEntries([...spans].map(([name, parts]) => [name, parts])),
        // One object, each entry carrying its own `kind` - splitting it into two
        // would break every consumer that looks a metric up by name, and the
        // tag travels with the number wherever it is sorted or filtered.
        rolling: Object.fromEntries([...stats].map(([name, stat]) => [name, stat])),
    };
}
