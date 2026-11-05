/**
 * @vitest-environment happy-dom
 *
 * The guided walk through an Iron Bell batch.
 *
 * The load-bearing test in this file is the last one: **the walk never presses a
 * game button.** That is the project's hard rule — one user click is exactly one
 * game action — and it is asserted directly, by watching every click there is:
 * `Element.prototype.click`, and every event dispatched anywhere in the document
 * for the whole length of a walk. The walk may navigate and it may type into the
 * game's own count box; a click it may not do.
 *
 * The rest pins the thing a second walker would have got wrong: alchemy is one
 * action for every item in the game, so the two alchemy steps must wait for the
 * player to select the item before a count means anything.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatWithSeparator } from '../../utils/formatters.js';

const mocks = vi.hoisted(() => ({
    settings: {},
    wsHandlers: new Map(),
    dmHandlers: new Map(),
    navigatedActions: [],
    currentActions: [],
    alchemyOpened: [],
    inventory: {},
    alchemyResult: { opened: false, selected: false },
    tabsSelected: [],
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => mocks.settings[key] },
}));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => mocks.wsHandlers.set(type, handler),
        off: (type) => mocks.wsHandlers.delete(type),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => mocks.dmHandlers.set(event, handler),
        off: (event) => mocks.dmHandlers.delete(event),
        getCurrentActions: () => mocks.currentActions,
        getItemDetails: (hrid) => ({ name: hrid === '/items/star_fruit' ? 'Star Fruit' : 'Foraging Essence' }),
    },
}));

vi.mock('../../utils/house-cost-calculator.js', () => ({
    getInventoryCount: (hrid) => mocks.inventory[hrid] ?? 0,
}));

vi.mock('../../utils/item-navigation.js', () => ({
    navigateToEnhanceItem: () => false,
    navigateToAction: (actionHrid) => {
        mocks.navigatedActions.push(actionHrid);
        return true;
    },
    // The game's item-menu handler: by default it cannot open Alchemy on an item, so the walk falls back
    navigateToAlchemyItem: (itemHrid, type) => {
        mocks.alchemyOpened.push([itemHrid, type]);
        return mocks.alchemyResult;
    },
}));

vi.mock('../../utils/alchemy-navigation.js', () => ({
    selectAlchemyTab: async (type) => {
        mocks.tabsSelected.push(type);
    },
}));

vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: () => {},
}));

// The real react-input, deliberately: what it dispatches on the game's own count
// box is part of what the no-click test is watching.
vi.mock('../../utils/action-panel-helper.js', () => ({
    // The game's real rule: the repeat box is the input inside the max-count container, not the first input
    findActionInput: (panel) => panel.querySelector('[class*="maxActionCountInput"] input'),
    resolveDetailPanel: (panel) => ({ actionHrid: panel.dataset.actionHrid || null }),
}));

const { default: craftingPlanWalk } = await import('../crafting-plan/crafting-plan-walk.js');
const { buildQueueSteps, startQueueWalk, legIsUnlimited, DECOMPOSE_ACTION, COINIFY_ACTION, MAX_STEP_ACTIONS } =
    await import('./ironcow-queue-walk.js');

const STARFRUIT = '/items/star_fruit';
const ESSENCE = '/items/foraging_essence';
const FORAGE_ACTION = '/actions/foraging/star_fruit';

/** A costed loop, only the parts the walk reads */
function loop(overrides = {}) {
    return {
        missing: [],
        items: {
            starfruitHrid: STARFRUIT,
            starfruitName: 'Star Fruit',
            essenceHrid: ESSENCE,
            essenceName: 'Foraging Essence',
            forageActionHrid: FORAGE_ACTION,
        },
        ...overrides,
    };
}

/** A balanced batch, as `balanceBatch` returns one */
function batch(overrides = {}) {
    return { forageActions: 1600, decomposeActions: 1600, coinifyActions: 480, ...overrides };
}

/**
 * Put an action detail panel on the page, with a count box and, optionally, an
 * item in the alchemy requirement slot.
 * @param {string} actionHrid - What the panel is showing
 * @param {string|null} [selectedItemHrid] - What is in the slot
 */
