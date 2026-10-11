// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import { getGameData } from './game-data.js';

/**
 * Round a loot stat for a histogram key: enough digits to keep every real
 * value apart, few enough that float noise from buff arithmetic folds together.
 * @param {number} value - A combat stat
 * @returns {number} The rounded value (0 for a missing one)
 */
function roundLootStat(value) {
    const n = Number(value) || 0;
    return Math.round(n * 1e6) / 1e6 + 0;
}

/**
 * A player's loot stats now. A downed player is read from the buffs still
 * running at `time`: death clears their expiry checks, so the folded stats keep
 * a drink that lapsed while they were down until a revive prunes it.
 */
function activeLootStats(player, time) {
    const stats = player?.combatDetails?.combatStats;
    if (
        time !== null &&
        stats &&
        typeof player.lootStatsAt === 'function' &&
        !(player.combatDetails.currentHitpoints > 0)
    ) {
        return player.lootStatsAt(time);
    }
    return stats;
}

/**
 * The lootStates key for one set of loot stats.
 * @param {number} dropRate - combatDropRate
 * @param {number} rareFind - combatRareFind
 * @param {number} dropQuantity - combatDropQuantity
 * @returns {string} "<dropRate>|<rareFind>|<dropQuantity>"
 */
export function lootStateKey(dropRate, rareFind, dropQuantity) {
    return `${roundLootStat(dropRate)}|${roundLootStat(rareFind)}|${roundLootStat(dropQuantity)}`;
}

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
        // Per player: the HP and MP pools the run ended with, which the trigger optimizer scales its
        // food thresholds to
        this.playerPools = {};
        this.rareFindMultiplier = {};
        this.combatDropQuantity = {};
        // Loot is valued at the stats each player held when the kill landed, not at
        // the end of the run: a Lucky Coffee that lapsed at the cutoff must not
        // strip its bonus from every kill it covered. Per player, per monster, a
        // histogram of kills by "<dropRate>|<rareFind>|<dropQuantity>" (see
        // lootStateKey). The end-of-run multipliers above stay for results
        // recorded before this existed.
        this.lootStates = {};
        // Per player: dungeon completions by the drop quantity held at the
        // completion, "<dropQuantity>" → completions
        this.dungeonQtyStates = {};
        this.playerRanOutOfMana = {
            player1: false,
            player2: false,
            player3: false,
            player4: false,
            player5: false,
        };
        this.playerRanOutOfManaTime = {};
        // Per player: ability casts that went through, and refusals - a triggered ability the unit could not
        // afford. A refusal is counted once per ability per cooldown period (see addCastRefused), because
        // checkTriggers re-tests after every event and a per-check count would scale with event density, and a
        // per-stretch count would scale with the number of worker chunks, each of which starts at full mana.
        this.manaCastsMade = {};
        this.manaCastsRefused = {};
        this.manaRefusalNextAt = {};
        this.manaUsed = {};
        // unitHrid → ability/item hrid → how often its trigger rows were read; see setTriggerChecks
        this.triggerChecks = {};
        this.timeSpentAlive = [];
        // Per dungeon wave: how long after the wave spawned the party first
        // landed damage on it — { name: '#k', total, count } in simulation
        // time. The windup before a wave's first hit is the one part of a run
        // the alive time above cannot separate out, and the part a real
        // recording can be compared against wave for wave.
        this.waveFirstHit = [];
        // The open-wave window ({ label, spawnedAt, hitSeen }) and the clock the
        // simulator injects (() => simulationTime) both live here for
        // addAttack's sake, but must never travel with the result: the worker
        // posts it back to the page with postMessage, whose structured clone
        // cannot copy a function. Non-enumerable, so the clone skips them.
        Object.defineProperty(this, '_wave', { value: null, writable: true, enumerable: false, configurable: true });
        Object.defineProperty(this, 'clock', { value: null, writable: true, enumerable: false, configurable: true });
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
     * Record the loot stats each player holds as a monster dies, one kill in
     * each player's histogram. The key is kept on the unit so a revive takes
     * back exactly the tuple this death recorded (see undoDeath).
     *
     * Every player is credited, standing or down, the same as `deaths` credits
     * every player today.
     *
     * @param {Object} unit - The monster that just died
     * @param {Array<Object>} players - The party
     * @param {number|null} [time] - Simulation time, so a downed player is read without buffs that lapsed while down
     */
    addLootStates(unit, players, time = null) {
        if (!unit || unit.isPlayer || !Array.isArray(players)) return;
        const keys = {};
        for (const player of players) {
            const stats = activeLootStats(player, time);
            if (!player?.hrid || !stats) continue;
            const key = lootStateKey(stats.combatDropRate, stats.combatRareFind, stats.combatDropQuantity);
            const byMonster = (this.lootStates[player.hrid] ??= {});
            const buckets = (byMonster[unit.hrid] ??= {});
            buckets[key] = (buckets[key] || 0) + 1;
            keys[player.hrid] = key;
        }
        unit._lootKeys = keys;
    }

    /**
     * Take back the loot tuple a revived monster's death recorded.
     * @param {Object} unit - The revived monster
     */
    removeLootStates(unit) {
        const keys = unit?._lootKeys;
        if (!keys) return;
        for (const [playerHrid, key] of Object.entries(keys)) {
            const buckets = this.lootStates[playerHrid]?.[unit.hrid];
            if (!buckets || !(buckets[key] > 0)) continue;
            buckets[key] -= 1;
            if (buckets[key] === 0) delete buckets[key];
        }
        unit._lootKeys = null;
    }

    /**
     * The drop quantity bucket each player holds right now, without recording it.
     * @param {Array<Object>} players - The party
     * @param {number|null} [time] - Simulation time, for downed players
     * @returns {Object<string, string>} Bucket key by player hrid
     */
    dungeonQtyKeys(players, time = null) {
        const keys = {};
        if (!Array.isArray(players)) return keys;
        for (const player of players) {
            const stats = activeLootStats(player, time);
            if (!player?.hrid || !stats) continue;
            keys[player.hrid] = String(roundLootStat(stats.combatDropQuantity));
        }
        return keys;
    }

    /**
     * Record the drop quantity each player holds at a dungeon completion.
     * @param {Array<Object>} players - The party
     * @param {Object<string, string>|null} [captured] - Keys taken earlier with dungeonQtyKeys; read live when absent
     * @param {number|null} [time] - Simulation time, for downed players
     */
    addDungeonQtyStates(players, captured = null, time = null) {
        if (!Array.isArray(players)) return;
        const keys = captured || this.dungeonQtyKeys(players, time);
        for (const player of players) {
            const key = keys[player?.hrid];
            if (key === undefined) continue;
            const buckets = (this.dungeonQtyStates[player.hrid] ??= {});
            buckets[key] = (buckets[key] || 0) + 1;
        }
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
        this.removeLootStates(unit);

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
        // A dungeon wave ('#k') opening starts its first-hit window; closing ends it
        if (typeof name === 'string' && name.startsWith('#')) {
            this._wave = alive ? { label: name, spawnedAt: time, hitSeen: false } : null;
        }
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

    /**
     * Record the party's first damage on the open dungeon wave, once per wave.
     * Only a player hitting a monster counts: a monster hitting a player, or
     * thorns credited back to a monster, says nothing about the party's
     * windup. Needs the clock the simulator injects; without it nothing is kept.
     * @param {Object} source - The attacking unit
     * @param {Object} target - The unit hit
     * @param {number} hit - Damage dealt
     */
    _noteWaveFirstHit(source, target, hit) {
        const wave = this._wave;
        if (!wave || wave.hitSeen) return;
        if (!source?.isPlayer || target?.isPlayer || !(Number(hit) > 0)) return;
        const now = typeof this.clock === 'function' ? this.clock() : null;
        if (!Number.isFinite(now)) return;
        wave.hitSeen = true;
        const delay = Math.max(0, now - wave.spawnedAt);
        const entry = this.waveFirstHit.find((e) => e.name === wave.label);
        if (entry) {
            entry.total += delay;
            entry.count += 1;
        } else {
            this.waveFirstHit.push({ name: wave.label, total: delay, count: 1 });
        }
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
            this._noteWaveFirstHit(source, target, hit);
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

    setPlayerPools(unit) {
        this.playerPools[unit.hrid] = {
            maxHitpoints: unit.combatDetails.maxHitpoints,
            maxManapoints: unit.combatDetails.maxManapoints,
        };
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

    /**
     * Record how often each of a unit's abilities, foods and drinks had its trigger rows read: the slot
     * was ready (off cooldown, not stunned or silenced) and reached its turn, so `Trigger.isActive` ran.
     * A slot with no rows, or one never reached, reads 0. A trigger row's threshold enters a run only
     * through those reads, so a slot at 0 ran exactly as it would have with any other threshold —
     * the trigger optimizer uses that to skip rows that cannot change the result.
     * @param {Object} unit - A player at the end of the run
     */
    setTriggerChecks(unit) {
        const out = {};
        for (const slot of [...(unit.abilities || []), ...(unit.food || []), ...(unit.drinks || [])]) {
            if (!slot) continue;
            out[slot.hrid] = (out[slot.hrid] || 0) + (slot.triggerChecks || 0);
        }
        this.triggerChecks[unit.hrid] = out;
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

    addCastMade(unit) {
        this.manaCastsMade[unit.hrid] = (this.manaCastsMade[unit.hrid] || 0) + 1;
    }

    /**
     * Counts one refused cast per ability per cooldown period, however often checkTriggers re-tests it, so the
     * count is density-independent and adds across worker chunks. A floor of one second stops a zero-cooldown
     * ability from being counted on every event.
     */
    addCastRefused(unit, ability, time, cooldownPeriod) {
        if (!this.manaRefusalNextAt[unit.hrid]) this.manaRefusalNextAt[unit.hrid] = {};
        const nextAt = this.manaRefusalNextAt[unit.hrid];
        if (time < (nextAt[ability.hrid] ?? 0)) return;
        nextAt[ability.hrid] = time + Math.max(cooldownPeriod, 1e9);
        this.manaCastsRefused[unit.hrid] = (this.manaCastsRefused[unit.hrid] || 0) + 1;
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
