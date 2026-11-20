/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ORB_ITEMS, REROLL_MODIFIERS, talismanRow } from '../../__fixtures__/talisman-reroll.js';

// Adding a line with cores: what the panel says for each outcome, and that Do next step never presses an add

const BASIC = '/items/basic_talisman_core';
const ADVANCED = '/items/advanced_talisman_core';
const EXPERT = '/items/expert_talisman_core';
const CORE_ITEMS = {
    [BASIC]: { hrid: BASIC, name: 'Basic Talisman Core', isTradable: true },
    [ADVANCED]: { hrid: ADVANCED, name: 'Advanced Talisman Core', isTradable: true },
    [EXPERT]: { hrid: EXPERT, name: 'Expert Talisman Core', isTradable: true },
};
const ITEMS = { ...ORB_ITEMS, ...CORE_ITEMS };

const game = vi.hoisted(() => ({
    shown: null,
    instance: null,
    onClass: null,
    handlers: new Map(),
    clicks: [],
    inventory: {},
    prices: {},
}));

vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => true,
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
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
vi.mock('../../core/data-manager.js', async () => {
    const fixtures = await import('../../__fixtures__/talisman-reroll.js');
    return {
        default: {
            getCurrentCharacterId: () => 32030,
            getCharacterTalismans: () => [],
            getInitClientData: () => ({
                talismanInfo: fixtures.TALISMAN_INFO,
                talismanModifierDetailMap: fixtures.REROLL_MODIFIERS,
                itemDetailMap: {
                    ...fixtures.ORB_ITEMS,
                    '/items/basic_talisman_core': { name: 'Basic Talisman Core' },
                    '/items/advanced_talisman_core': { name: 'Advanced Talisman Core' },
                    '/items/expert_talisman_core': { name: 'Expert Talisman Core' },
                },
            }),
            on: (event, handler) => game.handlers.set(event, handler),
            off: (event) => game.handlers.delete(event),
        },
    };
});
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid) => game.prices[hrid] || { price: null, source: null, estimated: false },
}));
vi.mock('../../utils/react-click.js', () => ({
    fiberFor: (modal) => {
        if (!String(modal.className).includes('TalismanModal_talismanModal')) {
            return { stateNode: modal, type: 'button', memoizedProps: { onClick: () => {} } };
        }
        const instance = game.instance;
        const component = { stateNode: instance, memoizedProps: { talisman: game.shown }, return: null };
        const fibers = [...modal.querySelectorAll('[data-role]')].map((el) => {
            const props = {};
            if (el.dataset.role === 'reroll') props.onClick = instance.handleReroll;
            if (el.dataset.role === 'picker') props.selectItemHandler = instance.handleOrbSelected;
            return { stateNode: el, memoizedProps: props, key: el.dataset.role === 'row' ? el.dataset.hrid : null };
        });
        fibers.forEach((fiber, i) => (fiber.sibling = fibers[i + 1] || null));
        return { stateNode: modal, memoizedProps: {}, child: fibers[0] || null, return: { return: component } };
    },
    clickThroughReact: (el) => {
        game.clicks.push(el.dataset.role || 'other');
        return 'react';
    },
}));

const { default: feature, describeAdvice, ADD_MANUAL_TEXT } = await import('./talisman-reroll-advisor.js');
const { MARK_CLASS, performStep } = await import('./talisman-step-controls.js');

const M = (name) => `/talisman_modifiers/${name}`;
const line = (name, grade) => ({ hrid: M(name), grade });

function makeInstance() {
    const instance = {
        state: { selectedOrbHrid: '', selectedFocusModifierHrids: [] },
        handleReroll: () => {},
        handleOrbSelected(hash) {
            instance.state.selectedOrbHrid = hash.replace('inv:', '');
        },
        getOrbItem: (hrid) => ({ hash: `inv:${hrid}`, itemHrid: hrid }),
        getInventoryCount: (hrid) => game.inventory[hrid] ?? 5,
    };
    return instance;
}

function openWindow(talisman) {
    game.shown = talisman;
    game.instance = makeInstance();
    const rows = talisman.modifiers
        .map(
            (m) =>
                `<div class="TalismanModal_modifierRow__2jyhC" data-role="row" data-hrid="${m.hrid}">` +
                '<span class="TalismanModal_lockAction__3NGAs"><button></button></span></div>'
        )
        .join('');
    document.body.innerHTML =
        `<div class="TalismanModal_talismanModal__1ocVR"><section>${rows}</section>` +
        '<div data-role="picker"></div><button data-role="reroll" disabled></button>' +
        '<div class="TalismanModal_footer__23MOl"></div></div>';
    const modal = document.body.firstElementChild;
    feature.initialize();
    game.onClass?.(modal);
    vi.advanceTimersByTime(200);
    return modal;
}

