/**
 * An unqueued action set to Repeat ∞ is shown for what it can actually run.
 *
 * The panel used to print `Total time: ∞` / `Total profit: ∞` while the queue row for the very
 * same action, one click later, printed `[0h 06m 40s · mat: 40]`. Both were describing one run,
 * so the fix is not a second calculation that happens to agree — it is the same calculation.
 * The load-bearing test here is `the panel figure is the queue figure`: it asserts the two
 * strings equal each other from one input rather than pinning two hardcoded literals that could
 * drift apart the next time the queue's arithmetic changes.
 *
 * Honesty is the other half. An action with no material cost at all really is unbounded, and
 * must keep reading ∞ rather than acquire an invented number.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null }));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {};
        },
        register: () => () => {},
    },
}));

const game = vi.hoisted(() => ({
    currentActions: [],
    actionDetails: {},
    itemDetails: {},
    inventory: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.currentActions,
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: game.itemDetails }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        on: () => () => {},
        off: () => {},
    },
}));

// A flat 10s per action with no efficiency keeps every expected time a round number.
const ACTION_TIME = 10;
vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: ACTION_TIME, totalEfficiency: 0 }),
}));

const settings = vi.hoisted(() => ({ values: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? true,
        getSettingValue: (_key, fallback) => fallback,
        getPricingModeDisplayLabel: (mode) => `label:${mode}`,
        onSettingChange: () => () => {},
        onSettingsLoaded: () => () => {},
        COLOR_TOOLTIP_INFO: '#abc',
        COLOR_TEXT_PRIMARY: '#fff',
        COLOR_TEXT_SECONDARY: '#888',
        COLOR_INFO: '#09f',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculate: async () => null,
        calculateCoinifyProfit: () => null,
        calculateDecomposeProfit: () => null,
        calculateTransmuteProfit: () => null,
    },
}));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));
vi.mock('../alchemy/alchemy-profit.js', () => ({
    default: {
        getCurrentActionHrid: () => null,
        getStateFingerprint: () => 'fp',
        extractDrops: async () => [],
        extractRequirements: async () => [],
    },
}));
vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: 1 }),
}));

const { default: actionTimeDisplay } = await import('./action-time-display.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');
const { default: alchemyDisplay } = await import('../alchemy/alchemy-profit-display.js');
const { buildUnlimitedProfitText } = await import('./profit-display.js');
const {
    estimateUnlimitedAction,
    formatUnlimitedTimeText,
    formatMaterialNote,
    isBoundedEstimate,
    buildUnqueuedActionObject,
    clearUnlimitedEstimateCache,
} = await import('./unlimited-action-estimate.js');

const LOG = '/items/log';
const PLANK = '/items/plank';
const CRAFT_PLANK = '/actions/crafting/plank';
const CHOP_LOG = '/actions/woodcutting/log';
const DECOMPOSE = '/actions/alchemy/decompose';

/** Inventory rows in the one location the lookup counts */
function stack(itemHrid, count, enhancementLevel = 0) {
    return { itemHrid, count, enhancementLevel, itemLocationHrid: '/item_locations/inventory' };
}

/** One queued action with no max count — the queue's own "Repeat ∞" shape. */
function unlimitedQueued(id, actionHrid) {
    return {
        id,
        ordinal: id,
        actionHrid,
        primaryItemHash: null,
        hasMaxCount: false,
        maxCount: 0,
        currentCount: 0,
    };
}

/** The "+N Queued Actions" popper with one row per queued action. */
function queueTooltipPopper(rowNames) {
    const rows = rowNames
        .map(
            (name, i) => `
                <div class="QueuedActions_action__item">
                    <div class="QueuedActions_actionText__y">
                        <div class="QueuedActions_text__z">#${i + 1}${name}</div>
                    </div>
                </div>`
        )
        .join('');
    const el = document.createElement('div');
    el.className = 'MuiTooltip-popper';
    el.innerHTML = `
        <div class="QueuedActions_queuedActionsTooltip__x">
            <div class="QueuedActions_actions__container">${rows}</div>
        </div>
    `;
    document.body.appendChild(el);
    return el;
}

