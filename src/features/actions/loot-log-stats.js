/**
 * Loot Log Statistics Module
 * Adds total value, average time, and daily output statistics to loot logs
 * Port of Edible Tools loot tracker feature, integrated into Toolasha architecture
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { getItemPrices } from '../../utils/market-data.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import { formatKMB, numberFormatter, formatDateTime } from '../../utils/formatters.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';
import { signedPercent } from '../../utils/overlay-format.js';
import {
    buildGatheringSession,
    gatheringLootValue,
    gatheringSessionLuck,
    describeRunLuck,
} from '../../utils/gathering-drop-model.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import lootLogHistory from './loot-log-history.js';

/** The loot log export, one row per item per logged session */
export const LOOT_LOG_CSV_COLUMNS = [
    { key: 'sessionStart', label: 'Session Start' },
    { key: 'action', label: 'Action' },
    { key: 'actionHrid', label: 'Action Hrid' },
    { key: 'item', label: 'Item' },
    { key: 'itemHrid', label: 'Item Hrid' },
    { key: 'quantity', label: 'Quantity' },
    { key: 'askValue', label: 'Ask Value' },
    { key: 'bidValue', label: 'Bid Value' },
];

/**
 * Loot log entries as CSV rows, one per item per session.
 *
 * Pure: the pricing and naming come in as functions, so the arithmetic can be
 * tested without a game. The values are the same figures the panel shows —
 * whatever the resolver prices an item at, times the count — as raw numbers a
 * spreadsheet can sum, not the panel's `1.2K`.
 *
 * Enhancing sessions are skipped, exactly as the panel skips drawing them.
 *
 * @param {Array<Object>} entries - Loot log entries (`{startTime, actionHrid, drops}`)
 * @param {Object} resolve - How to read an entry
 * @param {Function} resolve.itemInfo - `(baseHrid) => {name, askPerItem, bidPerItem}`
 * @param {Function} resolve.actionName - `(actionHrid) => string`
 * @returns {Array<Object>} Rows for `LOOT_LOG_CSV_COLUMNS`
 */
export function buildLootLogRows(entries, { itemInfo, actionName }) {
    const rows = [];
    for (const entry of entries || []) {
        if (!entry?.drops) continue;
        if (entry.actionHrid === '/actions/enhancing/enhance') continue;

        const started = new Date(entry.startTime);
        const sessionStart = Number.isNaN(started.getTime()) ? String(entry.startTime || '') : started.toISOString();
        const action = actionName(entry.actionHrid);

        for (const [hrid, count] of Object.entries(entry.drops)) {
            const baseHrid = hrid.replace(/::\d+$/, '');
            const info = itemInfo(baseHrid);
            rows.push({
                sessionStart,
                action,
                actionHrid: entry.actionHrid,
                item: info.name,
                itemHrid: baseHrid,
                quantity: count,
                askValue: (info.askPerItem || 0) * count,
                bidValue: (info.bidPerItem || 0) * count,
            });
        }
    }
    return rows;
}

class LootLogStats {
    constructor() {
        this.unregisterHandlers = [];
        this.initialized = false;
        this.timerRegistry = createTimerRegistry();
        this.currentLootLogData = null;
        this.itemsSpriteUrl = null;
        this.actionsSpriteUrl = null;
        this.historyEnabled = false;
        this.historicalBatchSize = 20;
        this.historicalRendered = 0;
        // Percentiles already worked out, keyed by what they were worked out
        // from — an entry that has not changed costs a lookup, not a transform
        this.luckCache = new Map();
    }

    /**
     * Initialize loot log statistics feature
     */
    async initialize() {
        if (this.initialized) return;

        const enabled = config.getSetting('lootLogStats');
        if (!enabled) return;

        this.historyEnabled = config.getSetting('lootLogHistory');

        // Listen for loot_log_updated messages from WebSocket
        const wsHandler = (data) => this.handleLootLogUpdate(data);
        webSocketHook.on('loot_log_updated', wsHandler);
        this.unregisterHandlers.push(() => {
            webSocketHook.off('loot_log_updated', wsHandler);
        });

        // Watch for loot log elements in DOM
        const unregisterObserver = domObserver.onClass('LootLogStats', 'LootLogPanel_actionLoot__32gl_', (element) =>
            this.processLootLogElement(element)
        );
        this.unregisterHandlers.push(unregisterObserver);

        // Watch for loot log container to inject historical entries
        if (this.historyEnabled) {
            const unregisterHistoryObserver = domObserver.onClass(
                'LootLogHistory',
                'LootLogPanel_actionLoots__3oTid',
                () => this.renderHistoricalEntries()
            );
            this.unregisterHandlers.push(unregisterHistoryObserver);
        }

        this.initialized = true;
    }

    /**
     * Handle loot_log_updated WebSocket message
     * @param {Object} data - WebSocket message data
     */
    handleLootLogUpdate(data) {
        if (!data || !Array.isArray(data.lootLog)) return;

        // Store loot log data for matching with DOM elements
        this.currentLootLogData = data.lootLog;

        // Persist to history if enabled
        if (this.historyEnabled) {
            lootLogHistory.mergeAndSave(data.lootLog);
        }

        // Process existing loot log elements after short delay
        const timeout = setTimeout(() => {
            const lootLogElements = document.querySelectorAll('.LootLogPanel_actionLoot__32gl_');
            lootLogElements.forEach((element) => this.processLootLogElement(element));

            if (this.historyEnabled) {
                this.renderHistoricalEntries();
            }
        }, 200);

        this.timerRegistry.registerTimeout(timeout);
    }

    /**
     * Process a single loot log DOM element
     * @param {HTMLElement} lootElem - Loot log element
     */
    processLootLogElement(lootElem) {
        // Extract divs
        const divs = lootElem.querySelectorAll('div');
        if (divs.length < 3) return;

        const secondDiv = divs[1]; // Timestamps
        const thirdDiv = divs[2]; // Duration

        // Extract log data — failures are retried on later loot_log_updated messages
        const logData = this.extractLogData(lootElem, secondDiv);
        if (!logData) return;

        // Skip enhancement actions
        if (logData.actionHrid === '/actions/enhancing/enhance') return;

        // Skip re-injection only when the matched log entry hasn't changed since last time;
        // ongoing entries keep updating (endTime/actionCount grow) and must be refreshed
        const stamp = `${logData.endTime || ''}|${logData.actionCount || 0}`;
        if (lootElem.dataset.mwiLootLogStamp === stamp) return;
        lootElem.dataset.mwiLootLogStamp = stamp;

        // Calculate and inject total value
        this.injectTotalValue(secondDiv, logData);

        // Calculate and inject average time and daily output
        this.injectTimeAndDailyOutput(thirdDiv, logData);
    }

