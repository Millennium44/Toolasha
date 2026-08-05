/** @vitest-environment happy-dom
 *
 * Reading one labyrinth run against another.
 *
 * A win rate on its own is a number; a win rate next to last week's is a
 * decision. These tests are about the record kept of a finished single-target
 * run, the baseline that survives a delete and a reload, and the delta cells —
 * including the two things a delta table gets wrong if nobody checks: printing
 * noise as a finding, and colouring "more deaths" green because the number went
 * up.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({ values: new Map(), failWrites: false }));

vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_char1`,
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => (db.values.has(key) ? db.values.get(key) : fallback),
        set: async (key, value) => {
            if (db.failWrites) throw new Error('quota');
            // Round-tripped, because storage is not a place to keep a reference
            // to an object the panel goes on mutating
            db.values.set(key, JSON.parse(JSON.stringify(value)));
        },
    },
}));

const {
    LAB_COMPARISON_KEY,
    LAB_COMPARISON_BASELINE_KEY,
    MAX_LAB_COMPARISON_RUNS,
    LAB_COMPARISON_METRICS,
    LabComparisonStore,
    describeLabRun,
    formatLabDelta,
    labComparisonRows,
    labMonsterName,
    labRunLabel,
    makeLabRunEntry,
    renderLabComparisonPanel,
    sanitizeLabRuns,
    wireLabComparisonPanel,
} = await import('./lab-sim-comparison.js');

const metric = (key) => LAB_COMPARISON_METRICS.find((m) => m.key === key);

/** A recorded run with the fields a test cares about and defaults for the rest. */
function run(overrides = {}) {
    return makeLabRunEntry({
        monsterHrid: '/monsters/gobo_chief',
        roomLevel: 120,
        hours: 3,
        attempts: 1000,
        encounters: 700,
        deaths: 30,
        ...overrides,
    });
}

beforeEach(() => {
    db.values = new Map();
    db.failWrites = false;
});

describe('what a finished run is recorded as', () => {
    test('the rates the table compares on, derived from the counts behind them', () => {
        const entry = run({ attempts: 1000, encounters: 700, deaths: 30 });

        expect(entry.metrics.winRate).toBeCloseTo(0.7, 10);
        expect(entry.metrics.tries).toBeCloseTo(1 / 0.7, 10);
        expect(entry.metrics.deathsPer100).toBeCloseTo(3, 10);
        // The sample stays with the rate — 100% off four attempts is not the
        // same claim as 100% off four thousand
        expect(entry.metrics.attempts).toBe(1000);
        expect(entry.metrics.deaths).toBe(30);
    });

    test('a fight that never cleared has no finite number of tries to a clear', () => {
        const entry = run({ attempts: 500, encounters: 0 });
        expect(entry.metrics.winRate).toBe(0);
        expect(entry.metrics.tries).toBeNull();
        expect(metric('tries').format(entry.metrics.tries)).toBe('—');
    });

    test('a run with no attempts at all does not divide by zero', () => {
        const entry = run({ attempts: 0, encounters: 0, deaths: 0 });
        expect(entry.metrics.winRate).toBe(0);
        expect(entry.metrics.deathsPer100).toBe(0);
    });

    test('the name comes off the monster when the caller has not got one', () => {
        expect(labMonsterName('/monsters/gobo_chief')).toBe('Gobo Chief');
        expect(run().settings.monsterName).toBe('Gobo Chief');
    });

    test('the label carries what distinguishes one run from the next', () => {
        expect(labRunLabel({ monsterName: 'Mimic', roomLevel: 140 })).toBe('Mimic L140');
        expect(labRunLabel({ monsterName: 'Mimic', roomLevel: 140, gearLabel: 'Cursed Bow +5' })).toBe(
            'Mimic L140 · Cursed Bow +5'
        );
        // "Current Gear" is what every unedited run says, so it distinguishes
        // nothing and is left out
        expect(labRunLabel({ monsterName: 'Mimic', roomLevel: 140, gearLabel: 'Current Gear' })).toBe('Mimic L140');
    });

    test('a run recorded before the Task Fight checkbox was removed still says so', () => {
        // The checkbox is gone — a labyrinth monster is never your combat task —
        // but entries already in the store were simulated with taskDamage on,
        // and one of those reading as an ordinary run is one you would compare
        // against by mistake
        expect(labRunLabel({ monsterName: 'Mimic', roomLevel: 140, taskFight: true })).toBe('Mimic L140 · task fight');
    });

    test('and nothing recorded from here on carries the flag at all', () => {
        expect(run().settings).not.toHaveProperty('taskFight');
        // Passing it is not an error, it simply has nowhere to land now
        expect(run({ taskFight: true }).label).toBe('Gobo Chief L120');
    });

    test('the settings the label had to drop are on the tooltip', () => {
        const text = describeLabRun(run({ hours: 5, crates: ['/items/expert_tea_crate'] }));
        expect(text).toContain('5h budget');
        expect(text).toContain('expert_tea');
        expect(text).toContain('1,000 attempts');
    });

    test('two runs made in the same millisecond are still two runs', () => {
        const a = run({ timestamp: 1000 });
        const b = run({ timestamp: 1000 });
        expect(a.id).not.toBe(b.id);
    });
});