/** The `[...]` bracket a queue row renders, without the wall-clock completion time. */
function rowLimits(el) {
    return [...el.querySelectorAll('.mwi-queue-action-time')].map(
        (row) => row.textContent.match(/^\[[^\]]*\]/)?.[0] ?? row.textContent
    );
}

/** The alchemy speed section's profit-data stub — the section only reads these fields. */
const alchemyProfitData = () => ({ actionTime: ACTION_TIME, efficiency: 0, efficiencyBreakdown: {} });

/** A Repeat input holding `value`. */
function repeatField(value) {
    const field = document.createElement('input');
    field.value = value;
    return field;
}

const sectionText = (section) => section.textContent;

beforeEach(() => {
    document.body.innerHTML = '';
    settings.values = {};
    clearUnlimitedEstimateCache();
    game.itemDetails = {
        [LOG]: { itemHrid: LOG, name: 'Log', itemLevel: 1 },
        [PLANK]: { itemHrid: PLANK, name: 'Plank', itemLevel: 1 },
    };
    game.actionDetails = {
        [CRAFT_PLANK]: {
            hrid: CRAFT_PLANK,
            name: 'Plank',
            type: '/action_types/crafting',
            coinCost: 0,
            inputItems: [{ itemHrid: LOG, count: 2 }],
            outputItems: [{ itemHrid: PLANK, count: 1 }],
        },
        // Gathering costs nothing to run, so it is the genuinely unbounded case.
        [CHOP_LOG]: {
            hrid: CHOP_LOG,
            name: 'Log',
            type: '/action_types/woodcutting',
            coinCost: 0,
            inputItems: [],
            outputItems: [{ itemHrid: LOG, count: 1 }],
        },
        // Same material shape as CRAFT_PLANK (2 logs each) so the alchemy panel's bound is the
        // same 40 already exercised above.
        [DECOMPOSE]: {
            hrid: DECOMPOSE,
            name: 'Decompose',
            type: '/action_types/alchemy',
            coinCost: 0,
            inputItems: [{ itemHrid: LOG, count: 2 }],
            outputItems: [],
        },
    };
    game.inventory = [stack(LOG, 80)];
    game.currentActions = [];
    actionTimeDisplay.initializeQueueTooltipObserver();
});

afterEach(() => {
    tooltipObserver.disable();
    clearUnlimitedEstimateCache();
    alchemyDisplay.sectionExpanded.clear();
    alchemyDisplay.removeSpeedTimeInputListeners();
    alchemyDisplay.removeProfitSummaryInputListeners();
    alchemyDisplay.displayElement = null;
    alchemyDisplay.cachedInputField = null;
    vi.useRealTimers();
});

/** The alchemy component with a Repeat input, the way `createDisplay` looks it up. */
function buildAlchemyComponent(value) {
    const component = document.createElement('div');
    component.className = 'SkillActionDetail_alchemyComponent__x';
    const inputContainer = document.createElement('div');
    inputContainer.className = 'maxActionCountInput_wrapper';
    const input = document.createElement('input');
    input.value = value;
    inputContainer.appendChild(input);
    component.appendChild(inputContainer);
    document.body.appendChild(component);
    return { component, input };
}

/** A minimal-but-valid decompose profitData, shaped so createDisplay draws without crashing. */
function decomposeProfitData(overrides = {}) {
    return {
        dropRevenues: [],
        requirementCosts: [],
        catalystCost: {},
        consumableCosts: [],
        profitPerHour: 3600,
        profitPerDay: 3600 * 24,
        revenuePerHour: 3600,
        materialCostPerHour: 0,
        catalystCostPerHour: 0,
        totalTeaCostPerHour: 0,
        successRate: 1,
        actionsPerHour: 360,
        actionTime: ACTION_TIME,
        efficiency: 0,
        efficiencyBreakdown: {},
        pricingMode: 'hybrid',
        // A flat 1000 profit per completed action, so the arithmetic under test is "how many
        // actions", not "what is an action worth" — that has its own tests.
        profitPerAction: 1000,
        ...overrides,
    };
}

