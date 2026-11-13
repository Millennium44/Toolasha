/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ORB_ITEMS, REROLL_MODIFIERS, TALISMAN_INFO, talismanRow } from '../../__fixtures__/talisman-reroll.js';

const game = vi.hoisted(() => ({
    server: true,
    setting: true,
    shown: null,
    instance: null,
    onClass: null,
    handlers: new Map(),
    clicks: [],
    inventory: {},
    // What clickThroughReact answers ('react', or 'none' when it reaches nothing)
    ctr: 'react',
    // Re-renders of the window: a host button's onClick is a new function after each, as React does
    renders: 0,
    rerenderDelay: 0,
    hostHandlers: new Map(),
}));

/** Which control an element is, for the click log */
function tagOf(el) {
    const row = el.closest('[data-role="row"]');
    return el.dataset.role || `lock:${row?.dataset.hrid}`;
}

vi.mock('../../utils/game-server.js', () => ({ isTestServer: () => game.server }));
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
        getCharacterTalismans: () => [],
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
    getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
}));
// The game's React tree, rebuilt from the window's DOM on every walk: the window component above the window
// element (its instance holds the handlers), and below it one fiber per control, carrying the props the game gives it
vi.mock('../../utils/react-click.js', () => ({
    fiberFor: (modal) => {
        if (!String(modal.className).includes('TalismanModal_talismanModal')) {
            // A host <button>, as measured live: type 'button' with its own onClick, new on every render
            const key = `${tagOf(modal)}:${game.renders}`;
            if (!game.hostHandlers.has(key)) game.hostHandlers.set(key, () => {});
            return { stateNode: modal, type: 'button', memoizedProps: { onClick: game.hostHandlers.get(key) } };
        }
        const instance = game.instance;
        const component = { stateNode: instance, memoizedProps: { talisman: game.shown }, return: null };
        const handlerOf = {
            reroll: instance.handleReroll,
            useNew: instance.handleUseNewRoll,
            keep: instance.handleKeepCurrent,
            unlock: instance.handleUnlock,
        };
        const fibers = [...modal.querySelectorAll('[data-role]')].map((el) => {
            const role = el.dataset.role;
            const props = {};
            if (handlerOf[role]) props.onClick = handlerOf[role];
            if (role === 'picker') props.selectItemHandler = instance.handleOrbSelected;
            return { stateNode: el, memoizedProps: props, key: role === 'row' ? el.dataset.hrid : null };
        });
        fibers.forEach((fiber, i) => (fiber.sibling = fibers[i + 1] || null));
        return { stateNode: modal, memoizedProps: {}, child: fibers[0] || null, return: { return: component } };
    },
    clickThroughReact: (el) => {
        if (game.ctr !== 'react') return game.ctr;
        game.clicks.push(tagOf(el));
        return 'react';
    },
}));

const { default: feature } = await import('./talisman-reroll-advisor.js');
const { MARK_CLASS } = await import('./talisman-step-controls.js');

const M = (name) => `/talisman_modifiers/${name}`;
const line = (name, grade) => ({ hrid: M(name), grade });
const RESHAPING = '/items/reshaping_orb';
const REFUSED = 'No response — the game may have refused this (rerolls are blocked in combat)';

