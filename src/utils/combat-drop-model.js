/**
 * Combat Drop Model
 *
 * Turning the game's zone data into the shape `drop-luck.js` analyses.
 *
 * Kept apart from the feature that displays the result because this is where
 * being wrong is invisible. A drop rate read straight out of the data is not the
 * rate you experience: difficulty tier raises it, your combat drop stats raise it
 * again, party size divides the quantity, and a rare drop scales by a different
 * stat than a common one. Get any of those wrong and the luck percentile is still
 * a plausible-looking number — it just quietly says everyone with drop-rate gear
 * is permanently lucky. So the arithmetic lives here, on its own, with tests.
 *
 * ## The assumption worth knowing about
 *
 * Quantity bonuses give fractional counts — a 1-to-1 drop at +10% quantity is a
 * count of 1.1 — and only whole items can drop. This assumes the game settles
 * that **without losing the fraction**: 1 item nine times in ten and 2 the tenth,
 * so the average is the 1.1 it says. `drop-luck.js` discretises the same way, and
 * its "a fractional fixed count splits between its neighbours" test pins it.
 *
 * If the game instead truncates, every such bonus below the next whole item is
 * worth nothing and this model overstates income. That is not a rounding detail:
 * on a zone where a rare carries the value, the two readings differed by 5% of
 * total income in testing, because the rare is exactly the drop whose count is
 * small enough for the fraction to be most of the bonus.
 *
 * The multipliers and the discretisation are both Frotty's, read out of MWI
 * Combat Suite — see `third-party/mwi-combat-suite/` and
 * `docs/THIRD-PARTY-LICENSES.md`.
 */

import { expectedSpawnsPerWave } from './spawn-expectation.js';

/** What the game gives every character before gear and buffs */
const NO_DROP_BONUSES = { combatDropRate: 0, combatRareFind: 0, combatDropQuantity: 0 };

/** Zones without their own figure send a boss every this many battles */
export const DEFAULT_BATTLES_PER_BOSS = 10;

/** A dungeon hands its whole party this much more of each drop */
const DUNGEON_QUANTITY_MULTIPLIER = 5;

/**
 * The rate a drop actually lands at, for one player in one zone.
 *
 * Difficulty raises a drop's rate twice over: once by a flat per-tier step the
 * drop itself carries, and again by a tenth of the base for every tier. Drop-rate
 * gear then multiplies what is left — but rare drops answer to `combatRareFind`
 * and common ones to `combatDropRate`, so a rare-find build looks unlucky on
 * common drops and lucky on rares if the two are mixed up.
 *
 * @param {Object} drop - `{ dropRate, dropRatePerDifficultyTier, isRare }`
 * @param {number} tier - Difficulty tier
 * @param {Object} bonuses - `{ combatDropRate, combatRareFind }`
 * @returns {number} Rate in [0, 1]
 */
export function effectiveDropRate(drop, tier, bonuses = NO_DROP_BONUSES) {
    const base = drop.dropRate || 0;
    const perTier = drop.dropRatePerDifficultyTier || 0;
    const finder = drop.isRare ? bonuses.combatRareFind || 0 : bonuses.combatDropRate || 0;

    const rate = (base + tier * perTier) * (1 + tier * 0.1) * (1 + finder);
    return Math.min(Math.max(rate, 0), 1);
}

/**
 * How much a drop's count is scaled before it reaches you.
 *
 * Quantity bonuses raise the whole stack, party size splits it, and a dungeon
 * multiplies it — the last two nearly cancelling in a full party, which is why
 * neither can be left out on its own.
 *
 * @param {Object} bonuses - `{ combatDropQuantity }`
 * @param {number} partySize - How many are splitting the loot
 * @param {boolean} isDungeon - Whether the zone is a dungeon
 * @returns {number} Multiplier for min and max count
 */
export function dropQuantityMultiplier(bonuses = NO_DROP_BONUSES, partySize = 1, isDungeon = false) {
    const party = partySize > 0 ? partySize : 1;
    const dungeon = isDungeon ? DUNGEON_QUANTITY_MULTIPLIER : 1;
    return ((1 + (bonuses.combatDropQuantity || 0)) / party) * dungeon;
}

/**
 * Every drop a monster can give, as one list.
 *
 * The two tables are kept apart in the game's data because they scale by
 * different stats, so the rare flag has to survive the merge.
 *
 * @param {Object} monster - An entry of `combatMonsterDetailMap`
 * @returns {Array<Object>} Drops, each flagged `isRare`
 */
