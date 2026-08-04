/**
 * Regression tests for the action-bar "Profit: X/hr · remaining Y" line.
 *
 * Bug this covers: alchemy Coinify actions showed the profit line TWICE, same
 * rate but different "remaining" values (e.g. "remaining +3.66M" and "remaining
 * +6.00M"). Root cause was in createDisplayPanel(): when the game's re-render
 * caused `this.displayElement` to become disconnected while `this.profitElement`
 * stayed connected (or vice versa), the function only orphan-cleaned the
 * time-display node by id (`document.getElementById('mwi-action-time-display')`)
 * and then unconditionally overwrote `this.profitElement` with a freshly created
 * node — silently orphaning the still-connected old one, which kept the "remaining"
 * value it was last rendered with (from before the queue/material-limit changed)
 * while the new node showed the current value. Two "#mwi-action-profit-display"
 * elements ended up in the DOM at once.
 *
 * The fix removes every element tagged with a `data-mwi-action-bar-widget`
 * attribute (not just the first match an id lookup would find) before injecting
 * fresh nodes, making the injection idempotent regardless of which tracked
 * reference went stale.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    actionDetails: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: () => null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => [],
        getCurrentActions: () => [],
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        on: () => () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, onSelector: () => () => {} },
}));

vi.mock('../../core/tooltip-observer.js', () => ({
    default: { register: () => () => {}, onTooltip: () => () => {} },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculateProfit: async () => null } }));

const alchemyCalc = vi.hoisted(() => ({
    coinify: null,
}));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculateCoinifyProfit: (...args) => alchemyCalc.coinify?.(...args) ?? null,
        calculateTransmuteProfit: () => null,
        calculateDecomposeProfit: () => null,
    },
}));

const actionTimeDisplay = (await import('./action-time-display.js')).default;

function setActionNameDom() {
    document.body.innerHTML = '<div class="Header_actionName_abc123">Coinify: Foraging Essence (100)</div>';
}

describe('action bar profit line — idempotent injection', () => {
    beforeEach(() => {
        setActionNameDom();
        actionTimeDisplay.displayElement = null;
        actionTimeDisplay.profitElement = null;
    });

    test('calling createDisplayPanel twice in a row is a no-op the second time', () => {
        actionTimeDisplay.createDisplayPanel();
        actionTimeDisplay.createDisplayPanel();

        expect(document.querySelectorAll('#mwi-action-time-display').length).toBe(1);
        expect(document.querySelectorAll('#mwi-action-profit-display').length).toBe(1);
    });

    test('a profit node left connected after the time-display node is lost does not survive as a duplicate', () => {
        actionTimeDisplay.createDisplayPanel();

        // Reproduce the exact desync that caused the bug: the time-display node is
        // removed from the DOM and its reference dropped, but the profit node is
        // left exactly as-is — still tracked AND still connected.
        actionTimeDisplay.displayElement.remove();
        actionTimeDisplay.displayElement = null;

        actionTimeDisplay.createDisplayPanel();

        const profitNodes = document.querySelectorAll('#mwi-action-profit-display');
        expect(profitNodes.length).toBe(1);
        expect(profitNodes[0]).toBe(actionTimeDisplay.profitElement);
        expect(document.querySelectorAll('#mwi-action-time-display').length).toBe(1);
    });

    test('a fully orphaned profit node (reference lost, node never removed) is cleaned up on the next render', () => {
        actionTimeDisplay.createDisplayPanel();
        const staleProfitNode = actionTimeDisplay.profitElement;
        staleProfitNode.innerHTML =
            '<span style="color:#888;">Profit:</span> <span>+1.90M/hr</span> · remaining <span>+6.00M</span>';

        // Both references dropped without touching the DOM — the node is now an orphan.
        actionTimeDisplay.displayElement = null;
        actionTimeDisplay.profitElement = null;

        actionTimeDisplay.createDisplayPanel();

        const profitNodes = document.querySelectorAll('[data-mwi-action-bar-widget="profit"]');
        expect(profitNodes.length).toBe(1);
        // The survivor is the fresh node, not the stale one carrying the old "remaining" text.
        expect(profitNodes[0]).toBe(actionTimeDisplay.profitElement);
        expect(profitNodes[0].innerHTML).toBe('');
        expect(staleProfitNode.isConnected).toBe(false);
    });
});

describe('action bar profit line — "remaining" basis', () => {
    const action = {
        actionHrid: '/actions/alchemy/coinify',
        primaryItemHash: '/item_locations/inventory::/items/foraging_essence::0',
    };

    beforeEach(() => {
        setActionNameDom();
        actionTimeDisplay.displayElement = null;
        actionTimeDisplay.profitElement = null;
        actionTimeDisplay.createDisplayPanel();
        actionTimeDisplay.activeBarProfitId = null;

        game.actionDetails = {
            '/actions/alchemy/coinify': { type: '/action_types/alchemy', outputItems: [] },
        };
    });

    test('"remaining" scales with the actions argument the caller passes (material-limit basis)', async () => {
        // Same rate both times — mirrors the reported bug (1.90M/hr with two different
        // "remaining" figures). What must vary is only how many actions are left, which
        // updateDisplay derives from the material limit (gold/materials run out) in
        // preference to the raw inventory count parsed from the header text — the
        // material limit is the count of actions actually still completable, which is
        // what "remaining" (profit still to be earned) has to be based on.
        alchemyCalc.coinify = () => ({ profitPerHour: 1_900_000, actionsPerHour: 1000 });

        await actionTimeDisplay.updateActionBarProfit(action, 1926); // material-limited count
        let html = actionTimeDisplay.profitElement.innerHTML;
        expect(html).toContain('Profit:');
        expect(html).toContain('+1.90M/hr');
        expect(html).toContain('remaining');
        expect(html).toContain('+3.66M');
        expect(html).not.toContain('+6.00M');

        // The queue's material limit was recalculated (e.g. more actions became
        // affordable) — the line must be replaced wholesale, not appended to.
        await actionTimeDisplay.updateActionBarProfit(action, 3158);
        html = actionTimeDisplay.profitElement.innerHTML;
        expect(html).toContain('+6.00M');
        expect(html).not.toContain('+3.66M');
        expect((html.match(/Profit:/g) || []).length).toBe(1);
        expect((html.match(/remaining/g) || []).length).toBe(1);
    });

    test('an unlimited (Infinity) remaining count omits the "remaining" segment entirely', async () => {
        alchemyCalc.coinify = () => ({ profitPerHour: 1_900_000, actionsPerHour: 1000 });

        await actionTimeDisplay.updateActionBarProfit(action, Infinity);

        const html = actionTimeDisplay.profitElement.innerHTML;
        expect(html).toContain('+1.90M/hr');
        expect(html).not.toContain('remaining');
    });
});
