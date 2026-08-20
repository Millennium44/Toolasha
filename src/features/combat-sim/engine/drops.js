// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
class Drops {
    constructor(itemHrid, dropRate, minCount, maxCount, difficultyTier) {
        this.itemHrid = itemHrid;
        this.dropRate = dropRate;
        this.minCount = minCount;
        this.maxCount = maxCount;
        this.difficultyTier = difficultyTier;
    }
}

export default Drops;