function mountPanel(actionHrid, selectedItemHrid = null) {
    const slot = selectedItemHrid
        ? `<div class="SkillActionDetail_itemRequirements__x">
               <div class="Item_itemContainer__y"><svg><use href="#${selectedItemHrid.split('/').pop()}"></use></svg></div>
           </div>`
        : '';
    document.body.innerHTML =
        `<div class="SkillActionDetail_skillActionDetail__abc" data-action-hrid="${actionHrid}">` +
        `<div class="SkillActionDetail_maxActionCountInput__z"><input value="1" /></div>${slot}</div>`;
    return document.querySelector('input');
}

/** The action queue answering the player's own press on one action */
function pressed(actionHrid, primaryItemHash = '', stored = undefined) {
    // The server keeps the count that was typed, unless a test says otherwise; an unlimited step is a row
    // with no count
    const step = craftingPlanWalk.currentStep();
    const row = { id: `new-${actionHrid}`, actionHrid, primaryItemHash };
    if (stored === undefined) {
        row.hasMaxCount = !step?.unlimited;
        row.maxCount = step?.unlimited ? 0 : (step?.count ?? 0);
    } else {
        row.hasMaxCount = stored !== null;
        row.maxCount = stored ?? 0;
    }
    mocks.wsHandlers.get('actions_updated')?.({ endCharacterActions: [row] });
}

/** The press, then the player's own press on Next */
function pressedThenNext(...args) {
    pressed(...args);
    craftingPlanWalk.next();
}

beforeEach(() => {
    vi.useFakeTimers();
    mocks.settings = {};
    mocks.navigatedActions = [];
    mocks.currentActions = [];
    mocks.alchemyOpened = [];
    mocks.inventory = {};
    mocks.alchemyResult = { opened: false, selected: false };
    mocks.tabsSelected = [];
    document.body.innerHTML = '';
});

