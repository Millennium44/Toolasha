/**
 * Dungeon token spend planner.
 *
 * "What should I buy with these tokens?" — the token tooltip ranks the shop by
 * gold per token, but the best-ranked item may trade a handful a week, and a
 * stack of fifty of it is not fifty sales. This panel plans the whole stack:
 * greedy by net gold per token, each item held to what the market could take
 * from you in a window (a share of the pooled history's traded volume, the
 * measurement the liquidity cap already uses), and says what is left over.
 *
 * ## Toolasha never buys
 *
 * A plan row opens the Shop on its Dungeon tab, filters it to the item and arms
 * the quantity; the player clicks the item's card and the game's dialog opens
 * with the quantity already typed. Pressing Buy is the player's click. The shop
 * card is not clicked for them either — one click, one game action (see
 * `tester-shop-nav.js`). When the shop cannot be reached the panel says the
 * number to type instead.
 *
 * ## Values
 *
 * Unit values are the token tooltip's own (the current ask, from
 * `dungeon-shop-offers.js`) less the market tax `calculatePriceAfterTax`
 * applies, which follows the server's patch gate. They are current sell prices,
 * not a walk down the order book — the panel says so.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';
import { itemDailyVolume } from '../../utils/liquidity-cap.js';
import { createAutofillManager } from '../../utils/marketplace-autofill.js';
import { calculatePriceAfterTax, outputTaxRate } from '../../utils/profit-helpers.js';
import { createPanel, panelNote } from '../../utils/simple-panel.js';
import { openShopTab, setShopFilter } from '../../utils/tester-shop-nav.js';
import { DUNGEON_TOKEN_HRIDS, dungeonShopOffers, ownedTokenCount } from './dungeon-shop-offers.js';
import { DEFAULT_CAP_DAYS, DEFAULT_CAP_SHARE_PERCENT, planTokenSpend, volumeCap } from './dungeon-shop-plan.js';

/** The feature's switch; also gates the tooltip hint line */
export const PLANNER_SETTING = 'dungeonShopPlanner';
export const DAYS_SETTING = 'dungeonShopPlanner_days';
export const SHARE_SETTING = 'dungeonShopPlanner_sharePercent';
export const UNMEASURED_SETTING = 'dungeonShopPlanner_includeUnmeasured';

/** The Shop tab the dungeon items are sold on */
export const DUNGEON_TAB_LABEL = /^\s*dungeons?\s*$/i;

const BUTTON_CLASS = 'toolasha-dungeon-plan-spend';
const ACCENT = '#8fb4ff';
const MUTED = 'rgba(232, 236, 245, 0.5)';
const WARN = '#ffb74d';

const REASON_TEXT = {
    volume: 'volume cap',
    tokens: 'out of tokens',
    'no-price': 'no market price',
    unprofitable: 'no value',
    'no-volume': 'no volume data',
};

/**
 * The dungeon-shop spend planner: a floating panel, a "Plan spend" button on
 * the Shop's Dungeon tab, and the row click that arms the game's buy dialog.
 */
class DungeonShopPlanner {
    constructor() {
        this.panel = null;
        this.autofill = null;
        this.unregisters = [];
        this.tokenHrid = null;
        /** @type {Map<string, Object>} itemHrid → volume measurement */
        this.volumes = new Map();
        /** @type {Set<string>} itemHrids being measured */
        this.measuring = new Set();
        this.status = '';
        this.lastPlan = null;
        this.initialized = false;
    }

    /** Set up the button observer and the panel shell */
    initialize() {
        if (this.initialized) return;
        this.initialized = true;

        this.autofill = createAutofillManager('DungeonShopPlanner');
        this.panel = createPanel({
            id: 'dungeon-shop-planner',
            title: 'Dungeon token spend plan',
            size: { width: 470, height: 440 },
            accent: ACCENT,
            refreshMs: 5000,
            draw: (body) => this.draw(body),
        });

        this.unregisters.push(
            domObserver.onClass('DungeonShopPlanner_tabs', 'MuiTabs-flexContainer', () => this.scanShopTabs(), {
                debounce: true,
            })
        );
        this.unregisters.push(domObserver.onReady('DungeonShopPlanner_catchUp', () => this.scanShopTabs()));
    }