/** The Profitability section's collapsed summary line. */
function profitSummaryText(container) {
    const section = container.querySelector('#mwi-alchemy-profit');
    return section?.querySelector('.mwi-section-header + div')?.textContent ?? null;
}

describe('the estimate itself', () => {
    test('an unlimited action bounded by materials gets a finite time and count', () => {
        // 80 logs at 2 per plank pays for 40 crafts, 10s each
        const timing = estimateUnlimitedAction({ actionHrid: CRAFT_PLANK });

        expect(timing.isTrulyInfinite).toBe(false);
        expect(timing.count).toBe(40);
        expect(timing.materialLimit).toBe(40);
        expect(timing.limitLabel).toBe('mat');
        expect(timing.totalTime).toBe(400);
        expect(isBoundedEstimate(timing)).toBe(true);
        expect(formatUnlimitedTimeText(timing)).toBe('0h 06m 40s · mat: 40');
    });

    test('the synthetic action object is the unqueued, whole-bag shape', () => {
        const actionObj = buildUnqueuedActionObject({ actionHrid: CRAFT_PLANK });

        // hasMaxCount false is what makes it the Repeat ∞ case, and the sentinel id cannot
        // collide with a real action, so no in-progress elapsed time is subtracted.
        expect(actionObj.hasMaxCount).toBe(false);
        expect(actionObj.actionHrid).toBe(CRAFT_PLANK);
        expect(actionObj.id).not.toBe(1);
    });

    test('an alchemy selection rides along as an item hash the calculator can parse', () => {
        const actionObj = buildUnqueuedActionObject({
            actionHrid: '/actions/alchemy/decompose',
            itemHrid: '/items/star_fruit',
            enhancementLevel: 3,
            catalystHrid: '/items/catalyst_of_transmutation',
        });

        expect(actionObj.primaryItemHash).toBe('/items/star_fruit::3');
        expect(actionObj.secondaryItemHash).toBe('/items/catalyst_of_transmutation::0');
    });

    test('an unknown action yields nothing rather than a guess', () => {
        expect(estimateUnlimitedAction({ actionHrid: '/actions/nope' })).toBe(null);
        expect(estimateUnlimitedAction(null)).toBe(null);
    });
});

describe('the panel figure is the queue figure', () => {
    test('one input, one answer — the panel text is the queue row bracket', () => {
        game.currentActions = [unlimitedQueued(1, CRAFT_PLANK)];

        const el = queueTooltipPopper(['Plank']);
        observerState.handler(el);
        const queueBracket = rowLimits(el)[0];

        const panelText = formatUnlimitedTimeText(estimateUnlimitedAction({ actionHrid: CRAFT_PLANK }));

        // Not two literals that happen to match today: the queue row's own bracket, built by
        // the queue walk, compared against the panel's text built by the shared calculator.
        expect(`[${panelText}]`).toBe(queueBracket);
    });

    test('the material note carries the queue row own vocabulary', () => {
        expect(formatMaterialNote(estimateUnlimitedAction({ actionHrid: CRAFT_PLANK }))).toBe('mat: 40');
    });

    test('a limit resting on credited expected yield carries the ~ marker', () => {
        // The marker is set by the calculator, so it is asserted on a result rather than
        // reconstructed: any bounded estimate flagged as estimated prints `~` before its count.
        const estimated = {
            isTrulyInfinite: false,
            materialLimit: 40,
            limitLabel: 'mat',
            materialLimitIsEstimated: true,
            totalTime: 400,
            count: 40,
        };

        expect(formatMaterialNote(estimated)).toBe('mat: ~40');
        expect(formatUnlimitedTimeText(estimated)).toBe('0h 06m 40s · mat: ~40');
    });
});

