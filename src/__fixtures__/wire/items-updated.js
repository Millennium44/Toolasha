/**
 * `items_updated`. Captured on the test server (Golem Cave), 2026-11-01.
 * Rows are full inventory rows: `count` is the new total, not a delta. Item row ids are synthetic.
 */

const CAPTURED = {
    type: 'items_updated',
    endCharacterItems: [
        {
            id: 900101,
            characterID: 900001,
            itemLocationHrid: '/item_locations/inventory',
            itemHrid: '/items/star_fruit_gummy',
            enhancementLevel: 0,
            count: 9937145,
            offlineCount: 0,
            hash: '900001::/item_locations/inventory::/items/star_fruit_gummy::0',
            createdAt: '2026-08-05T19:50:54Z',
            updatedAt: '2026-11-01T22:39:37.685601407Z',
        },
    ],
};

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} An `items_updated` message (a fresh copy each call)
 */
export function buildItemsUpdated(overrides = {}) {
    return { ...structuredClone(CAPTURED), ...overrides };
}
