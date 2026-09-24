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
 *
 * Experience is the one figure on this block that is not sourced that way: the payload behind
 * `offlineItems` carries no experience total, so it is read off the native modal's per-skill
 * experience cells instead (`readExperience`; the retired welcome-back-value.js one-liner this
 * block replaced scraped the text and misread item counts as experience). It is summed per skill the way the modal lists it, and rated per hour against
 * the same `durationSeconds` the Revenue/Cost/Profit per-day figures use — the full time away,
 * not the offline-hour-capped portion — so the rate on this row means the same "per hour offline"
 * as everywhere else in the block.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { calculateOfflineEconomics } from '../../utils/offline-economics-calculator.js';
import { formatPrice } from '../../utils/market-data.js';
import { formatKMB } from '../../utils/formatters.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { PATIENT_TICK_SETTING_KEYS } from '../../utils/patient-tick.js';
import { IRONCOW_VALUATION_SETTING } from '../../utils/ironcow-valuation.js';
import { parseItemCount } from '../../utils/number-parser.js';

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
        this.processedModals = new WeakMap();
        this.currentOfflineData = null;
        this.currentBlock = null;
        this.currentBlockData = null;
        this.currentModalNode = null;
        this.currentModalSignature = null;
        this.pricingModeChangeHandler = null;
        this.modalCleanupUnwatch = null;
        this.incompleteModalObserver = null;
        this.incompleteModalNode = null;
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
        } else {
            this.currentOfflineData = {
                offlineItems,
                currentTimestamp: data.currentTimestamp,
                lastOfflineTime: data.character?.lastOfflineTime,
                offlineHourCap: dataManager.getOfflineHourCap(),
            };
        }

        // The payload may arrive either before or after the game re-renders an already-open
        // modal with it, so both arrival orders have to check for the pairing going stale.
        this.reconcileRenderedBlock();
    }

    /**
     * Drop the cached data and any injected block, so a character switch never shows the
     * previous character's economics.
     */
    handleCharacterSwitching() {
        this.currentOfflineData = null;
        this.stopWatchingIncompleteModal();
        this.teardownBlock();
    }

    /**
     * Process a modal content node (idempotent).
     * @param {Element} node - The matched modal content element
     */
    processModalNode(node) {
        if (!this.currentOfflineData) return;
        // Keyed on the payload the node was last rendered from, not on the node alone: the game
        // reuses the same modal element across a reconnect, and a node-only guard would refuse
        // to rebuild the block while every native field around it switched to the new payload.
        if (this.processedModals.get(node) === this.currentOfflineData) return;

        const renderedData = this.currentOfflineData;
        if (this.renderBlock(node)) {
            this.stopWatchingIncompleteModal();
            this.processedModals.set(node, renderedData);
        } else {
            this.watchIncompleteModal(node);
        }
    }

    /**
     * Retry a modal content node that React inserted before its native anchor children.
     * @param {Element} node - Incomplete modal content element
     */
    watchIncompleteModal(node) {
        if (this.incompleteModalNode === node && this.incompleteModalObserver) return;
        this.stopWatchingIncompleteModal();
        this.incompleteModalNode = node;
        this.incompleteModalObserver = new MutationObserver(() => {
            if (!node.isConnected) {
                this.stopWatchingIncompleteModal();
                return;
            }
            this.processModalNode(node);
        });
        this.incompleteModalObserver.observe(node, { childList: true, subtree: true });
    }

    /** Stop the bounded retry observer for an incomplete modal. */
    stopWatchingIncompleteModal() {
        this.incompleteModalObserver?.disconnect();
        this.incompleteModalObserver = null;
        this.incompleteModalNode = null;
    }

    /**
     * Compute economics and inject the summary block right after the native duration line.
     * @param {Element} modalContentNode - OfflineProgressModal_modalContent element
     * @returns {boolean} Whether the native anchor existed and the block was rendered
     */
    renderBlock(modalContentNode) {
        const anchor = modalContentNode.querySelector(`[class*="${MODAL_ANCHOR_CLASS}"]`);
        const wrapper = anchor?.parentElement;
        if (!wrapper) return false;

        this.teardownBlock();

        try {
            const economics = this.computeEconomics(this.currentOfflineData, modalContentNode);
            const block = buildBlock(economics);
            wrapper.after(block);
            this.currentBlock = block;
            // A reconnect can cache the next offline payload while this native modal
            // still shows the previous one. Pricing changes must retain its snapshot.
            this.currentBlockData = this.currentOfflineData;
            this.currentModalNode = modalContentNode;
            this.currentModalSignature = readNativeSignature(modalContentNode);
        } catch (error) {
            console.error('[Offline Progress Economics] Could not build the summary block:', error);
            return false;
        }

        this.pricingModeChangeHandler = () => this.recompute();
        config.onSettingChange('profitCalc_pricingMode', this.pricingModeChangeHandler);
        for (const key of [...PATIENT_TICK_SETTING_KEYS, IRONCOW_VALUATION_SETTING]) {
            config.onSettingChange(key, this.pricingModeChangeHandler);
        }

        this.setupCleanupObserver(modalContentNode);
        return true;
    }

    /**
     * Recompute and redraw the block in place (e.g. after a pricing mode change).
     */
    recompute() {
        if (!this.currentBlockData || !this.currentBlock) return;
        const economics = this.computeEconomics(this.currentBlockData, this.currentModalNode);
        const newBlock = buildBlock(economics);
        this.currentBlock.replaceWith(newBlock);
        this.currentBlock = newBlock;
    }

    /**
     * Calculate the Revenue/Cost/Profit economics and thread in the one figure they cannot
     * carry: offline experience, read off the modal's own per-skill cells (see `readExperience`)
     * since `offlineItems` has no experience field of its own.
     * @param {Object} offlineData - Cached offline session payload
     * @param {Element|null} modalContentNode - The modal content element to read experience from
     * @returns {Object} calculateOfflineEconomics result, plus `experience` and `experiencePerHour`
     */
    computeEconomics(offlineData, modalContentNode) {
        const economics = calculateOfflineEconomics(offlineData);
        const experience = readExperience(modalContentNode);
        return {
            ...economics,
            experience,
            experiencePerHour:
                experience > 0 && economics.durationSeconds > 0
                    ? (experience * 3600) / economics.durationSeconds
                    : null,
        };
    }

    /**
     * Keep the injected block describing the same offline payload the native modal is showing.
     *
     * A reconnect hands the client a fresh `character_initialized` while the native
     * "Welcome Back!" modal is open, and the game re-renders that *same* modal element with
     * the new payload — new duration, new items, new experience. The block beside them must
     * not go on describing the previous session's haul.
     *
     * Two observable signals have to agree before anything is touched, which is what keeps this
     * apart from a plain "a newer payload exists" guess:
     *  - the cached payload is no longer the object the block was built from (identity compare
     *    against the snapshot captured at render), and
     *  - the modal's own native text has changed since the block was injected.
     * Either alone is not evidence: a reconnect can cache a payload the modal never adopts
     * (the modal keeps showing the old session, and a pricing change must reprice *that*),
     * and the native markup settles with harmless mutations of its own after mount.
     *
     * When both changed, the native fields have already switched, so the block adopts the new
     * payload. When the payload it would have to adopt is gone (an empty reconnect snapshot) or
     * the modal has left the DOM, the block is removed instead: a missing block is recoverable,
     * a headline figure contradicting the rest of the modal is not.
     */
    reconcileRenderedBlock() {
        const modal = this.currentModalNode;
        if (!this.currentBlock || !modal) return;
        if (this.currentOfflineData === this.currentBlockData) return;
        if (readNativeSignature(modal) === this.currentModalSignature) return;

        if (!this.currentOfflineData || !document.body?.contains(modal)) {
            this.teardownBlock();
            return;
        }

        const renderedData = this.currentOfflineData;
        if (this.renderBlock(modal)) {
            this.processedModals.set(modal, renderedData);
        }
    }

    /**
     * Tear the injected block down once the native modal closes.
     *
     * Only one of these watches every runs at a time. A second modal — a
     * different character's, after a switch that left the first modal's
     * element lingering in the DOM rather than removing it synchronously —
     * used to start a second `MutationObserver` on `document.body` without
     * disconnecting the first. Both then kept running: when the *stale*
     * modal was eventually removed, its own watcher fired and called
     * `teardownBlock()` unconditionally, deleting the current character's
     * block and unsubscribing its pricing-mode listener even though that
     * character's own modal was still open. Superseding the old watch here
     * before installing the new one keeps exactly one modal's lifetime tied
     * to `currentBlock` at any moment.
     * @param {Element} modal - OfflineProgressModal_modalContent element
     */
    setupCleanupObserver(modal) {
        if (!document.body) return;

        if (this.modalCleanupUnwatch) {
            this.modalCleanupUnwatch();
        }

        this.modalCleanupUnwatch = createMutationWatcher(
            document.body,
            () => {
                if (!document.body.contains(modal)) {
                    this.teardownBlock();
                    return;
                }
                // Same watch, not a second one: a re-render of the open modal has to be noticed
                // as promptly as its removal, and a second observer on document.body is exactly
                // the duplicate this watch was consolidated to avoid.
                this.reconcileRenderedBlock();
            },
            { childList: true, subtree: true, characterData: true }
        );
    }

    /**
     * Remove the injected block, unsubscribe its pricing-mode listener, and stop
     * watching for the modal that owned it to close.
     */
    teardownBlock() {
        if (this.modalCleanupUnwatch) {
            this.modalCleanupUnwatch();
            this.modalCleanupUnwatch = null;
        }
        if (this.pricingModeChangeHandler) {
            config.offSettingChange('profitCalc_pricingMode', this.pricingModeChangeHandler);
            for (const key of [...PATIENT_TICK_SETTING_KEYS, IRONCOW_VALUATION_SETTING]) {
                config.offSettingChange(key, this.pricingModeChangeHandler);
            }
            this.pricingModeChangeHandler = null;
        }
        if (this.currentBlock) {
            this.currentBlock.remove();
            this.currentBlock = null;
        }
        this.currentBlockData = null;
        this.currentModalNode = null;
        this.currentModalSignature = null;
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
        this.stopWatchingIncompleteModal();
        this.currentOfflineData = null;
        this.processedModals = new WeakMap();

        this.isActive = false;
        this.isInitialized = false;
    }
}

