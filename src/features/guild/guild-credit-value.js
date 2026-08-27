/**
 * Guild Credit Value Display
 *
 * Injects cost-efficiency tables into guild credit exchange modals and shrine
 * upgrade modals. Shows both sell-side (opportunity cost) and buy-side
 * (acquisition cost) columns. Pricing mode is taken from the user's profit
 * calculation settings.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { getItemPrice } from '../../utils/market-data.js';
import { formatKMB } from '../../utils/formatters.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';
import { itemHridFromIcon } from '../../utils/item-icon.js';
import webSocketHook from '../../core/websocket.js';
import {
    navigateToMarketplace,
    createMaterialTab,
    removeMaterialTabs,
    removeShrineMarketTabs,
    updateTabBadge,
    visibleTabsContainer,
} from '../../utils/marketplace-tabs.js';
import { createAutofillManager } from '../../utils/marketplace-autofill.js';
import { openShoppingList } from '../../utils/shopping-list.js';
import { createCuratedRecord, mergeMaps } from '../../utils/persisted-record.js';
import { heldInInventory } from '../../utils/dungeon-key-forecast.js';
import { renderTierBadge, TIER_BADGE_CLASS } from './guild-trial-tier-badge.js';
import { GUILD_BUILDING_MAX_LEVEL } from './guild-trials-store.js';
import { describeGuildTokenGold } from './guild-token-value.js';
import { captureTokenExchangeFromModal, hydrateCapturedTokenExchanges } from './guild-token-exchange-capture.js';

const CSS_CLASS = 'mwi-guild-credit-value';

/**
 * The shrine planner's saved state, per character.
 *
 * A curated record, not a plain one: the targets are a list the user edits, and
 * a target they cleared must not come back from storage on the next save.
 * Scoped (the default) because a plan for which shrine levels to chase is one
 * character's business — the guild-shared trial plan is the unscoped case.
 *
 * Shape: `{ targets: { [buffHrid]: number }, collapsed: boolean }`.
 * Stored key: `guildShrinePlan_<characterId>` in the `settings` store.
 *
 * `empty()` is a bare `{}` rather than the shape with its defaults filled in:
 * the pre-load merge is a shallow one with memory winning per key, so an
 * `empty()` carrying `targets: {}` would shadow the stored targets on the first
 * load and hand back an empty plan. Defaults are applied where the plan is
 * read instead ({@link planState}).
 */
const SHRINE_PLAN_KEY = 'guildShrinePlan';
const shrinePlanRecord = createCuratedRecord({
    base: SHRINE_PLAN_KEY,
    empty: () => ({}),
    merge: mergeMaps(),
    label: 'GuildShrinePlanner',
});

/**
 * The saved plan with its shape guaranteed — `targets` always an object.
 * @returns {{targets: Object<string, number>, collapsed: boolean}} The live record
 */
function planState() {
    const plan = shrinePlanRecord.get();
    if (!plan.targets || typeof plan.targets !== 'object') plan.targets = {};
    return plan;
}

/** How long the target inputs sit still before the plan is written */
const PLAN_SAVE_DEBOUNCE_MS = 400;

/**
 * Walk a token-cost-ascending list of single-level buys, taking each one the
 * remaining balance still covers.
 *
 * Deliberately single-level-ahead: buying a level changes what that buff's
 * *next* level costs, so this is an "if you spent everything right now" figure
 * and not a claim about an optimal spend.
 *
 * @param {Array<{tokenCost: number}>} options - Sorted by `tokenCost` ascending
 * @param {number} balance - Guild tokens held
 * @returns {{count: number, spent: number}} How many are covered and what they cost
 */
export function greedyAffordable(options, balance) {
    let spent = 0;
    let count = 0;
    for (const option of Array.isArray(options) ? options : []) {
        const cost = Number(option?.tokenCost) || 0;
        // Ascending order means the first miss is the last: nothing further down
        // the list is cheaper than the one that just failed to fit.
        if (spent + cost > balance) break;
        spent += cost;
        count += 1;
    }
    return { count, spent };
}

/**
 * Build cheapest-gold-per-credit maps for both sell and buy sides.
 * @param {Object} itemDetailMap
 * @returns {{ sell: Object, buy: Object }}
 */
function buildCheapestPerCredit(itemDetailMap) {
    const sell = {};
    const buy = {};
    for (const [hrid, item] of Object.entries(itemDetailMap)) {
        for (const conv of item.guildCreditConversions || []) {
            const creditHrid = conv.creditItemHrid;
            const sellPrice = getItemPrice(hrid, { mode: 'ask' });
            const buyPrice = getItemPrice(hrid, { mode: 'bid' });
            if (sellPrice > 0) {
                const gpc = (sellPrice * conv.itemCount) / conv.creditCount;
                if (!sell[creditHrid] || gpc < sell[creditHrid]) sell[creditHrid] = gpc;
            }
            if (buyPrice > 0) {
                const gpc = (buyPrice * conv.itemCount) / conv.creditCount;
                if (!buy[creditHrid] || gpc < buy[creditHrid]) buy[creditHrid] = gpc;
            }
        }
    }
    return { sell, buy };
}

/**
 * Build top-N conversion options per credit type, ranked by ask/credit ascending.
 * @param {Object} itemDetailMap
 * @param {number} n
 * @returns {Object} Map of creditHrid → array of up to n options
 */
function buildTopConversions(itemDetailMap, n) {
    const byCredit = {};
    for (const [hrid, item] of Object.entries(itemDetailMap)) {
        for (const conv of item.guildCreditConversions || []) {
            const creditHrid = conv.creditItemHrid;
            const askPrice = getItemPrice(hrid, { mode: 'ask' });
            const bidPrice = getItemPrice(hrid, { mode: 'bid' });
            if (!askPrice && !bidPrice) continue;
            const askGPC = askPrice > 0 ? (askPrice * conv.itemCount) / conv.creditCount : null;
            const bidGPC = bidPrice > 0 ? (bidPrice * conv.itemCount) / conv.creditCount : null;
            if (!byCredit[creditHrid]) byCredit[creditHrid] = [];
            byCredit[creditHrid].push({
                hrid,
                name: item.name,
                itemCount: conv.itemCount,
                creditCount: conv.creditCount,
                askPrice,
                bidPrice,
                askGPC,
                bidGPC,
            });
        }
    }
    for (const creditHrid of Object.keys(byCredit)) {
        byCredit[creditHrid].sort((a, b) => {
            if (a.askGPC === null && b.askGPC === null) return 0;
            if (a.askGPC === null) return 1;
            if (b.askGPC === null) return -1;
            return a.askGPC - b.askGPC;
        });
        byCredit[creditHrid] = byCredit[creditHrid].slice(0, n);
    }
    return byCredit;
}

/**
 * The raw materials to buy for a bill of still-owed credits.
 *
 * The same walk the shrine cost table does for one upgrade, applied to the
 * planner's whole target list: each credit is bought through its cheapest
 * conversion (`buildTopConversions` has already ranked them ask-per-credit
 * ascending, so `[0]` is that one), the conversion is a fixed
 * `itemCount → creditCount` trade so a part-filled trade still costs a whole
 * one, and what is already sitting in the inventory comes off the end.
 *
 * Materials are pooled by hrid before the inventory is subtracted — two credits
 * whose cheapest conversion is the same bar want one number, not two competing
 * ones each claiming the whole stack.
 *
 * A credit with no conversion at all is skipped. Nothing is lost by that: the
 * amount is still owed and still listed in the totals above, it just has no
 * market item behind it to go and buy, so there is no tab to open for it.
 *
 * Guild tokens never appear here. They are not a market item and have no
 * `guildCreditConversions` entry — they come from trials — so they are the
 * planner's one cost the marketplace cannot answer.
 *
 * @param {Object<string, number>} owedCredits - creditHrid → credits still owed
 * @param {Object} topConversions - From {@link buildTopConversions}
 * @param {Array<Object>} inventory - The character's items
 * @returns {Array<{itemHrid: string, name: string, count: number}>} Shopping-list shape
 */
