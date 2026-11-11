import { formatKMB } from '../../utils/formatters.js';
import { mirrorsToBuy } from '../../utils/mirror-route.js';

/**
 * The mirrors a build spends, by count: the route's built copies can use mirrors of their own.
 * @param {{mirrorPrice: number, mirrorCount?: number}|undefined} mirror - A ladder's `mirror`
 * @returns {string} Plain text, e.g. "3 Philosopher's Mirrors at 1.2B each"
 */
function mirrorsPhrase(mirror) {
    const count = mirrorsToBuy(mirror?.mirrorCount);
    const each = formatKMB(mirror?.mirrorPrice);
    return count > 1 ? `${count} Philosopher's Mirrors at ${each} each` : `a ${each} Philosopher's Mirror`;
}

/**
 * The clause naming the held copies a mirror build uses as inputs instead of buying them.
 * @param {number[]|undefined} heldLevels - Levels of the held copies used
 * @returns {string} Plain text, empty when none are used
 */
function heldMirrorInputsNote(heldLevels) {
    if (!Array.isArray(heldLevels) || heldLevels.length === 0) return '';
    return `, using the ${heldLevels.map((level) => `+${level}`).join(' and ')} you hold`;
}

/**
 * The one-line account of a laddered price: which copy it enhances from, and
 * whether a fresh base is in the figure.
 * @param {Object} ladder - `costDetail.ladder` from the advisor
 * @param {number|null} [total] - The row's figure, to name in the sentence
 * @returns {string} Plain text
 */
export function ladderSentence(ladder, total = null) {
    if (!ladder) return '';
    if (ladder.mirror) {
        return (
            `Mirror a +${ladder.toLevel - 1} and a +${ladder.toLevel - 2} copy into a +${ladder.toLevel} with ` +
            mirrorsPhrase(ladder.mirror) +
            (Number.isFinite(total) ? ` for ${formatKMB(total)}` : '') +
            heldMirrorInputsNote(ladder.mirror.heldLevels) +
            '.'
        );
    }
    if (ladder.refine?.mirror) {
        return (
            `Mirror a +${ladder.toLevel - 1} and a +${ladder.toLevel - 2} base copy into a +${ladder.toLevel} ` +
            `(${formatKMB(ladder.refine.mirror.baseCost)} with ${mirrorsPhrase(ladder.refine.mirror)}` +
            `${heldMirrorInputsNote(ladder.refine.mirror.heldLevels)}), then refine it: ` +
            `${(ladder.refine.lines || []).join(' + ')} = ${formatKMB(ladder.refine.materialCost)}.`
        );
    }
    if (ladder.refine) {
        const where = ladder.fromEquipped ? 'the one you are wearing' : 'your spare';
        const enhance =
            ladder.refine.enhanceCost > 0
                ? `, then enhance the star item +${ladder.fromLevel} to +${ladder.toLevel} for ` +
                  `${formatKMB(ladder.refine.enhanceCost)}`
                : '';
        return (
            `Refine ${where} +${ladder.fromLevel} (all levels transfer): ` +
            `${(ladder.refine.lines || []).join(' + ')} = ${formatKMB(ladder.refine.materialCost)}${enhance}.`
        );
    }
    // A spare another loadout wears is not a free one: using it takes it off that loadout, which gives up its resale
    const forfeitNote = ladder.claimed ? `; using it gives up its resale, ${formatKMB(ladder.claimedForfeit)}` : '';
    if (ladder.alreadyHeld) {
        if (ladder.claimed) {
            return `You hold a spare at +${ladder.fromLevel}, which meets +${ladder.toLevel}, but another loadout wears it${forfeitNote}.`;
        }
        return `You already hold a spare at +${ladder.fromLevel}, which meets +${ladder.toLevel}.`;
    }
    const span =
        `Enhance from +${ladder.fromLevel} to +${ladder.toLevel}` +
        (Number.isFinite(total) ? ` for ${formatKMB(total)}` : '');
    if (ladder.fresh) {
        const stonesOnly = ladder.baseStonesOnly
            ? ' (the refinement stones alone: your Untradable capes setting counts the base cape as nothing)'
            : '';
        return `${span}: you hold no spare copy, so this includes a fresh base at ${formatKMB(ladder.baseCost)}${stonesOnly}.`;
    }
    if (ladder.fromEquipped) return `${span}, on the copy you are wearing.`;
    if (ladder.claimed) return `${span}, on a spare copy another loadout wears${forfeitNote}.`;
    return `${span}, on the spare copy you hold.`;
}