export function monsterDropList(monster) {
    const common = (monster?.dropTable || []).map((drop) => ({ ...drop, isRare: false }));
    const rare = (monster?.rareDropTable || []).map((drop) => ({ ...drop, isRare: true }));
    return [...common, ...rare];
}

/**
 * Split a run of battles into ordinary ones and boss ones.
 * @param {number} battles - Battles fought
 * @param {number} battlesPerBoss - How often a boss comes round; 0 for never
 * @returns {{normalCount: number, bossCount: number}}
 */
export function splitBattles(battles, battlesPerBoss) {
    const total = Math.max(battles || 0, 0);
    if (!battlesPerBoss || battlesPerBoss <= 0) return { normalCount: total, bossCount: 0 };

    const bossCount = Math.floor(total / battlesPerBoss);
    return { normalCount: total - bossCount, bossCount };
}

/**
 * Build the session `drop-luck.js` analyses from a zone and a run of battles.
 *
 * Priced here rather than downstream because the analysis works in coins, not
 * items — an item with no price contributes nothing and is dropped, which is the
 * honest thing to do: counting it as zero would make every session containing one
 * look unlucky.
 *
 * @param {Object} input - Everything the model needs
 * @param {Object} input.actionDetail - The zone's `actionDetailMap` entry
 * @param {Object} input.monsterDetailMap - The game's `combatMonsterDetailMap`
 * @param {number} input.battles - Battles fought, excluding any still in progress
 * @param {Function} input.priceOf - `(itemHrid) => number|null`
 * @param {number} [input.difficultyTier] - Zone difficulty
 * @param {Object} [input.bonuses] - `{ combatDropRate, combatRareFind, combatDropQuantity }`
 * @param {number} [input.partySize] - How many are splitting the loot
 * @returns {Object|null} A session for `sessionLuck`, or null when the zone cannot
 *   be modelled — a dungeon, a zone with no spawn table, or no battles fought
 */
export function buildCombatSession({
    actionDetail,
    monsterDetailMap,
    battles,
    priceOf,
    difficultyTier = 0,
    bonuses = NO_DROP_BONUSES,
    partySize = 1,
}) {
    const zone = actionDetail?.combatZoneInfo;
    const fight = zone?.fightInfo;
    const spawnInfo = fight?.randomSpawnInfo;

    // Dungeons pay out of a reward table on completion rather than per monster,
    // which is a different distribution entirely. Better to show nothing than a
    // number built from the wrong model.
    if (!zone || zone.isDungeon) return null;
    if (!spawnInfo?.spawns?.length || !monsterDetailMap) return null;
    if (!(battles > 0)) return null;

    const quantity = dropQuantityMultiplier(bonuses, partySize, false);

    const priceDrop = (drop) => {
        const price = priceOf(drop.itemHrid);
        if (!(price > 0)) return null;

        const rate = effectiveDropRate(drop, difficultyTier, bonuses);
        if (rate <= 0) return null;

        return {
            // Carried through so a per-item expectation can be built from the
            // same priced drops the coin total is; two models of the same
            // session would disagree the moment either changed
            itemHrid: drop.itemHrid,
            minCount: (drop.minCount || 0) * quantity,
            maxCount: (drop.maxCount || 0) * quantity,
            dropRate: rate,
            price,
        };
    };
    const dropsFor = (hrid) => monsterDropList(monsterDetailMap[hrid]).map(priceDrop).filter(Boolean);

    const monsterDrops = {};
    for (const spawn of spawnInfo.spawns) {
        const hrid = spawn.combatMonsterHrid;
        if (hrid) monsterDrops[hrid] = dropsFor(hrid);
    }

    const bossDrops = {};
    for (const boss of fight.bossSpawns || []) {
        const hrid = boss.combatMonsterHrid;
        if (hrid) bossDrops[hrid] = dropsFor(hrid);
    }

    const battlesPerBoss = Object.keys(bossDrops).length ? fight.battlesPerBoss || DEFAULT_BATTLES_PER_BOSS : 0;
    const { normalCount, bossCount } = splitBattles(battles, battlesPerBoss);

    return { spawnInfo, monsterDrops, bossDrops, normalCount, bossCount };
}

/**
 * What a run of loot was worth, by the same prices the model used.
 *
 * Has to share the pricing with `buildCombatSession` or the comparison is
 * meaningless — an income counted at ask against a distribution built at bid
 * would read as luck.
 *
 * @param {Object<string, {itemHrid: string, count: number}>} lootMap - The game's `totalLootMap`
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @returns {number} Total value in coins
 */
