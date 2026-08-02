/**
 * Equipment Savings
 *
 * The gear you are saving for, and when you will have it.
 *
 * Wanting a piece of equipment is a savings problem, and the game gives you no
 * help with it at all: the price is on one screen, your coins on another, and
 * what you earn per day nowhere. So the question people actually ask — "can I
 * afford the sword yet, and if not, when" — is answered by opening the market,
 * squinting, and subtracting in your head, several times a day, for weeks.
 *
 * ## What an upgrade costs is not what it is priced at
 *
 * You sell the piece it replaces. The cost is the target's ask **less** the bid
 * on what you are wearing, which for a late-game slot is most of the price —
 * reading the ask alone can double the figure. Somebody keeping the old piece
 * for a second loadout pays the full ask, so the trade-in is the **Keep old
 * gear** switch rather than an assumption baked into the number.
 *
 * ## Everything, not just each thing
 *
 * A slot at a time answers the wrong question when you want three pieces. The
 * Everything row is the whole list against your coins, because that is the plan
 * you are actually saving towards.
 *
 * The arithmetic is in `utils/equipment-savings.js` with tests. This module
 * reads the market, the character and the income, and draws.
 *
 * The model is EWatch's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import { loadWhenReady } from '../../utils/deferred-load.js';
import { getItemPrices } from '../../utils/market-data.js';
import { getItemHridFromName } from '../../utils/game-lookups.js';
import { formatWithSeparator, formatKMB } from '../../utils/formatters.js';
import { itemIcon, linkToMarketplace, row, blank, shortDuration, ROW_COLORS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createPanel, panelCard, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { upgradeCost, savingsProgress, timeToAffordSeconds, totalSavings } from '../../utils/equipment-savings.js';

const STORAGE_KEY = 'equipmentSavings';
const MENU_BUTTON_CLASS = 'toolasha-savings-button';
const MENU_BUTTON_SETTING = 'equipmentSavings_menuButton';

/**
 * The list, and how it is being read.
 *
 * At module scope and persisted, because the overlay tile reads it while the
 * panel is closed, which is most of the time.
 *
 * `targets` is keyed by item hrid rather than by slot: you can be saving for two
 * rings, and a slot-keyed list would silently drop one.
 */
const state = { targets: {}, noSell: false };

// Kept asking until the database opens: it is opened after the libraries are
// evaluated, so a read at module scope always returns the default and the list
// looks like it forgot everything
loadWhenReady(STORAGE_KEY, 'settings', (saved) => Object.assign(state, saved), 'the equipment savings list');

/** Write the list back, without making anybody wait for it */
function persist() {
    storage
        .setJSON(STORAGE_KEY, { ...state }, 'settings')
        .catch((error) => console.error('[EquipmentSavings] Saving the list failed:', error));
}

/**
 * @param {string} itemHrid - The item
 * @returns {boolean} Whether it is being saved for
 */
export function isTargeted(itemHrid) {
    return Boolean(state.targets[itemHrid]);
}

/**
 * Start saving for a piece.
 *
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Which enhancement of it
 */
export function watchTarget(itemHrid, enhancementLevel = 0) {
    if (!itemHrid) return;
    state.targets[itemHrid] = { enhancementLevel: Number(enhancementLevel) || 0 };
    persist();
}

/** @param {string} itemHrid - Stop saving for this */
export function unwatchTarget(itemHrid) {
    delete state.targets[itemHrid];
    persist();
}

/** Whether the old piece is being sold to pay for the new one */
export function isKeepingOldGear() {
    return state.noSell;
}

/** @param {boolean} keep - Keep the old piece rather than trading it in */
export function setKeepOldGear(keep) {
    state.noSell = Boolean(keep);
    persist();
}

/** Forget everything, for a test that must not inherit the last one */
export function resetEquipmentSavings() {
    state.targets = {};
    state.noSell = false;
}

/**
 * Coins in hand.
 *
 * Straight off the character's items rather than out of the net worth figure:
 * net worth is recalculated on a schedule and includes everything you own, and
 * a savings bar has to move when you spend, not when a worker next runs.
 *
 * @returns {number}
 */
export function coinsHeld() {
    const coin = dataManager.getInventory?.()?.find((item) => item.itemHrid === '/items/coin');
    return coin?.count || 0;
}

/**
 * What the character makes in a day.
 *
 * Read off the combat stats where they exist, because that is the only place in
 * the script that knows. Nothing rather than a guess when combat has not run:
 * dividing by an invented income would produce a confident arrival date.
 *
 * @returns {number|null}
 */