describe('a genuine infinity stays honest', () => {
    test('an action with no material cost is not given a number', () => {
        const timing = estimateUnlimitedAction({ actionHrid: CHOP_LOG });

        expect(timing.isTrulyInfinite).toBe(true);
        expect(timing.materialLimit).toBe(null);
        expect(isBoundedEstimate(timing)).toBe(false);
        expect(formatUnlimitedTimeText(timing)).toBe(null);
        expect(formatMaterialNote(timing)).toBe('');
    });

    test('a crafting action the player holds no materials for runs nothing, not forever', () => {
        game.inventory = [];

        const timing = estimateUnlimitedAction({ actionHrid: CRAFT_PLANK });

        // The limit is known — it is zero — so there is no time to promise and no figure to
        // print. The panel falls back to ∞ rather than claiming a 0s unlimited run.
        expect(timing.materialLimit).toBe(0);
        expect(isBoundedEstimate(timing)).toBe(false);
        expect(formatUnlimitedTimeText(timing)).toBe(null);
    });
});

describe('the alchemy panel draws the bounded time', () => {
    const spec = { actionHrid: CRAFT_PLANK, itemHrid: null, enhancementLevel: 0, catalystHrid: null };

    test('Repeat ∞ shows the materials-bounded time instead of ∞', () => {
        const section = alchemyDisplay.createActionSpeedTimeSection(alchemyProfitData(), repeatField('∞'), spec);

        expect(sectionText(section)).toContain('Total time: 0h 06m 40s · mat: 40');
        expect(sectionText(section)).not.toContain('Total time: ∞');
    });

    test('the collapsed summary shows the same bounded time', () => {
        const section = alchemyDisplay.createActionSpeedTimeSection(alchemyProfitData(), repeatField('∞'), spec);

        expect(sectionText(section)).toContain('/hr | Total time: 0h 06m 40s · mat: 40');
    });

    test('a truly unbounded action still reads ∞', () => {
        const section = alchemyDisplay.createActionSpeedTimeSection(alchemyProfitData(), repeatField('∞'), {
            ...spec,
            actionHrid: CHOP_LOG,
        });

        expect(sectionText(section)).toContain('Total time: ∞');
    });

    test('with nothing describing the action on screen, ∞ stays ∞', () => {
        const section = alchemyDisplay.createActionSpeedTimeSection(alchemyProfitData(), repeatField('∞'));

        expect(sectionText(section)).toContain('Total time: ∞');
    });

    test('a finite Repeat is unchanged', () => {
        const section = alchemyDisplay.createActionSpeedTimeSection(alchemyProfitData(), repeatField('100'), spec);

        // 100 × 10s, with no material note: a counted request is what the player asked for
        expect(sectionText(section)).toContain('Total time: 0h 16m 40s');
        expect(sectionText(section)).not.toContain('mat:');
    });

    test('an empty Repeat is unchanged', () => {
        const section = alchemyDisplay.createActionSpeedTimeSection(alchemyProfitData(), repeatField(''), spec);

        expect(sectionText(section)).toContain('Total time: 0s');
    });

    test('typing switches between the bounded figure and the counted one', () => {
        const field = repeatField('∞');
        const section = alchemyDisplay.createActionSpeedTimeSection(alchemyProfitData(), field, spec);

        expect(sectionText(section)).toContain('Total time: 0h 06m 40s · mat: 40');

        field.value = '100';
        field.dispatchEvent(new Event('input'));
        expect(sectionText(section)).toContain('Total time: 0h 16m 40s');

        field.value = '∞';
        field.dispatchEvent(new Event('input'));
        expect(sectionText(section)).toContain('Total time: 0h 06m 40s · mat: 40');
    });
});

