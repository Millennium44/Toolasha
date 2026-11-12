/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { BELT_ITEMS, MODIFIER_DETAILS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';

const game = vi.hoisted(() => ({
    server: true,
    setting: true,
    equipment: new Map(),
    keys: new Map(),
    wrapperKeys: new Map(),
    handlers: new Map(),
    onClass: null,
}));

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
        getCurrentCharacterId: () => 'c1',
        getEquipment: () => game.equipment,
        getInitClientData: () => ({
            itemDetailMap: BELT_ITEMS,
            talismanModifierDetailMap: MODIFIER_DETAILS,
            enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
        }),
        on: (event, handler) => game.handlers.set(event, handler),
        off: (event) => game.handlers.delete(event),
    },
}));
// The fiber walk is the game's React tree; here the keys are handed over directly
vi.mock('../../utils/react-click.js', () => ({
    fiberFor: (modal) => {
        const rows = [...modal.querySelectorAll('[class*="TalismanModal_modifierRow"]')];
        const nodes = rows.map((row) => ({
            key: game.keys.get(row),
            stateNode: row,
            child: null,
            sibling: null,
            // A key that sits on a wrapping component fiber instead of the row's own
            return: game.wrapperKeys.has(row)
                ? { key: game.wrapperKeys.get(row), stateNode: null, return: null }
                : null,
        }));
        nodes.forEach((n, i) => (n.sibling = nodes[i + 1] || null));
        return { child: nodes[0] || null };
    },
}));

const { default: feature, scaledLineText, formatScaledValue } = await import('./talisman-window-values.js');

/** One modifier row as the game renders it, in the game's own class names, with a translated label */
function row(modal, hrid, grade, valueText, { special = false } = {}) {
    const el = document.createElement('div');
    el.className = 'TalismanModal_modifierRow__2jyhC';
    el.innerHTML =
        `<span class="TalismanModal_modifierLabel__2N6AQ">${special ? '<span class="TalismanModal_specialMark__3lAdK">✦</span>' : ''}采集速度` +
        `<span class="TalismanModal_grade__3dbTk">等级${grade}</span></span>` +
        `<span class="TalismanModal_value__3ErzJ">${valueText}</span>`;
    modal.querySelector('[class*="TalismanModal_modifiers"]').appendChild(el);
    game.keys.set(el, hrid);
    return el;
}

function openModal() {
    const modal = document.createElement('div');
    modal.className = 'TalismanModal_talismanModal__1ocVR';
    modal.innerHTML = '<div class="TalismanModal_modifiers__QfGsQ"></div>';
    document.body.appendChild(modal);
    return modal;
}

const large10 = {
    itemHrid: '/items/large_talisman_belt',
    itemLocationHrid: '/item_locations/belt',
    enhancementLevel: 10,
};

beforeEach(() => {
    vi.useFakeTimers();
    game.server = true;
    game.setting = true;
    game.equipment = new Map([['/item_locations/belt', large10]]);
    game.keys = new Map();
    game.wrapperKeys = new Map();
    game.handlers = new Map();
    document.body.innerHTML = '';
});

afterEach(() => {
    feature.disable();
    vi.useRealTimers();
});

describe('formatting', () => {
    test('percent lines as percent, flat lines as numbers, both signed and trimmed to two decimals', () => {
        expect(formatScaledValue(0.05661, true)).toBe('+5.66%');
        expect(formatScaledValue(0.07, true)).toBe('+7%');
        expect(formatScaledValue(2.516, false)).toBe('+2.52');
        expect(formatScaledValue(-0.0126, true)).toBe('-1.26%');
    });

    test('Milking Speed G2 under power 0.258 reads "→ +5.66%"; no belt (power 0) reads nothing', () => {
        expect(scaledLineText('/talisman_modifiers/milking_speed', 2, 0.258, MODIFIER_DETAILS)).toBe('→ +5.66%');
        expect(scaledLineText('/talisman_modifiers/armor', 1, 0.258, MODIFIER_DETAILS)).toBe('→ +2.52');
        expect(scaledLineText('/talisman_modifiers/milking_speed', 2, 0, MODIFIER_DETAILS)).toBeNull();
        expect(scaledLineText('/talisman_modifiers/not_a_thing', 2, 0.258, MODIFIER_DETAILS)).toBeNull();
    });
});

