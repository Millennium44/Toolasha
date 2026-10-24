/**
 * @vitest-environment happy-dom
 *
 * The Overlay switch in the character tabs.
 *
 * The overlay was opened from a button inside the settings dialog, which is two
 * clicks and a scroll away from something people turn on and off several times
 * an hour. Here it is one click, in the strip already used to change what that
 * column shows — and it has to read as a switch rather than a tab, because it
 * opens a panel instead of selecting a page.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** Settings the mocked config answers with; anything unset is on. */
const settings = vi.hoisted(() => ({ values: {} }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => settings.values[key] ?? true, Z_FLOATING_PANEL: 1100 },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        // Mirrors the real DOMObserver.onReady in its already-attached steady state
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));

/** What the module has written to the device-local hidden key, and its value */
const deviceStorage = vi.hoisted(() => ({ data: {} }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) =>
            Object.hasOwn(deviceStorage.data, key) ? deviceStorage.data[key] : fallback,
        set: async (key, value) => {
            deviceStorage.data[key] = value;
            return true;
        },
    },
}));

vi.mock('../../utils/dom.js', () => ({
    addStyles: (css, id) => {
        const el = document.createElement('style');
        el.id = id;
        el.textContent = css;
        document.head.appendChild(el);
    },
    removeStyles: (id) => document.getElementById(id)?.remove(),
}));

/** Whether the script is acting like a phone, decided per test */
const device = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../utils/mobile.js', () => ({
    isMobileMode: () => device.mobile,
    hasCoarsePointer: () => device.mobile,
}));

const panel = vi.hoisted(() => ({ open: false, toggles: 0 }));

vi.mock('./overlay-panel.js', () => ({
    VISIBILITY_EVENT: 'toolasha:overlay-visibility',
    default: {
        get panel() {
            return panel.open ? {} : null;
        },
        toggle() {
            panel.open = !panel.open;
            panel.toggles += 1;
            document.dispatchEvent(new CustomEvent('toolasha:overlay-visibility', { detail: { open: panel.open } }));
        },
    },
}));

const overlayTabButton = (await import('./overlay-tab-button.js')).default;

/**
 * The character column's tab strip, with a tab shaped the way the game's are.
 * @param {string[]} labels - Tab names, in order
 * @returns {HTMLElement} The strip
 */
function buildTabs(labels = ['Equipment', 'Inventory']) {
    const list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    list.className = 'MuiTabs-flexContainer';
    for (const label of labels) {
        const tab = document.createElement('button');
        tab.setAttribute('role', 'tab');
        tab.className = 'MuiTab-root TabsComponent_tab__x1';
        tab.innerHTML = `<span class="TabsComponent_badge__y2"><div>${label}</div></span>`;
        list.appendChild(tab);
    }
    document.body.appendChild(list);
    return list;
}

/** @returns {HTMLElement|null} */
function theButton() {
    return document.getElementById('toolasha-overlay-tab');
}

/** Flush the microtask queue so a pending storage.get()/set() promise settles */
async function flush() {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    settings.values = {};
    panel.open = false;
    panel.toggles = 0;
    device.mobile = false;
    deviceStorage.data = {};
    window.innerWidth = 400;
    window.innerHeight = 800;
});

afterEach(() => {
    overlayTabButton.cleanup();
    document.body.replaceChildren();
    document.head.replaceChildren();
});

describe('its own switch', () => {
    test('switched off, it draws nothing — the checkbox used to be decorative', () => {
        // The module read only the overlay's setting, and the registry gate
        // answered `true` for the button's own key, so `overlayTabButton` off
        // still put the button in the strip.
        settings.values.overlayTabButton = false;
        buildTabs();

        overlayTabButton.initialize();

        expect(theButton()).toBeNull();
    });

    test('an overlay that is off still takes the button with it', () => {
        settings.values.overlayPanel = false;
        buildTabs();

        overlayTabButton.initialize();

        expect(theButton()).toBeNull();
    });
});