const panel = () => document.querySelector('.toolasha-reroll-advisor');
const doButton = () => panel().querySelector('.toolasha-reroll-advisor-do');
const statusText = () => panel().querySelector('.toolasha-reroll-advisor-status').textContent;
const moveText = () => panel().querySelector('.toolasha-reroll-advisor-move').textContent;
const detailText = () => panel().querySelector('.toolasha-reroll-advisor-detail').textContent;

function aim(targets, need) {
    feature.setTargets({ id: game.shown.id }, targets, need);
    vi.advanceTimersByTime(200);
    vi.runAllTimers();
}

const book = (price) => ({ price, source: 'book', estimated: false });
/** Every orb with a live listing (the coin scale), and the cores as given */
function priceAll(cores) {
    game.prices = {};
    for (const [hrid, item] of Object.entries(ORB_ITEMS)) game.prices[hrid] = book(item.sellPrice);
    for (const [hrid, price] of Object.entries(cores)) game.prices[hrid] = book(price);
}

const SMITE = [{ hrid: M('smite'), minGrade: 1 }];
const POOL3 = [
    { hrid: M('armor'), minGrade: 1 },
    { hrid: M('melee_evasion'), minGrade: 1 },
    { hrid: M('ranged_evasion'), minGrade: 1 },
];

beforeEach(() => {
    vi.useFakeTimers();
    game.clicks = [];
    game.inventory = {};
    game.prices = {};
});

