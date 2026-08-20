/**
 * Offline Progress Economics
 *
 * The native Welcome Back modal lists what an idle night produced and what it ate, and never
 * says what any of it was worth. This adds a compact Revenue / Cost / Profit block to that
 * modal, with per-day projections, and lets each side expand into the items behind it.
 *
 * The numbers come from the `init_character_data` payload — the server's own signed item
 * deltas — not from the modal's rendered text, and are priced through the same pricing-mode
 * aware stack as every other profit figure in the script (see offline-economics-calculator).
 * Items that could not be priced are named, not silently folded into the total as zero.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { calculateOfflineEconomics } from '../../utils/offline-economics-calculator.js';
import { formatPrice } from '../../utils/market-data.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';

const UI_ID = 'mwi-offline-economics';
const MODAL_ANCHOR_CLASS = 'OfflineProgressModal_offlineProgress';
const MODAL_CONTENT_CLASS = 'OfflineProgressModal_modalContent';

/** What each `source` on a valued line means, shown as the line's tooltip */
const SOURCE_LABELS = {
    coin: 'Coin face value',
    cowbell: 'Cowbell valuation',
    dungeonToken: 'Dungeon Token shop value',
    expectedValue: 'Expected Value',
    custom: 'Custom price override',
    market: 'Market price',
    taskToken: 'Task Token shop value',
};

class OfflineProgressEconomics {
    constructor() {
        this.isActive = false;
        this.isInitialized = false;
        this.characterInitializedHandler = null;
        this.characterSwitchingHandler = null;
        this.domObserverUnregister = null;
        this.processedModals = new WeakSet();
        this.currentOfflineData = null;
        this.currentBlock = null;
        this.pricingModeChangeHandler = null;
    }

    /**
     * Setup settings listener for feature toggle
     */
    setupSettingListener() {
        config.onSettingChange('offlineProgressEconomics', (value) => {
            if (value) {
                this.initialize();
            } else {
                this.disable();
            }
        });
    }

    /**
     * Initialize the feature
     */
    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('offlineProgressEconomics')) return;

        this.isInitialized = true;

        this.characterInitializedHandler = (data) => this.handleCharacterInitialized(data);
        dataManager.on('character_initialized', this.characterInitializedHandler);

        this.characterSwitchingHandler = () => this.handleCharacterSwitching();
        dataManager.on('character_switching', this.characterSwitchingHandler);

        this.domObserverUnregister = domObserver.onClass('OfflineProgressEconomics', MODAL_CONTENT_CLASS, (node) =>
            this.processModalNode(node)
        );

        // Feature initialization is itself triggered from inside the very first
        // character_initialized event, so by the time this runs that one-time event — the one
        // carrying the offline data — has already fired and will not fire again this session.
        // dataManager cached the payload synchronously in its own early handler, so catch up
        // on it directly rather than relying solely on the live event.
        if (dataManager.characterData) {
            this.handleCharacterInitialized(dataManager.characterData);
        }

        // The native modal renders from that same event, so for the same reason it is very
        // likely already mounted — domObserver only reacts to future insertions.
        document.querySelectorAll(`[class*="${MODAL_CONTENT_CLASS}"]`).forEach((node) => this.processModalNode(node));

        this.isActive = true;
    }

    /**
     * Cache this offline session's data for the next time the modal mounts.
     * @param {Object} data - Full character_initialized payload
     */
    handleCharacterInitialized(data) {
        if (!config.getSetting('offlineProgressEconomics')) return;

        const offlineItems = data?.offlineItems || [];
        if (offlineItems.length === 0) {
            this.currentOfflineData = null;
            return;
        }

        this.currentOfflineData = {
            offlineItems,
            currentTimestamp: data.currentTimestamp,
            lastOfflineTime: data.character?.lastOfflineTime,
        };
    }

    /**
     * Drop the cached data and any injected block, so a character switch never shows the
     * previous character's economics.
     */
    handleCharacterSwitching() {
        this.currentOfflineData = null;
        this.teardownBlock();
    }

    /**
     * Process a modal content node (idempotent).
     * @param {Element} node - The matched modal content element
     */
    processModalNode(node) {
        if (this.processedModals.has(node)) return;
        if (!this.currentOfflineData) return;

        this.processedModals.add(node);
        this.renderBlock(node);
    }

    /**
     * Compute economics and inject the summary block right after the native duration line.
     * @param {Element} modalContentNode - OfflineProgressModal_modalContent element
     */
    renderBlock(modalContentNode) {
        const anchor = modalContentNode.querySelector(`[class*="${MODAL_ANCHOR_CLASS}"]`);
        const wrapper = anchor?.parentElement;
        if (!wrapper) return;

        this.teardownBlock();

        try {
            const economics = calculateOfflineEconomics(this.currentOfflineData);
            const block = buildBlock(economics);
            wrapper.after(block);
            this.currentBlock = block;
        } catch (error) {
            console.error('[Offline Progress Economics] Could not build the summary block:', error);
            return;
        }

        this.pricingModeChangeHandler = () => this.recompute();
        config.onSettingChange('profitCalc_pricingMode', this.pricingModeChangeHandler);

        this.setupCleanupObserver(modalContentNode);
    }

    /**
     * Recompute and redraw the block in place (e.g. after a pricing mode change).
     */
    recompute() {
        if (!this.currentOfflineData || !this.currentBlock) return;
        const economics = calculateOfflineEconomics(this.currentOfflineData);
        const newBlock = buildBlock(economics);
        this.currentBlock.replaceWith(newBlock);
        this.currentBlock = newBlock;
    }

    /**
     * Tear the injected block down once the native modal closes.
     * @param {Element} modal - OfflineProgressModal_modalContent element
     */
    setupCleanupObserver(modal) {
        if (!document.body) return;

        const cleanupObserver = createMutationWatcher(
            document.body,
            () => {
                if (!document.body.contains(modal)) {
                    this.teardownBlock();
                    cleanupObserver();
                }
            },
            { childList: true, subtree: true }
        );
    }

    /**
     * Remove the injected block and unsubscribe its pricing-mode listener.
     */
    teardownBlock() {
        if (this.pricingModeChangeHandler) {
            config.offSettingChange('profitCalc_pricingMode', this.pricingModeChangeHandler);
            this.pricingModeChangeHandler = null;
        }
        if (this.currentBlock) {
            this.currentBlock.remove();
            this.currentBlock = null;
        }
    }

    /**
     * Disable the feature
     */
    disable() {
        if (this.characterInitializedHandler) {
            dataManager.off('character_initialized', this.characterInitializedHandler);
            this.characterInitializedHandler = null;
        }
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }
        if (this.domObserverUnregister) {
            this.domObserverUnregister();
            this.domObserverUnregister = null;
        }

        this.teardownBlock();
        this.currentOfflineData = null;
        this.processedModals = new WeakSet();

        this.isActive = false;
        this.isInitialized = false;
    }
}