const money = (value) => formatKMB(Math.round(value));

/**
 * The mirrors a build spends, in a short form.
 * @param {{mirrorPrice: number, mirrorCount?: number}|undefined} mirror - A ladder's `mirror`
 * @returns {string} Plain text, e.g. "2 Philosopher's Mirrors (612.5M each)"
 */
function mirrorsShort(mirror) {
    const count = mirrorsToBuy(mirror?.mirrorCount);
    const each = formatKMB(mirror?.mirrorPrice);
    return count > 1 ? `${count} Philosopher's Mirrors (${each} each)` : `a Philosopher's Mirror (${each})`;
}

/**
 * The resale clause that follows a gross figure: what comes back from the piece the purchase
 * replaces, so the reader sees how the Cost cell is reached. Empty when no resale is credited.
 * @param {Object} detail - `costDetail`
 * @param {boolean} market - True for a listing purchase, which reads "sell ... after tax"
 * @returns {string} Plain text starting with a comma, or empty
 */
function creditClause(detail, market) {
    if (detail.kept?.length) return '';
    const credits = detail.credits || [];
    const priced = credits.filter((credit) => Number.isFinite(credit.price) && credit.price > 0 && !credit.noSalePrice);
    const unsold = credits.filter((credit) => credit.noSalePrice);
    let out = '';
    if (Number.isFinite(detail.net) && Number.isFinite(detail.gross) && detail.net !== detail.gross) {
        const amount = Number.isFinite(detail.credit) && detail.credit > 0 ? detail.credit : detail.gross - detail.net;
        const levels = priced.map((credit) => `+${credit.enhancementLevel}`).join(' and ');
        out += market
            ? `, sell your ${levels || 'current piece'} for ${money(amount)} after tax = ${money(detail.net)}`
            : `, less ${money(amount)}${levels ? ` for your ${levels} sold` : ' resale'} = ${money(detail.net)}`;
        if (detail.creditCapped) out += ' (resale capped at the purchase)';
    }
    if (unsold.length) {
        const levels = unsold.map((credit) => `+${credit.enhancementLevel}`).join(' and ');
        out += `, nothing credited for your ${levels} (no sale price)`;
    }
    return out;
}

/**
 * A compact account of how a gold row's Cost cell was reached, for the all-fights detail: one idea per
 * line, short figures, the basis folded into the wording. Long titles ride in `title` for a tooltip.
 * Never says "buy" for something enhanced, refined or mirror-built, and a held spare buys nothing.
 * @param {Object} detail - `costDetail` from the advisor (already checked to agree with the Cost cell)
 * @param {Object} [options] - Wording inputs
 * @param {string} [options.basisTitle] - Long title of the cost basis, for the first line's tooltip
 * @param {string} [options.keptWhy] - Short reason a kept piece is not sold
 * @param {string} [options.keptTitle] - Full wording (settings hint included) for the kept line's tooltip
 * @param {number} [options.fromLevel] - Candidate's current level, for a path with no ladder
 * @param {number} [options.toLevel] - Candidate's target level
 * @param {boolean} [options.isEnhancement] - The candidate enhances a piece
 * @param {string} [options.kind] - The candidate's type (`house` gets its own wording)
 * @param {boolean} [options.showAcquisitionComparison=false] - Current opt-in; a row that kept the advisor's
 *   quote says why only while it is on (a route-priced row always names its route)
 * @returns {Array<{text: string, title?: string, tone: string}>} Lines, tone one of main|warn|kept
 */
