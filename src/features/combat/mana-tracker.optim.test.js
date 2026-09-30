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
        getCurrentCharacterName: () => 'Tib',
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
    // The profit context is where the user's pricing mode applies; without it the resolver falls back to ask
    resolveItemPrice: (hrid, options = {}) => ({
        price: (options.context === 'profit' ? game.profitPrices?.[hrid] : undefined) ?? game.prices[hrid] ?? null,
    }),
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

    test('a cast that opens the span without a new_battle is the baseline, not part of the interval', () => {
        // Tracking began mid-fight: seven 100-MP casts 10 s apart cover 60 s and six casts of spend
        for (let i = 0; i < 7; i++) {
            game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/fireball' });
            if (i < 6) vi.advanceTimersByTime(10_000);
        }

        expect(manaPerMinuteMeasured()).toBe(600);
    });

    test('a reset mid-fight starts from the next cast the same way', () => {
        game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/fireball' });
        resetManaTally();
        for (let i = 0; i < 7; i++) {
            game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/fireball' });
            if (i < 6) vi.advanceTimersByTime(10_000);
        }

        expect(manaPerMinuteMeasured()).toBe(600);
    });
});

describe('a character that spends no mana', () => {
    /** Two minutes of fights with no casts: a complete tally that spent nothing */
    function fightWithoutCasting() {
        game.handlers['new_battle']({ players: [{ character: { id: 'char1' }, combatDetails: { combatStats: {} } }] });
        vi.advanceTimersByTime(60_000);
        game.handlers['new_battle']({ players: [{ character: { id: 'char1' }, combatDetails: { combatStats: {} } }] });
    }

    test('measures zero once a minute has been watched, not "still measuring"', () => {
        fightWithoutCasting();

        expect(manaPerMinuteMeasured()).toBe(0);
    });

    test('is still unknown before the span threshold', () => {
        game.handlers['new_battle']({});

        expect(manaPerMinuteMeasured()).toBe(null);
    });

    test('the card says no MP is needed instead of asking for a target or erroring', () => {
        fightWithoutCasting();
        manaPanel.show();

        expect(manaPanel.panel.querySelector('[data-mp-target]').value).toBe('0');
        expect(text()).toContain('No MP needed');
        expect(text()).not.toContain('Enter a target');
        expect(text()).not.toContain('out of reach');
        expect(text()).not.toContain('could not be drawn');
    });
});

describe('measured spend gaps', () => {
    test('is withheld while an observed ability has no stated cost', () => {
        spendSteadily();
        expect(manaPerMinuteMeasured()).toBe(600);
        game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/mystery' });

        expect(manaPerMinuteMeasured()).toBe(null);
    });

    test('the card says why and leaves the target to the user', () => {
        spendSteadily();
        game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/mystery' });
        manaPanel.show();

        expect(text()).toContain('unknown ability costs');
        expect(manaPanel.panel.querySelector('[data-mp-target]').value).toBe('');
        expect(text()).not.toContain('could not be drawn');
    });

    test('time the tracker was disabled is not part of the rate', () => {
        spendSteadily();
        manaTracker.cleanup();
        vi.advanceTimersByTime(2 * 60 * 60_000);
        manaTracker.initialize();
        expect(manaPerMinuteMeasured()).toBe(600);

        // The next cast opens a fresh stretch and is its baseline; 60 s more of casts adds 6 x 100 mana
        for (let i = 0; i < 7; i++) {
            game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/fireball' });
            if (i < 6) vi.advanceTimersByTime(10_000);
        }
        // 120 s + 60 s observed, 1,200 + 600 mana
        expect(manaPerMinuteMeasured()).toBe(600);
    });

    test('a reset clears the banked time too', () => {
        spendSteadily();
        manaTracker.cleanup();
        resetManaTally();
        manaTracker.initialize();

        expect(manaPerMinuteMeasured()).toBe(null);
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

describe('item pricing', () => {
    test('resolves costs in the profit context so the pricing mode applies', () => {
        game.profitPrices = { '/items/star_fruit_yogurt': 9000 };
        const item = mpSupplyPlan(0).max.items.find((entry) => entry.price === 9000);
        game.profitPrices = undefined;

        expect(item).toBeDefined();
    });
});

describe('a battle entry shaped differently', () => {
    test('is found when players is a map keyed by id', () => {
        game.handlers['new_battle']({
            players: {
                char0: { name: 'x' },
                char1: { character: { id: 'char1' }, combatDetails: { combatStats: { foodHaste: 0.5 } } },
            },
        });

        expect(mpSupplyPlan(0).max.mpPerMinute).toBe(450 * 1.5);
    });

    test('is found by a top-level name', () => {
        game.handlers['new_battle']({
            players: [{ name: 'Tib', combatDetails: { combatStats: { foodHaste: 0.5 } } }],
        });

        expect(mpSupplyPlan(0).max.mpPerMinute).toBe(450 * 1.5);
    });
});

describe('a battle entry without an id', () => {
    test('is matched by the current character name', () => {
        game.handlers['new_battle']({
            players: [
                { character: { name: 'Someone Else' }, combatDetails: { combatStats: { foodHaste: 0.1 } } },
                { character: { name: 'Tib' }, combatDetails: { combatStats: { foodHaste: 0.5 } } },
            ],
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
