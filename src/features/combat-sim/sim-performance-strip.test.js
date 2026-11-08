/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const store = vi.hoisted(() => ({ values: {}, writes: [], workers: 4 }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key in store.values ? store.values[key] : false),
        setSettingValue: (key, value) => {
            store.writes.push([key, value]);
            store.values[key] = value;
        },
        setSetting: (key, value) => {
            store.writes.push([key, value]);
            store.values[key] = value;
        },
    },
}));

vi.mock('./combat-sim-runner.js', () => ({
    getMaxWorkers: () => store.workers,
}));

const { createPerformanceStrip, clampTyped, effectiveThreadsText } = await import('./sim-performance-strip.js');
const { maxConcurrentSims, resimMaxBudgetMs, allFightsSimBudgetSetting } =
    await import('./sim-performance-settings.js');

const type = (strip, suffix, text) => {
    const box = strip.querySelector(`#t-perf-${suffix}`);
    box.value = text;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return box;
};

beforeEach(() => {
    store.values = {};
    store.writes = [];
    store.workers = 4;
    document.body.innerHTML = '';
});
afterEach(() => {
    document.body.innerHTML = '';
});

describe('the Performance strip', () => {
    test('builds collapsed, with defaults in every box and the effective thread count', () => {
        Object.defineProperty(navigator, 'hardwareConcurrency', { value: 16, configurable: true });
        const strip = createPerformanceStrip({ includeShorten: true, idPrefix: 't' });
        document.body.appendChild(strip);
        expect(strip.querySelector('#t-perf-body').style.display).toBe('none');
        expect(strip.querySelector('#t-perf-threads').value).toBe('0');
        expect(strip.querySelector('#t-perf-sims').value).toBe('6');
        expect(strip.querySelector('#t-perf-resim').value).toBe('10');
        expect(strip.querySelector('#t-perf-shorten').value).toBe('0');
        expect(strip.querySelector('#t-perf-uncap').checked).toBe(false);
        expect(strip.querySelector('#t-perf-effective').textContent).toBe('→ 4 of 16 cores');
    });

    test('the shorten box exists only when asked for', () => {
        const strip = createPerformanceStrip({ idPrefix: 't' });
        expect(strip.querySelector('#t-perf-shorten')).toBeNull();
    });

    test('the effective text survives a runner that throws', () => {
        store.workers = null;
        expect(effectiveThreadsText()).toBe('');
    });

    test('each box writes its setting on change and the effective text follows', () => {
        const strip = createPerformanceStrip({ includeShorten: true, idPrefix: 't' });
        document.body.appendChild(strip);
        type(strip, 'threads', '8');
        store.workers = 8;
        type(strip, 'sims', '3');
        type(strip, 'resim', '0');
        type(strip, 'shorten', '250');
        expect(store.writes).toEqual([
            ['combatSim_maxThreads', 8],
            ['combatSim_maxConcurrentSims', 3],
            ['combatSim_resimMaxMinutes', 0],
            ['labSim_allFightsSimBudget', 250],
        ]);
        expect(strip.querySelector('#t-perf-effective').textContent).toContain('8');
        // And the run-time readers see the written values
        expect(maxConcurrentSims()).toBe(3);
        expect(resimMaxBudgetMs()).toBe(Infinity);
        expect(allFightsSimBudgetSetting()).toBe(250);
    });

    test('every way a box can end: empty, non-number, negative, zero, above max', () => {
        const strip = createPerformanceStrip({ includeShorten: true, idPrefix: 't' });
        document.body.appendChild(strip);
        // Empty and non-number: nothing written, the box returns to the stored value
        const sims = type(strip, 'sims', '');
        expect(store.writes).toEqual([]);
        expect(sims.value).toBe('6');
        type(strip, 'sims', 'abc');
        expect(store.writes).toEqual([]);
        // Below the minimum, above the maximum
        type(strip, 'sims', '0');
        type(strip, 'sims', '99');
        type(strip, 'sims', '-4');
        expect(store.writes.map((w) => w[1])).toEqual([1, 32, 1]);
        // Threads: 0 is auto and legal; negative clamps to 0; above 32 clamps to 32
        store.writes = [];
        type(strip, 'threads', '0');
        type(strip, 'threads', '-1');
        type(strip, 'threads', '64');
        expect(store.writes.map((w) => w[1])).toEqual([0, 0, 32]);
        // Resim: 0 = no cap, negative clamps to 0, decimals round
        store.writes = [];
        type(strip, 'resim', '2.6');
        type(strip, 'resim', '-3');
        expect(store.writes.map((w) => w[1])).toEqual([3, 0]);
        // Shorten: 0 = never, negative clamps to 0
        store.writes = [];
        type(strip, 'shorten', '-10');
        expect(store.writes.map((w) => w[1])).toEqual([0]);
    });

    test('Ignore caps writes the checkbox and greys out Sims at once', () => {
        const strip = createPerformanceStrip({ idPrefix: 't' });
        document.body.appendChild(strip);
        const uncap = strip.querySelector('#t-perf-uncap');
        uncap.checked = true;
        uncap.dispatchEvent(new Event('change', { bubbles: true }));
        expect(store.writes).toEqual([['combatSim_uncapThreads', true]]);
        expect(strip.querySelector('#t-perf-sims').disabled).toBe(true);
        expect(strip.querySelector('#t-perf-sims-label').title).toContain('Ignore caps');
        uncap.checked = false;
        uncap.dispatchEvent(new Event('change', { bubbles: true }));
        expect(strip.querySelector('#t-perf-sims').disabled).toBe(false);
    });

    test('the toggle opens and closes; opening re-reads the stored values', () => {
        const strip = createPerformanceStrip({ idPrefix: 't' });
        document.body.appendChild(strip);
        store.values.combatSim_maxConcurrentSims = 9;
        strip.querySelector('#t-perf-toggle').click();
        expect(strip.querySelector('#t-perf-body').style.display).toBe('flex');
        expect(strip.querySelector('#t-perf-sims').value).toBe('9');
        strip.querySelector('#t-perf-toggle').click();
        expect(strip.querySelector('#t-perf-body').style.display).toBe('none');
    });

    test('an open strip picks up a change made elsewhere when the pointer comes back', () => {
        const a = createPerformanceStrip({ idPrefix: 'a' });
        const b = createPerformanceStrip({ idPrefix: 'b' });
        document.body.append(a, b);
        b.querySelector('#b-perf-toggle').click();
        a.querySelector('#a-perf-resim').value = '3';
        a.querySelector('#a-perf-resim').dispatchEvent(new Event('change', { bubbles: true }));
        b.querySelector('#b-perf-body').dispatchEvent(new Event('pointerenter'));
        expect(b.querySelector('#b-perf-resim').value).toBe('3');
    });

    test('the pointer coming back never undoes a value still being typed', () => {
        const strip = createPerformanceStrip({ idPrefix: 'c' });
        document.body.append(strip);
        strip.querySelector('#c-perf-toggle').click();
        const box = strip.querySelector('#c-perf-resim');
        box.focus();
        box.value = '42';
        strip.querySelector('#c-perf-body').dispatchEvent(new Event('pointerenter'));
        expect(box.value).toBe('42');
    });

    test('building a strip leaves no listener on the document', () => {
        const spy = vi.spyOn(document, 'addEventListener');
        createPerformanceStrip({ idPrefix: 'd' });
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('clampTyped covers the typed shapes', () => {
        expect(clampTyped('', 0, 5)).toBeNull();
        expect(clampTyped('  ', 0, 5)).toBeNull();
        expect(clampTyped('x', 0, 5)).toBeNull();
        expect(clampTyped('Infinity', 0, 5)).toBeNull();
        expect(clampTyped('7', 0, 5)).toBe(5);
        expect(clampTyped('-1', 0, 5)).toBe(0);
        expect(clampTyped('2.5', 0, 5)).toBe(3);
    });
});

describe('reading the limits when the stored value is unusable', () => {
    test.each([undefined, null, false, true, 'abc', '', NaN])('%s falls back to the defaults', (bad) => {
        store.values.combatSim_maxConcurrentSims = bad;
        store.values.combatSim_resimMaxMinutes = bad;
        store.values.labSim_allFightsSimBudget = bad;
        expect(maxConcurrentSims()).toBe(6);
        expect(resimMaxBudgetMs()).toBe(10 * 60 * 1000);
        expect(allFightsSimBudgetSetting()).toBe(0);
    });

    test('out-of-range stored numbers are clamped, not rejected', () => {
        store.values.combatSim_maxConcurrentSims = 500;
        expect(maxConcurrentSims()).toBe(32);
        store.values.combatSim_maxConcurrentSims = -2;
        expect(maxConcurrentSims()).toBe(1);
        store.values.combatSim_resimMaxMinutes = '15';
        expect(resimMaxBudgetMs()).toBe(15 * 60 * 1000);
    });
});
