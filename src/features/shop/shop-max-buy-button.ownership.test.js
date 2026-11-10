/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: true, owner: 'alice', affordable: 100 }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => state.enabled } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => state.owner, getInitClientData: () => null, getInventory: () => [] },
}));
vi.mock('../../utils/shop-max-buy.js', async (importOriginal) => ({
    ...(await importOriginal()),
    resolveCostLines: () => [],
    computeMaxAffordable: () => state.affordable,
}));
import { shopMaxBuyButton as feature } from './shop-max-buy-button.js';

let frames;
let container;
let input;
let buyClick;
function mount(cap = 9) {
    // Same shop modal/input/button selectors as the existing integration suite.
    document.body.innerHTML = `<div class="TasksPanel_modalContent">
        <div class="TasksPanel_inputContainer"><div class="Input_inputContainer">
            <input type="number" value="1">
        </div></div>
        <button class="Button_success">Buy</button>
    </div>`;
    container = document.querySelector('[class*="TasksPanel_inputContainer"]');
    input = container.querySelector('input');
    const buy = document.querySelector('button');
    Object.defineProperty(buy, 'offsetParent', { value: document.body, configurable: true });
    buyClick = vi.fn();
    buy.addEventListener('click', buyClick);
    input.addEventListener('input', () => {
        buy.disabled = Number(input.value) > cap;
    });
}
function start() {
    return feature.handleMaxClick(container, input, 'TasksPanel_modalContent', 'tasks');
}
async function frame(index = 0) {
    const [callback] = frames.splice(index, 1);
    expect(callback).toBeTypeOf('function');
    callback();
    for (let i = 0; i < 12; i++) await Promise.resolve();
}
async function finish() {
    for (let i = 0; frames.length && i < 50; i++) await frame();
    expect(frames).toHaveLength(0);
}

beforeEach(() => {
    feature.disable();
    state.enabled = true;
    state.owner = 'alice';
    state.affordable = 100;
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback) => frames.push(callback));
    mount();
    feature.initialize();
});
afterEach(() => {
    expect(buyClick).not.toHaveBeenCalled();
    feature.disable();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

describe('a shop Max search only owns the quantity until the request changes', () => {
    test('a manually entered quantity wins over an unfinished cap search', async () => {
        const searching = start();
        for (let i = 0; i < 4; i++) await frame();
        expect(input.value).toBe('6');
        input.value = '2';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await finish();
        await searching;
        expect(input.value).toBe('2');
    });

    test.each(['input', 'change'])(
        'an external %s edit cancels even when the value returns to the probe',
        async (type) => {
            const searching = start();
            for (let i = 0; i < 4; i++) await frame();
            expect(input.value).toBe('6');
            input.value = '2';
            input.dispatchEvent(new Event(type, { bubbles: true }));
            input.value = '6';
            input.dispatchEvent(new Event(type, { bubbles: true }));
            await finish();
            await searching;
            expect(input.value).toBe('6');
        }
    );

    test('a nested external edit during an owned input event cancels the search', async () => {
        input.addEventListener('input', () => {
            if (input.value !== '6') return;
            input.value = '2';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const searching = start();
        await finish();
        await searching;
        expect(input.value).toBe('2');
    });

    test('an old owned event cannot cancel a newer request started during capture', async () => {
        let newSearch;
        let restarted = false;
        const onCapture = (event) => {
            if (event.target !== input || restarted) return;
            restarted = true;
            newSearch = start();
        };
        document.addEventListener('input', onCapture, true);
        try {
            const oldSearch = start();
            await finish();
            await Promise.all([oldSearch, newSearch]);
            expect(input.value).toBe('9');
        } finally {
            document.removeEventListener('input', onCapture, true);
        }
    });

    test.each(['complete', 'disable', 'supersede', 'edit'])('input listeners are removed on %s', async (ending) => {
        const add = vi.spyOn(input, 'addEventListener');
        const remove = vi.spyOn(input, 'removeEventListener');
        const searching = start();
        const ownedListeners = add.mock.calls.filter(([type]) => type === 'input' || type === 'change');
        expect(ownedListeners).toHaveLength(2);
        if (ending === 'disable') feature.disable();
        if (ending === 'supersede') {
            state.affordable = null;
            await start();
        }
        if (ending === 'edit') input.dispatchEvent(new Event('input', { bubbles: true }));
        if (ending === 'complete') {
            await finish();
            await searching;
        }
        for (const [type, listener] of ownedListeners) {
            expect(remove).toHaveBeenCalledWith(type, listener);
        }
        await finish();
        await searching;
        expect(feature._fills.size).toBe(0);
    });

    test.each(['old first', 'new first'])('a newer Max request wins when frames settle %s', async (order) => {
        const oldSearch = start();
        await frame();
        expect(input.value).toBe('50');
        state.affordable = 3;
        const newSearch = start();
        if (order === 'new first') await frame(1);
        await finish();
        await Promise.all([oldSearch, newSearch]);
        expect(input.value).toBe('3');
    });

    test('a newer request that can no longer afford anything also retires the old search', async () => {
        const oldSearch = start();
        await frame();
        const previous = input.value;
        state.affordable = null;
        await start();
        await finish();
        await oldSearch;
        expect(input.value).toBe(previous);
    });

    test.each(['disable', 'disable/re-enable', 'setting', 'character', 'detach'])(
        '%s retires the old search before it can type another probe',
        async (change) => {
            const searching = start();
            await frame();
            const previous = input.value;
            if (change === 'disable' || change === 'disable/re-enable') feature.disable();
            if (change === 'disable/re-enable') feature.initialize();
            if (change === 'setting') state.enabled = false;
            if (change === 'character') state.owner = 'bob';
            if (change === 'detach') container.closest('[class*="modalContent"]').remove();
            await finish();
            await searching;
            expect(input.value).toBe(previous);
        }
    );

    test('an unchanged search still finds the real cap', async () => {
        const searching = start();
        await finish();
        await searching;
        expect(input.value).toBe('9');
    });

    test('an affordable uncapped request still fills the maximum', async () => {
        mount(200);
        const searching = start();
        await finish();
        await searching;
        expect(input.value).toBe('100');
    });
});
