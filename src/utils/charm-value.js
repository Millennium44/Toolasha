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
 * What the game's vendor charges for a trainee charm.
 *
 * Nobody lists trainee charms on the market — there is no profit in reselling
 * something the shop stocks at a fixed price — so the market has no ask for one
 * and a market-only reading of the family shows the bottom tier as unpriced.
 * It is not unpriced; it costs this, always, and that is the floor every other
 * tier's value per coin is judged against.
 *
 * The shop sells them unenhanced. A trainee charm at +5 is somebody's
 * enhancement work and is priced by the market like anything else.
 */
export const TRAINEE_SHOP_PRICE = 250_000;

/** Charm hrids are `/items/<tier>_<focus>_charm`, and both halves matter */
const CHARM_HRID = /^\/items\/(trainee|basic|advanced|expert|master|grandmaster)_(.+)_charm$/;

/**
 * What a charm costs when the market has no ask for it.
 *
 * Only the trainee tier has one. Every other tier with no listings is genuinely
 * unpriced, and saying it costs nothing would put it top of a value ranking.
 *
 * @param {string} itemHrid - The charm
 * @param {number} [enhancementLevel] - How enhanced
 * @returns {number} The shop price, or 0 for "nobody is selling this"
 */
export function shopPrice(itemHrid, enhancementLevel = 0) {
    return charmTier(itemHrid) === 'trainee' && enhancementLevel === 0 ? TRAINEE_SHOP_PRICE : 0;
}

/**
 * What a charm focuses on — the part of its name that is not the tier.
 *
 * @param {string} itemHrid - e.g. `/items/expert_melee_charm`
 * @returns {string|null} e.g. `melee`
 */
export function charmFocus(itemHrid) {
    return CHARM_HRID.exec(String(itemHrid || ''))?.[2] ?? null;
}

/**
 * Every tier of the charm you are wearing.
 *
 * The comparison worth making is within one focus. A melee charm and a brewing
 * charm are not alternatives to each other — they train different things — so a
 * ranking across every charm in the game is a list of things you do not want,
 * with the one you do want somewhere in it.
 *
 * @param {string} itemHrid - Any charm in the family
 * @returns {string[]} The six hrids, lowest tier first; empty for a non-charm
 */
export function charmFamily(itemHrid) {
    const focus = charmFocus(itemHrid);
    if (!focus) return [];
    return Object.keys(CHARM_TIER_EXPERIENCE).map((tier) => `/items/${tier}_${focus}_charm`);
}

/**
 * A charm's name in the shape a table column wants.
 *
 * @param {string} itemHrid - The charm
 * @returns {string} e.g. `Melee (Expert)`, or the hrid when it is not a charm
 */
export function charmDisplayName(itemHrid) {
    const match = CHARM_HRID.exec(String(itemHrid || ''));
    if (!match) return String(itemHrid || '');

    const capitalise = (word) => word.charAt(0).toUpperCase() + word.slice(1);
    const focus = match[2].split('_').map(capitalise).join(' ');
    return `${focus} (${capitalise(match[1])})`;
}

/**
 * Experience per million coins.
 *
 * Per coin the ratio is a number like 0.000000052, which no column can show and
 * nobody can compare at a glance. Per million it is 0.05 against 0.03, which is
 * the same ordering in a form you can read.
 *
 * @param {number} experience - The bonus, as a percentage
 * @param {number} price - What it costs
 * @returns {number|null} Null when unpriced, which must not sort above a number
 */
export function experiencePerMillion(experience, price) {
    if (!(price > 0) || !(experience > 0)) return null;
    return (experience / price) * 1_000_000;
}

/**
 * Split a family into what beats what you are wearing and what does not.
 *
 * Both halves are worth showing. The downgrades are not there to be bought —
 * they are there because seeing that a charm two tiers down is a tenth of the
 * price is how you decide the top tier is not worth it.
 *
 * @param {Array<Object>} rows - Charms with an `experience`
 * @param {number} equippedExperience - What the worn charm grants
 * @returns {{upgrades: Array<Object>, downgrades: Array<Object>}}
 */
export function splitByUpgrade(rows, equippedExperience) {
    const worn = Number(equippedExperience) || 0;
    return {
        // Equal counts as an upgrade: the same bonus for less money is the
        // trade people are actually looking for
        upgrades: (rows || []).filter((row) => row && row.experience >= worn),
        downgrades: (rows || []).filter((row) => row && row.experience < worn),
    };
}

/**
 * Order a table of charms by one of its columns.
 *
 * @param {Array<Object>} rows - Charm rows
 * @param {string} column - `name`, `experience`, `price` or `perMillion`
 * @param {string} [direction] - `asc` or `desc`
 * @returns {Array<Object>} A new array
 */
export function sortCharmRows(rows, column, direction = 'desc') {
    const sign = direction === 'asc' ? 1 : -1;
    const tiers = Object.keys(CHARM_TIER_EXPERIENCE);

    const key = (row) => {
        switch (column) {
            // By name means by tier and then by enhancement, which is the order
            // the charms actually come in — alphabetical puts Advanced first
            case 'name':
                return tiers.indexOf(row.tier) * 100 + (row.enhancementLevel || 0);
            case 'price':
                return row.price;
            case 'perMillion':
                return row.experiencePerMillion;
            default:
                return row.experience;
        }
    };

    return [...(rows || [])].filter(Boolean).sort((a, b) => {
        const left = key(a);
        const right = key(b);
        // Unpriced rows go last whichever way the column is pointing: they are
        // the least informative rows, not the best or the worst
        if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;
        if (!Number.isFinite(right)) return -1;
        return (left - right) * sign;
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