describe('finding its place', () => {
    test('it joins the strip that has an Inventory tab', () => {
        const list = buildTabs();
        overlayTabButton.initialize();

        expect(theButton()).toBeTruthy();
        expect(theButton().parentElement).toBe(list);
    });

    test('a strip belonging to some other panel is left alone', () => {
        // Every tab strip in the game shares the same classes, so the contents
        // are the only thing that says which one this is
        buildTabs(['General', 'Market Listings']);
        overlayTabButton.initialize();

        expect(theButton()).toBeNull();
    });

    test('it sits in front of Optimizer', () => {
        const list = buildTabs(['Inventory', 'Loadouts', 'Optimizer']);
        overlayTabButton.initialize();

        const labels = [...list.children].map((tab) => tab.textContent.trim());
        expect(labels.indexOf('⧉ Overlay')).toBe(labels.indexOf('Optimizer') - 1);
    });

    test('Optimizer arriving late still ends up behind it', () => {
        // On a slow load the Optimizer tab is injected after this one, so where
        // this sits is re-checked rather than decided once
        const list = buildTabs(['Inventory', 'Loadouts']);
        overlayTabButton.initialize();

        const optimizer = document.createElement('button');
        optimizer.setAttribute('role', 'tab');
        optimizer.textContent = 'Optimizer';
        list.appendChild(optimizer);
        overlayTabButton.ensureButton();

        expect(theButton().nextElementSibling).toBe(optimizer);
    });

    test('a rebuilt strip gets the button back', () => {
        buildTabs();
        overlayTabButton.initialize();

        document.body.replaceChildren();
        const rebuilt = buildTabs();
        overlayTabButton.ensureButton();

        expect(theButton()?.parentElement).toBe(rebuilt);
    });

    test('running twice leaves one button', () => {
        buildTabs();
        overlayTabButton.initialize();
        overlayTabButton.ensureButton();

        expect(document.querySelectorAll('#toolasha-overlay-tab').length).toBe(1);
    });
});

describe('looking like the tabs beside it', () => {
    test('it is cloned from a real tab rather than styled to match one', () => {
        // A copy drifts at the next game build; a clone cannot
        buildTabs();
        overlayTabButton.initialize();

        expect(theButton().className).toContain('TabsComponent_tab__x1');
        expect(theButton().querySelector('[class*="TabsComponent_badge"]').textContent).toBe('⧉ Overlay');
    });

    test('it is not copied from a tab the game has hidden', () => {
        // With "show Toolasha tab by default" on, the game's own Inventory tab
        // is set to display: none — and it is the first in the strip, so it is
        // exactly what a naive search picks. The clone carries that inline style
        // with it, and the result is a button that is added, positioned, kept in
        // place, and invisible.
        const list = buildTabs(['Inventory', 'Equipment']);
        list.children[0].style.display = 'none';
        overlayTabButton.initialize();

        expect(theButton().style.display).not.toBe('none');
    });

    test('every tab hidden means no button rather than an invisible one', () => {
        const list = buildTabs(['Inventory']);
        list.children[0].style.display = 'none';
        overlayTabButton.initialize();

        expect(theButton()).toBeNull();
    });

    test('it does not inherit the position of the tab it was copied from', () => {
        // Tab Reorder lays the strip out with CSS order, and a clone brings that
        // number along — parking this button on top of its own model
        const list = buildTabs(['Inventory', 'Equipment']);
        for (const tab of list.children) tab.style.order = '4';
        overlayTabButton.initialize();

        expect(theButton().style.order).toBe('');
    });

    test('it is not left draggable without the handlers that made it so', () => {
        const list = buildTabs();
        for (const tab of list.children) tab.setAttribute('draggable', 'true');
        overlayTabButton.initialize();

        expect(theButton().hasAttribute('draggable')).toBe(false);
    });

    test('an injected tab is not used as the model', () => {
        // Cloning one would copy whatever that feature did to itself
        const list = buildTabs(['Inventory']);
        const ours = document.createElement('button');
        ours.setAttribute('role', 'tab');
        ours.className = 'toolasha-inv-tab injected-look';
        ours.textContent = 'Toolasha';
        list.insertBefore(ours, list.firstChild);
        overlayTabButton.initialize();

        expect(theButton().className).not.toContain('injected-look');
    });

    test('it never claims the selection the real tabs share', () => {
        // It opens a panel instead of choosing what this column shows, so a
        // column showing Inventory with Overlay highlighted would be a lie
        const list = buildTabs();
        list.children[1].classList.add('Mui-selected');
        overlayTabButton.initialize();

        expect(theButton().classList.contains('Mui-selected')).toBe(false);
        expect(theButton().getAttribute('aria-selected')).toBe('false');
    });
});

