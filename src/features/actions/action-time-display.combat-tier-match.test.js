/**
 * Matching a queue row to its action when the row carries a tier annotation.
 *
 * The game renders a tiered combat zone's queue row as "Gobo Planet (T3)" while the
 * action itself is named "Gobo Planet" — `difficultyTier` is a separate field on the
 * queued action, never part of `actionDetailMap[...].name`. `matchActionFromDiv` compared
 * the row text to the name verbatim, so every tiered row failed to match, fell through to
 * a nonsense item hrid built from the row text (`/items/gobo_planet_(t3)`), found nothing
 * in `outputItems` or `dropTable`, and rendered "[Unknown action]". An untiered zone
 * ("Werewolf") matched fine, which is why only some rows were broken.
 *
 * The action-bar path had already solved this in `parseActionNameFromDom`, which strips
 * trailing parenthesised annotations ("(T3)", "(Party)"). The queue path carried its own
 * copy of the parsing that did not. These tests hold both paths to the same behaviour.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

const game = vi.hoisted(() => ({
    actionDetails: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => [],
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getItemDetails: () => null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        on: () => () => {},
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: 10, totalEfficiency: 0 }),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'actionQueue',
        getSettingValue: (_key, fallback) => fallback,
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));

const { default: actionTimeDisplay } = await import('./action-time-display.js');

const GOBO = '/actions/combat/gobo_planet';
const WEREWOLF = '/actions/combat/werewolf';
const COINIFY = '/actions/alchemy/coinify';
const ENHANCE = '/actions/enhancing/cheese_sword';

/** One queue row, as the game draws it: "#2" and the label share one text node. */
function row(position, label) {
    const el = document.createElement('div');
    el.className = 'QueuedActions_action__item';
    el.innerHTML = `
        <div class="QueuedActions_actionText__y">
            <div class="QueuedActions_text__z">#${position}${label}</div>
        </div>
    `;
    document.body.appendChild(el);
    return el;
}

function queued(id, actionHrid, difficultyTier = 0) {
    return {
        id,
        ordinal: id,
        actionHrid,
        difficultyTier,
        primaryItemHash: null,
        hasMaxCount: true,
        maxCount: 580,
        currentCount: 0,
    };
}

describe('matchActionFromDiv with a tier annotation', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        game.actionDetails = {
            // The live client's own shape: no tier anywhere in the name.
            [GOBO]: { hrid: GOBO, name: 'Gobo Planet', type: '/action_types/combat' },
            [WEREWOLF]: { hrid: WEREWOLF, name: 'Werewolf', type: '/action_types/combat' },
            [COINIFY]: {
                hrid: COINIFY,
                name: 'Coinify',
                type: '/action_types/alchemy',
                inputItems: [],
                outputItems: [],
            },
            [ENHANCE]: { hrid: ENHANCE, type: '/action_types/enhancing' },
        };
    });

    test('a tiered combat row matches its action', () => {
        const actions = [queued(1, GOBO, 3)];
        const matched = actionTimeDisplay.matchActionFromDiv(row(2, 'Gobo Planet (T3)'), actions);
        expect(matched).toBe(actions[0]);
    });

    test('an untiered combat row still matches its action', () => {
        const actions = [queued(1, WEREWOLF, 0)];
        const matched = actionTimeDisplay.matchActionFromDiv(row(3, 'Werewolf'), actions);
        expect(matched).toBe(actions[0]);
    });

    test('a tier annotation does not let one zone match another', () => {
        const actions = [queued(1, WEREWOLF, 0)];
        expect(actionTimeDisplay.matchActionFromDiv(row(2, 'Gobo Planet (T3)'), actions)).toBeFalsy();
    });

    test('a colon-bearing production row is unaffected', () => {
        const actions = [queued(1, COINIFY)];
        const matched = actionTimeDisplay.matchActionFromDiv(row(1, 'Coinify: Foraging Essence'), actions);
        expect(matched).toBe(actions[0]);
    });

    test('duplicate labels follow queue order even when the cached actions arrive out of order', () => {
        const later = { ...queued(7, GOBO, 3), ordinal: 221, characterLoadoutID: 70 };
        const earlier = { ...queued(8, GOBO, 3), ordinal: 219, characterLoadoutID: 80 };
        const actions = [later, earlier];
        const used = new Set();

        const firstMatch = actionTimeDisplay.matchActionFromDiv(row(1, 'Gobo Planet (T3)'), actions, used);
        used.add(firstMatch.id);
        const secondMatch = actionTimeDisplay.matchActionFromDiv(row(2, 'Gobo Planet (T3)'), actions, used);

        expect(firstMatch).toBe(earlier);
        expect(secondMatch).toBe(later);
    });

    test('duplicate enhancing rows also follow queue order', () => {
        const itemHash = 'char1::/item_locations/inventory::/items/cheese_sword::1';
        const later = { ...queued(7, ENHANCE), ordinal: 221, primaryItemHash: itemHash };
        const earlier = { ...queued(8, ENHANCE), ordinal: 219, primaryItemHash: itemHash };
        const enhancingRow = row(1, 'Cheese Sword +1');
        enhancingRow
            .querySelector('[class*="QueuedActions_text__"]')
            .insertAdjacentHTML('afterbegin', '<svg><use href="#enhancing_icon"></use></svg>');

        expect(actionTimeDisplay.matchActionFromDiv(enhancingRow, [later, earlier])).toBe(earlier);
    });
});
