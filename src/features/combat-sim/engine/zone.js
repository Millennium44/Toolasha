// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import { randomSpawn } from './rng.js';
import { getGameData } from './game-data.js';
import Monster from './monster.js';

/**
 * Chance a dungeon wave is drawn from any one table below the highest it has
 * reached. Measured, not documented — see the note in `getNextWave`.
 */
const LOWER_TABLE_RATE = 1 / 7;

class Zone {
    constructor(hrid, difficultyTier) {
        this.hrid = hrid;
        this.difficultyTier = difficultyTier;

        const actionDetailMap = getGameData().actionDetailMap;
        const gameZone = actionDetailMap[this.hrid];
        this.monsterSpawnInfo = gameZone.combatZoneInfo.fightInfo;
        this.dungeonSpawnInfo = gameZone.combatZoneInfo.dungeonInfo;
        this.encountersKilled = 1;
        this.buffs = gameZone.buffs;
        this.isDungeon = gameZone.combatZoneInfo.isDungeon;
        this.dungeonsCompleted = 0;
        this.dungeonsFailed = 0;
        this.finalWave = false;

        // Read, never written: monsterSpawnInfo is a live reference into the
        // shared actionDetailMap, so assigning here rewrote the game data every
        // other reader sees. The zone's own value wins, 10 is the fallback —
        // the same default utils/combat-drop-model.js and utils/expected-kills.js
        // apply to the fight's real battlesPerBoss.
        this.battlesPerBoss = this.monsterSpawnInfo?.battlesPerBoss || 10;
    }

    getRandomEncounter() {
        if (!this.monsterSpawnInfo) {
            return [];
        }

        if (this.monsterSpawnInfo.bossSpawns && this.encountersKilled === this.battlesPerBoss) {
            this.encountersKilled = 1;
            return this.monsterSpawnInfo.bossSpawns.map(
                (monster) => new Monster(monster.combatMonsterHrid, monster.difficultyTier + this.difficultyTier)
            );
        }

        if (!this.monsterSpawnInfo.randomSpawnInfo || !this.monsterSpawnInfo.randomSpawnInfo.spawns) {
            this.encountersKilled++;
            return [];
        }

        const totalWeight = this.monsterSpawnInfo.randomSpawnInfo.spawns.reduce((prev, cur) => prev + cur.rate, 0);

        const encounterHrids = [];
        let totalStrength = 0;

        outer: for (let i = 0; i < this.monsterSpawnInfo.randomSpawnInfo.maxSpawnCount; i++) {
            const randomWeight = totalWeight * randomSpawn();
            let cumulativeWeight = 0;

            for (const spawn of this.monsterSpawnInfo.randomSpawnInfo.spawns) {
                cumulativeWeight += spawn.rate;
                if (randomWeight <= cumulativeWeight) {
                    totalStrength += spawn.strength;

                    if (totalStrength <= this.monsterSpawnInfo.randomSpawnInfo.maxTotalStrength) {
                        encounterHrids.push({ hrid: spawn.combatMonsterHrid, difficultyTier: spawn.difficultyTier });
                    } else {
                        break outer;
                    }
                    break;
                }
            }
        }
        this.encountersKilled++;
        return encounterHrids.map((hrid) => new Monster(hrid.hrid, hrid.difficultyTier + this.difficultyTier));
    }

    failWave() {
        this.dungeonsFailed++;
        this.encountersKilled = 1;
    }

