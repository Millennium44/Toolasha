/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// A Mystical Study 5 -> 6 upgrade, the shape of the user's bug report: many
// materials, several of them short, so the marketplace button is built too.
const MATERIALS = Array.from({ length: 14 }, (_, i) => ({
    itemHrid: `/items/mat_${i}`,
    count: 1000,
    totalValue: 10_000,
}));

const itemDetailMap = Object.fromEntries(MATERIALS.map((m, i) => [m.itemHrid, { name: `Mat ${i}`, isTradable: true }]));

const inventoryState = vi.hoisted(() => ({
    items: [],
    reserved: new Map(),
    marketListeners: [],
    unitPrice: 10,
    deferredCosts: [],
    notifyMarketUpdate: () => Promise.all(inventoryState.marketListeners.map((listener) => listener())),
}));

vi.mock('../../utils/house-cost-calculator.js', () => ({
    calculateCumulativeCost: async () => {
        const deferred = inventoryState.deferredCosts.shift();
        if (deferred) return deferred.promise;

        const materials = MATERIALS.map((material) => ({
            ...material,
            marketPrice: inventoryState.unitPrice,
            totalValue: material.count * inventoryState.unitPrice,
        }));
        return {
            coins: 5000,
            materials,
            totalValue: 5000 + materials.reduce((sum, material) => sum + material.totalValue, 0),
        };
    },
    getCurrentRoomLevel: () => 5,
    // Nothing in the inventory, so every material is short
    getInventoryCount: () => 0,
    getItemName: (hrid) => itemDetailMap[hrid]?.name ?? hrid,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap }),
        getInventory: () => inventoryState.items,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../utils/inventory-reservations.js', () => ({
    effectiveInventory: (itemHrid, enhancementLevel = 0) => {
        const held = inventoryState.items
            .filter(
                (item) =>
                    item.itemHrid === itemHrid &&
                    item.itemLocationHrid === '/item_locations/inventory' &&
                    (item.enhancementLevel || 0) === enhancementLevel
            )
            .reduce((sum, item) => sum + item.count, 0);
        return Math.max(0, held - (inventoryState.reserved.get(`${itemHrid}:${enhancementLevel}`) || 0));
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: {
        on: (listener) => inventoryState.marketListeners.push(listener),
        off: (listener) => {
            inventoryState.marketListeners = inventoryState.marketListeners.filter(
                (candidate) => candidate !== listener
            );
        },
    },
}));

vi.mock('../../utils/bundle-bridge.js', () => ({ missingMaterialsButton: null }));
vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false }));
vi.mock('../../core/dom-observer.js', () => ({
    default: { observe: () => () => {}, onClass: () => () => {}, disconnect: () => {} },
}));

const { default: houseCostDisplay } = await import('./house-cost-display.js');

/** Build the game's costs section and let the module hang its own section off it */
async function render(currentLevel = 5) {
    const modal = document.createElement('div');
    const costsSection = document.createElement('div');
    modal.appendChild(costsSection);
    document.body.appendChild(modal);
    await houseCostDisplay.addCompactToLevel(costsSection, '/house_rooms/mystical_study', currentLevel);
    return modal.querySelector('.mwi-house-to-level');
}

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

beforeEach(() => {
    document.body.innerHTML = '';
    inventoryState.items = [];
    inventoryState.reserved = new Map();
    inventoryState.marketListeners = [];
    inventoryState.unitPrice = 10;
    inventoryState.deferredCosts = [];
});