export function incomePerDay() {
    const combat = window.Toolasha?.Combat;
    const data = combat?.combatStatsDataCollector?.getLatestData?.();
    const player = data?.players?.find((entry) => entry.isCurrentPlayer);
    if (!player) return null;

    const seconds = (data.endTime || Date.now()) / 1000 - (data.startTime || Date.now()) / 1000;
    const stats = combat?.combatStatsCalculator?.calculatePlayerStats?.(player, seconds);
    return stats?.dailyProfit > 0 ? stats.dailyProfit : null;
}

/**
 * What the game calls an item, for a list that stores only hrids.
 * @param {string} itemHrid - The item
 * @returns {string}
 */
function nameOf(itemHrid) {
    return (
        dataManager.getItemDetails?.(itemHrid)?.name ||
        String(itemHrid || '')
            .split('/')
            .pop()
            .replace(/_/g, ' ')
    );
}

/**
 * The piece currently in the slot this target would fill.
 *
 * By equipment type rather than by name, since that is what a target replaces —
 * and the equipment map is keyed by item **location**, which is not the same
 * string as the type.
 *
 * @param {string} itemHrid - The target
 * @returns {Object|null} The worn item, or null for an empty slot
 */
function wornRivalOf(itemHrid) {
    const type = dataManager.getItemDetails?.(itemHrid)?.equipmentDetail?.type;
    if (!type) return null;

    const location = `/item_locations/${type.split('/').pop()}`;
    return dataManager.getEquipment?.()?.get?.(location) || null;
}

/**
 * Every target, costed against what you are wearing and what you have.
 *
 * @returns {Array<Object>} `{itemHrid, name, enhancementLevel, ask, cost, ...}`
 */
export function watchedTargets() {
    const coins = coinsHeld();
    const perDay = incomePerDay();

    return Object.entries(state.targets).map(([itemHrid, target]) => {
        const enhancementLevel = target.enhancementLevel || 0;
        const ask = getItemPrices(itemHrid, enhancementLevel)?.ask || 0;

        const worn = wornRivalOf(itemHrid);
        const wornBid = worn ? getItemPrices(worn.itemHrid, worn.enhancementLevel || 0)?.bid || 0 : 0;

        const cost = upgradeCost({ targetAsk: ask, equippedBid: wornBid, noSell: state.noSell });
        const progress = savingsProgress(cost, coins);

        return {
            itemHrid,
            name: nameOf(itemHrid),
            enhancementLevel,
            ask,
            worn: worn ? { ...worn, name: nameOf(worn.itemHrid), bid: wornBid } : null,
            cost,
            ...progress,
            seconds: timeToAffordSeconds(progress.needed, perDay),
        };
    });
}

/** @returns {Object} The whole list against your coins */
export function everything() {
    const targets = watchedTargets();
    const { cost, unpriced } = totalSavings(targets);
    const progress = savingsProgress(targets.length ? cost : null, coinsHeld());

    return {
        targets,
        cost,
        unpriced,
        ...progress,
        seconds: timeToAffordSeconds(progress.needed, incomePerDay()),
    };
}

/**
 * A bar reading coins saved against coins needed.
 * @param {number|null} fraction - Saved ÷ needed
 * @returns {HTMLElement}
 */
function progressBar(fraction) {
    const track = document.createElement('div');
    Object.assign(track.style, {
        flex: '1',
        height: '5px',
        background: 'rgba(255, 255, 255, 0.12)',
        borderRadius: '3px',
        overflow: 'hidden',
    });

    const fill = document.createElement('div');
    Object.assign(fill.style, {
        height: '100%',
        width: `${((fraction ?? 0) * 100).toFixed(2)}%`,
        // Full means you can go and buy it, which is worth a different colour
        // from "getting there"
        background: fraction >= 1 ? '#4ade80' : '#6495ed',
        transition: 'width 0.3s',
    });

    track.appendChild(fill);
    return track;
}

/**
 * One target: what it is, what it costs, how far along, and how long.
 *
 * @param {Object} target - From `watchedTargets`
 * @returns {HTMLElement}
 */
