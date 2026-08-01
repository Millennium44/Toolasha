/**
 * House affordability
 *
 * How many house upgrades your coins currently cover, and what the cheapest one
 * is.
 *
 * The costing is `utils/house-cost-calculator.js` — this only asks it a
 * different question. That calculator returns the **cumulative** cost of taking
 * a room from nothing to a level, so the price of the next upgrade alone is the
 * difference between two of its answers rather than anything new.
 *
 * The figure is worth having because the alternative is opening each room in
 * turn to see what it wants, and the answer changes with the market rather than
 * only when you spend.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { calculateHouseBuildCost } from '../../utils/house-cost-calculator.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { rows, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';

/** The game's cap; a room at this level has nothing left to buy */
const MAX_ROOM_LEVEL = 8;
const PANEL_ID = 'toolasha-houses-panel';
/** Where this panel's size and position are remembered */
const GEOMETRY_KEY = 'housesPanel';
/** What it opens at before anyone has resized it */
const DEFAULT_PANEL = { width: 560, height: 420 };

const COLORS = {
    background: 'rgba(8, 10, 20, 0.96)',
    headerBg: 'rgba(14, 30, 20, 0.85)',
    border: 'rgba(120, 200, 150, 0.3)',
    text: '#e6efe9',
    textDim: 'rgba(230, 239, 233, 0.55)',
    accent: '#7fd6a3',
    affordable: 'rgba(60, 140, 90, 0.35)',
    tooDear: 'rgba(120, 60, 60, 0.3)',
    maxed: 'rgba(60, 60, 70, 0.35)',
};

/**
 * What the next level of one room costs, on its own.
 * @param {string} houseRoomHrid - Room
 * @param {number} currentLevel - Level it is at now
 * @returns {number} Cost of the next level, or 0 when there is none
 */
export function nextLevelCost(houseRoomHrid, currentLevel) {
    if (currentLevel >= MAX_ROOM_LEVEL) return 0;

    const toNext = calculateHouseBuildCost(houseRoomHrid, currentLevel + 1);
    const toHere = calculateHouseBuildCost(houseRoomHrid, currentLevel);
    const cost = toNext - toHere;
    return cost > 0 ? cost : 0;
}

/**
 * Which upgrades your coins cover right now.
 *
 * Counted per room rather than as a shopping basket: buying the cheapest
 * upgrade changes what you can afford next, so "you could buy all six" would be
 * false. Each entry answers "could I buy this one now", which stays true.
 *
 * @param {Object} houseRooms - `characterHouseRoomMap`
 * @param {number} coins - Coins in hand
 * @returns {{affordable: number, total: number, cheapest: {name: string, cost: number}|null}}
 */
export function affordableUpgrades(houseRooms, coins) {
    const gameData = dataManager.getInitClientData();
    const roomDetails = gameData?.houseRoomDetailMap || {};

    let affordable = 0;
    let total = 0;
    let cheapest = null;

    // Walk the game's full room list, not the character's. `characterHouseRoomMap`
    // holds only rooms you have already bought, so a character with one maxed
    // room and fifteen unbuilt ones looks like a character with nothing left to
    // buy — when the unbuilt ones are the whole point of the figure.
    for (const houseRoomHrid of Object.keys(roomDetails)) {
        const level = (houseRooms || {})[houseRoomHrid]?.level || 0;
        const cost = nextLevelCost(houseRoomHrid, level);
        // A maxed room, or one whose materials cannot be priced, is not an
        // upgrade you are choosing not to buy
        if (cost <= 0) continue;

        total++;
        if (cost <= coins) affordable++;
        if (!cheapest || cost < cheapest.cost) {
            const name = roomDetails[houseRoomHrid]?.name || houseRoomHrid.replace('/house_rooms/', '');
            cheapest = { name, cost };
        }
    }

    return { affordable, total, cheapest };
}

