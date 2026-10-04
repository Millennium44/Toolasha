/** Guild trials reuse combat mechanics, with their own encounter lifecycle. */
import CombatSimulator from './combat-simulator.js';
import Monster from './monster.js';
import Player from './player.js';
import { getGameData } from './game-data.js';
import { buildPlayerExtraBuffs } from './extra-buffs.js';
import { random, seedSimRng, syncEncounterRng } from './rng.js';
import { resetSimWarnings, getSimWarnings } from './sim-warnings.js';
import CombatStartEvent from './events/combat-start-event.js';
import EnrageTickEvent from './events/enrage-tick-event.js';
import RegenTickEvent from './events/regen-tick-event.js';
import { levelFromTier, TRIAL_MAX_TIER } from '../../guild/guild-trials-math.js';
import { summarizeTrialRuns, validateTrialScenario } from '../guild-trial-model.js';

const SECOND = 1e9;

/** Trial scaling is level-based, with participant bonuses on top of the base sheet. */
export class GuildTrialMonster extends Monster {
    constructor(hrid, tier, participants) {
        super(hrid, 0, levelFromTier(tier), true);
        this.participants = participants;
    }

    updateCombatDetails() {
        super.updateCombatDetails();
        const n = this.participants;
        this.combatDetails.maxHitpoints = Math.floor(this.combatDetails.maxHitpoints * (1 + 0.01 * n));
        this.combatDetails.combatStats.attackInterval /= 1 + 0.02 * n;
        this.combatDetails.combatStats.castSpeed += 0.02 * n;
        this.combatDetails.combatStats.abilityHaste += 2 * n;
    }
}

function regenBuff(type) {
    return {
        uniqueHrid: `/buff_uniques/guild_trial_${type}`,
        typeHrid: `/buff_types/${type}_regen`,
        flatBoost: 0.03,
        ratioBoost: 0,
    };
}

class TrialPlayer extends Player {
    updateCombatDetails() {
        super.updateCombatDetails();
        // Equipment haste is already folded by Player; trial-building or manual
        // haste is a separate buff, which the generic unit does not fold.
        this.combatDetails.combatStats.abilityHaste += this.getBuffBoost('/buff_types/ability_haste').flatBoost;
    }
}

/** Make fresh combat units; no food, drink, Labyrinth scrolls or party-level penalty. */
export function createTrialPlayers(members, sharedBuffs = [], buildingBuffs = []) {
    return members.map((member, index) => {
        const dto = structuredClone(member.dto);
        dto.hrid = `player${index + 1}`;
        dto.food = [];
        dto.drinks = [];
        dto.scrollBuffs = [];
        dto.debuffOnLevelGap = 0;
        const player = Object.assign(new TrialPlayer(), Player.createFromDTO(dto));
        player.zoneBuffs = [];
        player.extraBuffs = [
            ...buildPlayerExtraBuffs(sharedBuffs, dto),
            ...buildingBuffs,
            regenBuff('hp'),
            regenBuff('mp'),
        ];
        return player;
    });
}

export class GuildCombatSimulator extends CombatSimulator {
    constructor(players, scenario, monsterHrids, onProgress = () => {}) {
        // SimResult only needs these fields. No normal spawn, loot or respawn rules.
        super(
            players,
            { hrid: scenario.trialHrid, difficultyTier: 0, isDungeon: false, encountersKilled: 0 },
            onProgress
        );
        this.scenario = scenario;
        this.monsterHrids = monsterHrids;
        this.tier = scenario.startTier;
        this.tierStartedAt = 0;
        this.tiers = [];
        this.finished = false;
        this.reason = 'timeout';
    }

    processCombatStartEvent(event) {
        if (event.time === 0 && !this.tiers.length) {
            super.processCombatStartEvent(event);
            return;
        }
        if (this.scenario.resetBetweenTiers) {
            this.eventQueue.clear();
            for (const player of this.players) {
                player.clearBuffs();
                player.clearCCs();
                player.resetCooldowns(event.time);
                player.combatDetails.currentHitpoints = player.combatDetails.maxHitpoints;
                player.combatDetails.currentManapoints = player.combatDetails.maxManapoints;
            }
            this.eventQueue.addEvent(new RegenTickEvent(event.time + 10 * SECOND));
        }
        this.startNewEncounter();
    }

