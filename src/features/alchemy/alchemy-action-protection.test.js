/**
 * @vitest-environment happy-dom
 *
 * What this feature is allowed to do to the game's own alchemy panel.
 *
 * The panel it decorates is React's, and the two elements next to the shield
 * are the game's: the item being alchemized, and the catalyst slot beside it —
 * a dashed placeholder the game labels "Consumed Item" and fills with "Not
 * Used" until you pick a catalyst. None of it is ours to move, restyle or
 * duplicate, and a screenshot of a black box sitting where that slot goes is
 * what these tests exist to catch.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: () => 0 } }));
/** Who is logged in, and every write the feature made, for the switch test */
const store = vi.hoisted(() => ({
    characterId: 'character',
    writes: [],
    getJSON: async () => null,
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: (...args) => store.getJSON(...args),
        setJSON: async (key, value) => {
            store.writes.push({ key, value });
        },
    },
}));
const observerReady = vi.hoisted(() => ({ handlers: [], domReady: true }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        // Mirrors the real DOMObserver.onReady: immediate when already attached (the default),
        // deferred until the readiness-gap test fires it by hand otherwise.
        onReady: (name, callback) => {
            const handler = { name, callback };
            observerReady.handlers.push(handler);
            if (observerReady.domReady) callback();
            return () => {
                observerReady.handlers = observerReady.handlers.filter((h) => h !== handler);
            };
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => store.characterId,
        getItemDetails: () => null,
        getInventory: () => [],
        getCurrentActions: () => [],
        getInitClientData: () => null,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../actions/action-panel-sort.js', () => ({
    default: { isPinned: () => false, togglePin: async () => {} },
}));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async () => ({}),
    writeScoped: async () => {},
}));

const { default: alchemyActionProtection } = await import('./alchemy-action-protection.js');
const { default: alchemyItemPins } = await import('./alchemy-item-pins.js');

/**
 * The shape the game gives the alchemy panel: one row holding the item being
 * alchemized and, beside it, the catalyst slot in its empty state.
 * @returns {HTMLElement} The alchemy component
 */
function mountAlchemyPanel() {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_skillActionDetail__1jHU4';
    panel.innerHTML = `
        <div class="SkillActionDetail_alchemyComponent__1J55d">
            <div class="SkillActionDetail_inputs__2tnEq">
                <div class="SkillActionDetail_primaryItemSelectorContainer__nrvNW">
                    <div class="ItemSelector_itemSelector__2eTV6"></div>
                </div>
                <div class="SkillActionDetail_catalystItemInputContainer__5zmou">
                    <div class="ItemSelector_emptySlot__1ns6h">
                        <div class="ItemSelector_label__22ds9">Consumed Item</div>
                    </div>
                </div>
            </div>
            <div class="SkillActionDetail_buttonsContainer__sbg-V"></div>
        </div>`;
    document.body.appendChild(panel);
    return panel.querySelector('[class*="SkillActionDetail_alchemyComponent"]');
}

const catalystSlot = () => document.querySelector('[class*="ItemSelector_emptySlot"]');
const allCatalystSlots = () => document.querySelectorAll('[class*="ItemSelector_emptySlot"]');

beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    observerReady.handlers = [];
    observerReady.domReady = true;
});

afterEach(() => {
    alchemyActionProtection.disable();
    alchemyItemPins.disable();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
});

describe('a character switch inside the protected-category read', () => {
    beforeEach(() => {
        store.characterId = 'character';
        store.writes = [];
        store.getJSON = async () => null;
        alchemyActionProtection.disable();
    });

    afterEach(() => {
        alchemyActionProtection.disable();
        store.characterId = 'character';
        store.getJSON = async () => null;
    });

    test('the empty default is not seeded over the arriving character’s list', async () => {
        // The read was issued for `character`, who has nothing stored, and the
        // player is on the alt by the time it answers. Writing the default now
        // would empty the alt's protected categories — and with them the
        // double-confirm that stands between one click and a decomposed item.
        store.getJSON = async () => {
            store.characterId = 'alt';
            return null;
        };

        await alchemyActionProtection.initialize();

        expect(store.writes).toEqual([]);
    });
});

describe('the shield row beside the item selector', () => {
    test("leaves the game's catalyst slot exactly as the game drew it", async () => {
        mountAlchemyPanel();
        const before = {
            className: catalystSlot().className,
            style: catalystSlot().getAttribute('style'),
            label: catalystSlot().textContent.trim(),
            parent: catalystSlot().parentElement,
        };

        await alchemyActionProtection.initialize();

        // The row is ours and goes in; the slot beside it is the game's and does not move
        expect(document.querySelector('.mwi-alchemy-icon-row')).not.toBeNull();
        expect(catalystSlot().className).toBe(before.className);
        expect(catalystSlot().getAttribute('style')).toBe(before.style);
        expect(catalystSlot().textContent.trim()).toBe(before.label);
        expect(catalystSlot().parentElement).toBe(before.parent);
    });

    test('adds no second catalyst slot, however often the panel is rebuilt', async () => {
        mountAlchemyPanel();
        await alchemyActionProtection.initialize();

        // A React remount re-fires the observer; the guard must not answer it
        // by stacking another row — or another copy of the slot beside it
        const container = document.querySelector('[class*="SkillActionDetail_primaryItemSelectorContainer"]');
        alchemyActionProtection.initialize();
        alchemyActionProtection.initialize();
        expect(container).not.toBeNull();

        expect(allCatalystSlots()).toHaveLength(1);
        expect(document.querySelectorAll('.mwi-alchemy-icon-row')).toHaveLength(1);
    });

    test('a panel mounted before the shared observer is ready gets its row at readiness', async () => {
        observerReady.domReady = false;
        mountAlchemyPanel();

        await alchemyActionProtection.initialize();
        expect(document.querySelector('.mwi-alchemy-icon-row')).toBeNull();

        observerReady.handlers.forEach((h) => h.callback());
        expect(document.querySelector('.mwi-alchemy-icon-row')).not.toBeNull();
    });
});

describe('the action pin and the item-picker pins', () => {
    test('do not share a class name', async () => {
        // They did, and the picker's stylesheet — global, in document.head —
        // describes a 15px badge absolutely positioned at the top right of
        // whatever is positioned above it, painted rgba(10, 14, 22, 0.75) and
        // normally held at opacity 0. Sharing the name made this icon vanish
        // on a mouse and become a black square over the catalyst slot on a
        // touchscreen, where that stylesheet flips it back to 32px and opaque.
        mountAlchemyPanel();
        await alchemyItemPins.initialize();
        await alchemyActionProtection.initialize();

        const pin = document.querySelector('.mwi-alchemy-icon-row div[class*="pin"]');
        expect(pin).not.toBeNull();
        expect(pin.classList.contains('mwi-alchemy-pin')).toBe(false);

        const pickerCss = document.getElementById('mwi-alchemy-pins-style').textContent;
        for (const selector of pickerCss.split('}').map((block) => block.split('{')[0].trim())) {
            if (!selector || selector.startsWith('@') || selector.startsWith('/*')) continue;
            expect(pin.matches(selector)).toBe(false);
        }
    });

    test('turning the item pins off does not take the action pin with it', async () => {
        // disable() sweeps every .mwi-alchemy-pin on the page
        mountAlchemyPanel();
        await alchemyItemPins.initialize();
        await alchemyActionProtection.initialize();

        alchemyItemPins.disable();

        expect(document.querySelector('.mwi-alchemy-action-pin')).not.toBeNull();
    });
});
