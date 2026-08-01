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