afterEach(() => {
    craftingPlanWalk.disable();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('the three steps', () => {
    test('are forage, decompose then coinify — the order the loop consumes them in', () => {
        const steps = buildQueueSteps(loop(), batch());

        expect(steps.map((step) => step.actionHrid)).toEqual([FORAGE_ACTION, DECOMPOSE_ACTION, COINIFY_ACTION]);
        expect(steps.map((step) => step.actions)).toEqual([1600, 1600, 480]);
    });

    test('the alchemy steps name the item that has to be in the slot; foraging does not', () => {
        const [forage, decompose, coinify] = buildQueueSteps(loop(), batch());

        expect(forage.requiresItemHrid).toBeUndefined();
        expect(decompose.requiresItemHrid).toBe(STARFRUIT);
        expect(coinify.requiresItemHrid).toBe(ESSENCE);
        // The walk opens the alchemy panel with the item chosen (when held) and says the press is the player's
        expect(decompose.alchemyType).toBe('decompose');
        expect(coinify.alchemyType).toBe('coinify');
        expect(forage.alchemyType).toBeUndefined();
    });

    test('Max queues decompose and coinify as Repeat ∞ rows with no count typed; forage would stay counted', () => {
        const steps = buildQueueSteps(loop(), batch({ forageActions: 40, max: { fruitName: 'Star Fruit' } }));
        const [forage, decompose, coinify] = steps;

        expect(forage.unlimited).toBeUndefined();
        expect(forage.actions).toBe(40);
        expect(decompose.unlimited).toBe(true);
        expect(decompose.actions).toBe(0);
        expect(coinify.unlimited).toBe(true);
        expect(decompose.verifyCount).toBeUndefined();
        expect(legIsUnlimited({ max: {} }, 'forage')).toBe(false);
        expect(legIsUnlimited({}, 'decompose')).toBe(false);
    });

    test('a count above the 32-bit limit is still split; below it is one row', () => {
        expect(buildQueueSteps(loop(), batch({ decomposeActions: 250_000, forageActions: 0 }))[0].actions).toBe(
            250_000
        );
        const huge = buildQueueSteps(loop(), batch({ forageActions: MAX_STEP_ACTIONS + 5 })).filter((s) =>
            s.key.startsWith('ironbell:forage')
        );
        expect(huge.map((s) => s.actions)).toEqual([MAX_STEP_ACTIONS, 5]);
        expect(MAX_STEP_ACTIONS).toBe(2_147_483_647);
    });

    test('a leg sized at nothing is not a step to stand in front of', () => {
        const steps = buildQueueSteps(loop(), batch({ coinifyActions: 0 }));
        expect(steps.map((step) => step.key)).toEqual(['ironbell:forage', 'ironbell:decompose']);
    });

    test('nothing to walk without a costed loop or a batch', () => {
        expect(buildQueueSteps(null, batch())).toEqual([]);
        expect(buildQueueSteps(loop({ missing: ['coinifying'] }), batch())).toEqual([]);
        expect(buildQueueSteps(loop(), null)).toEqual([]);
        expect(startQueueWalk(null, null)).toBe(false);
    });
});

describe('a week-sized leg over the cap splits into repeats', () => {
    test('a leg at or under the cap is still exactly one step', () => {
        const steps = buildQueueSteps(loop(), batch({ forageActions: MAX_STEP_ACTIONS }));
        const forageSteps = steps.filter((step) => step.actionHrid === FORAGE_ACTION);
        expect(forageSteps).toHaveLength(1);
        expect(forageSteps[0].actions).toBe(MAX_STEP_ACTIONS);
        expect(forageSteps[0].key).toBe('ironbell:forage');
    });

    test('a leg over the cap becomes several steps of the same action, in order, summing to the count', () => {
        const total = MAX_STEP_ACTIONS * 2 + 50_000;
        const steps = buildQueueSteps(loop(), batch({ forageActions: total, decomposeActions: 0, coinifyActions: 0 }));

        expect(steps).toHaveLength(3);
        expect(steps.every((step) => step.actionHrid === FORAGE_ACTION)).toBe(true);
        expect(steps.map((step) => step.actions)).toEqual([MAX_STEP_ACTIONS, MAX_STEP_ACTIONS, 50_000]);
        expect(steps.reduce((sum, step) => sum + step.actions, 0)).toBe(total);
        // Distinct keys, so the walk's own step-tracking never confuses one
        // repeat's press for another's.
        expect(new Set(steps.map((step) => step.key)).size).toBe(3);
        expect(steps.map((step) => step.label)).toEqual([
            `forage ${formatWithSeparator(MAX_STEP_ACTIONS)} × Star Fruit — repeat 1 of 3`,
            `forage ${formatWithSeparator(MAX_STEP_ACTIONS)} × Star Fruit — repeat 2 of 3`,
            `forage ${formatWithSeparator(50_000)} × Star Fruit — repeat 3 of 3`,
        ]);
    });

    test('an alchemy leg over the cap still names the item every repeat has to wait for', () => {
        const total = MAX_STEP_ACTIONS + 1;
        const steps = buildQueueSteps(loop(), batch({ forageActions: 0, decomposeActions: total, coinifyActions: 0 }));

        expect(steps).toHaveLength(2);
        expect(steps.every((step) => step.requiresItemHrid === STARFRUIT)).toBe(true);
        expect(steps.every((step) => step.actionHrid === DECOMPOSE_ACTION)).toBe(true);
    });

    test('the walk stands the player in front of every repeat, one press each', () => {
        const total = MAX_STEP_ACTIONS + 10;
        mountPanel(FORAGE_ACTION);
        expect(startQueueWalk(loop(), batch({ forageActions: total, decomposeActions: 0, coinifyActions: 0 }))).toBe(
            true
        );
        vi.advanceTimersByTime(200);
        expect(document.querySelector('input').value).toBe(String(MAX_STEP_ACTIONS));

        // First repeat pressed: the walk moves to the second repeat of the same
        // action, not to decompose.
        pressedThenNext(FORAGE_ACTION);
        expect(mocks.navigatedActions).toEqual([FORAGE_ACTION, FORAGE_ACTION]);
        mountPanel(FORAGE_ACTION);
        vi.advanceTimersByTime(200);
        expect(document.querySelector('input').value).toBe('10');

        // Second press ends the leg — nothing left to walk.
        pressedThenNext(FORAGE_ACTION);
        expect(craftingPlanWalk.currentStep()).toBeNull();
    });
});

describe('the count the server kept, and opening Alchemy on the item', () => {
    const nextButton = () => document.querySelector('[data-role="next"]');

    test('a server that stores less than was typed shows a warning on the Queued step, and it ends the last one', () => {
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch({ forageActions: 5000, decomposeActions: 0, coinifyActions: 0 }));
        pressed(FORAGE_ACTION, '', 3000);

        // It was the last step: the walk ends done, with the warning still on screen
        expect(craftingPlanWalk.currentStep()).toBeNull();
        expect(document.body.textContent).toContain('The game queued 3,000 instead of the 5,000 typed');
        expect(document.body.textContent).toContain('the queue is short');
    });

    test('on a step that is not the last, the warning stays on the Queued state beside Next', () => {
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch({ forageActions: 5000 }));
        pressed(FORAGE_ACTION, '', 3000);

        expect(craftingPlanWalk.currentStep().key).toBe('ironbell:forage');
        expect(document.body.textContent).toContain('Queued ✓');
        expect(document.body.textContent).toContain('The game queued 3,000 instead of the 5,000 typed');
        expect(nextButton().hidden).toBe(false);
        expect(mocks.navigatedActions).toEqual([FORAGE_ACTION]);
    });

    test('a count above the old 100,000 step arrives as typed in one row', () => {
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch({ forageActions: 1_500_000, decomposeActions: 0, coinifyActions: 0 }));
        vi.advanceTimersByTime(200);
        expect(document.querySelector('input').value).toBe('1500000');
        pressed(FORAGE_ACTION);
        expect(craftingPlanWalk.currentStep()).toBeNull();
        expect(document.body.textContent).not.toContain('instead of');
    });

    test('a Max alchemy step is checked for being Repeat ∞, not for a count', () => {
        mocks.inventory[STARFRUIT] = 100;
        mocks.inventory[ESSENCE] = 100;
        startQueueWalk(loop(), batch({ forageActions: 0, max: {} }));
        pressed(DECOMPOSE_ACTION, `${DECOMPOSE_ACTION}::${STARFRUIT}`);
        expect(craftingPlanWalk.currentStep().actionHrid).toBe(DECOMPOSE_ACTION);
        craftingPlanWalk.next();
        expect(craftingPlanWalk.currentStep().actionHrid).toBe(COINIFY_ACTION);
        // a coinify that came back with a count is flagged
        pressed(COINIFY_ACTION, `${COINIFY_ACTION}::${ESSENCE}`, 480);
        expect(craftingPlanWalk.currentStep()).toBeNull();
        expect(document.body.textContent).toContain('instead of Repeat ∞');
    });

    test('nothing is typed into the count box of an ∞ step', () => {
        mocks.inventory[STARFRUIT] = 100;
        mountPanel(DECOMPOSE_ACTION, STARFRUIT);
        const before = document.querySelector('input').value;
        startQueueWalk(loop(), batch({ forageActions: 0, max: {} }));
        vi.advanceTimersByTime(2000);
        expect(document.querySelector('input').value).toBe(before);
    });

    describe('the item in the alchemy slot', () => {
        test('says "in the slot" only once the slot was read showing the item', () => {
            mocks.inventory[STARFRUIT] = 100;
            mocks.alchemyResult = { opened: true, selected: true };
            startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 100, coinifyActions: 0 }));

            expect(mocks.alchemyOpened[0]).toEqual([STARFRUIT, 'decompose']);
            expect(mocks.navigatedActions).toEqual([]);
            // the handler was called, but the slot has not been read yet: no claim
            expect(document.body.textContent).toContain('choose Star Fruit in the slot');
            expect(document.body.textContent).not.toContain('is in the slot');

            mountPanel(DECOMPOSE_ACTION, STARFRUIT);
            vi.advanceTimersByTime(700);
            expect(document.body.textContent).toContain('Star Fruit is in the slot; the Start press is yours');
        });

        test('reads the slot through xlink:href too', () => {
            mocks.inventory[STARFRUIT] = 100;
            mocks.alchemyResult = { opened: true, selected: true };
            startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 100, coinifyActions: 0 }));
            document.body.innerHTML =
                '<div class="SkillActionDetail_itemRequirements__x"><div class="Item_itemContainer__y">' +
                '<svg><use xlink:href="#star_fruit"></use></svg></div></div>';
            vi.advanceTimersByTime(700);
            expect(document.body.textContent).not.toContain('choose Star Fruit');
            expect(craftingPlanWalk.currentStep().itemSelected).toBe(true);
        });

        test('the handler is asserted again, bounded, while the slot shows the wrong item', () => {
            mocks.inventory[STARFRUIT] = 100;
            mocks.alchemyResult = { opened: true, selected: true };
            startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 100, coinifyActions: 0 }));
            mountPanel(DECOMPOSE_ACTION, '/items/holy_milk');

            vi.advanceTimersByTime(20_000);
            expect(mocks.alchemyOpened.length).toBeGreaterThan(1);
            expect(mocks.alchemyOpened.length).toBeLessThanOrEqual(7);
            expect(craftingPlanWalk.currentStep().itemSelected).toBe(false);
        });

        test('if the game changes the slot back while the step waits, it is chosen again', () => {
            mocks.inventory[STARFRUIT] = 100;
            mocks.alchemyResult = { opened: true, selected: true };
            startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 100, coinifyActions: 0 }));
            mountPanel(DECOMPOSE_ACTION, STARFRUIT);
            vi.advanceTimersByTime(1200);
            expect(craftingPlanWalk.currentStep().itemSelected).toBe(true);
            const before = mocks.alchemyOpened.length;

            mountPanel(DECOMPOSE_ACTION, '/items/holy_milk');
            vi.advanceTimersByTime(2500);
            expect(craftingPlanWalk.currentStep().itemSelected).toBe(false);
            expect(mocks.alchemyOpened.length).toBeGreaterThan(before);
        });

        test('an item that is not in the bag is not claimed: it says so, offers Skip, and picks it as it arrives', () => {
            mocks.inventory[ESSENCE] = 0;
            mocks.alchemyResult = { opened: true, selected: true };
            startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 0, coinifyActions: 40 }));

            // the action is opened, but the handler is not asked for an item the game cannot offer
            expect(mocks.alchemyOpened).toEqual([]);
            expect(mocks.navigatedActions).toEqual([COINIFY_ACTION]);
            expect(document.body.textContent).toContain('Foraging Essence is not in your bag yet');
            expect(document.body.textContent).toContain('Skip');
            expect(document.body.textContent).not.toContain('is in the slot');

            // the essence arrives while a decompose runs
            mocks.inventory[ESSENCE] = 500;
            mocks.dmHandlers.get('items_updated')();
            expect(mocks.alchemyOpened).toEqual([[ESSENCE, 'coinify']]);
            mountPanel(COINIFY_ACTION, ESSENCE);
            vi.advanceTimersByTime(1500);
            expect(document.body.textContent).toContain('Foraging Essence is in the slot');
        });

        test('a row for the wrong item does not count, and the strip says what was queued instead', () => {
            mocks.inventory[ESSENCE] = 500;
            startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 0, coinifyActions: 40 }));
            pressed(COINIFY_ACTION, `${COINIFY_ACTION}::${STARFRUIT}`);

            expect(craftingPlanWalk.currentStep().done).toBe(false);
            expect(document.body.textContent).toContain('was queued instead of Foraging Essence');
            expect(nextButton().hidden).toBe(true);
        });

        test('Skip is offered on a step still waiting for its item', () => {
            mocks.inventory[ESSENCE] = 0;
            startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 100, coinifyActions: 40 }));
            craftingPlanWalk.skip();
            expect(craftingPlanWalk.currentStep().actionHrid).toBe(COINIFY_ACTION);
        });
    });

    test('a step is Queued ✓ with a Next button after the press; the next step opens only on Next', () => {
        mocks.inventory[STARFRUIT] = 100;
        mocks.inventory[ESSENCE] = 100;
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch());
        pressed(FORAGE_ACTION);
        expect(mocks.navigatedActions).toEqual([FORAGE_ACTION]);
        expect(document.body.textContent).toContain('Queued ✓');

        craftingPlanWalk.next();
        craftingPlanWalk.next();
        expect(mocks.navigatedActions).toEqual([FORAGE_ACTION, DECOMPOSE_ACTION]);
        expect(mocks.alchemyOpened).toHaveLength(1);
        expect(craftingPlanWalk.currentStep().actionHrid).toBe(DECOMPOSE_ACTION);
    });
});