afterEach(() => {
    feature.disable();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('in the window', () => {
    test('priced cores that pay: add first, cores in the counts and the coin cost; Do next step presses nothing', () => {
        priceAll({ [BASIC]: 1000, [ADVANCED]: 5000, [EXPERT]: 20000 });
        openWindow(talismanRow(1, [line('armor', 1)]));
        aim(SMITE);
        expect(moveText()).toBe('Next: add line 2 with 5 Basic Talisman Core.');
        expect(detailText()).toMatch(/Expected from here: .*5 Basic Talisman Core/);
        expect(detailText()).toMatch(/About [\d.]+[KMB]? coins at market prices\./);
        // Nothing is marked and nothing pressed
        expect(document.querySelectorAll(`.${MARK_CLASS}`)).toHaveLength(0);
        expect(doButton().style.display).toBe('');
        expect(doButton().disabled).toBe(true);
        expect(statusText()).toBe(ADD_MANUAL_TEXT);
        feature.doNextStep();
        vi.runAllTimers();
        expect(game.clicks).toEqual([]);
    });

    test('too few cores in the inventory: says how many the add takes', () => {
        priceAll({ [BASIC]: 1000, [ADVANCED]: 5000, [EXPERT]: 20000 });
        game.inventory[BASIC] = 3;
        openWindow(talismanRow(1, [line('armor', 1)]));
        aim(SMITE);
        expect(statusText()).toBe(`${ADD_MANUAL_TEXT} Needs 5 Basic Talisman Core; you have 3.`);
    });

    test('cores so dear the add loses: reroll as before, no suggestion', () => {
        priceAll({ [BASIC]: 1e12, [ADVANCED]: 1e12, [EXPERT]: 1e12 });
        openWindow(talismanRow(1, [line('armor', 1)]));
        aim(SMITE);
        expect(moveText()).toBe('Next: Reshaping Orb.');
        expect(detailText()).not.toContain('Add a line first');
        expect(detailText()).not.toContain('Core');
    });

    test('unpriced cores: reroll, with a line saying what adding first would save', () => {
        priceAll({});
        openWindow(talismanRow(1, [line('armor', 1)]));
        aim(SMITE);
        expect(moveText()).toBe('Next: Reshaping Orb.');
        expect(detailText()).toMatch(
            /Add a line first \(5 Basic Talisman Core\): about [\d.]+ fewer orbs expected \(Reforging Orb equivalents\)\. The cores have no market price/
        );
    });

    test('unpriced cores and a target that needs more lines: the add is required, cores counted, no coin cost', () => {
        priceAll({});
        openWindow(talismanRow(1, [line('ability_haste', 1)]));
        aim(POOL3);
        expect(moveText()).toBe('Next: add line 2 with 5 Basic Talisman Core. The target needs 3 lines.');
        expect(detailText()).toContain('Lines are added only where the target needs them');
        expect(detailText()).toMatch(/Expected from here: .*5 Basic Talisman Core.*1 Advanced Talisman Core/);
        expect(detailText()).toContain('No coin cost: not every orb or core used has a market listing');
    });

    test('a locked line and a target that needs more lines: unlock first, then the add', () => {
        priceAll({});
        openWindow(talismanRow(1, [line('armor', 2), line('ability_haste', 1)], { lockedModifierHrid: M('armor') }));
        aim(POOL3);
        expect(moveText()).toBe(
            'Next: unlock the locked line (free), then add line 3 with 1 Advanced Talisman Core. The target needs 3 lines.'
        );
    });

    test('a core price arriving re-solves: the cached unpriced plan is not reused', () => {
        priceAll({});
        openWindow(talismanRow(1, [line('armor', 1)]));
        aim(SMITE);
        expect(moveText()).toBe('Next: Reshaping Orb.');
        priceAll({ [BASIC]: 1000, [ADVANCED]: 5000, [EXPERT]: 20000 });
        game.handlers.get('items_updated')?.();
        vi.advanceTimersByTime(200);
        vi.runAllTimers();
        expect(moveText()).toBe('Next: add line 2 with 5 Basic Talisman Core.');
    });

    test('a pending roll is decided before any add', () => {
        priceAll({ [BASIC]: 1000, [ADVANCED]: 5000, [EXPERT]: 20000 });
        openWindow(talismanRow(1, [line('armor', 1)], { pendingModifiers: [line('critical_rate', 1)] }));
        aim(SMITE);
        expect(moveText()).toBe('Keep Current: the new roll is not better.');
    });
});

describe('describeAdvice for an add', () => {
    const names = {
        item: (hrid) => ITEMS[hrid]?.name || hrid,
        modifier: (hrid) => REROLL_MODIFIERS[hrid]?.name || hrid,
        lineCount: 2,
        maxLines: 4,
        isCore: (hrid) => hrid in CORE_ITEMS,
    };
    const build = { status: 'ok', problem: { need: 2 } };
    const add = { kind: 'add', itemHrid: ADVANCED, count: 1, lineNumber: 3 };

    test('an add that pays, the target already within the line count', () => {
        const text = describeAdvice(
            {
                build,
                scale: 'market',
                prices: { [ADVANCED]: 5000, '/items/reforging_orb': 300000 },
                advice: { status: 'move', move: add, value: 1, counts: { [ADVANCED]: 1, '/items/reforging_orb': 2 } },
            },
            names
        );
        expect(text.move).toBe('Next: add line 3 with 1 Advanced Talisman Core.');
        expect(text.detail).toContain('Expected from here: 2 Reforging Orb, 1 Advanced Talisman Core');
        expect(text.detail).toContain('About 605.0K coins at market prices.');
    });

    test('the solve left out the largest line counts', () => {
        const text = describeAdvice(
            { build, scale: 'market', addLeftOut: true, advice: { status: 'move', move: add, value: 1, counts: {} } },
            names
        );
        expect(text.detail).toContain(
            'Target too large to plan every line the cores could add; the largest line counts are left out.'
        );
    });

    test('a suggestion with a lock: unlock and add', () => {
        const text = describeAdvice(
            {
                build,
                scale: 'market',
                reference: { hrid: '/items/reforging_orb', weight: 300000 },
                advice: {
                    status: 'move',
                    move: { kind: 'orb', itemHrid: '/items/reforging_orb' },
                    value: 3e6,
                    counts: {},
                    addSuggestion: { move: add, value: 1.5e6, saving: 1.5e6, unlockFirst: true },
                },
            },
            names
        );
        expect(text.detail[0]).toBe(
            'Unlock and add a line first (1 Advanced Talisman Core): about 5 fewer orbs expected (Reforging Orb ' +
                'equivalents). The cores have no market price, so they are not weighed against the orbs.'
        );
    });

    test('performStep never presses an add, whatever the window offers', () => {
        const out = performStep({
            modal: document.body,
            instance: makeInstance(),
            advice: { status: 'move', move: add },
            names,
        });
        expect(out.status).toBe('manual');
        expect(game.clicks).toEqual([]);
    });
});
