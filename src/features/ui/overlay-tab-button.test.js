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

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));

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

beforeEach(() => {
    panel.open = false;
    panel.toggles = 0;
});

afterEach(() => {
    overlayTabButton.cleanup();
    document.body.replaceChildren();
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
