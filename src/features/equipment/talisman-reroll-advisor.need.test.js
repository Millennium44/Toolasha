/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ORB_ITEMS, REROLL_MODIFIERS, TALISMAN_INFO, talismanRow } from '../../__fixtures__/talisman-reroll.js';

// "Need any K of these": the advisor's pool of wanted lines and how many of them are needed

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
const detailText = () => panel()?.querySelector('.toolasha-reroll-advisor-detail')?.textContent;
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

describe('the need any K selector', () => {
    test('hidden until two lines are picked, then 1..pool size with the pool size as default', () => {
        openWindow(talismanRow(1, BLANK));
        expect(needRow().style.display).toBe('none');
        pick(0, M('armor'), 3);
        expect(needRow().style.display).toBe('none');
        pick(1, M('melee_evasion'), 3);
        expect(needRow().style.display).toBe('');
        expect([...needSelect().options].map((o) => o.value)).toEqual(['1', '2']);
        expect(needSelect().value).toBe('2');
        pick(2, M('melee_accuracy'), 3);
        expect([...needSelect().options].map((o) => o.value)).toEqual(['1', '2', '3']);
        // Still following the pool size, since K was never chosen
        expect(needSelect().value).toBe('3');
    });

    test('a smaller K is kept when a row is added, and clamps when the pool shrinks below it', () => {
        openWindow(talismanRow(1, BLANK));
        pick(0, M('armor'), 3);
        pick(1, M('melee_evasion'), 3);
        pick(2, M('melee_accuracy'), 3);
        chooseNeed(2);
        expect(feature.getNeed({ id: 1 })).toBe(2);
        pick(3, M('smite'), 1);
        expect(needSelect().value).toBe('2');
        pick(3, '', 1);
        pick(2, '', 1);
        pick(1, '', 1);
        // A pool of one: the selector is hidden and K is moot
        expect(needRow().style.display).toBe('none');
        pick(1, M('melee_evasion'), 3);
        expect(needSelect().value).toBe('2');
    });

    test('choosing the pool size goes back to following it', () => {
        openWindow(talismanRow(1, BLANK));
        pick(0, M('armor'), 3);
        pick(1, M('melee_evasion'), 3);
        chooseNeed(1);
        expect(feature.getNeed({ id: 1 })).toBe(1);
        chooseNeed(2);
        expect(feature.getNeed({ id: 1 })).toBeNull();
    });

    test('Use current lines and Clear put K back to every line', () => {
        openWindow(talismanRow(1, [line('armor', 3), line('melee_evasion', 2), line('smite', 1)]));
        pick(0, M('armor'), 3);
        pick(1, M('melee_evasion'), 3);
        chooseNeed(1);
        panel().querySelector('.toolasha-reroll-advisor-use-current').click();
        vi.runAllTimers();
        expect(feature.getNeed({ id: 1 })).toBeNull();
        chooseNeed(2);
        chooseNeed(1);
        panel().querySelector('.toolasha-reroll-advisor-clear').click();
        vi.runAllTimers();
        expect(feature.getNeed({ id: 1 })).toBeNull();
        expect(moveText()).toBe('Pick up to six lines you want.');
    });
});

describe('what each outcome shows', () => {
    const pool = (modifiers, need) => {
        openWindow(talismanRow(1, modifiers));
        pick(0, M('armor'), 3);
        pick(1, M('melee_evasion'), 3);
        pick(2, M('melee_accuracy'), 3);
        if (need) chooseNeed(need);
    };

    test('K met by the current lines says so; every-line does not', () => {
        pool([line('armor', 3), line('melee_evasion', 4), line('smite', 1)]);
        expect(moveText()).not.toBe('Target met. Nothing to do.');
        chooseNeed(2);
        expect(moveText()).toBe('Target met. Nothing to do.');
        chooseNeed(1);
        expect(moveText()).toBe('Target met. Nothing to do.');
    });

    test('a grade just below the minimum is not met', () => {
        pool([line('armor', 3), line('melee_evasion', 2), line('smite', 1)], 2);
        expect(moveText()).not.toBe('Target met. Nothing to do.');
    });

    test('a pending roll that brings the talisman to K is to be used', () => {
        pool([line('smite', 1), line('ability_haste', 1), line('armor', 3)], 2);
        game.shown = {
            ...game.shown,
            pendingModifiers: [line('armor', 3), line('melee_evasion', 3), line('smite', 1)],
        };
        feature.schedule();
        vi.runAllTimers();
        expect(moveText()).toBe('Use New Roll: it meets the target.');
    });

    test('K - 1 held: advice is a move, and a different K is a different answer (the cache key carries K)', () => {
        pool([line('armor', 3), line('smite', 1), line('ability_haste', 1)], 3);
        const all = detailText();
        chooseNeed(2);
        expect(moveText()).toMatch(/^Next: /);
        expect(detailText()).not.toBe(all);
    });

    test('unreachable: too few of the pool can roll on this talisman type', () => {
        openWindow(talismanRow(1, BLANK));
        // Skilling lines cannot roll on a combat talisman; only an aim from outside can name them
        const pool = [
            { hrid: M('skilling_speed'), minGrade: 1 },
            { hrid: M('armor'), minGrade: 3 },
            { hrid: M('smite'), minGrade: 1 },
        ];
        // One rollable line is enough for K = 1, two for K = 2
        setRerollTarget(1, pool.slice(0, 2), 1);
        vi.runAllTimers();
        expect(moveText()).toMatch(/^Next: /);
        setRerollTarget(1, pool, 2);
        vi.runAllTimers();
        expect(moveText()).toMatch(/^Next: /);
        // Needing every line names the first that cannot roll, as before
        setRerollTarget(1, pool);
        vi.runAllTimers();
        expect(moveText()).toBe('Not reachable. Skilling Speed cannot roll on this talisman type.');
        setRerollTarget(1, [pool[0], { hrid: M('milking_speed'), minGrade: 1 }, pool[1]], 2);
        vi.runAllTimers();
        expect(moveText()).toBe(
            'Not reachable. Only 1 of the picked lines can roll on this talisman type at a grade the game offers, and you need 2.'
        );
    });

    test('K more than the talisman has lines', () => {
        openWindow(talismanRow(1, [line('smite', 1), line('armor', 1)]));
        pick(0, M('armor'), 3);
        pick(1, M('melee_evasion'), 3);
        pick(2, M('melee_accuracy'), 3);
        // The cores are not priced on the orbs' scale here: the add is named as required, not "not reachable"
        expect(moveText()).toBe('Next: add line 3 with 1 /items/advanced_talisman_core. The target needs 3 lines.');
        chooseNeed(2);
        expect(moveText()).toMatch(/^Next: /);
    });

    test('a type picked twice counts once', () => {
        openWindow(talismanRow(1, [line('armor', 3), line('smite', 1)]));
        pick(0, M('armor'), 3);
        pick(1, M('armor'), 3);
        expect(needRow().style.display).toBe('none');
        expect(moveText()).toBe('Target met. Nothing to do.');
    });
});