describe('the alchemy panel draws the bounded profit', () => {
    // Decompose's material limit is costed against the item being processed itself (the
    // inventory's enhanced-key count for PLANK), not actionDetails.inputItems — see
    // calculateMaterialLimit's alchemy branch in action-time-display.js. Decompose also
    // charges an unrecorded coin fee per action (utils/alchemy-fees.js), so a bag with
    // plenty of coin keeps the plank count, not the gold, as the binding limit.
    beforeEach(() => {
        game.inventory = [...game.inventory, stack(PLANK, 40), stack('/items/coin', 1_000_000)];
    });

    test('Repeat ∞ prices the run the materials actually pay for', () => {
        buildAlchemyComponent('∞');
        const container = document.createElement('div');

        alchemyDisplay.createDisplay(container, decomposeProfitData(), 'decompose', PLANK, 0);

        // 40 planks in the bag × 1000 flat profit per action = 40,000
        expect(profitSummaryText(container)).toContain('Total profit: 40.00K · mat: 40');
    });

    test('both lines on the panel quote the same bound', () => {
        buildAlchemyComponent('∞');
        const container = document.createElement('div');

        alchemyDisplay.createDisplay(container, decomposeProfitData(), 'decompose', PLANK, 0);

        const profitMat = profitSummaryText(container).match(/mat: (\d+)/)[1];
        const speedTimeSection = container.querySelector('#mwi-alchemy-speed-time');
        const timeSummary = speedTimeSection.querySelector('.mwi-section-header + div').textContent;
        const timeMat = timeSummary.match(/mat: (\d+)/)[1];

        expect(profitMat).toBe(timeMat);
    });

    test('with nothing describing the action on screen, ∞ stays ∞', () => {
        buildAlchemyComponent('∞');
        const container = document.createElement('div');

        // No actionType: createDisplay cannot build an estimateSpec, so there is nothing to
        // cost the run against — the same "no invented figure" rule as a genuinely unbounded
        // action, covered from the estimate's own side in "a genuine infinity stays honest" above.
        alchemyDisplay.createDisplay(container, decomposeProfitData(), null, PLANK, 0);

        expect(profitSummaryText(container)).toContain('Total profit: ∞');
    });

    test('a finite Repeat is unchanged', () => {
        buildAlchemyComponent('10');
        const container = document.createElement('div');

        alchemyDisplay.createDisplay(container, decomposeProfitData(), 'decompose', PLANK, 0);

        // 10 completed actions × 1000 flat profit per action
        expect(profitSummaryText(container)).toContain('Total profit: 10.00K');
        expect(profitSummaryText(container)).not.toContain('mat:');
    });

    test('typing switches between the bounded figure and the counted one', () => {
        const { input } = buildAlchemyComponent('∞');
        const container = document.createElement('div');

        alchemyDisplay.createDisplay(container, decomposeProfitData(), 'decompose', PLANK, 0);
        expect(profitSummaryText(container)).toContain('Total profit: 40.00K · mat: 40');

        input.value = '10';
        input.dispatchEvent(new Event('input'));
        expect(profitSummaryText(container)).toContain('Total profit: 10.00K');
        expect(profitSummaryText(container)).not.toContain('mat:');

        input.value = '∞';
        input.dispatchEvent(new Event('input'));
        expect(profitSummaryText(container)).toContain('Total profit: 40.00K · mat: 40');
    });
});

describe('the action panel draws the bounded profit', () => {
    // The panel's own totals helper, stubbed to a flat 1000 per action so the arithmetic under
    // test is "how many actions", not "what is an action worth" — that has its own tests.
    const totalsForCount = (actionsCount) => ({ totalProfit: actionsCount * 1000 });

    test('Repeat ∞ prices the run the materials actually pay for', () => {
        // 40 affordable crafts × 1000 = 40,000, with the bound named the queue row's way
        expect(buildUnlimitedProfitText(CRAFT_PLANK, totalsForCount)).toBe('40.00K · mat: 40');
    });

    test('the count it prices is the count the queue row displays', () => {
        game.currentActions = [unlimitedQueued(1, CRAFT_PLANK)];
        const el = queueTooltipPopper(['Plank']);
        observerState.handler(el);

        const queueCount = Number(rowLimits(el)[0].match(/mat: (\d+)/)[1]);

        expect(buildUnlimitedProfitText(CRAFT_PLANK, totalsForCount)).toContain(`mat: ${queueCount}`);
        expect(totalsForCount(queueCount).totalProfit).toBe(40000);
    });

    test('a truly unbounded action still reads ∞', () => {
        expect(buildUnlimitedProfitText(CHOP_LOG, totalsForCount)).toBe('∞');
    });

    test('a losing unlimited run shows its minus sign', () => {
        expect(buildUnlimitedProfitText(CRAFT_PLANK, (n) => ({ totalProfit: n * -1000 }))).toBe('-40.00K · mat: 40');
    });
});