    /** Undo everything `initialize` did */
    cleanup() {
        for (const unregister of this.unregisters.splice(0)) {
            try {
                unregister?.();
            } catch (error) {
                console.error('[DungeonShopPlanner] Unregister failed:', error);
            }
        }
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
        this.panel?.destroy();
        this.panel = null;
        this.autofill?.cleanup();
        this.autofill = null;
        this.volumes.clear();
        this.measuring.clear();
        this.status = '';
        this.initialized = false;
    }

    /**
     * Put a "Plan spend" button beside the Shop's tab strip, shown while the
     * Dungeon tab is the selected one.
     */
    scanShopTabs() {
        for (const strip of document.querySelectorAll('.MuiTabs-flexContainer[role="tablist"]')) {
            const dungeonTab = findDungeonTab(strip);
            if (!dungeonTab || !strip.closest('[class*="ShopPanel"]')) continue;

            const tabsRoot = strip.closest('.MuiTabs-root') || strip;
            let button = tabsRoot.nextElementSibling;
            if (!button?.classList?.contains(BUTTON_CLASS)) {
                button = createPlanButton(() => this.open());
                tabsRoot.insertAdjacentElement('afterend', button);
                // Selecting a tab re-renders only the panel below, not the
                // strip, so visibility follows clicks on the strip itself
                strip.addEventListener('click', () => setTimeout(() => syncButton(strip, button), 50));
            }
            syncButton(strip, button);
        }
    }

    /**
     * Open the panel, on the token asked for or the one the character holds most of.
     * @param {string} [tokenHrid] - A dungeon token
     */
    open(tokenHrid = null) {
        this.tokenHrid = tokenHrid || this.tokenHrid || mostHeldToken();
        this.panel?.show();
        this.measure(this.tokenHrid);
    }

    /** The planner's current inputs, from settings */
    options() {
        return {
            days: clampNumber(config.getSettingValue(DAYS_SETTING, DEFAULT_CAP_DAYS), 0.1, 365, DEFAULT_CAP_DAYS),
            sharePercent: clampNumber(
                config.getSettingValue(SHARE_SETTING, DEFAULT_CAP_SHARE_PERCENT),
                0.1,
                100,
                DEFAULT_CAP_SHARE_PERCENT
            ),
            includeUnmeasured: config.getSetting(UNMEASURED_SETTING, false) === true,
        };
    }

    /**
     * Fetch the traded volume of every priced item this token buys, once each.
     * @param {string} tokenHrid - A dungeon token
     * @returns {Promise<void>}
     */
    async measure(tokenHrid) {
        const wanted = dungeonShopOffers(tokenHrid).filter(
            (offer) => offer.askPrice > 0 && !this.volumes.has(offer.itemHrid) && !this.measuring.has(offer.itemHrid)
        );
        for (const offer of wanted) this.measuring.add(offer.itemHrid);
        if (wanted.length) this.panel?.render();

        // One at a time: the pooled-history host has refused bursts before
        for (const offer of wanted) {
            const volume = await itemDailyVolume(offer.itemHrid, 0);
            if (!this.initialized) return;
            this.volumes.set(offer.itemHrid, volume);
            this.measuring.delete(offer.itemHrid);
            this.panel?.render();
        }
    }