describe('the count box on the game’s alchemy form', () => {
    /**
     * The alchemy panel as the live game draws it: several inputs (a repeat box showing ∞ with a max length of
     * 10, and others holding 41730 and 102), the item slot with its icon carrying only xlink:href.
     */
    const alchemyForm = (item = 'star_fruit', repeatValue = '∞') => {
        document.body.innerHTML =
            '<div class="SkillActionDetail_skillActionDetail__a SkillActionDetail_alchemyComponent__b">' +
            `<div class="SkillActionDetail_itemRequirements__x"><div class="Item_itemContainer__y"><svg><use xlink:href="#${item}"></use></svg></div></div>` +
            '<div class="other__c"><input data-name="price" value="41730" /></div>' +
            `<div class="SkillActionDetail_maxActionCountInput__q"><input data-name="repeat" maxlength="10" value="${repeatValue}" /></div>` +
            '<input data-name="other" value="102" />' +
            '</div>';
        return {
            repeat: () => document.querySelector('[data-name="repeat"]'),
            price: () => document.querySelector('[data-name="price"]'),
            other: () => document.querySelector('[data-name="other"]'),
        };
    };
    const startCounted = () => {
        mocks.inventory[STARFRUIT] = 5000;
        mocks.alchemyResult = { opened: true, selected: true };
        return startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 1600, coinifyActions: 0 }));
    };

    test('after the slot reads right the count goes in the repeat box only, and is said filled once read back', () => {
        const form = alchemyForm();
        startCounted();
        vi.advanceTimersByTime(3000);

        expect(form.repeat().value).toBe('1600');
        expect(form.price().value).toBe('41730');
        expect(form.other().value).toBe('102');
        expect(document.body.textContent).toContain('count 1,600 filled');
    });

    test('nothing is typed while the wrong item is in the slot', () => {
        const form = alchemyForm('holy_milk');
        startCounted();
        vi.advanceTimersByTime(3000);
        expect(form.repeat().value).toBe('∞');
        expect(craftingPlanWalk.currentStep().countFilled).toBe(false);
    });

    test('it goes in again when the form is remounted and cleared', () => {
        alchemyForm();
        startCounted();
        vi.advanceTimersByTime(3000);
        expect(document.querySelector('[data-name="repeat"]').value).toBe('1600');

        const fresh = alchemyForm();
        expect(fresh.repeat().value).toBe('∞');
        vi.advanceTimersByTime(3000);
        expect(fresh.repeat().value).toBe('1600');
        expect(craftingPlanWalk.currentStep().countFilled).toBe(true);
    });

    test('a number the player typed since is never overwritten', () => {
        const form = alchemyForm();
        startCounted();
        vi.advanceTimersByTime(3000);

        // the player types their own figure: a trusted input event in the count box
        form.repeat().value = '777';
        const typed = new Event('input', { bubbles: true });
        Object.defineProperty(typed, 'isTrusted', { value: true });
        form.repeat().dispatchEvent(typed);
        vi.advanceTimersByTime(5000);
        expect(form.repeat().value).toBe('777');

        // and the form being remounted does not bring our figure back over theirs
        const fresh = alchemyForm();
        vi.advanceTimersByTime(5000);
        expect(fresh.repeat().value).toBe('∞');
    });

    test('a box that does not keep the figure is not called filled: the strip says to type it', () => {
        const form = alchemyForm();
        const shown = '∞';
        Object.defineProperty(form.repeat(), 'value', {
            get: () => shown,
            set: () => {},
            configurable: true,
        });
        startCounted();
        vi.advanceTimersByTime(8000);

        expect(craftingPlanWalk.currentStep().countFilled).toBe(false);
        expect(document.body.textContent).toContain('type 1,600 in the count box');
        expect(document.body.textContent).not.toContain('filled');
        expect(shown).toBe('∞');
    });

    test('a counted forage step still fills, and says so', () => {
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch({ forageActions: 5000, decomposeActions: 0, coinifyActions: 0 }));
        vi.advanceTimersByTime(300);
        expect(document.querySelector('input').value).toBe('5000');
        expect(document.body.textContent).toContain('count 5,000 filled');
    });

    test('a forage box that is remounted is filled again', () => {
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch({ forageActions: 5000, decomposeActions: 0, coinifyActions: 0 }));
        vi.advanceTimersByTime(300);
        const fresh = mountPanel(FORAGE_ACTION);
        expect(fresh.value).toBe('1');
        vi.advanceTimersByTime(2000);
        expect(fresh.value).toBe('5000');
    });
});

