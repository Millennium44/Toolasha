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

const { default: feature, placeClear } = await import('./inventory-tooltip-beside.js');

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
    it('moves a tooltip that covers the item to the roomier side, top at the tile', () => {
        expect(placeClear(over(), tile, vp)).toEqual({ x: 672, y: 300 });
        expect(placeClear(over({ left: 200 }), { ...tile, left: 300 }, vp)).toEqual({ x: 368, y: 300 });
    });
    it('clamps so the bottom fits, and pins to the top margin when taller than the viewport', () => {
        expect(placeClear(over({ top: 700 }), { ...tile, top: 900 }, vp)).toEqual({ x: 672, y: 622 });
        expect(placeClear(over({ top: 0, height: 1200 }), { ...tile, top: 500 }, vp)).toEqual({ x: 672, y: 8 });
    });
    it('leaves the game placement when neither side has room, or nothing was measured', () => {
        expect(placeClear(over({ left: 200, width: 1700 }), { ...tile, left: 300 }, vp)).toBeNull();
        expect(placeClear(over({ width: 0 }), tile, vp)).toBeNull();
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
        expect(popper.style.getPropertyValue('--tl-tip-x')).toBe('672px');
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
        expect(popper.style.getPropertyValue('--tl-tip-x')).toBe('672px');
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

    it('leaves a tooltip whose anchor is outside the inventory alone', () => {
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

    it('keeps the game placement on a phone', () => {
        h.mobile = true;
        const popper = build();
        h.callback(popper, 'opened', ITEM_INFO);
        expect(popper.classList.contains('toolasha-tip-beside')).toBe(false);
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