    startNewEncounter() {
        syncEncounterRng(this.encounterIndex++);
        this.tierStartedAt = this.simulationTime;
        this.enemies = this.monsterHrids.map((hrid) => new GuildTrialMonster(hrid, this.tier, this.players.length));
        for (const enemy of this.enemies) {
            enemy.reset(this.simulationTime);
            this.simResult.updateTimeSpentAlive(enemy.hrid, true, this.simulationTime);
        }
        this.enrageBeginTime = this.simulationTime;
        this.eventQueue.clearEventsOfType(EnrageTickEvent.type);
        this.eventQueue.addEvent(new EnrageTickEvent(this.simulationTime + 60 * SECOND, 60 * SECOND));
        this.checkTriggers();
        this.startAttacks();
    }

    /** At most five distinct eligible allies can try to parry an incoming attack. */
    checkParry(targets) {
        if (!targets.some((target) => target?.isPlayer)) return super.checkParry(targets);
        const eligible = targets.filter(
            (p) => p?.combatDetails.currentHitpoints > 0 && p.combatDetails.combatStats.parry > 0
        );
        for (let attempt = 0; attempt < 5 && eligible.length; attempt++) {
            const index = Math.floor(random() * eligible.length);
            const [player] = eligible.splice(index, 1);
            if (random() < player.combatDetails.combatStats.parry) return player;
        }
        return undefined;
    }

    checkTriggers() {
        if (!this.finished) super.checkTriggers();
    }

    checkEncounterEnd() {
        if (this.finished || !this.enemies) return this.finished;
        const allDown = this.players.every((p) => p.combatDetails.currentHitpoints <= 0);
        const cleared = this.enemies.every((m) => m.combatDetails.currentHitpoints <= 0) && !allDown;
        if (!allDown && !cleared) return false;
        this.tiers.push({ tier: this.tier, cleared, seconds: (this.simulationTime - this.tierStartedAt) / SECOND });
        for (const enemy of this.enemies) this.eventQueue.clearEventsForUnit(enemy);
        this.enemies = null;
        if (allDown || this.tier === TRIAL_MAX_TIER) {
            this.finished = true;
            this.reason = allDown ? 'defeat' : 'max-tier';
        } else {
            this.tier++;
            this.eventQueue.addEvent(new CombatStartEvent(this.simulationTime));
        }
        return true;
    }

    /** One whole trial: the time limit never restarts, and defeat ends the attempt. */
    simulateTrial() {
        resetSimWarnings();
        this.reset();
        const limit = this.scenario.seconds * SECOND;
        this.eventQueue.addEvent(new CombatStartEvent(0));
        let ticks = 0;
        while (!this.finished) {
            const event = this.eventQueue.getNextEvent();
            if (!event || event.time > limit) {
                this.simulationTime = limit;
                break;
            }
            this.processEvent(event);
            if (++ticks % 50_000 === 0) this.onProgress(this.simulationTime / limit);
            if (ticks > 2_000_000)
                throw new Error('This roster exceeds the trial event limit. Reduce the time budget.');
        }
        if (!this.finished)
            this.tiers.push({ tier: this.tier, cleared: false, seconds: (limit - this.tierStartedAt) / SECOND });
        return {
            highestTier: this.tiers.filter((row) => row.cleared).at(-1)?.tier ?? this.scenario.startTier - 1,
            seconds: this.simulationTime / SECOND,
            reason: this.reason,
            tiers: this.tiers,
            warnings: getSimWarnings().map((warning) =>
                typeof warning === 'string' ? warning : JSON.stringify(warning)
            ),
        };
    }
}

/** Repeated independent full trials, ready for later roster comparison consumers. */
export function simulateGuildCombat(input, onProgress = () => {}) {
    const scenario = validateTrialScenario(input);
    const gameData = getGameData();
    const trial = gameData?.guildTrialDetailMap?.[scenario.trialHrid];
    const monsterHrids = trial?.monsterHrids;
    if (!monsterHrids?.length || monsterHrids.some((hrid) => !gameData.combatMonsterDetailMap?.[hrid])) {
        throw new Error('The game has not supplied this trial’s boss data.');
    }
    const attempts = [];
    for (let run = 0; run < scenario.runs; run++) {
        seedSimRng((scenario.seed + run * 0x9e3779b9) >>> 0);
        const players = createTrialPlayers(scenario.members, scenario.sharedBuffs, scenario.buildingBuffs);
        const simulator = new GuildCombatSimulator(players, scenario, monsterHrids, (fraction) =>
            onProgress(Math.round(((run + fraction) / scenario.runs) * 100))
        );
        attempts.push(simulator.simulateTrial());
        onProgress(Math.round(((run + 1) / scenario.runs) * 100));
    }
    return summarizeTrialRuns(scenario, attempts);
}
