/** @vitest-environment happy-dom
 *
 * The house modal's room-switch watcher must not re-render on its own writes.
 *
 * The watcher sits on `HousePanel_modalContent`, which is an ancestor of the
 * room header. `addCostColumn()` removes and re-appends our `.mwi-house-to-level`
 * section directly under that same element, so every refresh used to look like
 * a room switch, which called `addCostColumn()` again, forever. Mutation
 * callbacks are microtasks, so the loop never yielded and the tab ran out of
 * memory. Opening a room to upgrade it was enough to start it.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const bus = vi.hoisted(() => ({ handlers: {} }));
const game = vi.hoisted(() => ({
    rooms: {
        '/house_rooms/dairy_barn': { name: 'Dairy Barn' },
        '/house_rooms/garden': { name: 'Garden' },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            bus.handlers[event] = (bus.handlers[event] || []).filter((entry) => entry !== handler);
        },
        emit: (event, payload) => {
            for (const handler of [...(bus.handlers[event] || [])]) handler(payload);
        },
        getInitClientData: () => ({ houseRoomDetailMap: game.rooms }),
        getCurrentCharacterId: () => 'char-1',
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => {},
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: (_name, callback) => {
            callback();
            return () => {};
        },
    },
}));

vi.mock('../../utils/marketplace-tabs.js', () => ({
    createMaterialTab: () => null,
    createClearAllTabsControl: () => null,
    removeMaterialTabs: () => {},
    setupMarketplaceCleanupObserver: () => () => {},
    navigateToMarketplace: () => {},
    navigateToMarketListingsTab: () => {},
    visibleTabsContainer: () => null,
    attachRegularTabClearListener: () => {},
}));

vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({
        initialize: () => {},
        cleanup: () => {},
        clearQuantity: () => {},
        setQuantity: () => {},
    }),
}));

vi.mock('../../utils/house-cost-calculator.js', () => ({
    initialize: async () => {},
    calculateUpgradeCost: () => null,
    getCumulativeCost: () => null,
}));

const housePanelObserver = (await import('./house-panel-observer.js')).default;
const houseCostDisplay = (await import('./house-cost-display.js')).default;

const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** The game's shape: header and costs are siblings inside the modal content */
function buildPanel(roomName) {
    const modalContent = document.createElement('div');
    modalContent.className = 'HousePanel_modalContent__abc123';
    const header = document.createElement('div');
    header.className = 'HousePanel_header__h1';
    header.textContent = roomName;
    const costs = document.createElement('div');
    costs.className = 'HousePanel_costs__def456';
    modalContent.append(header, costs);
    document.body.appendChild(modalContent);
    return { modalContent, header, costs };
}

describe('house modal watcher does not re-render on its own writes', () => {
    let calls;

    beforeEach(async () => {
        bus.handlers = {};
        document.body.innerHTML = '';
        calls = 0;
        await housePanelObserver.initialize();
        // The real render's DOM effect: remove our section, build it again
        // under the costs' parent (the modal content), after one await.
        vi.spyOn(houseCostDisplay, 'addCostColumn').mockImplementation(async (costsSection, hrid, modalContent) => {
            calls++;
            // What the real render records so the refresh listeners can find the room
            houseCostDisplay.currentModalContent = modalContent;
            houseCostDisplay._costContext = { houseRoomHrid: hrid };
            if (calls > 50) throw new Error('addCostColumn is looping');
            houseCostDisplay.removeExistingColumn(modalContent);
            await Promise.resolve();
            const section = document.createElement('div');
            section.className = 'mwi-house-to-level';
            section.appendChild(document.createElement('span'));
            costsSection.parentElement.appendChild(section);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        housePanelObserver.disable();
        houseCostDisplay.disable();
    });

    async function openPanel(roomName) {
        const panel = buildPanel(roomName);
        panel.modalContent.classList.add('open');
        // Same thing the dom-observer callback does after its settle delay
        const done = housePanelObserver.handleHouseModal(panel.modalContent);
        await vi.waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 2000 });
        await done;
        await flush();
        return panel;
    }

    test('an inventory update refreshes the open room once, not forever', async () => {
        const { modalContent } = await openPanel('Dairy Barn');
        const before = calls;

        bus.handlers.items_updated.forEach((handler) => handler());
        await flush();

        expect(calls - before).toBeLessThanOrEqual(2);
        expect(calls - before).toBeGreaterThanOrEqual(1);
        expect(modalContent.querySelectorAll('.mwi-house-to-level')).toHaveLength(1);
    });

    test('a native same-room re-render that drops our column restores it, once', async () => {
        const { modalContent, costs } = await openPanel('Dairy Barn');
        const before = calls;

        // The game replaces the room's children without changing the room
        modalContent.querySelector('.mwi-house-to-level').remove();
        const fresh = costs.cloneNode(false);
        costs.replaceWith(fresh);
        await flush();

        expect(calls - before).toBeGreaterThanOrEqual(1);
        expect(calls - before).toBeLessThanOrEqual(2);
        expect(modalContent.querySelectorAll('.mwi-house-to-level')).toHaveLength(1);
    });

    test('a room switch inside the open modal still re-renders', async () => {
        const { modalContent, header } = await openPanel('Dairy Barn');
        const before = calls;

        header.textContent = 'Garden';
        await flush();

        expect(calls - before).toBeGreaterThanOrEqual(1);
        expect(calls - before).toBeLessThanOrEqual(2);
        expect(modalContent.querySelectorAll('.mwi-house-to-level')).toHaveLength(1);
    });
});
