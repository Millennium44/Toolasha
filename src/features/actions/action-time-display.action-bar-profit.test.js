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
    default: { onClass: () => () => {} },
}));

vi.mock('../../core/tooltip-observer.js', () => ({
    default: { register: () => () => {}, onTooltip: () => () => {} },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculateProfit: async () => null } }));

/**
 * The market-volume cap, as one settable throttle. The cap arithmetic is
 * utils/liquidity-cap.js's own tested business; what this file proves is that
 * the action bar displays the *capped* pace and never a capped figure without
 * its marker.
 */
const liquidity = vi.hoisted(() => ({ throttle: null }));

vi.mock('../../utils/liquidity-cap.js', () => ({
    capProfitData: async (profitData) => {
        if (!profitData || !liquidity.throttle || liquidity.throttle >= 1) return profitData;
        return {
            ...profitData,
            profitPerHour: profitData.profitPerHour * liquidity.throttle,
            uncappedProfitPerHour: profitData.profitPerHour,
            liquidityLimit: {
                kind: 'volume',
                note: 'limited by market volume (~1/week)',
                detail: 'Foraging Essence trades ~1/week, and you are not the only seller.',
                itemHrid: '/items/foraging_essence',
                throttle: liquidity.throttle,
            },
        };
    },
    liquidityMarkerHtml: (limit) => (limit ? `<span title="${limit.note} — ${limit.detail}">vol-capped</span>` : ''),
}));

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

describe('action bar profit line — leaving a profitable action', () => {
    test('clearBarProfit blanks the line and disowns a calculation still in flight', () => {
        actionTimeDisplay.profitElement = document.createElement('div');
        actionTimeDisplay.profitElement.innerHTML = 'Profit: +1,751/hr';
        actionTimeDisplay.activeBarProfitId = 42;

        actionTimeDisplay.clearBarProfit();

        expect(actionTimeDisplay.profitElement.innerHTML).toBe('');
        // A calculation started for the previous action compares its id against
        // this and must find it gone rather than write over the blank
        expect(actionTimeDisplay.activeBarProfitId).toBeNull();
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

describe('action bar profit line — the market-volume cap', () => {
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
        liquidity.throttle = null;

        game.actionDetails = {
            '/actions/alchemy/coinify': { type: '/action_types/alchemy', outputItems: [] },
        };
        alchemyCalc.coinify = () => ({ profitPerHour: 1_900_000, actionsPerHour: 1000 });
    });

    test('the displayed rate is the capped one, and it carries the marker', async () => {
        liquidity.throttle = 0.1;

        await actionTimeDisplay.updateActionBarProfit(action, Infinity);

        const html = actionTimeDisplay.profitElement.innerHTML;
        // 1.9M/hr the calculator claims, 190K/hr the market will pay
        expect(html).toContain('+190.0K/hr');
        expect(html).not.toContain('+1.90M/hr');
        expect(html).toContain('vol-capped');
        expect(html).toContain('limited by market volume (~1/week)');
        expect(html).toContain('Foraging Essence');
    });

    test('"remaining" is priced at the pace the market pays, not the fantasy one', async () => {
        liquidity.throttle = 0.1;

        // 190K/hr over 1000 actions/hr → 190/action × 1000 remaining = 190K
        await actionTimeDisplay.updateActionBarProfit(action, 1000);

        const html = actionTimeDisplay.profitElement.innerHTML;
        expect(html).toContain('remaining');
        expect(html).toContain('+190.0K');
    });

    test('an uncapped rate shows no marker — the cap is never implied', async () => {
        await actionTimeDisplay.updateActionBarProfit(action, Infinity);

        const html = actionTimeDisplay.profitElement.innerHTML;
        expect(html).toContain('+1.90M/hr');
        expect(html).not.toContain('vol-capped');
    });
});
