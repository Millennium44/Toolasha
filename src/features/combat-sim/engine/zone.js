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
        // read from the live game client, over 2431 ordinary (non-fixed) dungeon
        // waves in three dungeons: Chimerical Den (keys 0/10/30) 2230 waves, from
        // a 2092-wave solo spawn census plus a 138-wave party-of-2 recording;
        // Enchanted Fortress (keys 0/20/40) 106 census waves, solo; and Sinister
        // Circus (keys 0/15/40) 95 waves, solo. No monster ever appears below
        // its own key's wave, and not one roster mixes species the way a pooled
        // union of the eligible tables would -- a union that would have to
        // explain most of the waves it cannot.
        //
        // The table is NOT always the highest eligible one. 310 of those 2431
        // waves are complete, well-formed draws from a strictly lower table, so
        // a highest-only reading gives them probability zero: 107 and 167 of the
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
        // LOWER table: 0.144 (Chimerical band 10), 0.099 (Enchanted band 20),
        // 0.136 (Sinister band 15), and on the two-lower-table bands 0.125/0.140
        // (Chimerical 30), 0.080/0.220 (Enchanted 40), 0.205/0.165 (Sinister 40),
        // quoted two-steps-below first. The share per table does not shrink as
        // more become eligible, so the tables do not split a fixed budget:
        // pooled, a fixed per-table weight beats a normalized share (s = 0.199)
        // by dLL = +19.71 on the same single parameter, odds of 3.6e8:1
        // (dAIC = dBIC = 39.4), and it wins in each dungeon separately (+16.51
        // Chimerical, +1.50 Enchanted, +1.93 Sinister) and in every
        // leave-one-dungeon-out subset (+3.2 to +18.2). A free weight per band
        // per dungeon buys only dLL = +2.78 for eight more parameters
        // (chi2 = 5.56, df 8, p = 0.70), so one parameter is adequate.
        //
        // So: each eligible lower table is drawn with LOWER_TABLE_RATE, the
        // current one takes the remainder. The pooled estimate is 0.1349 with a
        // 95% profile interval of [0.1227, 0.1477], five times tighter than the
        // [0.121, 0.179] the 498-wave fit gave. 1/7 = 0.1429 still sits inside
        // it, at a cost of 0.75 log-likelihood (chi2 = 1.50, p = 0.22), so 1/7
        // stays -- but it is now near the upper edge, and 0.15 and 1/6 are
        // excluded outright. Against the recordings this moves the modelled mean
        // wave HP from +9.9% to -0.8% (Chimerical band 30, census, n = 832),
        // +3.5% to +0.4% (Chimerical band 10, n = 837), +13.4% to +2.2%
        // (Enchanted band 40) and +16.1% to +6.1% (Sinister band 40), at the cost
        // of +0.6% to -1.5% in Enchanted band 20 and +0.7% to -1.3% in Sinister
        // band 15 -- both regressions smaller than those bands' own sampling
        // error (+-2.4% and +-1.8%). The two Chimerical gains are now 12 and 7
        // times their sampling error (+-0.8% and +-0.5%).
        //
        // The distance question is settled: the weight does NOT taper. Letting
        // it depend on how far below the current key a table sits gives 0.142
        // one step below and 0.124 two steps, dLL = +0.82 for the extra
        // parameter (chi2 = 1.64, df 1, p = 0.20) -- the 498-wave fit had this at
        // p = 0.058, and six times the data pushed it back towards nothing.
        // Chimerical band 30 alone now estimates the two weights separately
        // (896 waves): 0.135 [0.111, 0.161] one step below, 0.122 [0.102, 0.144]
        // two steps, intervals that overlap over most of their length. The other
        // two dungeons still disagree on the sign (Sinister runs the other way)
        // and neither is significant on its own. Flat it is.
        //
        // Two residuals remain, neither of which any table-choice rule can
        // explain. With only ONE table eligible, Chimerical band 0 is now exact
        // on the means (423 waves: -0.0% monsters, -0.2% HP), which retires the
        // 2-3% band-0 gap as a claim about the draw loop's arithmetic; but
        // Enchanted band 0 is still +3.2% on monsters and Sinister band 0 still
        // -2.4%, both on 24-32 waves and both within 1.5 sigma, and neither
        // dataset grew. What did sharpen is species composition inside band 0:
        // against equal rates, Chimerical band 0 gives chi2 = 22.7 on 13 species
        // (Monte-Carlo p = 0.027, sea_snail +25%, frog and slimy short) and
        // Enchanted band 0 chi2 = 15.8 on 7 (p = 0.016, abyssal_imp +86%). The
        // Chimerical pattern half-replicates across the two halves of its own
        // waves (r = +0.46) but not against the party recording (r = -0.36), so
        // it is a hint, not a finding. And Sinister band 40 is still +6.1% on HP
        // after the fix. Something in the draw loop itself may still be slightly
        // wrong. See zone.test.js.
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
