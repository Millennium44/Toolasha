/**
 * @vitest-environment happy-dom
 *
 * The ∑ merge view of the Enhancement Tracker panel: it follows a picked session that is still
 * running.
 *
 * The merge view was redrawn on every attempt, but its combined reading never carried a current
 * level (it stayed 0), so the per-level table marked the +0 row whatever level the item stood at
 * and could not show where a run was mid-enhancing; each redraw also threw away the pick-list's
 * scroll position.
 */

import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { createSession, SessionState } from './enhancement-session.js';

const game = vi.hoisted(() => ({ sessions: {}, merges: [], plan: null }));

vi.mock('./enhancement-tracker.js', () => ({
    default: {
        getAllSessions: () => game.sessions,
        clearSessions: async () => {
            game.sessions = {};
        },
        planMerge: (ids) => game.plan ?? { ok: false, reason: `no plan for ${ids.join(',')}` },
        mergeSessionsIntoOne: async (ids) => {
            game.merges.push(ids);
            return { ok: true, id: ids[ids.length - 1] };
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: { '/items/holy_spatula': { name: 'Holy Spatula' } } }),
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: () => false,
        getSettingValue: (key, fallback) => fallback,
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

vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: () => Promise.resolve(),
    saveGeometry: () => {},
    markPanelInteracted: () => {},
}));

vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => null }));

const { default: enhancementUI } = await import('./enhancement-ui.js');

/** Session #7 (ended at +3) and #8 (running, at +4), as the store holds them */
function spatulaRuns() {
    const seven = createSession('/items/holy_spatula', 'Holy Spatula', 0, 8, 5);
    Object.assign(seven, {
        id: 'session_7',
        state: SessionState.COMPLETED,
        startTime: 1_000_000,
        endTime: 1_600_000,
        lastUpdateTime: 1_600_000,
        currentLevel: 3,
        totalAttempts: 466,
        totalSuccesses: 200,
        totalFailures: 266,
        attemptsPerLevel: {
            0: { success: 150, fail: 200, blessed: 0, successRate: 150 / 350 },
            3: { success: 50, fail: 66, blessed: 0, successRate: 50 / 116 },
        },
    });
    const eight = createSession('/items/holy_spatula', 'Holy Spatula', 3, 8, 5);
    Object.assign(eight, {
        id: 'session_8',
        startTime: 5_000_000,
        lastUpdateTime: 5_100_000,
        currentLevel: 4,
        totalAttempts: 1,
        totalSuccesses: 1,
        attemptsPerLevel: { 3: { success: 1, fail: 0, blessed: 0, successRate: 1 } },
    });
    return { seven, eight };
}

/** The level of the highlighted (current) row, or null */
function highlightedLevel() {
    const rows = [...document.querySelectorAll('#enhancementPanelContent table tbody tr')];
    const marked = rows.filter((row) => row.getAttribute('style')?.includes('border-left'));
    return marked.length === 1 ? Number(marked[0].children[0].textContent) : null;
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    enhancementUI.cleanup();
    document.body.innerHTML = '';
    game.sessions = {};
    game.merges = [];
    game.plan = null;
    enhancementUI.mergeMode = false;
    enhancementUI.mergeSelected = new Set();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('the merge view follows a running session', () => {
    test('an attempt redraws it, marks the level the item stands at, and keeps the picks and scroll', () => {
        const { seven, eight } = spatulaRuns();
        game.sessions = { session_7: seven, session_8: eight };
        enhancementUI.mergeMode = true;
        enhancementUI.mergeSelected = new Set(['session_7', 'session_8']);
        enhancementUI.createFloatingUI();
        enhancementUI.updateUI();

        expect(highlightedLevel()).toBe(4);
        const content = document.getElementById('enhancementPanelContent');
        expect(content.textContent).toContain('467');

        content.querySelector('.enh-merge-list').scrollTop = 40;
        content.scrollTop = 120;

        // An attempt lands on #8: +4 → +5. The handler schedules a redraw, as for one session.
        eight.attemptsPerLevel[4] = { success: 1, fail: 0, blessed: 0, successRate: 1 };
        eight.totalAttempts += 1;
        eight.totalSuccesses += 1;
        eight.currentLevel = 5;
        enhancementUI.scheduleUpdate();
        vi.advanceTimersByTime(150);

        expect(content.textContent).toContain('468');
        expect(highlightedLevel()).toBe(5);
        const boxes = [...content.querySelectorAll('.enh-merge-check')];
        expect(boxes.map((box) => box.checked)).toEqual([true, true]);
        expect(content.querySelector('.enh-merge-list').scrollTop).toBe(40);
        expect(content.scrollTop).toBe(120);
    });
});