function makeInstance() {
    const instance = {
        state: { selectedOrbHrid: '', selectedFocusModifierHrids: [] },
        handleReroll: () => {},
        handleUseNewRoll: () => {},
        handleKeepCurrent: () => {},
        handleUnlock: () => {},
        handleOrbSelected(hash) {
            instance.state.selectedOrbHrid = hash.replace('inv:', '');
            // The window re-renders with the choice: new handlers on its host buttons
            if (game.rerenderDelay > 0) setTimeout(() => game.renders++, game.rerenderDelay);
            else game.renders++;
            const reroll = document.querySelector('[data-role="reroll"]');
            if (!reroll || game.enableDelay === 'never') return;
            if (game.enableDelay > 0) setTimeout(() => (reroll.disabled = false), game.enableDelay);
            else reroll.disabled = false;
        },
        handleFocusToggled(hrid) {
            const picks = instance.state.selectedFocusModifierHrids;
            instance.state.selectedFocusModifierHrids = picks.includes(hrid)
                ? picks.filter((h) => h !== hrid)
                : [...picks, hrid];
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
        '<button data-role="useNew"></button><button data-role="keep"></button>' +
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
const role = (name) => document.querySelector(`[data-role="${name}"]`);

function pick(row, hrid, grade) {
    const types = panel().querySelectorAll('.toolasha-reroll-advisor-type');
    const grades = panel().querySelectorAll('.toolasha-reroll-advisor-grade');
    types[row].value = hrid;
    grades[row].value = String(grade);
    types[row].dispatchEvent(new Event('change'));
    vi.advanceTimersByTime(200);
    vi.runAllTimers();
}

/** The game answers: the window's talisman prop changes and talismans_updated arrives */
function gameUpdates(talisman) {
    game.shown = talisman;
    game.handlers.get('talismans_updated')?.();
    vi.advanceTimersByTime(200);
}

const start = () => talismanRow(1, [line('melee_evasion', 1), line('melee_accuracy', 1)]);

beforeEach(() => {
    vi.useFakeTimers();
    game.server = true;
    game.setting = true;
    game.clicks = [];
    game.inventory = {};
    game.ctr = 'react';
    game.renders = 0;
    game.rerenderDelay = 0;
    game.hostHandlers = new Map();
    game.enableDelay = 0;
});

afterEach(() => {
    feature.disable();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('Do next step', () => {
    test('success: one press selects the orb and presses Reroll once; Done once the talisman changes', () => {
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        expect(moveText()).toBe('Next: Reshaping Orb.');
        expect(role('picker').classList.contains(MARK_CLASS)).toBe(true);
        expect(doButton().style.display).toBe('');

        doButton().click();
        vi.advanceTimersByTime(60);
        doButton().click(); // a double click never sends twice
        feature.doNextStep();
        expect(game.clicks).toEqual(['reroll']);
        expect(game.instance.state.selectedOrbHrid).toBe(RESHAPING);
        expect(doButton().disabled).toBe(true);
        expect(statusText()).toBe('Waiting for the game…');

        gameUpdates({ ...start(), pendingModifiers: [line('armor', 1), line('melee_accuracy', 2)] });
        expect(statusText()).toBe('Done — rerolled with one Reshaping Orb.');
        expect(doButton().disabled).toBe(false);
        expect(game.clicks).toEqual(['reroll']);
    });

    test('a pending roll that meets the target: the press uses it', () => {
        openWindow({ ...start(), pendingModifiers: [line('ability_damage', 4), line('melee_accuracy', 1)] });
        pick(0, M('ability_damage'), 3);
        expect(role('useNew').classList.contains(MARK_CLASS)).toBe(true);
        doButton().click();
        vi.advanceTimersByTime(60);
        expect(game.clicks).toEqual(['useNew']);
    });

    test('a lock: the press selects the Binding Orb and presses that line’s lock button', () => {
        openWindow(
            talismanRow(1, [
                line('armor', 4),
                line('melee_evasion', 1),
                line('melee_accuracy', 1),
                line('magic_damage', 1),
            ])
        );
        pick(0, M('armor'), 3);
        pick(1, M('ability_damage'), 3);
        expect(moveText()).toBe('Next: lock Armor with a Binding Orb.');
        doButton().click();
        vi.advanceTimersByTime(60);
        expect(game.instance.state.selectedOrbHrid).toBe('/items/binding_orb');
        expect(game.clicks).toEqual([`lock:${M('armor')}`]);
    });

    test('refusal: nothing changes within 5 s, the button comes back with the refusal text', () => {
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        doButton().click();
        vi.advanceTimersByTime(60);
        vi.advanceTimersByTime(5000);
        expect(statusText()).toBe(REFUSED);
        expect(doButton().disabled).toBe(false);
        expect(game.clicks).toEqual(['reroll']);
    });

    test('control not found: says so and sends nothing', () => {
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        role('reroll').remove();
        doButton().click();
        vi.advanceTimersByTime(60);
        expect(statusText()).toBe("Could not find the game's Reroll button.");
        expect(game.clicks).toEqual([]);
        expect(doButton().disabled).toBe(false);
    });

    test('no orb in inventory: the button is disabled and says which', () => {
        game.inventory[RESHAPING] = 0;
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        expect(doButton().disabled).toBe(true);
        expect(statusText()).toBe('No Reshaping Orb in inventory');
        feature.doNextStep();
        expect(game.clicks).toEqual([]);
    });

    test('target met: the button is hidden and nothing is marked', () => {
        openWindow(start());
        panel().querySelector('.toolasha-reroll-advisor-use-current').click();
        vi.advanceTimersByTime(200);
        expect(moveText()).toBe('Target met. Nothing to do.');
        expect(doButton().style.display).toBe('none');
        expect(document.querySelectorAll(`.${MARK_CLASS}`)).toHaveLength(0);
    });

    test('window closed mid-flight: the press is dropped and nothing more happens', () => {
        const modal = openWindow(start());
        pick(0, M('ability_damage'), 3);
        doButton().click();
        vi.advanceTimersByTime(60);
        modal.remove();
        feature.schedule();
        expect(feature.pressing).toBeNull();
        vi.advanceTimersByTime(6000);
        expect(game.clicks).toEqual(['reroll']);
        expect(document.querySelectorAll(`.${MARK_CLASS}`)).toHaveLength(0);
    });

    test('target changed mid-flight: the press is dropped, nothing more is sent', () => {
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        doButton().click();
        vi.advanceTimersByTime(60);
        pick(0, M('armor'), 2);
        expect(feature.pressing).toBeNull();
        expect(statusText()).not.toBe(REFUSED);
        vi.advanceTimersByTime(6000);
        expect(game.clicks).toEqual(['reroll']);
    });

    test('turning it off takes every mark off', () => {
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        expect(document.querySelectorAll(`.${MARK_CLASS}`).length).toBeGreaterThan(0);
        feature.disable();
        expect(document.querySelectorAll(`.${MARK_CLASS}`)).toHaveLength(0);
        expect(role('picker').style.outline).toBe('');
    });

    test('setting off: no panel, no button, no marks', () => {
        game.setting = false;
        openWindow(start());
        expect(panel()).toBeNull();
        expect(document.querySelectorAll(`.${MARK_CLASS}`)).toHaveLength(0);
    });
});

describe('live retest fixes (32030, talisman 3080)', () => {
    test('nothing is pressed inside our own click; the press follows, on the live host button', () => {
        openWindow({ ...start(), pendingModifiers: [line('melee_evasion', 1), line('melee_accuracy', 1)] });
        pick(0, M('ability_damage'), 3);
        expect(moveText()).toBe('Keep Current: the new roll is not better.');
        doButton().click();
        // Still inside our click's turn: the game's handler has not been called
        expect(game.clicks).toEqual([]);
        vi.advanceTimersByTime(0);
        expect(game.clicks).toEqual(['keep']);
    });

    test('Reroll waits for the window to re-render with the chosen orb (its onClick changes)', () => {
        game.rerenderDelay = 120;
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        doButton().click();
        vi.advanceTimersByTime(60);
        // Enabled already, but still the handler from before the choice
        expect(game.clicks).toEqual([]);
        vi.advanceTimersByTime(200);
        expect(game.clicks).toEqual(['reroll']);
    });

    test('a press that reaches nothing is reported and never retried', () => {
        game.ctr = 'none';
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        doButton().click();
        vi.advanceTimersByTime(600);
        expect(game.clicks).toEqual([]);
        expect(statusText()).toBe('Could not press the game button; press the marked one yourself.');
        expect(doButton().disabled).toBe(false);
    });

    test('a button gone from the document is never pressed', () => {
        openWindow({ ...start(), pendingModifiers: [line('melee_evasion', 1), line('melee_accuracy', 1)] });
        pick(0, M('ability_damage'), 3);
        doButton().click();
        // The game re-renders the choice away before the press runs
        role('keep').remove();
        vi.advanceTimersByTime(0);
        expect(game.clicks).toEqual([]);
        expect(statusText()).toBe("Could not find the game's button for this step.");
    });

    test('Reroll is pressed once the game enables it after the orb is chosen', () => {
        game.enableDelay = 120;
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        doButton().click();
        vi.advanceTimersByTime(60);
        expect(game.clicks).toEqual([]);
        expect(statusText()).toBe('Waiting for the game…');
        vi.advanceTimersByTime(200);
        expect(game.clicks).toEqual(['reroll']);
    });

    test('Reroll that never enables: says so and sends nothing', () => {
        game.enableDelay = 'never';
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        doButton().click();
        vi.advanceTimersByTime(60);
        vi.advanceTimersByTime(1000);
        expect(game.clicks).toEqual([]);
        expect(statusText()).toBe("Selected the Reshaping Orb; the game's Reroll button did not enable.");
        expect(doButton().disabled).toBe(false);
    });

    test('buying the orb redraws the button (items_updated)', () => {
        game.inventory[RESHAPING] = 0;
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        expect(statusText()).toBe('No Reshaping Orb in inventory');
        game.inventory[RESHAPING] = 10;
        game.handlers.get('items_updated')?.();
        vi.advanceTimersByTime(200);
        expect(doButton().disabled).toBe(false);
        expect(statusText()).toBe('');
    });

    test('an old step message clears when the talisman changes', () => {
        openWindow(start());
        pick(0, M('ability_damage'), 3);
        doButton().click();
        vi.advanceTimersByTime(60);
        vi.advanceTimersByTime(5000);
        expect(statusText()).toBe(REFUSED);
        // The player rerolls by hand
        gameUpdates({ ...start(), pendingModifiers: [line('armor', 1), line('melee_accuracy', 2)] });
        expect(statusText()).toBe('');
    });

    test('while the game’s confirm is open there is no timeout; refused only after it closes with no change', () => {
        const modal = openWindow(
            talismanRow(1, [
                line('armor', 4),
                line('melee_evasion', 1),
                line('melee_accuracy', 1),
                line('magic_damage', 1),
            ])
        );
        pick(0, M('armor'), 3);
        pick(1, M('ability_damage'), 3);
        doButton().click();
        vi.advanceTimersByTime(60);
        expect(game.clicks).toEqual([`lock:${M('armor')}`]);
        // The game's confirm: a nested dialog with a Yes/No pair
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<button></button><button></button>';
        modal.appendChild(dialog);
        vi.advanceTimersByTime(8000);
        expect(statusText()).toBe("Confirm in the game's dialog");
        expect(doButton().disabled).toBe(true);
        dialog.remove();
        vi.advanceTimersByTime(1000);
        expect(statusText()).not.toBe(REFUSED);
        vi.advanceTimersByTime(3000);
        expect(statusText()).toBe(REFUSED);
        expect(game.clicks).toHaveLength(1);
    });

    test('the window’s own pending-roll section is not taken for a game confirm', () => {
        openWindow({ ...start(), pendingModifiers: [line('ability_damage', 4), line('melee_accuracy', 1)] });
        // As live: Use New Roll / Keep Current sit in a nested dialog section of the window
        const section = document.createElement('div');
        section.setAttribute('role', 'dialog');
        section.append(role('useNew'), role('keep'));
        document.querySelector('section').appendChild(section);
        pick(0, M('ability_damage'), 3);
        doButton().click();
        vi.advanceTimersByTime(60);
        expect(game.clicks).toEqual(['useNew']);
        vi.advanceTimersByTime(5300);
        expect(statusText()).toBe(REFUSED);
    });
});