    /**
     * The plan for a token, from what is known right now.
     * @param {string} tokenHrid - A dungeon token
     * @returns {Object} `planTokenSpend`'s result plus `tokens` and `measuring`
     */
    plan(tokenHrid) {
        const options = this.options();
        const offers = dungeonShopOffers(tokenHrid).map((offer) => ({
            itemHrid: offer.itemHrid,
            name: offer.name,
            cost: offer.cost,
            netValue: offer.askPrice > 0 ? calculatePriceAfterTax(offer.askPrice) : null,
        }));
        const caps = {};
        for (const offer of offers) {
            if (this.volumes.has(offer.itemHrid)) {
                caps[offer.itemHrid] = volumeCap(this.volumes.get(offer.itemHrid), options);
            }
        }
        const tokens = ownedTokenCount(tokenHrid);
        return {
            ...planTokenSpend({ offers, tokens, caps }),
            tokens,
            options,
            measuring: offers.filter((offer) => this.measuring.has(offer.itemHrid)).length,
        };
    }

    /**
     * Draw the panel body.
     * @param {HTMLElement} body - The panel's body
     */
    draw(body) {
        const tokenHrid = this.tokenHrid || mostHeldToken();
        this.tokenHrid = tokenHrid;
        const result = this.plan(tokenHrid);
        this.lastPlan = result;

        body.appendChild(this.drawControls(tokenHrid, result.options));

        const held = document.createElement('div');
        held.textContent = `${formatWithSeparator(result.tokens)} ${itemName(tokenHrid)}s held`;
        body.appendChild(held);

        if (!result.rows.length) {
            body.appendChild(panelNote('The Dungeon shop sells nothing for this token, or game data is not loaded.'));
            return;
        }

        body.appendChild(this.drawTable(result));

        const summary = document.createElement('div');
        summary.style.fontWeight = 'bold';
        summary.textContent =
            `Spend ${formatWithSeparator(result.spent)} → ~${formatKMB(result.gold)} gold after tax` +
            ` · ${formatWithSeparator(result.leftover)} left over`;
        body.appendChild(summary);

        if (result.measuring > 0) {
            body.appendChild(panelNote(`Measuring traded volume for ${result.measuring} item(s)…`));
        }
        if (result.rows.some((row) => row.reason === 'no-volume')) {
            body.appendChild(
                panelNote('Items with no volume data are capped at 0. Tick "include unmeasured" to plan them uncapped.')
            );
        }
        if (this.status) {
            const status = document.createElement('div');
            status.style.color = WARN;
            status.textContent = this.status;
            body.appendChild(status);
        }

        const taxPercent = Math.round(outputTaxRate() * 1000) / 10;
        body.appendChild(
            panelNote(
                `Values are current ask prices less ${taxPercent}% market tax — sell prices, not a walk down the ` +
                    `order book. Caps: ${result.options.sharePercent}% of ${result.options.days} day(s) of traded ` +
                    'volume. Click a planned row to open it in the Shop; you press Buy.'
            )
        );
    }

    /**
     * Token picker, window, share and the unmeasured switch.
     * @param {string} tokenHrid - The token shown
     * @param {Object} options - Current planner options
     * @returns {HTMLElement}
     */
    drawControls(tokenHrid, options) {
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' });

        const select = document.createElement('select');
        select.className = 'toolasha-dungeon-plan-token';
        for (const hrid of DUNGEON_TOKEN_HRIDS) {
            const option = document.createElement('option');
            option.value = hrid;
            option.textContent = `${itemName(hrid)} (${formatWithSeparator(ownedTokenCount(hrid))})`;
            option.selected = hrid === tokenHrid;
            select.appendChild(option);
        }
        select.addEventListener('change', () => {
            this.tokenHrid = select.value;
            this.status = '';
            this.panel?.render();
            this.measure(select.value);
        });
        row.appendChild(select);

        row.appendChild(
            numberField('Days', options.days, 'toolasha-dungeon-plan-days', (value) => {
                config.setSettingValue(DAYS_SETTING, value);
                this.panel?.render();
            })
        );
        row.appendChild(
            numberField('% of volume', options.sharePercent, 'toolasha-dungeon-plan-share', (value) => {
                config.setSettingValue(SHARE_SETTING, value);
                this.panel?.render();
            })
        );

        const label = document.createElement('label');
        Object.assign(label.style, { display: 'flex', gap: '3px', alignItems: 'center', cursor: 'pointer' });
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'toolasha-dungeon-plan-unmeasured';
        box.checked = options.includeUnmeasured;
        box.addEventListener('change', () => {
            config.setSetting(UNMEASURED_SETTING, box.checked);
            this.panel?.render();
        });
        label.append(box, document.createTextNode('include unmeasured'));
        row.appendChild(label);

        return row;
    }