describe('the material rows fit a phone-width dialog', () => {
    // The four columns' min-widths add up to ~550px. Unwrapped, that min-content
    // made the section wider than a ~340px phone dialog, and the panel's
    // `align-items: center` hung it off both edges: the count column clipped
    // at the left and the rest scrolling sideways. happy-dom does no layout, so
    // this pins the declaration; the fit was measured in Firefox, Chromium and
    // WebKit at 360 and 390px wide against a copy of the game's dialog CSS.
    test('every row may wrap its columns onto a second line', async () => {
        const section = await render();
        const rows = section.querySelectorAll('.mwi-cumulative-materials-list > div');

        expect(rows.length).toBe(MATERIALS.length + 1); // coins + materials
        for (const row of rows) {
            expect(row.style.display).toBe('flex');
            expect(row.style.flexWrap).toBe('wrap');
        }
    });

    test('the section is appended after everything the game drew, Build button included', async () => {
        const panel = document.createElement('div');
        const costsSection = document.createElement('div');
        const build = document.createElement('button');
        panel.append(costsSection, build);
        document.body.appendChild(panel);

        await houseCostDisplay.addCompactToLevel(costsSection, '/house_rooms/mystical_study', 5);

        const section = panel.querySelector('.mwi-house-to-level');
        expect(panel.lastElementChild).toBe(section);
        expect(build.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});

describe('the materials list has no scroller of its own', () => {
    // One scroller now: the game's dialog (`Modal_modalContent`, bounded by
    // SCROLLER_MAX_HEIGHT). A second bound on the list here would recreate the
    // nested-scrollbar bug this replaces, so this asserts the bound is gone
    // rather than merely that a new one looks right.
    test('the list carries no inline max-height or overflow', async () => {
        const section = await render();
        const list = section.querySelector('.mwi-cumulative-materials-list');

        expect(list).toBeTruthy();
        expect(list.style.maxHeight).toBe('');
        expect(list.style.overflowY).toBe('');
        expect(list.style.overscrollBehavior).toBe('');
    });

    test('the section itself does not claim to scroll without a bound', async () => {
        const section = await render();
        // It has no max-height and no height-constraining ancestor, so an
        // `overflow-y` here would be inert and misleading.
        expect(section.style.overflowY).toBe('');
    });
});

describe('house material hints and reservations', () => {
    test('the shortage uses stock left after another plan claims part of the stack', () => {
        const material = MATERIALS[0];
        inventoryState.items = [
            {
                itemHrid: material.itemHrid,
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 0,
                count: material.count,
            },
        ];
        inventoryState.reserved.set(`${material.itemHrid}:0`, 400);

        expect(houseCostDisplay.getMissingMaterials({ materials: [material] })).toEqual([
            {
                itemHrid: material.itemHrid,
                itemName: 'Mat 0',
                required: material.count,
                missing: 400,
                isTradeable: true,
            },
        ]);

        const row = document.createElement('div');
        houseCostDisplay.appendMaterialRow(row, material);
        expect(row.textContent).toContain('600 / 1,000');
        expect(row.textContent).toContain('Missing: 400');
    });
});

describe('market quote refresh', () => {
    test('updates rendered prices when market quotes change and unregisters on disable', async () => {
        houseCostDisplay.initialize();
        const modalContent = document.createElement('div');
        const costsSection = document.createElement('div');
        modalContent.className = 'HousePanel_modalContent__test';
        costsSection.className = 'HousePanel_costs__test';
        modalContent.appendChild(costsSection);
        document.body.appendChild(modalContent);
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        const materialsList = modalContent.querySelector('.mwi-cumulative-materials-list');
        expect(materialsList.textContent).toContain('@ 10 = 10K');
        expect(materialsList.textContent).toContain('Missing: 1,000');
        expect(modalContent.textContent).toContain('Total Market Value: 145K');

        inventoryState.unitPrice = 20;
        await inventoryState.notifyMarketUpdate();
        const updatedList = modalContent.querySelector('.mwi-cumulative-materials-list');
        expect(updatedList.textContent).toContain('@ 20 = 20K');
        expect(updatedList.textContent).toContain('Missing: 1,000');
        expect(modalContent.textContent).toContain('Total Market Value: 285K');
        expect(inventoryState.marketListeners).toHaveLength(1);

        houseCostDisplay.disable();
        expect(inventoryState.marketListeners).toHaveLength(0);
    });
});

describe('inventory refresh', () => {
    test('updates the visible shortage and retains the selected cumulative target', async () => {
        houseCostDisplay.initialize();
        const modalContent = document.createElement('div');
        const costsSection = document.createElement('div');
        costsSection.className = 'HousePanel_costs__test';
        modalContent.appendChild(costsSection);
        document.body.appendChild(modalContent);
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        const dropdown = modalContent.querySelector('select');
        dropdown.value = '7';
        dropdown.dispatchEvent(new Event('change'));
        await Promise.resolve();
        expect(houseCostDisplay._costContext.targetLevel).toBe(7);
        const material = MATERIALS[0];
        inventoryState.items = [
            {
                itemHrid: material.itemHrid,
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 0,
                count: 400,
            },
        ];

        await houseCostDisplay._itemsUpdatedHandler();

        const updatedList = modalContent.querySelector('.mwi-cumulative-materials-list');
        expect(updatedList.textContent).toContain('400 / 1,000');
        expect(updatedList.textContent).toContain('Missing: 600');
        expect(modalContent.querySelector('select').value).toBe('7');

        houseCostDisplay.disable();
    });
});

describe('overlapping room modal refreshes', () => {
    test('a stale render cannot append an empty section or replace the current state', async () => {
        houseCostDisplay.initialize();
        const modalContent = document.createElement('div');
        const costsSection = document.createElement('div');
        modalContent.className = 'HousePanel_modalContent__test';
        costsSection.className = 'HousePanel_costs__test';
        modalContent.appendChild(costsSection);
        document.body.appendChild(modalContent);
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        const older = deferred();
        const newer = deferred();
        inventoryState.deferredCosts.push(older, newer);

        // These model the real items_updated and house_rooms_updated paths.
        const inventoryRefresh = houseCostDisplay._itemsUpdatedHandler();
        const roomRefresh = houseCostDisplay._houseRoomsUpdatedHandler();

        newer.resolve({ coins: 5000, materials: MATERIALS, totalValue: 2222 });
        await roomRefresh;
        const currentDropdown = modalContent.querySelector('select');
        expect(modalContent.querySelectorAll('.mwi-house-to-level')).toHaveLength(1);
        expect(houseCostDisplay._cumulativeState.dropdown).toBe(currentDropdown);
        expect(modalContent.textContent).toContain('Total Market Value: 2,222');

        older.resolve({ coins: 5000, materials: MATERIALS, totalValue: 1111 });
        await inventoryRefresh;

        expect(modalContent.querySelectorAll('.mwi-house-to-level')).toHaveLength(1);
        expect(modalContent.querySelector('select')).toBe(currentDropdown);
        expect(houseCostDisplay._cumulativeState.dropdown).toBe(currentDropdown);
        expect(houseCostDisplay._costContext).toEqual({
            houseRoomHrid: '/house_rooms/mystical_study',
            currentLevel: 5,
            targetLevel: 6,
        });
        expect(modalContent.textContent).toContain('Total Market Value: 2,222');
        expect(modalContent.textContent).not.toContain('Total Market Value: 1,111');

        houseCostDisplay.disable();
    });
});

describe('the section holds its own height inside the panel flex column', () => {
    // What this can and cannot show: happy-dom does no layout, so none of these
    // assert that anything actually fits, scrolls or is reachable — only that
    // the two declarations the browser needs are both present and that the
    // game-element rule is scoped so it undoes itself. Whether the resulting
    // layout is right was settled in a real browser against a reproduction of
    // the game's box structure, not here.

    // The module is a singleton that remembers it has been initialized, so each
    // test starts it from a known stopped state rather than inheriting the last.
    beforeEach(() => {
        houseCostDisplay.disable();
    });

    test('the section refuses to be shrunk below its contents', async () => {
        const section = await render();
        expect(section.style.flexShrink).toBe('0');
        // The declaration this replaced. `min-height: 0` invited the flex line
        // to squeeze the section past its own bounded list, which put the list,
        // the total and the button outside the section's border.
        expect(section.style.minHeight).toBe('');
    });

    test('the section has no bottom padding, border or radius, so the sticky footer sits flush', async () => {
        const section = await render();
        // See SCROLLER_PADDING_BOTTOM_FALLBACK: anything below a `position:
        // sticky; bottom: 0` element inside its scroller makes it travel at
        // the end of the scroll. Top and side padding/border/radius, which
        // give the section its own frame, are unchanged.
        expect(section.style.paddingBottom).toBe('0px');
        expect(section.style.paddingTop).toBe('8px');
        expect(section.style.borderBottomStyle).toBe('none');
        expect(section.style.borderTopStyle).toBe('solid');
        expect(section.style.borderBottomLeftRadius).toBe('0px');
        expect(section.style.borderTopLeftRadius).toBe('8px');
    });

    test('the panel is allowed to grow, so nothing else has to shrink', () => {
        houseCostDisplay.initialize();
        const sheet = document.getElementById('toolasha-house-panel-layout');

        expect(sheet).toBeTruthy();
        expect(sheet.textContent).toContain('HousePanel_modalContent');
        // `min-height` outranks a height or a max-height at used-value time, so
        // this holds however the panel was being clamped. Without it, a section
        // that will not shrink hands the whole deficit to the game's Build
        // button, which collapses to 0px.
        expect(sheet.textContent).toContain('min-height: fit-content');
    });

    test('the panel drops the game percentage height, so the capped scroller cannot clamp it', () => {
        houseCostDisplay.initialize();
        const sheet = document.getElementById('toolasha-house-panel-layout').textContent;
        // Firefox and WebKit resolve the game's `height: 100%` against the
        // scroller once SCROLLER_MAX_HEIGHT caps it, and `min-height:
        // fit-content` does not lift it there: the Build button took the whole
        // deficit and measured 0px on a phone-sized dialog. Both declarations
        // must sit in the panel rule, not the scroller rule.
        const selector = '[class*="HousePanel_modalContent"]:has(.mwi-house-to-level)';
        const start = sheet.indexOf(selector);
        expect(start).toBeGreaterThanOrEqual(0);
        const body = sheet.slice(sheet.indexOf('{', start) + 1, sheet.indexOf('}', start));
        const declarations = body.split(';').map((d) => d.trim());
        expect(declarations).toContain('height: auto');
        expect(declarations).toContain('min-height: fit-content');
    });

    test('the panel rule is scoped to panels this file has drawn into', () => {
        houseCostDisplay.initialize();
        const sheet = document.getElementById('toolasha-house-panel-layout');

        // This is the undo. No house panel without our section matches, so a
        // room switch, a removed column or a renamed game class all restore the
        // game's own layout with nothing to remember.
        expect(sheet.textContent).toContain(':has(.mwi-house-to-level)');
    });

    test('disabling the feature takes the stylesheet back out', () => {
        houseCostDisplay.initialize();
        expect(document.getElementById('toolasha-house-panel-layout')).toBeTruthy();

        houseCostDisplay.disable();
        expect(document.getElementById('toolasha-house-panel-layout')).toBeNull();
    });
});

describe('the panel min-height fallback on browsers without :has()', () => {
    // What this can and cannot show: happy-dom does no layout, so nothing here
    // proves the Build button survives — only that the declaration a browser
    // would need is set on exactly the browsers whose stylesheet rule was
    // dropped, and taken off again on teardown. That the value is the right one
    // was settled in a real browser against a reproduction of the game's box
    // structure, with `:has()` simulated away.

    /** Make `CSS.supports('selector(:has(*))')` answer `answer` */
    function withHasSupport(answer) {
        vi.stubGlobal('CSS', { supports: () => answer });
    }

    /** Make the whole support probe throw, the way a hostile shim would */
    function withThrowingSupports() {
        vi.stubGlobal('CSS', {
            supports: () => {
                throw new Error('nope');
            },
        });
    }

    /** The game's boxes: HousePanel_modalContent wrapping HousePanel_costs */
    function buildPanel() {
        const modalContent = document.createElement('div');
        modalContent.className = 'HousePanel_modalContent__abc123';
        const costsSection = document.createElement('div');
        costsSection.className = 'HousePanel_costs__def456';
        modalContent.appendChild(costsSection);
        document.body.appendChild(modalContent);
        return { modalContent, costsSection };
    }

    beforeEach(() => {
        houseCostDisplay.disable();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('sets the panel min-height when :has() is unsupported', async () => {
        withHasSupport(false);
        const { modalContent, costsSection } = buildPanel();

        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        expect(modalContent.querySelector('.mwi-house-to-level')).toBeTruthy();
        // The stylesheet rule was dropped whole, so `flex-shrink: 0` on the
        // section would otherwise hand the entire deficit to the game's Build
        // button. This is the same value the rule would have set.
        expect(modalContent.style.minHeight).toContain('fit-content');
        // The rule's `height: auto` goes with it — see PANEL_HEIGHT.
        expect(modalContent.style.height).toBe('auto');
    });

    test('leaves the panel alone when :has() is supported', async () => {
        withHasSupport(true);
        const { modalContent, costsSection } = buildPanel();

        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        expect(modalContent.querySelector('.mwi-house-to-level')).toBeTruthy();
        // The sheet is doing the job. An inline style here would be a second
        // opinion on the same property with no way to be overruled.
        expect(modalContent.style.minHeight).toBe('');
        expect(modalContent.style.height).toBe('');
    });

    test('treats a throwing or absent CSS.supports as unsupported', async () => {
        withThrowingSupports();
        const first = buildPanel();
        await houseCostDisplay.addCostColumn(first.costsSection, '/house_rooms/mystical_study', first.modalContent);
        expect(first.modalContent.style.minHeight).toContain('fit-content');

        houseCostDisplay.disable();
        vi.stubGlobal('CSS', undefined);
        const second = buildPanel();
        await houseCostDisplay.addCostColumn(second.costsSection, '/house_rooms/mystical_study', second.modalContent);
        // Failing this way costs one inline style on a browser that did not
        // need it; failing the other way costs the Build button.
        expect(second.modalContent.style.minHeight).toContain('fit-content');
    });

    test('tearing the section down clears it', async () => {
        withHasSupport(false);
        const { modalContent, costsSection } = buildPanel();
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);
        expect(modalContent.style.minHeight).toContain('fit-content');

        // A room switch: the same panel redrawn for another room removes the
        // old section first. An inline style has no `:has()` to stop matching.
        houseCostDisplay.removeExistingColumn(modalContent);

        expect(modalContent.querySelector('.mwi-house-to-level')).toBeNull();
        expect(modalContent.style.minHeight).toBe('');
        expect(modalContent.style.height).toBe('');
    });

    test('disabling the feature clears it', async () => {
        withHasSupport(false);
        const { modalContent, costsSection } = buildPanel();
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);
        expect(modalContent.style.minHeight).toContain('fit-content');

        houseCostDisplay.disable();

        expect(modalContent.style.minHeight).toBe('');
        expect(modalContent.style.height).toBe('');
    });

    test('does not clear a min-height the game set itself', () => {
        const { modalContent } = buildPanel();
        modalContent.style.minHeight = '320px';

        houseCostDisplay.removeExistingColumn(modalContent);

        expect(modalContent.style.minHeight).toBe('320px');
    });

    test('does not clear a height the game set itself', () => {
        const { modalContent } = buildPanel();
        modalContent.style.height = '100%';

        houseCostDisplay.removeExistingColumn(modalContent);

        expect(modalContent.style.height).toBe('100%');
    });
});

describe('the scroller max-height fallback on browsers without :has()', () => {
    // What this can and cannot show: happy-dom does no layout, so nothing here
    // proves Firefox's scroller actually stays inside the frame — only that the
    // declarations a browser would need are set on exactly the ancestor whose
    // stylesheet rule was dropped, and taken off again on teardown. That the
    // values are the right ones was settled in a real browser (Firefox,
    // Chromium, WebKit) against a reproduction of the game's box structure,
    // with `:has()` simulated away.

    /** Make `CSS.supports('selector(:has(*))')` answer `answer` */
    function withHasSupport(answer) {
        vi.stubGlobal('CSS', { supports: () => answer });
    }

    /**
     * The game's full box structure between the section and the scroller:
     * Modal_modalContent (the game's scroller) wrapping HousePanel_modalContent
     * wrapping HousePanel_costs. `buildPanel()` above omits the outer scroller
     * entirely, which is fine for the min-height fallback (scoped to
     * HousePanel_modalContent itself) but leaves nothing for this fallback's
     * `closest('[class*="Modal_modalContent"]')` to find.
     */
    function buildNestedPanel() {
        const scroller = document.createElement('div');
        scroller.className = 'Modal_modalContent__xyz789';
        const modalContent = document.createElement('div');
        modalContent.className = 'HousePanel_modalContent__abc123';
        const costsSection = document.createElement('div');
        costsSection.className = 'HousePanel_costs__def456';
        modalContent.appendChild(costsSection);
        scroller.appendChild(modalContent);
        document.body.appendChild(scroller);
        return { scroller, modalContent, costsSection };
    }

    beforeEach(() => {
        houseCostDisplay.disable();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('caps the game scroller when :has() is unsupported', async () => {
        withHasSupport(false);
        const { scroller, modalContent, costsSection } = buildNestedPanel();

        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        // The stylesheet rule was dropped whole, so without this the scroller
        // has nothing capping it to the frame in Firefox.
        expect(scroller.style.maxHeight).toContain('--toolasha-visual-viewport-height');
        expect(scroller.style.maxHeight).toContain('100vh'); // fallback for no visualViewport
        expect(scroller.style.boxSizing).toBe('border-box');
    });

    test('leaves the scroller alone when :has() is supported', async () => {
        withHasSupport(true);
        const { scroller, modalContent, costsSection } = buildNestedPanel();

        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        // The sheet is doing the job. An inline style here would be a second
        // opinion on the same properties with no way to be overruled.
        expect(scroller.style.maxHeight).toBe('');
        expect(scroller.style.boxSizing).toBe('');
    });

    test('tearing the section down clears it', async () => {
        withHasSupport(false);
        const { scroller, modalContent, costsSection } = buildNestedPanel();
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);
        expect(scroller.style.maxHeight).not.toBe('');

        // A room switch: the same panel redrawn for another room removes the
        // old section first. An inline style has no `:has()` to stop matching.
        houseCostDisplay.removeExistingColumn(modalContent);

        expect(scroller.style.maxHeight).toBe('');
        expect(scroller.style.boxSizing).toBe('');
    });

    test('disabling the feature clears it', async () => {
        withHasSupport(false);
        const { scroller, modalContent, costsSection } = buildNestedPanel();
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);
        expect(scroller.style.maxHeight).not.toBe('');

        houseCostDisplay.disable();

        expect(scroller.style.maxHeight).toBe('');
        expect(scroller.style.boxSizing).toBe('');
    });

    test('does not clear a max-height or box-sizing the game set itself', () => {
        const { scroller, modalContent } = buildNestedPanel();
        scroller.style.maxHeight = '640px';
        scroller.style.boxSizing = 'content-box';

        houseCostDisplay.removeExistingColumn(modalContent);

        expect(scroller.style.maxHeight).toBe('640px');
        expect(scroller.style.boxSizing).toBe('content-box');
    });

    // Same fallback function, one more property: a sticky `bottom: 0` footer
    // pins to its scroller's padding edge, so the scroller's own end padding
    // makes it travel at the end of the scroll just as surely as an unbounded
    // max-height does. See SCROLLER_PADDING_BOTTOM_FALLBACK.
    test('caps the scroller end padding when :has() is unsupported', async () => {
        withHasSupport(false);
        const { scroller, modalContent, costsSection } = buildNestedPanel();

        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        expect(scroller.style.paddingBottom).toBe('0px');
    });

    test('leaves the scroller end padding alone when :has() is supported', async () => {
        withHasSupport(true);
        const { scroller, modalContent, costsSection } = buildNestedPanel();

        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        // The sheet's own `padding-bottom: 0` is doing the job.
        expect(scroller.style.paddingBottom).toBe('');
    });

    test('tearing the section down clears the padding fallback', async () => {
        withHasSupport(false);
        const { scroller, modalContent, costsSection } = buildNestedPanel();
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);
        expect(scroller.style.paddingBottom).toBe('0px');

        houseCostDisplay.removeExistingColumn(modalContent);

        expect(scroller.style.paddingBottom).toBe('');
    });

    test('disabling the feature clears the padding fallback', async () => {
        withHasSupport(false);
        const { scroller, modalContent, costsSection } = buildNestedPanel();
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);
        expect(scroller.style.paddingBottom).toBe('0px');

        houseCostDisplay.disable();

        expect(scroller.style.paddingBottom).toBe('');
    });

    test('does not clear a padding-bottom the game set itself', () => {
        const { scroller, modalContent } = buildNestedPanel();
        scroller.style.paddingBottom = '24px';

        houseCostDisplay.removeExistingColumn(modalContent);

        expect(scroller.style.paddingBottom).toBe('24px');
    });
});

describe('Missing Mats Marketplace button placement', () => {
    test('the button lives in the pinned footer, not inside the list', async () => {
        const section = await render();
        const list = section.querySelector('.mwi-cumulative-materials-list');
        const footer = section.querySelector('.mwi-cumulative-footer');
        const button = [...section.querySelectorAll('button')].find(
            (b) => b.textContent === 'Missing Mats Marketplace'
        );

        expect(button).toBeTruthy();
        expect(list.contains(button)).toBe(false);
        expect(footer).toBeTruthy();
        expect(footer.contains(button)).toBe(true);
    });

    test('rows are followed by one footer holding the total and the button', async () => {
        const section = await render();
        const container = section.querySelector('.mwi-cumulative-cost-container');
        const children = [...container.children];

        expect(children[0].className).toBe('mwi-cumulative-materials-list');
        expect(children[1].className).toBe('mwi-cumulative-footer');
        expect(children[1].textContent).toContain('Total Market Value');
        expect(children[1].textContent).toContain('Missing Mats Marketplace');
        // Coins plus every material
        expect(children[0].children.length).toBe(MATERIALS.length + 1);
    });
});

describe('the footer is pinned to the bottom of the single scroller', () => {
    // happy-dom does no layout, so this cannot show the footer actually stays
    // visible — that was checked in real browsers against a reproduction. What
    // is assertable here is the sticky-positioning contract.
    //
    // The footer's opaque background is not asserted here: it is set as
    // `background: var(--color-midnight-900, #0a0a12)`, and happy-dom's
    // CSSStyleDeclaration rejects `var()` as a color value outright — it drops
    // the whole declaration rather than keeping the string, the same way it
    // drops `color: var(...)` — so `style.background` reads back empty
    // regardless of whether the source sets it. That the background is opaque
    // and not the section's translucent `rgba(0, 0, 0, 0.3)` was checked in a
    // real browser, not here.
    test('the footer is sticky and pinned to the bottom, above the rows', async () => {
        const section = await render();
        const footer = section.querySelector('.mwi-cumulative-footer');

        expect(footer.style.position).toBe('sticky');
        expect(footer.style.bottom).toBe('0px');
        expect(footer.style.zIndex).toBe('1');
    });
});

describe('the list has no scroll position of its own to carry across a redraw', () => {
    // Superseded by the single-scroller change: the list no longer scrolls on
    // its own, so it has no scrollTop worth carrying, and the fragment
    // clear+append is synchronous with no layout in between — so the dialog's
    // own scrollTop (the one real scroller now) is never touched by a rebuild.
    // This replaces the old "keeps its place" tests, which asserted a
    // scrollTop carry-over onto the list that no longer exists.
    test('a redraw does not put a scroll position on the rebuilt list', async () => {
        const section = await render();
        const container = section.querySelector('.mwi-cumulative-cost-container');
        const before = container.querySelector('.mwi-cumulative-materials-list');

        // What an `items_updated` does — the same call the handler makes
        await houseCostDisplay.updateCompactCumulativeDisplay(container, '/house_rooms/mystical_study', 5, 8);

        const after = container.querySelector('.mwi-cumulative-materials-list');
        expect(after).not.toBe(before); // genuinely rebuilt, not reused
        expect(after.scrollTop).toBe(0);
    });
});
