/**
 * Consumables panel
 *
 * Everything the character is eating and drinking — and, in a dungeon, the
 * entry keys the runs are spending — how long it lasts, and what it would take
 * to keep it going.
 *
 * The overlay row answers "what runs out first, and when". That is the figure
 * worth watching, but it is not the figure worth acting on — when the answer is
 * "six hours", the next question is immediately "so what do I buy, and how
 * much", and the row cannot hold that. This can.
 *
 * ## The target duration is the point
 *
 * Every line is measured against a duration you pick: overnight, a day, a
 * weekend. A list of stock levels tells you what you have; the same list against
 * "last me a day" tells you what to do about it, and the two readings differ for
 * every consumable because they are consumed at different rates.
 *
 * Shortfalls are rounded up and counted from what is already held, so the figure
 * is what to buy rather than what to own. The arithmetic is in
 * `utils/consumable-forecast.js`; this module lists, sorts and draws.
 *
 * Party members are shown when there are any, because a party run stops when the
 * **first** member runs dry, and that member is frequently not you.
 *
 * ## Why it lives in the UI bundle
 *
 * It reads combat data but is otherwise a panel, and the combat bundle is close
 * to its size ceiling while this one is not. The collector it reads is a
 * stateful singleton fed by the websocket, so it is declared shared in
 * `rollup.config.js` rather than imported into a second copy that would sit
 * there receiving nothing.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { shortDuration, itemIcon, linkToMarketplace, ROW_COLORS } from '../../utils/overlay-format.js';
import { getItemPrices } from '../../utils/market-data.js';
import { currentTarget, cycleTarget, loadTarget } from '../../utils/consumable-target.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import {
    forecast,
    forecastAll,
    firstToRunOut,
    costPerDaySides,
    refillFor,
    refillAll,
    drinkRatePerDay,
    buyStrategy,
} from '../../utils/consumable-forecast.js';
import { dungeonEntryKey, heldInInventory, keyConsumableEntry } from '../../utils/dungeon-key-forecast.js';
import { resolveSupplyHrids, readSupplyCounts, bestOwnedTier, SUPPLY_KINDS } from '../combat/labyrinth-supplies.js';
import storage from '../../core/storage.js';
import { createAutofillManager } from '../../utils/marketplace-autofill.js';
import { estimateFillSeconds } from '../../utils/order-book.js';
import { openShoppingList } from './consumables-shopping-list.js';
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { calculatePlayerStats } from '../combat-stats/combat-stats-calculator.js';
import { queueLengthEstimator } from '../../utils/bundle-bridge.js';
import { getDrinkConcentration } from '../../utils/tea-parser.js';
import { readScoped } from '../../utils/character-key.js';

const PANEL_ID = 'toolasha-consumables-panel';
const GEOMETRY_KEY = 'consumablesPanel';
const DEFAULT_PANEL = { width: 520, height: 420 };
const REFRESH_MS = 5000;

const COLORS = {
    background: 'rgba(8, 10, 20, 0.97)',
    headerBg: 'rgba(20, 30, 24, 0.9)',
    border: 'rgba(120, 200, 150, 0.32)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.55)',
    accent: '#7fd6a3',
};

class ConsumablesPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.refreshId = null;
        // The same mechanism the missing-materials features use: park a quantity,
        // and the buy modal fills itself in when it appears
        this.autofill = createAutofillManager('Consumables');
        this.autofill.initialize?.();
    }

    /**
     * Open the panel, or raise it if it is already up.
     * @param {Object} [options] - `remember: false` when reopening at start-up,
     *   so restoring a panel is not itself recorded as opening one
     */
    show({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, true);
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    hide({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, false);
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    /** Reopen if the page was left with this panel up */
    restore() {
        reopenIfLeftOpen(GEOMETRY_KEY, () => this.show({ remember: false }));
    }

    /** Read back the duration everything is measured against */
    async loadSettings() {
        await loadTarget(() => this._render());
        this._labRuns = Number(await storage.get('consumablesLabRuns', 'settings', 5)) || 5;
        // The last sim's measured consumable use, for rating food while idle
        this._simRates = await readScoped('simConsumableRates', 'combatExport', null).catch(() => null);
    }

    /** The duration everything is measured against */
    get target() {
        return currentTarget();
    }

    /**
     * Every player's consumables, the current character first.
     *
     * A party run stops when the first member runs dry, and that member is
     * frequently not you — so party members are listed rather than summarised
     * away.
     *
     * @returns {Array<{name: string, isCurrent: boolean, forecasts: Array<Object>}>}
     */
    _players() {
        const data = combatStatsDataCollector.getLatestData();
        if (!data?.players?.length) return [];

        const duration = data.durationSeconds || 0;
        return data.players
            .map((player) => {
                const stats = calculatePlayerStats(player, duration);
                const forecasts = forecastAll(
                    this._exactRates(stats?.consumableBreakdown, player),
                    (hrid) => getItemPrices(hrid),
                    {
                        keepOrder: true,
                    }
                );

                // The dungeon's entry key, for the character whose inventory is
                // visible — a run stops on an empty key pile exactly as it does
                // on an empty coffee slot, so it belongs in the same list
                if (player.isCurrentPlayer) {
                    const key = this._keyForecast(stats, data);
                    if (key) forecasts.push(key);
                }

                return {
                    name: player.name || 'Unknown',
                    isCurrent: !!player.isCurrentPlayer,
                    forecasts,
                };
            })
            .filter((entry) => entry.forecasts.length)
            .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
    }

    /**
     * The current dungeon's entry key as a forecast, or null outside a dungeon.
     *
     * Null is the whole answer for a zone: the panel must render exactly as it
     * always has when no keys are being spent. The rate is the session's own
     * measurement — one entry key per regular chest, over the run's duration,
     * the same arithmetic the combat stats price keys with — and a session that
     * has not dropped a chest yet honestly has no rate, which the row shows as
     * "—" while still counting what is held.
     *
     * @param {Object} stats - From `calculatePlayerStats`, for its `keyBreakdown`
     * @param {Object} data - The collector's snapshot, for the action and duration
     * @returns {Object|null} A forecast like any other, or null when not a dungeon
     */
    _keyForecast(stats, data) {
        try {
            const actionHrid = data?.actionHrid;
            if (!actionHrid) return null;

            const keyHrid = dungeonEntryKey(actionHrid, dataManager.getActionDetails?.(actionHrid));
            if (!keyHrid) return null;

            const prices = getItemPrices(keyHrid);
            const entry = keyConsumableEntry({
                itemHrid: keyHrid,
                itemName: dataManager.getItemDetails?.(keyHrid)?.name,
                held: heldInInventory(dataManager.getInventory?.(), keyHrid),
                keyBreakdown: stats?.keyBreakdown,
                durationSeconds: data.durationSeconds || 0,
                fallbackPrice: prices?.ask,
            });
            return forecast(entry, prices);
        } catch (error) {
            console.error('[ConsumablesPanel] Building the entry-key row failed:', error);
            return null;
        }
    }

    /**
     * Replace measured drink rates with the arithmetic ones.
     *
     * A drink is re-drunk the moment its buff expires, so its rate follows from
     * the buff's duration and the player's drink concentration and needs no
     * observing. Food is eaten on a health or mana trigger, which depends on
     * what is hitting you, so it is left measured — there is nothing to compute.
     *
     * The measured figure was also capped at a hardcoded 345.6 a day, the rate
     * at the maximum 20% concentration, so anyone below that was told their
     * drinks would run out sooner than they will.
     *
     * @param {Array<Object>} breakdown - From `calculatePlayerStats`
     * @param {Object} player - The collector's player entry, for its concentration
     * @returns {Array<Object>} The same entries, drinks re-rated
     */
    _exactRates(breakdown, player) {
        const concentration = player?.combatStats?.drinkConcentration || 0;

        return (breakdown || []).map((entry) => {
            const detail = dataManager.getItemDetails?.(entry?.itemHrid);
            const duration = detail?.consumableDetail?.buffs?.[0]?.duration;
            const perDay = drinkRatePerDay(duration, concentration);
            if (perDay === null) return entry;

            return { ...entry, consumptionRate: perDay / 86400, consumedPerDay: Math.ceil(perDay) };
        });
    }

    /**
     * How long a buy order for this item would sit, from the real book.
     *
     * The queue length estimator caches every order book the game has sent, so
     * the depth and the listing timestamps are already in hand for anything you
     * have opened. Reached through the global rather than imported, because it
     * lives in the market bundle and this panel does not — and because an item
     * whose book has never been seen must degrade to "no measurement" rather
     * than to an error.
     *
     * @param {string} itemHrid - The item
     * @param {number} count - How many the order would be for
     * @returns {number|null} Seconds, or null when no book has been seen
     */
    _fillSeconds(itemHrid, count) {
        try {
            const cached = queueLengthEstimator()?.orderBooksCache?.[itemHrid];
            // A buy order joins the bid side, so that is the queue it waits in
            const bids = (cached?.data || cached)?.orderBooks?.[0]?.bids;
            return estimateFillSeconds(bids, count);
        } catch (error) {
            console.error('[ConsumablesPanel] Reading the order book failed:', error);
            return null;
        }
    }

    /**
     * Send the whole restock to the marketplace as tabs.
     * @param {Array<Object>} shortfall - What to buy
     */
    _openShoppingList(shortfall) {
        try {
            // Out of the way first: it is a floating panel and the marketplace it
            // is sending you to opens underneath it. Not recorded as closing it
            // — you went shopping, you did not put the panel away.
            this.hide({ remember: false });
            openShoppingList(shortfall);
        } catch (error) {
            console.error('[ConsumablesPanel] Building the shopping list failed:', error);
        }
    }

    /**
     * Send the shortfall to the marketplace, quantity already filled in — and,
     * when the setting says so, straight into the form the recommendation
     * points at, the way the Bulk Sell Assistant opens sell forms in reverse.
     *
     * Opening the form rather than buying: this is a decision about spending
     * coins, and a panel that spends them for you is a panel you have to
     * watch. Nothing is bought until the game's own confirm button is pressed;
     * the recommendation only decides which form is standing open when you
     * decide.
     *
     * @param {Object} entry - The forecast being topped up
     * @param {number} count - How many are missing
     * @param {Object|null} [strategy] - From `buyStrategy`, for which form to open
     */
    _buy(entry, count, strategy = null) {
        if (!count) return;
        try {
            this.hide({ remember: false });
            this.autofill.setQuantity(count);
            navigateToMarketplace(entry.itemHrid);
            this._openRecommendedForm(strategy);
        } catch (error) {
            console.error('[ConsumablesPanel] Opening the marketplace failed:', error);
        }
    }

    /**
     * Click the button the recommendation points at, once the item page is up.
     *
     * Late-bound through the market bundle's shortcuts (this panel lives in the
     * UI bundle), and best-effort throughout: if the setting is off, the
     * shortcuts are not loaded, or the button never appears, the result is
     * exactly the old behaviour — the item open in the marketplace with the
     * quantity parked, waiting for a hand.
     *
     * @param {Object|null} strategy - From `buyStrategy`
     */
    _openRecommendedForm(strategy) {
        if (!strategy || !config.getSetting('market_consumableBuyOpenRecommended')) return;
        const shortcuts = window.Toolasha?.Market?.marketplaceShortcuts;
        if (!shortcuts) return;

        // The navigation itself takes a beat; the shortcuts' own click helpers
        // then poll for the button, so this only has to not fire too early
        setTimeout(() => {
            const open =
                strategy.mode === 'instant'
                    ? shortcuts.clickInstantActionButton?.('Buy')
                    : shortcuts.clickListingButton?.('+ New Buy Listing', 'Button_buy');
            open?.catch?.(() => {
                // No matching button (an empty book's Buy Now has nothing to
                // take) — the marketplace is open and the quantity is parked,
                // which is the old behaviour and still useful
            });
        }, 400);
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '110px',
            left: '70px',
            zIndex: String(config.Z_FLOATING_PANEL),
            // Clamped so the first open on a phone is not wider than the screen
            width: `min(${DEFAULT_PANEL.width}px, 92vw)`,
            height: `min(${DEFAULT_PANEL.height}px, 80vh)`,
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        const header = this._header();
        this.panel.appendChild(header);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px 10px 10px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 380,
            minHeight: 200,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 380, height: 200 });

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header,
            body: this.bodyEl,
            panelKey: GEOMETRY_KEY,
            beforeEl: header.lastElementChild,
            accent: COLORS.text,
        });

        this._render();
        // Stock and rates both move as you play, and prices move under them
        this.refreshId = setInterval(() => {
            if (document.hidden) return;
            this._render();
        }, REFRESH_MS);
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = 'Consumables';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        // The duration everything is measured against, on its own face rather
        // than behind a menu — every figure below it changes when it changes
        this.targetBtn = document.createElement('button');
        Object.assign(this.targetBtn.style, {
            background: 'rgba(255, 255, 255, 0.07)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.accent,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 8px',
        });
        this.targetBtn.title = 'How long the stock should last. Every shortfall below is measured against this.';
        this.targetBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            cycleTarget();
            this._render();
        });

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const close = document.createElement('button');
        close.textContent = '✕';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 4px',
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            this.hide();
        });

        header.append(title, this.targetBtn, spacer, close);
        return header;
    }

    _render() {
        if (!this.bodyEl) return;
        this.targetBtn.textContent = `Last ${this.target.label}`;

        this.bodyEl.replaceChildren();
        const players = this._players();

        if (!players.length) {
            // Nothing measured because nothing is being fought — but what the
            // next fight will drink is already decided by the default loadout,
            // and what it will eat by the last sim. Plan from those instead of
            // shrugging, when the setting allows and either source exists.
            const idle = config.getSetting('consumables_idleLoadoutPlan') ? this._idleSection() : null;
            if (idle) {
                this.bodyEl.appendChild(idle);
            } else {
                const empty = document.createElement('div');
                empty.style.color = COLORS.textDim;
                empty.textContent = 'No consumable data yet. Fight something with food or drinks equipped.';
                this.bodyEl.appendChild(empty);
            }
        }

        for (const player of players) this.bodyEl.appendChild(this._playerSection(player));

        try {
            const lab = this._labSection();
            if (lab) this.bodyEl.appendChild(lab);
        } catch (error) {
            console.error('[ConsumablesPanel] Building the labyrinth section failed:', error);
        }
    }

    /**
     * The idle plan: the default combat loadout's consumables, rated without a
     * fight. Drinks are arithmetic — buff duration against drink concentration
     * needs no observing — and food takes the last sim's measured per-hour use
     * for whatever zone was simmed (said in the heading), since food has no
     * rate outside a fight or a sim. Food with no sim on record still lists,
     * held and priced, with its rate honestly blank.
     *
     * @returns {HTMLElement|null} Null when no default loadout names anything
     */
    _idleSection() {
        const bridge = window.Toolasha?.Combat?.loadoutSnapshot;
        const snapshots = bridge?.getAllSnapshots?.() || [];
        const combat = snapshots.filter(
            (snap) => snap.actionTypeHrid === '/action_types/combat' || snap.actionTypeHrid === ''
        );
        combat.sort(
            (a, b) =>
                (b.actionTypeHrid === '/action_types/combat') - (a.actionTypeHrid === '/action_types/combat') ||
                Number(b.isDefault) - Number(a.isDefault) ||
                (a.ordinal || 0) - (b.ordinal || 0)
        );
        const loadout = combat[0];
        if (!loadout) return null;

        const sim = this._simRates || null;
        const itemMap = dataManager.getInitClientData?.()?.itemDetailMap;
        const inventory = dataManager.getInventory?.();
        const concentration = this._idleConcentration();
        const simPerDay = (hrid) => (sim?.perHour?.[hrid] > 0 ? sim.perHour[hrid] * 24 : null);

        const entries = [];
        for (const slot of loadout.drinks || []) {
            if (!slot?.itemHrid) continue;
            const duration = itemMap?.[slot.itemHrid]?.consumableDetail?.buffs?.[0]?.duration;
            const perDay = drinkRatePerDay(duration, concentration) ?? simPerDay(slot.itemHrid);
            entries.push({ itemHrid: slot.itemHrid, perDay });
        }
        for (const slot of loadout.food || []) {
            if (!slot?.itemHrid) continue;
            entries.push({ itemHrid: slot.itemHrid, perDay: simPerDay(slot.itemHrid) });
        }
        if (!entries.length) return null;

        const section = document.createElement('div');
        section.style.marginBottom = '12px';
        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderBottom: `1px solid ${COLORS.border}`,
            paddingBottom: '3px',
            marginBottom: '5px',
        });
        const name = document.createElement('span');
        name.textContent = 'Idle plan — default loadout';
        name.style.fontWeight = 'bold';
        name.style.color = COLORS.accent;
        const source = document.createElement('span');
        source.style.marginLeft = 'auto';
        source.style.color = COLORS.textDim;
        source.textContent = sim
            ? `food rated from last sim (${dataManager.getInitClientData()?.actionDetailMap?.[sim.zoneHrid]?.name || sim.zoneHrid || 'unknown zone'})`
            : 'food unrated — run a sim to rate it';
        heading.append(name, source);
        section.appendChild(heading);
        section.appendChild(this._columnHeadings());

        for (const { itemHrid, perDay } of entries) {
            const entry = forecast(
                {
                    itemHrid,
                    itemName: dataManager.getItemDetails?.(itemHrid)?.name || itemHrid.split('/').pop(),
                    inventoryAmount: heldInInventory(inventory, itemHrid),
                    consumptionRate: perDay > 0 ? perDay / 86400 : 0,
                    consumedPerDay: perDay > 0 ? Math.ceil(perDay) : 0,
                },
                getItemPrices(itemHrid)
            );
            section.appendChild(this._entryRow(entry, false));
        }
        return section;
    }

    /** Drink concentration off worn gear, for the idle plan's arithmetic rates */
    _idleConcentration() {
        try {
            return (
                getDrinkConcentration(dataManager.getEquipment?.(), dataManager.getInitClientData?.()?.itemDetailMap) ||
                0
            );
        } catch {
            return 0;
        }
    }

    /** How many runs the labyrinth section is measured against */
    get labRuns() {
        return this._labRuns || 5;
    }

    /** Cycle the run target and remember it, the way the duration target works */
    _cycleLabRuns() {
        const steps = [1, 3, 5, 10, 25];
        this._labRuns = steps[(steps.indexOf(this.labRuns) + 1) % steps.length];
        storage.set('consumablesLabRuns', this._labRuns, 'settings').catch(() => {});
        this._render();
    }

    /**
     * What one labyrinth run consumes, planned as full consumption.
     *
     * Per the game's own model: a run takes in up to its capacity of torches,
     * shrouds and beacons (base 100/4/5, raised by the capacity upgrades — the
     * capacities are settings, since the upgrade levels are not in any payload
     * this reads), plus exactly one crate per selected crate slot. Planned as
     * fully spent, which is the ceiling a restock should be sized for.
     *
     * @returns {Array<{itemHrid: string, perRun: number}>} Empty when the game
     *   data needed to name the items is not up yet
     */
    _labNeedsPerRun() {
        const itemMap = dataManager.getInitClientData?.()?.itemDetailMap;
        if (!itemMap) return [];
        const hrids = resolveSupplyHrids(itemMap);
        const inventory = dataManager.getInventory?.();
        const counts = readSupplyCounts(inventory, hrids);
        const lab = dataManager.characterData?.characterLabyrinth || dataManager.characterData?.labyrinth;

        // The server states the final capacities outright on characterInfo
        // (labyrinthTorchCap and friends, upgrades already applied) — the
        // settings only stand in when the payload has not arrived
        const info = dataManager.characterData?.characterInfo;
        const cap = (field, key, fallback) =>
            Number(info?.[field]) > 0 ? Number(info[field]) : Number(config.getSettingValue(key, fallback)) || 0;
        const capacity = {
            torch: cap('labyrinthTorchCap', 'consumables_labTorchMax', 100),
            shroud: cap('labyrinthShroudCap', 'consumables_labShroudMax', 4),
            beacon: cap('labyrinthBeaconCap', 'consumables_labBeaconMax', 5),
        };
        const needs = [];
        for (const kind of SUPPLY_KINDS) {
            if (!(capacity[kind] > 0)) continue;
            // The tier the last run actually carried names the item; what is
            // held, then the basic tier, stand in before any run has said
            const hrid = lab?.[`${kind}ItemHrid`] || bestOwnedTier(counts, kind, hrids) || hrids[kind][0];
            needs.push({ itemHrid: hrid, perRun: capacity[kind] });
        }
        // One crate per selected slot per run — the slots the run itself names
        for (const slot of ['teaCrateItemHrid', 'coffeeCrateItemHrid', 'foodCrateItemHrid']) {
            if (lab?.[slot]) needs.push({ itemHrid: lab[slot], perRun: 1 });
        }
        return needs;
    }

    /**
     * The Labyrinth block: what X runs consume, against what the bag holds.
     *
     * Same columns as the combat rows, re-read for runs: Per day becomes per
     * run, Lasts becomes how many whole runs the held pile covers, and the Buy
     * link makes the same order-or-instant judgement every other Buy link does.
     *
     * @returns {HTMLElement|null} Null when nothing names the lab's items yet
     */
    _labSection() {
        const needs = this._labNeedsPerRun();
        if (!needs.length) return null;

        const section = document.createElement('div');
        section.style.marginBottom = '12px';

        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderBottom: `1px solid ${COLORS.border}`,
            paddingBottom: '3px',
            marginBottom: '5px',
        });
        const name = document.createElement('span');
        name.textContent = 'Labyrinth';
        name.style.fontWeight = 'bold';
        name.style.color = COLORS.accent;

        const runsBtn = document.createElement('button');
        Object.assign(runsBtn.style, {
            background: 'rgba(255, 255, 255, 0.07)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.accent,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '1px 8px',
        });
        runsBtn.textContent = `${this.labRuns} run${this.labRuns === 1 ? '' : 's'}`;
        runsBtn.title =
            'How many runs to stock for, at full consumption: the whole torch/shroud/beacon capacity and one ' +
            'crate per slot, every run. Capacities are settings — set them to the "max" the Supplies row shows.';
        runsBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._cycleLabRuns();
        });
        heading.append(name, runsBtn);
        section.appendChild(heading);

        const inventory = dataManager.getInventory?.() || [];
        const runs = this.labRuns;
        for (const { itemHrid, perRun } of needs) {
            section.appendChild(this._labRow(itemHrid, perRun, runs, inventory));
        }
        return section;
    }

    /**
     * One labyrinth item: held, per-run, the buy decision for X runs, and how
     * many whole runs the held pile already covers.
     *
     * @param {string} itemHrid - The item
     * @param {number} perRun - Full consumption per run
     * @param {number} runs - The run target
     * @param {Array<Object>} inventory - dataManager.getInventory() shape
     * @returns {HTMLElement}
     */
    _labRow(itemHrid, perRun, runs, inventory) {
        const row = this._grid();
        row.style.padding = '2px 0';

        const held = heldInInventory(inventory, itemHrid);
        const needCount = Math.max(0, Math.ceil(perRun * runs) - held);
        const prices = getItemPrices(itemHrid);
        const ask = Number(prices?.ask) > 0 ? Number(prices.ask) : null;
        const bid = Number(prices?.bid) > 0 ? Number(prices.bid) : null;

        const heldCell = this._cell(formatLargeNumber(held));

        const icon = itemIcon(itemHrid, 18);
        linkToMarketplace(icon, itemHrid, navigateToMarketplace);
        const name = document.createElement('span');
        name.textContent = dataManager.getItemDetails?.(itemHrid)?.name || itemHrid.split('/').pop();
        Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
        linkToMarketplace(name, itemHrid, navigateToMarketplace);

        const perRunCell = this._cell(`${formatLargeNumber(perRun)}/run`);
        perRunCell.style.color = COLORS.textDim;

        const cost = this._cell(ask === null ? '—' : formatLargeNumber(Math.round(ask * perRun)));
        cost.style.color = COLORS.textDim;
        cost.title =
            ask === null ? 'No price known.' : `~${Math.round(ask * perRun).toLocaleString()} coins per run at ask.`;

        const buy = this._cell(needCount ? formatLargeNumber(needCount) : '✓');
        buy.style.color = needCount ? ROW_COLORS.gold : ROW_COLORS.good;
        if (needCount) {
            const readNumber = (key, fallback) => {
                const raw = Number(config.getSettingValue(key, fallback));
                return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
            };
            const strategy = buyStrategy({
                count: needCount,
                ask,
                bid,
                // A lab restock has no running-out clock — the run starts when
                // you start it — so urgency never forces an instant buy here
                secondsLeft: Infinity,
                fillSeconds: this._fillSeconds(itemHrid, needCount),
                maxSpreadPct: readNumber('market_consumableBuyMaxSpreadPct', 2),
                minSavingCoins: readNumber('market_consumableBuyMinSaving', 0),
                minOrderValue: readNumber('market_consumableBuyMinOrderValue', 0),
            });
            buy.textContent = `${formatLargeNumber(needCount)} ${strategy.mode === 'order' ? '⏳' : '⚡'}`;
            buy.style.cursor = 'pointer';
            buy.style.textDecoration = 'underline dotted';
            buy.title =
                `Buy ${needCount.toLocaleString()} for ${runs} run${runs === 1 ? '' : 's'}` +
                (ask === null ? '' : ` — about ${Math.round(ask * needCount).toLocaleString()} coins`) +
                `.\n${strategy.mode === 'order' ? 'Place an order' : 'Buy now'}: ${strategy.reason}`;
            buy.addEventListener('click', (event) => {
                event.stopPropagation();
                this._buy({ itemHrid }, needCount, strategy);
            });
        }

        const runsHeld = perRun > 0 ? Math.floor(held / perRun) : 0;
        const lasts = this._cell(`${formatLargeNumber(runsHeld)} run${runsHeld === 1 ? '' : 's'}`);
        lasts.style.color = runsHeld >= runs ? ROW_COLORS.good : ROW_COLORS.bad;

        row.append(heldCell, icon, name, perRunCell, cost, buy, lasts);
        return row;
    }

    /**
     * One player's consumables, with their own summary.
     * @param {Object} player - From `_players`
     * @returns {HTMLElement}
     */
    _playerSection(player) {
        const section = document.createElement('div');
        section.style.marginBottom = '12px';

        const soonest = firstToRunOut(player.forecasts);
        const sides = costPerDaySides(player.forecasts);
        const need = refillAll(player.forecasts, this.target.seconds);

        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderBottom: `1px solid ${COLORS.border}`,
            paddingBottom: '3px',
            marginBottom: '5px',
        });

        const name = document.createElement('span');
        name.textContent = player.isCurrent ? `${player.name} (you)` : player.name;
        name.style.fontWeight = 'bold';
        name.style.color = player.isCurrent ? COLORS.accent : COLORS.text;

        const stops = document.createElement('span');
        stops.style.marginLeft = 'auto';
        if (soonest) {
            stops.textContent = `stops in ${shortDuration(soonest.secondsLeft)} · ${soonest.name}`;
            stops.style.color = soonest.secondsLeft < this.target.seconds ? ROW_COLORS.bad : ROW_COLORS.good;
        } else {
            // Nothing being consumed at all, which is not the same as lasting
            // forever — it usually means an empty slot
            stops.textContent = 'nothing being consumed';
            stops.style.color = COLORS.textDim;
        }

        heading.append(name, stops);
        section.appendChild(heading);

        section.appendChild(this._columnHeadings());
        for (const entry of player.forecasts) {
            section.appendChild(this._entryRow(entry, entry === soonest));
        }

        // What each row is short of, which is the list the marketplace tabs are
        // built from — worked out here so the footer and the rows cannot differ
        const shortfall = player.forecasts
            .map((entry) => ({ ...refillFor(entry, this.target.seconds), itemHrid: entry.itemHrid, name: entry.name }))
            .filter((item) => item.count > 0);

        section.appendChild(this._footer(sides, need, shortfall));
        return section;
    }

    /** @returns {HTMLElement} */
    _columnHeadings() {
        const row = this._grid();
        row.style.color = COLORS.textDim;
        row.style.marginBottom = '3px';

        for (const [text, align] of [
            ['Held', 'right'],
            ['', 'left'],
            ['Item', 'left'],
            ['Per day', 'right'],
            ['Cost/day', 'right'],
            [`Buy for ${this.target.label}`, 'right'],
            ['Lasts', 'right'],
        ]) {
            const cell = document.createElement('span');
            cell.textContent = text;
            cell.style.textAlign = align;
            row.appendChild(cell);
        }
        return row;
    }

    /**
     * One consumable, laid out the way MCS's CRack lays it out: the count you
     * hold, the icon, the name, then the rates and the countdown.
     *
     * The one that runs out first is coloured throughout rather than only in its
     * time column — it is the row the whole panel exists to point at, and a
     * single red figure at the far right is easy to miss.
     *
     * @param {Object} entry - A forecast
     * @param {boolean} isLimiting - Whether this is the one that stops the run
     * @returns {HTMLElement}
     */
    _entryRow(entry, isLimiting) {
        const row = this._grid();
        row.style.padding = '2px 0';

        const held = this._cell(formatLargeNumber(entry.held));
        held.style.color = isLimiting ? ROW_COLORS.bad : COLORS.text;

        const icon = itemIcon(entry.itemHrid, 18);
        linkToMarketplace(icon, entry.itemHrid, navigateToMarketplace);

        const name = document.createElement('span');
        name.textContent = entry.name;
        Object.assign(name.style, {
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: isLimiting ? ROW_COLORS.bad : COLORS.text,
        });
        linkToMarketplace(name, entry.itemHrid, navigateToMarketplace);

        const perDay = this._cell(entry.perDay >= 1 ? `${entry.perDay.toFixed(1)}/day` : '—');
        perDay.style.color = COLORS.textDim;

        // Both sides stacked, because buying costs ask and what you hold is worth
        // bid — averaging them hides a gap that is real money at this scale
        const cost = document.createElement('span');
        Object.assign(cost.style, { textAlign: 'right', lineHeight: '1.15', fontSize: '90%' });
        const sides = entry.costPerDaySides;
        if (sides.ask === null && sides.bid === null) {
            cost.textContent = '—';
            cost.style.color = COLORS.textDim;
        } else {
            cost.appendChild(this._side('Ask', sides.ask));
            cost.appendChild(this._side('Bid', sides.bid));
        }

        const need = refillFor(entry, this.target.seconds);
        const buy = this._cell(need.count ? formatLargeNumber(need.count) : '✓');
        buy.style.color = need.count ? ROW_COLORS.gold : ROW_COLORS.good;

        if (need.count) {
            const readNumber = (key, fallback) => {
                const raw = Number(config.getSettingValue(key, fallback));
                return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
            };
            const strategy = buyStrategy({
                count: need.count,
                ask: entry.price,
                bid: entry.costPerDaySides.bid && entry.perDay ? entry.costPerDaySides.bid / entry.perDay : null,
                secondsLeft: entry.secondsLeft,
                fillSeconds: this._fillSeconds(entry.itemHrid, need.count),
                // The bulk sell assistant's rules, mirrored for buying and read
                // from their own settings so this panel and the settings page
                // can never disagree
                maxSpreadPct: readNumber('market_consumableBuyMaxSpreadPct', 2),
                minSavingCoins: readNumber('market_consumableBuyMinSaving', 0),
                minOrderValue: readNumber('market_consumableBuyMinOrderValue', 0),
            });

            // The recommendation is on the face of it, because it is the whole
            // reason to press one of these rather than open the marketplace
            buy.textContent = `${formatLargeNumber(need.count)} ${strategy.mode === 'order' ? '⏳' : '⚡'}`;
            buy.style.cursor = 'pointer';
            buy.style.textDecoration = 'underline dotted';
            const opens = config.getSetting('market_consumableBuyOpenRecommended')
                ? `\nOpens the ${strategy.mode === 'order' ? 'buy-listing' : 'Buy Now'} form with the quantity filled in.`
                : '';
            buy.title =
                `Buy ${need.count.toLocaleString()}` +
                (need.cost === null ? '' : ` for about ${Math.round(need.cost).toLocaleString()} coins`) +
                `.\n${strategy.mode === 'order' ? 'Place an order' : 'Buy now'}: ${strategy.reason}` +
                opens +
                (strategy.measured ? '' : '\nOpen it in the marketplace once to measure its queue.');
            buy.addEventListener('click', (event) => {
                event.stopPropagation();
                this._buy(entry, need.count, strategy);
            });
        }

        const lasts = this._cell(Number.isFinite(entry.secondsLeft) ? shortDuration(entry.secondsLeft) : '∞');
        if (!Number.isFinite(entry.secondsLeft)) lasts.style.color = COLORS.textDim;
        // Measured against the target rather than a fixed hour: with "3 days"
        // chosen, something lasting two of them is exactly what you opened this
        // to find, and green was the panel disagreeing with its own Buy column
        else
            lasts.style.color =
                isLimiting || entry.secondsLeft < this.target.seconds ? ROW_COLORS.bad : ROW_COLORS.good;

        row.append(held, icon, name, perDay, cost, buy, lasts);
        return row;
    }

    /**
     * One side of the book, on its own line.
     * @param {string} label - `Ask` or `Bid`
     * @param {number|null} value - Coins per day
     * @returns {HTMLElement}
     */
    _side(label, value) {
        const line = document.createElement('div');
        line.textContent = `${label}: ${value === null ? '—' : formatLargeNumber(Math.round(value))}`;
        line.style.color = COLORS.textDim;
        line.style.whiteSpace = 'nowrap';
        return line;
    }

    /**
     * @param {{ask: number, bid: number}} sides - Cost per day
     * @param {{items: number, cost: number, unpriced: number}} need - Total shortfall
     * @param {Array<Object>} shortfall - What to buy, per item
     * @returns {HTMLElement}
     */
    _footer(sides, need, shortfall) {
        const footer = document.createElement('div');
        Object.assign(footer.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderTop: `1px solid ${COLORS.border}`,
            marginTop: '5px',
            paddingTop: '4px',
            fontWeight: 'bold',
        });

        const label = document.createElement('span');
        label.textContent = 'Total Cost/Day:';
        label.style.color = COLORS.accent;

        const value = document.createElement('span');
        value.textContent = `Ask: ${formatLargeNumber(Math.round(sides.ask))} / Bid: ${formatLargeNumber(Math.round(sides.bid))}`;
        value.style.whiteSpace = 'nowrap';

        const buy = document.createElement('span');
        buy.style.marginLeft = 'auto';
        buy.style.whiteSpace = 'nowrap';

        if (need.items) {
            // The whole restock in one gesture. Buying it a row at a time means
            // a trip back to this panel between each one, and this panel is
            // behind the marketplace you would be standing in.
            buy.textContent = `Buy all ${formatLargeNumber(need.items)} · ${formatLargeNumber(Math.round(need.cost))}`;
            buy.style.color = ROW_COLORS.gold;
            buy.style.cursor = 'pointer';
            buy.style.textDecoration = 'underline dotted';
            buy.title =
                'Open the marketplace with a tab per item, each showing what is missing.' +
                (need.unpriced ? `\n${need.unpriced} item(s) could not be priced and are not in this total.` : '');
            buy.addEventListener('click', (event) => {
                event.stopPropagation();
                this._openShoppingList(shortfall);
            });
        } else {
            buy.textContent = 'Stocked ✓';
            buy.style.color = ROW_COLORS.good;
        }

        footer.append(label, value, buy);
        return footer;
    }

    /** The one grid every line shares, so the columns line up */
    _grid() {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: '64px 20px minmax(0, 1fr) 76px 84px 74px 64px',
            gap: '6px',
            alignItems: 'baseline',
        });
        return row;
    }

    /**
     * @param {string} text - Cell contents
     * @returns {HTMLElement}
     */
    _cell(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        cell.style.textAlign = 'right';
        cell.style.whiteSpace = 'nowrap';
        return cell;
    }

    _remove() {
        clearInterval(this.refreshId);
        this.refreshId = null;
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
    }
}

export const consumablesPanel = new ConsumablesPanel();

// Both at module scope, and both wait on storage internally: the target has to
// be back before the panel draws a week's shortfall as a day's, and the panel
// has to reopen if the page was left with it up.
consumablesPanel.loadSettings();
consumablesPanel.restore();

/** Console handle, since a panel that only opens from the overlay is hard to reach */
if (typeof window !== 'undefined') {
    window.Toolasha = window.Toolasha || {};
    window.Toolasha.Debug = window.Toolasha.Debug || {};
    window.Toolasha.Debug.consumables = () => {
        const data = combatStatsDataCollector.getLatestData();
        console.log('[Consumables] players:', data?.players?.length ?? 0);
        for (const player of data?.players || []) {
            const stats = calculatePlayerStats(player, data.durationSeconds || 0);
            console.log(` ${player.name}:`, forecastAll(stats?.consumableBreakdown));
        }
        return dataManager.getCurrentCharacterId?.();
    };
}
