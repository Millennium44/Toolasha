/**
 * The queue total's `~` mark used to come from one source only: `usesSimRate`, set when a
 * combat row rests on a simulated rate. A row whose figure instead rests on an estimated
 * material limit (e.g. an enhancing row capped by an expected protection draw) marked
 * itself with `~`, but that mark never reached the total — a queue with such a row and no
 * simulated combat row showed a bare, unmarked "Total time:", presenting an estimate as an
 * exact figure.
 *
 * The fix folds `materialLimitIsEstimated` into the same `hasEstimate` flag the sim-rate
 * path already sets, so the total is marked whenever any contributing row was an estimate,
 * of either kind.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

const game = vi.hoisted(() => ({
    currentActions: [],
    actionDetails: {},
    itemDetails: {},
    inventory: [],
    predictions: null,
    settings: {},
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
        getCurrentCharacterId: () => 'char1',
        on: () => () => {},
    },
}));

const ACTION_TIME = 10;
vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: ACTION_TIME, totalEfficiency: 0 }),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => game.settings[key] ?? false,
        getSettingValue: (key, fallback) => game.settings[key] ?? fallback,
        COLOR_TOOLTIP_INFO: '#abc',
        COLOR_TEXT_SECONDARY: '#def',
        COLOR_TEXT_PRIMARY: '#111',
        COLOR_BORDER: '#222',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => false, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => game.predictions }));

const { default: actionTimeDisplay } = await import('./action-time-display.js');

const SWORD = '/items/cheese_sword';
const ESSENCE = '/items/enhancing_essence';
const PROTECTION = '/items/mirror_of_protection';
const ENHANCE = '/actions/enhancing/enhance';
const COINIFY = '/actions/alchemy/coinify';
const COIN = '/items/coin';

const stack = (itemHrid, count, enhancementLevel = 0) => ({
    itemHrid,
    count,
    enhancementLevel,
    itemLocationHrid: '/item_locations/inventory',
});

const hashFor = (itemHrid, level = 0) => `char1::/item_locations/inventory::${itemHrid}::${level}`;

function enhancingRow(id, { maxCount, protectionItemHrid = null, protectFrom = 5 } = {}) {
    return {
        id,
        ordinal: id,
        actionHrid: ENHANCE,
        primaryItemHash: hashFor(SWORD, 1),
        hasMaxCount: maxCount !== undefined,
        maxCount: maxCount ?? 0,
        currentCount: 0,
        enhancingMaxLevel: 16,
        enhancingProtectionMinLevel: protectionItemHrid ? protectFrom : 0,
        enhancingProtectionItemHrid: protectionItemHrid,
    };
}

function coinifyAction(id, remaining = 3) {
    return {
        id,
        ordinal: id,
        actionHrid: COINIFY,
        difficultyTier: 0,
        characterLoadoutID: 0,
        primaryItemHash: '',
        hasMaxCount: true,
        maxCount: remaining,
        currentCount: 0,
    };
}

/**
 * The edit menu as the game draws it, one row per label. An enhancing row carries the
 * `#enhancing` SVG icon `matchActionFromDiv` keys off of, and its label is the item name
 * alone (no ": " action prefix), just as the game renders it.
 */
function queueMenu(labels, { enhancingIndexes = [] } = {}) {
    const parent = document.createElement('div');
    const menu = document.createElement('div');
    menu.className = 'QueuedActions_queuedActionsEditMenu__x';
    menu.innerHTML = labels
        .map((label, index) => {
            const icon = enhancingIndexes.includes(index) ? '<svg><use href="#enhancing"></use></svg>' : '';
            return `
        <div class="QueuedActions_action__item">
            <div class="QueuedActions_actionText__y">
                <div class="QueuedActions_text__z">${icon}#${index + 1}${label}</div>
            </div>
        </div>`;
        })
        .join('');
    parent.appendChild(menu);
    document.body.appendChild(parent);
    return menu;
}

function total() {
    return document.querySelector('#mwi-queue-total-time');
}

beforeEach(() => {
    document.body.innerHTML = '';
    game.settings = { actionQueue: true, actionPanel_enhanceMatLimitProtections: true };
    game.actionDetails = {
        [ENHANCE]: { type: '/action_types/enhancing', hrid: ENHANCE },
        [COINIFY]: {
            hrid: COINIFY,
            name: 'Coinify',
            type: '/action_types/alchemy',
            inputItems: [],
            outputItems: [],
        },
    };
    game.itemDetails = {
        [SWORD]: { hrid: SWORD, enhancementCosts: [{ itemHrid: ESSENCE, count: 1 }] },
        [ESSENCE]: { hrid: ESSENCE },
        [PROTECTION]: { hrid: PROTECTION },
        [COIN]: { hrid: COIN },
    };
    // One protection expected per ten attempts, so 3 protections buy 30 attempts.
    game.predictions = {
        expectedAttempts: 1000,
        expectedProtections: 100,
        perActionTime: ACTION_TIME,
        successMultiplier: 1,
    };
});

describe('the queue total marks a material-limit estimate, not only a sim rate', () => {
    test('an estimated-material-limit row with no sim-rate row still marks the total', () => {
        game.inventory = [stack(ESSENCE, 500), stack(PROTECTION, 3)];
        game.currentActions = [enhancingRow(1, { maxCount: 500, protectionItemHrid: PROTECTION })];
        const menu = queueMenu(['Cheese Sword'], { enhancingIndexes: [0] });

        actionTimeDisplay.injectQueueTimes(menu);

        const row = menu.querySelector('.mwi-queue-action-time');
        expect(row.textContent).toContain('~');

        const totalDiv = total();
        expect(totalDiv).not.toBeNull();
        expect(totalDiv.textContent).toContain('~');
        // The hover text says why, in the material-limit voice rather than the sim-rate one
        expect(totalDiv.title).toContain('Estimated, not measured');
        expect(totalDiv.title).toContain('expected draw');
    });

    test('an exact queue — no estimate of either kind — leaves the total unmarked and untitled', () => {
        game.inventory = [stack(ESSENCE, 40)];
        game.currentActions = [enhancingRow(1, { maxCount: 40 }), coinifyAction(2, 3)];
        const menu = queueMenu(['Cheese Sword', 'Coinify'], { enhancingIndexes: [0] });

        actionTimeDisplay.injectQueueTimes(menu);

        const totalDiv = total();
        expect(totalDiv).not.toBeNull();
        expect(totalDiv.textContent).not.toContain('~');
        expect(totalDiv.textContent).toMatch(/^Total time: \d/);
        expect(totalDiv.title).toBe('');
    });
});