    /**
     * Extract log data from DOM element
     * @param {HTMLElement} lootElem - Loot log element
     * @param {HTMLElement} secondDiv - Second div containing timestamps
     * @returns {Object|null} Log data object or null if extraction fails
     */
    extractLogData(lootElem, secondDiv) {
        if (!this.currentLootLogData || !Array.isArray(this.currentLootLogData)) {
            return null;
        }

        // Extract start time from DOM
        const textContent = secondDiv.textContent;
        let utcISOString = '';

        // Try multiple date formats
        const matchCN = textContent.match(/(\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2})/);
        const matchEN = textContent.match(/(\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} (AM|PM))/i);
        const matchDE = textContent.match(/(\d{1,2}\.\d{1,2}\.\d{4}, \d{1,2}:\d{2}:\d{2})/);

        if (matchCN) {
            const localTimeStr = matchCN[1].trim();
            const [y, m, d, h, min, s] = localTimeStr.match(/\d+/g).map(Number);
            const localDate = new Date(y, m - 1, d, h, min, s);
            utcISOString = localDate.toISOString().slice(0, 19);
        } else if (matchEN) {
            const localTimeStr = matchEN[1].trim();
            const localDate = new Date(localTimeStr);
            if (!isNaN(localDate)) {
                utcISOString = localDate.toISOString().slice(0, 19);
            } else {
                return null;
            }
        } else if (matchDE) {
            const localTimeStr = matchDE[1].trim();
            const [datePart, timePart] = localTimeStr.split(', ');
            const [day, month, year] = datePart.split('.').map(Number);
            const [hours, minutes, seconds] = timePart.split(':').map(Number);
            const localDate = new Date(year, month - 1, day, hours, minutes, seconds);
            utcISOString = localDate.toISOString().slice(0, 19);
        } else {
            return null;
        }

        // Find matching log data
        const getLogStartTimeSec = (logObj) => {
            return logObj && logObj.startTime ? logObj.startTime.slice(0, 19) : '';
        };

        let log = null;
        for (const logObj of this.currentLootLogData) {
            if (getLogStartTimeSec(logObj) === utcISOString) {
                log = logObj;
                break;
            }
        }

        return log;
    }

    /**
     * Calculate total value of drops
     * @param {Object} drops - Drops object { [itemHrid]: count, ... }
     * @returns {Object} { askTotal, bidTotal }
     */
    calculateTotalValue(drops) {
        let askTotal = 0;
        let bidTotal = 0;

        if (!drops) return { askTotal, bidTotal };

        for (const [hrid, count] of Object.entries(drops)) {
            // Strip enhancement level from HRID
            const baseHrid = hrid.replace(/::\d+$/, '');

            // Coins are base currency — not in marketplace, face value is 1
            if (baseHrid === '/items/coin') {
                askTotal += count;
                bidTotal += count;
                continue;
            }

            // Check for openable containers (caches, chests) — use expected value
            const itemDetails = dataManager.getItemDetails(baseHrid);
            if (itemDetails?.isOpenable && expectedValueCalculator.isInitialized) {
                const evData = expectedValueCalculator.calculateExpectedValue(baseHrid);
                if (evData && evData.expectedValue > 0) {
                    askTotal += evData.expectedValue * count;
                    bidTotal += evData.expectedValue * count;
                    continue;
                }
            }

            // Get market prices
            const prices = getItemPrices(baseHrid, 0);
            if (!prices) continue;

            const ask = prices.ask || 0;
            const bid = prices.bid || 0;

            askTotal += ask * count;
            bidTotal += bid * count;
        }

        return { askTotal, bidTotal };
    }

    /**
     * Calculate the market cost of inputs consumed by a logged action run.
     * @param {string} actionHrid - Action HRID
     * @param {number} actionCount - Number of completed actions
     * @returns {Object|null} { askCost, bidCost, inputs: [{hrid, name, count, askTotal, bidTotal}] },
     *   or null when the action's inputs cannot be resolved (unknown action, alchemy)
     */
    calculateInputCost(actionHrid, actionCount) {
        if (!actionHrid || !actionCount) return null;

        // Alchemy consumes item-specific inputs not present in actionDetailMap
        if (actionHrid.startsWith('/actions/alchemy/')) return null;

        const actionDetails = dataManager.getActionDetails(actionHrid);
        if (!actionDetails) return null;

        const consumed = (actionDetails.inputItems || []).map((input) => ({
            hrid: input.itemHrid,
            count: (input.count || 0) * actionCount,
        }));
        const upgradeHrid = actionDetails.upgradeItemHrid;
        if (upgradeHrid && !consumed.some((c) => c.hrid === upgradeHrid)) {
            consumed.push({ hrid: upgradeHrid, count: actionCount });
        }

        let askCost = 0;
        let bidCost = 0;
        const inputs = [];
        for (const { hrid, count } of consumed) {
            let askPerItem = 1;
            let bidPerItem = 1;
            let name = 'Coins';
            if (hrid !== '/items/coin') {
                const prices = getItemPrices(hrid, 0);
                askPerItem = prices?.ask || 0;
                bidPerItem = prices?.bid || 0;
                name = dataManager.getItemDetails(hrid)?.name || hrid.split('/').pop().replace(/_/g, ' ');
            }
            askCost += askPerItem * count;
            bidCost += bidPerItem * count;
            inputs.push({ hrid, name, count, askTotal: askPerItem * count, bidTotal: bidPerItem * count });
        }

        return { askCost, bidCost, inputs };
    }

    /**
     * Calculate profit for a logged action run: drop revenue after market tax
     * minus the cost of consumed inputs.
     * @param {Object} logData - Log entry ({actionHrid, actionCount, drops})
     * @returns {Object|null} { askProfit, bidProfit, inputs } or null when not computable
     */
    calculateProfit(logData) {
        if (!logData?.drops) return null;

        const inputCost = this.calculateInputCost(logData.actionHrid, logData.actionCount);
        if (!inputCost) return null;

        // Revenue after the 2% marketplace tax (coins are untaxed face value)
        let askRevenue = 0;
        let bidRevenue = 0;
        for (const [hrid, count] of Object.entries(logData.drops)) {
            const baseHrid = hrid.replace(/::\d+$/, '');
            if (baseHrid === '/items/coin') {
                askRevenue += count;
                bidRevenue += count;
                continue;
            }
            const { askTotal, bidTotal } = this.calculateTotalValue({ [hrid]: count });
            askRevenue += askTotal * (1 - MARKET_TAX);
            bidRevenue += bidTotal * (1 - MARKET_TAX);
        }

        return {
            askProfit: askRevenue - inputCost.askCost,
            bidProfit: bidRevenue - inputCost.bidCost,
            inputs: inputCost.inputs,
        };
    }

    /**
     * Calculate the expected total value for a completed run of `actionCount` actions,
     * from the action's drop table odds (drop rate × average count) rather than what was
     * actually rolled. Mirrors `calculateTotalValue`'s price resolution (coins at face
     * value, openable containers priced via expected value) so the two totals are directly
     * comparable — this is only available for actions with a static drop table (gathering);
     * combat drops come from the monster, not the action, and production has none.
     * @param {string} actionHrid - Action HRID
     * @param {number} actionCount - Number of completed actions
     * @returns {Object|null} { askExpected, bidExpected } or null when unavailable
     */
    calculateExpectedRunValue(actionHrid, actionCount) {
        if (!actionHrid || !actionCount) return null;

        const actionDetails = dataManager.getActionDetails(actionHrid);
        const dropTable = actionDetails?.dropTable;
        if (!dropTable || dropTable.length === 0) return null;

        let askExpected = 0;
        let bidExpected = 0;
        let hasAnyPrice = false;

        for (const drop of dropTable) {
            const dropRate = drop.dropRate || 0;
            const avgCount = ((drop.minCount || 0) + (drop.maxCount || 0)) / 2;
            if (dropRate <= 0 || avgCount <= 0) continue;

            const expectedCount = dropRate * avgCount * actionCount;

            if (drop.itemHrid === '/items/coin') {
                askExpected += expectedCount;
                bidExpected += expectedCount;
                hasAnyPrice = true;
                continue;
            }

            const itemDetails = dataManager.getItemDetails(drop.itemHrid);
            if (itemDetails?.isOpenable && expectedValueCalculator.isInitialized) {
                const evData = expectedValueCalculator.calculateExpectedValue(drop.itemHrid);
                if (evData && evData.expectedValue > 0) {
                    askExpected += evData.expectedValue * expectedCount;
                    bidExpected += evData.expectedValue * expectedCount;
                    hasAnyPrice = true;
                    continue;
                }
            }

            const prices = getItemPrices(drop.itemHrid, 0);
            if (!prices) continue;

            askExpected += (prices.ask || 0) * expectedCount;
            bidExpected += (prices.bid || 0) * expectedCount;
            hasAnyPrice = true;
        }

        if (!hasAnyPrice) return null;

        return { askExpected, bidExpected };
    }

    /**
     * Pick a display color for an ask/bid profit pair.
     * @param {number} askProfit
     * @param {number} bidProfit
     * @returns {string} CSS color
     */
    getProfitColor(askProfit, bidProfit) {
        if (bidProfit >= 0) return config.COLOR_PROFIT;
        if (askProfit < 0) return config.COLOR_LOSS;
        return config.COLOR_GOLD;
    }

    /**
     * Calculate average time per action
     * @param {string} startTime - ISO start time
     * @param {string} endTime - ISO end time
     * @param {number} actionCount - Number of actions
     * @returns {number} Average time in seconds, or 0 if invalid
     */
    calculateAverageTime(startTime, endTime, actionCount) {
        if (!startTime || !endTime || !actionCount || actionCount === 0) {
            return 0;
        }

        const duration = (new Date(endTime) - new Date(startTime)) / 1000;
        if (duration <= 0) return 0;

        return duration / actionCount;
    }

    /**
     * Calculate daily output value
     * @param {number} totalValue - Total value
     * @param {number} durationSeconds - Duration in seconds
     * @returns {number} Daily output value, or 0 if invalid
     */
    calculateDailyOutput(totalValue, durationSeconds) {
        if (!totalValue || !durationSeconds || durationSeconds === 0) {
            return 0;
        }

        return (totalValue * 86400) / durationSeconds;
    }

    /**
     * Format duration for display
     * @param {number} seconds - Duration in seconds
     * @returns {string} Formatted duration string
     */
    formatDuration(seconds) {
        if (seconds === 0 || !seconds) return '—';
        if (seconds < 60) return `${seconds.toFixed(2)}s`;

        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.round(seconds % 60);

        let str = '';
        if (h > 0) str += `${h}h`;
        if (m > 0 || h > 0) str += `${m}m`;
        str += `${s}s`;

        return str;
    }

    /**
     * Inject expandable total value into second div
     * @param {HTMLElement} secondDiv - Second div element
     * @param {Object} logData - Log data object
     */
    injectTotalValue(secondDiv, logData) {
        // Remove existing value element
        const oldValue = secondDiv.querySelector('.mwi-loot-log-value');
        if (oldValue) oldValue.remove();

        if (!logData || !logData.drops) return;

        // Calculate total value
        const { askTotal, bidTotal } = this.calculateTotalValue(logData.drops);

        // Create wrapper div
        const wrapper = document.createElement('div');
        wrapper.className = 'mwi-loot-log-value';
        wrapper.style.cssText = 'float: right; margin-left: 8px;';

        // Create header (clickable total value line)
        const header = document.createElement('span');
        header.style.cssText = `color: ${config.COLOR_GOLD}; font-weight: bold;`;

        if (askTotal === 0 && bidTotal === 0) {
            header.textContent = 'Total Value: —';
            wrapper.appendChild(header);
            secondDiv.appendChild(wrapper);
            return;
        }

        header.textContent = `▶ Total Value: ${formatKMB(askTotal)}/${formatKMB(bidTotal)}`;
        header.style.cursor = 'pointer';
        wrapper.appendChild(header);

        // Profit line (revenue after tax minus consumed inputs)
        const profit = this.calculateProfit(logData);
        if (profit) {
            const profitLine = document.createElement('div');
            profitLine.style.cssText = `text-align: right; font-weight: bold; color: ${this.getProfitColor(profit.askProfit, profit.bidProfit)};`;
            profitLine.textContent = `Profit: ${formatKMB(profit.askProfit)}/${formatKMB(profit.bidProfit)}`;
            wrapper.appendChild(profitLine);
        }

        // Actual-vs-expected line — only available for actions with a static drop table
        // (gathering); combat and production have no comparable per-action baseline here.
        const expected = this.calculateExpectedRunValue(logData.actionHrid, logData.actionCount);
        if (expected && (expected.askExpected > 0 || expected.bidExpected > 0)) {
            const basisExpected = expected.askExpected > 0 ? expected.askExpected : expected.bidExpected;
            const basisActual = expected.askExpected > 0 ? askTotal : bidTotal;
            const ratio = signedPercent(((basisActual - basisExpected) / basisExpected) * 100);

            const expectedLine = document.createElement('div');
            expectedLine.style.cssText = 'text-align: right; font-size: 0.9em; color: #aaa;';
            expectedLine.textContent = `Expected: ${formatKMB(expected.askExpected)}/${formatKMB(expected.bidExpected)} (`;

            const ratioSpan = document.createElement('span');
            ratioSpan.style.cssText = `color: ${ratio.color}; font-weight: bold;`;
            ratioSpan.textContent = `${ratio.text} of expected`;
            expectedLine.appendChild(ratioSpan);
            expectedLine.appendChild(document.createTextNode(')'));

            wrapper.appendChild(expectedLine);
        }

        // Drop-luck verdict — the expected line's other half. "−12% of
        // expected" cannot say whether that is routine or remarkable; the
        // percentile can, and on a table whose value rides on one rare drop the
        // two answers genuinely differ.
        this.injectDropLuck(wrapper, logData);

        // Create details container (hidden by default)
        const details = this.buildItemBreakdown(logData.drops, profit?.inputs);
        details.style.display = 'none';
        wrapper.appendChild(details);

        // Toggle on click
        header.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = details.style.display !== 'none';
            details.style.display = isOpen ? 'none' : 'block';
            const text = header.textContent;
            header.textContent = isOpen ? text.replace('▼', '▶') : text.replace('▶', '▼');
        });

        secondDiv.appendChild(wrapper);
    }

    /**
     * The price the drop-luck model uses for an item, ask side.
     *
     * Mirrors `calculateTotalValue`'s resolution — coins at face value,
     * openable containers at expected value, everything else at market ask —
     * because the distribution and the income measured against it must share
     * one price source or the comparison measures pricing gaps rather than
     * luck. Ask rather than bid to match the basis the Expected line prefers.
     *
     * @param {string} itemHrid - Base item HRID (no enhancement suffix)
     * @returns {number|null} Price in coins, or null when the item has none
     */
    getModelPrice(itemHrid) {
        if (itemHrid === '/items/coin') return 1;

        const itemDetails = dataManager.getItemDetails(itemHrid);
        if (itemDetails?.isOpenable && expectedValueCalculator.isInitialized) {
            const evData = expectedValueCalculator.calculateExpectedValue(itemHrid);
            if (evData && evData.expectedValue > 0) return evData.expectedValue;
        }

        const ask = getItemPrices(itemHrid, 0)?.ask;
        return ask > 0 ? ask : null;
    }

    /**
     * Bind a log entry to the gathering drop model.
     *
     * Null carries the model's own floors through — no completed actions, no
     * static drop table (production, combat, alchemy), or nothing in the table
     * with a price means no verdict rather than a made-up one.
     *
     * @param {Object} logData - Log entry ({actionHrid, actionCount, drops})
     * @returns {{session: Object, income: number}|null}
     */
    buildLuckReading(logData) {
        if (!logData?.drops) return null;

        const session = buildGatheringSession({
            actionDetail: dataManager.getActionDetails(logData.actionHrid),
            actionCount: logData.actionCount,
            priceOf: (itemHrid) => this.getModelPrice(itemHrid),
        });
        if (!session) return null;

        return { session, income: gatheringLootValue(session, logData.drops) };
    }

    /**
     * Add the drop-luck line to a loot entry's value block.
     *
     * The placeholder goes in synchronously and the transform runs off a
     * timeout, as the combat verdict does — the inversion is milliseconds per
     * entry but a loot log holds many entries, and none of them should stall
     * the injection pass.
     *
     * @param {HTMLElement} wrapper - The `.mwi-loot-log-value` block
     * @param {Object} logData - Log entry ({actionHrid, actionCount, drops})
     */
    injectDropLuck(wrapper, logData) {
        if (!config.getSetting('lootLogDropLuck')) return;

        const reading = this.buildLuckReading(logData);
        if (!reading) return;

        const line = document.createElement('div');
        line.className = 'mwi-loot-log-luck';
        line.style.cssText = 'text-align: right; font-size: 0.9em; color: #aaa;';
        line.textContent = 'Drop luck: working it out…';
        wrapper.appendChild(line);

        const deferred = setTimeout(() => this.fillInDropLuck(line, reading, logData), 0);
        this.timerRegistry.registerTimeout(deferred);
    }

    /**
     * Replace the placeholder with the verdict, or remove it if there is none.
     * @param {HTMLElement} line - The row to fill in
     * @param {Object} reading - From `buildLuckReading`
     * @param {Object} logData - The entry the reading came from, for the cache key
     */
    fillInDropLuck(line, reading, logData) {
        try {
            const key = `${logData.actionHrid}|${logData.actionCount}|${Math.round(reading.income)}`;
            let percentile = this.luckCache.get(key);
            if (percentile === undefined) {
                percentile = gatheringSessionLuck(reading.session, reading.income).percentile;
                // Prices move and entries churn; the cache is a session-length
                // convenience, not a store, so it is dropped rather than evicted
                if (this.luckCache.size > 200) this.luckCache.clear();
                this.luckCache.set(key, percentile);
            }

            const { text, tone } = describeRunLuck(percentile);
            const color = { lucky: config.COLOR_PROFIT, unlucky: config.COLOR_LOSS, normal: '#aaa' }[tone];

            line.style.color = color;
            line.textContent = `Drop luck: ${text}`;
            line.title = [
                `Value of ${numberFormatter(logData.actionCount)} actions' drops, against every outcome ` +
                    'those actions could have had. 50 is typical; 5 means nineteen runs in twenty do better.',
                'Drops with no market price are left out of both sides.',
                "Essence and rare-find drops are not in the action's own drop table, so they are left out of " +
                    'both sides too. Gathering-quantity buffs are not modelled; a buffed run reads high.',
            ].join('\n');
        } catch (error) {
            console.error('[LootLogStats] Drop luck calculation failed:', error);
            line.remove();
        }
    }

    /**
     * Build item breakdown table for the expandable details
     * @param {Object} drops - Drops object { [itemHrid]: count, ... }
     * @param {Array<Object>} [inputs] - Consumed inputs [{hrid, name, count, askTotal, bidTotal}]
     * @returns {HTMLElement} Details container element
     */
    buildItemBreakdown(drops, inputs) {
        const container = document.createElement('div');
        container.style.cssText = `
            clear: both;
            margin-top: 4px;
            padding: 4px 0;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            font-weight: normal;
            font-size: 0.9em;
        `;

        // Build item rows with calculated values
        const items = [];
        for (const [hrid, count] of Object.entries(drops)) {
            const baseHrid = hrid.replace(/::\d+$/, '');
            const { name, askPerItem, bidPerItem } = this.resolveItemPricing(baseHrid);

            items.push({
                hrid: baseHrid,
                name,
                count,
                askPerItem,
                bidPerItem,
                askTotal: askPerItem * count,
                bidTotal: bidPerItem * count,
            });
        }

        // Sort by ask total descending
        items.sort((a, b) => b.askTotal - a.askTotal);

        // Build rows
        for (const item of items) {
            const row = document.createElement('div');
            row.style.cssText = `
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 2px 0;
                white-space: nowrap;
            `;

            // Item icon
            const icon = this.createItemIcon(item.hrid, 16);
            if (icon) {
                row.appendChild(icon);
            }

            // Item name
            const nameSpan = document.createElement('span');
            nameSpan.textContent = item.name;
            nameSpan.style.cssText = `
                color: #fff;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                flex-shrink: 1;
            `;
            row.appendChild(nameSpan);

            // Quantity
            const qtySpan = document.createElement('span');
            qtySpan.textContent = `×${numberFormatter(item.count)}`;
            qtySpan.style.cssText = `color: #aaa; flex-shrink: 0;`;
            row.appendChild(qtySpan);

            // Spacer
            const spacer = document.createElement('span');
            spacer.style.cssText = 'flex: 1;';
            row.appendChild(spacer);

            // Stack total ask/bid
            const totalSpan = document.createElement('span');
            totalSpan.style.cssText = `color: ${config.COLOR_GOLD}; flex-shrink: 0; text-align: right;`;

            if (item.askTotal > 0 || item.bidTotal > 0) {
                totalSpan.textContent = `${formatKMB(item.askTotal)}/${formatKMB(item.bidTotal)}`;
            } else {
                totalSpan.textContent = '—';
            }
            row.appendChild(totalSpan);

            container.appendChild(row);
        }

        // Consumed input rows (shown as negative costs)
        if (inputs?.length) {
            const divider = document.createElement('div');
            divider.style.cssText = `
                margin-top: 4px;
                padding: 2px 0;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                color: #888;
                font-size: 0.9em;
            `;
            divider.textContent = 'Inputs consumed';
            container.appendChild(divider);

            for (const input of inputs) {
                const row = document.createElement('div');
                row.style.cssText = `
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 2px 0;
                    white-space: nowrap;
                `;

                const icon = this.createItemIcon(input.hrid, 16);
                if (icon) row.appendChild(icon);

                const nameSpan = document.createElement('span');
                nameSpan.textContent = input.name;
                nameSpan.style.cssText = `
                    color: #fff;
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    flex-shrink: 1;
                `;
                row.appendChild(nameSpan);

                const qtySpan = document.createElement('span');
                qtySpan.textContent = `×${numberFormatter(input.count)}`;
                qtySpan.style.cssText = 'color: #aaa; flex-shrink: 0;';
                row.appendChild(qtySpan);

                const spacer = document.createElement('span');
                spacer.style.cssText = 'flex: 1;';
                row.appendChild(spacer);

                const costSpan = document.createElement('span');
                costSpan.style.cssText = `color: ${config.COLOR_LOSS}; flex-shrink: 0; text-align: right;`;
                if (input.askTotal > 0 || input.bidTotal > 0) {
                    costSpan.textContent = `−${formatKMB(input.askTotal)}/−${formatKMB(input.bidTotal)}`;
                } else {
                    costSpan.textContent = '—';
                }
                row.appendChild(costSpan);

                container.appendChild(row);
            }
        }

        return container;
    }

    /**
     * How one item is named and priced, the same way everywhere.
     *
     * Coins at face value, openable containers at their expected value,
     * everything else at the market — the resolution `buildItemBreakdown` has
     * always used, pulled out so the CSV export prices a drop identically to
     * the row on screen.
     *
     * @param {string} baseHrid - Item HRID with any enhancement level stripped
     * @returns {{name: string, askPerItem: number, bidPerItem: number}}
     */
    resolveItemPricing(baseHrid) {
        if (baseHrid === '/items/coin') {
            return { name: 'Coins', askPerItem: 1, bidPerItem: 1 };
        }

        const itemDetails = dataManager.getItemDetails(baseHrid);
        const name = itemDetails?.name || baseHrid.split('/').pop().replace(/_/g, ' ');
        let askPerItem = 0;
        let bidPerItem = 0;

        // Check for openable containers — use expected value
        if (itemDetails?.isOpenable && expectedValueCalculator.isInitialized) {
            const evData = expectedValueCalculator.calculateExpectedValue(baseHrid);
            if (evData && evData.expectedValue > 0) {
                askPerItem = evData.expectedValue;
                bidPerItem = evData.expectedValue;
            }
        }

        // Fall back to market prices
        if (askPerItem === 0 && bidPerItem === 0) {
            const prices = getItemPrices(baseHrid, 0);
            if (prices) {
                askPerItem = prices.ask || 0;
                bidPerItem = prices.bid || 0;
            }
        }

        return { name, askPerItem, bidPerItem };
    }

    /**
     * Create an SVG item icon element
     * @param {string} itemHrid - Item HRID
     * @param {number} size - Icon size in pixels
     * @returns {SVGElement|null} SVG element or null if sprite URL unavailable
     */
    createItemIcon(itemHrid, size) {
        const spriteUrl = this.getItemsSpriteUrl();
        if (!spriteUrl) return null;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.style.flexShrink = '0';

        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        const iconName = itemHrid.split('/').pop();
        use.setAttribute('href', `${spriteUrl}#${iconName}`);
        svg.appendChild(use);

        return svg;
    }

    /**
     * Get the items sprite URL (cached after first lookup)
     * @returns {string|null} Sprite URL or null
     */
    getItemsSpriteUrl() {
        if (!this.itemsSpriteUrl) {
            const el = document.querySelector('use[href*="items_sprite"]');
            if (el) {
                const href = el.getAttribute('href');
                this.itemsSpriteUrl = href ? href.split('#')[0] : null;
            }
        }
        return this.itemsSpriteUrl;
    }

    /**
     * Inject average time and daily output into third div
     * @param {HTMLElement} thirdDiv - Third div element
     * @param {Object} logData - Log data object
     */
    injectTimeAndDailyOutput(thirdDiv, logData) {
        // Remove existing spans
        const oldAvgTime = thirdDiv.querySelector('.mwi-loot-log-avgtime');
        if (oldAvgTime) oldAvgTime.remove();
        const oldDayValue = thirdDiv.querySelector('.mwi-loot-log-day-value');
        if (oldDayValue) oldDayValue.remove();
        const oldDayProfit = thirdDiv.querySelector('.mwi-loot-log-day-profit');
        if (oldDayProfit) oldDayProfit.remove();

        if (!logData) return;

        // Calculate duration
        let duration = 0;
        if (logData.startTime && logData.endTime) {
            duration = (new Date(logData.endTime) - new Date(logData.startTime)) / 1000;
        }

        // Calculate average time
        const avgTime = this.calculateAverageTime(logData.startTime, logData.endTime, logData.actionCount);

        // Create average time span
        const avgTimeSpan = document.createElement('span');
        avgTimeSpan.className = 'mwi-loot-log-avgtime';
        avgTimeSpan.textContent = `⏱${this.formatDuration(avgTime)}`;
        avgTimeSpan.style.marginRight = '16px';
        avgTimeSpan.style.marginLeft = '2ch';
        avgTimeSpan.style.color = config.COLOR_INFO;
        avgTimeSpan.style.fontWeight = 'bold';
        thirdDiv.appendChild(avgTimeSpan);

        // Calculate total value for daily output
        const { askTotal, bidTotal } = this.calculateTotalValue(logData.drops);
        const dayValueAsk = this.calculateDailyOutput(askTotal, duration);
        const dayValueBid = this.calculateDailyOutput(bidTotal, duration);

        // Create daily output span
        const dayValueSpan = document.createElement('span');
        dayValueSpan.className = 'mwi-loot-log-day-value';

        if (dayValueAsk === 0 && dayValueBid === 0) {
            dayValueSpan.textContent = 'Daily Output: —';
        } else {
            dayValueSpan.textContent = `Daily Output: ${formatKMB(dayValueAsk)}/${formatKMB(dayValueBid)}`;
        }

        dayValueSpan.style.float = 'right';
        dayValueSpan.style.color = config.COLOR_GOLD;
        dayValueSpan.style.fontWeight = 'bold';
        dayValueSpan.style.marginLeft = '8px';
        thirdDiv.appendChild(dayValueSpan);

        // Daily profit (after tax and input costs), extrapolated to 24h
        // Appended after dayValueSpan so the float places it to its left
        const profit = this.calculateProfit(logData);
        if (profit && duration > 0) {
            const dayProfitSpan = document.createElement('span');
            dayProfitSpan.className = 'mwi-loot-log-day-profit';
            const dayProfitAsk = (profit.askProfit * 86400) / duration;
            const dayProfitBid = (profit.bidProfit * 86400) / duration;
            dayProfitSpan.textContent = `Daily Profit: ${formatKMB(dayProfitAsk)}/${formatKMB(dayProfitBid)}`;
            dayProfitSpan.style.float = 'right';
            dayProfitSpan.style.color = this.getProfitColor(dayProfitAsk, dayProfitBid);
            dayProfitSpan.style.fontWeight = 'bold';
            dayProfitSpan.style.marginLeft = '8px';
            thirdDiv.appendChild(dayProfitSpan);
        }
    }

    /**
     * Render historical entries below native loot log entries
     */
    async renderHistoricalEntries() {
        const container = document.querySelector('.LootLogPanel_actionLoots__3oTid');
        if (!container) return;

        // Remove existing historical section
        const existing = container.querySelector('.mwi-loot-log-history');
        if (existing) existing.remove();

        if (!this.currentLootLogData) return;

        // Build set of current IDs
        const currentIds = new Set(this.currentLootLogData.map((e) => e.characterActionId));

        // Get historical entries not in current set
        const historicalEntries = await lootLogHistory.getHistoricalEntries(currentIds);
        if (historicalEntries.length === 0) return;

        // Create separator
        const separator = document.createElement('div');
        separator.style.cssText = `
            text-align: center;
            padding: 8px 0;
            margin-top: 8px;
            border-top: 1px solid rgba(96, 165, 250, 0.3);
            color: rgba(96, 165, 250, 0.7);
            font-size: 0.85em;
        `;
        separator.textContent = `— Historical Entries (${historicalEntries.length}) —`;

        // Create wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'mwi-loot-log-history';
        wrapper.appendChild(separator);
        wrapper.appendChild(this.buildCsvExportBar());

        // Render first batch
        this.historicalRendered = 0;
        const batch = historicalEntries.slice(0, this.historicalBatchSize);
        for (const entry of batch) {
            const el = this.renderHistoricalEntry(entry);
            if (el) wrapper.appendChild(el);
        }
        this.historicalRendered = batch.length;

        // "Show more" button if needed
        if (historicalEntries.length > this.historicalBatchSize) {
            const showMoreBtn = document.createElement('button');
            showMoreBtn.className = 'mwi-loot-log-history-more';
            showMoreBtn.textContent = `Show more (${historicalEntries.length - this.historicalRendered} remaining)`;
            showMoreBtn.style.cssText = `
                display: block;
                width: 100%;
                margin-top: 8px;
                padding: 6px;
                background: rgba(96, 165, 250, 0.1);
                border: 1px solid rgba(96, 165, 250, 0.3);
                border-radius: 4px;
                color: rgba(96, 165, 250, 0.8);
                cursor: pointer;
                font-size: 0.85em;
            `;
            showMoreBtn.addEventListener('click', () => {
                const nextBatch = historicalEntries.slice(
                    this.historicalRendered,
                    this.historicalRendered + this.historicalBatchSize
                );
                for (const entry of nextBatch) {
                    const el = this.renderHistoricalEntry(entry);
                    if (el) wrapper.insertBefore(el, showMoreBtn);
                }
                this.historicalRendered += nextBatch.length;
                const remaining = historicalEntries.length - this.historicalRendered;
                if (remaining <= 0) {
                    showMoreBtn.remove();
                } else {
                    showMoreBtn.textContent = `Show more (${remaining} remaining)`;
                }
            });
            wrapper.appendChild(showMoreBtn);
        }

        container.appendChild(wrapper);
    }

    /**
     * An Export CSV bar for the loot log, current and historical sessions both.
     *
     * Built only from `renderHistoricalEntries`, which has already established
     * there are entries to write. The rows are gathered at click time rather
     * than render time, so an export taken an hour after the panel was drawn
     * carries the sessions recorded since.
     *
     * @returns {HTMLElement} The bar
     */
    buildCsvExportBar() {
        const bar = document.createElement('div');
        bar.dataset.csvExport = 'loot-log';
        bar.style.cssText = 'display: flex; justify-content: flex-end; margin: 4px 0;';

        const button = document.createElement('button');
        button.textContent = 'Export CSV';
        button.title = 'Save every logged session as a spreadsheet — one row per item per session, raw numbers.';
        button.style.cssText = `
            padding: 2px 8px;
            background: rgba(96, 165, 250, 0.1);
            border: 1px solid rgba(96, 165, 250, 0.3);
            border-radius: 4px;
            color: rgba(96, 165, 250, 0.8);
            cursor: pointer;
            font-size: 0.85em;
        `;
        button.addEventListener('click', async () => {
            try {
                const current = this.currentLootLogData || [];
                const currentIds = new Set(current.map((e) => e.characterActionId));
                const historical = await lootLogHistory.getHistoricalEntries(currentIds);
                const rows = buildLootLogRows([...current, ...historical], {
                    itemInfo: (baseHrid) => this.resolveItemPricing(baseHrid),
                    actionName: (actionHrid) => this.getActionName(actionHrid),
                });
                if (!rows.length) return;
                downloadCsv(csvFilename('loot-log'), toCsv(rows, LOOT_LOG_CSV_COLUMNS));
            } catch (error) {
                console.error('[LootLogStats] CSV export failed:', error);
            }
        });

        bar.appendChild(button);
        return bar;
    }

    /**
     * Render a single historical loot log entry matching native styling
     * @param {Object} entry - Historical log entry from storage
     * @returns {HTMLElement|null}
     */
    renderHistoricalEntry(entry) {
        if (!entry) return null;

        // Skip enhancing entries
        if (entry.actionHrid === '/actions/enhancing/enhance') return null;

        const entryEl = document.createElement('div');
        entryEl.className = 'mwi-loot-log-history-entry';
        entryEl.style.cssText = `
            border-left: 3px solid rgba(96, 165, 250, 0.3);
            opacity: 0.9;
            padding: 8px 8px 8px 12px;
            margin-top: 8px;
            position: relative;
            background: rgba(28, 33, 40, 0.8);
            border-radius: 8px;
        `;

        // Delete button (red X)
        const deleteBtn = document.createElement('span');
        deleteBtn.textContent = '✕';
        deleteBtn.style.cssText = `
            position: absolute;
            top: 4px;
            right: 8px;
            color: rgba(239, 68, 68, 0.6);
            cursor: pointer;
            font-size: 14px;
            line-height: 1;
            padding: 2px 4px;
            border-radius: 3px;
        `;
        deleteBtn.addEventListener('mouseenter', () => {
            deleteBtn.style.color = 'rgba(239, 68, 68, 1)';
            deleteBtn.style.background = 'rgba(239, 68, 68, 0.1)';
        });
        deleteBtn.addEventListener('mouseleave', () => {
            deleteBtn.style.color = 'rgba(239, 68, 68, 0.6)';
            deleteBtn.style.background = 'none';
        });
        deleteBtn.addEventListener('click', async () => {
            await this.deleteHistoricalEntry(entry.characterActionId);
            entryEl.remove();
            // Update separator count
            const wrapper = document.querySelector('.mwi-loot-log-history');
            if (wrapper) {
                const sep = wrapper.querySelector('div');
                const remaining = wrapper.querySelectorAll('.mwi-loot-log-history-entry').length;
                if (remaining === 0) {
                    wrapper.remove();
                } else if (sep) {
                    sep.textContent = `— Historical Entries (${remaining}) —`;
                }
            }
        });
        entryEl.appendChild(deleteBtn);

        // Header row: action icon + "Category - Action Name (count)"
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 2px;';

        const actionIcon = this.createActionIcon(entry.actionHrid, 20);
        if (actionIcon) headerDiv.appendChild(actionIcon);

        const actionLabel = document.createElement('span');
        actionLabel.style.cssText = 'font-weight: bold; color: #fff;';
        const category = this.getActionCategory(entry.actionHrid);
        const name = this.getActionName(entry.actionHrid);
        const countStr = entry.actionCount ? ` (${numberFormatter(entry.actionCount)})` : '';
        actionLabel.textContent = category ? `${category} - ${name}${countStr}` : `${name}${countStr}`;
        headerDiv.appendChild(actionLabel);

        entryEl.appendChild(headerDiv);

        // Start Time row + total value
        const timeDiv = document.createElement('div');
        timeDiv.style.cssText = 'margin-bottom: 2px;';

        const startDate = new Date(entry.startTime);
        timeDiv.textContent = `Start Time: ${formatDateTime(startDate)}`;
        entryEl.appendChild(timeDiv);

        this.injectTotalValue(timeDiv, entry);

        // Duration row + avg time + daily output
        const durationDiv = document.createElement('div');
        durationDiv.style.cssText = 'margin-bottom: 6px;';

        if (entry.startTime && entry.endTime) {
            const durationSec = (new Date(entry.endTime) - new Date(entry.startTime)) / 1000;
            durationDiv.textContent = `Duration: ${this.formatDuration(durationSec)}`;
        }
        entryEl.appendChild(durationDiv);

        this.injectTimeAndDailyOutput(durationDiv, entry);

        // Drops grid - large icons with counts below (matching native style)
        if (entry.drops && Object.keys(entry.drops).length > 0) {
            const dropsDiv = document.createElement('div');
            dropsDiv.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;';

            for (const [hrid, count] of Object.entries(entry.drops)) {
                const baseHrid = hrid.replace(/::\d+$/, '');
                const dropEl = document.createElement('div');
                dropEl.style.cssText = `
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    width: 60px;
                `;

                const icon = this.createItemIcon(baseHrid, 48);
                if (icon) {
                    icon.style.cssText = `
                        width: 48px;
                        height: 48px;
                        background: rgba(255, 255, 255, 0.03);
                        border-radius: 4px;
                        padding: 4px;
                    `;
                    dropEl.appendChild(icon);
                }

                const countEl = document.createElement('span');
                countEl.style.cssText = 'font-size: 0.8em; color: #ccc; margin-top: 2px;';
                countEl.textContent = numberFormatter(count);
                dropEl.appendChild(countEl);

                dropsDiv.appendChild(dropEl);
            }

            entryEl.appendChild(dropsDiv);
        }

        return entryEl;
    }

    /**
     * Delete a single historical entry by characterActionId
     * @param {number} characterActionId
     */
    async deleteHistoricalEntry(characterActionId) {
        const key = lootLogHistory._getKey();
        if (!key) return;
        const entries = await lootLogHistory._load();
        const filtered = entries.filter((e) => e.characterActionId !== characterActionId);
        await lootLogHistory._save(filtered);
    }

    /**
     * Get action category from HRID (e.g. "/actions/cooking/donut" → "Cooking")
     * @param {string} actionHrid
     * @returns {string|null}
     */
    getActionCategory(actionHrid) {
        if (!actionHrid) return null;
        const parts = actionHrid.split('/');
        // Format: /actions/category/name
        if (parts.length >= 3) {
            const category = parts[2];
            return category.charAt(0).toUpperCase() + category.slice(1);
        }
        return null;
    }

    /**
     * Create an SVG action icon element
     * @param {string} actionHrid - Action HRID
     * @param {number} size - Icon size in pixels
     * @returns {SVGElement|null}
     */
    createActionIcon(actionHrid, size) {
        const spriteUrl = this.getActionsSpriteUrl();
        if (!spriteUrl) return null;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.style.flexShrink = '0';

        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        const iconName = actionHrid.split('/').pop();
        use.setAttribute('href', `${spriteUrl}#${iconName}`);
        svg.appendChild(use);

        return svg;
    }

    /**
     * Get the actions sprite URL (cached after first lookup)
     * @returns {string|null}
     */
    getActionsSpriteUrl() {
        if (!this.actionsSpriteUrl) {
            const el = document.querySelector('use[href*="actions_sprite"]');
            if (el) {
                const href = el.getAttribute('href');
                this.actionsSpriteUrl = href ? href.split('#')[0] : null;
            }
        }
        return this.actionsSpriteUrl;
    }

    /**
     * Get action display name from HRID
     * @param {string} actionHrid - Action HRID
     * @returns {string}
     */
    getActionName(actionHrid) {
        if (!actionHrid) return 'Unknown';
        const details = dataManager.getActionDetails(actionHrid);
        if (details?.name) return details.name;
        return actionHrid.split('/').pop().replace(/_/g, ' ');
    }

    /**
     * Cleanup when disabling feature
     */
    cleanup() {
        // Remove all injected spans
        const valueSpans = document.querySelectorAll('.mwi-loot-log-value');
        valueSpans.forEach((span) => span.remove());

        const avgTimeSpans = document.querySelectorAll('.mwi-loot-log-avgtime');
        avgTimeSpans.forEach((span) => span.remove());

        const dayValueSpans = document.querySelectorAll('.mwi-loot-log-day-value');
        dayValueSpans.forEach((span) => span.remove());

        const dayProfitSpans = document.querySelectorAll('.mwi-loot-log-day-profit');
        dayProfitSpans.forEach((span) => span.remove());

        // Remove historical entries section
        const historySection = document.querySelectorAll('.mwi-loot-log-history');
        historySection.forEach((el) => el.remove());

        // Unregister all handlers
        this.unregisterHandlers.forEach((fn) => fn());
        this.unregisterHandlers = [];

        // Clear timers
        this.timerRegistry.clearAll();

        // Reset state
        this.currentLootLogData = null;
        this.itemsSpriteUrl = null;
        this.actionsSpriteUrl = null;
        this.historicalRendered = 0;
        this.luckCache.clear();
        this.initialized = false;
    }
}

// Exported for unit testing pure/standalone methods (e.g. calculateExpectedRunValue)
// without going through the feature registry's initialize() lifecycle.
export { LootLogStats };

// Export as feature module
export default {
    name: 'Loot Log Statistics',
    initialize: async () => {
        const lootLogStats = new LootLogStats();
        await lootLogStats.initialize();
        return lootLogStats;
    },
    cleanup: (instance) => {
        if (instance) {
            instance.cleanup();
        }
    },
};