    /**
     * The plan table.
     * @param {Object} result - The plan
     * @returns {HTMLElement}
     */
    drawTable(result) {
        const table = document.createElement('table');
        Object.assign(table.style, { width: '100%', borderCollapse: 'collapse' });
        const head = table.insertRow();
        for (const [text, align] of [
            ['Item', 'left'],
            ['Qty', 'right'],
            ['Tokens', 'right'],
            ['Gold', 'right'],
            ['Gold/Token', 'right'],
            ['Cap', 'right'],
        ]) {
            const th = document.createElement('th');
            th.textContent = text;
            Object.assign(th.style, { textAlign: align, padding: '2px 4px', color: MUTED, fontWeight: 'normal' });
            head.appendChild(th);
        }

        for (const planRow of result.rows) {
            const tr = table.insertRow();
            tr.className = 'toolasha-dungeon-plan-row';
            tr.dataset.itemHrid = planRow.itemHrid;
            const planned = planRow.quantity > 0;
            if (!planned) tr.style.color = MUTED;
            if (planned) {
                tr.style.cursor = 'pointer';
                tr.title = `Open ${planRow.name} in the Dungeon shop with ${planRow.quantity} filled in`;
                tr.addEventListener('click', () => this.openInShop(planRow));
            }

            const cells = [
                planRow.name,
                planned ? formatWithSeparator(planRow.quantity) : '—',
                planned ? formatWithSeparator(planRow.tokens) : '',
                planned ? formatKMB(planRow.gold) : '',
                planRow.goldPerToken > 0 ? formatKMB(planRow.goldPerToken) : '',
                this.capText(planRow),
            ];
            cells.forEach((text, index) => {
                const td = tr.insertCell();
                td.textContent = text;
                Object.assign(td.style, { padding: '2px 4px', textAlign: index === 0 ? 'left' : 'right' });
                if (index === 5 && planRow.measured === false && planRow.cap === Number.POSITIVE_INFINITY) {
                    td.style.color = WARN;
                }
            });
        }
        return table;
    }

    /**
     * What the Cap cell says for a row.
     * @param {Object} planRow - One plan row
     * @returns {string}
     */
    capText(planRow) {
        if (this.measuring.has(planRow.itemHrid)) return 'measuring…';
        if (planRow.reason === 'no-price' || planRow.reason === 'unprofitable') return REASON_TEXT[planRow.reason];
        if (!planRow.measured) {
            return planRow.cap === Number.POSITIVE_INFINITY ? 'unmeasured, uncapped' : REASON_TEXT['no-volume'];
        }
        const perDay = planRow.unitsPerDay >= 1 ? Math.round(planRow.unitsPerDay) : planRow.unitsPerDay.toFixed(2);
        const suffix = planRow.reason === 'volume' ? ' ◂' : '';
        return `${formatWithSeparator(planRow.cap)} (~${perDay}/day)${suffix}`;
    }

    /**
     * Open a planned item in the Shop's Dungeon tab with its quantity armed.
     * Never presses the card or Buy.
     * @param {Object} planRow - One plan row with a quantity
     * @returns {Promise<void>}
     */
    async openInShop(planRow) {
        const quantity = planRow.quantity;
        this.status = `Opening the Dungeon shop for ${planRow.name}…`;
        this.panel?.render();

        let tab = null;
        try {
            tab = await openShopTab(DUNGEON_TAB_LABEL);
        } catch (error) {
            console.error('[DungeonShopPlanner] Opening the shop failed:', error);
        }
        if (!this.initialized) return;
        if (!tab) {
            this.status = `Shop not found — buy ${planRow.name} and type ${quantity} in the quantity box.`;
            this.panel?.render();
            return;
        }

        // Armed after the tab is selected: selecting a shop tab is what clears
        // an armed quantity
        const filtered = setShopFilter(planRow.name);
        this.autofill.initialize();
        this.autofill.setQuantity(quantity, { itemHrid: planRow.itemHrid });
        this.status =
            `${filtered ? 'Shop filtered to' : 'Find'} ${planRow.name}: click its card and the quantity box will ` +
            `read ${quantity} (if not, type it). Press Buy yourself.`;
        this.panel?.render();
    }
}