    getNextWave() {
        if (this.encountersKilled > this.dungeonSpawnInfo.maxWaves) {
            this.dungeonsCompleted++;
            this.encountersKilled = 1;
        }

        const waveNum = this.encountersKilled;
        const fixedSpawns = this.dungeonSpawnInfo.fixedSpawnsMap[waveNum.toString()];

        if (fixedSpawns) {
            this.encountersKilled++;
            return fixedSpawns.map(
                (monster) => new Monster(monster.combatMonsterHrid, monster.difficultyTier + this.difficultyTier)
            );
        }

        // Random spawn path.
        //
        // The map's keys gate which tables a wave may draw from, and a wave is
        // drawn whole from exactly ONE of them. Both halves are measured against
        // the tables as read from the live game client, across 138 ordinary
        // waves of Chimerical Den (keys 0/10/30, party of 2) and 95 ordinary
        // waves of Sinister Circus (keys 0/15/40, solo): no monster ever appears
        // below its own key's wave, and not one roster mixes species the way a
        // pooled union of the eligible tables would -- a union that would have to
        // explain 57-85% of the waves it cannot.
        //
        // What the recordings also show is that the table is NOT always the
        // highest eligible one. 28 of those 233 waves are complete, well-formed
        // draws from a strictly lower table, which a highest-only reading gives
        // probability zero. Fitting a mixture by maximum likelihood puts a
        // constant weight on each eligible LOWER table -- 0.130 with one lower
        // table in Chimerical Den's band 10, 0.136 in Sinister Circus's band 15,
        // and 0.125/0.165 and 0.204/0.164 on the two lower tables of their top
        // bands. The share per lower table does not shrink as more become
        // eligible, so the tables do not split a fixed budget: pooling both
        // dungeons, a fixed per-table weight beats a normalized share by
        // dLL = +3.9 (49:1) on the same single parameter, and beats it in each
        // dungeon separately (+2.1 and +1.9). Nor does the weight depend on how
        // far below the current key a table sits (fitting the one- and two-step
        // weights apart gives 0.148 and 0.153, dLL = +0.01 for the extra
        // parameter), and a free weight per band per dungeon buys only
        // dLL = +0.7 for five more parameters.
        //
        // So: each eligible lower table is drawn with LOWER_TABLE_RATE, the
        // current one takes the remainder. The pooled estimate is 0.149 with a
        // 95% profile interval of [0.110, 0.193], and 1/7 sits inside it at a
        // cost of 0.05 log-likelihood, so 1/7 is what is used. Adopting it moves
        // the modelled mean wave HP from +13.7% to -6.0% (Chimerical band 30) and
        // +16.2% to +6.1% (Sinister band 40) against the recordings, at the cost
        // of -6.0% to -15.2% in Chimerical band 10, whose own sampling error is
        // +-8.9%, and +0.7% to -1.3% in Sinister band 15 against +-1.8%.
        //
        // Two residuals this does not touch, both in Sinister Circus. Band 0 runs
        // 2.4% short on monsters and 3.5% short on HP with only ONE table
        // eligible, so no mixture weight can explain it and the overflow reading
        // below cannot either -- with maxSpawnCount 4 and strengths of 50-70
        // against a 250 cap, the only draw that can overflow is the last one,
        // where ending the wave and skipping the draw are the same thing. And
        // band 40 is still +6.1% on HP after the fix. Something in the draw loop
        // itself is still slightly wrong. See zone.test.js.
        const randomSpawnInfoMap = this.dungeonSpawnInfo.randomSpawnInfoMap;

        if (!randomSpawnInfoMap || typeof randomSpawnInfoMap !== 'object') {
            this.encountersKilled++;
            return [];
        }

        const waveKeys = Object.keys(randomSpawnInfoMap)
            .map(Number)
            .sort((a, b) => a - b);

        if (waveKeys.length === 0) {
            this.encountersKilled++;
            return [];
        }

        const eligibleKeys = waveKeys.filter((key) => waveNum >= key);

        let monsterSpawns = null;

        if (eligibleKeys.length > 0) {
            let chosenKey = eligibleKeys[eligibleKeys.length - 1];
            const lowerCount = eligibleKeys.length - 1;

            if (lowerCount > 0) {
                const roll = randomSpawn();
                if (roll < LOWER_TABLE_RATE * lowerCount) {
                    const index = Math.min(Math.floor(roll / LOWER_TABLE_RATE), lowerCount - 1);
                    chosenKey = eligibleKeys[index];
                }
            }

            monsterSpawns = randomSpawnInfoMap[chosenKey];
        }

        // Fallback to first available spawn info if no range matched
        if (!monsterSpawns || !monsterSpawns.spawns) {
            monsterSpawns = randomSpawnInfoMap[waveKeys[0]];
        }

        // Final safety — if still broken, skip wave instead of crashing
        if (!monsterSpawns?.spawns) {
            this.encountersKilled++;
            return [];
        }

        const totalWeight = monsterSpawns.spawns.reduce((prev, cur) => prev + cur.rate, 0);

        const encounterHrids = [];
        let totalStrength = 0;

        outer: for (let i = 0; i < monsterSpawns.maxSpawnCount; i++) {
            const randomWeight = totalWeight * randomSpawn();
            let cumulativeWeight = 0;

            for (const spawn of monsterSpawns.spawns) {
                cumulativeWeight += spawn.rate;
                if (randomWeight <= cumulativeWeight) {
                    totalStrength += spawn.strength;

                    if (totalStrength <= monsterSpawns.maxTotalStrength) {
                        encounterHrids.push({
                            hrid: spawn.combatMonsterHrid,
                            difficultyTier: spawn.difficultyTier,
                        });
                    } else {
                        break outer;
                    }
                    break;
                }
            }
        }
        this.encountersKilled++;
        return encounterHrids.map((hrid) => new Monster(hrid.hrid, hrid.difficultyTier + this.difficultyTier));
    }
}

export default Zone;