describe('working as a switch', () => {
    test('clicking it opens the overlay', () => {
        buildTabs();
        overlayTabButton.initialize();
        theButton().click();

        expect(panel.open).toBe(true);
    });

    test('clicking it again closes it', () => {
        // A switch that only ever opens reads as broken the second time
        buildTabs();
        overlayTabButton.initialize();
        theButton().click();
        theButton().click();

        expect(panel.toggles).toBe(2);
        expect(panel.open).toBe(false);
    });

    test('it is dim while the overlay is down and bright while it is up', () => {
        buildTabs();
        overlayTabButton.initialize();
        expect(Number(theButton().style.opacity)).toBeLessThan(1);

        theButton().click();
        expect(Number(theButton().style.opacity)).toBe(1);
    });

    test('closing the panel by its own ✕ dims the switch too', () => {
        buildTabs();
        overlayTabButton.initialize();
        theButton().click();

        // What the panel's close button ends up doing
        panel.open = false;
        document.dispatchEvent(new CustomEvent('toolasha:overlay-visibility', { detail: { open: false } }));

        expect(Number(theButton().style.opacity)).toBeLessThan(1);
    });

    test('cleanup takes the button away and stops listening', () => {
        buildTabs();
        overlayTabButton.initialize();
        overlayTabButton.cleanup();

        expect(theButton()).toBeNull();
        expect(() => document.dispatchEvent(new CustomEvent('toolasha:overlay-visibility'))).not.toThrow();
    });
});

/** The left navigation of the game, with an optional Pinned entry already in it. */
function buildNav({ pinned = false } = {}) {
    const nav = document.createElement('div');
    nav.className = 'NavigationBar_navigationBar__x';
    const links = document.createElement('div');
    links.className = 'NavigationBar_navigationLinks__y';
    links.innerHTML = '<div class="NavigationBar_nav__z">Marketplace</div>';
    if (pinned) links.insertAdjacentHTML('afterbegin', '<div class="mwi-pinned-nav">Pinned</div>');
    nav.appendChild(links);
    document.body.appendChild(nav);
    return { nav, links };
}

/** @returns {HTMLElement|null} */
function theNavItem() {
    return document.getElementById('toolasha-overlay-nav');
}