describe('settings', () => {
    test('the figure lives inside the sections the action panel already governs', () => {
        // No new toggle: the alchemy Total time line is drawn by createDisplay, which returns
        // before building anything when the existing profitability-detail setting is off.
        settings.values = { actionPanel_showProfitDetail: false };
        const container = document.createElement('div');

        alchemyDisplay.createDisplay(container, alchemyProfitData(), 'decompose', PLANK, 0);

        expect(container.textContent).toBe('');
        expect(alchemyDisplay.displayElement).toBe(null);
    });
});

describe('redraw cost', () => {
    test('repeated reads inside the throttle window walk the inventory once', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T10:00:00'));
        const walk = vi.spyOn(actionTimeDisplay, 'buildInventoryLookup');

        estimateUnlimitedAction({ actionHrid: CRAFT_PLANK });
        estimateUnlimitedAction({ actionHrid: CRAFT_PLANK });
        estimateUnlimitedAction({ actionHrid: CRAFT_PLANK });

        expect(walk).toHaveBeenCalledTimes(1);

        // A different action is a different question and is answered fresh
        estimateUnlimitedAction({ actionHrid: CHOP_LOG });
        expect(walk).toHaveBeenCalledTimes(2);

        walk.mockRestore();
    });

    test('the estimate does not outlive the throttle window', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T10:00:00'));

        expect(estimateUnlimitedAction({ actionHrid: CRAFT_PLANK }).count).toBe(40);

        game.inventory = [stack(LOG, 20)];
        vi.setSystemTime(new Date('2026-01-01T10:00:05'));

        expect(estimateUnlimitedAction({ actionHrid: CRAFT_PLANK }).count).toBe(10);
    });

    test('the action panel time line and profit line share one walk', () => {
        // quick-input-buttons.js (time) and profit-display.js (profit) are two independent
        // consumers on the same panel; both must land on the shared cache rather than each
        // walking the bag itself.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T10:00:00'));
        const walk = vi.spyOn(actionTimeDisplay, 'buildInventoryLookup');
        const totalsForCount = (actionsCount) => ({ totalProfit: actionsCount * 1000 });

        const timing = estimateUnlimitedAction({ actionHrid: CRAFT_PLANK }); // as the time line would
        const profitText = buildUnlimitedProfitText(CRAFT_PLANK, totalsForCount); // as the profit line would

        expect(walk).toHaveBeenCalledTimes(1);
        expect(formatUnlimitedTimeText(timing)).toBe('0h 06m 40s · mat: 40');
        expect(profitText).toBe('40.00K · mat: 40');

        walk.mockRestore();
    });

    test('the alchemy panel builds both its lines from one walk', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T10:00:00'));
        const walk = vi.spyOn(actionTimeDisplay, 'buildInventoryLookup');
        game.inventory = [...game.inventory, stack(PLANK, 40), stack('/items/coin', 1_000_000)];
        buildAlchemyComponent('∞');
        const container = document.createElement('div');

        alchemyDisplay.createDisplay(container, decomposeProfitData(), 'decompose', PLANK, 0);

        expect(walk).toHaveBeenCalledTimes(1);
        expect(profitSummaryText(container)).toContain('mat: 40');

        walk.mockRestore();
    });
});
