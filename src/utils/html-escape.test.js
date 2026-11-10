/** @vitest-environment happy-dom */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { escapeHtml } from './html-escape.js';
import { escapeText, boardTabsHTML } from './damage-board.js';
import { badgeHtml } from './calibration-badge.js';

const hostile = `<img src=x onerror="alert('x')"> & "quoted" 'single' 中文`;

afterEach(() => vi.unstubAllGlobals());

describe('shared HTML escaping', () => {
    test('escapes all markup delimiters in one pass', () => {
        expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
        expect(escapeHtml('&lt;already text&gt;')).toBe('&amp;lt;already text&amp;gt;');
    });

    test.each([
        [null, 'null'],
        [undefined, 'undefined'],
        [0, '0'],
        [false, 'false'],
        ['', ''],
    ])('preserves ordinary String coercion for %s', (input, expected) => {
        expect(escapeHtml(input)).toBe(expected);
    });

    test('works without a browser document', () => {
        vi.stubGlobal('document', undefined);
        expect(escapeHtml('<x>')).toBe('&lt;x&gt;');
    });

    test.each(['"', "'"])('round-trips text and a %s-quoted attribute without creating markup', (quote) => {
        const host = document.createElement('div');
        host.innerHTML = `<span title=${quote}${escapeHtml(hostile)}${quote}>${escapeHtml(hostile)}</span>`;
        expect(host.children).toHaveLength(1);
        expect(host.querySelector('img')).toBeNull();
        expect(host.firstElementChild.attributes).toHaveLength(1);
        expect(host.firstElementChild.title).toBe(hostile);
        expect(host.textContent).toBe(hostile);
    });
});

describe('shared utility consumers preserve rendered content', () => {
    test('damage board keeps its nullish-to-empty public helper contract', () => {
        expect(escapeText(null)).toBe('');
        expect(escapeText(undefined)).toBe('');
        expect(escapeText(0)).toBe('0');
    });

    test('damage board tab keys and labels remain literal text', () => {
        const host = document.createElement('div');
        host.innerHTML = boardTabsHTML([{ key: hostile, label: hostile }], hostile);
        const button = host.querySelector('button');
        expect(button.dataset.tab).toBe(hostile);
        expect(button.textContent).toBe(hostile);
        expect(host.querySelector('img')).toBeNull();
    });

    test('calibration badge titles and labels remain literal text', () => {
        const host = document.createElement('div');
        host.innerHTML = badgeHtml({ tone: 'neutral', title: hostile, text: hostile });
        expect(host.firstElementChild.title).toBe(hostile);
        expect(host.textContent).toBe(hostile);
        expect(host.querySelector('img')).toBeNull();
    });
});