describe('opening the overlay from anywhere on a phone', () => {
    test('with no character column on screen there is a sidebar entry and no floating launcher', () => {
        device.mobile = true;
        buildNav();
        overlayTabButton.initialize();

        expect(theButton()).toBeNull();
        expect(theNavItem()).toBeTruthy();
        expect(theNavItem().parentElement.className).toContain('NavigationBar_navigationLinks');
        expect(document.getElementById('toolasha-overlay-launcher')).toBeNull();
        expect(theNavItem().textContent).toContain('Overlay');
    });

    test('it sits under the Pinned entry when that is there', () => {
        device.mobile = true;
        const { links } = buildNav({ pinned: true });
        overlayTabButton.initialize();

        expect(links.children[0].className).toBe('mwi-pinned-nav');
        expect(links.children[1]).toBe(theNavItem());
    });

    test('the label hides with the collapsed sidebar rule', () => {
        device.mobile = true;
        buildNav();
        overlayTabButton.initialize();

        const css = document.getElementById('toolasha-overlay-nav-layout').textContent;
        expect(css).toContain('NavigationBar_collapsed');
        // Only inside the game's own collapse query, so a phone in landscape keeps the label
        expect(css).toContain('@media only screen and (max-width: 48rem)');
        expect(css).toContain('.toolasha-overlay-nav-label { display: none; }');
        expect(theNavItem().querySelector('.toolasha-overlay-nav-label')).toBeTruthy();
    });

    test('pressing it toggles the overlay, and it shows whether the overlay is up', () => {
        device.mobile = true;
        buildNav();
        overlayTabButton.initialize();
        expect(theNavItem().getAttribute('aria-pressed')).toBe('false');

        theNavItem().click();
        expect(panel.open).toBe(true);
        expect(theNavItem().getAttribute('aria-pressed')).toBe('true');
        expect(theNavItem().style.background).not.toBe('');

        theNavItem().click();
        expect(panel.open).toBe(false);
        expect(theNavItem().getAttribute('aria-pressed')).toBe('false');
    });

    test('an overlay closed by its own X updates the entry', () => {
        device.mobile = true;
        buildNav();
        overlayTabButton.initialize();
        theNavItem().click();

        panel.open = false;
        document.dispatchEvent(new CustomEvent('toolasha:overlay-visibility'));

        expect(theNavItem().getAttribute('aria-pressed')).toBe('false');
    });

    test('a re-rendered nav gets the entry back, once', () => {
        device.mobile = true;
        buildNav();
        overlayTabButton.initialize();

        document.body.replaceChildren();
        buildNav();
        overlayTabButton.ensureNavItem();
        overlayTabButton.ensureNavItem();

        expect(document.querySelectorAll('#toolasha-overlay-nav')).toHaveLength(1);
    });

    test('no nav yet means nothing is drawn, and the entry appears when it does', () => {
        device.mobile = true;
        overlayTabButton.initialize();
        expect(theNavItem()).toBeNull();

        buildNav();
        overlayTabButton.ensureNavItem();
        expect(theNavItem()).toBeTruthy();
    });

    test('a desktop keeps the tab and gets no sidebar entry', () => {
        device.mobile = false;
        buildNav();
        buildTabs();
        overlayTabButton.initialize();

        expect(theButton()).toBeTruthy();
        expect(theNavItem()).toBeNull();
        expect(document.getElementById('toolasha-overlay-nav-layout')).toBeNull();
    });

    test('leaving mobile mode, or cleanup, removes the entry and its styles', () => {
        device.mobile = true;
        buildNav();
        overlayTabButton.initialize();
        expect(theNavItem()).toBeTruthy();

        device.mobile = false;
        overlayTabButton.ensureNavItem();
        expect(theNavItem()).toBeNull();
        expect(document.getElementById('toolasha-overlay-nav-layout')).toBeNull();

        device.mobile = true;
        overlayTabButton.ensureNavItem();
        expect(theNavItem()).toBeTruthy();
        overlayTabButton.cleanup();
        expect(theNavItem()).toBeNull();
        expect(document.getElementById('toolasha-overlay-nav-layout')).toBeNull();
    });
});

describe('the settings-side control', () => {
    test('setLauncherHidden(true) removes the entry immediately and persists it', async () => {
        device.mobile = true;
        buildNav();
        overlayTabButton.initialize();
        expect(theNavItem()).toBeTruthy();

        await overlayTabButton.setLauncherHidden(true);

        expect(theNavItem()).toBeNull();
        expect(overlayTabButton.isLauncherHidden()).toBe(true);
        expect(deviceStorage.data['toolasha_local_overlayLauncherHidden']).toBe(true);
    });

    test('setLauncherHidden(false) brings the entry back with no reload', async () => {
        device.mobile = true;
        buildNav();
        deviceStorage.data['toolasha_local_overlayLauncherHidden'] = true;
        overlayTabButton.initialize();
        await flush();
        expect(theNavItem()).toBeNull();

        await overlayTabButton.setLauncherHidden(false);

        expect(theNavItem()).toBeTruthy();
        expect(overlayTabButton.isLauncherHidden()).toBe(false);
        expect(deviceStorage.data['toolasha_local_overlayLauncherHidden']).toBe(false);
    });

    test('with the flag unset the entry opens as usual', async () => {
        device.mobile = true;
        buildNav();
        overlayTabButton.initialize();
        await flush();

        expect(theNavItem()).toBeTruthy();
    });
});
