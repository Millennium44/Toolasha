/**
 * Market History Viewer Module
 *
 * Displays a comprehensive table of all market listings with:
 * - Sortable columns
 * - Search/filter functionality
 * - Pagination with user-configurable rows per page
 * - CSV export
 * - Summary statistics
 */

import storage from '../../core/storage.js';
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { formatWithSeparator, formatKMB, formatDateTime } from '../../utils/formatters.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { navigateToMarketplace, visibleTabsContainer } from '../../utils/marketplace-tabs.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import listingMarkers, { markerStateFor } from './listing-markers.js';

/** Rows here are finished trades, not working orders. Markers are told so. */
const HISTORY_SURFACE = { surface: 'history' };
import estimatedListingAge from './estimated-listing-age.js';

class MarketHistoryViewer {
    constructor() {
        this.isInitialized = false;
        this.modal = null;
        this.unsubscribeMarkers = null;
        this.listings = [];
        this.filteredListings = [];
        this.currentPage = 1;
        this.rowsPerPage = 50;
        this.showAll = false;
        this.sortColumn = 'createdTimestamp';
        this.sortDirection = 'desc'; // Most recent first
        this.searchTerm = '';
        this.typeFilter = 'all'; // 'all', 'buy', 'sell'
        this.statusFilter = 'all'; // 'all', 'active', 'filled', 'filled_active', 'canceled', 'expired', 'unknown'
        this.useKMBFormat = false; // K/M/B formatting toggle
        // Base of a per-character key; estimatedListingAge owns the scoping and
        // the split of the old shared array, so reads go through it
        this.storageKey = 'marketListingTimestamps';
        this.timerRegistry = createTimerRegistry();

        // Column filters
        this.filters = {
            dateFrom: null, // Date object or null
            dateTo: null, // Date object or null
            selectedItems: [], // Array of itemHrids
            selectedEnhLevels: [], // Array of enhancement levels (numbers)
            selectedTypes: [], // Array of 'buy' and/or 'sell'
        };
        this.activeFilterPopup = null; // Track currently open filter popup
        this.popupCloseHandler = null; // Track the close handler to clean it up properly

        // Marketplace tab tracking
        this.marketplaceTab = null;
        this.tabCleanupObserver = null;

        // Performance optimization: cache item names to avoid repeated lookups
        this.itemNameCache = new Map();
    }

    /**
     * Get the current items sprite URL from the DOM
     * @returns {string|null} Items sprite URL or null if not found
     */
    getItemsSpriteUrl() {
        const itemIcon = document.querySelector('use[href*="items_sprite"]');
        if (!itemIcon) {
            return null;
        }
        const href = itemIcon.getAttribute('href');
        return href ? href.split('#')[0] : null;
    }

    /**
     * Initialize the feature
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('market_showHistoryViewer')) {
            return;
        }

        this.isInitialized = true;

        // Load K/M/B format preference
        this.useKMBFormat = await storage.get('marketHistoryKMBFormat', 'settings', false);

        // Load saved filters
        await this.loadFilters();

        // A marker registered after this table was built would otherwise not
        // appear until it was next opened — and the scripts that register them
        // load after this one does, so that is the ordinary case rather than
        // the exception
        // Whatever is already registered goes first. `initialize()` sets
        // `isInitialized` at the top but reaches here two awaits later, so a
        // switch landing in between lets the arriving character's initialize
        // register its own subscription and the parked one then overwrite the
        // handle — stranding a subscription `disable()` can no longer reach,
        // and redrawing the table once more for every switch survived.
        this.unsubscribeMarkers?.();
        this.unsubscribeMarkers = listingMarkers.onChange(() => {
            if (this.modal && this.modal.style.display !== 'none') this.renderTable();
        });

        // Add marketplace tab
        this.addMarketplaceTab();
    }

    /**
     * Load saved filters from storage
     */
    async loadFilters() {
        // Whose filters these are, decided before the read rather than after
        // it. `readScoped` builds the key now, but the values are adopted a
        // storage round trip later: a switch inside that read left the
        // departing character's item, date and type selections sitting in the
        // arriving character's viewer, and `saveFilters()` writes the whole
        // filter object out on the next change — so one filter click files the
        // departing character's selections under the arriving character's key,
        // and the table thereafter shows nothing with no visible reason.
        const owner = dataManager.getCurrentCharacterId?.() ?? null;
        try {
            // Discarded rather than adopted on migration: a filter naming items
            // and dates is a view of one character's log, and pointing it at
            // another's shows an empty table with no visible reason
            const savedFilters = await readScoped('marketHistoryFilters', 'settings', null, { migrate: 'discard' });
            if ((dataManager.getCurrentCharacterId?.() ?? null) !== owner) return;
            if (savedFilters) {
                // Convert date strings back to Date objects
                this.filters.dateFrom = savedFilters.dateFrom ? new Date(savedFilters.dateFrom) : null;
                this.filters.dateTo = savedFilters.dateTo ? new Date(savedFilters.dateTo) : null;
                this.filters.selectedItems = savedFilters.selectedItems || [];
                this.filters.selectedEnhLevels = savedFilters.selectedEnhLevels || [];
                this.filters.selectedTypes = savedFilters.selectedTypes || [];
            }
        } catch (error) {
            console.error('[MarketHistoryViewer] Failed to load filters:', error);
        }
    }

    /**
     * Save filters to storage
     */
    async saveFilters() {
        try {
            // Convert Date objects to strings for storage
            const filtersToSave = {
                dateFrom: this.filters.dateFrom ? this.filters.dateFrom.toISOString() : null,
                dateTo: this.filters.dateTo ? this.filters.dateTo.toISOString() : null,
                selectedItems: this.filters.selectedItems,
                selectedEnhLevels: this.filters.selectedEnhLevels,
                selectedTypes: this.filters.selectedTypes,
            };
            await writeScoped('marketHistoryFilters', filtersToSave, 'settings', true);
        } catch (error) {
            console.error('[MarketHistoryViewer] Failed to save filters:', error);
        }
    }

    /**
     * Add "Market History" tab to marketplace tabs
     */
    addMarketplaceTab() {
        const ensureTabExists = () => {
            // Get tabs container
            const tabsContainer = visibleTabsContainer();
            if (!tabsContainer) return;

            // Verify this is the marketplace tabs (check for Market Listings tab)
            const hasMarketListingsTab = Array.from(tabsContainer.children).some((btn) =>
                btn.textContent.includes('Market Listings')
            );
            if (!hasMarketListingsTab) return;

            // Check if tab already exists
            if (tabsContainer.querySelector('[data-mwi-market-history-tab="true"]')) {
                return;
            }

            // Get reference tab (My Listings) to clone structure
            const referenceTab = Array.from(tabsContainer.children).find((btn) =>
                btn.textContent.includes('My Listings')
            );
            if (!referenceTab) return;

            // Clone reference tab
            const tab = referenceTab.cloneNode(true);

            // Mark as market history tab
            tab.setAttribute('data-mwi-market-history-tab', 'true');

            // Update badge content
            const badgeSpan = tab.querySelector('.TabsComponent_badge__1Du26');
            if (badgeSpan) {
                badgeSpan.innerHTML = `
                    <div style="text-align: center;">
                        <div>Market History</div>
                    </div>
                `;
            }

            // Remove selected state
            tab.classList.remove('Mui-selected');
            tab.setAttribute('aria-selected', 'false');
            tab.setAttribute('tabindex', '-1');

            // Add click handler
            tab.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openModal();
            });

            // Insert before any missing materials custom tabs (data-mwi-custom-tab="true")
            const firstCustomTab = Array.from(tabsContainer.children).find(
                (btn) => btn.getAttribute('data-mwi-custom-tab') === 'true'
            );

            if (firstCustomTab) {
                firstCustomTab.before(tab);
            } else {
                // No custom tabs, append to end
                tabsContainer.appendChild(tab);
            }

