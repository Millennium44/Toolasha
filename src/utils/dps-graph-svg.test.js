/** @vitest-environment happy-dom */

import { describe, test, expect } from 'vitest';
import { dpsGraphSVG, niceStep, BOSS_COLOR } from './dps-graph-svg.js';

function parse(markup) {
    const host = document.createElement('div');
    host.innerHTML = markup;
    return host;
}

describe('niceStep', () => {
    test('rounds to 1, 2 or 5 of a power of ten', () => {
        expect(niceStep(900)).toBe(200);
        expect(niceStep(12_000)).toBe(5000);
        expect(niceStep(0)).toBe(1);
    });
});

describe('dpsGraphSVG', () => {
    test('nothing with fewer than two points', () => {
        expect(dpsGraphSVG({ xs: [0], lines: [{ values: [1], color: '#fff' }] })).toBe('');
    });

    test('one polyline per line, each with a point per x, drawn in order', () => {
        const host = parse(
            dpsGraphSVG({
                xs: [0, 1, 2],
                lines: [
                    { values: [1, 2, 3], color: '#ef5350', label: 'Abe' },
                    { values: [3, 4, 5], color: '#e8ecf5', width: 1.8, label: 'Party' },
                ],
            })
        );
        const polylines = host.querySelectorAll('polyline');
        expect(polylines).toHaveLength(2);
        expect(polylines[0].getAttribute('points').split(' ')).toHaveLength(3);
        expect(polylines[1].getAttribute('stroke')).toBe('#e8ecf5');
        expect(polylines[1].textContent).toBe('Party');
    });

    test('boss stretches are shaded, boundaries marked, and labels escaped', () => {
        const host = parse(
            dpsGraphSVG({
                xs: [0, 10, 20],
                lines: [{ values: [5, 5, 5], color: '#42a5f5', label: '<b>x</b>' }],
                bands: [{ from: 10, to: 20 }],
                markers: [{ x: 10, label: 'T3' }],
                xTicks: [{ x: 20, label: 'now' }],
            })
        );
        expect(host.querySelector('[data-band]').getAttribute('fill')).toBe(BOSS_COLOR);
        expect(host.querySelector('[data-marker]')).not.toBeNull();
        expect(host.textContent).toContain('T3');
        expect(host.textContent).toContain('now');
        expect(host.querySelector('b')).toBeNull();
    });
});