/**
 * Every room, with what its next level costs and whether you can afford it.
 *
 * Sorted cheapest first, because the panel exists to answer "what can I buy
 * next" and the cheapest upgrade is almost always the answer.
 *
 * @param {Object} houseRooms - `characterHouseRoomMap`
 * @param {number} coins - Coins in hand
 * @returns {Array<Object>} `{ hrid, name, level, cost, affordable, maxed, materials }`
 */
export function roomUpgrades(houseRooms, coins) {
    const gameData = dataManager.getInitClientData();
    const roomDetails = gameData?.houseRoomDetailMap || {};

    const rooms = Object.keys(roomDetails).map((hrid) => {
        const level = (houseRooms || {})[hrid]?.level || 0;
        const cost = nextLevelCost(hrid, level);
        const maxed = level >= MAX_ROOM_LEVEL;

        return {
            hrid,
            name: roomDetails[hrid]?.name || hrid.replace('/house_rooms/', ''),
            level,
            cost,
            maxed,
            affordable: !maxed && cost > 0 && cost <= coins,
            materials: roomDetails[hrid]?.upgradeCostsMap?.[level + 1] || [],
        };
    });

    rooms.sort((a, b) => {
        // Maxed rooms last; there is nothing to decide about them
        if (a.maxed !== b.maxed) return a.maxed ? 1 : -1;
        return a.cost - b.cost;
    });
    return rooms;
}

/**
 * Coins in hand.
 * @returns {number} Coin count, or 0 when the inventory is not loaded
 */
function coinBalance() {
    const items = dataManager.getCombinedData()?.characterItems || [];
    const coin = items.find((item) => item.itemHrid === '/items/coin');
    return coin?.count || 0;
}

/**
 * Report why the Houses row is or is not showing anything.
 *
 * The row draws nothing when it cannot price a single upgrade, and "nothing" is
 * indistinguishable from the feature being off. This says which step came back
 * empty: the room list, the level, the game's cost table, or the market prices
 * those costs are valued at.
 *
 * Console: `Toolasha.Debug.houses()`
 * @returns {Object} What was found
 */
export function describeHouses() {
    const combined = dataManager.getCombinedData();
    const initData = dataManager.getInitClientData();
    const rooms = combined?.characterHouseRoomMap || {};
    const roomDetails = initData?.houseRoomDetailMap || {};

    const rows = Object.keys(roomDetails).map((hrid) => {
        const level = rooms[hrid]?.level || 0;
        const detail = roomDetails[hrid];
        const costsMap = detail?.upgradeCostsMap;
        const nextCosts = costsMap?.[level + 1];
        return {
            room: hrid.replace('/house_rooms/', ''),
            level,
            hasDetail: !!detail,
            hasCostsMap: !!costsMap,
            costsMapKeys: costsMap ? Object.keys(costsMap).join(',') : '(none)',
            nextLevelHasCosts: Array.isArray(nextCosts) ? nextCosts.length : '(missing)',
            cumulativeToHere: calculateHouseBuildCost(hrid, level),
            cumulativeToNext: calculateHouseBuildCost(hrid, level + 1),
            upgradeCost: nextLevelCost(hrid, level),
        };
    });

    const coins = coinBalance();
    const summary = affordableUpgrades(rooms, coins);

    console.log(
        `[Toolasha] ${Object.keys(roomDetails).length} room(s) in the game, ${Object.keys(rooms).length} owned; ` +
            `coins = ${coins}. ` +
            `houseRoomDetailMap present = ${!!initData?.houseRoomDetailMap}. ` +
            `Row shows: ${summary.total ? `${summary.affordable} of ${summary.total}` : 'nothing (no upgrade could be priced)'}.\n` +
            'upgradeCost of 0 on every row means the cost table was read wrong or its materials have no market price.'
    );
    if (rows.length) console.table(rows);

    return { coins, rooms: rows, summary };
}