/**
 * Build the heading tooltip: the active pricing mode, plus — when anything went unpriced — the
 * names of the items missing from the total.
 * @param {Object} economics - calculateOfflineEconomics result
 * @returns {string} Tooltip text
 */
export function buildHeadingTooltip(economics) {
    const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
    let tooltip = `Pricing mode: ${config.getPricingModeLabel(mode)}`;

    if (economics.isPartial) {
        const names = economics.unvaluedItems.map((item) => getItemDisplayName(item.itemHrid));
        const count = economics.unvaluedItems.length;
        tooltip += ` | Partial - ${count} item${count === 1 ? '' : 's'} could not be valued: ${names.join(', ')}`;
    }

    return tooltip;
}

/**
 * Build the compact Revenue / Cost / Profit block.
 * @param {Object} economics - calculateOfflineEconomics result
 * @returns {Element} Block element
 */
export function buildBlock(economics) {
    const container = document.createElement('div');
    container.id = UI_ID;
    // The modal centers its children, which would otherwise shrink this block to its own
    // content width and jam the collapsed rows together — stretch it to the parent instead.
    container.style.cssText = `
        align-self: stretch;
        justify-self: stretch;
        width: 100%;
        box-sizing: border-box;
        margin: 8px 0;
        padding: 8px 14px;
        background: linear-gradient(180deg, rgba(91, 141, 239, 0.12) 0%, rgba(91, 141, 239, 0.05) 100%);
        border: 1px solid rgba(91, 141, 239, 0.3);
        border-radius: 8px;
        color: #ffffff;
        font-size: 13px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
    `;

    const header = document.createElement('div');
    header.textContent = economics.isPartial ? 'Offline Economics *' : 'Offline Economics';
    header.title = buildHeadingTooltip(economics);
    header.style.cssText = `
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 6px;
        color: #93c5fd;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    `;
    container.appendChild(header);

    container.appendChild(
        renderRow(
            'Revenue',
            economics.revenue,
            economics.revenuePerDay,
            'sell',
            economics.lines.filter((line) => line.side === 'sell').sort((a, b) => b.totalValue - a.totalValue),
            economics.unvaluedItems
                .filter((item) => item.offlineCount > 0)
                .sort((a, b) => b.offlineCount - a.offlineCount)
        )
    );
    container.appendChild(
        renderRow(
            'Cost',
            economics.cost,
            economics.costPerDay,
            'buy',
            economics.lines.filter((line) => line.side === 'buy').sort((a, b) => b.totalValue - a.totalValue),
            economics.unvaluedItems
                .filter((item) => item.offlineCount < 0)
                .sort((a, b) => a.offlineCount - b.offlineCount)
        )
    );
    container.appendChild(renderRow('Profit', economics.profit, economics.profitPerDay, null, null, null));

    return container;
}