export function creditShortfallMaterials(owedCredits, topConversions, inventory) {
    const wanted = new Map();
    for (const [creditHrid, owed] of Object.entries(owedCredits || {})) {
        if (!(owed > 0)) continue;
        const top = (topConversions?.[creditHrid] || [])[0];
        if (!top?.hrid || !(top.creditCount > 0) || !(top.itemCount > 0)) continue;
        const qtyNeeded = Math.ceil(owed / top.creditCount) * top.itemCount;
        const prior = wanted.get(top.hrid);
        if (prior) prior.count += qtyNeeded;
        else wanted.set(top.hrid, { itemHrid: top.hrid, name: top.name, count: qtyNeeded });
    }

    const mats = [];
    for (const mat of wanted.values()) {
        const missing = mat.count - heldInInventory(inventory, mat.itemHrid);
        if (missing > 0) mats.push({ ...mat, count: missing });
    }
    return mats;
}

class GuildCreditValue {
    constructor() {
        this.initialized = false;
        this.unregisterObservers = [];
        this.autofillManager = createAutofillManager('GuildCreditValue-MissingMats');
        this._shrineTabCleanup = null;
        this._advisorObserver = null; // Re-renders the exchange advisor when the selected item changes
        this._advisorTimer = null;
        this._planSaveTimer = null;
    }

    initialize() {
        if (this.initialized) return;

        this.autofillManager.initialize();

        // The saved shrine plan, read once so the synchronous planner render can
        // see it. Nothing waits on it: a modal opened before it lands restores
        // its inputs when the load finishes (see `_renderShrinePlanner`).
        shrinePlanRecord.load();

        // The stored token exchange, read once so the synchronous valuation can
        // see it. Nothing waits on it: until it lands, tokens are priced the way
        // they were before.
        hydrateCapturedTokenExchanges();

        const unregister = domObserver.onClass('GuildCreditValue', 'GuildPanel_exchangeModalContent', (el) => {
            // Before the table is drawn, because the reading is of the game's
            // own markup and this script is about to add markup of its own
            this._captureTokenExchange(el);
            this._render(el);
        });
        this.unregisterObservers.push(unregister);

        const unregisterShrine = domObserver.onClass('GuildCreditValue-Shrine', 'GuildPanel_guildModalContent', (el) =>
            this._renderShrine(el)
        );
        this.unregisterObservers.push(unregisterShrine);

        const unregisterTrial = domObserver.onClass('GuildCreditValue-Trial', 'GuildPanel_signupModal', (el) =>
            this._renderTrialSignup(el)
        );
        this.unregisterObservers.push(unregisterTrial);

        const unregisterTileSummary = domObserver.onClass(
            'GuildCreditValue-TileSummary',
            'GuildPanel_tileSummary',
            (el) => this._renderTrialTier(el)
        );
        this.unregisterObservers.push(unregisterTileSummary);

        this.initialized = true;
    }

    /**
     * Read the token→credit rate off an open exchange dialog.
     *
     * The Guild Shop states this rate and nothing in the client data has been
     * found that does, so this dialog is where it comes from. Runs regardless of
     * the `guildCreditValue` setting: that setting governs a table this script
     * draws, and reading a number off the game's own markup is not drawing
     * anything. Failures are swallowed inside the capture module — a dialog that
     * does not parse must never stop the table below it from rendering.
     *
     * @param {Element} modalEl - The exchange modal
     * @returns {void}
     */
    _captureTokenExchange(modalEl) {
        const gameData = dataManager.getInitClientData();
        const itemDetailMap = gameData?.itemDetailMap;
        if (!itemDetailMap) return;

        const titleText = modalEl.querySelector('[class*="GuildPanel_header"]')?.textContent?.trim() || '';
        if (!titleText) return;

        const creditHrid = Object.keys(itemDetailMap).find(
            (hrid) => hrid.includes('guild_credit') && itemDetailMap[hrid].name === titleText
        );
        if (!creditHrid) return;

        const tokenHrid = Object.keys(itemDetailMap).find((hrid) => hrid.includes('guild_token'));
        const selectorContainer = modalEl.querySelector('[class*="ItemSelector_itemContainer"]');
        // Identity from the icon sprite (locale independent); the translatable
        // aria-label only backs up the name comparison for older markup
        const selectedItemHrid = itemHridFromIcon(selectorContainer, itemDetailMap);
        const selectedItemName =
            selectorContainer?.querySelector('svg[aria-label]')?.getAttribute('aria-label') || null;

        captureTokenExchangeFromModal(modalEl, {
            creditItemHrid: creditHrid,
            creditName: titleText,
            selectedItemHrid,
            selectedItemName,
            tokenHrid: tokenHrid || null,
            tokenName: (tokenHrid && itemDetailMap[tokenHrid]?.name) || 'Guild Token',
        });
    }

    _render(modalEl) {
        if (!config.getSetting('guildCreditValue', true)) return;

        modalEl.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());

        const gameData = dataManager.getInitClientData();
        if (!gameData) return;

        const titleEl = modalEl.querySelector('[class*="GuildPanel_header"]');
        const titleText = titleEl?.textContent?.trim() || '';
        if (!titleText) return;

        const creditHrid = Object.keys(gameData.itemDetailMap || {}).find(
            (hrid) => hrid.includes('guild_credit') && gameData.itemDetailMap[hrid].name === titleText
        );
        if (!creditHrid) return;

        const rows = [];
        for (const [hrid, item] of Object.entries(gameData.itemDetailMap)) {
            const conv = (item.guildCreditConversions || []).find((c) => c.creditItemHrid === creditHrid);
            if (!conv) continue;

            const sellPrice = getItemPrice(hrid, { mode: 'ask' });
            const buyPrice = getItemPrice(hrid, { mode: 'bid' });
            if (!sellPrice && !buyPrice) continue;

            const sellGPC = sellPrice > 0 ? (sellPrice * conv.itemCount) / conv.creditCount : null;
            const buyGPC = buyPrice > 0 ? (buyPrice * conv.itemCount) / conv.creditCount : null;

            rows.push({
                hrid,
                name: item.name,
                itemCount: conv.itemCount,
                creditCount: conv.creditCount,
                sellPrice,
                buyPrice,
                sellGPC,
                buyGPC,
            });
        }

        if (rows.length === 0) return;

        const exchangeBtn = modalEl.querySelector('button');
        if (!exchangeBtn) return;

        let sortKey = 'ask';

        const buildTbody = () => {
            const sorted = [...rows].sort((a, b) => {
                const aVal = sortKey === 'bid' ? a.buyGPC : a.sellGPC;
                const bVal = sortKey === 'bid' ? b.buyGPC : b.sellGPC;
                if (aVal === null && bVal === null) return 0;
                if (aVal === null) return 1;
                if (bVal === null) return -1;
                return aVal - bVal;
            });
            const tbody = document.createElement('tbody');
            sorted.forEach((row, i) => {
                const isTop = i === 0;
                const tr = document.createElement('tr');
                tr.style.cssText = `border-bottom:1px solid rgba(255,255,255,0.05); color:${isTop ? '#4ade80' : '#e0e0e0'};`;
                const rate = row.creditCount === 1 ? `${row.itemCount} → 1` : `${row.itemCount} → ${row.creditCount}`;
                tr.innerHTML = `
                    <td style="padding:4px 6px; text-align:left;">${row.name}</td>
                    <td style="padding:4px 6px; text-align:center; color:#9ca3af;">${rate}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.sellPrice ? formatKMB(row.sellPrice) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.buyPrice ? formatKMB(row.buyPrice) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right; ${sortKey === 'bid' ? 'color:#9ca3af;' : `font-weight:${isTop ? '700' : '400'};`}">${row.sellGPC ? formatKMB(row.sellGPC) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right; ${sortKey === 'ask' ? 'color:#9ca3af;' : `font-weight:${isTop ? '700' : '400'};`}">${row.buyGPC ? formatKMB(row.buyGPC) : '–'}</td>
                `;
                tbody.appendChild(tr);
            });
            return tbody;
        };

        const wrapper = document.createElement('div');
        wrapper.className = CSS_CLASS;
        wrapper.style.cssText = 'margin-top:12px; font-size:12px; width:100%; max-height:260px; overflow-y:auto;';

        const hdr = document.createElement('div');
        hdr.style.cssText = 'font-size:11px; color:#9ca3af; margin-bottom:6px; text-align:center;';
        hdr.textContent = 'Gold cost per credit — click to sort';
        wrapper.appendChild(hdr);

        const table = document.createElement('table');
        table.style.cssText = 'width:100%; border-collapse:collapse;';

