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

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            communityBuffTypeDetailMap: {
                '/community_buff_types/gathering_quantity': {
                    buff: { typeHrid: '/buff_types/gathering' },
                    cowbellCost: 10,
                },
                '/community_buff_types/experience': { buff: { typeHrid: '/buff_types/wisdom' }, cowbellCost: 20 },
            },
        }),
        getInventory: () => [],
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

    test('finds Buy in the panel modal even when it is not a sibling of the input container', async () => {
        document.body.innerHTML = `
            <div class="TasksPanel_modalContent__a">
                <div class="TasksPanel_buyRow__b">
                    <div class="TasksPanel_inputContainer__c">
                        <div class="Input_inputContainer"><input type="number" value="1"></div>
                    </div>
                </div>
                <button class="Button_button Button_success">Buy</button>
            </div>`;
        const container = document.querySelector('[class*="TasksPanel_inputContainer"]');
        const input = container.querySelector('input');
        const buy = document.querySelector('button[class*="Button_success"]');
        input.addEventListener('input', () => {
            buy.disabled = Number(input.value) > 9;
        });
        state.owned = 100;
        shopMaxBuyButton.initialize();
        state.handlers.find((h) => h.className === 'TasksPanel_inputContainer').callback(container);
        container.querySelector('.toolasha-shop-max-buy-button').click();
        await flush();
        expect(input.value).toBe('9');
    });

    test('ignores a same-styled button outside the panel modal', async () => {
        const { container, input } = modal({ cap: 9 });
        document.body.insertAdjacentHTML('beforeend', '<button class="Button_success">Other</button>');
        state.owned = 100;
        shopMaxBuyButton.initialize();
        state.handlers.find((h) => h.className === 'TasksPanel_inputContainer').callback(container);
        container.querySelector('.toolasha-shop-max-buy-button').click();
        await flush();
        expect(input.value).toBe('9');
    });

    test('stops without searching when two visible Buy buttons make the oracle ambiguous', async () => {
        const { container, input } = modal({ cap: 9 });
        container
            .closest('[class*="TasksPanel_modalContent"]')
            .insertAdjacentHTML('beforeend', '<button class="Button_success">Second</button>');
        state.owned = 100;
        shopMaxBuyButton.initialize();
        state.handlers.find((h) => h.className === 'TasksPanel_inputContainer').callback(container);
        container.querySelector('.toolasha-shop-max-buy-button').click();
        await flush();
        expect(input.value).toBe('100');
    });

    test('stops when the only Buy button is not visible', async () => {
        const { container, input, buy } = modal({ cap: 9 });
        Object.defineProperty(buy, 'offsetParent', { value: null, configurable: true });
        state.owned = 100;
        shopMaxBuyButton.initialize();
        state.handlers.find((h) => h.className === 'TasksPanel_inputContainer').callback(container);
        container.querySelector('.toolasha-shop-max-buy-button').click();
        await flush();
        expect(input.value).toBe('100');
    });

    test('styles the button and removes the style on disable', () => {
        shopMaxBuyButton.initialize();
        expect(document.getElementById('mwi-shop-max-buy-button-style')?.textContent).toContain(
            'toolasha-shop-max-buy-button'
        );
        shopMaxBuyButton.disable();
        expect(document.getElementById('mwi-shop-max-buy-button-style')).toBeNull();
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

describe('ShopMaxBuyButton.resolveUnitCostLines', () => {
    function buffDialog(iconName, total) {
        document.body.innerHTML = `
            <div class="CowbellStorePanel_modalContent">
                <div class="CommunityBuff_communityBuff__x">
                    <svg><use href="/static/media/buffs_sprite.abc.svg#${iconName}"></use></svg>
                </div>
                <div class="CowbellStorePanel_inputContainer"><input type="number" value="10"></div>
                <div>${total}</div>
            </div>`;
        const container = document.querySelector('[class*="inputContainer"]');
        return { container, input: container.querySelector('input') };
    }

    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('a known Community Buff takes the per-minute cost from game data at 10 minutes', () => {
        const { container, input } = buffDialog('gathering', '100');
        expect(shopMaxBuyButton.resolveUnitCostLines(container, input, 'cowbellStore')).toEqual([
            { itemHrid: '/items/cowbell', perUnitAmount: 10 },
        ]);
    });

    test('an unknown buff falls back to dividing the displayed total by the typed quantity', () => {
        const { container, input } = buffDialog('mystery', '100');
        // resolveCostLines is mocked to the displayed "You Pay" total
        state.cost = [{ itemHrid: '/items/cowbell', perUnitAmount: 100 }];
        expect(shopMaxBuyButton.resolveUnitCostLines(container, input, 'cowbellStore')).toEqual([
            { itemHrid: '/items/cowbell', perUnitAmount: 10 },
        ]);
        state.cost = [];
    });

    test('a Cowbell Store item dialog without a buff icon keeps its per-unit price', () => {
        document.body.innerHTML = `
            <div class="CowbellStorePanel_modalContent">
                <div class="CowbellStorePanel_inputContainer"><input type="number" value="5"></div>
                <div>You Pay: 100</div>
            </div>`;
        const container = document.querySelector('[class*="inputContainer"]');
        state.cost = [{ itemHrid: '/items/cowbell', perUnitAmount: 100 }];
        expect(
            shopMaxBuyButton.resolveUnitCostLines(container, container.querySelector('input'), 'cowbellStore')
        ).toEqual(state.cost);
        state.cost = [];
    });

    test('a buff dialog matching by key suffix (experience) or typeHrid suffix (wisdom) resolves', () => {
        for (const icon of ['experience', 'wisdom']) {
            const { container, input } = buffDialog(icon, '200');
            expect(shopMaxBuyButton.resolveUnitCostLines(container, input, 'cowbellStore')).toEqual([
                { itemHrid: '/items/cowbell', perUnitAmount: 20 },
            ]);
        }
    });

    test('other shops keep reading the cost row as it is', () => {
        const { container, input } = buffDialog('gathering', '100');
        state.cost = [{ itemHrid: '/items/task_token', perUnitAmount: 50 }];
        expect(shopMaxBuyButton.resolveUnitCostLines(container, input, 'tasks')).toEqual(state.cost);
        state.cost = [];
    });
});