/**
 * Read the native modal's own text, excluding this script's injected block, as a signature of
 * which offline session the game is currently rendering. Walking the tree and skipping the block
 * subtree keeps the signature about the native fields only, so injecting, replacing or removing
 * the block never looks like a re-render.
 * @param {Element} root - OfflineProgressModal_modalContent element
 * @returns {string} Whitespace-normalized text of the native modal content
 */
export function readNativeSignature(root) {
    let text = '';
    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.nodeValue;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.id === UI_ID) return;
        for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Total experience the native modal lists under "Experience gained".
 *
 * Read from the game's own per-skill cells (`OfflineProgressModal_expList` holding one
 * `OfflineProgressModal_skillExperience` per skill: an icon and a bare number), not from the
 * modal's text. The text has no separators between elements, so the item counts above run
 * straight into the "Experience gained" heading — "…131Experience" — and a text scrape read
 * the item counts as experience (1.7M XP from a 45K session). `offlineItems` carries no
 * experience, so the modal is the only source there is.
 *
 * @param {Element|null} root - The native modal content element
 * @returns {number} Experience, zero when none was found
 */
export function readExperience(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;

    let total = 0;
    for (const cell of root.querySelectorAll(
        '[class*="OfflineProgressModal_expList"] [class*="OfflineProgressModal_skillExperience"]'
    )) {
        if (cell.closest(`#${UI_ID}`)) continue;
        const value = parseItemCount(cell.textContent.trim(), 0);
        if (Number.isFinite(value) && value > 0) total += value;
    }
    return total;
}

