/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, mobile: false, callback: null, resizeCallbacks: [] }));

vi.mock('../../core/config.js', () => ({ default: { isFeatureEnabled: () => h.enabled } }));
vi.mock('../../utils/mobile.js', () => ({ isMobileMode: () => h.mobile }));
vi.mock('../../core/tooltip-observer.js', () => ({
    default: {
        subscribe: (name, cb) => {
            h.callback = cb;
        },
        unsubscribe: () => {
            h.callback = null;
        },
    },
}));

const {
    default: feature,
    placeClear,
    placePhone,
    InventoryTooltipBeside,
    CSS: TOOLTIP_CSS,
} = await import('./inventory-tooltip-beside.js');

const rect = (o) => ({ left: 0, top: 0, width: 0, height: 0, ...o });
const ITEM_INFO = { isTooltipPopper: true, isItemTooltip: true };

/** Build an inventory with one tile and an open popper; rects are stubbed. */
function build({
    inInventory = true,
    panelLeft = 900,
    tileLeft = 1000,
    tileTop = 300,
    size = { width: 320, height: 370 },
} = {}) {
    document.body.innerHTML = `
        <div class="Inventory_items__x"><div class="Item_itemContainer__y"><div id="trigger" aria-describedby="pop1"></div></div></div>
        <div id="outside" aria-describedby="pop2"></div>
        <div id="pop1" class="MuiPopper-root MuiTooltip-popper" style="transform: translate3d(1629px, -677px, 0)"></div>
        <div id="pop2" class="MuiPopper-root MuiTooltip-popper"></div>`;
    const panel = document.querySelector('.Inventory_items__x');
    panel.getBoundingClientRect = () => rect({ left: panelLeft });
    document.querySelector('.Item_itemContainer__y').getBoundingClientRect = () =>
        rect({ left: tileLeft, top: tileTop, width: 60, height: 60 });
    const popper = document.getElementById(inInventory ? 'pop1' : 'pop2');
    // The game's own placement: over the tile unless a test says otherwise
    popper.getBoundingClientRect = () => rect({ left: tileLeft - 100, top: tileTop - 200, ...size });
    if (!inInventory) {
        document.getElementById('outside').getBoundingClientRect = () => rect({ top: 50 });
    }
    return popper;
}

describe('placeClear', () => {
    const vp = { width: 1920, height: 1000 };
    const tile = { left: 1000, top: 300, width: 60, height: 60 };
    const over = (o) => ({ left: 900, top: 100, width: 320, height: 370, ...o });
    it('keeps the game placement when it already clears the item', () => {
        expect(placeClear(over({ top: -80, height: 370 }), tile, vp)).toBeNull();
        expect(placeClear(over({ top: 370 }), tile, vp)).toBeNull();
    });
    it('moves a tooltip that covers the item to the roomier side, touching it as above and below do', () => {
        expect(placeClear(over(), tile, vp)).toEqual({ x: 680, y: 300 });
        expect(placeClear(over({ left: 200 }), { ...tile, left: 300 }, vp)).toEqual({ x: 360, y: 300 });
    });
    it('clamps so the bottom fits, and pins to the top margin when taller than the viewport', () => {
        expect(placeClear(over({ top: 700 }), { ...tile, top: 900 }, vp)).toEqual({ x: 680, y: 622 });
        expect(placeClear(over({ top: 0, height: 1200 }), { ...tile, top: 500 }, vp)).toEqual({ x: 680, y: 8 });
    });
    it('leaves the game placement when neither side has room, or nothing was measured', () => {
        expect(placeClear(over({ left: 200, width: 1700 }), { ...tile, left: 300 }, vp)).toBeNull();
        expect(placeClear(over({ width: 0 }), tile, vp)).toBeNull();
    });
});

