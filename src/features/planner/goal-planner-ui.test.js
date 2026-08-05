/** @vitest-environment happy-dom
 *
 * That the panel actually draws a plan.
 *
 * The arithmetic is tested against fixtures in `goal-planner.test.js`; nothing
 * here re-checks a number. What this catches is the other failure — a renamed
 * helper, a property read off something that stopped having it — which no
 * arithmetic test can see, because the panel swallows per-goal errors so one
 * bad goal does not blank the rest. `could not be drawn` on screen is the
 * symptom, so it is the assertion.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {} }));

vi.mock('../../core/config.js', () => ({
    default: { Z_FLOATING_PANEL: 1100, getSetting: () => true, getSettingValue: (_key, fallback) => fallback },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        get: async (key, _name, fallback = null) => store.data[key] ?? fallback,
        set: async (key, value) => {
            store.data[key] = value;
            return true;
        },
        delete: async (key) => {
            delete store.data[key];
            return true;
        },
        getAllKeys: async () => Object.keys(store.data),
        getJSON: async (key, _name, fallback) => store.data[key] ?? fallback,
        setJSON: async (key, value) => {
            store.data[key] = value;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/sinister_cape': { name: 'Sinister Cape', equipmentDetail: { type: '/equipment_types/back' } },
            },
            houseRoomDetailMap: { '/house_rooms/observatory': { name: 'Observatory' } },
        }),
        getSkills: () => [{ skillHrid: '/skills/enhancing', level: 90, experience: 90_000 }],
        on: () => {},
        off: () => {},
    },
}));
// Only the two functions the planner calls; the real one reaches the market
vi.mock('../../utils/experience-calculator.js', () => ({
    calculateMultiLevelProgress: (currentLevel, _currentXP, targetLevel, _eff, actionTime, xpPerAction) => ({
        actionsNeeded: (targetLevel - currentLevel) * 100,
        timeNeeded: (targetLevel - currentLevel) * 100 * actionTime * (xpPerAction > 0 ? 1 : 1),
    }),
}));

// The two marketplace hand-offs. Both reach the live DOM and the game's own
// panels; what this file is about is that a buy step *offers* the trip, not
// what the marketplace does when it gets there.
const shopping = vi.hoisted(() => ({ calls: [] }));
vi.mock('../actions/missing-materials-button.js', () => ({
    openMissingMaterials: (actionHrid, numActions) => shopping.calls.push({ kind: 'action', actionHrid, numActions }),
}));
vi.mock('../ui/consumables-shopping-list.js', () => ({
    openShoppingList: (items) => shopping.calls.push({ kind: 'list', items }),
}));

const plannerContext = vi.hoisted(() => ({ value: null }));
vi.mock('./goal-planner-context.js', () => ({
    buildPlannerContext: async () => plannerContext.value,
    withHouseCosts: async (context) => context,
}));

const { goalPlannerPanel } = await import('./goal-planner-ui.js');

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = () => document.getElementById('toolasha-goal-planner-panel')?.textContent ?? '';

/**
 * A context that can answer every goal the test asks for.
 * @returns {Object} A planning context
 */
