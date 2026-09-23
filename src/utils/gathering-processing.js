/**
 * Expected whole conversions when Processing rolls once over all outputs of an
 * action completion. Efficiency repeats the gather roll before that conversion;
 * flooring an average stack loses the remainder carried between repeats.
 * @param {Object} drop - One game drop-table row
 * @param {number} conversionRatio - Raw items consumed per processed item
 * @param {number} gatheringQuantity - Gathering bonus as a decimal
 * @param {number} efficiencyMultiplier - Expected gather rolls per completion
 * @returns {number} Expected processed items if Processing procs
 */
export function expectedProcessedItems(drop, conversionRatio, gatheringQuantity, efficiencyMultiplier) {
    const repeatCount = Math.floor(efficiencyMultiplier);
    const extraRepeatChance = efficiencyMultiplier - repeatCount;
    const outcomes = [];
    const countRange = drop.maxCount - drop.minCount + 1;
    for (let count = drop.minCount; count <= drop.maxCount; count++) {
        const boosted = count * (1 + gatheringQuantity);
        const whole = Math.floor(boosted);
        const fraction = boosted - whole;
        outcomes.push({ count: whole, probability: (drop.dropRate * (1 - fraction)) / countRange });
        if (fraction > 0) outcomes.push({ count: whole + 1, probability: (drop.dropRate * fraction) / countRange });
    }
    outcomes.push({ count: 0, probability: 1 - drop.dropRate });

    let remainders = Array(conversionRatio).fill(0);
    remainders[0] = 1;
    let expectedCount = 0;
    const perRepeatMean = drop.dropRate * ((drop.minCount + drop.maxCount) / 2) * (1 + gatheringQuantity);
    let baseConversions = 0;
    let extraConversions = 0;
    for (let repeat = 1; repeat <= repeatCount + (extraRepeatChance > 0 ? 1 : 0); repeat++) {
        const next = Array(conversionRatio).fill(0);
        for (let remainder = 0; remainder < conversionRatio; remainder++) {
            for (const outcome of outcomes) {
                next[(remainder + outcome.count) % conversionRatio] += remainders[remainder] * outcome.probability;
            }
        }
        remainders = next;
        expectedCount += perRepeatMean;
        const expectedRemainder = remainders.reduce((sum, probability, remainder) => sum + probability * remainder, 0);
        const conversions = (expectedCount - expectedRemainder) / conversionRatio;
        if (repeat === repeatCount) baseConversions = conversions;
        if (repeat === repeatCount + 1) extraConversions = conversions;
    }
    return baseConversions * (1 - extraRepeatChance) + extraConversions * extraRepeatChance;
}