export function compactCostLines(
    detail,
    { basisTitle, keptWhy, keptTitle, fromLevel, toLevel, isEnhancement, kind, showAcquisitionComparison = false } = {}
) {
    const lines = [];
    if (!detail) return lines;
    const ladder = detail.ladder;
    const source = detail.source;
    const built = source === 'enhance' || source === 'sim' || source === 'refine' || source === 'mirror';
    const rates = detail.enhanceSource;
    const ratesTitle = rates ? `Enhance rates: ${rates.label}${rates.detail ? ` — ${rates.detail}` : ''}.` : '';
    const ratesTail = rates && rates.label !== 'Yours' ? ` ${rates.label} enhance rates.` : '';
    const title = [basisTitle, ratesTitle].filter(Boolean).join(' ');
    const main = (text) => lines.push({ text, title: title || undefined, tone: 'main' });
    const hasGross = Number.isFinite(detail.gross);

    if (detail.unpriced?.length > 0) {
        const why = detail.books ? 'no market listing' : 'no market listing or priced path to reach it';
        main(`No price for ${detail.unpriced.join(' and ')}: ${why}, so Cost shows as —.`);
    } else if (ladder && (hasGross || ladder.alreadyHeld)) {
        const total = detail.gross;
        const levels = `+${ladder.fromLevel} → +${ladder.toLevel}`;
        if (ladder.alreadyHeld) {
            if (ladder.claimed) {
                main(
                    `You hold a +${ladder.fromLevel} spare that meets +${ladder.toLevel}, but another loadout wears it: ` +
                        `using it gives up ${money(ladder.claimedForfeit)} of resale.`
                );
            } else {
                main(`You already hold a +${ladder.fromLevel} spare that meets +${ladder.toLevel}: nothing to buy.`);
            }
        } else if (ladder.mirror) {
            const held = ladder.mirror.heldLevels?.length
                ? `, using the ${ladder.mirror.heldLevels.map((level) => `+${level}`).join(' and ')} you hold`
                : '';
            main(
                `Mirror build, estimate: +${ladder.toLevel - 1} and +${ladder.toLevel - 2} copies + ` +
                    `${mirrorsShort(ladder.mirror)}${held} = ${money(total)}${creditClause(detail, false)}.${ratesTail}`
            );
        } else if (ladder.refine?.mirror) {
            main(
                `Mirror build and refine, estimate: base ${money(ladder.refine.mirror.baseCost)}, refining ` +
                    `${money(ladder.refine.materialCost)} = ${money(total)}${creditClause(detail, false)}.${ratesTail}`
            );
        } else if (ladder.refine) {
            const where = ladder.fromEquipped ? 'the one you wear' : 'your spare';
            const enhance = ladder.refine.enhanceCost > 0 ? `, then ${levels} ${money(ladder.refine.enhanceCost)}` : '';
            main(
                `Refined${ladder.refine.enhanceCost > 0 ? ', expected' : ''}: ${where} +${ladder.fromLevel}, ` +
                    `materials ${money(ladder.refine.materialCost)}${enhance} = ${money(total)}${creditClause(detail, false)}.${ratesTail}`
            );
        } else if (ladder.fresh) {
            const base = ladder.baseStonesOnly ? 'stones for a base' : 'fresh base';
            main(
                `Enhanced, expected: ${base} ${money(ladder.baseCost)}, then ${levels} = ${money(total)}` +
                    `${creditClause(detail, false)}.${ratesTail}`
            );
        } else {
            let on = 'on your spare';
            if (ladder.fromEquipped) on = 'on the copy you wear';
            else if (ladder.claimed)
                on = `on a spare another loadout wears (gives up ${money(ladder.claimedForfeit)} of its resale)`;
            main(`Enhanced, expected: ${levels} ${on} = ${money(total)}${creditClause(detail, false)}.${ratesTail}`);
        }
    } else if (detail.books) {
        const books = detail.books;
        const each = books.bookPrice === null ? 'no price' : `${money(books.bookPrice)} each`;
        const learn = books.learnBook ? ' (the learn book included)' : '';
        const sum = hasGross ? ` = ${money(detail.gross)}` : '';
        main(
            `Ability books: ${Math.ceil(books.books)} × ${books.bookName} at ${each}${learn}${sum}. ` +
                'Abilities cannot be resold.'
        );
    } else if (detail.enhancementPath || (isEnhancement && !detail.buys?.length)) {
        if (!hasGross || toLevel == null) {
            main(`Enhanced +${fromLevel ?? 0} → +${toLevel ?? '?'}: no priced path to get there.`);
        } else {
            const kind = source === 'sim' ? 'estimate' : 'expected';
            main(
                `Enhanced, ${kind}: +${fromLevel ?? 0} → +${toLevel} = ${money(detail.gross)}` +
                    `${creditClause(detail, false)}.${ratesTail}`
            );
        }
    } else if (detail.buys?.length) {
        let verb = 'buy';
        let label = 'Market';
        if (built) {
            verb = 'build';
            label = 'Built, estimate';
        } else if (source === 'craft') {
            verb = 'make';
            label = 'Crafted';
        }
        const what = detail.buys
            .map((buy) =>
                buy.forgone
                    ? `your ${buy.name} +${buy.enhancementLevel} (gives up ${money(buy.price)} of sale)`
                    : `${buy.name} +${buy.enhancementLevel} for ${buy.price === null ? 'no price' : money(buy.price)}`
            )
            .join(' and ');
        main(`${label}: ${verb} ${what}${creditClause(detail, verb === 'buy')}.${ratesTail}`);
    } else if (kind === 'house' && hasGross) {
        // A house level lists no purchases, but its bill is coins plus materials at their buy prices, and
        // materials already in the inventory are not taken off it: an empty buy list is not "nothing to buy"
        main(`House construction: coins and materials at market buy prices = ${money(detail.gross)}.`);
    } else if (Number.isFinite(detail.net)) {
        // Neutral: an empty buy list alone does not establish that nothing has to be bought
        main(`Cost ${money(detail.net)}.`);
    }

    if (detail.kept?.length) {
        const names = detail.kept.map((k) => `${k.name} +${k.enhancementLevel}`).join(', ');
        let resale = '';
        if (Number.isFinite(detail.keptValue) && detail.keptValue > 0) {
            resale = `${money(detail.keptValue)} resale not credited`;
        } else if (detail.kept.some((k) => k.priced === false)) {
            resale = 'no resale credit, no price';
        }
        if (resale) lines.push({ text: `Keeps ${names} (${resale}: ${keptWhy}).`, title: keptTitle, tone: 'kept' });
    }
    const route = sharedRouteText(detail, { showKept: showAcquisitionComparison });
    // The route that set the figure comes first; a kept quote's reason is a note after the account
    if (route && detail.sharedRoute?.applied) lines.unshift({ text: route, tone: 'main', plainText: true });
    else if (route) lines.push({ text: route, tone: 'warn', plainText: true });
    for (const note of detail.ownershipNotes || []) lines.push({ text: note, tone: 'warn' });
    return lines;
}