describe('the alchemy watcher keeps to one chain and leaves the player alone', () => {
    const startItem = () => {
        mocks.inventory[STARFRUIT] = 100;
        mocks.alchemyResult = { opened: true, selected: true };
        startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 100, coinifyActions: 0 }));
    };

    test('many items_updated while the item is absent add no timers and refill nothing', () => {
        mocks.inventory[ESSENCE] = 0;
        startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 0, coinifyActions: 40 }));
        vi.advanceTimersByTime(1000);
        const timers = vi.getTimerCount();
        for (let i = 0; i < 40; i++) mocks.dmHandlers.get('items_updated')();
        expect(vi.getTimerCount()).toBe(timers);
        expect(mocks.alchemyOpened).toEqual([]);
    });

    test('when the item arrives the step looks at once, in a fresh short window, still one chain', () => {
        mocks.inventory[ESSENCE] = 0;
        mocks.alchemyResult = { opened: true, selected: true };
        startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 0, coinifyActions: 40 }));
        vi.advanceTimersByTime(60_000);
        const timers = vi.getTimerCount();
        mocks.inventory[ESSENCE] = 500;
        mocks.dmHandlers.get('items_updated')();
        expect(mocks.alchemyOpened).toEqual([[ESSENCE, 'coinify']]);
        expect(vi.getTimerCount()).toBe(timers);
    });

    test('after the settle window a wrong slot is reported, never undone', () => {
        startItem();
        mountPanel(DECOMPOSE_ACTION, STARFRUIT);
        vi.advanceTimersByTime(12_000);
        expect(craftingPlanWalk.currentStep().itemSelected).toBe(true);
        const before = mocks.alchemyOpened.length;

        // the player picks another item themselves
        mountPanel(DECOMPOSE_ACTION, '/items/holy_milk');
        vi.advanceTimersByTime(5000);
        expect(mocks.alchemyOpened.length).toBe(before);
        expect(craftingPlanWalk.currentStep().itemSelected).toBe(false);
        expect(craftingPlanWalk.currentStep().slotNote).toBe('the slot shows Foraging Essence');
    });

    test('having left the alchemy panel after the window, the walk does not navigate back', () => {
        startItem();
        mountPanel(DECOMPOSE_ACTION, STARFRUIT);
        vi.advanceTimersByTime(12_000);
        const before = mocks.alchemyOpened.length;
        document.body.innerHTML = '';
        vi.advanceTimersByTime(10_000);
        expect(mocks.alchemyOpened.length).toBe(before);
        expect(mocks.navigatedActions).toEqual([]);
    });
});