function targetCard(target) {
    const card = document.createElement('div');
    Object.assign(card.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '6px 0',
        borderTop: '1px solid rgba(255, 255, 255, 0.08)',
    });

    const heading = document.createElement('div');
    Object.assign(heading.style, { display: 'flex', alignItems: 'center', gap: '7px' });

    const icon = itemIcon(target.itemHrid, 22);
    linkToMarketplace(icon, target.itemHrid, navigateToMarketplace);

    const name = document.createElement('span');
    name.textContent = target.enhancementLevel ? `${target.name} +${target.enhancementLevel}` : target.name;
    Object.assign(name.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    linkToMarketplace(name, target.itemHrid, navigateToMarketplace);

    const cost = document.createElement('span');
    cost.textContent = target.cost === null ? 'no price' : formatKMB(target.cost);
    cost.style.color = target.cost === null ? ROW_COLORS.bad : ROW_COLORS.gold;
    cost.title =
        target.cost === null
            ? 'Nobody is selling this, so what it would cost is unknown rather than nothing.'
            : target.worn
              ? `${formatKMB(target.ask)} to buy, less ${formatKMB(target.worn.bid)} for your ${target.worn.name}.`
              : `${formatKMB(target.ask)} to buy. Nothing in that slot to trade in.`;

    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.dataset.removeTarget = target.itemHrid;
    Object.assign(remove.style, {
        background: 'none',
        border: 'none',
        color: 'rgba(232, 236, 245, 0.5)',
        cursor: 'pointer',
        fontSize: '12px',
        padding: '0 2px',
    });
    remove.title = 'Stop saving for this.';
    remove.addEventListener('click', () => {
        unwatchTarget(target.itemHrid);
        equipmentSavingsPanel.render();
    });

    heading.append(icon, name, cost, remove);
    card.appendChild(heading);

    const bar = document.createElement('div');
    Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '7px' });
    bar.appendChild(progressBar(target.fraction));

    const status = document.createElement('span');
    status.textContent = statusText(target);
    Object.assign(status.style, {
        color: target.affordable ? ROW_COLORS.good : 'rgba(232, 236, 245, 0.6)',
        fontSize: '11px',
        flex: '0 0 auto',
        minWidth: '96px',
        textAlign: 'right',
    });
    bar.appendChild(status);

    card.appendChild(bar);
    return card;
}

/**
 * What a bar says beside itself.
 * @param {Object} target - A costed target
 * @returns {string}
 */
function statusText(target) {
    if (target.cost === null) return 'unpriced';
    if (target.affordable) return 'Affordable';

    // The shortfall rather than the percentage: a percentage of an amount you
    // have not been told is not a figure you can act on
    const short = `${formatKMB(target.needed)} to go`;
    return target.seconds === null ? short : `${short} · ${shortDuration(target.seconds)}`;
}

/**
 * The gear you are saving for.
 */
export const equipmentSavingsPanel = createPanel({
    id: 'equipmentSavings',
    title: 'Equipment Savings',
    size: { width: 420, height: 420 },
    accent: '#6495ed',
    draw: (body) => {
        const plan = everything();

        const purse = panelCard(body, undefined, '#6495ed');
        Object.assign(purse.style, { flexDirection: 'row', alignItems: 'center', gap: '10px' });

        const coins = document.createElement('span');
        coins.textContent = `🪙 ${formatWithSeparator(Math.round(coinsHeld()))}`;
        coins.style.color = ROW_COLORS.gold;
        coins.style.fontWeight = 'bold';

        const perDay = incomePerDay();
        const income = document.createElement('span');
        income.textContent = perDay === null ? 'no income measured' : `${formatKMB(perDay)}/day`;
        income.style.color = perDay === null ? 'rgba(232, 236, 245, 0.5)' : ROW_COLORS.good;
        income.style.flex = '1';
        income.title =
            perDay === null
                ? 'Combat has not run long enough to measure an income, so no arrival time can be given.'
                : 'Daily profit from the combat session, which is what the countdowns divide by.';

        const keep = document.createElement('label');
        Object.assign(keep.style, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' });
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = state.noSell;
        box.dataset.keepOld = 'true';
        box.addEventListener('change', () => {
            setKeepOldGear(box.checked);
            equipmentSavingsPanel.render();
        });
        keep.append(box, document.createTextNode('Keep old gear'));
        keep.title = 'Pay the full asking price rather than putting the piece it replaces towards it.';

        purse.append(coins, income, keep);

        if (!plan.targets.length) {
            body.appendChild(panelNote('Nothing being saved for.'));
            body.appendChild(
                panelNote('Click an item in your inventory or the marketplace and press Save for to add one.')
            );
            return;
        }

        const list = panelCard(body, 'Saving for', '#6495ed');
        for (const target of plan.targets) list.appendChild(targetCard(target));

        // One at a time answers the wrong question when you want three pieces
        const all = panelCard(body, 'Everything', '#6495ed');
        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '7px' });
        line.appendChild(progressBar(plan.fraction));

        const status = document.createElement('span');
        status.textContent = statusText(plan);
        Object.assign(status.style, {
            color: plan.affordable ? ROW_COLORS.good : 'rgba(232, 236, 245, 0.6)',
            fontSize: '11px',
            flex: '0 0 auto',
            minWidth: '96px',
            textAlign: 'right',
        });
        line.appendChild(status);
        all.appendChild(line);
        all.appendChild(
            panelNote(
                `${formatKMB(plan.cost)} for ${plan.targets.length} pieces` +
                    (plan.unpriced ? ` (+${plan.unpriced} unpriced)` : '')
            )
        );
    },
});

