/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ORB_ITEMS, REROLL_MODIFIERS, TALISMAN_INFO, talismanRow } from '../../__fixtures__/talisman-reroll.js';

// Required lines: the checkbox on each wanted-line row, the K selector floor, and aimAt carrying the flag

const game = vi.hoisted(() => ({
    server: true,
    setting: true,
    talismans: [],
    shown: null,
    prices: {},
    onClass: null,
    handlers: new Map(),
}));

vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => game.server,
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => game.setting } }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _cls, callback) => {
            game.onClass = callback;
            return () => {
                game.onClass = null;
            };
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 32030,
        getCharacterTalismans: () => game.talismans,
        getInitClientData: () => ({
            talismanInfo: TALISMAN_INFO,
            talismanModifierDetailMap: REROLL_MODIFIERS,
            itemDetailMap: ORB_ITEMS,
        }),
        on: (event, handler) => game.handlers.set(event, handler),
        off: (event) => game.handlers.delete(event),
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid) => game.prices[hrid] || { price: null, source: null, estimated: false },
}));
// The window's React component carries the talisman as a prop, a few fibers above the window element
vi.mock('../../utils/react-click.js', () => ({
    clickThroughReact: () => 'none',
    fiberFor: () => ({
        memoizedProps: { className: 'x' },
        return: { memoizedProps: {}, return: { memoizedProps: { talisman: game.shown }, return: null } },
    }),
}));

// A talisman under four lines also solves the line counts the cores can add: a few picks take longer
vi.setConfig({ testTimeout: 30000 });

const { default: feature, describeAdvice, setRerollTarget } = await import('./talisman-reroll-advisor.js');

const M = (name) => `/talisman_modifiers/${name}`;
const line = (name, grade) => ({ hrid: M(name), grade });
const BLANK = [line('smite', 1), line('ability_damage', 1), line('ability_haste', 1)];

function openWindow(talisman) {
    game.talismans = [talisman];
    game.shown = talisman;
    document.body.innerHTML =
        '<div class="TalismanModal_talismanModal__1ocVR"><section></section><div class="TalismanModal_footer__23MOl"></div></div>';
    const modal = document.body.firstElementChild;
    feature.initialize();
    game.onClass?.(modal);
    vi.advanceTimersByTime(200);
    return modal;
}

const panel = () => document.querySelector('.toolasha-reroll-advisor');
const moveText = () => panel()?.querySelector('.toolasha-reroll-advisor-move')?.textContent;
const needSelect = () => panel().querySelector('.toolasha-reroll-advisor-need');
const needRow = () => panel().querySelector('.toolasha-reroll-advisor-need-row');

function pick(row, hrid, grade) {
    const types = panel().querySelectorAll('.toolasha-reroll-advisor-type');
    const grades = panel().querySelectorAll('.toolasha-reroll-advisor-grade');
    types[row].value = hrid;
    grades[row].value = String(grade);
    types[row].dispatchEvent(new Event('change'));
    vi.advanceTimersByTime(200);
    // The solve runs in slices; let them and the redraw finish
    vi.runAllTimers();
}

function chooseNeed(value) {
    needSelect().value = String(value);
    needSelect().dispatchEvent(new Event('change'));
    vi.advanceTimersByTime(200);
    vi.runAllTimers();
}

beforeEach(() => {
    vi.useFakeTimers();
    game.server = true;
    game.setting = true;
    game.prices = {};
});

