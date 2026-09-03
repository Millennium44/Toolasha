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
        // drawn whole from exactly ONE of them. Measured against the tables as
        // read from the live game client, over 498 ordinary (non-fixed) dungeon
        // waves in three dungeons: Chimerical Den (keys 0/10/30) 297 waves, from
        // a 138-wave party-of-2 recording plus a 159-wave solo spawn census;
        // Enchanted Fortress (keys 0/20/40) 106 census waves, solo; and Sinister
        // Circus (keys 0/15/40) 95 waves, solo. No monster ever appears below
        // its own key's wave, and not one roster mixes species the way a pooled
        // union of the eligible tables would -- a union that would have to
        // explain most of the waves it cannot.
        //
        // The table is NOT always the highest eligible one. 61 of those 498
        // waves are complete, well-formed draws from a strictly lower table, so
        // a highest-only reading gives them probability zero: 12 and 13 of the
        // census's Chimerical bands 10 and 30, 7 and 16 of the party
        // recording's, 8 of Enchanted Fortress band 40, and 5 of Sinister
        // Circus band 40. That much is not a fit, it is arithmetic.
        //
        // How much weight each lower table carries is a fit. The likelihood is
        // exact per roster -- the probability the draw loop below produces that
        // multiset from a given table, overflow termination included -- so a
        // lower draw that could equally have come from the current table simply
        // contributes no evidence either way instead of false confidence. That
        // matters for Enchanted Fortress, whose key-40 and key-20 tables share
        // every species: band 40 still discriminates them (their rates and
        // strength caps differ) but far more weakly than a disjoint pair would.
        //
        // Fitting per band per dungeon puts a constant weight on each eligible
        // LOWER table: 0.166 (Chimerical band 10), 0.099 (Enchanted band 20),
        // 0.136 (Sinister band 15), and on the two-lower-table bands 0.090/0.200
        // (Chimerical 30), 0.080/0.220 (Enchanted 40), 0.205/0.165 (Sinister 40).
        // The share per table does not shrink as more become eligible, so the
        // tables do not split a fixed budget: pooled, a fixed per-table weight
        // beats a normalized share by dLL = +5.36 on the same single parameter,
        // odds of 212:1 (dAIC = dBIC = 10.7), up from +3.9 (49:1) on the older
        // two dungeons alone, and it wins in each dungeon separately (+2.10
        // Chimerical, +1.50 Enchanted, +1.93 Sinister) and in every
        // leave-one-dungeon-out subset (+3.2 to +3.9). A free weight per band
        // per dungeon buys only dLL = +4.40 for eight more parameters
        // (chi2 = 8.81, df 8, p = 0.36), so one parameter is adequate.
        //
        // So: each eligible lower table is drawn with LOWER_TABLE_RATE, the
        // current one takes the remainder. The pooled estimate is 0.1487 with a
        // 95% profile interval of [0.121, 0.179] -- almost exactly the 0.149 the
        // two-dungeon fit gave -- and 1/7 sits inside it at a cost of 0.08
        // log-likelihood, so 1/7 stays. Against the recordings this moves the
        // modelled mean wave HP from +10.6% to -0.2% (Chimerical band 30, census),
        // +3.6% to +0.6% (Chimerical band 10, census), +13.4% to +2.2%
        // (Enchanted band 40) and +16.1% to +6.1% (Sinister band 40), at the cost
        // of +0.6% to -1.5% in Enchanted band 20 and +0.7% to -1.3% in Sinister
        // band 15 -- both regressions smaller than those bands' own sampling
        // error (+-2.4% and +-1.8%).
        //
        // One caveat and two residuals. The caveat: letting the weight depend on
        // how far below the current key a table sits now buys dLL = +1.80 for
        // one extra parameter (0.174 one step below, 0.109 two steps;
        // chi2 = 3.61, df 1, p = 0.058), where the two-dungeon fit saw +0.01.
        // That is not significant and the three dungeons disagree on its sign
        // (Sinister band 40 runs the other way), but if it is real the flat rule
        // slightly over-weights the two-steps-below table. The residuals: with
        // only ONE table eligible, band 0 runs 2.4% short on monsters and 3.5%
        // short on HP in Sinister Circus and 3.2% LONG on monsters in Enchanted
        // Fortress, which no mixture weight can explain and the overflow reading
        // below cannot either; and Sinister band 40 is still +6.1% on HP after
        // the fix. Something in the draw loop itself is still slightly wrong.
        // See zone.test.js.
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
