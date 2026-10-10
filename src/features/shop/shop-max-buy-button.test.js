/** @vitest-environment happy-dom */
/**
 * Shop Max Buy Button: setting gating, injection, the fill, and the guarantee that Buy is never
 * pressed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ settings: { shop_maxBuyButton: true }, handlers: [], cost: [], owned: 0 }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => state.settings[key] },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, callback) => {
            const entry = { name, className, callback };
            state.handlers.push(entry);
            return () => {
                state.handlers.splice(state.handlers.indexOf(entry), 1);
            };
        },
    },
}));

vi.mock('../../utils/shop-max-buy.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        resolveCostLines: () => state.cost,
        computeMaxAffordable: () => state.owned || null,
    };
});

import feature, { shopMaxBuyButton } from './shop-max-buy-button.js';
import { settingsGroups } from '../../core/settings-schema.js';

function modal({ cap = Infinity } = {}) {
    document.body.innerHTML = `
        <div class="TasksPanel_modalContent">
            <div class="TasksPanel_inputContainer">
                <div class="Input_inputContainer"><input type="number" value="1"></div>
            </div>
            <div>You Pay: 50</div>
            <button class="Button_button Button_success">Buy</button>
        </div>`;
    const container = document.querySelector('[class*="TasksPanel_inputContainer"]');
    const input = container.querySelector('input');
    const buy = document.querySelector('button[class*="Button_success"]');
    const buyClick = vi.fn();
    buy.addEventListener('click', buyClick);
    input.addEventListener('input', () => {
        buy.disabled = Number(input.value) > cap;
    });
    return { container, input, buy, buyClick };
}

const flush = async () => {
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 20));
};

describe('shop Max buy button', () => {
    beforeEach(() => {
        state.settings.shop_maxBuyButton = true;
        state.handlers.length = 0;
        state.owned = 0;
        vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
    });

    afterEach(() => {
        shopMaxBuyButton.disable();
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
    });

    test('the setting defaults on', () => {
        const def = Object.values(settingsGroups)
            .flatMap((g) => Object.values(g.settings))
            .find((s) => s.id === 'shop_maxBuyButton');
        expect(def.default).toBe(true);
    });

    test('registers one observer per shop panel when the setting is on', () => {
        shopMaxBuyButton.initialize();
        expect(state.handlers.map((h) => h.className)).toEqual([
            'ShopPanel_inputContainer',
            'TasksPanel_inputContainer',
            'LabyrinthPanel_inputContainer',
            'CowbellStorePanel_inputContainer',
        ]);
    });

    test('registers nothing when the setting is off', () => {
        state.settings.shop_maxBuyButton = false;
        shopMaxBuyButton.initialize();
        expect(state.handlers).toHaveLength(0);
    });

    test('injects a single Max button and removes it on disable', () => {
        const { container } = modal();
        shopMaxBuyButton.initialize();
        shopMaxBuyButton.injectButton(container);
        shopMaxBuyButton.injectButton(container);
        expect(document.querySelectorAll('.toolasha-shop-max-buy-button')).toHaveLength(1);
        feature.disable();
        expect(document.querySelectorAll('.toolasha-shop-max-buy-button')).toHaveLength(0);
        expect(state.handlers).toHaveLength(0);
    });

    test('fills the affordable maximum and never clicks Buy', async () => {
        const { container, input, buyClick } = modal();
        state.owned = 40;
        shopMaxBuyButton.initialize();
        shopMaxBuyButton.injectButton(container);
        container.querySelector('.toolasha-shop-max-buy-button').click();
        await flush();
        expect(input.value).toBe('40');
        expect(buyClick).not.toHaveBeenCalled();
    });

    test('steps down to a purchase cap using the disabled Buy button, still without clicking it', async () => {
        const { container, input, buyClick } = modal({ cap: 9 });
        state.owned = 100;
        shopMaxBuyButton.initialize();
        shopMaxBuyButton.injectButton(container);
        container.querySelector('.toolasha-shop-max-buy-button').click();
        await flush();
        expect(input.value).toBe('9');
        expect(buyClick).not.toHaveBeenCalled();
    });

    test('leaves the input alone when nothing is affordable', async () => {
        const { container, input } = modal();
        state.owned = 0;
        shopMaxBuyButton.initialize();
        shopMaxBuyButton.injectButton(container);
        container.querySelector('.toolasha-shop-max-buy-button').click();
        await flush();
        expect(input.value).toBe('1');
    });
});