describe('the window', () => {
    test('each line gets its scaled value beside the game value, found by React key and grade digits (zh text)', () => {
        feature.initialize();
        const modal = openModal();
        const speed = row(modal, '/talisman_modifiers/milking_speed', 2, '+4.5%');
        const armor = row(modal, '/talisman_modifiers/armor', 1, '+2');
        game.onClass(modal);
        vi.advanceTimersByTime(100);

        expect(speed.querySelector('.toolasha-talisman-scaled').textContent).toBe('→ +5.66%');
        expect(armor.querySelector('.toolasha-talisman-scaled').textContent).toBe('→ +2.52');
        // The game's own value element is left alone
        expect(speed.querySelector('[class*="TalismanModal_value"]').textContent).toBe('+4.5%');
    });

    test('a key on a wrapping component fiber still names the row', () => {
        feature.initialize();
        const modal = openModal();
        const speed = row(modal, undefined, 2, '+4.5%');
        game.wrapperKeys.set(speed, '/talisman_modifiers/milking_speed');
        game.onClass(modal);
        vi.advanceTimersByTime(100);
        expect(speed.querySelector('.toolasha-talisman-scaled').textContent).toBe('→ +5.66%');
    });

    test('a row with no key anywhere above it up to the list is left alone', () => {
        feature.initialize();
        const modal = openModal();
        const speed = row(modal, undefined, 2, '+4.5%');
        game.onClass(modal);
        vi.advanceTimersByTime(100);
        expect(speed.querySelector('.toolasha-talisman-scaled')).toBeNull();
    });

    test('a special line is left alone', () => {
        feature.initialize();
        const modal = openModal();
        const special = row(modal, '/talisman_modifiers/armor', 1, '+2', { special: true });
        game.onClass(modal);
        vi.advanceTimersByTime(100);
        expect(special.querySelector('.toolasha-talisman-scaled')).toBeNull();
    });

    test('taking the belt off removes the figures on the next redraw', () => {
        feature.initialize();
        const modal = openModal();
        const speed = row(modal, '/talisman_modifiers/milking_speed', 2, '+4.5%');
        game.onClass(modal);
        vi.advanceTimersByTime(100);
        expect(speed.querySelector('.toolasha-talisman-scaled')).not.toBeNull();

        game.equipment = new Map();
        game.handlers.get('items_updated')();
        vi.advanceTimersByTime(100);
        expect(speed.querySelector('.toolasha-talisman-scaled')).toBeNull();
    });

    test('a better belt redraws with the new figure, and disable() leaves nothing behind', () => {
        feature.initialize();
        const modal = openModal();
        const speed = row(modal, '/talisman_modifiers/milking_speed', 2, '+4.5%');
        game.onClass(modal);
        vi.advanceTimersByTime(100);

        game.equipment = new Map([['/item_locations/belt', { ...large10, enhancementLevel: 0 }]]);
        game.handlers.get('talismans_updated')();
        vi.advanceTimersByTime(100);
        expect(speed.querySelector('.toolasha-talisman-scaled').textContent).toBe('→ +5.4%');

        feature.disable();
        expect(document.querySelector('.toolasha-talisman-scaled')).toBeNull();
        expect(game.handlers.size).toBe(0);
        expect(game.onClass).toBeNull();
    });
});

describe('where it does not run', () => {
    test('off the test server initialize does nothing at all', () => {
        game.server = false;
        feature.initialize();
        expect(game.onClass).toBeNull();
        expect(game.handlers.size).toBe(0);
    });

    test('with the setting off it registers nothing', () => {
        game.setting = false;
        feature.initialize();
        expect(game.onClass).toBeNull();
    });
});
