/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Geometry lives in IndexedDB and is never what these tests are about
vi.mock('./panel-geometry.js', () => ({
    restoreGeometry: vi.fn(),
    saveGeometry: vi.fn(),
}));

vi.mock('./panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
    bringPanelToFront: vi.fn(),
}));

vi.mock('./floating-panel.js', () => ({
    makeDraggable: vi.fn(() => vi.fn()),
    makeResizable: vi.fn(() => vi.fn()),
}));

const { createPanel, panelCard, panelLine, panelNote } = await import('./simple-panel.js');

const SIZE = { width: 300, height: 200 };

describe('createPanel', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('toggle opens and closes', () => {
        const panel = createPanel({ id: 'test', title: 'Test', size: SIZE, draw: (body) => body.append('hello') });

        panel.toggle();
        expect(document.getElementById('toolasha-test-panel')).toBeTruthy();
        expect(panel.panel.textContent).toContain('hello');

        panel.toggle();
        expect(document.getElementById('toolasha-test-panel')).toBeNull();
        expect(panel.panel).toBeNull();
    });

    test('showing an open panel raises it rather than opening a second one', () => {
        const panel = createPanel({ id: 'twice', title: 'Twice', size: SIZE, draw: () => {} });

        panel.show();
        panel.show();
        expect(document.querySelectorAll('#toolasha-twice-panel')).toHaveLength(1);
        panel.hide();
    });

    test('a draw that throws says so instead of leaving an empty panel', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const panel = createPanel({
            id: 'broken',
            title: 'Broken',
            size: SIZE,
            draw: () => {
                throw new Error('no data');
            },
        });

        panel.show();
        expect(panel.panel.textContent).toContain('could not be drawn');
        expect(panel.panel.textContent).toContain('no data');

        panel.hide();
        spy.mockRestore();
    });

    test('closing stops the refresh, so a hidden panel does no work', () => {
        const draw = vi.fn();
        const panel = createPanel({ id: 'timer', title: 'Timer', size: SIZE, refreshMs: 1000, draw });

        panel.show();
        vi.advanceTimersByTime(3000);
        const drawsWhileOpen = draw.mock.calls.length;
        expect(drawsWhileOpen).toBeGreaterThan(1);

        panel.hide();
        vi.advanceTimersByTime(10_000);
        expect(draw).toHaveBeenCalledTimes(drawsWhileOpen);
    });

    test('a control being used is not rebuilt under the pointer', () => {
        // A refresh rebuilds the body, and rebuilding a select closes its
        // dropdown — scroll a long list for a few seconds and it shuts under you
        const panel = createPanel({
            id: 'busy',
            title: 'Busy',
            size: SIZE,
            refreshMs: 1000,
            draw: (body) => body.appendChild(document.createElement('select')),
        });
        panel.show();

        const select = panel.panel.querySelector('select');
        select.focus();
        vi.advanceTimersByTime(5000);

        // Same element, so nothing was torn down and rebuilt
        expect(panel.panel.querySelector('select')).toBe(select);

        select.blur();
        vi.advanceTimersByTime(1000);
        expect(panel.panel.querySelector('select')).not.toBe(select);
        panel.hide();
    });

    test('the close button closes it', () => {
        const panel = createPanel({ id: 'close', title: 'Close', size: SIZE, draw: () => {} });
        panel.show();

        panel.panel.querySelector('button').click();
        expect(document.getElementById('toolasha-close-panel')).toBeNull();
    });

    test('render on a closed panel is a no-op rather than a crash', () => {
        const draw = vi.fn();
        const panel = createPanel({ id: 'closed', title: 'Closed', size: SIZE, draw });

        expect(() => panel.render()).not.toThrow();
        expect(draw).not.toHaveBeenCalled();
    });
});

describe('panel pieces', () => {
    test('a card appends itself and returns somewhere to put lines', () => {
        const body = document.createElement('div');
        const card = panelCard(body, 'Heading');

        expect(body.children).toHaveLength(1);
        card.appendChild(panelLine('Fights', '12'));
        expect(card.textContent).toContain('Heading');
        expect(card.textContent).toContain('Fights');
        expect(card.textContent).toContain('12');
    });

    test('a note is plain text with nothing to read into it', () => {
        expect(panelNote('Nothing cast yet.').textContent).toBe('Nothing cast yet.');
    });
});
