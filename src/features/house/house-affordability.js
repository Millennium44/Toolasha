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

import dataManager from '../../core/data-manager.js';
import { calculateHouseBuildCost } from '../../utils/house-cost-calculator.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { formatLargeNumber } from '../../utils/formatters.js';

/** The game's cap; a room at this level has nothing left to buy */
const MAX_ROOM_LEVEL = 8;

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

    for (const [houseRoomHrid, room] of Object.entries(houseRooms || {})) {
        const level = room?.level || 0;
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
 * Coins in hand.
 * @returns {number} Coin count, or 0 when the inventory is not loaded
 */
function coinBalance() {
    const items = dataManager.getCombinedData()?.characterItems || [];
    const coin = items.find((item) => item.itemHrid === '/items/coin');
    return coin?.count || 0;
}

registerRow({
    key: 'houses',
    name: 'Houses',
    render: (container) => {
        container.replaceChildren();

        const rooms = dataManager.getCombinedData()?.characterHouseRoomMap;
        if (!rooms) return;

        const { affordable, total, cheapest } = affordableUpgrades(rooms, coinBalance());
        if (!total) return;

        Object.assign(container.style, { display: 'flex', justifyContent: 'space-between', gap: '10px' });

        const label = document.createElement('span');
        label.textContent = `${affordable} of ${total} upgrades`;
        // Nothing affordable is information, not an error — it just means the
        // next one is still being saved for
        label.style.color = affordable > 0 ? '#4ade80' : 'inherit';

        const value = document.createElement('span');
        value.style.whiteSpace = 'nowrap';
        value.textContent = cheapest ? `${cheapest.name} ${formatLargeNumber(Math.round(cheapest.cost))}` : '';

        container.appendChild(label);
        container.appendChild(value);
    },
});
