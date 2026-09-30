/**
 * @vitest-environment happy-dom
 *
 * The MP supply section of the mana panel, drawn rather than reasoned about.
 * The allocation arithmetic is tested in `utils/mp-optimizer.test.js`; this
 * file is for the wiring: measured spend filling the target, the panel drawing
 * every section without one reporting a failure, and the button re-planning.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    abilityDetailMap: {},
    itemDetailMap: {},
    prices: {},
    handlers: {},
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: game.abilityDetailMap, itemDetailMap: game.itemDetailMap }),
        getCurrentCharacterId: () => 'char1',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.handlers[event] = handler;
        },
        off: () => {},
    },
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: (hrid) => ({ price: game.prices[hrid] ?? null }),
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    clampPanelToViewport: () => null,
    markPanelInteracted: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../core/storage.js', () => ({
    default: { getJSON: async () => null, setJSON: async () => {}, ready: Promise.resolve() },
}));

const manaTracker = (await import('./mana-tracker.js')).default;
const { manaPanel, resetManaTally, resetMpPlanner, manaPerMinuteMeasured, mpSupplyPlan } =
    await import('./mana-tracker.js');

const MINUTE_NS = 60e9;
const text = () => manaPanel.panel.textContent;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    game.handlers = {};
    game.abilityDetailMap = { '/abilities/fireball': { manaCost: 100, name: 'Fireball' } };
    game.itemDetailMap = {
        '/items/star_fruit_yogurt': {
            name: 'Star Fruit Yogurt',
            categoryHrid: '/item_categories/food',
            consumableDetail: { hitpointRestore: 0, manapointRestore: 350, cooldownDuration: MINUTE_NS },
        },
        '/items/plum_gummy': {
            name: 'Plum Gummy',
            categoryHrid: '/item_categories/food',
            consumableDetail: {
                hitpointRestore: 0,
                manapointRestore: 100,
                recoveryDuration: 10e9,
                cooldownDuration: MINUTE_NS,
            },
        },
    };
    game.prices = { '/items/star_fruit_yogurt': 900, '/items/plum_gummy': 200 };
    resetManaTally();
    manaTracker.cleanup();
    manaTracker.initialize();
});

afterEach(() => {
    manaPanel.hide();
    manaTracker.cleanup();
    // The typed target, haste and slots are the panel's per-character state
    resetMpPlanner();
    vi.useRealTimers();
});

/** Two minutes of play spending 100 mana every 10 seconds, so 600 per minute */
function spendSteadily() {
    game.handlers['new_battle']({ players: [{ character: { id: 'char1' }, combatDetails: { combatStats: {} } }] });
    for (let i = 0; i < 12; i++) {
        vi.advanceTimersByTime(10_000);
        game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/fireball' });
    }
}

describe('measured spend', () => {
    test('is unknown until a minute has been watched', () => {
        game.handlers['new_battle']({});
        game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/fireball' });

        expect(manaPerMinuteMeasured()).toBe(null);
    });

    test('is mana over the watched span, per minute', () => {
        spendSteadily();

        expect(manaPerMinuteMeasured()).toBe(600);
    });
});

describe('the MP supply section', () => {
    test('with nothing measured it asks for a target and still draws without failing', () => {
        manaPanel.show();

        expect(text()).toContain('Cheapest MP supply');
        expect(text()).toContain('Enter a target');
        expect(text()).toContain('Most MP the slots allow');
        expect(text()).not.toContain('could not be drawn');
    });

    test('the measured spend fills the target and is planned for', () => {
        spendSteadily();
        manaPanel.show();

        expect(manaPanel.panel.querySelector('[data-mp-target]').value).toBe('600');
        // 600 is out of reach: yogurt 350 + plum gummy 100 = 450
        expect(text()).toContain('out of reach');
        expect(text()).toContain('450 MP/min');
        expect(text()).not.toContain('could not be drawn');
    });

    test('typing a target and calculating shows the cheapest set for it', () => {
        manaPanel.show();
        const input = manaPanel.panel.querySelector('[data-mp-target]');
        input.value = '380';
        manaPanel.panel.querySelector('[data-mp-calculate]').click();

        expect(text()).toContain('Star Fruit Yogurt');
        expect(text()).toContain('Plum Gummy');
        // 54,000 + 12,000 coins per hour
        expect(text()).toContain('66,000/h');
        expect(text()).not.toContain('could not be drawn');
    });

    test('with no priced mana item it says so instead of a plan', () => {
        game.prices = {};
        manaPanel.show();

        expect(text()).toContain('No priced mana food or drink');
    });
});

describe('mpSupplyPlan', () => {
    test('reads food haste from the character in the battle message', () => {
        game.handlers['new_battle']({
            players: [{ character: { id: 'char1' }, combatDetails: { combatStats: { foodHaste: 0.5 } } }],
        });

        expect(mpSupplyPlan(0).max.mpPerMinute).toBe(450 * 1.5);
    });
});

describe('a character with fewer consumable slots', () => {
    test('is not offered a plan that needs more food than it can equip', () => {
        // One food slot: the yogurt (350/min) and the gummy (100/min) together would reach 400
        game.handlers['new_battle']({
            players: [{ character: { id: 'char1' }, combatDetails: { combatStats: { foodSlots: 1, drinkSlots: 1 } } }],
        });
        expect(mpSupplyPlan(400).best).toBeNull();
        expect(mpSupplyPlan(300).best.items).toHaveLength(1);
        expect(mpSupplyPlan(0).max.items).toHaveLength(1);
    });
});
