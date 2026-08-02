/**
 * Ability books
 *
 * How many books an ability level costs, and which level is the cheapest to buy.
 *
 * ## The book that teaches the ability
 *
 * An ability you have never learned is level 0, and the first book does not
 * grant experience towards level 1 — it teaches the ability. So a plan from
 * level 0 is one book more than the experience arithmetic says, and a
 * calculation that misses it is short by exactly one book every time, which is
 * the kind of error that only shows up when you are one book short.
 *
 * ## Cheapest is not fewest
 *
 * The ability closest to its next level is rarely the cheapest one to level:
 * books differ in experience granted and by orders of magnitude in price. So the
 * question worth answering is not "which is nearest" but "which costs least",
 * and that needs the market.
 *
 * The maths was already in `features/abilities/ability-book-calculator.js`, tied
 * to whichever book the Item Dictionary happened to be showing. It is here so
 * the panel and the dictionary cannot disagree about the same number.
 *
 * The model is BRead's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

/** Where an ability's book lives — the game keeps the two under matching names */
export function bookItemFor(abilityHrid) {
    return String(abilityHrid || '').replace('/abilities/', '/items/');
}

/**
 * Books needed to take an ability to a target level.
 *
 * @param {Object} input - What it needs
 * @param {number} input.level - Current ability level; 0 means never learned
 * @param {number} input.experience - Current ability experience
 * @param {number} input.targetLevel - Level being aimed at
 * @param {number} input.perBookExperience - Experience one book grants
 * @param {number[]} input.table - The game's cumulative `levelExperienceTable`
 * @returns {number|null} Books needed, or null when it cannot be worked out
 */
export function booksToLevel({ level, experience, targetLevel, perBookExperience, table }) {
    const goal = table?.[targetLevel];
    if (goal === undefined || !(perBookExperience > 0)) return null;

    const owed = goal - (Number(experience) || 0);
    // Already past it is nothing to buy, not a negative order
    if (owed <= 0) return level === 0 ? 1 : 0;

    // The first book teaches the ability rather than levelling it
    return Math.ceil(owed / perBookExperience) + (level === 0 ? 1 : 0);
}

/**
 * One ability's plan: what the next level costs, and a chosen target.
 *
 * @param {Object} input - What it needs
 * @param {Object} input.ability - `{abilityHrid, level, experience}`
 * @param {number} input.perBookExperience - Experience one book grants
 * @param {number} input.bookPrice - What one book costs
 * @param {number[]} input.table - The game's cumulative experience table
 * @param {number} [input.targetLevel] - A level beyond the next one
 * @returns {Object|null} The plan, or null without a book to buy
 */
export function abilityPlan({ ability, perBookExperience, bookPrice, table, targetLevel }) {
    if (!ability?.abilityHrid || !(perBookExperience > 0)) return null;

    const level = Number(ability.level) || 0;
    const experience = Number(ability.experience) || 0;
    const price = Number(bookPrice) || 0;

    const next = booksToLevel({ level, experience, targetLevel: level + 1, perBookExperience, table });
    const target = targetLevel && targetLevel > level ? targetLevel : null;
    const toTarget = target ? booksToLevel({ level, experience, targetLevel: target, perBookExperience, table }) : null;

    return {
        abilityHrid: ability.abilityHrid,
        itemHrid: bookItemFor(ability.abilityHrid),
        level,
        experience,
        perBookExperience,
        bookPrice: price,
        booksToNext: next,
        // Nothing rather than zero when the book has no price: an ability whose
        // book is unpriced is not free to level, it is unknown
        costToNext: next === null || !price ? null : next * price,
        targetLevel: target,
        booksToTarget: toTarget,
        costToTarget: toTarget === null || !price ? null : toTarget * price,
    };
}

/**
 * The ability whose next level costs least.
 *
 * Plans with no price are not candidates — an unpriced book is unknown rather
 * than free, and treating it as zero would make it win every time.
 *
 * @param {Array<Object>} plans - From `abilityPlan`
 * @returns {Object|null}
 */
export function cheapestNextLevel(plans) {
    let best = null;
    for (const plan of plans || []) {
        if (!plan || plan.costToNext === null || !(plan.costToNext > 0)) continue;
        if (!best || plan.costToNext < best.costToNext) best = plan;
    }
    return best;
}

/**
 * What a whole set of plans would cost.
 *
 * @param {Array<Object>} plans - From `abilityPlan`
 * @param {string} [field] - `costToNext` or `costToTarget`
 * @returns {{books: number, cost: number, unpriced: number}} `unpriced` is how
 *   many abilities the total could not include, which is the difference between
 *   a total and a lower bound presented as one
 */
export function planTotals(plans, field = 'costToNext') {
    const booksField = field === 'costToTarget' ? 'booksToTarget' : 'booksToNext';
    let books = 0;
    let cost = 0;
    let unpriced = 0;

    for (const plan of plans || []) {
        if (!plan) continue;
        books += plan[booksField] || 0;
        if (plan[field] === null) unpriced++;
        else cost += plan[field];
    }
    return { books, cost, unpriced };
}
