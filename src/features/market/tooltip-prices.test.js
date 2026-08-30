/** @vitest-environment happy-dom */
/**
 * Tooltip prices — the routing of a popper by the shared tooltip observer's
 * classification (item / collection / ability / other) and the per-item
 * dedupe on top of it. The price, profit and enhancement maths live in their
 * own modules and are mocked away here.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null }));
const settings = vi.hoisted(() => ({ hideInEnhanceSelector: false }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (id) => (id === 'itemTooltip_hideInEnhanceSelector' ? settings.hideInEnhanceSelector : true),
        getSettingValue: (_id, fallback) => fallback,
        COLOR_TOOLTIP_INFO: '#abc',
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TOOLTIP_PROFIT: '#0f0',
        COLOR_TOOLTIP_LOSS: '#f00',
        COLOR_BORDER: '#444',
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {};
        },
    },
}));
vi.mock('../../core/data-manager.js', () => {
    const itemDetailMap = {
        '/items/cheese': { name: 'Cheese' },
        '/items/griffin_bulwark': { name: 'Griffin Bulwark' },
    };
    return {
        default: {
            getInitClientData: () => ({
                itemDetailMap,
                abilityDetailMap: { '/abilities/berserk': { name: 'Berserk' } },
            }),
            getItemDetails: (hrid) => itemDetailMap[hrid] || null,
        },
    };
});
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => {}, getPrice: () => null },
}));
vi.mock('./profit-calculator.js', () => ({ default: { calculateProfit: async () => null } }));
vi.mock('./alchemy-profit-calculator.js', () => ({ default: { calculateAllProfits: async () => ({}) } }));
vi.mock('./expected-value-calculator.js', () => ({ default: { calculateExpectedValue: () => null } }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: () => null,
    buildEnhancementTooltipHTML: () => '',
    buildEnhancementMilestonesHTML: () => '',
    getProductionCost: () => 0,
    installEnhancementSourceToggle: () => {},
    uninstallEnhancementSourceToggle: () => {},
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ enhancementParamsFor: () => null }));
vi.mock('../actions/gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => ({ ask: 10, bid: 9 }) }));
vi.mock('../../utils/ability-cost-calculator.js', () => ({
    explainAbilityCost: () => ({ total: 1234, books: 3 }),
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: () => 0,
    calculatePriceAfterTax: (price) => price,
}));
vi.mock('../../utils/material-calculator.js', () => ({ calculateArtisanBonus: () => 0 }));
vi.mock('../../utils/game-lookups.js', () => ({ getActionHridFromName: () => null }));
vi.mock('../../utils/production-index.js', () => ({ findProducingAction: () => null }));
vi.mock('../../utils/dom.js', () => ({
    default: {
        addStyles: vi.fn(),
        fixTooltipOverflow: vi.fn(),
        createStyledDiv: (_style, text, className) => {
            const div = document.createElement('div');
            div.className = className;
            div.textContent = text;
            return div;
        },
    },
}));

const { default: tooltipPrices } = await import('./tooltip-prices.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');

/**
 * @param {string} innerHTML
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function popper(innerHTML, className = 'MuiTooltip-popper') {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = `<div class="MuiTooltip-tooltip">${innerHTML}</div>`;
    document.body.appendChild(el);
    return el;
}

const itemTooltip = (name) =>
    popper(`<div class="ItemTooltipText_itemTooltipText__x">
        <div class="ItemTooltipText_name__2JAHA"><span>${name}</span></div></div>`);

const abilityTooltip = () =>
    popper(
        `<div class="Ability_abilityTooltip__1"><div class="Ability_name__2">Berserk</div><div>Level: 42</div></div>`
    );

/** Let the async handler run past its awaits */
const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(async () => {
    document.body.innerHTML = '';
    settings.hideInEnhanceSelector = false;
    await tooltipPrices.initialize();
});

afterEach(() => {
    tooltipPrices.disable();
    tooltipObserver.disable();
});

describe('routing by classification', () => {
    test('subscribes to the shared observer', () => {
        expect(tooltipObserver.subscribers.has('TooltipPrices')).toBe(true);
    });

    test('an item tooltip gets its price section, keyed on the item name', async () => {
        const el = itemTooltip('Cheese');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBe('Cheese');
        expect(el.querySelector('.market-price-injected')).not.toBeNull();
    });

    test('the same popper handed over twice is processed once', async () => {
        const el = itemTooltip('Cheese');
        observerState.handler(el);
        observerState.handler(el);
        await settle();
        expect(el.querySelectorAll('.market-price-injected')).toHaveLength(1);
    });

    test('an enhanced item is priced at its enhancement level, not as the base item', async () => {
        const el = itemTooltip('Griffin Bulwark +7');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBe('Griffin Bulwark +7');
        // Enhanced items skip the craft-profit path; the price section still lands
        expect(el.querySelector('.market-price-injected')).not.toBeNull();
    });

    test('an ability tooltip gets its fresh-cost line and nothing else', async () => {
        const el = abilityTooltip();
        observerState.handler(el);
        await settle();
        expect(el.querySelector('.mwi-ability-fresh')?.textContent).toContain('Fresh to Lv 42');
        expect(el.dataset.pricesProcessedItem).toBeUndefined();
    });

    test('a tooltip that is neither is left alone', async () => {
        const el = popper('<div class="QueuedActions_queuedActionsTooltip__1">3 queued</div>');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBeUndefined();
        expect(el.querySelector('.market-price-injected')).toBeNull();
    });

    test('a popper that is not a tooltip is not touched', async () => {
        const el = popper('<div class="ItemTooltipText_name__2JAHA"><span>Cheese</span></div>', 'MuiPopper-root');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBeUndefined();
    });

    test('handleTooltip classifies for itself when called without a classification', async () => {
        const el = itemTooltip('Cheese');
        await tooltipPrices.handleTooltip(el);
        expect(el.querySelector('.market-price-injected')).not.toBeNull();
    });

    test('disable unsubscribes', () => {
        tooltipPrices.disable();
        expect(tooltipObserver.subscribers.has('TooltipPrices')).toBe(false);
    });
});
