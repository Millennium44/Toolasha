// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import { getGameData } from './game-data.js';

class SimResult {
    constructor(zone, numberOfPlayers) {
        this.deaths = {};
        this.experienceGained = {};
        this.encounters = 0;
        this.attacks = {};
        /** Landed critical hits per source, the predicted half of the crit-rate check */
        this.crits = {};
        this.consumablesUsed = {};
        this.hitpointsGained = {};
        this.manapointsGained = {};
        this.debuffOnLevelGap = {};
        this.dropRateMultiplier = {};
        this.rareFindMultiplier = {};
        this.combatDropQuantity = {};
        this.playerRanOutOfMana = {
            player1: false,
            player2: false,
            player3: false,
            player4: false,
            player5: false,
        };
        this.playerRanOutOfManaTime = {};
        this.manaUsed = {};
        this.timeSpentAlive = [];
        this.bossSpawns = [];
        this.hitpointsSpent = {};
        this.zoneName = zone.hrid;
        this.difficultyTier = zone.difficultyTier;
        this.isDungeon = false;
        this.dungeonsCompleted = 0;
        this.dungeonsFailed = 0;
        this.maxWaveReached = 0;
        // Clear-time metric matching the in-game dungeon tracker's key→key
        // definition (see dungeon-tracker-chat-annotations.js): the average is
        // taken over completion-to-completion intervals of consecutive
        // successful runs only. A wipe breaks the pair, so failed-run time and
        // the partial final run never enter the average — unlike
        // simulatedTime / dungeonsCompleted, which counts both and so reads
        // systematically longer than a real clear.
        this.dungeonCleanClearTimeTotal = 0;
        this.dungeonCleanClearCount = 0;
        this.numberOfPlayers = numberOfPlayers;
        this.maxEnrageStack = 0;

        this.wipeEvents = [];
        this.totalDamageDealt = {}; // sourceHrid → total damage dealt
        // Mechanics the engine met and skipped, filled in by CombatSimulator at
        // the end of the run. Non-empty means the numbers below understate.
        this.warnings = [];
    }

    addWipeEvent(logs, simulationTime, wave) {
        this.wipeEvents.push({
            simulationTime: simulationTime,
            logs: logs,
            wave: wave,
            timestamp: new Date().toISOString(),
        });
    }

    addDeath(unit) {
        if (!this.deaths[unit.hrid]) {
            this.deaths[unit.hrid] = 0;
        }

        this.deaths[unit.hrid] += 1;
    }

    /**
     * Take back a death a revive undid, for a monster.
     *
     * `deaths` is read as a kill count — the combat adapter multiplies
     * `deaths[monsterHrid]` by the drop table to price a run's loot, and
     * `utils/expected-kills.js` models the same quantity as spawns per battle,
     * not as times a unit hit zero. A revived monster is still the one spawn:
     * it drops once, when it finally stays down. Leaving the first death on the
     * books made every revived monster drop twice.
     *
     * Player deaths are deliberately not undone here — each time a player goes
     * down is a real event the run should report, and nothing prices loot off
     * them.
     *
     * @param {Object} unit - The revived unit
     * @param {number} time - Current simulation time in nanoseconds
     */
    undoDeath(unit, time) {
        if (unit.isPlayer) {
            return;
        }

        if (this.deaths[unit.hrid] > 0) {
            this.deaths[unit.hrid] -= 1;
        }

        // The death also closed this unit's alive window and counted it. Reopen
        // the window at the revive and take the count back, so `count` stays a
        // count of spawns that finished, matching `deaths`.
        const i = this.timeSpentAlive.findIndex((e) => e.name === unit.hrid);
        if (i !== -1 && this.timeSpentAlive[i].count > 0) {
            this.timeSpentAlive[i].count -= 1;
        }
        this.updateTimeSpentAlive(unit.hrid, true, time);
    }

    updateTimeSpentAlive(name, alive, time) {
        const i = this.timeSpentAlive.findIndex((e) => e.name === name);
        if (alive) {
            if (i !== -1) {
                this.timeSpentAlive[i].alive = true;
                this.timeSpentAlive[i].spawnedAt = time;
            } else {
                this.timeSpentAlive.push({ name: name, timeSpentAlive: 0, spawnedAt: time, alive: true, count: 0 });
            }
        } else {
            const timeAlive = time - this.timeSpentAlive[i].spawnedAt;
            this.timeSpentAlive[i].alive = false;
            this.timeSpentAlive[i].timeSpentAlive += timeAlive;
            this.timeSpentAlive[i].count += 1;
        }
    }

    addExperienceGain(unit, experience) {
        if (!unit.isPlayer) {
            return;
        }

        if (!this.experienceGained[unit.hrid]) {
            this.experienceGained[unit.hrid] = {
                stamina: 0,
                intelligence: 0,
                attack: 0,
                melee: 0,
                defense: 0,
                ranged: 0,
                magic: 0,
            };
        }

        const experienceGainedRate = {
            stamina: 0,
            intelligence: 0,
            attack: 0,
            melee: 0,
            defense: 0,
            ranged: 0,
            magic: 0,
        };

        const primaryTraining = unit.combatDetails.combatStats.primaryTraining;
        experienceGainedRate[primaryTraining.split('/')[2]] = 0.3;

        const combatStyleDetailMap = getGameData().combatStyleDetailMap;
        const skillExpMap = combatStyleDetailMap[unit.combatDetails.combatStats.combatStyleHrid].skillExpMap;
        const skillExpMapLength = Object.keys(skillExpMap).length;

        const focusTraining = unit.combatDetails.combatStats.focusTraining;
        if (focusTraining && skillExpMap[focusTraining]) {
            experienceGainedRate[focusTraining.split('/')[2]] += 0.7;
        } else {
            Object.keys(skillExpMap).forEach((skillHrid) => {
                experienceGainedRate[skillHrid.split('/')[2]] += 0.7 / skillExpMapLength;
            });
        }

        for (const [type, rate] of Object.entries(experienceGainedRate)) {
            if (rate <= 0) continue;

            const skillExperience = rate * (1 + unit.combatDetails.combatStats[type + 'Experience']);

            this.experienceGained[unit.hrid][type] +=
                experience *
                (1 + unit.combatDetails.combatStats.combatExperience) *
                skillExperience *
                (1 + unit.debuffOnLevelGap);
        }
    }