        const thead = document.createElement('thead');
        const thRow = document.createElement('tr');
        thRow.style.cssText = 'font-size:11px; border-bottom:1px solid rgba(255,255,255,0.1);';

        [
            { text: 'Item', align: 'left' },
            { text: 'Rate', align: 'center' },
            { text: 'Ask ea.', align: 'right' },
            { text: 'Bid ea.', align: 'right' },
        ].forEach(({ text, align }) => {
            const th = document.createElement('th');
            th.style.cssText = `text-align:${align}; padding:3px 6px; font-weight:500; color:#6b7280;`;
            th.textContent = text;
            thRow.appendChild(th);
        });

        const askTh = document.createElement('th');
        askTh.textContent = 'Ask/credit';
        const bidTh = document.createElement('th');
        bidTh.textContent = 'Bid/credit';
        thRow.appendChild(askTh);
        thRow.appendChild(bidTh);
        thead.appendChild(thRow);
        table.appendChild(thead);

        const updateThStyles = () => {
            const isAsk = sortKey === 'ask';
            const active = 'font-weight:600; color:#e0e0e0; text-decoration:underline;';
            const inactive = 'font-weight:500; color:#6b7280;';
            askTh.style.cssText = `text-align:right; padding:3px 6px; cursor:pointer; ${isAsk ? active : inactive}`;
            bidTh.style.cssText = `text-align:right; padding:3px 6px; cursor:pointer; ${!isAsk ? active : inactive}`;
        };
        updateThStyles();

        let currentTbody = buildTbody();
        table.appendChild(currentTbody);

        const setSort = (key) => {
            sortKey = key;
            updateThStyles();
            const newTbody = buildTbody();
            table.replaceChild(newTbody, currentTbody);
            currentTbody = newTbody;
        };

        askTh.addEventListener('click', () => setSort('ask'));
        bidTh.addEventListener('click', () => setSort('bid'));

        wrapper.appendChild(table);
        exchangeBtn.insertAdjacentElement('afterend', wrapper);