/**
 * The Houses panel: a grid of rooms and what each one's next level costs.
 *
 * The overlay row is a headline — how many you can afford, and the cheapest. The
 * question it provokes is "which ones, and what do they need", and that needs a
 * list. So the row opens this on a double-click and stays one line itself.
 *
 * Rooms are ordered cheapest first, with maxed ones last, because the panel is
 * read to decide what to buy next rather than to audit what you own.
 */
class HousesPanel {
    constructor() {
        this.panel = null;
        this.gridEl = null;
        this.detailEl = null;
        this.selected = null;
        this.detachDrag = null;
        this.refreshId = null;
    }

    /** Open the panel, or raise it if it is already up */
    show() {
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    hide() {
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '100px',
            left: '60px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: `${DEFAULT_PANEL.width}px`,
            height: `${DEFAULT_PANEL.height}px`,
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

        const body = document.createElement('div');
        Object.assign(body.style, { display: 'flex', gap: '10px', padding: '10px', flex: '1', minHeight: '0' });

        this.gridEl = document.createElement('div');
        Object.assign(this.gridEl.style, {
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '6px',
            flex: '0 0 auto',
            overflow: 'auto',
        });

        this.detailEl = document.createElement('div');
        Object.assign(this.detailEl.style, { flex: '1', overflow: 'auto', minWidth: '0' });

        body.appendChild(this.gridEl);
        body.appendChild(this.detailEl);
        this.panel.appendChild(body);

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

        this._render();
        // Costs move with the market, and coins move as you play
        this.refreshId = setInterval(() => this._render(), 5000);
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: '10px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
        });

        this.titleEl = document.createElement('span');
        this.titleEl.style.fontWeight = 'bold';
        this.titleEl.style.color = COLORS.accent;

