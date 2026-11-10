/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: 'alice', enabled: true, settingChanged: null }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => state.enabled,
        onSettingChange: (_key, handler) => {
            state.settingChanged = handler;
            return () => {
                state.settingChanged = null;
            };
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => ({ coinify: ['/item_categories/equipment'], decompose: ['/item_categories/equipment'] }),
        setJSON: async () => true,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.owner,
        getItemDetails: (item) => ({
            categoryHrid: item === '/items/milk' ? '/item_categories/drink' : '/item_categories/equipment',
        }),
        getInventory: () => [],
        getCurrentActions: () => [],
        getInitClientData: () => null,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {}, onReady: () => () => {} } }));
vi.mock('../actions/action-panel-sort.js', () => ({ default: { isPinned: () => false } }));

const { alchemyActionProtection: protection } = await import('./alchemy-action-protection.js');
let panel;
let game;
// DOM selectors and sprite/level shapes mirror the existing protection and
// catalyst-check panel fixtures; this is not a new captured game DOM sample.
function mount() {
    document.body.innerHTML = `
        <div class="AlchemyPanel_tabsComponentContainer"><div role="tab" aria-selected="true">Coinify</div></div>
        <div class="SkillActionDetail_alchemyComponent">
            <div class="SkillActionDetail_itemRequirements"><div class="Item_itemContainer">
                <svg><use href="/items_sprite.svg#sword"></use></svg>
                <span class="Item_enhancementLevel">+0</span>
            </div></div>
            <div class="SkillActionDetail_buttonsContainer"><button>Start Now</button></div>
        </div>`;
    panel = document.querySelector('[class*="SkillActionDetail_alchemyComponent"]');
    panel.querySelector('button').addEventListener('click', game);
}
function press() {
    panel.querySelector('button').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}
function changeItem(item) {
    panel.querySelector('use').setAttribute('href', `/items_sprite.svg#${item}`);
}

beforeEach(async () => {
    vi.useFakeTimers();
    protection.disable();
    state.owner = 'alice';
    state.enabled = true;
    game = vi.fn();
    mount();
    await protection.initialize();
});
afterEach(() => {
    protection.disable();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('confirmation belongs to the protected action being requested', () => {
    test.each(['item', 'level', 'action', 'character'])(
        'a changed %s cannot reuse an armed confirmation',
        async (change) => {
            press();
            await vi.advanceTimersByTimeAsync(3000);
            if (change === 'item') changeItem('boots');
            if (change === 'level') panel.querySelector('[class*="Item_enhancementLevel"]').textContent = '+13';
            if (change === 'action') document.querySelector('[role="tab"]').textContent = 'Decompose';
            if (change === 'character') state.owner = 'bob';
            press();
            expect(game).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(3000);
            press();
            expect(game).toHaveBeenCalledTimes(1);
        }
    );

    test('changing selection before the old lockdown expires cannot arm the new item', async () => {
        press();
        await vi.advanceTimersByTimeAsync(2000);
        changeItem('boots');
        await vi.advanceTimersByTimeAsync(1000);
        press();
        expect(game).not.toHaveBeenCalled();
    });

    test('disable and re-enable cannot reuse an armed confirmation on the same panel', async () => {
        press();
        await vi.advanceTimersByTimeAsync(3000);
        protection.disable();
        await protection.initialize();
        press();
        expect(game).not.toHaveBeenCalled();
    });

    test('disable during lockdown does not permanently lock the reused panel', async () => {
        press();
        protection.disable();
        await protection.initialize();
        press();
        await vi.advanceTimersByTimeAsync(3000);
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('turning protection off and back on retires the earlier confirmation', async () => {
        press();
        await vi.advanceTimersByTimeAsync(3000);
        state.enabled = false;
        state.settingChanged?.(false);
        state.enabled = true;
        state.settingChanged?.(true);
        press();
        expect(game).not.toHaveBeenCalled();
    });

    test('the unchanged action still needs one press after the three-second lockdown', async () => {
        press();
        await vi.advanceTimersByTimeAsync(1000);
        press();
        expect(game).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        press();
        expect(game).toHaveBeenCalledTimes(1);
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('a changed selection restarts the full lockdown rather than keeping the old deadline', async () => {
        press();
        await vi.advanceTimersByTimeAsync(2000);
        changeItem('boots');
        press();
        await vi.advanceTimersByTimeAsync(1000);
        press();
        expect(game).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('an expired confirmation starts a fresh cycle', async () => {
        press();
        await vi.advanceTimersByTimeAsync(6000);
        press();
        expect(game).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3000);
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('a detached panel timer cannot grant confirmation to its replacement', async () => {
        press();
        await vi.advanceTimersByTimeAsync(2000);
        mount();
        press();
        await vi.advanceTimersByTimeAsync(1000);
        press();
        expect(game).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('Start and Queue remain the same confirmation for an unchanged item', async () => {
        press();
        await vi.advanceTimersByTimeAsync(3000);
        const queue = document.createElement('button');
        queue.textContent = 'Add to Queue';
        queue.addEventListener('click', game);
        panel.querySelector('[class*="SkillActionDetail_buttonsContainer"]').appendChild(queue);
        queue.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(game).toHaveBeenCalledTimes(1);
    });

    test('the protected item is read from the pressed panel rather than an earlier panel', () => {
        const earlier = document.createElement('div');
        earlier.innerHTML = `<div class="SkillActionDetail_itemRequirements"><div class="Item_itemContainer">
            <svg><use href="/items_sprite.svg#milk"></use></svg>
        </div></div>`;
        document.body.prepend(earlier);
        press();
        expect(game).not.toHaveBeenCalled();
    });

    test.each(['xlink:href', 'namespaced xlink:href'])(
        'an item sprite using only %s still requires confirmation',
        async (attribute) => {
            const use = panel.querySelector('use');
            use.removeAttribute('href');
            if (attribute === 'xlink:href') use.setAttribute('xlink:href', '/items_sprite.svg#sword');
            else use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '/items_sprite.svg#sword');
            press();
            expect(game).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(3000);
            press();
            expect(game).toHaveBeenCalledTimes(1);
        }
    );

    test('changing an xlink-only sprite cannot reuse the earlier confirmation', async () => {
        press();
        await vi.advanceTimersByTimeAsync(3000);
        const use = panel.querySelector('use');
        use.removeAttribute('href');
        use.setAttribute('xlink:href', '/items_sprite.svg#boots');
        press();
        expect(game).not.toHaveBeenCalled();
    });

    test('unprotected items still pass immediately', () => {
        changeItem('milk');
        press();
        expect(game).toHaveBeenCalledTimes(1);
    });
});