/**
 * The Dungeon tab in a tab strip.
 * @param {Element} strip - A MUI tab strip
 * @returns {HTMLElement|null}
 */
function findDungeonTab(strip) {
    return Array.from(strip.children).find((el) => DUNGEON_TAB_LABEL.test(el.textContent || '')) || null;
}

/**
 * Show the button only while the Dungeon tab is selected.
 * @param {Element} strip - The Shop's tab strip
 * @param {HTMLElement} button - The Plan spend button
 */
function syncButton(strip, button) {
    const tab = findDungeonTab(strip);
    button.style.display = tab?.getAttribute('aria-selected') === 'true' ? '' : 'none';
}

/**
 * @param {Function} onClick - Opens the panel
 * @returns {HTMLButtonElement}
 */
function createPlanButton(onClick) {
    const button = document.createElement('button');
    button.className = BUTTON_CLASS;
    button.type = 'button';
    button.textContent = 'Plan spend';
    button.title = 'Plan what to buy with your dungeon tokens, capped by market volume';
    Object.assign(button.style, {
        margin: '4px 8px',
        padding: '3px 10px',
        background: 'rgba(143, 180, 255, 0.15)',
        border: `1px solid ${ACCENT}`,
        borderRadius: '4px',
        color: '#e8ecf5',
        cursor: 'pointer',
        fontSize: '12px',
    });
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
    });
    return button;
}

/**
 * A small labelled number box that reports on change.
 * @param {string} labelText - Label
 * @param {number} value - Current value
 * @param {string} className - For tests and styling
 * @param {Function} onChange - `(number) => void`, only for a positive number
 * @returns {HTMLElement}
 */
function numberField(labelText, value, className, onChange) {
    const label = document.createElement('label');
    Object.assign(label.style, { display: 'flex', gap: '3px', alignItems: 'center' });
    const input = document.createElement('input');
    input.type = 'number';
    input.className = className;
    input.value = String(value);
    input.min = '0';
    input.step = 'any';
    input.style.width = '52px';
    input.addEventListener('change', () => {
        const next = Number(input.value);
        if (Number.isFinite(next) && next > 0) onChange(next);
    });
    label.append(document.createTextNode(labelText), input);
    return label;
}

/**
 * @param {*} value - A stored setting
 * @param {number} min - Lowest allowed
 * @param {number} max - Highest allowed
 * @param {number} fallback - When the stored value is not a number
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(max, Math.max(min, number));
}

/** The dungeon token the character holds most of, the first one when none */
function mostHeldToken() {
    let best = DUNGEON_TOKEN_HRIDS[0];
    let bestCount = -1;
    for (const hrid of DUNGEON_TOKEN_HRIDS) {
        const count = ownedTokenCount(hrid);
        if (count > bestCount) {
            best = hrid;
            bestCount = count;
        }
    }
    return best;
}

/**
 * @param {string} hrid - An item
 * @returns {string} Its display name
 */
function itemName(hrid) {
    return dataManager.getInitClientData?.()?.itemDetailMap?.[hrid]?.name || hrid.split('/').pop();
}

const dungeonShopPlanner = new DungeonShopPlanner();

export { dungeonShopPlanner };

export default {
    name: 'Dungeon Shop Planner',
    initialize: async () => {
        dungeonShopPlanner.initialize();
    },
    cleanup: () => {
        dungeonShopPlanner.cleanup();
    },
    disable: () => {
        dungeonShopPlanner.cleanup();
    },
};