describe('a count the player chose is left alone', () => {
    test('the game’s own ∞ toggle on the same box stops the filling and the strip stays truthful', () => {
        mocks.inventory[STARFRUIT] = 100;
        mocks.alchemyResult = { opened: true, selected: true };
        document.body.innerHTML =
            '<div class="SkillActionDetail_skillActionDetail__a SkillActionDetail_alchemyComponent__b">' +
            '<div class="SkillActionDetail_itemRequirements__x"><div class="Item_itemContainer__y"><svg><use xlink:href="#star_fruit"></use></svg></div></div>' +
            '<div class="SkillActionDetail_maxActionCountInput__q"><input maxlength="10" value="∞" /></div></div>';
        startQueueWalk(loop(), batch({ forageActions: 0, decomposeActions: 1600, coinifyActions: 0 }));
        vi.advanceTimersByTime(3000);
        const box = document.querySelector('input');
        expect(box.value).toBe('1600');

        box.value = '∞';
        vi.advanceTimersByTime(5000);
        expect(box.value).toBe('∞');
        expect(craftingPlanWalk.currentStep().countFilled).toBe(false);
        expect(document.body.textContent).toContain('left as you set it');
        expect(document.body.textContent).not.toContain('type 1,600');
    });
});

describe('walking it', () => {
    test('opens each action in turn, and only advances on the press', () => {
        mountPanel(FORAGE_ACTION);
        expect(startQueueWalk(loop(), batch())).toBe(true);
        expect(mocks.navigatedActions).toEqual([FORAGE_ACTION]);

        pressedThenNext(FORAGE_ACTION);
        expect(mocks.navigatedActions).toEqual([FORAGE_ACTION, DECOMPOSE_ACTION]);

        // The queue answering a decompose of something else is not this step
        pressedThenNext(DECOMPOSE_ACTION, '/items/holy_milk');
        expect(mocks.navigatedActions).toHaveLength(2);

        pressedThenNext(DECOMPOSE_ACTION, `${DECOMPOSE_ACTION}::${STARFRUIT}`);
        expect(mocks.navigatedActions).toEqual([FORAGE_ACTION, DECOMPOSE_ACTION, COINIFY_ACTION]);
    });

    test('types the forage count into the game’s own count box', () => {
        const input = mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch());
        vi.advanceTimersByTime(200);

        expect(input.value).toBe('1600');
    });

    test('types nothing into an alchemy panel until the right item is in the slot', () => {
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch());
        pressedThenNext(FORAGE_ACTION);

        // The player is on decompose, but with the wrong item selected
        const input = mountPanel(DECOMPOSE_ACTION, '/items/holy_milk');
        vi.advanceTimersByTime(2000);
        expect(input.value).toBe('1');

        // They put the fruit in the slot
        const withFruit = mountPanel(DECOMPOSE_ACTION, STARFRUIT);
        vi.advanceTimersByTime(1000);
        expect(withFruit.value).toBe('1600');
    });

    test('ends on a character switch, like every other walk', () => {
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch());
        expect(craftingPlanWalk.currentStep()).not.toBeNull();

        mocks.dmHandlers.get('character_switching')?.();
        expect(craftingPlanWalk.currentStep()).toBeNull();
    });

    test('Skip leaves a step undone and Stop ends the walk', () => {
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch());

        craftingPlanWalk.skip();
        expect(craftingPlanWalk.currentStep().actionHrid).toBe(DECOMPOSE_ACTION);

        craftingPlanWalk.stop('');
        expect(craftingPlanWalk.currentStep()).toBeNull();
    });
});

