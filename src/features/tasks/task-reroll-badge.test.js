/** @vitest-environment happy-dom */
/**
 * The reroll spend badge's arithmetic, and the one piece of wiring that is not
 * arithmetic: whether the badge appears on a Tasks panel that is already open.
 *
 * The one thing worth getting wrong here is scope: the live map keeps a
 * just-retired task for a grace window (see `task-reroll-tracker.js`), and a
 * sum that did not filter by the active id set would count it twice — once on
 * its own card before it left, and again in the badge after.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'taskRerollSpendBadge',
        onSettingChange: () => {},
        COLOR_LOSS: '#ef4444',
    },
}));
// The observer reports elements that *appear*; a no-op here is exactly the
// production behaviour for a panel that was already on the page.
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterQuests() {
            return board.quests;
        },
    },
}));

const board = { quests: [] };

const {
    default: taskRerollBadge,
    sumBoardRerollSpend,
    formatRerollSpendBadge,
} = await import('./task-reroll-badge.js');

describe('sumBoardRerollSpend', () => {
    test('sums gold and cowbells across the active tasks only', () => {
        const taskRerollData = new Map([
            [1, { coinRerollCount: 2, cowbellRerollCount: 0 }], // 10K + 20K = 30K
            [2, { coinRerollCount: 0, cowbellRerollCount: 2 }], // 1 + 2 = 3
            [3, { coinRerollCount: 5, cowbellRerollCount: 5 }], // retired, not counted
        ]);
        const activeIds = new Set([1, 2]);

        expect(sumBoardRerollSpend(taskRerollData, activeIds)).toEqual({ gold: 30000, cowbells: 3 });
    });

    test('a task with no reroll data yet contributes nothing', () => {
        const taskRerollData = new Map([[1, { coinRerollCount: 0, cowbellRerollCount: 0 }]]);
        expect(sumBoardRerollSpend(taskRerollData, new Set([1]))).toEqual({ gold: 0, cowbells: 0 });
    });

    test('an empty board is zero, not a throw', () => {
        expect(sumBoardRerollSpend(new Map(), new Set())).toEqual({ gold: 0, cowbells: 0 });
        expect(sumBoardRerollSpend(null, null)).toEqual({ gold: 0, cowbells: 0 });
    });
});

describe('formatRerollSpendBadge', () => {
    test('nothing spent draws nothing', () => {
        expect(formatRerollSpendBadge({ gold: 0, cowbells: 0 })).toBe('');
    });

    test('gold only', () => {
        expect(formatRerollSpendBadge({ gold: 30000, cowbells: 0 })).toBe('Rerolls: 30.0K\u{1f4b0}');
    });

    test('cowbells only', () => {
        expect(formatRerollSpendBadge({ gold: 0, cowbells: 3 })).toBe('Rerolls: 3\u{1f514}');
    });

    test('both currencies, cowbells first', () => {
        expect(formatRerollSpendBadge({ gold: 30000, cowbells: 3 })).toBe('Rerolls: 3\u{1f514} + 30.0K\u{1f4b0}');
    });
});

describe('appearing on a panel that is already open', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        board.quests = [];
        taskRerollBadge.disable();
    });

    test('initialize() draws onto a task slot count that is already on the page', () => {
        // domObserver.onClass only fires for elements that appear after
        // registration — it does not scan the existing DOM. Ticking the setting
        // on while the Tasks panel is open is therefore an initialize() with
        // nothing to react to, and without an immediate pass the badge stays
        // missing until the panel is navigated away from and back.
        const header = document.createElement('div');
        header.className = 'TasksPanel_taskSlotCount__abc';
        document.body.appendChild(header);

        taskRerollBadge.initialize();

        expect(header.querySelector('.toolasha-reroll-spend-badge')).not.toBeNull();
    });
});
