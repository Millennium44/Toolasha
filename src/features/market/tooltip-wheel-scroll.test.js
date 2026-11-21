/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: true, subscriber: null }));

vi.mock('../../core/config.js', () => ({
    default: { isFeatureEnabled: () => state.enabled },
}));
vi.mock('../../core/tooltip-observer.js', () => ({
    default: {
        subscribe: (_name, callback) => {
            state.subscriber = callback;
        },
        unsubscribe: () => {
            state.subscriber = null;
        },
    },
}));

const { tooltipWheelScroll, wheelPixels, canScroll } = await import('./tooltip-wheel-scroll.js');

/** A hover tooltip whose scroller holds `content` pixels in a `view`-pixel box */
function openTooltip({ content = 2000, view = 800, interactive = false } = {}) {
    const popper = document.createElement('div');
    popper.className = `MuiPopper-root MuiTooltip-popper${interactive ? ' MuiTooltip-popperInteractive' : ''}`;
    const scroller = document.createElement('div');
    scroller.className = 'MuiTooltip-tooltip';
    Object.defineProperty(scroller, 'scrollHeight', { value: content, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: view, configurable: true });
    popper.appendChild(scroller);
    document.body.appendChild(popper);
    state.subscriber(popper, 'opened', { isTooltipPopper: true });
    return { popper, scroller };
}

let clock = 10_000;
/** A wheel over the hovered item; returns whether the page's scroll was stopped */
function wheel(deltaY, { target = document.body, deltaMode = 0, ctrlKey = false, after = 1000 } = {}) {
    clock += after;
    const event = new WheelEvent('wheel', { deltaY, deltaMode, ctrlKey, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'timeStamp', { value: clock });
    // happy-dom drops ctrlKey from the WheelEvent init
    Object.defineProperty(event, 'ctrlKey', { value: ctrlKey });
    target.dispatchEvent(event);
    return event.defaultPrevented;
}

beforeEach(() => {
    state.enabled = true;
    tooltipWheelScroll.initialize();
});

afterEach(() => {
    tooltipWheelScroll.cleanup();
    document.body.innerHTML = '';
});

describe('tooltip wheel scroll', () => {
    test('the wheel over the item scrolls a tooltip taller than the window', () => {
        const { scroller } = openTooltip();
        expect(wheel(120)).toBe(true);
        expect(scroller.scrollTop).toBe(120);
        expect(wheel(-50)).toBe(true);
        expect(scroller.scrollTop).toBe(70);
    });

    test('at the bottom the wheel goes back to the page', () => {
        const { scroller } = openTooltip();
        scroller.scrollTop = 1200;
        expect(wheel(100)).toBe(false);
        // At the top, scrolling up is the page's too
        scroller.scrollTop = 0;
        expect(wheel(-100)).toBe(false);
    });

    test('a tooltip that fits leaves the wheel to the page', () => {
        openTooltip({ content: 500, view: 500 });
        expect(wheel(100)).toBe(false);
    });

    test('a list scroll with no tooltip open is not taken over by a tall tooltip opening mid-scroll', () => {
        // The page is scrolling: no tooltip, so only the timing listener hears these
        expect(wheel(100, { after: 1000 })).toBe(false);
        expect(wheel(100, { after: 100 })).toBe(false);
        const { scroller } = openTooltip();
        expect(wheel(100, { after: 100 })).toBe(false);
        expect(scroller.scrollTop).toBe(0);
        // Once the gesture pauses, the tooltip has it, and keeps it through a fast run of wheels
        expect(wheel(100, { after: 1000 })).toBe(true);
        expect(wheel(100, { after: 50 })).toBe(true);
        expect(scroller.scrollTop).toBe(200);
    });

    test('a wheel the page took while a tooltip fitted keeps the gesture on the page', () => {
        openTooltip({ content: 500, view: 500 });
        expect(wheel(100)).toBe(false);
        const { scroller } = openTooltip();
        expect(wheel(100, { after: 100 })).toBe(false);
        expect(scroller.scrollTop).toBe(0);
    });

    test('a wheel on the tooltip itself is left to the browser', () => {
        const { scroller } = openTooltip();
        expect(wheel(100, { target: scroller })).toBe(false);
        expect(scroller.scrollTop).toBe(0);
    });

    test('click menus and Ctrl+wheel zoom are left alone', () => {
        openTooltip({ interactive: true });
        expect(wheel(100)).toBe(false);
        document.body.innerHTML = '';
        const { scroller } = openTooltip();
        expect(wheel(100, { ctrlKey: true })).toBe(false);
        expect(scroller.scrollTop).toBe(0);
    });

    test('turned off, the wheel is the page again', () => {
        openTooltip();
        state.enabled = false;
        expect(wheel(100)).toBe(false);
    });

    test('the listener is removed once the last tooltip closes, and on cleanup', () => {
        const remove = vi.spyOn(document, 'removeEventListener');
        const { popper } = openTooltip();
        popper.remove();
        state.subscriber(popper, 'closed');
        expect(remove).toHaveBeenCalledWith('wheel', expect.any(Function), expect.objectContaining({ capture: true }));
        expect(tooltipWheelScroll.listening).toBe(false);
        openTooltip();
        tooltipWheelScroll.cleanup();
        expect(tooltipWheelScroll.listening).toBe(false);
        remove.mockRestore();
    });

    test('a wheel in lines or pages is turned into pixels', () => {
        expect(wheelPixels({ deltaY: 3, deltaMode: 1 }, 800)).toBe(48);
        expect(wheelPixels({ deltaY: 1, deltaMode: 2 }, 800)).toBe(800);
        expect(wheelPixels({ deltaY: 40, deltaMode: 0 }, 800)).toBe(40);
        const scroller = { scrollTop: 0, clientHeight: 100, scrollHeight: 300 };
        expect(canScroll(scroller, 0)).toBe(false);
    });
});