describe('the hard rule', () => {
    test('never presses a game button: no click is issued anywhere, at any step', () => {
        const clicked = [];
        const dispatched = [];
        // Found by walking up from a real element rather than off a global: the
        // one that actually owns the method is the one a patch has to sit on.
        const owner = (method) => {
            let proto = Object.getPrototypeOf(document.createElement('input'));
            while (proto && !Object.prototype.hasOwnProperty.call(proto, method)) proto = Object.getPrototypeOf(proto);
            return proto;
        };
        const clickProto = owner('click');
        const dispatchProto = owner('dispatchEvent');
        const realClick = clickProto.click;
        const realDispatch = dispatchProto.dispatchEvent;
        clickProto.click = function patchedClick() {
            clicked.push(this);
        };
        dispatchProto.dispatchEvent = function patchedDispatch(event) {
            dispatched.push(event.type);
            return realDispatch.call(this, event);
        };

        try {
            mountPanel(FORAGE_ACTION);
            startQueueWalk(loop(), batch());
            vi.advanceTimersByTime(2000);

            pressed(FORAGE_ACTION);
            mountPanel(DECOMPOSE_ACTION, STARFRUIT);
            vi.advanceTimersByTime(2000);

            pressed(DECOMPOSE_ACTION, `${DECOMPOSE_ACTION}::${STARFRUIT}`);
            mountPanel(COINIFY_ACTION, ESSENCE);
            vi.advanceTimersByTime(2000);

            pressed(COINIFY_ACTION, `${COINIFY_ACTION}::${ESSENCE}`);
            vi.advanceTimersByTime(2000);
        } finally {
            clickProto.click = realClick;
            dispatchProto.dispatchEvent = realDispatch;
        }

        expect(clicked).toEqual([]);
        expect(dispatched).not.toContain('click');
        expect(dispatched).not.toContain('mousedown');
        expect(dispatched).not.toContain('pointerdown');
        // What it *does* dispatch is the input event that tells React a number
        // was typed into the game's own count box.
        expect(dispatched).toContain('input');
    });
});
