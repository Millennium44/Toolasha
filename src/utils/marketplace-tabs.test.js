/** @vitest-environment happy-dom */
/**
 * Tests for Marketplace Custom Tabs Utility
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
    createMaterialTab,
    visibleTabsContainer,
    removeMaterialTabs,
    removeShrineMarketTabs,
    updateTabBadge,
    navigateToMarketplace,
} from './marketplace-tabs.js';

function buildReferenceTab() {
    const tab = document.createElement('div');
    tab.className = 'Mui-selected';
    tab.setAttribute('aria-selected', 'true');
    tab.setAttribute('tabindex', '0');
    const badge = document.createElement('span');
    badge.className = 'TabsComponent_badge__x';
    tab.appendChild(badge);
    return tab;
}

describe('createMaterialTab', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    test('marks the tab red and shows missing quantity when material is missing', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/plank', itemName: 'plank', missing: 50, required: 100, isTradeable: true },
            ref,
            () => {}
        );
        expect(tab.getAttribute('data-missing-quantity')).toBe('50');
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Missing: 50');
    });

    test('marks the tab green when sufficient', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/plank', itemName: 'plank', missing: 0, required: 100, isTradeable: true },
            ref,
            () => {}
        );
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Sufficient');
    });

    test('marks the tab gray and disables interaction when not tradeable', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/quest_item', itemName: 'quest item', missing: 5, isTradeable: false },
            ref,
            () => {}
        );
        expect(tab.style.opacity).toBe('0.5');
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Not Tradeable');
    });

    test('clears the selected state inherited from the reference tab', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab({ itemHrid: '/items/x', itemName: 'x', missing: 0, isTradeable: true }, ref, () => {});
        expect(tab.classList.contains('Mui-selected')).toBe(false);
        expect(tab.getAttribute('aria-selected')).toBe('false');
    });

    test('invokes the click callback with the material when tradeable', () => {
        const ref = buildReferenceTab();
        const onClick = vi.fn();
        const material = { itemHrid: '/items/x', itemName: 'x', missing: 0, isTradeable: true };
        const tab = createMaterialTab(material, ref, onClick);

        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(onClick.mock.calls[0][1]).toBe(material);
    });

    test('does not invoke the click callback when not tradeable', () => {
        const ref = buildReferenceTab();
        const onClick = vi.fn();
        const tab = createMaterialTab(
            { itemHrid: '/items/x', itemName: 'x', missing: 0, isTradeable: false },
            ref,
            onClick
        );
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(onClick).not.toHaveBeenCalled();
    });

    test('title-cases the item name in the badge', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/x', itemName: 'refined iron bar', missing: 0, isTradeable: true },
            ref,
            () => {}
        );
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Refined Iron Bar');
    });
});

describe('visibleTabsContainer', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    function makeBar({ visible = true, text = 'My Listings' } = {}) {
        const bar = document.createElement('div');
        bar.className = 'MuiTabs-flexContainer';
        bar.setAttribute('role', 'tablist');
        const tab = document.createElement('div');
        tab.textContent = text;
        bar.appendChild(tab);
        if (!visible) {
            bar.style.display = 'none';
            // happy-dom doesn't compute layout; offsetParent stays null for detached/hidden
        }
        document.body.appendChild(bar);
        Object.defineProperty(bar, 'offsetParent', { get: () => (visible ? document.body : null) });
        Object.defineProperty(bar, 'getBoundingClientRect', {
            value: () => ({ width: visible ? 100 : 0 }),
        });
        return bar;
    }

    test('returns null when no tab bar matches', () => {
        expect(visibleTabsContainer()).toBeNull();
    });

    test('skips a hidden bar and returns the visible one containing the marker text', () => {
        makeBar({ visible: false });
        const visible = makeBar({ visible: true });
        expect(visibleTabsContainer()).toBe(visible);
    });

    test('ignores tab bars that do not contain the marker text', () => {
        makeBar({ visible: true, text: 'Something Else' });
        expect(visibleTabsContainer('My Listings')).toBeNull();
    });
});

describe('removeMaterialTabs / removeShrineMarketTabs', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    test('removes only tabs flagged as custom material tabs', () => {
        const custom = document.createElement('div');
        custom.setAttribute('data-mwi-custom-tab', 'true');
        const other = document.createElement('div');
        document.body.append(custom, other);

        removeMaterialTabs();

        expect(document.body.contains(custom)).toBe(false);
        expect(document.body.contains(other)).toBe(true);
    });

    test('removes only shrine tabs', () => {
        const shrine = document.createElement('div');
        shrine.setAttribute('data-mwi-shrine-tab', 'true');
        document.body.appendChild(shrine);

        removeShrineMarketTabs();

        expect(document.body.contains(shrine)).toBe(false);
    });
});

describe('updateTabBadge', () => {
    test('updates badge content and quantity attribute in place', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/x', itemName: 'x', missing: 10, required: 20, isTradeable: true },
            ref,
            () => {}
        );

        updateTabBadge(tab, { itemName: 'x', missing: 0, required: 20, isTradeable: true });

        expect(tab.getAttribute('data-missing-quantity')).toBe('0');
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Sufficient');
        expect(tab.style.opacity).toBe('1');
    });

    test('does nothing when the tab has no badge element', () => {
        const tab = document.createElement('div');
        expect(() => updateTabBadge(tab, { itemName: 'x', missing: 0, isTradeable: true })).not.toThrow();
    });
});

describe('navigateToMarketplace', () => {
    test('silently does nothing when the game object is unavailable', () => {
        expect(() => navigateToMarketplace('/items/plank')).not.toThrow();
    });

    test('calls handleGoToMarketplace with the item and enhancement level', () => {
        const handle = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = { current: { stateNode: { handleGoToMarketplace: handle }, child: null, sibling: null } };
        document.body.appendChild(root);

        navigateToMarketplace('/items/plank', 5);
        expect(handle).toHaveBeenCalledWith('/items/plank', 5);
        document.body.innerHTML = '';
    });
});