/**
 * Resolve a display name for an item, falling back to the HRID tail when game data is not
 * available yet.
 * @param {string} itemHrid - Item HRID
 * @returns {string} Display name
 */
function getItemDisplayName(itemHrid) {
    const details = dataManager.getItemDetails(itemHrid);
    return details?.name || itemHrid.split('/').pop();
}

/**
 * Build one valued line-item detail row.
 * @param {Object} line - A line entry from calculateOfflineEconomics's `lines`
 * @returns {Element} Detail row element
 */
function buildLineDetail(line) {
    const row = document.createElement('div');
    row.style.cssText = `
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-left: 10px;
        font-size: 0.8rem;
        color: ${config.COLOR_TEXT_SECONDARY};
    `;

    const name = getItemDisplayName(line.itemHrid);
    const label = document.createElement('span');
    label.textContent = `${line.quantity}x ${name}${line.enhancementLevel > 0 ? ` +${line.enhancementLevel}` : ''}`;
    label.title = SOURCE_LABELS[line.source] || line.source;

    const value = document.createElement('span');
    value.textContent = formatPrice(line.totalValue, { decimals: 1 });
    value.style.fontVariantNumeric = 'tabular-nums';

    row.appendChild(label);
    row.appendChild(value);
    return row;
}

/**
 * Build one unvalued-item detail row — named rather than shown as a fake zero.
 * @param {Object} item - An entry from calculateOfflineEconomics's `unvaluedItems`
 * @returns {Element} Detail row element
 */
function buildUnvaluedDetail(item) {
    const row = document.createElement('div');
    row.style.cssText = `
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-left: 10px;
        font-size: 0.8rem;
        color: ${config.COLOR_WARNING};
    `;

    const name = getItemDisplayName(item.itemHrid);
    const enhancement = item.enhancementLevel > 0 ? ` +${item.enhancementLevel}` : '';
    row.textContent = `${Math.abs(item.offlineCount)}x ${name}${enhancement} - no price data`;

    return row;
}

/**
 * Render one Revenue/Cost/Profit row: label, total, per-day, and — where there are line items —
 * a click-to-expand breakdown of what is behind that total.
 * @param {string} label - Row label
 * @param {number} value - Total value
 * @param {number|null} perDay - Per-day value, or null when the offline window was zero/invalid
 * @param {'sell'|'buy'|null} side - Which side this row values, for the per-side pricing tooltip
 * @param {Array|null} lines - Valued line items for this side, or null for a non-expandable row
 * @param {Array|null} unvaluedItems - Unvalued items for this side, or null when non-expandable
 * @returns {Element} Row wrapper element
 */
function renderRow(label, value, perDay, side, lines, unvaluedItems) {
    const wrapper = document.createElement('div');

    const hasDetails = (lines && lines.length > 0) || (unvaluedItems && unvaluedItems.length > 0);

    const row = document.createElement('div');
    row.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        line-height: 1.5;
        ${hasDetails ? 'cursor: pointer;' : ''}
    `;

    const labelEl = document.createElement('span');
    labelEl.textContent = hasDetails ? `+ ${label}` : label;
    labelEl.style.color = '#cbd5e1';
    if (side) {
        const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
        labelEl.title = `${config.getPricingModeLabel(mode)} (${side === 'sell' ? 'Sell' : 'Buy'} side)`;
    }

    const valueEl = document.createElement('span');
    const sign = value > 0 && label === 'Profit' ? '+' : '';
    const perDayText = perDay !== null ? ` (${sign}${formatPrice(perDay, { decimals: 1 })}/day)` : '';
    valueEl.textContent = `${sign}${formatPrice(value, { decimals: 1 })}${perDayText}`;
    valueEl.style.color = '#e2e8f0';
    valueEl.style.fontVariantNumeric = 'tabular-nums';

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    wrapper.appendChild(row);

    if (hasDetails) {
        const details = document.createElement('div');
        details.className = 'mwi-offline-economics-details';
        details.style.cssText = 'display: none; margin: 4px 0 2px;';
        for (const line of lines) details.appendChild(buildLineDetail(line));
        for (const item of unvaluedItems) details.appendChild(buildUnvaluedDetail(item));
        wrapper.appendChild(details);

        row.addEventListener('click', () => {
            const isCollapsed = details.style.display === 'none';
            details.style.display = isCollapsed ? 'block' : 'none';
            labelEl.textContent = `${isCollapsed ? '-' : '+'} ${label}`;
        });
    }

    return wrapper;
}

const offlineProgressEconomics = new OfflineProgressEconomics();
offlineProgressEconomics.setupSettingListener();

export default offlineProgressEconomics;