describe('placePhone', () => {
    const overlaps = (r, t) =>
        r.left < t.left + t.width && t.left < r.left + r.width && r.top < t.top + t.height && t.top < r.top + r.height;

    describe('beside the tile', () => {
        const vp = { width: 412, height: 924 };
        it('the live Regal Sword geometry: squeezed to the right of the tile, capped, never over it', () => {
            const tile = { left: 181, top: 446, width: 42, height: 42 };
            const spot = placePhone({ left: 89, top: 9, width: 226, height: 480 }, tile, vp);
            expect(spot).toEqual({ x: 223, y: 316, maxHeight: 0, maxWidth: 181 });
            const shown = Math.min(Math.ceil((480 * 226) / 181), 908);
            expect(overlaps({ left: spot.x, top: spot.y, width: 181, height: shown }, tile)).toBe(false);
            expect(spot.y + shown).toBeLessThanOrEqual(916);
        });
        it('prefers the right when the whole tooltip fits there, keeping its width', () => {
            const tile = { left: 20, top: 300, width: 42, height: 42 };
            expect(placePhone({ left: 0, top: 200, width: 226, height: 300 }, tile, vp)).toEqual({
                x: 62,
                y: 300,
                maxHeight: 0,
                maxWidth: 0,
            });
        });
        it('uses the left when only the left fits whole', () => {
            const tile = { left: 300, top: 300, width: 42, height: 42 };
            expect(placePhone({ left: 200, top: 200, width: 226, height: 300 }, tile, vp)).toEqual({
                x: 74,
                y: 300,
                maxHeight: 0,
                maxWidth: 0,
            });
        });
        it('caps a tooltip taller than the screen to the screen and pins it to the top', () => {
            const tile = { left: 20, top: 300, width: 42, height: 42 };
            const spot = placePhone({ left: 0, top: 0, width: 226, height: 1400 }, tile, vp);
            expect(spot).toEqual({ x: 62, y: 8, maxHeight: 908, maxWidth: 0 });
        });
    });

    describe('above or below, when neither side has room', () => {
        const vp = { width: 320, height: 800 };
        const tile = { left: 140, top: 400, width: 44, height: 44 };
        it('never covers the tapped tile, with or without a cap', () => {
            for (const height of [200, 360, 500, 900]) {
                for (const top of [100, 380, 500]) {
                    const spot = placePhone({ left: 10, top, width: 300, height }, tile, vp) || { x: 10, y: top };
                    const shown = spot.maxHeight || height;
                    expect(overlaps({ left: spot.x, top: spot.y, width: 300, height: shown }, tile)).toBe(false);
                    expect(spot.y).toBeGreaterThanOrEqual(8);
                    expect(spot.y + shown).toBeLessThanOrEqual(792);
                }
            }
        });
        it('goes above when below has no room, capped when taller than the room', () => {
            const low = { ...tile, top: 700 };
            expect(placePhone({ left: 10, top: 600, width: 300, height: 300 }, low, vp)).toEqual({
                x: 10,
                y: 400,
                maxHeight: 0,
                maxWidth: 0,
            });
            expect(placePhone({ left: 10, top: 600, width: 300, height: 900 }, low, vp).maxHeight).toBe(692);
        });
        it('leaves a tooltip that clears the tile and fits the screen to the game', () => {
            expect(placePhone({ left: 10, top: 450, width: 300, height: 300 }, tile, vp)).toBeNull();
        });
        it('caps a tooltip that clears the tile but runs off the screen', () => {
            const spot = placePhone({ left: 10, top: 450, width: 300, height: 500 }, tile, vp);
            expect(spot).toMatchObject({ y: 8, maxHeight: 392 });
        });
    });
});