    addEncounterEnd() {
        this.encounters++;
    }

    addAttack(source, target, ability, hit, isCrit = false) {
        if (!this.attacks[source.hrid]) {
            this.attacks[source.hrid] = {};
        }
        if (!this.attacks[source.hrid][target.hrid]) {
            this.attacks[source.hrid][target.hrid] = {};
        }
        if (!this.attacks[source.hrid][target.hrid][ability]) {
            this.attacks[source.hrid][target.hrid][ability] = {};
        }

        if (!this.attacks[source.hrid][target.hrid][ability][hit]) {
            this.attacks[source.hrid][target.hrid][ability][hit] = 0;
        }

        this.attacks[source.hrid][target.hrid][ability][hit] += 1;

        if (hit !== 'miss') {
            this.totalDamageDealt[source.hrid] = (this.totalDamageDealt[source.hrid] || 0) + hit;
            // Counted beside the histogram rather than in it: the histogram
            // keys are damage values, and folding crit-ness into the key would
            // double its cardinality for one bit. The recorder keeps the real
            // crit count per fight; this is the predicted side of that row.
            if (isCrit) {
                this.crits[source.hrid] = (this.crits[source.hrid] || 0) + 1;
            }
        }
    }

    addConsumableUse(unit, consumable) {
        if (!this.consumablesUsed[unit.hrid]) {
            this.consumablesUsed[unit.hrid] = {};
        }
        if (!this.consumablesUsed[unit.hrid][consumable.hrid]) {
            this.consumablesUsed[unit.hrid][consumable.hrid] = 0;
        }

        this.consumablesUsed[unit.hrid][consumable.hrid] += 1;
    }

    addHitpointsGained(unit, source, amount) {
        if (!this.hitpointsGained[unit.hrid]) {
            this.hitpointsGained[unit.hrid] = {};
        }
        if (!this.hitpointsGained[unit.hrid][source]) {
            this.hitpointsGained[unit.hrid][source] = 0;
        }

        this.hitpointsGained[unit.hrid][source] += amount;
    }

    addManapointsGained(unit, source, amount) {
        if (!this.manapointsGained[unit.hrid]) {
            this.manapointsGained[unit.hrid] = {};
        }
        if (!this.manapointsGained[unit.hrid][source]) {
            this.manapointsGained[unit.hrid][source] = 0;
        }

        this.manapointsGained[unit.hrid][source] += amount;
    }

    setDropRateMultipliers(unit) {
        if (!this.dropRateMultiplier[unit.hrid]) {
            this.dropRateMultiplier[unit.hrid] = {};
        }
        this.dropRateMultiplier[unit.hrid] = 1 + unit.combatDetails.combatStats.combatDropRate;

        if (!this.rareFindMultiplier[unit.hrid]) {
            this.rareFindMultiplier[unit.hrid] = {};
        }
        this.rareFindMultiplier[unit.hrid] = 1 + unit.combatDetails.combatStats.combatRareFind;

        if (!this.combatDropQuantity[unit.hrid]) {
            this.combatDropQuantity[unit.hrid] = {};
        }
        this.combatDropQuantity[unit.hrid] = unit.combatDetails.combatStats.combatDropQuantity;

        if (!this.debuffOnLevelGap[unit.hrid]) {
            this.debuffOnLevelGap[unit.hrid] = {};
        }
        this.debuffOnLevelGap[unit.hrid] = unit.debuffOnLevelGap;
    }

    setManaUsed(unit) {
        this.manaUsed[unit.hrid] = {};
        for (const [key, value] of unit.abilityManaCosts.entries()) {
            this.manaUsed[unit.hrid][key] = value;
        }
    }

    addHitpointsSpent(unit, source, amount) {
        if (!this.hitpointsSpent[unit.hrid]) {
            this.hitpointsSpent[unit.hrid] = {};
        }
        if (!this.hitpointsSpent[unit.hrid][source]) {
            this.hitpointsSpent[unit.hrid][source] = 0;
        }

        this.hitpointsSpent[unit.hrid][source] += amount;
    }

    addRanOutOfManaCount(unit, isOutOfMana, time) {
        if (isOutOfMana) this.playerRanOutOfMana[unit.hrid] = true;

        if (!this.playerRanOutOfManaTime[unit.hrid]) {
            this.playerRanOutOfManaTime[unit.hrid] = {
                isOutOfMana: false,
                startTimeForOutOfMana: 0,
                totalTimeForOutOfMana: 0,
            };
        }

        if (isOutOfMana) {
            if (!this.playerRanOutOfManaTime[unit.hrid].isOutOfMana) {
                this.playerRanOutOfManaTime[unit.hrid].isOutOfMana = true;
                this.playerRanOutOfManaTime[unit.hrid].startTimeForOutOfMana = time;
            }
        } else if (this.playerRanOutOfManaTime[unit.hrid].isOutOfMana) {
            this.playerRanOutOfManaTime[unit.hrid].isOutOfMana = false;
            this.playerRanOutOfManaTime[unit.hrid].totalTimeForOutOfMana +=
                time - this.playerRanOutOfManaTime[unit.hrid].startTimeForOutOfMana;
        }
    }
}

export default SimResult;