        const close = document.createElement('button');
        close.textContent = '✕';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 5px',
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            this.hide();
        });

        header.appendChild(this.titleEl);
        header.appendChild(close);
        return header;
    }

    _render() {
        if (!this.gridEl) return;

        const coins = coinBalance();
        const rooms = roomUpgrades(dataManager.getCombinedData()?.characterHouseRoomMap, coins);
        const buyable = rooms.filter((room) => room.affordable).length;
        const cheapest = rooms.find((room) => !room.maxed && room.cost > 0);

        this.titleEl.textContent = cheapest
            ? `Houses — ${buyable} affordable · cheapest ${cheapest.name} ${formatLargeNumber(Math.round(cheapest.cost))}`
            : 'Houses';

        this.gridEl.replaceChildren();
        for (const room of rooms) this.gridEl.appendChild(this._tile(room));

        // Keep whatever was selected across a refresh, or fall back to the one
        // you are most likely to want
        const chosen = rooms.find((room) => room.hrid === this.selected) || cheapest || rooms[0];
        this._renderDetail(chosen, coins);
    }

    /**
     * @param {Object} room - From `roomUpgrades`
     * @returns {HTMLElement} A tile
     */
    _tile(room) {
        const tile = document.createElement('div');
        const background = room.maxed ? COLORS.maxed : room.affordable ? COLORS.affordable : COLORS.tooDear;
        Object.assign(tile.style, {
            padding: '5px 6px',
            borderRadius: '4px',
            background,
            border: `1px solid ${room.hrid === this.selected ? COLORS.accent : 'transparent'}`,
            cursor: 'pointer',
            minWidth: '92px',
            lineHeight: '1.3',
        });
        tile.title = room.maxed
            ? `${room.name} is at the maximum level`
            : `${room.name} → level ${room.level + 1}: ${formatLargeNumber(Math.round(room.cost))}`;

        const name = document.createElement('div');
        name.textContent = room.name;
        name.style.whiteSpace = 'nowrap';
        name.style.overflow = 'hidden';
        name.style.textOverflow = 'ellipsis';

        const level = document.createElement('div');
        level.textContent = room.maxed ? `Lv ${room.level} · max` : `Lv ${room.level} → ${room.level + 1}`;
        level.style.color = COLORS.textDim;
        level.style.fontSize = '11px';

        tile.appendChild(name);
        tile.appendChild(level);
        tile.addEventListener('click', () => {
            this.selected = room.hrid;
            this._render();
        });
        return tile;
    }

    /**
     * What the selected room's next level needs.
     *
     * Materials are listed with what you hold against what it wants, because the
     * cost in coins is only the answer if you intend to buy the materials — and
     * the usual question is whether you already have them.
     *
     * @param {Object} room - The selected room
     * @param {number} coins - Coins in hand
     */
    _renderDetail(room, coins) {
        this.detailEl.replaceChildren();
        if (!room) return;

        const title = document.createElement('div');
        title.textContent = room.maxed ? `${room.name} — maxed` : `${room.name} ${room.level} → ${room.level + 1}`;
        Object.assign(title.style, { fontWeight: 'bold', color: COLORS.accent, marginBottom: '4px' });
        this.detailEl.appendChild(title);

        if (room.maxed) return;

        const cost = document.createElement('div');
        cost.textContent = `Upgrade cost ${formatLargeNumber(Math.round(room.cost))}`;
        cost.style.color = room.affordable ? COLORS.accent : '#f87171';
        cost.style.marginBottom = '2px';
        this.detailEl.appendChild(cost);

        const held = document.createElement('div');
        held.textContent = `You hold ${formatLargeNumber(coins)}`;
        held.style.color = COLORS.textDim;
        held.style.marginBottom = '6px';
        this.detailEl.appendChild(held);

        if (!room.materials.length) return;

        const heading = document.createElement('div');
        heading.textContent = 'Materials';
        heading.style.color = COLORS.textDim;
        heading.style.marginBottom = '2px';
        this.detailEl.appendChild(heading);

        const inventory = dataManager.getCombinedData()?.characterItems || [];
        for (const material of room.materials) {
            const line = document.createElement('div');
            Object.assign(line.style, { display: 'flex', justifyContent: 'space-between', gap: '8px' });

            const name = document.createElement('span');
            name.textContent =
                dataManager.getItemDetails?.(material.itemHrid)?.name || material.itemHrid.split('/').pop();

            const have =
                material.itemHrid === '/items/coin'
                    ? coins
                    : inventory.find((item) => item.itemHrid === material.itemHrid && !item.enhancementLevel)?.count ||
                      0;
            const need = material.count || 0;

            const amount = document.createElement('span');
            amount.textContent = `${formatLargeNumber(have)} / ${formatLargeNumber(need)}`;
            amount.style.color = have >= need ? COLORS.accent : '#f87171';
            amount.style.whiteSpace = 'nowrap';

            line.appendChild(name);
            line.appendChild(amount);
            this.detailEl.appendChild(line);
        }
    }

    _remove() {
        clearInterval(this.refreshId);
        this.refreshId = null;
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;
        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.gridEl = null;
        this.detailEl = null;
    }
}

export const housesPanel = new HousesPanel();

registerRow({
    key: 'houses',
    name: 'Houses',
    defaultSize: { width: 200, height: 50 },
    render: (container) => {
        const rooms = dataManager.getCombinedData()?.characterHouseRoomMap;
        if (!rooms) return blank(container);

        const { affordable, total, cheapest } = affordableUpgrades(rooms, coinBalance());
        if (!total) return blank(container);

        rows(container, [
            [
                {
                    text: `${affordable} of ${total} affordable`,
                    // Nothing affordable is information, not an error — it just
                    // means the next one is still being saved for
                    color: affordable > 0 ? ROW_COLORS.good : ROW_COLORS.dim,
                },
            ],
            cheapest
                ? [
                      { text: cheapest.name, color: ROW_COLORS.gold, ellipsis: true },
                      { text: formatLargeNumber(Math.round(cheapest.cost)), color: ROW_COLORS.dim, push: true },
                  ]
                : null,
        ]);
    },
    onOpen: () => housesPanel.toggle(),
});
