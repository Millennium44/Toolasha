/**
 * Merge market listing updates into the current list.
 * @param {Array} currentListings - Existing market listings.
 * @param {Array} updatedListings - Updated listings from WebSocket.
 * @returns {Array} New merged listings array.
 */
export const mergeMarketListings = (currentListings = [], updatedListings = []) => {
    const safeCurrent = Array.isArray(currentListings) ? currentListings : [];
    const safeUpdates = Array.isArray(updatedListings) ? updatedListings : [];

    if (safeUpdates.length === 0) {
        return [...safeCurrent];
    }

    const indexById = new Map();
    safeCurrent.forEach((listing, index) => {
        if (!listing || listing.id === undefined || listing.id === null) {
            return;
        }
        indexById.set(listing.id, index);
    });

    const merged = [...safeCurrent];

    for (const listing of safeUpdates) {
        if (!listing || listing.id === undefined || listing.id === null) {
            continue;
        }

        const existingIndex = indexById.get(listing.id);
        if (existingIndex !== undefined) {
            merged[existingIndex] = listing;
        } else {
            merged.push(listing);
        }
    }

    // Remove dead listings. A listing that has ended still belongs in the book
    // while it is holding something for you: a filled order holds its proceeds,
    // and a cancelled one holds the refund — coins for a buy, the unsold items
    // for a sell. Both are a click away from being yours and both are what the
    // sidebar badge is legitimately for, so dropping them on arrival made a
    // refund structurally invisible. They go once there is nothing left to
    // claim. Expiries carry nothing back and go immediately.
    return merged.filter((listing) => {
        if (!listing) return false;
        if (listing.status === '/market_listing_status/expired') {
            return false;
        }
        if (
            (listing.status === '/market_listing_status/cancelled' ||
                listing.status === '/market_listing_status/filled') &&
            (listing.unclaimedItemCount || 0) === 0 &&
            (listing.unclaimedCoinCount || 0) === 0
        ) {
            return false;
        }
        return true;
    });
};
