/** Presentation-only rules shared by the marketplace additions. Native tables and buttons stay intact. */
export const MARKET_MOBILE_QUERY = '(max-width: 768px)';

const STYLE_ID = 'mwi-market-mobile-layout';
const SCROLL_ATTR = 'data-mwi-listing-scroll';
const COLUMN_CELLS = '.mwi-enh-profit-cell, .mwi-estimated-age-cell, .mwi-listing-price-cell';

/** Install the rules once. They match only nodes owned by these features. */
export function ensureMarketMobileStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .mwi-market-pricing-disclosure { display: none; }
        #mwi-market-pricing-fields { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; }
        @media ${MARKET_MOBILE_QUERY} {
            #mwi-market-pricing-controls { margin-left: 0 !important; flex: 1 1 100%; min-width: 0; }
            .mwi-market-pricing-disclosure {
                display: block; box-sizing: border-box; min-height: 44px; width: 100%;
                padding: 8px; color: inherit; background: transparent; border: 1px solid #666;
                border-radius: 4px; font: 14px/1.3 sans-serif; text-align: left; cursor: pointer;
            }
            #mwi-market-pricing-fields { width: 100%; min-width: 0; gap: 6px; }
            #mwi-market-pricing-controls:not([data-expanded]) #mwi-market-pricing-fields { display: none; }
            #mwi-market-pricing-fields > select, #mwi-market-pricing-fields > button {
                box-sizing: border-box; flex: 1 1 130px; min-width: 0; max-width: 100%;
                min-height: 44px; padding: 6px !important; font-size: 16px !important;
            }
            [${SCROLL_ATTR}] { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }
            [${SCROLL_ATTR}] > table { width: max-content; min-width: 100%; }
            .mwi-market-order-totals {
                flex-wrap: wrap; justify-content: flex-end !important; min-width: 0;
                max-width: var(--mwi-market-header-width, 100%);
                gap: 0 6px !important; font-size: 11px !important; line-height: 1.2;
                margin-top: 0 !important; padding: 0 !important;
            }
            .mwi-market-order-totals > div { white-space: nowrap; }
            .mwi-volume-stats-mobile-host {
                box-sizing: border-box; width: 100%; min-width: 0; flex: 0 0 auto;
                grid-column: 1 / -1; margin: 6px 0;
            }
            .mwi-volume-stats-mobile-host .mwi-volume-stats {
                position: static !important; margin-left: 0 !important; transform: none !important;
                box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0;
            }
            .mwi-volume-stats-mobile-host .mwi-volume-stats-table-scroll {
                overflow-x: auto; max-width: 100%; -webkit-overflow-scrolling: touch;
            }
            .mwi-volume-stats-mobile-host .mwi-volume-stats-gear {
                position: static !important; display: block; min-width: 44px; min-height: 44px;
            }
            .mwi-volume-stats-mobile-host .mwi-volume-stats-menu {
                position: static !important; min-width: 0 !important; max-width: 100%;
            }
            .mwi-volume-stats-mobile-host .mwi-volume-stats-menu label,
            .mwi-volume-stats-mobile-host .mwi-volume-stats-menu button { min-height: 44px; }
        }
    `;
    document.head.appendChild(style);
}

/** Remove the shared rules only when the last owning UI has gone away. */
export function releaseMarketMobileStyles() {
    const owned = document.querySelector(
        `#mwi-market-pricing-controls, .mwi-market-order-totals, .mwi-volume-stats, [${SCROLL_ATTR}]`
    );
    if (!owned) {
        document.getElementById(STYLE_ID)?.remove();
    }
}

/**
 * Let a listings table that carries Toolasha columns scroll sideways on phones.
 * The game's single row and its native buttons stay as they are; the table's own
 * container gets the overflow. The marker is inert above the phone breakpoint.
 * Safe to call after every repaint: it writes only when the state changes.
 * @param {HTMLTableElement} table
 */
export function syncListingScroll(table) {
    const host = table?.parentElement;
    if (!host) return;
    if (table.querySelector(COLUMN_CELLS)) {
        ensureMarketMobileStyles();
        if (!host.hasAttribute(SCROLL_ATTR)) host.setAttribute(SCROLL_ATTR, '');
    } else {
        releaseListingScroll(host);
    }
}

/**
 * Drop the scroll marker from every container under root (or root itself) that no
 * longer holds a Toolasha column, then release the shared rules if nothing else owns them.
 * Call after the feature's cells are removed.
 * @param {ParentNode & Element} root
 */
export function releaseListingScroll(root) {
    const hosts = [...root.querySelectorAll(`[${SCROLL_ATTR}]`)];
    if (root.hasAttribute?.(SCROLL_ATTR)) hosts.push(root);
    for (const host of hosts) {
        if (!host.querySelector(COLUMN_CELLS)) host.removeAttribute(SCROLL_ATTR);
    }
    releaseMarketMobileStyles();
}