export function lootValue(lootMap, priceOf) {
    let total = 0;
    for (const loot of Object.values(lootMap || {})) {
        const price = priceOf(loot.itemHrid);
        if (price > 0) total += price * (loot.count || 0);
    }
    return total;
}

/**
 * What one drop pays on average, counting the times it does not land.
 * @param {Object} drop - A priced drop from `buildCombatSession`
 * @returns {number} Coins per attempt
 */
function dropMean(drop) {
    // The mean of the integerised count is the continuous mean it was built
    // from — the discretisation in `drop-luck.js` splits mass between neighbours
    // in proportion to distance, which is exactly what preserves it
    const meanCount = ((drop.minCount || 0) + (drop.maxCount || 0)) / 2;
    return drop.dropRate * meanCount * drop.price;
}

/**
 * What a session was owed on average.
 *
 * The percentile from `sessionLuck` says where a session sits among all the
 * sessions it could have been, which is the honest answer but not an intuitive
 * one — on a zone where a rare carries the value, a perfectly ordinary session
 * sits at the 30th percentile and reads as bad luck. This is the other half of
 * that: how far above or below par the takings actually were, in coins.
 *
 * Computed in closed form rather than from the distribution. The mean of a sum
 * is the sum of the means whatever the shape, so no inversion is needed and this
 * costs microseconds where the percentile costs a tenth of a second.
 *
 * @param {Object} session - As `buildCombatSession` returns
 * @returns {number} Expected income in coins
 */
export function sessionMean({ spawnInfo, monsterDrops, bossDrops = {}, normalCount, bossCount = 0 }) {
    let total = 0;

    const perWave = expectedSpawnsPerWave(spawnInfo);
    for (const [hrid, spawns] of Object.entries(perWave)) {
        const drops = monsterDrops?.[hrid];
        if (!drops?.length) continue;

        const perKill = drops.reduce((sum, drop) => sum + dropMean(drop), 0);
        total += perKill * spawns * (normalCount || 0);
    }

    // Every boss in the table turns up on a boss wave, so they are counted
    // outright rather than weighted by a spawn rate
    for (const drops of Object.values(bossDrops)) {
        const perKill = drops.reduce((sum, drop) => sum + dropMean(drop), 0);
        total += perKill * (bossCount || 0);
    }

    return total;
}

/**
 * What a session was owed, item by item.
 *
 * `sessionMean` answers the same question in coins, which is the right shape for
 * "was this run lucky" and the wrong one for "which drop is behind it". Both
 * walk the same priced drops in the same order, so they cannot disagree about
 * the session — one sums `rate × count × price`, this one sums `rate × count`
 * and keeps it under the item.
 *
 * @param {Object} session - From `buildCombatSession`
 * @returns {Object<string, number>} Item hrid → expected count
 */
export function expectedItemCounts({ spawnInfo, monsterDrops, bossDrops = {}, normalCount, bossCount = 0 }) {
    const counts = {};

    const add = (drops, kills) => {
        for (const drop of drops || []) {
            if (!drop?.itemHrid) continue;
            const meanCount = ((drop.minCount || 0) + (drop.maxCount || 0)) / 2;
            counts[drop.itemHrid] = (counts[drop.itemHrid] || 0) + drop.dropRate * meanCount * kills;
        }
    };

    const perWave = expectedSpawnsPerWave(spawnInfo);
    for (const [hrid, spawns] of Object.entries(perWave)) {
        add(monsterDrops?.[hrid], spawns * (normalCount || 0));
    }

    // Every boss in the table turns up on a boss wave, so they are counted
    // outright rather than weighted by a spawn rate
    for (const drops of Object.values(bossDrops)) add(drops, bossCount || 0);

    return counts;
}

/**
 * How far above or below par a figure landed, as a percentage.
 *
 * Signed against zero rather than expressed as a fraction of expectation:
 * "+36%" is read at a glance and "136%" is read twice. Nothing to compare
 * against is nothing, not a triumph — a zero expectation with drops in hand is
 * a model that does not cover this zone, not infinite luck.
 *
 * @param {number} actual - What happened
 * @param {number} expected - What was owed
 * @returns {number|null} Signed percentage, or null when there is nothing to say
 */
export function percentOfExpected(actual, expected) {
    if (!(expected > 0)) return null;
    return ((actual || 0) / expected - 1) * 100;
}
