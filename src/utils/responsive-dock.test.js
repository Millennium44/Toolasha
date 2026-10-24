/** @vitest-environment happy-dom */
import { afterEach, expect, test, vi } from 'vitest';
import { dockWhenNarrow } from './responsive-dock.js';

let detach;
afterEach(() => {
    detach?.();
    detach = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function fixture(width = 360) {
    const host = document.createElement('div');
    const tabs = document.createElement('nav');
    const content = document.createElement('main');
    host.append(tabs, content);
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'position:fixed; top:110px; right:24px; width:280px;';
    document.body.append(host, toolbar);
    const rect = vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ width });
    const disconnect = vi.fn();
    let resize;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(callback) {
                resize = callback;
            }
            observe() {}
            disconnect = disconnect;
        }
    );
    const changed = vi.fn();
    detach = dockWhenNarrow(toolbar, { host, before: content, onChange: changed });
    return { host, tabs, content, toolbar, rect, resize, changed, disconnect };
}

test('a narrow content panel gets a flow row below its tabs, not a fixed overlay', () => {
    const { host, tabs, content, toolbar } = fixture();
    expect(toolbar.parentElement).toBe(host);
    expect(toolbar.previousElementSibling).toBe(tabs);
    expect(toolbar.nextElementSibling).toBe(content);
    expect(toolbar.style.position).toBe('relative');
    expect(toolbar.style.maxWidth).toBe('100%');
    expect(toolbar.dataset.toolashaDocked).toBe('true');
});

test('wide content keeps exact desktop geometry, then restores it after resizing both ways', () => {
    const { host, toolbar, rect, resize, changed } = fixture(1000);
    const css = toolbar.style.cssText;
    expect(toolbar.parentElement).toBe(document.body);
    rect.mockReturnValue({ width: 360 });
    resize();
    expect(toolbar.parentElement).toBe(host);
    resize();
    expect(changed).toHaveBeenCalledTimes(1);
    rect.mockReturnValue({ width: 1000 });
    resize();
    expect(toolbar.parentElement).toBe(document.body);
    expect(toolbar.style.cssText).toBe(css);
    expect(toolbar.dataset.toolashaDocked).toBeUndefined();
});

test('hidden content does not overwrite desktop placement', () => {
    const { toolbar } = fixture(0);
    expect(toolbar.parentElement).toBe(document.body);
    expect(toolbar.style.top).toBe('110px');
});

test('cleanup disconnects observers and does not resurrect a removed toolbar', () => {
    const { toolbar, disconnect, resize } = fixture();
    toolbar.remove();
    detach();
    resize();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(toolbar.isConnected).toBe(false);
    expect([...document.body.childNodes].some((node) => node.nodeType === 8)).toBe(false);
    detach = null;
});

test('moving the native content out from under a toolbar makes later resize harmless', () => {
    const { host, toolbar, resize } = fixture();
    host.remove();
    resize();
    detach();
    expect(toolbar.isConnected).toBe(false);
    detach = null;
});
