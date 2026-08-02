/**
 * Charm value
 *
 * Which charm buys the most experience per coin.
 *
 * A charm grants a percentage bonus to one skill's experience. The bonus scales
 * with the charm's tier and its enhancement level, and the price scales with
 * neither in any orderly way — so the best charm to buy is not the highest tier,
 * and it is not the cheapest. It is whichever gives the most bonus per coin, and
 * that is a division nobody does in their head across six tiers and twenty
 * enhancement levels.
 *
 * ## Bonus per coin, not bonus
 *
 * Ranking by bonus alone recommends the grandmaster charm every time, which is
 * true and useless. Ranking by price recommends the trainee charm, which is
 * worse. The ratio is the only ordering that answers "what should I buy".
 *
 * An unpriced charm is **unknown, not free** — the same rule the ability book
 * panel needs, for the same reason: dividing by a missing price would put
 * whatever nobody is selling at the top of the list.
 *
 * The tier table and the enhancement curve are QCharm's, from MWI Combat Suite
 * by Frotty (MIT) — see `third-party/mwi-combat-suite/` and
 * `docs/THIRD-PARTY-LICENSES.md`. The code is Toolasha's own.
 */

/** The experience bonus a charm of each tier grants before enhancement */
export const CHARM_TIER_EXPERIENCE = {
    trainee: 1,
    basic: 2,
    advanced: 3.5,
    expert: 5,
    master: 6.5,
    grandmaster: 8,
};

/**
 * The tier named in a charm's hrid.
 *
 * Read from the name rather than from a list of every charm, so a charm added by
 * an update is priced correctly instead of being missed.
 *
 * @param {string} itemHrid - e.g. `/items/expert_task_charm`
 * @returns {string|null} The tier, or null when it is not a charm we know
 */
export function charmTier(itemHrid) {
    const name = String(itemHrid || '');
    for (const tier of Object.keys(CHARM_TIER_EXPERIENCE)) {
        if (name.includes(`/${tier}_`)) return tier;
    }
    return null;
}

/**
 * What one charm is worth, and what that costs.
 *
 * @param {Object} input - What it needs
 * @param {string} input.itemHrid - The charm
 * @param {number} [input.enhancementLevel] - How enhanced it is
 * @param {number} [input.price] - What it costs to buy
 * @param {Function} [input.multiplierOf] - `(level) => number` enhancement scaling
 * @param {number} [input.experience] - The bonus, when the game states it directly
 * @returns {Object|null} `{itemHrid, tier, experience, price, experiencePerCoin}`
 */
export function charmValue({ itemHrid, enhancementLevel = 0, price = 0, multiplierOf, experience }) {
    const tier = charmTier(itemHrid);
    // Prefer what the game says over what the tier table predicts: the table is
    // a reconstruction, and the game's own number is the fact
    const base = experience > 0 ? experience : CHARM_TIER_EXPERIENCE[tier];
    if (!(base > 0)) return null;

    const scaled = experience > 0 ? base : base * (multiplierOf ? multiplierOf(enhancementLevel) : 1);
    const cost = Number(price) || 0;

    return {
        itemHrid,
        tier,
        enhancementLevel,
        experience: scaled,
        price: cost,
        // Null rather than Infinity when unpriced: an unknown ratio must not sort
        // above every known one
        experiencePerCoin: cost > 0 ? scaled / cost : null,
    };
}

/**
 * Charms in the order worth buying them.
 *
 * @param {Array<Object>} charms - From `charmValue`
 * @returns {Array<Object>} Best value first, unpriced last
 */
export function rankCharms(charms) {
    return [...(charms || [])].filter(Boolean).sort((a, b) => {
        if (a.experiencePerCoin === null) return b.experiencePerCoin === null ? 0 : 1;
        if (b.experiencePerCoin === null) return -1;
        return b.experiencePerCoin - a.experiencePerCoin;
    });
}

/**
 * What a charm is worth against what you already have equipped.
 *
 * The number that matters is not a charm's bonus but the bonus it would *add* —
 * swapping a 5% charm for a 6.5% one buys 1.5%, not 6.5%, and paying for it as
 * though it bought 6.5% is how people overpay for upgrades.
 *
 * @param {Object} candidate - From `charmValue`
 * @param {Object|null} equipped - From `charmValue`, or null for an empty slot
 * @returns {{gain: number, gainPerCoin: number|null}}
 */
export function upgradeValue(candidate, equipped) {
    const gain = (candidate?.experience || 0) - (equipped?.experience || 0);
    const price = candidate?.price || 0;

    return { gain, gainPerCoin: gain > 0 && price > 0 ? gain / price : null };
}
