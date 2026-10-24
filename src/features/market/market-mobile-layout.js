/** Presentation-only rules shared by the marketplace additions. Native tables and buttons stay intact. */
export const MARKET_MOBILE_QUERY = '(max-width: 768px)';

const STYLE_ID = 'mwi-market-mobile-layout';

/** Install the rules once. They match only nodes owned by these features. */
export function ensureMarketMobileStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .mwi-market-pricing-disclosure, .mwi-market-mobile-note, .mwi-my-listings-columns-toggle { display: none; }
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
            .mwi-market-mobile-note {
                display: block; font-size: 11px; line-height: 1.25; white-space: normal;
                overflow-wrap: anywhere; margin-top: 3px;
            }
            .mwi-market-mobile-note::before { content: attr(data-label); display: block; color: #aaa; }
            .mwi-market-mobile-note::after { content: attr(data-value); }
            table[data-mwi-mobile-mwi-enh-profit-cell] .mwi-enh-profit-header,
            table[data-mwi-mobile-mwi-enh-profit-cell] .mwi-enh-profit-cell,
            table[data-mwi-mobile-mwi-estimated-age-cell] .mwi-estimated-age-header,
            table[data-mwi-mobile-mwi-estimated-age-cell] .mwi-estimated-age-cell { display: none; }
            table[data-mwi-mobile-mwi-listing-price-cell]:not([data-mwi-show-full-columns]) .mwi-listing-price-header,
            table[data-mwi-mobile-mwi-listing-price-cell]:not([data-mwi-show-full-columns]) .mwi-listing-price-cell { display: none; }
            table[data-mwi-show-full-columns] [data-mwi-mobile-column="mwi-listing-price-cell"] { display: none; }
            .mwi-my-listings-columns-toggle {
                display: block; min-height: 44px; max-width: 100%; margin: 4px 0;
                color: inherit; background: transparent; border: 1px solid #666; border-radius: 4px;
                padding: 6px 10px; font-size: 14px;
            }
            .mwi-market-order-totals {
                flex-wrap: wrap; justify-content: flex-end !important; min-width: 0;
                max-width: var(--mwi-market-header-width, 100%);
                gap: 0 6px !important; font-size: 11px !important; line-height: 1.2;
                margin-top: 0 !important; padding: 0 !important;
            }
            .mwi-market-order-totals > div { white-space: nowrap; }
            .mwi-volume-stats-mobile-host {
                box-sizing: border-box; width: 100%; min-width: 0; flex: 0 0 100%;
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
    if (
        !document.querySelector(
            '#mwi-market-pricing-controls, .mwi-market-mobile-note, .mwi-market-order-totals, .mwi-volume-stats'
        )
    ) {
        document.getElementById(STYLE_ID)?.remove();
    }
}

/**
 * Mirror an injected column below the native price on phones instead of widening the table.
 * Keep the price span itself untouched: several consumers parse its text as a number.
 * @param {HTMLTableElement} table
 * @param {string} cellClass
 * @param {string} label
 */
export function syncMobileListingNotes(table, cellClass, label) {
    ensureMarketMobileStyles();
    const notes = new Set(table.querySelectorAll(`[data-mwi-mobile-column="${cellClass}"]`));
    const marker = `data-mwi-mobile-${cellClass}`;
    const cells = [...table.querySelectorAll(`td.${cellClass}`)].filter(
        (cell) =>
            !cell.parentElement.matches('[class*="MarketplacePanel_outsideRangeSeparator"]') &&
            cell.textContent.trim() &&
            cell.textContent.trim() !== '· · ·'
    );
    if (
        !cells.length ||
        cells.some((cell) => !cell.parentElement.querySelector('[class*="MarketplacePanel_price"]')?.closest('td'))
    ) {
        notes.forEach((note) => note.remove());
        if (table.hasAttribute(marker)) table.removeAttribute(marker);
        return;
    }
    if (!table.hasAttribute(marker)) table.setAttribute(marker, '');
    for (const cell of cells) {
        const price = cell.parentElement.querySelector('[class*="MarketplacePanel_price"]')?.closest('td');
        if (!price || price === cell) continue;
        let note = price.querySelector(`[data-mwi-mobile-column="${cellClass}"]`);
        if (!note) {
            note = document.createElement('span');
            note.className = 'mwi-market-mobile-note';
            note.dataset.mwiMobileColumn = cellClass;
            note.setAttribute('role', 'note');
            price.appendChild(note);
        }
        notes.delete(note);
        // This helper runs from a childList observer's repaint path. Update only
        // changed attributes; never replace settled notes and retrigger that observer.
        const values = {
            title: cell.title,
            'data-label': label,
            'data-value': cell.textContent,
            'aria-label': `${label}: ${cell.textContent}`,
        };
        for (const [name, value] of Object.entries(values)) {
            if (note.getAttribute(name) !== value) note.setAttribute(name, value);
        }
        if (note.style.color !== cell.style.color) note.style.color = cell.style.color;
    }
    notes.forEach((note) => note.remove());
}

/** Remove one feature's mirrored values, leaving the other feature's notes alone. */
export function removeMobileListingNotes(root, cellClass) {
    root.querySelectorAll(`[data-mwi-mobile-column="${cellClass}"]`).forEach((note) => note.remove());
    root.querySelectorAll(`[data-mwi-mobile-${cellClass}]`).forEach((table) =>
        table.removeAttribute(`data-mwi-mobile-${cellClass}`)
    );
    root.removeAttribute?.(`data-mwi-mobile-${cellClass}`);
    releaseMarketMobileStyles();
}