describe('InventoryTooltipBeside', () => {
    beforeEach(async () => {
        h.enabled = true;
        h.mobile = false;
        h.resizeCallbacks = [];
        window.innerWidth = 1920;
        window.innerHeight = 1000;
        globalThis.ResizeObserver = class {
            constructor(cb) {
                this.cb = cb;
                h.resizeCallbacks.push(cb);
                this.disconnected = false;
            }
            observe() {}
            disconnect() {
                this.disconnected = true;
                h.resizeCallbacks = h.resizeCallbacks.filter((c) => c !== this.cb);
            }
        };
        await feature.initialize();
    });
    afterEach(() => {
        feature.cleanup();
    });

    it('moves an inventory tooltip that covers the item beside it, aligned to the tile', () => {
        const popper = build();
        h.callback(popper, 'opened', ITEM_INFO);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(true);
        expect(popper.style.getPropertyValue('--tl-tip-x')).toBe('680px');
        expect(popper.style.getPropertyValue('--tl-tip-y')).toBe('300px');
    });

    it('clamps the top when the tooltip would run off the bottom', () => {
        const popper = build({ tileTop: 900 });
        h.callback(popper, 'opened', ITEM_INFO);
        expect(popper.style.getPropertyValue('--tl-tip-y')).toBe('622px');
    });

    it('re-measures when the tooltip resizes (lines appended after open)', () => {
        const popper = build({ tileTop: 500 });
        h.callback(popper, 'opened', ITEM_INFO);
        expect(popper.style.getPropertyValue('--tl-tip-y')).toBe('500px');
        popper.getBoundingClientRect = () => rect({ left: 900, top: 300, width: 320, height: 500 });
        h.resizeCallbacks.forEach((cb) => cb());
        expect(popper.style.getPropertyValue('--tl-tip-y')).toBe('492px');
    });

    it('falls back to the game placement when neither side has room', () => {
        const popper = build({ panelLeft: 200, tileLeft: 300, size: { width: 1700, height: 370 } });
        h.callback(popper, 'opened', ITEM_INFO);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
        expect(popper.style.getPropertyValue('--tl-tip-x')).toBe('');
        expect(popper.style.transform).toContain('1629px');
    });

    it('drops the class when a resize leaves no room, and keeps watching', () => {
        const popper = build({ panelLeft: 600, tileLeft: 700 });
        h.callback(popper, 'opened', ITEM_INFO);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(true);
        popper.getBoundingClientRect = () => rect({ left: 0, top: 500, width: 1800, height: 300 });
        h.resizeCallbacks.forEach((cb) => cb());
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
        expect(h.resizeCallbacks.length).toBe(1);
    });

    it('moves the tooltip once the game positions it over the item a frame after open', async () => {
        const popper = build();
        // At open the game has not placed it yet: it sits at the top-left corner, clear of the tile
        const unplaced = () => rect({ left: 0, top: 0, width: 320, height: 370 });
        popper.getBoundingClientRect = unplaced;
        h.callback(popper, 'opened', ITEM_INFO);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
        // The game's placement lands on the tile
        popper.getBoundingClientRect = () => rect({ left: 900, top: 100, width: 320, height: 370 });
        popper.style.transform = 'translate3d(900px, 100px, 0)';
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(true);
        expect(popper.style.getPropertyValue('--tl-tip-x')).toBe('680px');
        // And a later game placement that clears the item hands it back
        popper.getBoundingClientRect = unplaced;
        popper.style.transform = 'translate3d(0px, 0px, 0)';
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
    });

    it('keeps watching a tooltip whose first placement already clears the item', () => {
        const popper = build();
        popper.getBoundingClientRect = () => rect({ left: 900, top: -100, width: 320, height: 370 });
        h.callback(popper, 'opened', ITEM_INFO);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
        expect(h.resizeCallbacks.length).toBe(1);
    });

    it('leaves a tooltip whose anchor is not an item tile alone', () => {
        const popper = build({ inInventory: false });
        h.callback(popper, 'opened', ITEM_INFO);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
        expect(h.resizeCallbacks.length).toBe(0);
    });

    it('ignores non-item tooltips', () => {
        const popper = build();
        h.callback(popper, 'opened', { isTooltipPopper: true, isItemTooltip: false });
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
    });

    it('removes the class and the observer on close', () => {
        const popper = build();
        h.callback(popper, 'opened', ITEM_INFO);
        expect(h.resizeCallbacks.length).toBe(1);
        h.callback(popper, 'closed', ITEM_INFO);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
        expect(popper.style.getPropertyValue('--tl-tip-x')).toBe('');
        expect(h.resizeCallbacks.length).toBe(0);
    });

    it('does nothing with the setting off', async () => {
        feature.cleanup();
        h.enabled = false;
        await feature.initialize();
        expect(h.callback).toBeNull();
    });

    it('stops at the next open when the setting is switched off', () => {
        h.enabled = false;
        const popper = build();
        h.callback(popper, 'opened', ITEM_INFO);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
    });

    it('on a phone, moves a tooltip covering the tapped item beside it, squeezed and capped', () => {
        h.mobile = true;
        window.innerWidth = 412;
        window.innerHeight = 924;
        const popper = build({ tileLeft: 181, tileTop: 446 });
        document.querySelector('.Item_itemContainer__y').getBoundingClientRect = () =>
            rect({ left: 181, top: 446, width: 42, height: 42 });
        popper.getBoundingClientRect = () => rect({ left: 89, top: 9, width: 226, height: 480 });
        h.callback(popper, 'opened', ITEM_INFO);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(true);
        expect(popper.style.getPropertyValue('--tl-tip-x')).toBe('223px');
        expect(popper.style.getPropertyValue('--tl-tip-y')).toBe('316px');
        expect(popper.style.getPropertyValue('--tl-tip-w')).toBe('181px');
    });

    it('cleanup hands open tooltips back and removes the stylesheet', () => {
        const popper = build();
        h.callback(popper, 'opened', ITEM_INFO);
        expect(document.getElementById('toolasha-tip-beside-style')).not.toBeNull();
        feature.cleanup();
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
        expect(document.getElementById('toolasha-tip-beside-style')).toBeNull();
    });
});

