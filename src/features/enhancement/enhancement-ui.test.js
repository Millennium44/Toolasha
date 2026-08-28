/**
 * @vitest-environment happy-dom
 *
 * The Enhancement Tracker panel's header, exercised rather than reasoned about.
 *
 * A user reported the header title wrapping to two lines with a session
 * indicator clipped to "(2" right after it — the indicator was assigned its
 * full text correctly, it just didn't fit next to six control buttons. No
 * arithmetic test catches a layout squeeze; only building the header does.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ sessions: {} }));
const settings = vi.hoisted(() => ({}));

vi.mock('./enhancement-tracker.js', () => ({
    default: {
        getAllSessions: () => game.sessions,
        clearSessions: async () => {
            game.sessions = {};
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: {} }),
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: (key) => settings[key],
        onSettingChange: () => {},
        offSettingChange: () => {},
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        register: () => () => {},
    },
}));

// Geometry is held in IndexedDB, which is not what this file is about.
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: () => Promise.resolve(),
    saveGeometry: () => {},
    markPanelInteracted: () => {},
}));

vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => null }));

const { default: enhancementUI } = await import('./enhancement-ui.js');

/** A minimal session, shaped like what `enhancementTracker.getAllSessions()` hands back. */
function sessionFixture(overrides = {}) {
    return {
        id: 's1',
        itemHrid: '/items/foo',
        itemName: 'Foo',
        startLevel: 0,
        targetLevel: 10,
        state: 'tracking',
        totalAttempts: 3,
        totalSuccesses: 2,
        totalFailures: 1,
        totalBlessed: 0,
        protectionCount: 0,
        totalCost: 100,
        totalXP: 0,
        ...overrides,
    };
}

afterEach(() => {
    enhancementUI.cleanup();
    document.body.innerHTML = '';
    game.sessions = {};
});

describe('header layout', () => {
    test('the title does not wrap and the session indicator carries its full text', () => {
        game.sessions = { s1: sessionFixture(), s2: sessionFixture({ id: 's2' }) };
        enhancementUI.currentViewingIndex = 1;

        const panel = enhancementUI.createFloatingUI();
        enhancementUI.updateSessionCounter();

        const header = panel.querySelector('#enhancementPanelHeader');
        const title = header.querySelector('span');
        expect(title.textContent).toBe('Enhancement Tracker');
        // Never wraps to a second line — it ellipsizes instead if the panel
        // is ever narrower than the title, rather than breaking the header.
        expect(title.style.whiteSpace).toBe('nowrap');

        const counter = document.getElementById('enhancementSessionCounter');
        // This is the exact string that used to render as "(2" — clipped by
        // the row it shared with the ◀ ▶ Σ ⧉ ▼ 🗑 buttons.
        expect(counter.textContent).toBe('(2/2)');
        expect(counter.style.display).not.toBe('none');

        // The indicator is on its own row under the title/controls row, not
        // squeezed into it — that's the actual fix for the clipping.
        expect(header.children.length).toBe(2);
        expect(header.children[1]).toBe(counter);
    });

    test('the indicator is hidden rather than left as an empty gap with no sessions', () => {
        const panel = enhancementUI.createFloatingUI();
        enhancementUI.updateSessionCounter();

        const counter = panel.querySelector('#enhancementSessionCounter');
        expect(counter.textContent).toBe('');
        expect(counter.style.display).toBe('none');
    });

    test('the merge-mode indicator also gets its full text', () => {
        game.sessions = { s1: sessionFixture(), s2: sessionFixture({ id: 's2' }) };
        enhancementUI.mergeMode = true;
        enhancementUI.mergeSelected = new Set(['s1']);

        enhancementUI.createFloatingUI();
        enhancementUI.updateSessionCounter();

        expect(document.getElementById('enhancementSessionCounter').textContent).toBe('(merge 1/2)');
    });
});