afterEach(() => {
    feature.disable();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

const requiredBoxes = () => [...panel().querySelectorAll('.toolasha-reroll-advisor-required')];

function tick(row, on = true) {
    const box = requiredBoxes()[row];
    box.checked = on;
    box.dispatchEvent(new Event('change'));
    vi.advanceTimersByTime(200);
    vi.runAllTimers();
}

const POOL4 = [
    { hrid: M('armor'), minGrade: 3 },
    { hrid: M('melee_evasion'), minGrade: 3 },
    { hrid: M('melee_accuracy'), minGrade: 3 },
    { hrid: M('smite'), minGrade: 3 },
];

describe('the required checkbox', () => {
    test('every row has one, unticked; ticking one stores the flag on that line only', () => {
        openWindow(talismanRow(1, BLANK));
        expect(requiredBoxes()).toHaveLength(6);
        expect(requiredBoxes().every((b) => !b.checked)).toBe(true);
        pick(0, M('armor'), 3);
        pick(1, M('melee_evasion'), 3);
        pick(2, M('melee_accuracy'), 3);
        tick(0);
        expect(feature.getTargets({ id: 1 })).toEqual([
            { hrid: M('armor'), minGrade: 3, required: true },
            { hrid: M('melee_evasion'), minGrade: 3 },
            { hrid: M('melee_accuracy'), minGrade: 3 },
        ]);
        tick(0, false);
        expect(feature.getTargets({ id: 1 }).some((t) => 'required' in t)).toBe(false);
    });

    test('the K selector starts at the required count and keeps K from falling below it', () => {
        openWindow(talismanRow(1, BLANK));
        pick(0, M('armor'), 3);
        pick(1, M('melee_evasion'), 3);
        pick(2, M('melee_accuracy'), 3);
        chooseNeed(1);
        expect([...needSelect().options].map((o) => o.value)).toEqual(['1', '2', '3']);
        tick(0);
        tick(1);
        expect([...needSelect().options].map((o) => o.value)).toEqual(['2', '3']);
        // K was 1: shown (and solved) at the floor
        expect(needSelect().value).toBe('2');
        chooseNeed(1);
        expect(feature.getNeed({ id: 1 })).toBe(2);
    });

    test('every line required: no K to choose', () => {
        openWindow(talismanRow(1, BLANK));
        pick(0, M('armor'), 3);
        pick(1, M('melee_evasion'), 3);
        tick(0);
        tick(1);
        expect(needRow().style.display).toBe('none');
        expect(moveText()).not.toMatch(/^Target met/);
    });

    test('a required line that cannot roll here is not reachable, with its name', () => {
        openWindow(talismanRow(1, BLANK));
        // The picker only offers this type's lines, so the aim path is how a foreign line gets in
        setRerollTarget(1, [
            { hrid: M('armor'), minGrade: 3 },
            { hrid: M('milking_speed'), minGrade: 1, required: true },
        ]);
        vi.runAllTimers();
        expect(moveText()).toContain('is marked required, but it cannot roll on this talisman type');
    });

    test('a met target needs the required line: K other lines without it still has a move', () => {
        const held = [line('melee_evasion', 3), line('melee_accuracy', 3), line('smite', 1)];
        openWindow(talismanRow(1, held));
        pick(0, M('armor'), 3);
        pick(1, M('melee_evasion'), 3);
        pick(2, M('melee_accuracy'), 3);
        chooseNeed(2);
        expect(moveText()).toBe('Target met. Nothing to do.');
        tick(0);
        expect(moveText()).not.toBe('Target met. Nothing to do.');
    });

    test('Clear drops the flags', () => {
        openWindow(talismanRow(1, BLANK));
        pick(0, M('armor'), 3);
        tick(0);
        panel().querySelector('.toolasha-reroll-advisor-clear').click();
        vi.runAllTimers();
        expect(requiredBoxes().every((b) => !b.checked)).toBe(true);
        expect(feature.getTargets({ id: 1 })).toEqual([]);
    });
});

describe('aimAt with required lines', () => {
    test('the flag and K are kept and shown, and a talisman not owned keeps nothing', () => {
        openWindow(talismanRow(5, BLANK));
        const pool = POOL4.map((t, i) => (i < 2 ? { ...t, required: true } : t));
        expect(setRerollTarget(5, pool, 3)).toBe(true);
        vi.runAllTimers();
        expect(feature.getTargets({ id: 5 })).toEqual(pool);
        expect(feature.getNeed({ id: 5 })).toBe(3);
        expect(requiredBoxes().map((b) => b.checked)).toEqual([true, true, false, false, false, false]);
        expect(needSelect().value).toBe('3');
        expect(setRerollTarget(999, pool, 3)).toBe(false);
        expect(feature.getTargets({ id: 999 })).toEqual([]);
    });

    test('a flag other than true is dropped; six lines are taken, a seventh is not', () => {
        openWindow(talismanRow(5, BLANK));
        const names = Object.keys(REROLL_MODIFIERS).filter((h) => REROLL_MODIFIERS[h].weight > 0);
        const seven = names.slice(0, 7).map((hrid, i) => ({ hrid, minGrade: 1, required: i === 0 ? 'yes' : false }));
        setRerollTarget(5, seven, 2);
        const kept = feature.getTargets({ id: 5 });
        expect(kept).toHaveLength(6);
        expect(kept.some((t) => 'required' in t)).toBe(false);
    });
});

describe('describeAdvice for required lines', () => {
    const names = { item: (h) => h, modifier: (h) => `<${h}>`, lineCount: 4 };

    test('a required line above the grade cap', () => {
        const text = describeAdvice(
            { build: { status: 'impossible', reason: 'requiredNotRollable', cause: 'gradeAboveCap', hrid: 'a' } },
            names
        );
        expect(text.move).toBe('Not reachable. <a> is marked required, but grades only go up to G6.');
    });

    test('a pool over the limit', () => {
        const text = describeAdvice(
            { build: { status: 'impossible', reason: 'poolTooLarge', rollable: 7, max: 6 } },
            names
        );
        expect(text.move).toContain('at most 6');
    });
});

describe('describeAdvice for a pool over the state ceiling', () => {
    test('says to drop a line or lower a grade', () => {
        const text = describeAdvice(
            { build: { status: 'impossible', reason: 'tooManyStates', rollable: 6, states: 289290, max: 150000 } },
            { item: (h) => h, modifier: (h) => h, lineCount: 4 }
        );
        expect(text.move).toBe('Not reachable. Too many lines at this grade (6 lines): drop a line or lower a grade.');
    });
});