function fixtureContext() {
    return {
        now: 1_700_000_000_000,
        gold: 50_000_000,
        levelExperienceTable: Array.from({ length: 201 }, (_, level) => level * 1000),
        pricingNote: 'Priced at 10:00.',
        itemName: () => 'Sinister Cape',
        skillName: () => 'Enhancing',
        houseRoomName: () => 'Observatory',
        skill: () => ({ level: 90, experience: 90_000 }),
        owned: () => 0,
        ownedEnhancementLevel: () => -1,
        houseLevel: () => 6,
        goldRates: () => [{ label: 'Milking: Cow', goldPerHour: 4_000_000, actionHrid: '/actions/milking/cow' }],
        xpRates: () => [
            {
                label: 'Cheese Sword +0 → +5',
                requiredLevel: 1,
                xpPerHour: 500_000,
                xpPerAction: 250,
                actionTime: 10,
                totalEfficiency: 0,
                flatRate: true,
                goldPerHour: -1_000_000,
            },
        ],
        acquire: () => ({
            strategy: 'buy',
            totalCost: 12_000_000,
            unitCost: 12_000_000,
            buyPrice: 12_000_000,
            craftCost: 15_000_000,
            requires: [],
        }),
        enhance: () => ({
            attempts: 41.3,
            totalTimeSeconds: 3600,
            materialCost: 30_000_000,
            protectionCost: 5_000_000,
            protectionCount: 3,
            protectFrom: 4,
            baseCost: 12_000_000,
            totalCost: 47_000_000,
        }),
        houseCost: () => ({
            coins: 20_000_000,
            totalValue: 60_000_000,
            materials: [
                { itemHrid: '/items/log', name: 'Log', count: 500, marketPrice: 80_000, totalValue: 40_000_000 },
            ],
        }),
    };
}

beforeEach(() => {
    shopping.calls = [];
    store.data = {
        goalPlannerGoals_char1: [
            { id: 'g-gold', type: 'gold', amount: 500_000_000 },
            { id: 'g-cape', type: 'equipment', itemHrid: '/items/sinister_cape', enhancementLevel: 10 },
            { id: 'g-enh', type: 'skill', skillHrid: '/skills/enhancing', targetLevel: 110 },
            { id: 'g-obs', type: 'house', roomHrid: '/house_rooms/observatory', targetLevel: 8 },
        ],
    };
    plannerContext.value = fixtureContext();
});

afterEach(() => {
    // A panel remembers which form was open between openings, which is right
    // for a panel and wrong for a test
    goalPlannerPanel.hide({ remember: false });
    goalPlannerPanel.formType = null;
    goalPlannerPanel.goals = [];
    goalPlannerPanel.plans = [];
    goalPlannerPanel.pricedAt = null;
    goalPlannerPanel.loaded = null;
});

describe('drawing a plan', () => {
    test('every goal type renders without a section failing', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Goal Planner');
        expect(text()).toContain('Have 500.0M coins');
        expect(text()).toContain('Own Sinister Cape +10');
        expect(text()).toContain('Enhancing 110');
        expect(text()).toContain('Observatory 8');
    });

    test('the steps of a plan are on screen, in order, with their bill', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        const body = text();
        expect(body).toContain('Buy Sinister Cape');
        expect(body).toContain('Enhance Sinister Cape +0 → +10');
        // Spending 47M against 50M held needs no grind first; the house goal does
        expect(body).toContain('Earn');
        expect(body).toContain('Priced at 10:00.');
    });

    test('a satisfied step is struck through rather than dropped', async () => {
        plannerContext.value.ownedEnhancementLevel = () => 0;
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).toContain('Already hold Sinister Cape');
        const struck = [...document.querySelectorAll('#toolasha-goal-planner-panel *')].some(
            (element) => element.style.textDecoration === 'line-through'
        );
        expect(struck).toBe(true);
    });

    test('a context that answers nothing still draws every goal', async () => {
        // Everything absent is the ordinary state before the market has loaded,
        // and it must degrade to warnings rather than to a blank panel
        plannerContext.value = { gold: 0, levelExperienceTable: null };
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('⚠');
    });
});