        // Exchange advisor — initial render + re-render on item selection change
        if (config.getSetting('guildCreditExchangeAdvisor', true)) {
            this._renderExchangeAdvisor(modalEl, creditHrid, rows);

            const itemSelector = modalEl.querySelector('[class*="ItemSelector_itemContainer"]');
            if (itemSelector) {
                // One observer at a time, released with the feature: a modal
                // reopened a few times used to leave each one's observer behind.
                // Debounced, since a selection change lands as a burst of
                // mutations and the advisor is a full re-render.
                this._disconnectAdvisorObserver();
                this._advisorObserver = new MutationObserver(() => {
                    if (this._advisorTimer) clearTimeout(this._advisorTimer);
                    this._advisorTimer = setTimeout(() => {
                        this._advisorTimer = null;
                        if (!modalEl.isConnected) return;
                        this._renderExchangeAdvisor(modalEl, creditHrid, rows);
                    }, 50);
                });
                this._advisorObserver.observe(itemSelector, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    attributeFilter: ['href', 'aria-label', 'class'],
                });
            }
        }

        // Shrine upgrade planner
        if (config.getSetting('guildShrineUpgradePlanner', true)) {
            this._renderShrinePlanner(modalEl);
        }
    }

    /**
     * Write the shrine plan, once the inputs have sat still.
     *
     * The number input fires `input` on every keystroke — typing "12" is a pass
     * through "1" — and each write is a probe-merge-write against IndexedDB, so
     * they are coalesced the way the advisor's re-render is.
     * @returns {void}
     */
    _savePlanSoon() {
        if (this._planSaveTimer) clearTimeout(this._planSaveTimer);
        this._planSaveTimer = setTimeout(() => {
            this._planSaveTimer = null;
            shrinePlanRecord.save();
        }, PLAN_SAVE_DEBOUNCE_MS);
    }

    /** Release the exchange advisor's selection observer and any pending re-render */
    _disconnectAdvisorObserver() {
        this._advisorObserver?.disconnect();
        this._advisorObserver = null;
        if (this._advisorTimer) {
            clearTimeout(this._advisorTimer);
            this._advisorTimer = null;
        }
    }

    _renderShrinePlanner(modalEl) {
        modalEl.querySelectorAll('.mwi-shrine-planner').forEach((el) => el.remove());

        const gameData = dataManager.getInitClientData();
        if (!gameData?.guildBuffDetailMap) return;

        // Group buffs by shrine
        const byShrine = {};
        for (const [buffHrid, buff] of Object.entries(gameData.guildBuffDetailMap)) {
            const shrineHrid = buff.shrineHrid;
            if (!byShrine[shrineHrid]) byShrine[shrineHrid] = [];
            byShrine[shrineHrid].push({ buffHrid, buff });
        }
        if (Object.keys(byShrine).length === 0) return;

        const SHRINE_LABELS = {
            '/guild_shrines/force': 'Force',
            '/guild_shrines/tempo': 'Tempo',
            '/guild_shrines/rarity': 'Rarity',
            '/guild_shrines/scholar': 'Scholar',
            '/guild_shrines/spirit': 'Spirit',
        };

        // Aggregate total costs across all target levels selected
        const aggregateCosts = (plans) => {
            const tokens = { total: 0 };
            const credits = {};
            for (const { buffHrid, fromLevel, toLevel } of plans) {
                const levelCosts = gameData.guildBuffDetailMap[buffHrid]?.levelCosts || {};
                for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) {
                    const cost = levelCosts[String(lvl)];
                    if (!cost) continue;
                    tokens.total += cost.guildTokenCost || 0;
                    for (const { itemHrid, count } of cost.creditCosts || []) {
                        credits[itemHrid] = (credits[itemHrid] || 0) + count;
                    }
                }
            }
            return { tokens, credits };
        };

        const wrapper = document.createElement('div');
        wrapper.className = 'mwi-shrine-planner';
        wrapper.style.cssText = 'margin-top:10px; font-size:12px; width:100%;';

        // Collapsible header
        const header = document.createElement('div');
        header.style.cssText = `
            display:flex; justify-content:space-between; align-items:center;
            padding:5px 6px; background:rgba(255,255,255,0.04); border-radius:4px;
            cursor:pointer; font-size:11px; color:#9ca3af; user-select:none;
            border:1px solid rgba(255,255,255,0.08); margin-bottom:4px;
        `;
        const headerTitle = document.createElement('span');
        headerTitle.textContent = 'Shrine Upgrade Planner';
        const headerArrow = document.createElement('span');
        headerArrow.textContent = '▶';
        header.appendChild(headerTitle);
        header.appendChild(headerArrow);
        wrapper.appendChild(header);

        const body = document.createElement('div');
        // Bounded like the ranking table above: the game's exchange modal does not grow
        // for injected content, so an unbounded planner body renders past the modal's
        // bottom edge instead of scrolling within it
        body.style.cssText = 'display:none; max-height:260px; overflow-y:auto;';
        wrapper.appendChild(body);

        const applyCollapsed = (collapsed) => {
            body.style.display = collapsed ? 'none' : 'block';
            headerArrow.textContent = collapsed ? '▶' : '▼';
        };

        header.addEventListener('click', () => {
            const isOpen = body.style.display !== 'none';
            applyCollapsed(isOpen);
            planState().collapsed = isOpen;
            this._savePlanSoon();
        });

        // The suggestion section is built before the manual rows so it sits at
        // the top of the body, but its contents come from the same per-buff walk
        // below — so it is filled in afterwards.
        const suggestEl = document.createElement('div');
        suggestEl.className = 'mwi-shrine-next-buys';
        suggestEl.style.cssText =
            'margin-bottom:8px; padding:6px; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.2);';
        body.appendChild(suggestEl);

        // Track target inputs for cost recalculation
        const planInputs = []; // [{buffHrid, currentLevel, capLevel, inputEl}]

        const totalsEl = document.createElement('div');
        totalsEl.style.cssText =
            'margin-top:8px; padding:6px; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.2);';

        // The marketplace hand-off for whatever the totals still owe. Its own
        // element rather than part of `totalsEl`, so the button is not rebuilt
        // by the innerHTML wipe that clears the rows above it.
        const matsEl = document.createElement('div');
        matsEl.className = 'mwi-shrine-plan-mats';

        const recalculate = () => {
            const plans = planInputs
                .map(({ buffHrid, currentLevel, inputEl }) => ({
                    buffHrid,
                    fromLevel: currentLevel,
                    toLevel: Math.min(parseInt(inputEl.value, 10) || currentLevel, parseInt(inputEl.max, 10)),
                }))
                .filter(({ fromLevel, toLevel }) => toLevel > fromLevel);

            totalsEl.innerHTML = '';
            matsEl.innerHTML = '';

            if (plans.length === 0) {
                totalsEl.innerHTML =
                    '<div style="color:#6b7280; text-align:center; font-size:11px;">Set target levels above current to see costs</div>';
                return;
            }

            const { tokens, credits } = aggregateCosts(plans);
            const itemDetailMap = gameData.itemDetailMap || {};
            const inventory = dataManager.getInventory();

            // What the plan costs, less what is already in the bag. The shrine
            // cost table nets the same way for a single upgrade, and the two
            // reading differently for the same buy was the confusing part: the
            // planner asked for 50 credits you were holding 50 of.
            //
            // Netting is why the heading no longer says "Total upgrade cost".
            // That phrase was true of the gross figure and would be a lie about
            // this one, so the box says what it now shows, and every row that
            // had something come off it says how much.
            const owedRow = (itemHrid, gross) => {
                const owned = heldInInventory(inventory, itemHrid);
                return { owed: Math.max(0, gross - owned), owned };
            };
            const ownedNote = (owned) =>
                owned > 0
                    ? ` <span style="color:#6b7280; font-weight:400;">(own ${owned.toLocaleString()})</span>`
                    : '';

            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'color:#9ca3af; font-size:11px; margin-bottom:6px;';
            titleEl.textContent = 'Still needed for these targets';
            totalsEl.appendChild(titleEl);

            // Guild tokens row. Tokens are not listed on the market, but the
            // guild shop trades them for credits and credits have a gold value,
            // so the row can carry an approximate one — labelled as derived,
            // never presented as a price
            const tokenHrid = Object.keys(itemDetailMap).find((hrid) => hrid.includes('guild_token'));
            const tokenRow = owedRow(tokenHrid, tokens.total);
            if (tokenRow.owed > 0) {
                const tokenGold = describeGuildTokenGold(tokenRow.owed, 'ask');
                const goldStr = tokenGold
                    ? ` <span style="color:#6b7280; font-weight:400;" title="${tokenGold.title.replace(/"/g, '&quot;')}">(${tokenGold.text})</span>`
                    : '';
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; justify-content:space-between; padding:2px 0; font-size:12px;';
                row.innerHTML = `<span style="color:#aaa;">Guild Tokens</span><span style="color:#e0e0e0; font-weight:600;">${tokenRow.owed.toLocaleString()}${goldStr}${ownedNote(tokenRow.owned)}</span>`;
                totalsEl.appendChild(row);
            }

            // Credit costs
            const owedCredits = {};
            for (const [itemHrid, count] of Object.entries(credits)) {
                const { owed, owned } = owedRow(itemHrid, count);
                owedCredits[itemHrid] = owed;
                if (owed <= 0) continue;
                const name = itemDetailMap[itemHrid]?.name || itemHrid.split('/').pop();
                const price = getItemPrice(itemHrid, { mode: 'ask' });
                const goldStr = price > 0 ? ` (${formatKMB(price * owed)})` : '';
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; justify-content:space-between; padding:2px 0; font-size:12px;';
                row.innerHTML = `<span style="color:#aaa;">${name}</span><span style="color:#e0e0e0; font-weight:600;">${owed.toLocaleString()}<span style="color:#6b7280; font-weight:400;">${goldStr}</span>${ownedNote(owned)}</span>`;
                totalsEl.appendChild(row);
            }

            if (totalsEl.childElementCount === 1) {
                const none = document.createElement('div');
                none.style.cssText = 'color:#4ade80; text-align:center; font-size:11px;';
                none.textContent = 'Everything these targets cost is already held';
                totalsEl.appendChild(none);
            }

            renderMissingMats(owedCredits, itemDetailMap, inventory);
        };

        /**
         * The "go and buy the shortfall" button under the totals.
         *
         * Rebuilt by `recalculate()` rather than kept in step, because what is
         * missing is a function of the targets, the inventory and the ask prices
         * all at once — the same three the totals above are drawn from, so the
         * two cannot disagree if they are drawn together. (The planner has no
         * live inventory or price hook of its own; neither does the shrine cost
         * table's own button, which is likewise built once per render.)
         *
         * @param {Object<string, number>} owedCredits - creditHrid → credits still owed
         * @param {Object} itemDetailMap - The game's items
         * @param {Array<Object>} inventory - The character's items
         */
        function renderMissingMats(owedCredits, itemDetailMap, inventory) {
            // Fresh per recalculation: the ranking is by live ask price, and a
            // cached one would send the user after yesterday's cheapest bar
            const topConversions = buildTopConversions(itemDetailMap, 1);
            const missingMats = creditShortfallMaterials(owedCredits, topConversions, inventory);
            if (missingMats.length === 0) return;

            const button = document.createElement('button');
            button.className = 'mwi-shrine-plan-mats-btn';
            button.style.cssText = `
                width:100%; padding:8px 12px; margin-top:8px;
                background:linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%);
                color:#fff; border:1px solid rgba(91,141,239,0.4); border-radius:6px;
                cursor:pointer; font-size:12px; font-weight:600;
            `;
            button.textContent = 'Missing Mats Marketplace';
            button.addEventListener('mouseenter', () => {
                button.style.background = 'linear-gradient(180deg,rgba(91,141,239,0.35) 0%,rgba(91,141,239,0.25) 100%)';
            });
            button.addEventListener('mouseleave', () => {
                button.style.background = 'linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%)';
            });
            // The shared list, not this file's older hand-rolled tab code above:
            // one module owns the marketplace tab bar, and a second watcher on it
            // is what the shopping list's own docstring is a note about. It also
            // takes its own tabs away when the marketplace closes, so the button
            // needs no teardown hooked into the modal's lifecycle.
            button.addEventListener('click', () => openShoppingList(missingMats, { heading: 'Shrine plan' }));
            matsEl.appendChild(button);
        }

        // Single-level-ahead buys, filled by the per-shrine walk below
        const nextBuys = [];

        // Build rows per shrine
        for (const [shrineHrid, buffs] of Object.entries(byShrine).sort()) {
            const shrineLabel = SHRINE_LABELS[shrineHrid] || shrineHrid.split('/').pop();
            const shrineCapLevel = dataManager.getGuildBuildingLevel(shrineHrid);

            const shrineSection = document.createElement('div');
            shrineSection.style.cssText = 'margin-bottom:6px;';

            const shrineTitleEl = document.createElement('div');
            shrineTitleEl.style.cssText =
                'color:#c4b5fd; font-size:11px; font-weight:600; margin-bottom:3px; padding:2px 0;';
            shrineTitleEl.textContent = `${shrineLabel} Shrine${shrineCapLevel > 0 ? ` (cap: ${shrineCapLevel})` : ''}`;
            shrineSection.appendChild(shrineTitleEl);

            for (const { buffHrid, buff } of buffs.sort((a, b) => a.buffHrid.localeCompare(b.buffHrid))) {
                const isCombat = buff.isCombat;
                const buffLabel = isCombat ? 'Combat' : 'Skilling';
                const currentLevel = dataManager.getCharacterGuildBuffLevel(buffHrid);
                const maxLevel = Math.max(...Object.keys(buff.levelCosts).map(Number));
                const rawCap = shrineCapLevel > 0 ? Math.min(shrineCapLevel, maxLevel) : maxLevel;
                // Buildings and shrines cap at level 20 in-game (Buildings tab:
                // "Lv. x / 20") — a different ladder from the 21 trial tiers, and a
                // shrine level or levelCosts table that claims more than that is
                // not one to plan an upgrade past.
                const capLevel = Math.min(rawCap, GUILD_BUILDING_MAX_LEVEL);

                const row = document.createElement('div');
                row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:2px 0; font-size:11px;';

                const label = document.createElement('span');
                label.style.cssText = 'flex:1; color:#9ca3af;';
                label.textContent = `${buffLabel} (lvl ${currentLevel})`;

                const input = document.createElement('input');
                input.type = 'number';
                input.min = String(currentLevel);
                input.max = String(capLevel);
                input.value = String(currentLevel);
                input.dataset.buffHrid = buffHrid;
                input.style.cssText = `
                    width:52px; padding:2px 4px; background:#1a1a2e; border:1px solid #374151;
                    border-radius:3px; color:#e0e0e0; font-size:11px; text-align:center;
                `;
                input.addEventListener('input', () => {
                    recalculate();
                    const targets = planState().targets;
                    const value = parseInt(input.value, 10);
                    if (Number.isFinite(value) && value > currentLevel) targets[buffHrid] = Math.min(value, capLevel);
                    else delete targets[buffHrid];
                    this._savePlanSoon();
                });

                // The cost of this buff's next level only, for the suggestions
                // above — a buff already at its shrine's cap has no next level
                // and is left out.
                if (currentLevel < capLevel) {
                    const nextCost = buff.levelCosts?.[String(currentLevel + 1)];
                    if (nextCost) {
                        nextBuys.push({
                            buffHrid,
                            label: `${shrineLabel} · ${buffLabel}`,
                            fromLevel: currentLevel,
                            toLevel: currentLevel + 1,
                            tokenCost: nextCost.guildTokenCost || 0,
                            creditCosts: nextCost.creditCosts || [],
                        });
                    }
                }

                const capLabel = document.createElement('span');
                capLabel.style.cssText = 'color:#4b5563; font-size:10px;';
                capLabel.textContent = `/ ${capLevel}`;

                row.appendChild(label);
                row.appendChild(input);
                row.appendChild(capLabel);
                shrineSection.appendChild(row);

                planInputs.push({ buffHrid, currentLevel, capLevel, inputEl: input });
            }

            body.appendChild(shrineSection);
        }

        body.appendChild(totalsEl);
        body.appendChild(matsEl);

        /**
         * "What should I buy next" — every buff's single next level, cheapest
         * guild-token cost first.
         *
         * Ranked by token cost alone, and deliberately not by any blended score:
         * Force, Rarity and Scholar buy different things (combat power, loot,
         * experience) with no exchange rate between them, so a "best value"
         * number across shrines would be an invented one. Cheapest-unlock-first
         * is objective, and which of the cheap ones is worth having stays the
         * player's call. Credit costs are shown but not ranked on — tokens are
         * the scarce side, credits convert from ordinary skilling materials.
         */
        function renderSuggestions() {
            const itemDetailMap = gameData.itemDetailMap || {};
            const tokenHrid = Object.keys(itemDetailMap).find((hrid) => hrid.includes('guild_token'));
            const tokenName = (tokenHrid && itemDetailMap[tokenHrid]?.name) || 'Guild Tokens';
            const balance = tokenHrid ? heldInInventory(dataManager.getInventory(), tokenHrid) : 0;

            suggestEl.innerHTML = '';

            const heading = document.createElement('div');
            heading.style.cssText =
                'display:flex; justify-content:space-between; align-items:center; font-size:11px; color:#9ca3af; margin-bottom:5px;';
            heading.innerHTML = `<span>Suggested Next Buys</span><span style="color:#e0e0e0;">${tokenName}: <b>${balance.toLocaleString()}</b></span>`;
            suggestEl.appendChild(heading);

            if (nextBuys.length === 0) {
                const none = document.createElement('div');
                none.style.cssText = 'color:#6b7280; text-align:center; font-size:11px;';
                none.textContent = 'Every buff is at its shrine cap';
                suggestEl.appendChild(none);
                return;
            }

            const sorted = [...nextBuys].sort((a, b) => a.tokenCost - b.tokenCost || a.label.localeCompare(b.label));
            const { count, spent } = greedyAffordable(sorted, balance);

            sorted.forEach((buy, i) => {
                const affordable = i < count;
                const credits = buy.creditCosts
                    .map(({ itemHrid, count: n }) => {
                        const name = itemDetailMap[itemHrid]?.name || itemHrid.split('/').pop();
                        return `${n.toLocaleString()} ${name}`;
                    })
                    .join(', ');
                const row = document.createElement('div');
                row.className = 'mwi-shrine-next-buy';
                row.dataset.affordable = affordable ? 'yes' : 'no';
                row.style.cssText =
                    'display:flex; justify-content:space-between; gap:6px; padding:2px 0; font-size:11px;';
                row.innerHTML = `
                    <span style="color:${affordable ? '#4ade80' : '#9ca3af'};">${affordable ? '✓ ' : ''}${buy.label} <span style="color:#6b7280;">${buy.fromLevel}→${buy.toLevel}</span></span>
                    <span style="color:${affordable ? '#e0e0e0' : '#6b7280'}; white-space:nowrap;">${buy.tokenCost.toLocaleString()} tok${credits ? ` <span style="color:#6b7280;">+ ${credits}</span>` : ''}</span>
                `;
                suggestEl.appendChild(row);
            });

            const walk = document.createElement('div');
            walk.className = 'mwi-shrine-spend-all';
            walk.style.cssText =
                'margin-top:5px; padding-top:4px; border-top:1px solid rgba(255,255,255,0.1); font-size:11px; color:#9ca3af;';
            walk.textContent =
                count === 0
                    ? `Nothing on this list is affordable with ${balance.toLocaleString()} tokens`
                    : `Spending everything now: ${count} of ${sorted.length} next levels for ${spent.toLocaleString()} tokens`;
            suggestEl.appendChild(walk);
        }

        /**
         * Put the saved plan back into the inputs.
         *
         * Two things are pruned rather than restored, so the record does not
         * accumulate cruft as levels rise: a target at or below the buff's
         * current level (already met — a no-op), and a target above what the
         * input now accepts is clamped to the cap (the shrine may have been
         * upgraded, or its `levelCosts` table changed, since the plan was made).
         */
        const restorePlan = () => {
            const plan = planState();
            const targets = plan.targets;
            let pruned = false;
            for (const { buffHrid, currentLevel, capLevel, inputEl } of planInputs) {
                const saved = Number(targets[buffHrid]);
                if (!Number.isFinite(saved)) continue;
                if (saved <= currentLevel) {
                    delete targets[buffHrid];
                    pruned = true;
                    continue;
                }
                const clamped = Math.min(saved, capLevel);
                inputEl.value = String(clamped);
                if (clamped !== saved) {
                    targets[buffHrid] = clamped;
                    pruned = true;
                }
            }
            applyCollapsed(plan.collapsed !== false);
            recalculate();
            if (pruned) this._savePlanSoon();
        };

        restorePlan();
        renderSuggestions();

        // A modal opened before the record's initial read landed shows the
        // defaults; when the read finishes, the inputs it belongs in are filled.
        if (!shrinePlanRecord.isLoaded()) {
            (async () => {
                const readable = await shrinePlanRecord.load();
                if (readable && wrapper.isConnected) restorePlan();
            })();
        }

        // Insert after the advisor (or after the ranking table if no advisor)
        const advisorEl = modalEl.querySelector('.mwi-exchange-advisor');
        const rankingEl = modalEl.querySelector(`.${CSS_CLASS}`);
        const insertAfter = advisorEl || rankingEl;
        insertAfter?.insertAdjacentElement('afterend', wrapper);
    }

    _renderExchangeAdvisor(modalEl, creditHrid, rows) {
        modalEl.querySelectorAll('.mwi-exchange-advisor').forEach((el) => el.remove());

        // The source item is inside ItemSelector_itemContainer. Its identity comes from
        // the icon's <use> sprite reference (locale independent); the SVG's aria-label
        // is the translated display name and only backs it up.
        const selectorContainer = modalEl.querySelector('[class*="ItemSelector_itemContainer"]');
        const selectedItemHrid = itemHridFromIcon(selectorContainer, dataManager.getInitClientData()?.itemDetailMap);
        const itemSvg = selectorContainer?.querySelector('svg[aria-label]');
        const selectedItemName = itemSvg?.getAttribute('aria-label') || null;

        // Read batch quantity
        const quantityInput = modalEl.querySelector('input[type="number"]');
        const batches = Math.max(1, parseInt(quantityInput?.value || '1', 10) || 1);

        // Find best and selected rows (rows are pre-built from _render)
        const validRows = rows.filter((r) => r.sellGPC !== null || r.buyGPC !== null);
        if (validRows.length === 0) return;

        const bestRow = [...validRows].sort((a, b) => {
            const aVal = a.sellGPC ?? Infinity;
            const bVal = b.sellGPC ?? Infinity;
            return aVal - bVal;
        })[0];

        const advisor = document.createElement('div');
        advisor.className = 'mwi-exchange-advisor';
        advisor.style.cssText = `
            margin-top:8px; padding:8px 10px; border-radius:6px; font-size:12px;
            border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.2);
        `;

        if (!selectedItemHrid && !selectedItemName) {
            // No item selected yet
            advisor.innerHTML = `<div style="color:#6b7280; text-align:center;">Select an item to see exchange advice</div>`;
            modalEl.querySelector(`.${CSS_CLASS}`)?.insertAdjacentElement('afterend', advisor);
            return;
        }

        const selectedRow = selectedItemHrid
            ? validRows.find((r) => r.hrid === selectedItemHrid)
            : validRows.find((r) => r.name === selectedItemName);

        if (!selectedRow) {
            // Item in modal has no conversion for this credit type
            advisor.innerHTML = `<div style="color:#6b7280; text-align:center;">Selected item has no conversion for this credit</div>`;
            modalEl.querySelector(`.${CSS_CLASS}`)?.insertAdjacentElement('afterend', advisor);
            return;
        }

        if (selectedRow === bestRow) {
            advisor.style.borderColor = 'rgba(74,222,128,0.4)';
            advisor.innerHTML = `<div style="color:#4ade80; font-weight:600; text-align:center;">✓ Optimal choice for this credit type</div>`;
            modalEl.querySelector(`.${CSS_CLASS}`)?.insertAdjacentElement('afterend', advisor);
            return;
        }

        // Calculate sell → rebuy scenario
        const SELLER_TAX = MARKET_TAX;
        const sellPrice = selectedRow.buyPrice; // bid price = what market will buy at
        const directCredits = batches * selectedRow.creditCount;

        if (!sellPrice || sellPrice <= 0 || !bestRow.sellPrice || bestRow.sellPrice <= 0) {
            advisor.innerHTML = `<div style="color:#6b7280; text-align:center;">Best: <b style="color:#e0e0e0;">${bestRow.name}</b> — no price data for comparison</div>`;
            modalEl.querySelector(`.${CSS_CLASS}`)?.insertAdjacentElement('afterend', advisor);
            return;
        }

        const gross = batches * selectedRow.itemCount * sellPrice;
        const tax = Math.floor(gross * SELLER_TAX);
        const net = gross - tax;

        // How many batches of the best item can we buy with net proceeds?
        const bestBatchCost = bestRow.itemCount * bestRow.sellPrice;
        const bestBatches = Math.floor(net / bestBatchCost);
        const bestCredits = bestBatches * bestRow.creditCount;
        const creditDiff = bestCredits - directCredits;

        const diffColor = creditDiff > 0 ? '#4ade80' : '#ff6b6b';
        const diffSign = creditDiff > 0 ? '+' : '';
        const diffLabel = creditDiff > 0 ? '↑ better' : '↓ worse';

        advisor.style.borderColor = creditDiff > 0 ? 'rgba(74,222,128,0.3)' : 'rgba(255,107,107,0.3)';
        advisor.innerHTML = `
            <div style="color:#9ca3af; margin-bottom:6px; font-size:11px;">Sell → rebuy best item (${Math.round(MARKET_TAX * 100)}% tax)</div>
            <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                <span style="color:#aaa;">Direct exchange</span>
                <span style="color:#e0e0e0; font-weight:600;">${directCredits.toLocaleString()} credits</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                <span style="color:#aaa;">Sell proceeds (after tax)</span>
                <span style="color:#e0e0e0;">${formatKMB(net)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                <span style="color:#aaa;">Buy <b style="color:#e0e0e0;">${bestRow.name}</b> → credits</span>
                <span style="color:#e0e0e0; font-weight:600;">${bestCredits.toLocaleString()} credits</span>
            </div>
            <div style="display:flex; justify-content:space-between; border-top:1px solid rgba(255,255,255,0.1); padding-top:6px;">
                <span style="color:#aaa;">Difference</span>
                <span style="color:${diffColor}; font-weight:700;">${diffSign}${creditDiff.toLocaleString()} credits ${diffLabel}</span>
            </div>
        `;

        modalEl.querySelector(`.${CSS_CLASS}`)?.insertAdjacentElement('afterend', advisor);
    }

    _renderTrialSignup(modalEl) {
        modalEl.querySelectorAll('.mwi-trial-copy-btn').forEach((el) => el.remove());

        const memberList = modalEl.querySelector('[class*="GuildPanel_memberList"]');
        if (!memberList) return;

        const buttonsContainer = modalEl.querySelector('[class*="GuildPanel_buttonsContainer"]');
        if (!buttonsContainer) return;

        const copyBtn = document.createElement('button');
        copyBtn.className = 'mwi-trial-copy-btn';
        copyBtn.style.cssText = `
            width:100%; padding:8px 12px; margin-bottom:6px;
            background:linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%);
            color:#fff; border:1px solid rgba(91,141,239,0.4); border-radius:6px;
            cursor:pointer; font-size:12px; font-weight:600;
        `;
        copyBtn.textContent = 'Copy List';
        copyBtn.addEventListener('mouseenter', () => {
            copyBtn.style.background = 'linear-gradient(180deg,rgba(91,141,239,0.35) 0%,rgba(91,141,239,0.25) 100%)';
        });
        copyBtn.addEventListener('mouseleave', () => {
            copyBtn.style.background = 'linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%)';
        });
        copyBtn.addEventListener('click', () => {
            const names = Array.from(memberList.querySelectorAll('[class*="GuildPanel_memberName"]'))
                .map((el) => el.textContent.trim())
                .filter(Boolean)
                .join('\n');
            if (!names) return;
            navigator.clipboard.writeText(names).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => {
                    copyBtn.textContent = 'Copy List';
                }, 1500);
            });
        });

        buttonsContainer.insertAdjacentElement('beforebegin', copyBtn);
    }

    _renderShrine(modalEl) {
        if (!config.getSetting('guildCreditValue', true)) return;

        modalEl.querySelectorAll('.mwi-shrine-cost').forEach((el) => el.remove());

        const requirements = modalEl.querySelector('[class*="GuildPanel_itemRequirements"]');
        if (!requirements) return;

        const upgradeBtn = modalEl.querySelector('button');
        if (!upgradeBtn) return;

        const gameData = dataManager.getInitClientData();
        if (!gameData) return;

        const topConversions = buildTopConversions(gameData.itemDetailMap, 3);
        // Still need cheapest sell/buy for the credit row's own cost columns
        const { sell: cheapestSell, buy: cheapestBuy } = buildCheapestPerCredit(gameData.itemDetailMap);

        const itemContainers = Array.from(requirements.querySelectorAll('[class*="Item_itemContainer"]'));
        const inputCounts = Array.from(requirements.querySelectorAll('[class*="GuildPanel_inputCount"]'));
        if (itemContainers.length === 0) return;

        const inventory = dataManager.getInventory();
        const rows = [];
        let totalSell = 0;
        let totalBuy = 0;
        let allSellPriced = true;
        let allBuyPriced = true;

        itemContainers.forEach((container, i) => {
            const use = container.querySelector('use');
            const spriteId = use?.getAttribute('href')?.split('#')[1];
            if (!spriteId) return;

            const itemHrid = `/items/${spriteId}`;
            const required = parseInt(inputCounts[i]?.textContent?.replace(/[^0-9]/g, '') || '', 10) || 0;
            const owned = inventory
                .filter((inv) => inv.itemHrid === itemHrid && inv.itemLocationHrid === '/item_locations/inventory')
                .reduce((sum, inv) => sum + (inv.count || 0), 0);
            const effectiveRequired = Math.max(0, required - owned);
            const itemName = gameData.itemDetailMap?.[itemHrid]?.name || spriteId.replace(/_/g, ' ');
            const isToken = itemHrid.includes('guild_token');
            const isCredit = itemHrid.includes('guild_credit');

            let sellEach = getItemPrice(itemHrid, { mode: 'ask' });
            let buyEach = getItemPrice(itemHrid, { mode: 'bid' });

            if (isCredit) {
                if (!sellEach || sellEach <= 0) sellEach = cheapestSell[itemHrid] || null;
                if (!buyEach || buyEach <= 0) buyEach = cheapestBuy[itemHrid] || null;
            }

            let sellSub = sellEach && effectiveRequired ? sellEach * effectiveRequired : null;
            let buySub = buyEach && effectiveRequired ? buyEach * effectiveRequired : null;

            if (isCredit && effectiveRequired > 0) {
                const creditOptions = topConversions[itemHrid] || [];
                const askTop = creditOptions.find((o) => o.askGPC !== null);
                const bidTop = [...creditOptions].sort((a, b) => {
                    if (a.bidGPC === null) return 1;
                    if (b.bidGPC === null) return -1;
                    return a.bidGPC - b.bidGPC;
                })[0];
                sellSub = askTop?.askPrice
                    ? Math.ceil(effectiveRequired / askTop.creditCount) * askTop.itemCount * askTop.askPrice
                    : null;
                buySub = bidTop?.bidPrice
                    ? Math.ceil(effectiveRequired / bidTop.creditCount) * bidTop.itemCount * bidTop.bidPrice
                    : null;
            }

            if (sellSub !== null) totalSell += sellSub;
            else if (!isToken && effectiveRequired > 0) allSellPriced = false;

            if (buySub !== null) totalBuy += buySub;
            else if (!isToken && effectiveRequired > 0) allBuyPriced = false;

            rows.push({
                itemName,
                required,
                effectiveRequired,
                owned,
                sellEach,
                buyEach,
                sellSub,
                buySub,
                isCredit,
                creditHrid: isCredit ? itemHrid : null,
            });
        });

        if (rows.length === 0) return;

        let sortKey = 'ask';

        const buildTbody = () => {
            const tbody = document.createElement('tbody');
            rows.forEach((row) => {
                const tr = document.createElement('tr');
                tr.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.05); color:#e0e0e0;';
                tr.innerHTML = `
                    <td style="padding:4px 6px; text-align:left;">${row.itemName}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.effectiveRequired.toLocaleString()}${row.owned > 0 ? ` <span style="color:#6b7280;font-size:10px;">(own ${row.owned.toLocaleString()})</span>` : ''}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.sellEach ? formatKMB(row.sellEach) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.buyEach ? formatKMB(row.buyEach) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right;">${row.sellSub ? formatKMB(row.sellSub) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.buySub ? formatKMB(row.buySub) : '–'}</td>
                `;
                tbody.appendChild(tr);

                if (row.isCredit && row.creditHrid) {
                    const options = [...(topConversions[row.creditHrid] || [])];
                    options.sort((a, b) => {
                        const aVal = sortKey === 'bid' ? a.bidGPC : a.askGPC;
                        const bVal = sortKey === 'bid' ? b.bidGPC : b.askGPC;
                        if (aVal === null && bVal === null) return 0;
                        if (aVal === null) return 1;
                        if (bVal === null) return -1;
                        return aVal - bVal;
                    });
                    options.forEach((opt, idx) => {
                        const qtyNeeded = Math.ceil(row.effectiveRequired / opt.creditCount) * opt.itemCount;
                        const askTotal = opt.askPrice ? opt.askPrice * qtyNeeded : null;
                        const bidTotal = opt.bidPrice ? opt.bidPrice * qtyNeeded : null;
                        const isTop = idx === 0;
                        const nameColor = isTop ? '#4ade80' : '#9ca3af';
                        const rankPrefix = `↳ #${idx + 1}`;
                        const subTr = document.createElement('tr');
                        subTr.style.cssText = `border-bottom:1px solid rgba(255,255,255,0.03); font-size:11px;`;
                        const askStyle = `color:${sortKey === 'bid' ? '#6b7280' : isTop ? '#4ade80' : '#9ca3af'}; font-weight:${sortKey === 'ask' && isTop ? '600' : '400'};`;
                        const bidStyle = `color:${sortKey === 'ask' ? '#6b7280' : isTop ? '#4ade80' : '#9ca3af'}; font-weight:${sortKey === 'bid' && isTop ? '600' : '400'};`;
                        subTr.innerHTML = `
                            <td style="padding:2px 6px 2px 16px; text-align:left; color:${nameColor};">${rankPrefix} ${opt.name}</td>
                            <td style="padding:2px 6px; text-align:right; color:${nameColor};">${qtyNeeded.toLocaleString()}</td>
                            <td style="padding:2px 6px; text-align:right; color:#6b7280;">${opt.askPrice ? formatKMB(opt.askPrice) : '–'}</td>
                            <td style="padding:2px 6px; text-align:right; color:#6b7280;">${opt.bidPrice ? formatKMB(opt.bidPrice) : '–'}</td>
                            <td style="padding:2px 6px; text-align:right; ${askStyle}">${askTotal ? formatKMB(askTotal) : '–'}</td>
                            <td style="padding:2px 6px; text-align:right; ${bidStyle}">${bidTotal ? formatKMB(bidTotal) : '–'}</td>
                        `;
                        tbody.appendChild(subTr);
                    });
                }
            });

            const totalRow = document.createElement('tr');
            totalRow.style.cssText = 'border-top:1px solid rgba(255,255,255,0.2); color:#4ade80; font-weight:700;';
            totalRow.innerHTML = `
                <td style="padding:5px 6px;" colspan="4">Total</td>
                <td style="padding:5px 6px; text-align:right;">${totalSell > 0 ? formatKMB(totalSell) : '–'}${!allSellPriced ? '*' : ''}</td>
                <td style="padding:5px 6px; text-align:right;">${totalBuy > 0 ? formatKMB(totalBuy) : '–'}${!allBuyPriced ? '*' : ''}</td>
            `;
            tbody.appendChild(totalRow);
            return tbody;
        };

        const wrapper = document.createElement('div');
        wrapper.className = 'mwi-shrine-cost';
        wrapper.style.cssText = 'margin-top:12px; font-size:12px; width:100%;';

        const hdr = document.createElement('div');
        hdr.style.cssText = 'font-size:11px; color:#9ca3af; margin-bottom:6px; text-align:center;';
        hdr.textContent = 'Gold cost of upgrade — click to sort';
        wrapper.appendChild(hdr);

        const table = document.createElement('table');
        table.style.cssText = 'width:100%; border-collapse:collapse;';

        const thead = document.createElement('thead');
        const thRow = document.createElement('tr');
        thRow.style.cssText = 'font-size:11px; border-bottom:1px solid rgba(255,255,255,0.1);';

        [
            { text: 'Item', align: 'left' },
            { text: 'Qty', align: 'right' },
            { text: 'Ask ea.', align: 'right' },
            { text: 'Bid ea.', align: 'right' },
        ].forEach(({ text, align }) => {
            const th = document.createElement('th');
            th.style.cssText = `text-align:${align}; padding:3px 6px; font-weight:500; color:#6b7280;`;
            th.textContent = text;
            thRow.appendChild(th);
        });

        const askTh = document.createElement('th');
        askTh.textContent = 'Ask cost';
        const bidTh = document.createElement('th');
        bidTh.textContent = 'Bid cost';
        thRow.appendChild(askTh);
        thRow.appendChild(bidTh);
        thead.appendChild(thRow);
        table.appendChild(thead);

        const updateThStyles = () => {
            const isAsk = sortKey === 'ask';
            const active = 'font-weight:600; color:#e0e0e0; text-decoration:underline;';
            const inactive = 'font-weight:500; color:#6b7280;';
            askTh.style.cssText = `text-align:right; padding:3px 6px; cursor:pointer; ${isAsk ? active : inactive}`;
            bidTh.style.cssText = `text-align:right; padding:3px 6px; cursor:pointer; ${!isAsk ? active : inactive}`;
        };
        updateThStyles();

        let currentTbody = buildTbody();
        table.appendChild(currentTbody);

        const setSort = (key) => {
            sortKey = key;
            updateThStyles();
            const newTbody = buildTbody();
            table.replaceChild(newTbody, currentTbody);
            currentTbody = newTbody;
        };

        askTh.addEventListener('click', () => setSort('ask'));
        bidTh.addEventListener('click', () => setSort('bid'));

        wrapper.appendChild(table);

        if (!allSellPriced || !allBuyPriced) {
            const note = document.createElement('div');
            note.style.cssText = 'font-size:10px; color:#6b7280; margin-top:4px; text-align:center;';
            note.textContent = '* some items have no market price data';
            wrapper.appendChild(note);
        }

        // Build missing mats list from top-1 conversion per credit row
        const missingMats = [];
        for (const row of rows) {
            if (!row.isCredit || !row.creditHrid) continue;
            const top = (topConversions[row.creditHrid] || [])[0];
            if (!top?.hrid) continue;
            const qtyNeeded = Math.ceil(row.effectiveRequired / top.creditCount) * top.itemCount;
            const have = inventory
                .filter((i) => i.itemHrid === top.hrid && i.itemLocationHrid === '/item_locations/inventory')
                .reduce((sum, i) => sum + (i.count || 0), 0);
            const missing = Math.max(0, qtyNeeded - have);
            if (missing > 0) {
                missingMats.push({
                    itemHrid: top.hrid,
                    itemName: top.name,
                    missing,
                    required: qtyNeeded,
                    isTradeable: true,
                });
            }
        }

        if (missingMats.length > 0) {
            const missingBtn = document.createElement('button');
            missingBtn.style.cssText = `
                width:100%; padding:8px 12px; margin-top:8px;
                background:linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%);
                color:#fff; border:1px solid rgba(91,141,239,0.4); border-radius:6px;
                cursor:pointer; font-size:12px; font-weight:600;
            `;
            missingBtn.textContent = 'Missing Mats Marketplace';
            missingBtn.addEventListener('mouseenter', () => {
                missingBtn.style.background =
                    'linear-gradient(180deg,rgba(91,141,239,0.35) 0%,rgba(91,141,239,0.25) 100%)';
            });
            missingBtn.addEventListener('mouseleave', () => {
                missingBtn.style.background =
                    'linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%)';
            });
            missingBtn.addEventListener('click', async () => {
                navigateToMarketplace(missingMats[0].itemHrid, 0);

                // Tear down any previous shrine tab listener before creating new tabs
                if (this._shrineTabCleanup) {
                    this._shrineTabCleanup();
                    this._shrineTabCleanup = null;
                }

                // Wait for the marketplace tablist to render
                let tabsContainer = null;
                let referenceTab = null;
                for (let i = 0; i < 20; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    tabsContainer = visibleTabsContainer();
                    referenceTab = tabsContainer
                        ? Array.from(tabsContainer.children).find((btn) => btn.textContent.includes('My Listings'))
                        : null;
                    if (referenceTab) break;
                }
                if (!referenceTab) return;

                // Allow tabs to wrap and make the scroller visible
                const scroller = tabsContainer.closest('[class*="MuiTabs-scroller"]');
                const muiRoot = scroller?.closest('[class*="MuiTabs-root"]');
                tabsContainer.style.flexWrap = 'wrap';
                if (scroller) scroller.style.overflow = 'visible';
                if (muiRoot) muiRoot.style.height = 'auto';

                // Remove any existing action tabs and shrine tabs before inserting new ones
                removeMaterialTabs();
                removeShrineMarketTabs();

                for (const mat of missingMats) {
                    let tabEl = null;
                    const tab = createMaterialTab(mat, referenceTab, (_e, m) => {
                        this.autofillManager.setPendingCalculation(() =>
                            parseInt(tabEl?.getAttribute('data-missing-quantity') || '0', 10)
                        );
                        navigateToMarketplace(m.itemHrid, 0);
                    });
                    // Opt out of global removeMaterialTabs() cleanup so tabs survive tab-to-tab navigation
                    tab.removeAttribute('data-mwi-custom-tab');
                    tab.setAttribute('data-mwi-shrine-tab', 'true');
                    tab.setAttribute('data-required-quantity', mat.required.toString());
                    tab.setAttribute('data-item-name', mat.itemName);
                    tabEl = tab;
                    tabsContainer.appendChild(tab);
                }

                // Watch for inventory/market changes and update shrine tabs accordingly
                const shrineTabs = Array.from(document.querySelectorAll('[data-mwi-shrine-tab="true"]'));
                const inventoryUpdateHandler = (message) => {
                    const msgType = message?.type || '';
                    if (
                        !msgType.includes('item') &&
                        !msgType.includes('inventory') &&
                        !msgType.includes('market') &&
                        !message?.inventory &&
                        !message?.characterItems
                    )
                        return;

                    // One pass over the inventory for every tab, not one per tab
                    const haveByHrid = new Map();
                    for (const i of dataManager.getInventory() || []) {
                        if (i.itemLocationHrid !== '/item_locations/inventory') continue;
                        haveByHrid.set(i.itemHrid, (haveByHrid.get(i.itemHrid) || 0) + (i.count || 0));
                    }
                    let anyRemaining = false;

                    for (const tab of shrineTabs) {
                        if (!tab.isConnected) continue;
                        const itemHrid = tab.getAttribute('data-item-hrid');
                        const required = parseInt(tab.getAttribute('data-required-quantity') || '0', 10);
                        const itemName = tab.getAttribute('data-item-name') || '';
                        const have = haveByHrid.get(itemHrid) || 0;
                        const missing = Math.max(0, required - have);

                        if (missing === 0) {
                            tab.remove();
                        } else {
                            updateTabBadge(tab, { itemHrid, itemName, missing, required, isTradeable: true });
                            anyRemaining = true;
                        }
                    }

                    if (!anyRemaining) {
                        webSocketHook.off('*', inventoryUpdateHandler);
                        this._shrineTabCleanup = null;
                    }
                };

                webSocketHook.on('*', inventoryUpdateHandler);
                this._shrineTabCleanup = () => webSocketHook.off('*', inventoryUpdateHandler);
            });
            wrapper.appendChild(missingBtn);
        }

        upgradeBtn.insertAdjacentElement('afterend', wrapper);

        const levelEl = modalEl.querySelector('[class*="GuildPanel_level"]');
        if (!levelEl) return;

        upgradeBtn.addEventListener(
            'click',
            () => {
                const observer = new MutationObserver(() => {
                    observer.disconnect();
                    this._renderShrine(modalEl);
                });
                observer.observe(levelEl, { subtree: true, childList: true, characterData: true });
            },
            { once: true }
        );
    }

    _renderTrialTier(el) {
        // The badge itself, its ladder and its level cap all live in
        // `guild-trial-tier-badge.js`, because the trials feature draws the
        // same marker from its own tile pass and two copies of the rule would
        // drift. This tab observer is what puts one on every card, including
        // the ones the trials feature is not rendering a block beside.
        //
        // Guarded by the badge's own presence rather than a `data-` flag: React
        // reuses the level line and replaces its children on every redraw, so
        // the flag survived the span and the marker never came back. That is
        // why the maintainer's card read "Lv.260" with no tier on it.
        //
        // `GuildPanel_tileSummary` is not exclusive to trial tiles — the same
        // class also carries a guild building's "Lv. x / 20"
        // (GUILD_BUILDING_MAX_LEVEL, from guild-trials-store.js). The badge
        // helper keeps the two apart: a level below the first trial level
        // (100) resolves to no tier and gets no badge.
        const owner = el.closest?.('[data-mwi-trial-banked]');
        const banked = Number(owner?.dataset?.mwiTrialBanked);
        renderTierBadge(el, { bankedTiers: Number.isFinite(banked) ? banked : null });
    }

    cleanup() {
        this.unregisterObservers.forEach((fn) => fn());
        this.unregisterObservers = [];
        this._disconnectAdvisorObserver();
        // A plan edited in the last few hundred milliseconds is written now
        // rather than dropped with the timer
        if (this._planSaveTimer) {
            clearTimeout(this._planSaveTimer);
            this._planSaveTimer = null;
            shrinePlanRecord.save();
        }
        if (this._shrineTabCleanup) {
            this._shrineTabCleanup();
            this._shrineTabCleanup = null;
        }
        removeShrineMarketTabs();
        document.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll('.mwi-shrine-cost').forEach((el) => el.remove());
        document.querySelectorAll('.mwi-trial-copy-btn').forEach((el) => el.remove());
        document.querySelectorAll(`.${TIER_BADGE_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll('.mwi-exchange-advisor').forEach((el) => el.remove());
        document.querySelectorAll('.mwi-shrine-planner').forEach((el) => el.remove());
        this.initialized = false;
    }
}

const guildCreditValue = new GuildCreditValue();

/**
 * The shrine plan record, for a character switch to `reset()` and for tests to
 * drive. Everything else goes through the planner.
 */
export { shrinePlanRecord };

export default {
    name: 'Guild Credit Value',
    initialize: () => guildCreditValue.initialize(),
    cleanup: () => {
        try {
            return guildCreditValue.cleanup();
        } catch (error) {
            console.error('[Guild Credit Value] Disable failed part-way:', error);
        } finally {
            guildCreditValue.initialized = false;
        }
    },
};