describe('ItemTooltipBeside outside the inventory', () => {
    const sprite = (fragment) => `<svg><use href="/static/media/items_sprite.abc.svg#${fragment}"></use></svg>`;
    const POPPER = `<div id="pop1" class="MuiPopper-root MuiTooltip-popper">
        <div class="MuiTooltip-tooltip"><div class="ItemTooltipText_name__n"><span>Pathbreaker Boots</span></div></div>
    </div>`;
    const BOOTS = { ...ITEM_INFO, itemHrid: '/items/pathbreaker_boots' };

    /** Stub the tile and popper rects: the game's placement covers the tile */
    function stub(tile, popper) {
        tile.getBoundingClientRect = () => rect({ left: 1000, top: 300, width: 60, height: 60 });
        popper.getBoundingClientRect = () => rect({ left: 900, top: 100, width: 320, height: 370 });
    }

    beforeEach(async () => {
        h.enabled = true;
        h.mobile = false;
        window.innerWidth = 1920;
        window.innerHeight = 1000;
        delete globalThis.ResizeObserver;
        await feature.initialize();
    });
    afterEach(() => {
        feature.cleanup();
    });

    it('moves a Loadouts-panel slot tooltip off the slot (anchor named by aria-describedby)', () => {
        document.body.innerHTML = `
            <div class="LoadoutsPanel_selectedLoadout__s"><div class="LoadoutsPanel_equipment__e">
                <div class="Item_item__a" aria-describedby="pop1">${sprite('pathbreaker_boots')}</div>
            </div></div>${POPPER}`;
        const tile = document.querySelector('.Item_item__a');
        const popper = document.getElementById('pop1');
        stub(tile, popper);
        h.callback(popper, 'opened', BOOTS);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(true);
        expect(popper.style.getPropertyValue('--tl-tip-x')).toBe('680px');
        expect(popper.style.getPropertyValue('--tl-tip-y')).toBe('300px');
    });

    it('moves an equipment-panel tooltip off the worn item, measured from the item container', () => {
        document.body.innerHTML = `
            <div class="EquipmentPanel_playerModel__p"><div class="EquipmentPanel_equipmentSlot__q">
                <div class="Item_itemContainer__c"><div class="Item_item__a" aria-describedby="pop1">${sprite(
                    'pathbreaker_boots'
                )}</div></div>
            </div></div>${POPPER}`;
        const tile = document.querySelector('.Item_itemContainer__c');
        const popper = document.getElementById('pop1');
        stub(tile, popper);
        h.callback(popper, 'opened', BOOTS);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(true);
        expect(popper.style.getPropertyValue('--tl-tip-x')).toBe('680px');
    });

    it('falls back to the hovered item tile when no trigger names the popper (an item picker)', () => {
        document.body.innerHTML = `
            <div class="Modal_modal__m"><div class="ItemSelector_itemList__l">
                <div class="Item_itemContainer__c"><div class="Item_item__a" id="hovered">${sprite(
                    'pathbreaker_boots'
                )}</div></div>
            </div></div>${POPPER}`;
        const tile = document.querySelector('.Item_itemContainer__c');
        const popper = document.getElementById('pop1');
        stub(tile, popper);
        h.callback(popper, 'opened', { ...BOOTS, hoverTarget: document.querySelector('#hovered use') });
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(true);
    });

    it('moves the tooltip of a picker the game draws as a menu popper', () => {
        document.body.innerHTML = `
            <div class="MuiPopper-root MuiPopover-paper"><div class="ItemSelector_itemList__l">
                <div class="Item_itemContainer__c"><div class="Item_item__a" aria-describedby="pop1">${sprite(
                    'pathbreaker_boots'
                )}</div></div>
            </div></div>${POPPER}`;
        const tile = document.querySelector('.Item_itemContainer__c');
        const popper = document.getElementById('pop1');
        stub(tile, popper);
        h.callback(popper, 'opened', BOOTS);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(true);
    });

    it('ignores a hover target showing another item than the tooltip, or one outside any item tile', () => {
        document.body.innerHTML = `
            <div class="Item_itemContainer__c"><div class="Item_item__a" id="hovered">${sprite('gummy')}</div></div>
            <button id="plain">Equip</button>${POPPER}`;
        const tile = document.querySelector('.Item_itemContainer__c');
        const popper = document.getElementById('pop1');
        stub(tile, popper);
        h.callback(popper, 'opened', { ...BOOTS, hoverTarget: document.getElementById('hovered') });
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
        h.callback(popper, 'closed', BOOTS);
        h.callback(popper, 'opened', { ...BOOTS, hoverTarget: document.getElementById('plain') });
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
    });

    it('hands back a tooltip the enhance selector hides', async () => {
        document.body.innerHTML = `
            <div class="Item_itemContainer__c"><div class="Item_item__a" aria-describedby="pop1">${sprite(
                'pathbreaker_boots'
            )}</div></div>${POPPER}`;
        const tile = document.querySelector('.Item_itemContainer__c');
        const popper = document.getElementById('pop1');
        stub(tile, popper);
        h.callback(popper, 'opened', BOOTS);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(true);
        popper.getBoundingClientRect = () => rect({});
        popper.style.display = 'none';
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
        expect(popper.style.getPropertyValue('--tl-tip-x')).toBe('');
    });
});