            this.marketplaceTab = tab;
        };

        // Watch for marketplace tabs container to appear
        if (!this.tabCleanupObserver) {
            this.tabCleanupObserver = createMutationWatcher(
                document.body,
                () => {
                    // Check if marketplace is still active
                    const tabsContainer = visibleTabsContainer();
                    if (!tabsContainer) {
                        // Marketplace closed, clean up tab
                        if (this.marketplaceTab && !document.body.contains(this.marketplaceTab)) {
                            this.marketplaceTab = null;
                        }
                        return;
                    }

                    // Check if this is still the marketplace (Market Listings tab exists)
                    const hasMarketListingsTab = Array.from(tabsContainer.children).some((btn) =>
                        btn.textContent.includes('Market Listings')
                    );

                    if (!hasMarketListingsTab) {
                        // No longer on marketplace, clean up
                        if (this.marketplaceTab && document.body.contains(this.marketplaceTab)) {
                            this.marketplaceTab.remove();
                            this.marketplaceTab = null;
                        }
                        return;
                    }

                    // Try to ensure tab exists
                    ensureTabExists();
                },
                { childList: true, subtree: true }
            );
        }

        // Initial attempt
        ensureTabExists();
    }

    /**
     * Load listings from storage
     */
    async loadListings() {
        try {
            const stored = await estimatedListingAge.personalListings();
            // Belt and braces: anchors are split off before this point, but a
            // row with no item is not a row this table can draw
            this.listings = stored.filter((listing) => listing && listing.itemHrid);

            // Migrate old listings without status field
            for (const listing of this.listings) {
                if (!listing.status) {
                    listing.status = 'unknown';
                }
            }

            // Update statuses (active and expired detection)
            await this.updateListingStatuses();

            this.cachedDateRange = null; // Clear cache when loading new data
            this.applyFilters();
        } catch (error) {
            console.error('[MarketHistoryViewer] Failed to load listings:', error);
            this.listings = [];
            this.filteredListings = [];
        }
    }

    /**
     * Update listing statuses by checking active listings
     */
    async updateListingStatuses() {
        // Get current active listings from dataManager
        const activeListings = dataManager.getMarketListings() || [];
        const activeListingIds = new Set(activeListings.map((l) => l.id));

        // Update active status (but don't overwrite expired/canceled/filled statuses)
        for (const listing of this.listings) {
            if (activeListingIds.has(listing.id)) {
                // Only mark as active if status is currently unknown or was previously active
                if (listing.status === 'unknown' || listing.status === 'active') {
                    listing.status = 'active';
                }
                // If it's already expired/canceled/filled, keep that status
            }
        }

        // Persist via estimatedListingAge — the single writer for the shared storage key.
        // Writing this.listings directly would drop its seed entries and let its stale
        // in-memory copy resurrect deleted/updated rows on the next WebSocket event.
        await estimatedListingAge.markActiveListings(activeListingIds);
    }

    /**
     * Apply filters and search to listings (optimized single-pass version)
     */
    applyFilters() {
        // Clear cached date range when filters change
        this.cachedDateRange = null;

        // Pre-compute filter conditions to avoid repeated checks
        const hasTypeFilter = this.typeFilter !== 'all';
        const typeIsBuy = this.typeFilter === 'buy';
        const typeIsSell = this.typeFilter === 'sell';

        const hasStatusFilter = this.statusFilter && this.statusFilter !== 'all';

        const hasSearchTerm = !!this.searchTerm;
        const searchTerm = hasSearchTerm ? this.searchTerm.toLowerCase() : '';

        const hasDateFilter = !!(this.filters.dateFrom || this.filters.dateTo);
        let dateToEndOfDay = null;
        if (hasDateFilter && this.filters.dateTo) {
            dateToEndOfDay = new Date(this.filters.dateTo);
            dateToEndOfDay.setHours(23, 59, 59, 999);
        }

        const hasItemFilter = this.filters.selectedItems.length > 0;
        const itemFilterSet = hasItemFilter ? new Set(this.filters.selectedItems) : null;

        const hasEnhLevelFilter = this.filters.selectedEnhLevels.length > 0;
        const enhLevelFilterSet = hasEnhLevelFilter ? new Set(this.filters.selectedEnhLevels) : null;

        const hasColumnTypeFilter = this.filters.selectedTypes.length > 0 && this.filters.selectedTypes.length < 2;
        const showBuy = hasColumnTypeFilter && this.filters.selectedTypes.includes('buy');
        const showSell = hasColumnTypeFilter && this.filters.selectedTypes.includes('sell');

        // Single-pass filter: combines all filters into one iteration
        const filtered = this.listings.filter((listing) => {
            // Type filter (legacy)
            if (hasTypeFilter) {
                if (typeIsBuy && listing.isSell) return false;
                if (typeIsSell && !listing.isSell) return false;
            }

            // Status filter
            if (hasStatusFilter) {
                if (this.statusFilter === 'filled_active') {
                    if (listing.status !== 'filled' && listing.status !== 'active') return false;
                } else if (listing.status !== this.statusFilter) {
                    return false;
                }
            }

            // Search term filter (with cached item names)
            if (hasSearchTerm) {
                const itemName = this.getItemName(listing.itemHrid);
                if (!itemName.toLowerCase().includes(searchTerm)) {
                    return false;
                }
            }

            // Date range filter
            if (hasDateFilter) {
                const listingDate = new Date(listing.createdTimestamp || listing.timestamp);

                if (this.filters.dateFrom && listingDate < this.filters.dateFrom) {
                    return false;
                }

                if (dateToEndOfDay && listingDate > dateToEndOfDay) {
                    return false;
                }
            }

            // Item filter (using Set for O(1) lookup)
            if (hasItemFilter && !itemFilterSet.has(listing.itemHrid)) {
                return false;
            }

            // Enhancement level filter (using Set for O(1) lookup)
            if (hasEnhLevelFilter && !enhLevelFilterSet.has(listing.enhancementLevel)) {
                return false;
            }

            // Type filter (column filter)
            if (hasColumnTypeFilter) {
                if (showBuy && listing.isSell) return false;
                if (showSell && !listing.isSell) return false;
            }

            return true;
        });

        // Optimize sorting: cache computed values to avoid recalculating in comparator
        if (this.sortColumn === 'itemHrid') {
            // Pre-compute item names for sorting
            const itemNamesMap = new Map();
            for (const listing of filtered) {
                if (!itemNamesMap.has(listing.itemHrid)) {
                    itemNamesMap.set(listing.itemHrid, this.getItemName(listing.itemHrid));
                }
            }

            filtered.sort((a, b) => {
                const aVal = itemNamesMap.get(a.itemHrid);
                const bVal = itemNamesMap.get(b.itemHrid);
                return this.sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
            });
        } else if (this.sortColumn === 'total') {
            // Pre-compute totals
            filtered.sort((a, b) => {
                const aVal = a.price * a.filledQuantity;
                const bVal = b.price * b.filledQuantity;
                return this.sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
            });
        } else if (this.sortColumn === 'createdTimestamp') {
            // Use numeric timestamp for fast sorting
            filtered.sort((a, b) => {
                const aVal = a.timestamp;
                const bVal = b.timestamp;
                return this.sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
            });
        } else {
            // Generic sorting for other columns
            filtered.sort((a, b) => {
                const aVal = a[this.sortColumn];
                const bVal = b[this.sortColumn];

                if (typeof aVal === 'string') {
                    return this.sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
                } else {
                    return this.sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
                }
            });
        }

        this.filteredListings = filtered;
        this.currentPage = 1; // Reset to first page when filters change

        // Auto-cleanup invalid filter selections (only on first pass to prevent infinite recursion)
        if (!this._cleanupInProgress) {
            this._cleanupInProgress = true;
            const cleaned = this.cleanupInvalidSelections();

            if (cleaned) {
                // Selections were cleaned - re-apply filters with the cleaned selections
                this.applyFilters();
            }

            this._cleanupInProgress = false;

            // Re-render table if modal is open and cleanup happened (only on outermost call)
            if (cleaned && this.modal && this.modal.style.display !== 'none') {
                this.renderTable();
            }
        }
    }

    /**
     * Remove filter selections that yield no results with current filters
     * @returns {boolean} True if any selections were cleaned up
     */
    cleanupInvalidSelections() {
        let changed = false;

        // Check item selections
        if (this.filters.selectedItems.length > 0) {
            const validItems = new Set(this.filteredListings.map((l) => l.itemHrid));
            const originalLength = this.filters.selectedItems.length;
            this.filters.selectedItems = this.filters.selectedItems.filter((hrid) => validItems.has(hrid));

            if (this.filters.selectedItems.length !== originalLength) {
                changed = true;
            }
        }

        // Check enhancement level selections
        if (this.filters.selectedEnhLevels.length > 0) {
            const validLevels = new Set(this.filteredListings.map((l) => l.enhancementLevel));
            const originalLength = this.filters.selectedEnhLevels.length;
            this.filters.selectedEnhLevels = this.filters.selectedEnhLevels.filter((level) => validLevels.has(level));

            if (this.filters.selectedEnhLevels.length !== originalLength) {
                changed = true;
            }
        }

        // Check type selections
        if (this.filters.selectedTypes.length > 0) {
            const hasBuy = this.filteredListings.some((l) => !l.isSell);
            const hasSell = this.filteredListings.some((l) => l.isSell);
            const originalLength = this.filters.selectedTypes.length;

            this.filters.selectedTypes = this.filters.selectedTypes.filter((type) => {
                if (type === 'buy') return hasBuy;
                if (type === 'sell') return hasSell;
                return false;
            });

            if (this.filters.selectedTypes.length !== originalLength) {
                changed = true;
            }
        }

        // Save changes to storage
        if (changed) {
            this.saveFilters();
        }

        return changed;
    }

    /**
     * Get item name from HRID (with caching for performance)
     */
    getItemName(itemHrid) {
        // Check cache first
        if (this.itemNameCache.has(itemHrid)) {
            return this.itemNameCache.get(itemHrid);
        }

        // Get item name and cache it
        const itemDetails = dataManager.getItemDetails(itemHrid);
        const name = itemDetails?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
        this.itemNameCache.set(itemHrid, name);
        return name;
    }

    /**
     * Format number based on K/M/B toggle
     * @param {number} num - Number to format
     * @returns {string} Formatted number
     */
    formatNumber(num) {
        return this.useKMBFormat ? formatKMB(num, 1) : formatWithSeparator(num);
    }

    /**
     * Get paginated listings for current page
     */
    getPaginatedListings() {
        if (this.showAll) {
            return this.filteredListings;
        }

        const start = (this.currentPage - 1) * this.rowsPerPage;
        const end = start + this.rowsPerPage;
        return this.filteredListings.slice(start, end);
    }

    /**
     * Get total pages
     */
    getTotalPages() {
        if (this.showAll) {
            return 1;
        }
        return Math.ceil(this.filteredListings.length / this.rowsPerPage);
    }

    /**
     * Open the market history modal
     */
    async openModal() {
        // Load listings
        await this.loadListings();

        // Create modal if it doesn't exist
        if (!this.modal) {
            this.createModal();
        }

        // Show modal
        this.modal.style.display = 'flex';

        // Render table
        this.renderTable();
    }

    /**
     * Close the modal
     */
    closeModal() {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
    }

    /**
     * Create modal structure
     */
    createModal() {
        // Modal overlay — full-screen intentional modal, so it sits at config.Z_MODAL
        // rather than the persistent-floating-panel tier (PANEL_Z_CAP); popouts spawned
        // from it (import progress, filter dropdowns) sit just above at Z_MODAL + 1/+2,
        // still comfortably below native browser dialogs (confirm/alert), which are
        // always topmost regardless of z-index.
        this.modal = document.createElement('div');
        this.modal.className = 'mwi-market-history-modal';
        this.modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: ${config.Z_MODAL};
        `;

        // Modal content — shared navy/blue-accent chrome (see simple-panel.js)
        const content = document.createElement('div');
        content.className = 'mwi-market-history-content';
        content.style.cssText = `
            background: rgba(10, 10, 20, 0.97);
            border: 1px solid rgba(74, 158, 255, 0.5);
            border-radius: 8px;
            padding: 20px;
            max-width: 95%;
            max-height: 90%;
            overflow: auto;
            color: #e8ecf5;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 12px;
            border-bottom: 1px solid rgba(74, 158, 255, 0.3);
        `;

        const title = document.createElement('h2');
        title.textContent = 'Market History';
        title.style.cssText = `
            margin: 0;
            color: #8fb4ff;
        `;

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: none;
            border: none;
            color: #e8ecf5;
            font-size: 24px;
            cursor: pointer;
            padding: 0;
            width: 30px;
            height: 30px;
        `;
        closeBtn.addEventListener('click', () => this.closeModal());

        header.appendChild(title);
        header.appendChild(closeBtn);

        // Controls container
        const controls = document.createElement('div');
        controls.className = 'mwi-market-history-controls';
        controls.style.cssText = `
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
        `;

        content.appendChild(header);
        content.appendChild(controls);

        // Table container
        const tableContainer = document.createElement('div');
        tableContainer.className = 'mwi-market-history-table-container';
        content.appendChild(tableContainer);

        // Pagination container
        const pagination = document.createElement('div');
        pagination.className = 'mwi-market-history-pagination';
        pagination.style.cssText = `
            margin-top: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        content.appendChild(pagination);

        this.modal.appendChild(content);
        document.body.appendChild(this.modal);

        // Close on background click
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.closeModal();
            }
        });
    }

    /**
     * Render controls (search, filters, export)
     */
    renderControls() {
        const controls = this.modal.querySelector('.mwi-market-history-controls');

        // Only render if controls are empty (prevents re-rendering on every keystroke)
        if (controls.children.length > 0) {
            // Just update the stats text
            this.updateStats();
            return;
        }

        // Left group: Search and filters
        const leftGroup = document.createElement('div');
        leftGroup.style.cssText = `
            display: flex;
            gap: 10px;
            align-items: center;
        `;

        // Search box
        const searchBox = document.createElement('input');
        searchBox.type = 'text';
        searchBox.placeholder = 'Search items...';
        searchBox.value = this.searchTerm;
        searchBox.className = 'mwi-search-box';
        searchBox.style.cssText = `
            padding: 6px 12px;
            border: 1px solid #555;
            border-radius: 4px;
            background: #1a1a1a;
            color: #fff;
            min-width: 200px;
        `;
        searchBox.addEventListener('input', (e) => {
            this.searchTerm = e.target.value;
            this.applyFilters();
            this.renderTable();
        });

        // Type filter
        const typeFilter = document.createElement('select');
        typeFilter.classList.add('toolasha-select');
        typeFilter.style.cssText = `
            padding: 6px 12px;
            border: 1px solid #555;
            border-radius: 4px;
            background: #1a1a1a;
            color: #fff;
        `;
        const typeOptions = [
            { value: 'all', label: 'All Types' },
            { value: 'buy', label: 'Buy Orders' },
            { value: 'sell', label: 'Sell Orders' },
        ];
        typeOptions.forEach((opt) => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.value === this.typeFilter) {
                option.selected = true;
            }
            typeFilter.appendChild(option);
        });
        typeFilter.addEventListener('change', (e) => {
            this.typeFilter = e.target.value;
            this.applyFilters();
            this.renderTable();
        });

        // Status filter
        const statusFilter = document.createElement('select');
        statusFilter.classList.add('toolasha-select');
        statusFilter.style.cssText = `
            padding: 6px 12px;
            border: 1px solid #555;
            border-radius: 4px;
            background: #1a1a1a;
            color: #fff;
        `;
        const statusOptions = [
            { value: 'all', label: 'All Statuses' },
            { value: 'active', label: 'Active Only' },
            { value: 'filled', label: 'Filled Only' },
            { value: 'filled_active', label: 'Filled or Active' },
            { value: 'canceled', label: 'Canceled Only' },
            { value: 'expired', label: 'Expired Only' },
            { value: 'unknown', label: 'Unknown Only' },
        ];
        statusOptions.forEach((opt) => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.value === this.statusFilter) {
                option.selected = true;
            }
            statusFilter.appendChild(option);
        });
        statusFilter.addEventListener('change', (e) => {
            this.statusFilter = e.target.value;
            this.applyFilters();
            this.renderTable();
        });

        leftGroup.appendChild(searchBox);
        leftGroup.appendChild(typeFilter);
        leftGroup.appendChild(statusFilter);

        // Middle group: Active filter badges
        const middleGroup = document.createElement('div');
        middleGroup.className = 'mwi-active-filters';
        middleGroup.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
            flex-wrap: wrap;
            flex: 1;
            min-height: 32px;
        `;

        // Action buttons group
        const actionGroup = document.createElement('div');
        actionGroup.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
        `;

        // Export button
        const exportBtn = document.createElement('button');
        exportBtn.textContent = 'Export CSV';
        exportBtn.style.cssText = `
            padding: 6px 12px;
            background: #4a90e2;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        `;
        exportBtn.addEventListener('click', () => this.exportCSV());

        // Import button
        const importBtn = document.createElement('button');
        importBtn.textContent = 'Import Market Data';
        importBtn.style.cssText = `
            padding: 6px 12px;
            background: #9b59b6;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        `;
        importBtn.addEventListener('click', () => this.showImportDialog());

        // Clear History button (destructive action - red)
        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear History';
        clearBtn.style.cssText = `
            padding: 6px 12px;
            background: #dc2626;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        `;
        clearBtn.addEventListener('mouseenter', () => {
            clearBtn.style.background = '#b91c1c';
        });
        clearBtn.addEventListener('mouseleave', () => {
            clearBtn.style.background = '#dc2626';
        });
        clearBtn.addEventListener('click', () => this.clearHistory());

        actionGroup.appendChild(exportBtn);
        actionGroup.appendChild(importBtn);
        actionGroup.appendChild(clearBtn);

        // Right group: Options and stats
        const rightGroup = document.createElement('div');
        rightGroup.style.cssText = `
            display: flex;
            gap: 12px;
            align-items: center;
            margin-left: auto;
        `;

        // K/M/B Format checkbox
        const kmbCheckbox = document.createElement('input');
        kmbCheckbox.type = 'checkbox';
        kmbCheckbox.checked = this.useKMBFormat;
        kmbCheckbox.id = 'mwi-kmb-format';
        kmbCheckbox.style.cssText = `
            cursor: pointer;
        `;
        kmbCheckbox.addEventListener('change', (e) => {
            this.useKMBFormat = e.target.checked;
            // Save preference to storage
            storage.set('marketHistoryKMBFormat', this.useKMBFormat, 'settings');
            this.renderTable(); // Re-render to apply formatting
        });

        const kmbLabel = document.createElement('label');
        kmbLabel.htmlFor = 'mwi-kmb-format';
        kmbLabel.textContent = 'K/M/B Format';
        kmbLabel.style.cssText = `
            cursor: pointer;
            color: #aaa;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 6px;
        `;
        kmbLabel.prepend(kmbCheckbox);

        // Summary stats
        const stats = document.createElement('div');
        stats.className = 'mwi-market-history-stats';
        stats.style.cssText = `
            color: #aaa;
            font-size: 14px;
            white-space: nowrap;
        `;
        stats.textContent = `Total: ${this.filteredListings.length} listings`;

        rightGroup.appendChild(kmbLabel);
        rightGroup.appendChild(stats);

        controls.appendChild(leftGroup);
        controls.appendChild(middleGroup);
        controls.appendChild(actionGroup);
        controls.appendChild(rightGroup);

        // Add Clear All Filters button if needed (handled dynamically)
        this.updateClearFiltersButton();

        // Render active filter badges
        this.renderActiveFilters();
    }

    /**
     * Update just the stats text (without re-rendering controls)
     */
    updateStats() {
        const stats = this.modal.querySelector('.mwi-market-history-stats');
        if (stats) {
            stats.textContent = `Total: ${this.filteredListings.length} listings`;
        }

        // Update Clear All Filters button visibility
        this.updateClearFiltersButton();

        // Update active filter badges
        this.renderActiveFilters();
    }

    /**
     * Render active filter badges in the middle section
     */
    renderActiveFilters() {
        const container = this.modal.querySelector('.mwi-active-filters');
        if (!container) return;

        // Explicitly remove all children to ensure SVG elements are garbage collected
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        const badges = [];

        // Date filter
        if (this.filters.dateFrom || this.filters.dateTo) {
            const dateText = [];
            if (this.filters.dateFrom) {
                dateText.push(formatDateTime(this.filters.dateFrom, { includeTime: false }));
            }
            if (this.filters.dateTo) {
                dateText.push(formatDateTime(this.filters.dateTo, { includeTime: false }));
            }
            badges.push({
                label: `Date: ${dateText.join(' - ')}`,
                onRemove: () => {
                    this.filters.dateFrom = null;
                    this.filters.dateTo = null;
                    this.saveFilters();
                    this.applyFilters();
                    this.renderTable();
                },
            });
        }

        // Item filters
        if (this.filters.selectedItems.length > 0) {
            if (this.filters.selectedItems.length === 1) {
                badges.push({
                    label: this.getItemName(this.filters.selectedItems[0]),
                    icon: this.filters.selectedItems[0],
                    onRemove: () => {
                        this.filters.selectedItems = [];
                        this.saveFilters();
                        this.applyFilters();
                        this.renderTable();
                    },
                });
            } else {
                badges.push({
                    label: `${this.filters.selectedItems.length} items selected`,
                    icon: this.filters.selectedItems[0], // Show first item's icon
                    onRemove: () => {
                        this.filters.selectedItems = [];
                        this.saveFilters();
                        this.applyFilters();
                        this.renderTable();
                    },
                });
            }
        }

        // Enhancement level filters
        if (this.filters.selectedEnhLevels.length > 0) {
            const levels = this.filters.selectedEnhLevels.sort((a, b) => a - b);
            if (levels.length === 1) {
                const levelText = levels[0] > 0 ? `+${levels[0]}` : 'No Enhancement';
                badges.push({
                    label: `Enh Lvl: ${levelText}`,
                    onRemove: () => {
                        this.filters.selectedEnhLevels = [];
                        this.saveFilters();
                        this.applyFilters();
                        this.renderTable();
                    },
                });
            } else {
                badges.push({
                    label: `Enh Lvl: ${levels.length} selected`,
                    onRemove: () => {
                        this.filters.selectedEnhLevels = [];
                        this.saveFilters();
                        this.applyFilters();
                        this.renderTable();
                    },
                });
            }
        }

        // Type filters
        if (this.filters.selectedTypes.length > 0 && this.filters.selectedTypes.length < 2) {
            badges.push({
                label: `Type: ${this.filters.selectedTypes.includes('buy') ? 'Buy' : 'Sell'}`,
                onRemove: () => {
                    this.filters.selectedTypes = [];
                    this.saveFilters();
                    this.applyFilters();
                    this.renderTable();
                },
            });
        }

        // Render badges
        badges.forEach((badge) => {
            const badgeEl = document.createElement('div');
            badgeEl.style.cssText = `
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 4px 8px;
                background: #3a3a3a;
                border: 1px solid #555;
                border-radius: 4px;
                color: #aaa;
                font-size: 13px;
            `;

            // Add icon if provided
            if (badge.icon) {
                const itemsSpriteUrl = this.getItemsSpriteUrl();
                if (itemsSpriteUrl) {
                    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    svg.setAttribute('width', '16');
                    svg.setAttribute('height', '16');
                    svg.style.flexShrink = '0';

                    // Extract icon name and create use element with external sprite reference
                    const iconName = badge.icon.split('/').pop();
                    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
                    use.setAttribute('href', `${itemsSpriteUrl}#${iconName}`);
                    svg.appendChild(use);
                    badgeEl.appendChild(svg);
                }
            }

            const label = document.createElement('span');
            label.textContent = badge.label;

            const removeBtn = document.createElement('button');
            removeBtn.textContent = '✕';
            removeBtn.style.cssText = `
                background: none;
                border: none;
                color: #aaa;
                cursor: pointer;
                padding: 0;
                font-size: 14px;
                line-height: 1;
            `;
            removeBtn.addEventListener('mouseenter', () => {
                removeBtn.style.color = '#fff';
            });
            removeBtn.addEventListener('mouseleave', () => {
                removeBtn.style.color = '#aaa';
            });
            removeBtn.addEventListener('click', badge.onRemove);

            badgeEl.appendChild(label);
            badgeEl.appendChild(removeBtn);
            container.appendChild(badgeEl);
        });
    }

    /**
     * Update Clear All Filters button visibility based on filter state
     */
    updateClearFiltersButton() {
        const controls = this.modal.querySelector('.mwi-market-history-controls');
        if (!controls) return;

        const hasActiveFilters =
            this.filters.dateFrom !== null ||
            this.filters.dateTo !== null ||
            this.filters.selectedItems.length > 0 ||
            this.filters.selectedEnhLevels.length > 0 ||
            (this.filters.selectedTypes.length > 0 && this.filters.selectedTypes.length < 2);

        const existingBtn = controls.querySelector('.mwi-clear-filters-button');

        if (hasActiveFilters && !existingBtn) {
            // Create button
            const clearFiltersBtn = document.createElement('button');
            clearFiltersBtn.className = 'mwi-clear-filters-button';
            clearFiltersBtn.textContent = 'Clear All Filters';
            clearFiltersBtn.style.cssText = `
                padding: 6px 12px;
                background: #e67e22;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                white-space: nowrap;
            `;
            clearFiltersBtn.addEventListener('mouseenter', () => {
                clearFiltersBtn.style.background = '#d35400';
            });
            clearFiltersBtn.addEventListener('mouseleave', () => {
                clearFiltersBtn.style.background = '#e67e22';
            });
            clearFiltersBtn.addEventListener('click', () => this.clearAllFilters());

            // Insert into right group (before K/M/B checkbox)
            const rightGroup = controls.children[3]; // Fourth child is rightGroup
            if (rightGroup) {
                rightGroup.insertBefore(clearFiltersBtn, rightGroup.firstChild);
            }
        } else if (!hasActiveFilters && existingBtn) {
            // Remove button
            existingBtn.remove();
        }
    }

    /**
     * Render table with listings
     */
    renderTable() {
        this.renderControls();

        const tableContainer = this.modal.querySelector('.mwi-market-history-table-container');

        // Explicitly remove all children to ensure SVG elements are garbage collected
        while (tableContainer.firstChild) {
            tableContainer.removeChild(tableContainer.firstChild);
        }

        const table = document.createElement('table');
        table.style.cssText = `
            width: 100%;
            border-collapse: collapse;
            color: #fff;
        `;

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.style.cssText = `
            background: #1a1a1a;
        `;

        const columns = [
            { key: 'createdTimestamp', label: 'Date' },
            { key: 'itemHrid', label: 'Item' },
            { key: 'enhancementLevel', label: 'Enh Lvl' },
            { key: 'isSell', label: 'Type' },
            { key: 'status', label: 'Status' },
            { key: 'price', label: 'Price' },
            { key: 'orderQuantity', label: 'Quantity' },
            { key: 'filledQuantity', label: 'Filled' },
            { key: 'total', label: 'Total' },
            ...listingMarkers.all().map((marker) => ({ key: `_marker_${marker.name}`, label: '' })),
            { key: '_delete', label: '' },
        ];

        columns.forEach((col) => {
            const th = document.createElement('th');
            th.style.cssText = `
                padding: 10px;
                text-align: left;
                border-bottom: 2px solid #555;
                user-select: none;
                position: relative;
            `;

            // Create header content container
            const headerContent = document.createElement('div');
            headerContent.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
            `;

            // Label and sort indicator
            const labelSpan = document.createElement('span');
            labelSpan.textContent = col.label;

            if (col.key === '_delete') {
                th.style.width = '30px';
            } else {
                labelSpan.style.cursor = 'pointer';

                // Sort indicator
                if (this.sortColumn === col.key) {
                    labelSpan.textContent += this.sortDirection === 'asc' ? ' ▲' : ' ▼';
                }

                // Sort click handler
                labelSpan.addEventListener('click', () => {
                    if (this.sortColumn === col.key) {
                        this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                    } else {
                        this.sortColumn = col.key;
                        this.sortDirection = 'desc';
                    }
                    this.applyFilters();
                    this.renderTable();
                });
            }

            headerContent.appendChild(labelSpan);

            // Add filter button for filterable columns
            const filterableColumns = ['createdTimestamp', 'itemHrid', 'enhancementLevel', 'isSell'];
            if (filterableColumns.includes(col.key)) {
                const filterBtn = document.createElement('button');
                filterBtn.textContent = '⋮';
                filterBtn.style.cssText = `
                    background: none;
                    border: none;
                    color: #aaa;
                    cursor: pointer;
                    font-size: 16px;
                    padding: 2px 4px;
                    font-weight: bold;
                `;

                // Check if filter is active
                const hasActiveFilter = this.hasActiveFilter(col.key);
                if (hasActiveFilter) {
                    filterBtn.style.color = '#4a90e2';
                    filterBtn.textContent = '⋮';
                }

                filterBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showFilterPopup(col.key, filterBtn);
                });

                headerContent.appendChild(filterBtn);
            }

            th.appendChild(headerContent);
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        const paginatedListings = this.getPaginatedListings();

        if (paginatedListings.length === 0) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = columns.length;
            cell.textContent = 'No listings found';
            cell.style.cssText = `
                padding: 20px;
                text-align: center;
                color: #888;
            `;
            row.appendChild(cell);
            tbody.appendChild(row);
        } else {
            paginatedListings.forEach((listing, index) => {
                const row = document.createElement('tr');
                row.style.cssText = `
                    border-bottom: 1px solid #333;
                    background: ${index % 2 === 0 ? '#2a2a2a' : '#252525'};
                `;

                // Date
                const dateCell = document.createElement('td');
                // Use createdTimestamp if available, otherwise fall back to numeric timestamp
                const dateValue = listing.createdTimestamp || listing.timestamp;
                dateCell.textContent = formatDateTime(new Date(dateValue));
                dateCell.style.padding = '4px 10px';
                row.appendChild(dateCell);

                // Item (with icon)
                const itemCell = document.createElement('td');
                itemCell.style.cssText = `
                    padding: 4px 10px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                `;

                // Create SVG icon
                const itemsSpriteUrl = this.getItemsSpriteUrl();
                if (itemsSpriteUrl) {
                    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    svg.setAttribute('width', '20');
                    svg.setAttribute('height', '20');

                    // Extract icon name and create use element with external sprite reference
                    const iconName = listing.itemHrid.split('/').pop();
                    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
                    use.setAttribute('href', `${itemsSpriteUrl}#${iconName}`);
                    svg.appendChild(use);

                    // Add icon
                    itemCell.appendChild(svg);
                }

                // Add text
                const textSpan = document.createElement('span');
                textSpan.textContent = this.getItemName(listing.itemHrid);
                itemCell.appendChild(textSpan);

                // Clicking the item opens its marketplace page. The row already
                // names an item and an enhancement level, which is everything
                // the marketplace needs, so retyping it into the search box was
                // only ever busywork. The modal closes first — navigating behind
                // an overlay would look like nothing happened.
                itemCell.style.cursor = 'pointer';
                itemCell.title = 'Open this item in the marketplace';
                itemCell.addEventListener('click', () => {
                    this.closeModal();
                    navigateToMarketplace(listing.itemHrid, listing.enhancementLevel || 0);
                });

                row.appendChild(itemCell);

                // Enhancement
                const enhCell = document.createElement('td');
                enhCell.textContent = listing.enhancementLevel > 0 ? `+${listing.enhancementLevel}` : '-';
                enhCell.style.padding = '4px 10px';
                row.appendChild(enhCell);

                // Type
                const typeCell = document.createElement('td');
                typeCell.textContent = listing.isSell ? 'Sell' : 'Buy';
                typeCell.style.cssText = `
                    padding: 4px 10px;
                    color: ${listing.isSell ? '#4ade80' : '#60a5fa'};
                `;
                row.appendChild(typeCell);

                // Status
                const statusCell = document.createElement('td');
                const status = listing.status || 'unknown';
                statusCell.textContent = status.charAt(0).toUpperCase() + status.slice(1);
                const statusColors = {
                    active: '#60a5fa',
                    filled: '#4ade80',
                    canceled: '#fbbf24',
                    expired: '#f87171',
                    unknown: '#9ca3af',
                };
                statusCell.style.cssText = `
                    padding: 4px 10px;
                    color: ${statusColors[status] || '#9ca3af'};
                    font-weight: 500;
                `;
                row.appendChild(statusCell);

                // Price
                const priceCell = document.createElement('td');
                priceCell.textContent = this.formatNumber(listing.price);
                priceCell.style.padding = '4px 10px';
                row.appendChild(priceCell);

                // Quantity
                const qtyCell = document.createElement('td');
                qtyCell.textContent = this.formatNumber(listing.orderQuantity);
                qtyCell.style.padding = '4px 10px';
                row.appendChild(qtyCell);

                // Filled
                const filledCell = document.createElement('td');
                filledCell.textContent = this.formatNumber(listing.filledQuantity);
                filledCell.style.padding = '4px 10px';
                row.appendChild(filledCell);

                // Total (Price × Filled)
                const totalCell = document.createElement('td');
                const totalValue = listing.price * listing.filledQuantity;
                totalCell.textContent = this.formatNumber(totalValue);
                totalCell.style.padding = '4px 10px';
                row.appendChild(totalCell);

                // Whatever other scripts want to mark this listing with. The
                // viewer supplies a cell and a click; the meaning is theirs.
                for (const marker of listingMarkers.all()) {
                    const cell = document.createElement('td');
                    cell.style.cssText = 'padding: 4px 4px; text-align: center;';
                    const state = markerStateFor(
                        marker,
                        listing,
                        (name, error) => console.error(`[MarketHistory] Listing marker "${name}" failed:`, error),
                        HISTORY_SURFACE
                    );
                    if (state) {
                        const button = document.createElement('button');
                        button.textContent = state.glyph;
                        button.title = state.title;
                        button.style.cssText =
                            'background:none; border:none; cursor:pointer; font-size:14px; line-height:1; ' +
                            `padding:2px 4px; color:${state.active ? state.color || '#ffc866' : '#555'};`;
                        button.addEventListener('click', async (e) => {
                            e.stopPropagation();
                            try {
                                await marker.onToggle(listing, HISTORY_SURFACE);
                            } catch (error) {
                                console.error(`[MarketHistory] Listing marker "${marker.name}" toggle failed:`, error);
                            }
                            this.renderTable();
                        });
                        cell.appendChild(button);
                    }
                    row.appendChild(cell);
                }

                // Delete button
                const deleteCell = document.createElement('td');
                deleteCell.style.cssText = 'padding: 4px 6px; text-align: center;';
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '✕';
                deleteBtn.title = 'Delete this listing';
                deleteBtn.style.cssText = `
                    background: none;
                    border: none;
                    color: #666;
                    cursor: pointer;
                    font-size: 13px;
                    padding: 2px 5px;
                    border-radius: 3px;
                    line-height: 1;
                `;
                deleteBtn.addEventListener('mouseenter', () => {
                    deleteBtn.style.color = '#f87171';
                    deleteBtn.style.background = 'rgba(248,113,113,0.15)';
                });
                deleteBtn.addEventListener('mouseleave', () => {
                    deleteBtn.style.color = '#666';
                    deleteBtn.style.background = 'none';
                });
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.deleteListing(listing.id);
                });
                deleteCell.appendChild(deleteBtn);
                row.appendChild(deleteCell);

                tbody.appendChild(row);
            });
        }

        table.appendChild(tbody);
        tableContainer.appendChild(table);

        // Render pagination
        this.renderPagination();
    }

    /**
     * Render pagination controls
     */
    renderPagination() {
        const pagination = this.modal.querySelector('.mwi-market-history-pagination');

        // Explicitly remove all children to ensure proper cleanup
        while (pagination.firstChild) {
            pagination.removeChild(pagination.firstChild);
        }

        // Left side: Rows per page
        const leftSide = document.createElement('div');
        leftSide.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
            color: #aaa;
        `;

        const label = document.createElement('span');
        label.textContent = 'Rows per page:';

        const rowsInput = document.createElement('input');
        rowsInput.type = 'number';
        rowsInput.value = this.rowsPerPage;
        rowsInput.min = '1';
        rowsInput.disabled = this.showAll;
        rowsInput.style.cssText = `
            width: 60px;
            padding: 4px 8px;
            border: 1px solid #555;
            border-radius: 4px;
            background: ${this.showAll ? '#333' : '#1a1a1a'};
            color: ${this.showAll ? '#666' : '#fff'};
        `;
        rowsInput.addEventListener('change', (e) => {
            this.rowsPerPage = Math.max(1, parseInt(e.target.value) || 50);
            this.currentPage = 1;
            this.renderTable();
        });

        const showAllCheckbox = document.createElement('input');
        showAllCheckbox.type = 'checkbox';
        showAllCheckbox.checked = this.showAll;
        showAllCheckbox.style.cssText = `
            cursor: pointer;
        `;
        showAllCheckbox.addEventListener('change', (e) => {
            this.showAll = e.target.checked;
            rowsInput.disabled = this.showAll;
            rowsInput.style.background = this.showAll ? '#333' : '#1a1a1a';
            rowsInput.style.color = this.showAll ? '#666' : '#fff';
            this.currentPage = 1;
            this.renderTable();
        });

        const showAllLabel = document.createElement('label');
        showAllLabel.textContent = 'Show All';
        showAllLabel.style.cssText = `
            cursor: pointer;
            color: #aaa;
        `;
        showAllLabel.prepend(showAllCheckbox);

        leftSide.appendChild(label);
        leftSide.appendChild(rowsInput);
        leftSide.appendChild(showAllLabel);

        // Right side: Page navigation
        const rightSide = document.createElement('div');
        rightSide.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
            color: #aaa;
        `;

        if (!this.showAll) {
            const totalPages = this.getTotalPages();

            const prevBtn = document.createElement('button');
            prevBtn.textContent = '◀';
            prevBtn.disabled = this.currentPage === 1;
            prevBtn.style.cssText = `
                padding: 4px 12px;
                background: ${this.currentPage === 1 ? '#333' : '#4a90e2'};
                color: ${this.currentPage === 1 ? '#666' : 'white'};
                border: none;
                border-radius: 4px;
                cursor: ${this.currentPage === 1 ? 'default' : 'pointer'};
            `;
            prevBtn.addEventListener('click', () => {
                if (this.currentPage > 1) {
                    this.currentPage--;
                    this.renderTable();
                }
            });

            const pageInfo = document.createElement('span');
            pageInfo.textContent = `Page ${this.currentPage} of ${totalPages}`;

            const nextBtn = document.createElement('button');
            nextBtn.textContent = '▶';
            nextBtn.disabled = this.currentPage === totalPages;
            nextBtn.style.cssText = `
                padding: 4px 12px;
                background: ${this.currentPage === totalPages ? '#333' : '#4a90e2'};
                color: ${this.currentPage === totalPages ? '#666' : 'white'};
                border: none;
                border-radius: 4px;
                cursor: ${this.currentPage === totalPages ? 'default' : 'pointer'};
            `;
            nextBtn.addEventListener('click', () => {
                if (this.currentPage < totalPages) {
                    this.currentPage++;
                    this.renderTable();
                }
            });

            rightSide.appendChild(prevBtn);
            rightSide.appendChild(pageInfo);
            rightSide.appendChild(nextBtn);
        } else {
            const showingInfo = document.createElement('span');
            showingInfo.textContent = `Showing all ${this.filteredListings.length} listings`;
            rightSide.appendChild(showingInfo);
        }

        pagination.appendChild(leftSide);
        pagination.appendChild(rightSide);
    }

    /**
     * Export listings to CSV
     */
    exportCSV() {
        const headers = ['Date', 'Item', 'Enhancement', 'Type', 'Status', 'Price', 'Quantity', 'Filled', 'Total', 'ID'];
        const rows = this.filteredListings.map((listing) => [
            new Date(listing.createdTimestamp || listing.timestamp).toISOString(),
            this.getItemName(listing.itemHrid),
            listing.enhancementLevel || 0,
            listing.isSell ? 'Sell' : 'Buy',
            listing.status || 'unknown',
            listing.price,
            listing.orderQuantity,
            listing.filledQuantity,
            listing.price * listing.filledQuantity, // Total
            listing.id,
        ]);

        const csv = [headers, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n');

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `market-history-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Import listings from CSV
     */
    async importCSV(csvText) {
        let progressMsg = null;
        try {
            // Parse CSV
            const lines = csvText.trim().split('\n');
            if (lines.length < 2) {
                throw new Error('CSV file is empty or invalid');
            }

            // Parse header to detect the optional Status column
            // (current exports have 10 columns including Status; old exports have 9 without it)
            const headerFields = lines[0].split(',').map((field) => field.replace(/"/g, '').trim());
            const hasStatusColumn = headerFields.includes('Status');

            // Show progress message
            progressMsg = document.createElement('div');
            progressMsg.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(10, 10, 20, 0.97);
                border: 1px solid rgba(74, 158, 255, 0.5);
                padding: 20px;
                border-radius: 8px;
                color: #e8ecf5;
                z-index: ${config.Z_MODAL + 1};
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            `;
            progressMsg.textContent = `Importing ${lines.length - 1} listings from CSV...`;
            document.body.appendChild(progressMsg);

            // Load existing listings
            const existingListings = await estimatedListingAge.personalListings();
            const existingIds = new Set(existingListings.map((l) => l.id));

            let imported = 0;
            let skipped = 0;
            // Imported rows are exact id↔time pairs too — mirror them into the
            // shared anchor pool the same way live recording does
            const newAnchors = [];

            // Build item name to HRID map
            const itemNameToHrid = {};
            const gameData = dataManager.getInitClientData();
            if (gameData?.itemDetailMap) {
                for (const [hrid, details] of Object.entries(gameData.itemDetailMap)) {
                    if (details.name) {
                        itemNameToHrid[details.name] = hrid;
                    }
                }
            }

            // Process each line
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                // Parse CSV row (handle quoted fields)
                const fields = [];
                let currentField = '';
                let inQuotes = false;

                for (let j = 0; j < line.length; j++) {
                    const char = line[j];
                    if (char === '"') {
                        inQuotes = !inQuotes;
                    } else if (char === ',' && !inQuotes) {
                        fields.push(currentField);
                        currentField = '';
                    } else {
                        currentField += char;
                    }
                }
                fields.push(currentField); // Add last field

                if (fields.length < (hasStatusColumn ? 10 : 9)) {
                    console.warn(`[MarketHistoryViewer] Skipping invalid CSV row ${i}: ${line}`);
                    continue;
                }

                // Columns: Date, Item, Enhancement, Type, [Status,] Price, Quantity, Filled, Total, ID
                const statusOffset = hasStatusColumn ? 1 : 0;
                const [dateStr, itemName, enhStr, typeStr] = fields;
                const statusStr = hasStatusColumn ? fields[4] : 'unknown';
                const priceStr = fields[4 + statusOffset];
                const qtyStr = fields[5 + statusOffset];
                const filledStr = fields[6 + statusOffset];
                const idStr = fields[8 + statusOffset];

                // Parse ID
                const id = parseInt(idStr);
                if (isNaN(id)) {
                    console.warn(`[MarketHistoryViewer] Skipping row with invalid ID: ${idStr}`);
                    continue;
                }

                // Skip duplicates
                if (existingIds.has(id)) {
                    skipped++;
                    continue;
                }

                // Find item HRID from name
                const itemHrid = itemNameToHrid[itemName];
                if (!itemHrid) {
                    console.warn(`[MarketHistoryViewer] Could not find HRID for item: ${itemName}`);
                    skipped++;
                    continue;
                }

                // Reject rows with non-numeric price/quantity/filled instead of storing NaN
                const price = parseFloat(priceStr);
                const orderQuantity = parseFloat(qtyStr);
                const filledQuantity = parseFloat(filledStr);
                if (isNaN(price) || isNaN(orderQuantity) || isNaN(filledQuantity)) {
                    console.warn(`[MarketHistoryViewer] Skipping row with invalid numbers: ${line}`);
                    skipped++;
                    continue;
                }

                // Create listing object
                const listing = {
                    id: id,
                    timestamp: new Date(dateStr).getTime(),
                    createdTimestamp: dateStr,
                    itemHrid: itemHrid,
                    enhancementLevel: parseInt(enhStr) || 0,
                    price: price,
                    orderQuantity: orderQuantity,
                    filledQuantity: filledQuantity,
                    isSell: typeStr.toLowerCase() === 'sell',
                    status: statusStr || 'unknown',
                };

                existingListings.push(listing);
                newAnchors.push({ id: listing.id, timestamp: listing.timestamp });
                imported++;
            }

            // Save to storage
            await estimatedListingAge.importListings(existingListings);
            await estimatedListingAge.addAnchors(newAnchors);

            // Remove progress message
            document.body.removeChild(progressMsg);

            // Show success message
            alert(
                `Import complete!\n\nImported: ${imported} new listings\nSkipped: ${skipped} duplicates or invalid rows\nTotal: ${existingListings.length} listings`
            );

            // Reload and render table
            await this.loadListings();
            this.renderTable();
        } catch (error) {
            // Remove the progress overlay so a partial failure doesn't leave it stuck on screen
            progressMsg?.remove();
            console.error('[MarketHistoryViewer] CSV import error:', error);
            throw error;
        }
    }

    /**
     * Show import dialog
     */
    showImportDialog() {
        // Create file input
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.txt,.json,.csv';
        fileInput.style.display = 'none';

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();

                // Detect file type and use appropriate import method
                if (file.name.endsWith('.csv')) {
                    await this.importCSV(text);
                } else {
                    await this.importEdibleToolsData(text);
                }
            } catch (error) {
                console.error('[MarketHistoryViewer] Import failed:', error);
                alert(`Import failed: ${error.message}`);
            }
        });

        document.body.appendChild(fileInput);
        fileInput.click();
        document.body.removeChild(fileInput);
    }

    /**
     * Import market listing data (supports multiple JSON formats)
     * Accepts:
     * - Edible Tools format: {"market_list": "[...]"} (double-encoded JSON string)
     * - Edible Tools modern: {"market_list": [...]} (proper JSON array)
     * - Direct array: [{listing1}, {listing2}, ...]
     */
    async importEdibleToolsData(jsonText) {
        let progressMsg = null;
        try {
            // Check for truncated file (only if it looks like an object)
            const trimmed = jsonText.trim();
            if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
                throw new Error(
                    'File appears to be truncated or incomplete. The JSON does not end properly. ' +
                        'Try exporting from Edible Tools again, or export to CSV from the Market History Viewer and import that instead.'
                );
            }

            // Parse the file
            const data = JSON.parse(jsonText);

            let marketList;

            // Format 1: Direct array [{}, {}, ...]
            if (Array.isArray(data)) {
                marketList = data;
            }
            // Format 2 & 3: Object with market_list key
            else if (data && typeof data === 'object' && data.market_list) {
                // Format 2a: market_list is a JSON string (Edible Tools legacy format)
                if (typeof data.market_list === 'string') {
                    marketList = JSON.parse(data.market_list);
                }
                // Format 2b: market_list is already an array (Edible Tools modern format)
                else if (Array.isArray(data.market_list)) {
                    marketList = data.market_list;
                } else {
                    throw new Error('market_list must be an array or JSON string containing an array');
                }
            }
            // Unrecognized format
            else {
                throw new Error(
                    'Unrecognized format. Expected:\n' +
                        '- Direct array: [{listing1}, {listing2}, ...]\n' +
                        '- Object format: {"market_list": [...]}\n' +
                        '- Edible Tools format: {"market_list": "[...]"}'
                );
            }

            if (!Array.isArray(marketList) || marketList.length === 0) {
                throw new Error('No listings found in file or array is empty');
            }

            // Show progress message
            progressMsg = document.createElement('div');
            progressMsg.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(10, 10, 20, 0.97);
                border: 1px solid rgba(74, 158, 255, 0.5);
                padding: 20px;
                border-radius: 8px;
                color: #e8ecf5;
                z-index: ${config.Z_MODAL + 1};
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            `;
            progressMsg.textContent = `Importing ${marketList.length} listings...`;
            document.body.appendChild(progressMsg);

            // Convert imported format to Toolasha format
            const existingListings = await estimatedListingAge.personalListings();
            const existingIds = new Set(existingListings.map((l) => l.id));

            let imported = 0;
            let skipped = 0;
            // Imported rows are exact id↔time pairs too — mirror them into the
            // shared anchor pool the same way live recording does
            const newAnchors = [];

            for (const etListing of marketList) {
                // Skip if we already have this listing
                if (existingIds.has(etListing.id)) {
                    skipped++;
                    continue;
                }

                // Convert to Toolasha format
                const toolashaListing = {
                    id: etListing.id,
                    timestamp: new Date(etListing.createdTimestamp).getTime(),
                    createdTimestamp: etListing.createdTimestamp,
                    itemHrid: etListing.itemHrid,
                    enhancementLevel: etListing.enhancementLevel || 0,
                    price: etListing.price,
                    orderQuantity: etListing.orderQuantity,
                    filledQuantity: etListing.filledQuantity,
                    isSell: etListing.isSell,
                };

                existingListings.push(toolashaListing);
                newAnchors.push({ id: toolashaListing.id, timestamp: toolashaListing.timestamp });
                imported++;
            }

            // Save to storage
            await estimatedListingAge.importListings(existingListings);
            await estimatedListingAge.addAnchors(newAnchors);

            // Remove progress message
            document.body.removeChild(progressMsg);

            // Show success message
            alert(
                `Import complete!\n\nImported: ${imported} new listings\nSkipped: ${skipped} duplicates\nTotal: ${existingListings.length} listings`
            );

            // Reload and render table
            await this.loadListings();
            this.renderTable();
        } catch (error) {
            // Remove the progress overlay so a partial failure doesn't leave it stuck on screen
            progressMsg?.remove();
            console.error('[MarketHistoryViewer] Import error:', error);
            throw error;
        }
    }

    /**
     * Delete a single listing by its ID
     * @param {number} listingId
     */
    async deleteListing(listingId) {
        this.listings = this.listings.filter((l) => l.id !== listingId);
        // Persist via estimatedListingAge (single writer for the shared storage key);
        // it also drops the entry from its in-memory copy so the deletion sticks
        await estimatedListingAge.deleteListing(listingId);
        this.applyFilters();
        this.renderTable();
    }

    /**
     * Clear all market history data
     */
    async clearHistory() {
        // Strong confirmation dialog
        const confirmed = confirm(
            `⚠️ WARNING: This will permanently delete ALL market history data!\n` +
                `You are about to delete ${this.listings.length} listings.\n` +
                `RECOMMENDATION: Export to CSV first using the "Export CSV" button.\n` +
                `Anonymous age anchors are kept so age estimates stay accurate.\n` +
                `This action CANNOT be undone!\n` +
                `Are you absolutely sure you want to continue?`
        );

        if (!confirmed) {
            return;
        }

        try {
            // "Clear History" only wipes this character's personal listing log —
            // the item/price/status record of what *you* sold. It deliberately
            // leaves the anonymous {id, timestamp} anchor mirror in place: those
            // pairs carry no item, price, or character info, so keeping them isn't
            // keeping "history", and every other listing's age estimate on this
            // and every other character depends on that shared pool staying intact.
            // Backfill it one last time first, in case any of these listings predate
            // anchor growth and were never mirrored.
            await estimatedListingAge.addAnchors(this.listings.map((l) => ({ id: l.id, timestamp: l.timestamp })));

            // The log's owner clears it: its saves merge what is stored under
            // what is in memory, so a bare empty write here would be refilled
            // from its memory on the next listing event
            await estimatedListingAge.clearPersonalListings();

            // Clear local data
            this.listings = [];
            this.filteredListings = [];

            // Show success message
            alert('Market history cleared successfully.');

            // Reload and render table (will show empty state)
            await this.loadListings();
            this.renderTable();
        } catch (error) {
            console.error('[MarketHistoryViewer] Failed to clear history:', error);
            alert(`Failed to clear history: ${error.message}`);
        }
    }

    /**
     * Get filtered listings excluding a specific filter type
     * Used for dynamic filter options - shows what's available given OTHER active filters
     * @param {string} excludeFilterType - Filter to exclude: 'date', 'item', 'enhancementLevel', 'type'
     * @returns {Array} Filtered listings
     */
    getFilteredListingsExcluding(excludeFilterType) {
        let filtered = [...this.listings];

        // Apply legacy type filter if set
        if (this.typeFilter === 'buy') {
            filtered = filtered.filter((listing) => !listing.isSell);
        } else if (this.typeFilter === 'sell') {
            filtered = filtered.filter((listing) => listing.isSell);
        }

        // Apply search term
        if (this.searchTerm) {
            const term = this.searchTerm.toLowerCase();
            filtered = filtered.filter((listing) => {
                const itemName = this.getItemName(listing.itemHrid).toLowerCase();
                return itemName.includes(term);
            });
        }

        // Apply date range filter (unless excluded)
        if (excludeFilterType !== 'date' && (this.filters.dateFrom || this.filters.dateTo)) {
            filtered = filtered.filter((listing) => {
                const listingDate = new Date(listing.createdTimestamp || listing.timestamp);

                if (this.filters.dateFrom && listingDate < this.filters.dateFrom) {
                    return false;
                }

                if (this.filters.dateTo) {
                    const endOfDay = new Date(this.filters.dateTo);
                    endOfDay.setHours(23, 59, 59, 999);
                    if (listingDate > endOfDay) {
                        return false;
                    }
                }

                return true;
            });
        }

        // Apply item filter (unless excluded)
        if (excludeFilterType !== 'item' && this.filters.selectedItems.length > 0) {
            filtered = filtered.filter((listing) => this.filters.selectedItems.includes(listing.itemHrid));
        }

        // Apply enhancement level filter (unless excluded)
        if (excludeFilterType !== 'enhancementLevel' && this.filters.selectedEnhLevels.length > 0) {
            filtered = filtered.filter((listing) => this.filters.selectedEnhLevels.includes(listing.enhancementLevel));
        }

        // Apply type filter (unless excluded)
        if (
            excludeFilterType !== 'type' &&
            this.filters.selectedTypes.length > 0 &&
            this.filters.selectedTypes.length < 2
        ) {
            const showBuy = this.filters.selectedTypes.includes('buy');
            const showSell = this.filters.selectedTypes.includes('sell');

            filtered = filtered.filter((listing) => {
                if (showBuy && !listing.isSell) return true;
                if (showSell && listing.isSell) return true;
                return false;
            });
        }

        return filtered;
    }

    /**
     * Check if a column has an active filter
     * @param {string} columnKey - Column key to check
     * @returns {boolean} True if filter is active
     */
    hasActiveFilter(columnKey) {
        switch (columnKey) {
            case 'createdTimestamp':
                return this.filters.dateFrom !== null || this.filters.dateTo !== null;
            case 'itemHrid':
                return this.filters.selectedItems.length > 0;
            case 'enhancementLevel':
                return this.filters.selectedEnhLevels.length > 0;
            case 'isSell':
                return this.filters.selectedTypes.length > 0 && this.filters.selectedTypes.length < 2;
            default:
                return false;
        }
    }

    /**
     * Show filter popup for a column
     * @param {string} columnKey - Column key
     * @param {HTMLElement} buttonElement - Button that triggered popup
     */
    showFilterPopup(columnKey, buttonElement) {
        // If clicking the same button that opened the current popup, close it (toggle behavior)
        if (this.activeFilterPopup && this.activeFilterButton === buttonElement) {
            this.activeFilterPopup.remove();
            this.activeFilterPopup = null;
            this.activeFilterButton = null;
            if (this.popupCloseHandler) {
                document.removeEventListener('click', this.popupCloseHandler);
                this.popupCloseHandler = null;
            }
            return;
        }

        // Close any existing popup and remove its event listener
        if (this.activeFilterPopup) {
            this.activeFilterPopup.remove();
            this.activeFilterPopup = null;
        }
        if (this.popupCloseHandler) {
            document.removeEventListener('click', this.popupCloseHandler);
            this.popupCloseHandler = null;
        }

        // Create popup based on column type
        let popup;
        switch (columnKey) {
            case 'createdTimestamp':
                popup = this.createDateFilterPopup();
                break;
            case 'itemHrid':
                popup = this.createItemFilterPopup();
                break;
            case 'enhancementLevel':
                popup = this.createEnhancementFilterPopup();
                break;
            case 'isSell':
                popup = this.createTypeFilterPopup();
                break;
            default:
                return;
        }

        // Position popup below button
        const buttonRect = buttonElement.getBoundingClientRect();
        popup.style.position = 'fixed';
        popup.style.top = `${buttonRect.bottom + 5}px`;
        popup.style.left = `${buttonRect.left}px`;
        popup.style.zIndex = String(config.Z_MODAL + 2);

        document.body.appendChild(popup);
        this.activeFilterPopup = popup;
        this.activeFilterButton = buttonElement; // Track which button opened this popup

        // Close popup when clicking outside
        this.popupCloseHandler = (e) => {
            // Don't close if clicking on date inputs or their calendar pickers
            if (e.target.type === 'date' || e.target.closest('input[type="date"]')) {
                return;
            }

            if (!popup.contains(e.target) && e.target !== buttonElement) {
                popup.remove();
                this.activeFilterPopup = null;
                this.activeFilterButton = null;
                document.removeEventListener('click', this.popupCloseHandler);
                this.popupCloseHandler = null;
            }
        };
        const popupTimeout = setTimeout(() => document.addEventListener('click', this.popupCloseHandler), 10);
        this.timerRegistry.registerTimeout(popupTimeout);
    }

    /**
     * Parse a YYYY-MM-DD date input value as a local date
     * (new Date('YYYY-MM-DD') parses as UTC midnight, shifting the day for users west of UTC)
     * @param {string} dateStr - Date string in YYYY-MM-DD format
     * @returns {Date} Local date at midnight
     */
    parseLocalDate(dateStr) {
        const [year, month, day] = dateStr.split('-').map(Number);
        return new Date(year, month - 1, day);
    }

    /**
     * Format a Date as a YYYY-MM-DD value for date inputs, using local time
     * (toISOString would shift the day for users at non-zero UTC offsets)
     * @param {Date} date - Date to format
     * @returns {string} YYYY-MM-DD string in local time
     */
    formatDateInputValue(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    /**
     * Create date filter popup
     * @returns {HTMLElement} Popup element
     */
    createDateFilterPopup() {
        const popup = document.createElement('div');
        popup.style.cssText = `
            background: #2a2a2a;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 12px;
            min-width: 250px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        `;

        // Title
        const title = document.createElement('div');
        title.textContent = 'Filter by Date';
        title.style.cssText = `
            color: #fff;
            font-weight: bold;
            margin-bottom: 10px;
        `;
        popup.appendChild(title);

        // Get date range from filtered listings (excluding date filter itself)
        // Cache the result to avoid recalculating on every popup open
        if (!this.cachedDateRange) {
            const filteredListings = this.getFilteredListingsExcluding('date');

            if (filteredListings.length > 0) {
                // Use timestamps directly to avoid creating Date objects unnecessarily
                const timestamps = filteredListings.map((l) => l.timestamp || new Date(l.createdTimestamp).getTime());
                this.cachedDateRange = {
                    minDate: new Date(Math.min(...timestamps)),
                    maxDate: new Date(Math.max(...timestamps)),
                };
            } else {
                this.cachedDateRange = { minDate: null, maxDate: null };
            }
        }

        const { minDate, maxDate } = this.cachedDateRange;

        if (minDate && maxDate) {
            // Show available date range
            const rangeInfo = document.createElement('div');
            rangeInfo.style.cssText = `
                color: #aaa;
                font-size: 11px;
                margin-bottom: 10px;
                padding: 6px;
                background: #1a1a1a;
                border-radius: 3px;
            `;
            rangeInfo.textContent = `Available: ${formatDateTime(minDate, { includeTime: false })} - ${formatDateTime(maxDate, { includeTime: false })}`;
            popup.appendChild(rangeInfo);
        }

        // From date
        const fromLabel = document.createElement('label');
        fromLabel.textContent = 'From:';
        fromLabel.style.cssText = `
            display: block;
            color: #aaa;
            margin-bottom: 4px;
            font-size: 12px;
        `;

        const fromInput = document.createElement('input');
        fromInput.type = 'date';
        fromInput.value = this.filters.dateFrom ? this.formatDateInputValue(this.filters.dateFrom) : '';
        if (minDate) fromInput.min = this.formatDateInputValue(minDate);
        if (maxDate) fromInput.max = this.formatDateInputValue(maxDate);
        fromInput.style.cssText = `
            width: 100%;
            padding: 6px;
            background: #1a1a1a;
            border: 1px solid #555;
            border-radius: 3px;
            color: #fff;
            margin-bottom: 10px;
        `;

        // To date
        const toLabel = document.createElement('label');
        toLabel.textContent = 'To:';
        toLabel.style.cssText = `
            display: block;
            color: #aaa;
            margin-bottom: 4px;
            font-size: 12px;
        `;

        const toInput = document.createElement('input');
        toInput.type = 'date';
        toInput.value = this.filters.dateTo ? this.formatDateInputValue(this.filters.dateTo) : '';
        if (minDate) toInput.min = this.formatDateInputValue(minDate);
        if (maxDate) toInput.max = this.formatDateInputValue(maxDate);
        toInput.style.cssText = `
            width: 100%;
            padding: 6px;
            background: #1a1a1a;
            border: 1px solid #555;
            border-radius: 3px;
            color: #fff;
            margin-bottom: 10px;
        `;

        // Buttons
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-top: 10px;
        `;

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = `
            flex: 1;
            padding: 6px;
            background: #4a90e2;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
        `;
        applyBtn.addEventListener('click', () => {
            // Parse as local dates so setHours(23,59,59,999) covers the selected local day
            this.filters.dateFrom = fromInput.value ? this.parseLocalDate(fromInput.value) : null;
            this.filters.dateTo = toInput.value ? this.parseLocalDate(toInput.value) : null;
            this.saveFilters();
            this.applyFilters();
            this.renderTable();
            popup.remove();
            this.activeFilterPopup = null;
            this.activeFilterButton = null;
        });

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText = `
            flex: 1;
            padding: 6px;
            background: #666;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
        `;
        clearBtn.addEventListener('click', () => {
            this.filters.dateFrom = null;
            this.filters.dateTo = null;
            this.saveFilters();
            this.applyFilters();
            this.renderTable();
            popup.remove();
            this.activeFilterPopup = null;
            this.activeFilterButton = null;
        });

        buttonContainer.appendChild(applyBtn);
        buttonContainer.appendChild(clearBtn);

        popup.appendChild(fromLabel);
        popup.appendChild(fromInput);
        popup.appendChild(toLabel);
        popup.appendChild(toInput);
        popup.appendChild(buttonContainer);

        return popup;
    }

    /**
     * Create item filter popup
     * @returns {HTMLElement} Popup element
     */
    createItemFilterPopup() {
        const popup = document.createElement('div');
        popup.style.cssText = `
            background: #2a2a2a;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 12px;
            min-width: 300px;
            max-height: 400px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        `;

        // Title
        const title = document.createElement('div');
        title.textContent = 'Filter by Item';
        title.style.cssText = `
            color: #fff;
            font-weight: bold;
            margin-bottom: 10px;
        `;
        popup.appendChild(title);

        // Search box
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search items...';
        searchInput.style.cssText = `
            width: 100%;
            padding: 6px;
            background: #1a1a1a;
            border: 1px solid #555;
            border-radius: 3px;
            color: #fff;
            margin-bottom: 8px;
        `;

        popup.appendChild(searchInput);

        // Get unique items from filtered listings (excluding item filter itself)
        const filteredListings = this.getFilteredListingsExcluding('item');
        const itemHrids = [...new Set(filteredListings.map((l) => l.itemHrid))];
        const itemsWithNames = itemHrids.map((hrid) => ({
            hrid,
            name: this.getItemName(hrid),
        }));
        itemsWithNames.sort((a, b) => a.name.localeCompare(b.name));

        // Checkboxes container
        const checkboxContainer = document.createElement('div');
        checkboxContainer.style.cssText = `
            flex: 1;
            overflow-y: auto;
            margin-bottom: 10px;
            max-height: 250px;
        `;

        const renderCheckboxes = (filterText = '') => {
            // Explicitly remove all children to ensure proper cleanup
            while (checkboxContainer.firstChild) {
                checkboxContainer.removeChild(checkboxContainer.firstChild);
            }

            const filtered = filterText
                ? itemsWithNames.filter((item) => item.name.toLowerCase().includes(filterText.toLowerCase()))
                : itemsWithNames;

            filtered.forEach((item) => {
                const label = document.createElement('label');
                label.style.cssText = `
                    display: block;
                    color: #fff;
                    padding: 4px;
                    cursor: pointer;
                `;

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = this.filters.selectedItems.includes(item.hrid);
                checkbox.style.marginRight = '6px';

                label.appendChild(checkbox);
                label.appendChild(document.createTextNode(item.name));
                checkboxContainer.appendChild(label);

                checkbox.addEventListener('change', (e) => {
                    if (e.target.checked) {
                        if (!this.filters.selectedItems.includes(item.hrid)) {
                            this.filters.selectedItems.push(item.hrid);
                        }
                    } else {
                        const index = this.filters.selectedItems.indexOf(item.hrid);
                        if (index > -1) {
                            this.filters.selectedItems.splice(index, 1);
                        }
                    }
                });
            });
        };

        renderCheckboxes();
        searchInput.addEventListener('input', (e) => renderCheckboxes(e.target.value));

        popup.appendChild(checkboxContainer);

        // Buttons
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            gap: 8px;
        `;

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = `
            flex: 1;
            padding: 6px;
            background: #4a90e2;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
        `;
        applyBtn.addEventListener('click', () => {
            this.saveFilters();
            this.applyFilters();
            this.renderTable();
            popup.remove();
            this.activeFilterPopup = null;
            this.activeFilterButton = null;
        });

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText = `
            flex: 1;
            padding: 6px;
            background: #666;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
        `;
        clearBtn.addEventListener('click', () => {
            this.filters.selectedItems = [];
            this.saveFilters();
            this.applyFilters();
            this.renderTable();
            popup.remove();
            this.activeFilterPopup = null;
            this.activeFilterButton = null;
        });

        buttonContainer.appendChild(applyBtn);
        buttonContainer.appendChild(clearBtn);
        popup.appendChild(buttonContainer);

        return popup;
    }

    /**
     * Create enhancement level filter popup
     * @returns {HTMLElement} Popup element
     */
    createEnhancementFilterPopup() {
        const popup = document.createElement('div');
        popup.style.cssText = `
            background: #2a2a2a;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 12px;
            min-width: 200px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        `;

        // Title
        const title = document.createElement('div');
        title.textContent = 'Filter by Enhancement Level';
        title.style.cssText = `
            color: #fff;
            font-weight: bold;
            margin-bottom: 10px;
        `;
        popup.appendChild(title);

        // Get unique enhancement levels from filtered listings (excluding enhancement filter itself)
        const filteredListings = this.getFilteredListingsExcluding('enhancementLevel');
        const enhLevels = [...new Set(filteredListings.map((l) => l.enhancementLevel))];
        enhLevels.sort((a, b) => a - b);

        // Checkboxes
        const checkboxContainer = document.createElement('div');
        checkboxContainer.style.cssText = `
            max-height: 250px;
            overflow-y: auto;
            margin-bottom: 10px;
        `;

        enhLevels.forEach((level) => {
            const label = document.createElement('label');
            label.style.cssText = `
                display: block;
                color: #fff;
                padding: 4px;
                cursor: pointer;
            `;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.filters.selectedEnhLevels.includes(level);
            checkbox.style.marginRight = '6px';

            const levelText = level > 0 ? `+${level}` : 'No Enhancement';

            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(levelText));
            checkboxContainer.appendChild(label);

            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    if (!this.filters.selectedEnhLevels.includes(level)) {
                        this.filters.selectedEnhLevels.push(level);
                    }
                } else {
                    const index = this.filters.selectedEnhLevels.indexOf(level);
                    if (index > -1) {
                        this.filters.selectedEnhLevels.splice(index, 1);
                    }
                }
            });
        });

        popup.appendChild(checkboxContainer);

        // Buttons
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            gap: 8px;
        `;

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = `
            flex: 1;
            padding: 6px;
            background: #4a90e2;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
        `;
        applyBtn.addEventListener('click', () => {
            this.saveFilters();
            this.applyFilters();
            this.renderTable();
            popup.remove();
            this.activeFilterPopup = null;
            this.activeFilterButton = null;
        });

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText = `
            flex: 1;
            padding: 6px;
            background: #666;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
        `;
        clearBtn.addEventListener('click', () => {
            this.filters.selectedEnhLevels = [];
            this.saveFilters();
            this.applyFilters();
            this.renderTable();
            popup.remove();
            this.activeFilterPopup = null;
            this.activeFilterButton = null;
        });

        buttonContainer.appendChild(applyBtn);
        buttonContainer.appendChild(clearBtn);
        popup.appendChild(buttonContainer);

        return popup;
    }

    /**
     * Create type filter popup (Buy/Sell)
     * @returns {HTMLElement} Popup element
     */
    createTypeFilterPopup() {
        const popup = document.createElement('div');
        popup.style.cssText = `
            background: #2a2a2a;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 12px;
            min-width: 150px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        `;

        // Title
        const title = document.createElement('div');
        title.textContent = 'Filter by Type';
        title.style.cssText = `
            color: #fff;
            font-weight: bold;
            margin-bottom: 10px;
        `;
        popup.appendChild(title);

        // Check which types exist in filtered listings (excluding type filter itself)
        const filteredListings = this.getFilteredListingsExcluding('type');
        const hasBuyOrders = filteredListings.some((l) => !l.isSell);
        const hasSellOrders = filteredListings.some((l) => l.isSell);

        // Buy checkbox
        if (hasBuyOrders) {
            const buyLabel = document.createElement('label');
            buyLabel.style.cssText = `
                display: block;
                color: #fff;
                padding: 4px;
                cursor: pointer;
                margin-bottom: 6px;
            `;

            const buyCheckbox = document.createElement('input');
            buyCheckbox.type = 'checkbox';
            buyCheckbox.checked = this.filters.selectedTypes.includes('buy');
            buyCheckbox.style.marginRight = '6px';

            buyLabel.appendChild(buyCheckbox);
            buyLabel.appendChild(document.createTextNode('Buy Orders'));
            popup.appendChild(buyLabel);

            buyCheckbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    if (!this.filters.selectedTypes.includes('buy')) {
                        this.filters.selectedTypes.push('buy');
                    }
                } else {
                    const index = this.filters.selectedTypes.indexOf('buy');
                    if (index > -1) {
                        this.filters.selectedTypes.splice(index, 1);
                    }
                }
            });
        }

        // Sell checkbox
        if (hasSellOrders) {
            const sellLabel = document.createElement('label');
            sellLabel.style.cssText = `
                display: block;
                color: #fff;
                padding: 4px;
                cursor: pointer;
            `;

            const sellCheckbox = document.createElement('input');
            sellCheckbox.type = 'checkbox';
            sellCheckbox.checked = this.filters.selectedTypes.includes('sell');
            sellCheckbox.style.marginRight = '6px';

            sellLabel.appendChild(sellCheckbox);
            sellLabel.appendChild(document.createTextNode('Sell Orders'));
            popup.appendChild(sellLabel);

            sellCheckbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    if (!this.filters.selectedTypes.includes('sell')) {
                        this.filters.selectedTypes.push('sell');
                    }
                } else {
                    const index = this.filters.selectedTypes.indexOf('sell');
                    if (index > -1) {
                        this.filters.selectedTypes.splice(index, 1);
                    }
                }
            });
        }

        // Buttons
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-top: 10px;
        `;

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = `
            flex: 1;
            padding: 6px;
            background: #4a90e2;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
        `;
        applyBtn.addEventListener('click', () => {
            this.saveFilters();
            this.applyFilters();
            this.renderTable();
            popup.remove();
            this.activeFilterPopup = null;
            this.activeFilterButton = null;
        });

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText = `
            flex: 1;
            padding: 6px;
            background: #666;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
        `;
        clearBtn.addEventListener('click', () => {
            this.filters.selectedTypes = [];
            this.saveFilters();
            this.applyFilters();
            this.renderTable();
            popup.remove();
            this.activeFilterPopup = null;
            this.activeFilterButton = null;
        });

        buttonContainer.appendChild(applyBtn);
        buttonContainer.appendChild(clearBtn);
        popup.appendChild(buttonContainer);

        return popup;
    }

    /**
     * Clear all active filters
     */
    async clearAllFilters() {
        this.filters.dateFrom = null;
        this.filters.dateTo = null;
        this.filters.selectedItems = [];
        this.filters.selectedEnhLevels = [];
        this.filters.selectedTypes = [];

        await this.saveFilters();
        this.applyFilters();
        this.renderTable();
    }

    /**
     * Disable the feature
     */
    disable() {
        try {
            if (this.unsubscribeMarkers) {
                this.unsubscribeMarkers();
                this.unsubscribeMarkers = null;
            }

            // Disconnect the marketplace-tab watcher and remove the injected tab
            // (nulling the watcher lets addMarketplaceTab recreate it on re-init)
            if (this.tabCleanupObserver) {
                this.tabCleanupObserver();
                this.tabCleanupObserver = null;
            }
            if (this.marketplaceTab) {
                this.marketplaceTab.remove();
                this.marketplaceTab = null;
            }

            // Clean up any active filter popup and its event listener
            if (this.activeFilterPopup) {
                this.activeFilterPopup.remove();
                this.activeFilterPopup = null;
                this.activeFilterButton = null;
            }
            if (this.popupCloseHandler) {
                document.removeEventListener('click', this.popupCloseHandler);
                this.popupCloseHandler = null;
            }

            this.timerRegistry.clearAll();

            // Remove modal and all its event listeners
            if (this.modal) {
                this.modal.remove();
                this.modal = null;
            }

            // Remove settings button
            const button = document.querySelector('.mwi-market-history-button');
            if (button) {
                button.remove();
            }

            // Clear data references
            this.listings = [];
            this.filteredListings = [];
            this.cachedDateRange = null;

            this.isInitialized = false;
        } catch (error) {
            console.error('[Market History Viewer] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const marketHistoryViewer = new MarketHistoryViewer();

export default marketHistoryViewer;