/** Route ids as the row names them */
const ROUTE_NAMES = { buy: 'Buy', craft: 'Craft', mirror: 'Mirror' };

/**
 * One short sentence on which route set a row's Cost.
 *
 * A row the shared route priced always says so, whatever the setting is now: the figure on screen came
 * from it. A row that kept the advisor's own quote says why only while the setting is on, and an
 * analysis saved before route pricing (a bare `acquisitionComparison`) says nothing, since its Cost was
 * never route-priced.
 * @param {Object|null} detail - `costDetail`
 * @param {Object} [options]
 * @param {boolean} [options.showKept=false] - Whether to explain a row that kept the advisor's quote
 * @returns {string} Plain text, empty when there is nothing to say
 */
export function sharedRouteText(detail, { showKept = false } = {}) {
    const stamp = detail?.sharedRoute;
    if (!stamp) return '';
    const name = ROUTE_NAMES[stamp.route] || '';
    if (stamp.applied) {
        const why =
            stamp.preference && stamp.preference !== 'auto' && stamp.preference === stamp.route
                ? 'your preferred route'
                : 'the lowest real cost';
        const own = Number.isFinite(stamp.advisorNet) ? stamp.real - stamp.advisorNet : null;
        const versus =
            own === null
                ? '; the advisor had no quote of its own'
                : `, ${money(Math.abs(own))} ${own < 0 ? 'below' : 'above'} the advisor's own quote`;
        return `Priced by ${name}, ${why}: ${money(stamp.real)}${versus}.`;
    }
    if (!showKept) return '';
    if (stamp.agrees) return `${name} route, the same as the advisor's own quote.`;
    const route = name && Number.isFinite(stamp.real) ? ` (${name} ${money(stamp.real)} not used)` : '';
    return `Advisor's own quote${route}: ${stamp.reason}`;
}