describe('aimAt and setRerollTarget with a need', () => {
    const POOL = [
        { hrid: M('armor'), minGrade: 3 },
        { hrid: M('melee_evasion'), minGrade: 3 },
        { hrid: M('melee_accuracy'), minGrade: 3 },
    ];

    test('an array alone still means every line; a K is kept and shown', () => {
        openWindow(talismanRow(5, BLANK));
        expect(setRerollTarget(5, POOL, 2)).toBe(true);
        vi.runAllTimers();
        expect(feature.getNeed({ id: 5 })).toBe(2);
        expect(needSelect().value).toBe('2');
        expect(setRerollTarget(5, POOL)).toBe(true);
        vi.runAllTimers();
        expect(feature.getNeed({ id: 5 })).toBeNull();
        expect(needSelect().value).toBe('3');
    });

    test('a refused aim leaves the need alone', () => {
        openWindow(talismanRow(5, BLANK));
        expect(setRerollTarget(999, POOL, 1)).toBe(false);
        expect(feature.getNeed({ id: 999 })).toBeNull();
    });

    test('turning the advisor off forgets the needs', () => {
        openWindow(talismanRow(5, BLANK));
        setRerollTarget(5, POOL, 1);
        feature.disable();
        expect(feature.getNeed({ id: 5 })).toBeNull();
    });
});

describe('describeAdvice for a K that cannot be met', () => {
    test('says how many lines can roll', () => {
        const names = { item: (h) => h, modifier: (h) => h, lineCount: 4 };
        const text = describeAdvice(
            { build: { status: 'impossible', reason: 'tooFewRollable', rollable: 1, need: 3 } },
            names
        );
        expect(text.move).toBe(
            'Not reachable. Only 1 of the picked lines can roll on this talisman type at a grade the game offers, and you need 3.'
        );
    });
});

describe('a target too big to solve that the lines already meet', () => {
    // Six lines wanted at G6 on a four-line talisman is 289,290 states, over the ceiling
    const SIX = ['armor', 'melee_evasion', 'melee_accuracy', 'ability_damage', 'ability_haste', 'critical_rate'].map(
        (name) => ({ hrid: M(name), minGrade: 6 })
    );
    const held = [line('armor', 6), line('melee_evasion', 6), line('smite', 1), line('ability_haste', 2)];

    test('K met by the current lines says so, not "too many lines"', () => {
        openWindow(talismanRow(7, held));
        setRerollTarget(7, SIX, 2);
        vi.runAllTimers();
        expect(moveText()).toBe('Target met. Nothing to do.');
    });

    test('a pending roll that meets K is to be used', () => {
        openWindow(talismanRow(7, [line('armor', 6), line('smite', 1), line('ability_haste', 2), line('cast_speed', 1)]));
        game.shown = { ...game.shown, pendingModifiers: [line('armor', 6), line('critical_rate', 6), line('smite', 1)] };
        setRerollTarget(7, SIX, 2);
        vi.runAllTimers();
        expect(moveText()).toBe('Use New Roll: it meets the target.');
    });

    test('K not met still says the target is too big', () => {
        openWindow(talismanRow(7, [line('armor', 6), line('smite', 1), line('ability_haste', 2), line('cast_speed', 1)]));
        setRerollTarget(7, SIX, 2);
        vi.runAllTimers();
        expect(moveText()).toMatch(/^Not reachable\. Too many lines at this grade/);
    });
});
