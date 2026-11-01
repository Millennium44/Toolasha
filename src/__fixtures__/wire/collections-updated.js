/**
 * `collections_updated`. Captured on the test server, 2026-10-31/11-01.
 * A DELTA: the game's `handleMessageCollectionsUpdated` merges `collections` into the
 * existing list by `itemHrid`. An uncollected item is absent.
 */

export function buildCollectionRow(overrides = {}) {
    return { characterID: 900001, itemHrid: '/items/umbral_hood', count: 331, enhancementData: '{}', ...overrides };
}

export function buildCollectionsUpdated(rows = [buildCollectionRow()], overrides = {}) {
    return { type: 'collections_updated', collections: rows, ...overrides };
}