describe('deltas against the baseline', () => {
    test('a better win rate reads green, a worse one red', () => {
        expect(formatLabDelta(0.75, 0.7, metric('winRate'))).toContain('#7ec87e');
        expect(formatLabDelta(0.65, 0.7, metric('winRate'))).toContain('#ff6b6b');
    });

    test('fewer tries and fewer deaths are the good direction, even though the number went down', () => {
        expect(formatLabDelta(1.2, 1.5, metric('tries'))).toContain('#7ec87e');
        expect(formatLabDelta(1.8, 1.5, metric('tries'))).toContain('#ff6b6b');
        expect(formatLabDelta(1, 4, metric('deathsPer100'))).toContain('#7ec87e');
        expect(formatLabDelta(6, 4, metric('deathsPer100'))).toContain('#ff6b6b');
    });

    test('a move too small to be anything but the seed is not printed', () => {
        expect(formatLabDelta(0.700001, 0.7, metric('winRate'))).toBe('');
        expect(formatLabDelta(1.5001, 1.5, metric('tries'))).toBe('');
    });

    test('nothing to compare against prints nothing', () => {
        expect(formatLabDelta(0.7, null, metric('winRate'))).toBe('');
        expect(formatLabDelta(null, 0.7, metric('tries'))).toBe('');
    });

    test('the baseline row comes first however late it was recorded', () => {
        const runs = [run({ roomLevel: 100 }), run({ roomLevel: 110 }), run({ roomLevel: 120 })];
        const rows = labComparisonRows(runs, runs[2].id);

        expect(rows[0].entry).toBe(runs[2]);
        expect(rows[0].isBaseline).toBe(true);
        expect(rows.slice(1).map((r) => r.entry)).toEqual([runs[0], runs[1]]);
        expect(rows.every((r) => r.baselineMetrics === runs[2].metrics)).toBe(true);
    });

    test('a baseline that no longer exists falls back to the oldest run', () => {
        const runs = [run(), run()];
        expect(labComparisonRows(runs, 'gone')[0].entry).toBe(runs[0]);
    });
});

describe('the comparison table', () => {
    test('one run is not a comparison, so nothing is drawn', () => {
        expect(renderLabComparisonPanel([run()], null)).toBe('');
        expect(renderLabComparisonPanel([], null)).toBe('');
    });

    test('two runs draw a baseline picker with every run in it', () => {
        const runs = [run({ roomLevel: 100 }), run({ roomLevel: 120 })];
        const html = renderLabComparisonPanel(runs, runs[1].id);

        expect(html).toContain('Comparison (2 runs)');
        expect(html).toContain('mwi-labsim-cmp-baseline');
        expect(html).toContain('Clear All');
        for (const entry of runs) expect(html).toContain(entry.id);
        // The pinned one is the selected option and the starred row
        expect(html).toContain(`value="${runs[1].id}" selected`);
        expect(html).toContain('★');
    });

    test('a loadout name with markup in it stays text', () => {
        const runs = [run({ gearLabel: '<img src=x>' }), run()];
        const html = renderLabComparisonPanel(runs, null);
        expect(html).not.toContain('<img src=x>');
        expect(html).toContain('&lt;img src=x&gt;');
    });

    test('every headline metric gets a column and the sample size follows it', () => {
        const html = renderLabComparisonPanel([run(), run()], null);
        for (const m of LAB_COMPARISON_METRICS) expect(html).toContain(m.label);
        expect(html).toContain('Attempts');
    });

    test('its controls report the run they are about', () => {
        const runs = [run({ roomLevel: 100 }), run({ roomLevel: 120 })];
        const host = document.createElement('div');
        host.innerHTML = renderLabComparisonPanel(runs, runs[0].id);

        const seen = { baseline: null, deleted: null, cleared: 0 };
        wireLabComparisonPanel(host, {
            onBaseline: (id) => {
                seen.baseline = id;
            },
            onDelete: (id) => {
                seen.deleted = id;
            },
            onClear: () => {
                seen.cleared++;
            },
        });

        const select = host.querySelector('#mwi-labsim-cmp-baseline');
        select.value = runs[1].id;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        expect(seen.baseline).toBe(runs[1].id);

        host.querySelector(`[data-labsim-cmp-delete="${runs[1].id}"]`).dispatchEvent(
            new window.Event('click', { bubbles: true })
        );
        expect(seen.deleted).toBe(runs[1].id);

        host.querySelector('#mwi-labsim-cmp-clear').dispatchEvent(new window.Event('click', { bubbles: true }));
        expect(seen.cleared).toBe(1);
    });

    test('the section collapses and comes back', () => {
        const host = document.createElement('div');
        host.innerHTML = renderLabComparisonPanel([run(), run()], null);
        wireLabComparisonPanel(host, {});

        const toggle = host.querySelector('#mwi-labsim-cmp-toggle');
        const body = host.querySelector('#mwi-labsim-cmp-body');
        toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
        expect(body.style.display).toBe('none');
        toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
        expect(body.style.display).toBe('block');
    });
});

