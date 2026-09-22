/** @vitest-environment happy-dom
 *
 * A character switch tearing the feature down while initialize() is parked on
 * the saved listing-order read. The interrupted initializer must not register
 * observers after cleanup has already run.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const world = vi.hoisted(() => ({
    characterId: 'char1',
    gate: null,
}));

const registrations = vi.hoisted(() => ({ live: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
        getMarketListings: () => [],
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name) => {
            registrations.live.push(name);
            return () => {
                const index = registrations.live.indexOf(name);
                if (index !== -1) registrations.live.splice(index, 1);
            };
        },
        onReady: (name) => {
            registrations.live.push(name);
            return () => {
                const index = registrations.live.indexOf(name);
                if (index !== -1) registrations.live.splice(index, 1);
            };
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async () => {
            if (world.gate) await world.gate;
            return [];
        },
        set: async () => true,
    },
}));
vi.mock('../../utils/dom.js', () => ({ addStyles: vi.fn(), removeStyles: vi.fn() }));
vi.mock('./listing-price-display.js', () => ({
    default: { extractRowInfo: () => ({}) },
}));

const { default: listingDragOrder } = await import('./listing-drag-order.js');

describe('a character switch landing inside the saved listing-order read', () => {
    beforeEach(() => {
        listingDragOrder.cleanup();
        world.characterId = 'char1';
        world.gate = null;
        registrations.live = [];
    });

    afterEach(() => listingDragOrder.cleanup());

    async function switchDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = listingDragOrder.initialize();
        listingDragOrder.cleanup();
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initializer leaves no observer behind', async () => {
        await switchDuringInitialize();

        expect(registrations.live).toEqual([]);
        expect(listingDragOrder.isInitialized).toBe(false);
    });

    test('only the arriving character owns the observers after reinitialization', async () => {
        await switchDuringInitialize();
        await listingDragOrder.initialize();

        expect(registrations.live).toEqual(['ListingDragOrder', 'ListingDragOrderCatchUp']);
        expect(listingDragOrder.storageKey).toBe('marketListingDragOrder_char2');

        listingDragOrder.cleanup();
        expect(registrations.live).toEqual([]);
    });
});