/**
 * Build the heading tooltip: the active pricing mode, plus — when anything went unpriced — the
 * names of the items missing from the total.
 * @param {Object} economics - calculateOfflineEconomics result
 * @returns {string} Tooltip text
 */
export function buildHeadingTooltip(economics) {
    const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
    let tooltip = `Pricing mode: ${config.getPricingModeDisplayLabel(mode)}`;

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

    // Only economics.experience carries anything real: an economics result from before this row
    // existed (an older/mocked shape) or a modal with no XP wording at all leaves it undefined/0,
    // and a "0 XP (0/hr)" line would be a worse answer than no line, same as the rest of this block.
    if (economics.experience > 0) {
        container.appendChild(
            renderRow('Experience', economics.experience, economics.experiencePerHour, null, null, null, {
                formatValue: (value) => formatKMB(value, 1),
                unitLabel: 'hr',
            })
        );
    }

    const overrunRow = buildOverrunRow(economics);
    if (overrunRow) container.appendChild(overrunRow);

    return container;
}

/**
 * Build the "away past the offline cap" line — the game rewards at most `offlineHourCap` hours
 * of offline progress, and never says so when a longer absence ran past it. Shown only when this
 * haul actually did: within the cap there is nothing extra to report, so no line is built at all.
 *
 * The overrun is costed at this same haul's own rate — profit earned over the hours that
 * actually counted (`economics.overrunValue`, from `calculateOfflineEconomics`) — not a second,
 * invented rate, and is always presented as an estimate since the game never confirms what the
 * missed hours would actually have produced.
 * @param {Object} economics - calculateOfflineEconomics result
 * @returns {Element|null} Row element, or null when the offline window did not exceed the cap
 */
