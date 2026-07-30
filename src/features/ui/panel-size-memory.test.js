/**
 * Tests for the panel size memory's pure parts: reading inline size styles,
 * building and resolving structural paths, and layout fingerprinting.
 *
 * The suite runs without a DOM, so these use minimal element stubs covering the
 * surface the functions actually touch — tagName, className, parentElement,
 * children and an inline style declaration list.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: vi.fn() } }));
vi.mock('../../core/storage.js', () => ({ default: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { register: vi.fn() } }));

const { readSizeStyles, buildElementPath, resolveElementPath, elementSignature } =
    await import('./panel-size-memory.js');

/**
 * Minimal stand-in for an element's inline style declaration list.
 * @param {Object} declarations - property → value
 * @returns {Object} CSSStyleDeclaration-like object
 */
function styleOf(declarations = {}) {
    const entries = Object.entries(declarations);
    const style = {
        length: entries.length,
        getPropertyValue: (property) => declarations[property] ?? '',
        setProperty: (property, value) => {
            declarations[property] = value;
        },
    };
    entries.forEach(([property], index) => {
        style[index] = property;
    });
    return style;
}

/**
 * Minimal element stub.
 * @param {string} tag - Tag name
 * @param {Object} [options] - { className, style, children }
 * @returns {Object} Element-like object
 */
function el(tag, { className = '', style = {}, children = [] } = {}) {
    const node = {
        tagName: tag.toUpperCase(),
        className,
        style: styleOf(style),
        children,
        parentElement: null,
    };
    for (const child of children) child.parentElement = node;
    return node;
}

describe('readSizeStyles', () => {
    test('keeps size declarations and custom properties', () => {
        const node = el('div', {
            style: { width: '420px', 'flex-basis': '30%', '--sidebar-width': '18rem' },
        });

        expect(readSizeStyles(node)).toEqual({
            width: '420px',
            'flex-basis': '30%',
            '--sidebar-width': '18rem',
        });
    });

    test('ignores styles unrelated to size', () => {
        const node = el('div', { style: { color: 'red', transform: 'translateX(4px)' } });
        expect(readSizeStyles(node)).toEqual({});
    });

    test('survives a missing element', () => {
        expect(readSizeStyles(null)).toEqual({});
    });
});

describe('element paths', () => {
    test('round-trips an element through its path', () => {
        const target = el('span');
        const section = el('section', { children: [el('span'), target] });
        const root = el('div', { children: [el('div'), section] });

        const path = buildElementPath(target, root);
        expect(path).toBe('section:nth-of-type(1)>span:nth-of-type(2)');
        expect(resolveElementPath(path, root)).toBe(target);
    });

    test('counts position among same-tag siblings only', () => {
        const target = el('div');
        const root = el('div', { children: [el('div'), el('span'), target] });

        expect(buildElementPath(target, root)).toBe('div:nth-of-type(2)');
    });

    test('does not depend on class names', () => {
        const target = el('aside', { className: 'Panel_side__a1b2' });
        const root = el('div', { children: [target] });
        const path = buildElementPath(target, root);

        // A game update that rewrites the hashed class must not break the path
        target.className = 'Panel_side__z9y8';
        expect(resolveElementPath(path, root)).toBe(target);
    });

    test('returns null for an element outside the root', () => {
        expect(buildElementPath(el('div'), el('div', { children: [] }))).toBe(null);
    });

    test('resolves to null when the layout no longer has that position', () => {
        const second = el('span');
        const section = el('section', { children: [el('span'), second] });
        const root = el('div', { children: [section] });
        const path = buildElementPath(second, root);

        section.children = [el('span')];
        expect(resolveElementPath(path, root)).toBe(null);
    });

    test('rejects a malformed path instead of guessing', () => {
        const root = el('div', { children: [el('div')] });
        expect(resolveElementPath('div.some-class', root)).toBe(null);
        expect(resolveElementPath('', root)).toBe(null);
    });
});

describe('elementSignature', () => {
    test('ignores the generated hash suffix', () => {
        const a = el('div', { className: 'MainPanel_container__1i-H9 Flex_row__2Ab3' });
        const b = el('div', { className: 'MainPanel_container__ZZZZ9 Flex_row__QQ11' });

        expect(elementSignature(a)).toBe(elementSignature(b));
    });

    test('separates genuinely different elements', () => {
        const a = el('div', { className: 'MainPanel_container__1i-H9' });
        const b = el('div', { className: 'ChatPanel_container__1i-H9' });

        expect(elementSignature(a)).not.toBe(elementSignature(b));
    });

    test('distinguishes tags with no classes', () => {
        expect(elementSignature(el('aside'))).not.toBe(elementSignature(el('div')));
    });

    test('survives a missing element', () => {
        expect(elementSignature(null)).toBe('');
    });
});
