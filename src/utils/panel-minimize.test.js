/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// The geometry store is IndexedDB and never what these tests are about.
const geo = vi.hoisted(() => ({ collapsed: {}, sizes: {}, saved: [] }));
vi.mock('./panel-geometry.js', () => ({
    saveCollapsed: vi.fn(async (key, value) => {
        geo.saved.push({ key, value });
        geo.collapsed[key] = value;
    }),
    wasCollapsed: vi.fn(async (key) => Boolean(geo.collapsed[key])),
    savedSize: vi.fn(async (key) => geo.sizes[key] || null),
}));

import { attachMinimize } from './panel-minimize.js';

/** Build a panel with a header (close button) and one or more body children. */
function buildPanel({ bodies = 1, withGrip = false } = {}) {
    const panel = document.createElement('div');
    panel.style.height = '400px';
    const header = document.createElement('div');
    const close = document.createElement('button');
    close.textContent = '✕';
    header.appendChild(close);
    panel.appendChild(header);

    const bodyEls = [];
    for (let i = 0; i < bodies; i++) {
        const b = document.createElement('div');
        b.style.display = 'flex';
        panel.appendChild(b);
        bodyEls.push(b);
    }
    if (withGrip) {
        const grip = document.createElement('div');
        grip.className = 'toolasha-resize-grip';
        panel.appendChild(grip);
    }
    document.body.appendChild(panel);
    return { panel, header, close, bodyEls };
}

describe('attachMinimize', () => {
    beforeEach(() => {
        geo.collapsed = {};
        geo.sizes = {};
        geo.saved = [];
    });
    afterEach(() => {
        document.body.replaceChildren();
    });

    test('inserts a minimize button just before the close button', () => {
        const { header, close, bodyEls } = buildPanel();
        const ctl = attachMinimize({
            panel: header.parentNode,
            header,
            body: bodyEls[0],
            panelKey: 'k',
            beforeEl: close,
        });
        expect(ctl.button.previousSibling).toBe(null); // it's first
        expect(ctl.button.nextSibling).toBe(close);
    });

    test('collapsing hides the body, folds the panel, and flips the glyph', () => {
        const { panel, header, close, bodyEls } = buildPanel({ withGrip: true });
        const ctl = attachMinimize({ panel, header, body: bodyEls[0], panelKey: 'k', beforeEl: close });

        ctl.button.click();

        expect(ctl.collapsed).toBe(true);
        expect(bodyEls[0].style.display).toBe('none');
        expect(panel.style.height).toBe('auto');
        expect(panel.style.minHeight).toBe('0');
        expect(panel.dataset.minimized).toBe('true');
        expect(panel.querySelector('.toolasha-resize-grip').style.display).toBe('none');
        expect(geo.saved.at(-1)).toEqual({ key: 'k', value: true });
    });

    test('expanding restores the body display, height, and grip', () => {
        const { panel, header, close, bodyEls } = buildPanel({ withGrip: true });
        const ctl = attachMinimize({ panel, header, body: bodyEls[0], panelKey: 'k', beforeEl: close });

        ctl.button.click(); // collapse
        ctl.button.click(); // expand

        expect(ctl.collapsed).toBe(false);
        expect(bodyEls[0].style.display).toBe('flex');
        expect(panel.style.height).toBe('400px');
        expect(panel.querySelector('.toolasha-resize-grip').style.display).toBe('');
        expect(geo.saved.at(-1)).toEqual({ key: 'k', value: false });
    });

    test('restores the display each body actually had at collapse time (tabbed panels)', () => {
        const { panel, header, close, bodyEls } = buildPanel({ bodies: 2 });
        // Second body is a hidden tab when the user minimizes.
        bodyEls[1].style.display = 'none';
        const ctl = attachMinimize({
            panel,
            header,
            body: [bodyEls[0], bodyEls[1]],
            panelKey: 'k',
            beforeEl: close,
        });

        ctl.button.click(); // collapse
        expect(bodyEls[0].style.display).toBe('none');
        expect(bodyEls[1].style.display).toBe('none');

        ctl.button.click(); // expand
        expect(bodyEls[0].style.display).toBe('flex'); // was visible
        expect(bodyEls[1].style.display).toBe('none'); // stays the hidden tab
    });

    test('restores the persisted collapsed state on attach', async () => {
        geo.collapsed['k'] = true;
        geo.sizes['k'] = { height: 350 };
        const { panel, header, close, bodyEls } = buildPanel();
        const ctl = attachMinimize({ panel, header, body: bodyEls[0], panelKey: 'k', beforeEl: close });

        // The restore is fire-and-forget; let its microtasks settle.
        await vi.waitFor(() => expect(ctl.collapsed).toBe(true));
        expect(bodyEls[0].style.display).toBe('none');
        // Reopening from persisted state should not re-persist.
        expect(geo.saved).toHaveLength(0);

        ctl.button.click(); // expand — springs back to the stored size
        expect(panel.style.height).toBe('350px');
    });

    test('restore:false leaves a persisted-collapsed panel expanded', async () => {
        geo.collapsed['k'] = true;
        const { panel, header, close, bodyEls } = buildPanel();
        const ctl = attachMinimize({
            panel,
            header,
            body: bodyEls[0],
            panelKey: 'k',
            beforeEl: close,
            restore: false,
        });
        await Promise.resolve();
        expect(ctl.collapsed).toBe(false);
        expect(bodyEls[0].style.display).toBe('flex');
    });

    test('destroy removes the button', () => {
        const { panel, header, close, bodyEls } = buildPanel();
        const ctl = attachMinimize({ panel, header, body: bodyEls[0], panelKey: 'k', beforeEl: close });
        expect(header.contains(ctl.button)).toBe(true);
        ctl.destroy();
        expect(header.contains(ctl.button)).toBe(false);
    });
});