describe('InventoryTooltipBeside bounded work', () => {
    beforeEach(async () => {
        h.enabled = true;
        h.mobile = false;
        window.innerWidth = 1920;
        window.innerHeight = 1000;
        delete globalThis.ResizeObserver;
        await feature.initialize();
    });
    afterEach(() => {
        feature.cleanup();
        vi.restoreAllMocks();
    });

    it('hands a tooltip back to the game when the game keeps re-placing it against the move', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const popper = build();
        // A game that re-places the popper for the size the class gives it: over the tile without the class,
        // clear of it with the class on. Every move is a style write, and every answer changes the class
        let gameWrites = 0;
        const overTile = () => rect({ left: 900, top: 100, width: 320, height: 370 });
        const clear = () => rect({ left: 900, top: -400, width: 320, height: 370 });
        popper.getBoundingClientRect = overTile;
        const game = new MutationObserver(() => {
            if (gameWrites >= 500) return;
            gameWrites += 1;
            const placed = popper.classList.contains('toolasha-tip-beside');
            popper.getBoundingClientRect = placed ? clear : overTile;
            popper.style.transform = `translate3d(900px, ${placed ? -400 : 100}px, ${gameWrites}px)`;
        });
        game.observe(popper, { attributes: true, attributeFilter: ['class'] });
        h.callback(popper, 'opened', ITEM_INFO);
        for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
        game.disconnect();
        expect(gameWrites).toBeLessThan(50);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('stops after a burst of passes in one short window', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const popper = build();
        const inst = new InventoryTooltipBeside();
        inst.handleOpen(popper, ITEM_INFO);
        const state = inst.tracked.get(popper);
        let skipped = 0;
        for (let i = 0; i < 100; i++) if (inst.overBudget(popper, state)) skipped += 1;
        expect(skipped).toBeGreaterThan(0);
        expect(inst.tracked.has(popper)).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        inst.release(popper);
    });
});

describe('tooltip width', () => {
    it('leaves the game its own max-width unless a phone placement squeezed the tooltip', () => {
        // A `none` fallback lifted the game's limit, and desktop tooltips ran the width of the screen
        expect(TOOLTIP_CSS).not.toMatch(/max-width:\s*var\(--tl-tip-w,\s*none\)/);
        const rules = TOOLTIP_CSS.split('}').filter((r) => /max-width/.test(r));
        expect(rules).toHaveLength(1);
        expect(rules[0]).toContain('[style*="--tl-tip-w"]');
    });
});
