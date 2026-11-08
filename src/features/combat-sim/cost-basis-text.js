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