function buildOverrunRow(economics) {
    if (!(economics.overrunHours > 0)) return null;

    const row = document.createElement('div');
    row.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        line-height: 1.5;
        margin-top: 4px;
        padding-top: 4px;
        border-top: 1px solid rgba(255, 255, 255, 0.15);
    `;
    row.title =
        "Estimated at this haul's own rate (profit ÷ capped hours) — the game does not report what the time past the offline cap would have earned.";

    const label = document.createElement('span');
    label.textContent = `Away ${economics.awayHours.toFixed(1)}h (cap ${economics.offlineHourCap}h)`;
    label.style.color = '#cbd5e1';

    const value = document.createElement('span');
    value.textContent = `${economics.overrunHours.toFixed(1)}h over, ~${formatPrice(economics.overrunValue, { decimals: 1 })} missed`;
    value.style.color = config.COLOR_WARNING;
    value.style.fontVariantNumeric = 'tabular-nums';

    row.appendChild(label);
    row.appendChild(value);
    return row;
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
 * @param {Object} [options] - Non-money row formatting overrides
 * @param {Function} [options.formatValue] - `(value) => string`, defaults to a priced format
 * @param {string} [options.unitLabel] - Per-value unit shown after the rate, defaults to 'day'
 * @returns {Element} Row wrapper element
 */
function renderRow(label, value, perDay, side, lines, unvaluedItems, options = {}) {
    const { formatValue = (v) => formatPrice(v, { decimals: 1 }), unitLabel = 'day' } = options;
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
        labelEl.title = `${config.getPricingModeDisplayLabel(mode)} (${side === 'sell' ? 'Sell' : 'Buy'} side)`;
    }

    const valueEl = document.createElement('span');
    const sign = value > 0 && label === 'Profit' ? '+' : '';
    const perDayText = perDay !== null ? ` (${sign}${formatValue(perDay)}/${unitLabel})` : '';
    valueEl.textContent = `${sign}${formatValue(value)}${perDayText}`;
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