/**
 * Put a Save for button on one item menu.
 * @param {HTMLElement} actionMenu - The game's `Item_actionMenu` popup
 */
function injectSaveButton(actionMenu) {
    if (actionMenu.querySelector(`.${MENU_BUTTON_CLASS}`)) return;

    const itemName = actionMenu.querySelector('[class*="Item_name"]')?.textContent?.trim();
    const hrid = itemName && getItemHridFromName(itemName);
    // Only equipment: saving up for a cheese is not a plan
    if (!hrid || !dataManager.getItemDetails?.(hrid)?.equipmentDetail) return;

    const level =
        Number(actionMenu.querySelector('[class*="Item_enhancementLevel"]')?.textContent?.replace('+', '')) || 0;

    const button = document.createElement('button');
    // The game's own button classes, taken from a button already in this menu,
    // so it does not look like something bolted on
    const sibling = actionMenu.querySelector('button');
    if (sibling) button.className = sibling.className;
    button.classList.add(MENU_BUTTON_CLASS);

    const label = () => {
        button.textContent = isTargeted(hrid) ? 'Stop saving' : 'Save for';
    };
    label();

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (isTargeted(hrid)) unwatchTarget(hrid);
        else watchTarget(hrid, level);

        label();
        // The panel may be open behind the menu, and a list that does not change
        // when you press the button looks like a button that does nothing
        if (equipmentSavingsPanel.panel) equipmentSavingsPanel.render();
    });

    actionMenu.appendChild(button);
}

let detachMenuObserver = null;

/** Start watching for item menus, if the setting says to */
function applyMenuButtonSetting() {
    const wanted = config.getSetting(MENU_BUTTON_SETTING);

    if (wanted && !detachMenuObserver) {
        detachMenuObserver = domObserver.onClass('EquipmentSavingsSaveButton', 'Item_actionMenu', injectSaveButton);
    } else if (!wanted && detachMenuObserver) {
        detachMenuObserver();
        detachMenuObserver = null;
        document.querySelectorAll(`.${MENU_BUTTON_CLASS}`).forEach((button) => button.remove());
    }
}

export default {
    name: 'Equipment Savings',
    initialize: () => {
        applyMenuButtonSetting();
        config.onSettingChange(MENU_BUTTON_SETTING, applyMenuButtonSetting);
    },
    cleanup: () => {
        detachMenuObserver?.();
        detachMenuObserver = null;
        document.querySelectorAll(`.${MENU_BUTTON_CLASS}`).forEach((button) => button.remove());
    },
};

registerRow({
    key: 'equipmentSavings',
    name: 'Equipment Savings',
    defaultSize: { width: 230, height: 30 },
    render: (container) => {
        const plan = everything();
        if (!plan.targets.length) return blank(container);

        // The nearest one, because that is the next thing that happens — a total
        // that is months away says nothing about today
        const next = plan.targets
            .filter((target) => target.cost !== null && !target.affordable)
            .sort((a, b) => a.needed - b.needed)[0];
        const shown = next || plan;

        row(container, [
            shown.itemHrid ? { icon: shown.itemHrid, size: 18 } : { text: '🎯', color: ROW_COLORS.dim },
            {
                text: next ? next.name : 'All affordable',
                color: next ? ROW_COLORS.dim : ROW_COLORS.good,
                ellipsis: true,
            },
            next
                ? { text: formatKMB(next.needed), color: ROW_COLORS.gold, push: true }
                : { text: formatKMB(plan.cost), color: ROW_COLORS.good, push: true },
            next && next.seconds !== null ? { text: shortDuration(next.seconds), color: ROW_COLORS.accent } : null,
        ]);

        container.title =
            (next
                ? `${next.name} is the nearest: ${formatWithSeparator(Math.round(next.needed))} to go of ` +
                  `${formatWithSeparator(Math.round(next.cost))}.`
                : 'Everything on the list is affordable now.') +
            `\n${plan.targets.length} pieces, ${formatKMB(plan.cost)} altogether.` +
            (plan.unpriced ? `\n${plan.unpriced} of them have no market price.` : '') +
            '\nDouble-click for the whole list.';
    },
    onOpen: () => equipmentSavingsPanel.toggle(),
});