describe('a step that says buy can go and buy', () => {
    /**
     * Click a button by its label, on the step whose text contains `within`.
     * @param {string} label - Button text
     * @param {string} [within] - Text the step row must contain
     * @returns {boolean} Whether one was found
     */
    function press(label, within = '') {
        const found = [...document.querySelectorAll('#toolasha-goal-planner-panel button')].find(
            (element) =>
                element.textContent === label && (!within || element.parentElement?.textContent.includes(within))
        );
        found?.click();
        return Boolean(found);
    }

    test('house materials go across as a shopping list of what is missing', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(press('Buy', 'material')).toBe(true);
        const list = shopping.calls.find((call) => call.kind === 'list');
        expect(list.items).toEqual([{ itemHrid: '/items/log', name: 'Log', count: 500 }]);
    });

    test('a single purchase goes the same way, named and counted', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(press('Buy', 'Buy Sinister Cape')).toBe(true);
        expect(shopping.calls[0].items).toEqual([
            { itemHrid: '/items/sinister_cape', name: 'Sinister Cape', count: 1 },
        ]);
    });

    test('a craft hands the action to the missing-materials machinery', async () => {
        plannerContext.value.acquire = () => ({
            strategy: 'craft',
            totalCost: 9_000_000,
            craftCost: 9_000_000,
            buyPrice: 12_000_000,
            actionHrid: '/actions/crafting/sinister_cape',
            actionsNeeded: 3,
            requires: [],
        });
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(press('Buy mats')).toBe(true);
        expect(shopping.calls[0]).toEqual({
            kind: 'action',
            actionHrid: '/actions/crafting/sinister_cape',
            numActions: 3,
        });
    });

    test('a step that is already satisfied offers no trip to the marketplace', async () => {
        plannerContext.value.owned = () => 10_000;
        plannerContext.value.ownedEnhancementLevel = () => 10;
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(press('Buy mats')).toBe(false);
    });
});

describe('reading the plan', () => {
    test('a step is wrapped rather than cut off, so no tooltip has to cover the plan', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        const clipped = [...document.querySelectorAll('#toolasha-goal-planner-panel *')].filter(
            (element) => element.style.textOverflow === 'ellipsis'
        );
        expect(clipped).toEqual([]);
    });

    test('the pricing note is said once for the panel, not once per goal', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        const occurrences = text().split('Priced at 10:00.').length - 1;
        expect(occurrences).toBe(1);
    });

    test('the bottom line says which two figures it is the difference of', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).toContain('Left to do');
        expect(text()).toContain('earn');
        expect(text()).toContain('spend');
    });

    test('one combat loadout is not a choice, and is not offered as one', async () => {
        plannerContext.value.combatStatus = { loadoutName: 'Fighting', loadoutChoices: ['Fighting'] };
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).not.toContain('Combat rates judged against');
    });

    test('two combat loadouts are a guess, so the guess can be corrected', async () => {
        plannerContext.value.combatStatus = { loadoutName: 'Ranged', loadoutChoices: ['Fighting', 'Ranged'] };
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).toContain('Combat rates judged against');
        const picker = document.querySelector('#toolasha-goal-planner-panel select');
        expect(picker.value).toBe('Ranged');
    });
});

describe('the goal list', () => {
    test('an empty list says so instead of drawing nothing', async () => {
        store.data = {};
        goalPlannerPanel.show();
        await goalPlannerPanel.load();

        expect(text()).toContain('No goals yet');
    });

    test('every goal type offers a creation form that draws', async () => {
        goalPlannerPanel.show();
        await settled();

        for (const type of ['gold', 'equipment', 'skill', 'house']) {
            goalPlannerPanel.formType = type;
            goalPlannerPanel._render();
            expect(text()).not.toContain('could not be drawn');
            expect(document.querySelectorAll(`#${'toolasha-goal-planner-panel'} input`).length).toBeGreaterThan(0);
        }
    });

    test('removing a goal takes its plan with it', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();
        expect(text()).toContain('Observatory 8');

        await goalPlannerPanel.removeGoal('g-obs');

        expect(text()).not.toContain('Observatory 8');
        expect(text()).toContain('Have 500.0M coins');
    });
});

describe('whether the panel was open', () => {
    test('opening it is remembered, and closing it is', async () => {
        const { wasOpen } = await import('../../utils/panel-geometry.js');

        goalPlannerPanel.show();
        await settled();
        await expect(wasOpen('goalPlannerPanel')).resolves.toBe(true);

        goalPlannerPanel.hide();
        await settled();
        await expect(wasOpen('goalPlannerPanel')).resolves.toBe(false);
    });
});
