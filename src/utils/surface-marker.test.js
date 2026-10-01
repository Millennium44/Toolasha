/** @vitest-environment happy-dom */
import { describe, test, expect } from 'vitest';
import { markToolashaSurface, SURFACE_ATTRIBUTE, SURFACE_KINDS } from './surface-marker.js';

describe('markToolashaSurface', () => {
    test('stamps the attribute text-appearance selects on', () => {
        const el = document.createElement('div');
        expect(markToolashaSurface(el, 'modal')).toBe(el);
        expect(el.getAttribute(SURFACE_ATTRIBUTE)).toBe('modal');
        expect(SURFACE_ATTRIBUTE).toBe('data-toolasha-surface');
    });

    test('defaults to a panel and re-marking replaces the kind', () => {
        const el = document.createElement('div');
        markToolashaSurface(el);
        expect(el.getAttribute(SURFACE_ATTRIBUTE)).toBe('panel');
        markToolashaSurface(el, 'popover');
        expect(el.getAttribute(SURFACE_ATTRIBUTE)).toBe('popover');
    });

    test('tolerates a missing element and a stand-in without setAttribute', () => {
        expect(markToolashaSurface(null)).toBeNull();
        expect(markToolashaSurface(undefined)).toBeUndefined();
        const plain = {};
        expect(markToolashaSurface(plain)).toBe(plain);
    });

    test('names the four kinds', () => {
        expect(SURFACE_KINDS).toEqual(['panel', 'popover', 'modal', 'dialog']);
    });
});