describe('the store behind it', () => {
    test('the second run is where a baseline starts to mean something', async () => {
        const store = new LabComparisonStore();
        await store.load();

        await store.add(run());
        expect(store.baselineId).toBeNull();

        const first = store.runs[0];
        await store.add(run());
        expect(store.baselineId).toBe(first.id);
    });

    test('runs survive a reload, baseline and all', async () => {
        const store = new LabComparisonStore();
        await store.load();
        await store.add(run({ roomLevel: 100 }));
        await store.add(run({ roomLevel: 120 }));
        await store.setBaseline(store.runs[1].id);
        const pinned = store.runs[1].id;

        const reopened = new LabComparisonStore();
        await reopened.load();

        expect(reopened.runs.map((e) => e.settings.roomLevel)).toEqual([100, 120]);
        expect(reopened.baselineId).toBe(pinned);
        expect(db.values.get(`${LAB_COMPARISON_KEY}_char1`)).toHaveLength(2);
        expect(db.values.get(`${LAB_COMPARISON_BASELINE_KEY}_char1`)).toBe(pinned);
    });

    test('a baseline pointing at a run that is no longer stored is not restored', async () => {
        db.values.set(`${LAB_COMPARISON_KEY}_char1`, [run()]);
        db.values.set(`${LAB_COMPARISON_BASELINE_KEY}_char1`, 'a-run-from-another-life');

        const store = new LabComparisonStore();
        await store.load();

        expect(store.baselineId).toBeNull();
    });

    test('deleting the baseline moves it rather than leaving it dangling', async () => {
        const store = new LabComparisonStore();
        await store.load();
        await store.add(run({ roomLevel: 100 }));
        await store.add(run({ roomLevel: 110 }));
        await store.add(run({ roomLevel: 120 }));
        await store.setBaseline(store.runs[2].id);

        await store.remove(store.runs[2].id);

        expect(store.runs).toHaveLength(2);
        expect(store.baselineId).toBe(store.runs[0].id);
    });

    test('deleting down to one run leaves nothing pinned', async () => {
        const store = new LabComparisonStore();
        await store.load();
        await store.add(run());
        await store.add(run());
        await store.remove(store.runs[1].id);

        expect(store.baselineId).toBeNull();
    });

    test('the window rolls, and takes the baseline with it when it evicts one', async () => {
        const store = new LabComparisonStore();
        await store.load();
        for (let i = 0; i < MAX_LAB_COMPARISON_RUNS; i++) await store.add(run({ roomLevel: 100 + i }));
        const evicted = store.runs[0].id;
        await store.setBaseline(evicted);

        await store.add(run({ roomLevel: 999 }));

        expect(store.runs).toHaveLength(MAX_LAB_COMPARISON_RUNS);
        expect(store.runs.map((e) => e.id)).not.toContain(evicted);
        // Not left pointing at a run that is gone
        expect(store.baselineId).toBe(store.runs[0].id);
        expect(store.runs.at(-1).settings.roomLevel).toBe(999);
    });

    test('clearing forgets the runs and the pin together', async () => {
        const store = new LabComparisonStore();
        await store.load();
        await store.add(run());
        await store.add(run());
        await store.clear();

        expect(store.runs).toEqual([]);
        expect(store.baselineId).toBeNull();
        expect(db.values.get(`${LAB_COMPARISON_KEY}_char1`)).toEqual([]);
    });

    test('a storage that cannot write does not take the panel down with it', async () => {
        const store = new LabComparisonStore();
        await store.load();
        db.failWrites = true;

        await expect(store.add(run())).resolves.toBeDefined();
        expect(store.runs).toHaveLength(1);
    });

    test('whatever is in storage, only runs come back out', () => {
        expect(sanitizeLabRuns(null)).toEqual([]);
        expect(sanitizeLabRuns('nonsense')).toEqual([]);
        expect(sanitizeLabRuns([null, {}, { metrics: {} }])).toHaveLength(1);
        // A round trip through JSON turns the "never cleared" case into null,
        // which is what the formatter is expecting
        expect(sanitizeLabRuns([{ metrics: { tries: null } }])[0].metrics.tries).toBeNull();
        expect(sanitizeLabRuns(Array.from({ length: 30 }, () => run()))).toHaveLength(MAX_LAB_COMPARISON_RUNS);
    });
});
