import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { setGameData } from './game-data.js';
import { TRIAL_GAME_DATA } from './guild-trial-game-data.fixture.js';
import {
    GuildTrialMonster,
    GuildCombatSimulator,
    createTrialPlayers,
    simulateGuildCombat,
} from './guild-combat-simulator.js';
import Monster from './monster.js';
import * as rng from './rng.js';
import { RECORDED_TRIAL_BOSSES } from '../guild-trial-rebalance.fixture.js';
import { validateTrialScenario } from '../guild-trial-model.js';
import CheckBuffExpirationEvent from './events/check-buff-expiration-event.js';
import StunExpirationEvent from './events/stun-expiration-event.js';
import BlindExpirationEvent from './events/blind-expiration-event.js';
import SilenceExpirationEvent from './events/silence-expiration-event.js';

const SECOND = 1e9;

const build = () => ({
    staminaLevel: 100,
    intelligenceLevel: 100,
    attackLevel: 100,
    defenseLevel: 100,
    meleeLevel: 100,
    rangedLevel: 100,
    magicLevel: 100,
    hrid: 'player1',
    equipment: {},
    food: [],
    drinks: [],
    abilities: [],
    houseRooms: {},
    debuffOnLevelGap: 0,
});
const scenario = (overrides = {}) => ({
    kind: 'combat',
    trialHrid: '/guild_combat/badger',
    startTier: 1,
    resetBetweenTiers: true,
    seconds: 60,
    runs: 2,
    seed: 1,
    members: [{ name: 'Test', dto: build() }],
    ...overrides,
});

beforeEach(() => {
    setGameData(TRIAL_GAME_DATA);
    rng.seedSimRng(1);
});
afterEach(() => {
    vi.restoreAllMocks();
    rng.seedSimRng(null);
});

describe('current game trial boss data', () => {
    test('counts signed-up members without usable builds in boss scaling', () => {
        const input = validateTrialScenario(scenario({ participantCount: 2 }));
        const sim = new GuildCombatSimulator(createTrialPlayers(input.members), input, ['/monsters/trial_badger']);
        sim.simulationTime = 0;
        vi.spyOn(sim, 'checkTriggers').mockImplementation(() => {});
        vi.spyOn(sim, 'startAttacks').mockImplementation(() => {});
        sim.startNewEncounter();
        expect(sim.enemies[0].combatDetails.maxHitpoints).toBe(379500 * 1.02);
        expect(sim.enemies[0].combatDetails.combatStats.abilityHaste).toBe(4);
        expect(sim.players).toHaveLength(1);
    });
    test.each(RECORDED_TRIAL_BOSSES)(
        'matches $hrid T$tier with $participants participants on $recordedOn',
        (recorded) => {
            const boss = new GuildTrialMonster(recorded.hrid, recorded.tier, recorded.participants);
            boss.reset(0);
            for (const [key, value] of Object.entries(recorded.combatDetails)) {
                if (key === 'combatStats') {
                    expect(boss.combatDetails.combatStats.abilityHaste).toBe(value.abilityHaste);
                } else if (key === 'attackInterval') {
                    expect(Math.abs(boss.combatDetails.combatStats.attackInterval - value)).toBeLessThanOrEqual(2);
                } else if (key === 'totalCastSpeed') {
                    expect(boss.combatDetails.combatStats.castSpeed).toBeCloseTo(value, 10);
                } else if (key === 'maxHitpoints' || key === 'maxManapoints') {
                    expect(boss.combatDetails[key]).toBe(value);
                } else {
                    expect(boss.combatDetails[key]).toBeCloseTo(value, 8);
                }
            }
            for (const [i, ability] of recorded.combatAbilities.entries()) {
                const simulated = boss.abilities[i];
                expect(simulated.hrid).toBe(ability.abilityHrid);
                expect(simulated.level).toBe(ability.level);
                const cooldown = simulated.cooldownDuration / (1 + 0.01 * boss.combatDetails.combatStats.abilityHaste);
                expect(Math.abs((simulated.lastUsed + cooldown) / 1e9 - ability.availableAfterSeconds)).toBeLessThan(
                    0.002
                );
            }
        }
    );
    test('keeps both Badgers and every Swarm monster', () => {
        expect(TRIAL_GAME_DATA.guildTrialDetailMap['/guild_combat/badger'].monsterHrids).toEqual([
            '/monsters/trial_badger',
            '/monsters/trial_badger',
        ]);
        expect(TRIAL_GAME_DATA.guildTrialDetailMap['/guild_combat/swarm'].monsterHrids).toHaveLength(4);
        for (const detail of Object.values(TRIAL_GAME_DATA.guildTrialDetailMap)) {
            for (const hrid of detail.monsterHrids) {
                const boss = new GuildTrialMonster(hrid, 1, 30);
                boss.reset(0);
                expect(boss.combatDetails.maxHitpoints).toBeGreaterThan(0);
                expect(boss.abilities.filter(Boolean)).toHaveLength(
                    TRIAL_GAME_DATA.combatMonsterDetailMap[hrid].abilities.length
                );
            }
        }
    });
    test('adds participant HP, attack speed, cast speed and haste to the current base sheet', () => {
        const boss = new GuildTrialMonster('/monsters/trial_badger', 1, 30);
        boss.reset(0);
        expect(boss.combatDetails.maxHitpoints).toBe(379500 * 1.3);
        expect(boss.combatDetails.maxManapoints).toBe(379500);
        expect(boss.combatDetails.combatStats.attackInterval).toBeCloseTo(2700000000 / 1.05 / 1.6);
        expect(boss.combatDetails.combatStats.castSpeed).toBeCloseTo(0.65);
        expect(boss.combatDetails.combatStats.abilityHaste).toBe(60);
        boss.updateCombatDetails();
        expect(boss.combatDetails.maxHitpoints).toBe(493350); // does not accumulate
        const ordinary = new Monster('/monsters/trial_badger');
        ordinary.reset(0);
        expect(ordinary.combatDetails.maxHitpoints).toBe(379500);
    });
    test('uses the known HP ladder and scales ability levels with the tier', () => {
        const boss = new GuildTrialMonster('/monsters/trial_badger', 2, 2);
        boss.reset(0);
        expect(boss.combatDetails.maxHitpoints).toBeCloseTo(379500 * (120 / 110) * 1.02, 0);
        expect(boss.abilities[0].level).toBe(44);
    });
});

describe('trial participants and lifecycle', () => {
    test('rejects imported text levels before they inflate combat stats', () => {
        const dto = { ...build(), staminaLevel: '100' };
        expect(() => simulateGuildCombat(scenario({ members: [{ name: 'Imported', dto }] }))).toThrow(
            'stamina level must be a numeric value'
        );
    });
    test.each(['guildCombatBuffs', 'achievementCombatBuffs'])(
        'normalizes imported %s before folding player stats without mutating the build',
        (key) => {
            const dto = {
                ...build(),
                [key]: [{ typeHrid: '/buff_types/max_hitpoints', flatBoost: '0', ratioBoost: '0.1' }],
            };
            const before = structuredClone(dto);
            // Both the worker and the setup importer use scenario validation.
            const input = validateTrialScenario(scenario({ members: [{ name: 'Imported', dto }] }));
            const [player] = createTrialPlayers(input.members);
            player.generatePermanentBuffs();
            player.reset(0);
            expect(player.combatDetails.maxHitpoints).toBe(1210);
            expect(dto).toEqual(before);
        }
    );
    test('keeps net progress across the whole boss roster when defeat ends a tier', () => {
        const players = createTrialPlayers(scenario().members);
        const sim = new GuildCombatSimulator(players, scenario(), ['/monsters/trial_badger', '/monsters/trial_badger']);
        sim.simulationTime = 5e9;
        sim.enemies = [
            { combatDetails: { currentHitpoints: 0, maxHitpoints: 100 } },
            { combatDetails: { currentHitpoints: 50, maxHitpoints: 100 } },
        ];
        players[0].combatDetails.currentHitpoints = 0;
        sim.checkEncounterEnd();
        expect(sim.tiers[0].progressFraction).toBe(0.75);
    });
    test('keeps remaining boss HP when the time budget expires', () => {
        const players = createTrialPlayers(scenario().members);
        const sim = new GuildCombatSimulator(players, scenario({ seconds: 1 }), ['/monsters/trial_badger']);
        vi.spyOn(sim, 'processEvent').mockImplementation(() => {
            sim.enemies = [{ combatDetails: { currentHitpoints: 75, maxHitpoints: 100 } }];
        });
        expect(sim.simulateTrial().tiers[0].progressFraction).toBe(0.25);
    });
    test('removes consumables, scrolls and level penalties without changing the build', () => {
        const dto = {
            ...build(),
            food: [{ hrid: '/items/donut' }],
            drinks: [{ hrid: '/items/coffee' }],
            scrollBuffs: ['/buff_types/armor'],
            debuffOnLevelGap: 2,
        };
        const before = structuredClone(dto);
        const [player] = createTrialPlayers(
            [{ dto }],
            [],
            [{ typeHrid: '/buff_types/ability_haste', flatBoost: 10, ratioBoost: 0 }]
        );
        player.generatePermanentBuffs();
        player.reset(0);
        expect(player.food).toEqual([]);
        expect(player.drinks).toEqual([]);
        expect(player.debuffOnLevelGap).toBe(0);
        expect(player.combatDetails.combatStats.hpRegenPer10).toBeCloseTo(0.04);
        expect(player.combatDetails.combatStats.mpRegenPer10).toBeCloseTo(0.04);
        expect(player.combatDetails.combatStats.abilityHaste).toBe(10);
        player.updateCombatDetails();
        expect(player.combatDetails.combatStats.abilityHaste).toBe(10);
        expect(dto).toEqual(before);
    });
    test('revives a downed player and restores lost timed statuses in carry mode', () => {
        const combatBuild = () => ({
            ...build(),
            abilities: [{ hrid: '/abilities/precision', level: 1 }],
        });
        const members = [
            { name: 'Downed', dto: combatBuild() },
            { name: 'Survivor', dto: combatBuild() },
        ];
        const players = createTrialPlayers(members);
        for (const player of players) {
            player.generatePermanentBuffs();
            player.reset(0);
        }
        const [downed, survivor] = players;
        const now = 30 * SECOND;
        const stunAt = now + SECOND;
        const blindAt = now + 2 * SECOND;
        const silenceAt = now + 3 * SECOND;
        const carryBuff = {
            uniqueHrid: '/buff_uniques/carry_state_test',
            typeHrid: '/buff_types/attack_speed',
            flatBoost: 0,
            flatBoostLevelBonus: 0,
            ratioBoost: 0.1,
            ratioBoostLevelBonus: 0,
            duration: 20 * SECOND,
        };
        survivor.addBuff(carryBuff, 25 * SECOND);
        survivor.abilities[0].lastUsed = 12 * SECOND;
        downed.combatDetails.currentHitpoints = 0;
        downed.combatDetails.currentManapoints = 0;
        downed.isStunned = true;
        downed.stunExpireTime = stunAt;
        downed.isBlinded = true;
        downed.blindExpireTime = blindAt;
        downed.isSilenced = true;
        downed.silenceExpireTime = silenceAt;
        survivor.combatDetails.currentHitpoints = 500;
        survivor.combatDetails.currentManapoints = 400;
        const sim = new GuildCombatSimulator(players, scenario({ resetBetweenTiers: false }), [
            '/monsters/trial_badger',
        ]);
        sim.tiers.push({ tier: 1, cleared: true, seconds: 30, progressFraction: 1 });
        sim.simulationTime = now;
        const lostEvents = [
            new StunExpirationEvent(stunAt, downed),
            new BlindExpirationEvent(blindAt, downed),
            new SilenceExpirationEvent(silenceAt, downed),
            new CheckBuffExpirationEvent(45 * SECOND, downed),
        ];
        for (const event of lostEvents) sim.eventQueue.addEvent(event);

        // A real death clears every queued event that names the player.
        sim.eventQueue.clearEventsForUnit(downed);
        expect(lostEvents.every((event) => !sim.eventQueue.getMatching((queued) => queued === event))).toBe(true);

        sim.processCombatStartEvent({ time: sim.simulationTime });

        expect(downed.combatDetails.currentHitpoints).toBe(downed.combatDetails.maxHitpoints);
        expect(downed.combatDetails.currentManapoints).toBe(downed.combatDetails.maxManapoints);
        expect(survivor.combatDetails.currentHitpoints).toBe(500);
        expect(survivor.combatDetails.currentManapoints).toBe(400);
        expect(survivor.abilities[0].lastUsed).toBe(12 * SECOND);
        expect(survivor.combatBuffs['/buff_uniques/carry_state_test']).toBeDefined();
        expect(downed.isStunned).toBe(true);
        expect(downed.isBlinded).toBe(true);
        expect(downed.isSilenced).toBe(true);
        for (const [type, time] of [
            [StunExpirationEvent.type, stunAt],
            [BlindExpirationEvent.type, blindAt],
            [SilenceExpirationEvent.type, silenceAt],
        ]) {
            expect(sim.eventQueue.getMatching((event) => event.type === type && event.source === downed)?.time).toBe(
                time
            );
        }
        expect(
            sim.eventQueue.getMatching((event) => event.type === 'autoAttack' && event.source === downed)
        ).toBeNull();

        while (downed.isStunned) {
            const event = sim.eventQueue.getNextEvent();
            expect(event).toBeTruthy();
            sim.processEvent(event);
        }
        expect(downed.isStunned).toBe(false);
        expect(
            sim.eventQueue.getMatching((event) => event.type === 'autoAttack' && event.source === downed)
        ).toBeNull();

        while (downed.isBlinded) {
            const event = sim.eventQueue.getNextEvent();
            expect(event).toBeTruthy();
            sim.processEvent(event);
        }
        expect(downed.isBlinded).toBe(false);
        while (downed.isSilenced) {
            const event = sim.eventQueue.getNextEvent();
            expect(event).toBeTruthy();
            sim.processEvent(event);
        }
        expect(downed.isSilenced).toBe(false);

        for (let events = 0; !sim.simResult.attacks[downed.hrid] && events < 100; events++) {
            const event = sim.eventQueue.getNextEvent();
            expect(event).toBeTruthy();
            sim.processEvent(event);
        }
        expect(sim.simResult.attacks[downed.hrid]).toBeDefined();
        const nextCast = sim.eventQueue.getMatching(
            (event) => event.type === 'abilityCastEndEvent' && event.source === downed
        );
        expect(nextCast).toBeTruthy();
        for (let events = 0; !downed.combatBuffs['/buff_uniques/precision'] && events < 100; events++) {
            const event = sim.eventQueue.getNextEvent();
            expect(event).toBeTruthy();
            sim.processEvent(event);
        }
        expect(downed.combatBuffs['/buff_uniques/precision']).toBeDefined();
    });
    test('fills a revived player after expired maximum-pool buffs are removed', () => {
        const [downed] = createTrialPlayers([{ name: 'Downed', dto: build() }]);
        downed.generatePermanentBuffs();
        downed.reset(0);
        const baseMaxHp = downed.combatDetails.maxHitpoints;
        const baseMaxMp = downed.combatDetails.maxManapoints;
        const expiration = 29 * SECOND;
        downed.addBuff(
            {
                uniqueHrid: '/buff_uniques/expired_max_hp_test',
                typeHrid: '/buff_types/max_hitpoints',
                flatBoost: 0,
                flatBoostLevelBonus: 0,
                ratioBoost: 0.5,
                ratioBoostLevelBonus: 0,
                duration: expiration,
            },
            0
        );
        downed.addBuff(
            {
                uniqueHrid: '/buff_uniques/expired_max_mp_test',
                typeHrid: '/buff_types/max_manapoints',
                flatBoost: 0,
                flatBoostLevelBonus: 0,
                ratioBoost: 0.5,
                ratioBoostLevelBonus: 0,
                duration: expiration,
            },
            0
        );
        downed.combatDetails.currentHitpoints = 0;
        downed.combatDetails.currentManapoints = 0;
        const sim = new GuildCombatSimulator([downed], scenario({ resetBetweenTiers: false }), [
            '/monsters/trial_badger',
        ]);
        sim.tiers.push({ tier: 1, cleared: true, seconds: 30, progressFraction: 1 });
        sim.simulationTime = 30 * SECOND;
        const lostBuffExpiry = new CheckBuffExpirationEvent(expiration, downed);
        sim.eventQueue.addEvent(lostBuffExpiry);
        sim.eventQueue.clearEventsForUnit(downed);
        expect(sim.eventQueue.getMatching((event) => event === lostBuffExpiry)).toBeNull();

        sim.processCombatStartEvent({ time: sim.simulationTime });

        expect(downed.combatDetails.maxHitpoints).toBe(baseMaxHp);
        expect(downed.combatDetails.maxManapoints).toBe(baseMaxMp);
        expect(downed.combatDetails.currentHitpoints).toBe(baseMaxHp);
        expect(downed.combatDetails.currentManapoints).toBe(baseMaxMp);
        expect(downed.combatBuffs['/buff_uniques/expired_max_hp_test']).toBeUndefined();
        expect(downed.combatBuffs['/buff_uniques/expired_max_mp_test']).toBeUndefined();
    });
    test('clears downed-player CC flags whose stored deadlines passed before the next tier', () => {
        const [downed] = createTrialPlayers([{ name: 'Downed', dto: build() }]);
        downed.generatePermanentBuffs();
        downed.reset(0);
        downed.combatDetails.currentHitpoints = 0;
        downed.isStunned = true;
        downed.stunExpireTime = 29 * SECOND;
        downed.isBlinded = true;
        downed.blindExpireTime = 29 * SECOND;
        downed.isSilenced = true;
        downed.silenceExpireTime = 29 * SECOND;
        const sim = new GuildCombatSimulator([downed], scenario({ resetBetweenTiers: false }), [
            '/monsters/trial_badger',
        ]);
        sim.tiers.push({ tier: 1, cleared: true, seconds: 30, progressFraction: 1 });
        sim.simulationTime = 30 * SECOND;
        for (const EventClass of [StunExpirationEvent, BlindExpirationEvent, SilenceExpirationEvent]) {
            sim.eventQueue.addEvent(new EventClass(29 * SECOND, downed));
        }
        sim.eventQueue.clearEventsForUnit(downed);

        sim.processCombatStartEvent({ time: sim.simulationTime });

        expect(downed.isStunned).toBe(false);
        expect(downed.stunExpireTime).toBeNull();
        expect(downed.isBlinded).toBe(false);
        expect(downed.blindExpireTime).toBeNull();
        expect(downed.isSilenced).toBe(false);
        expect(downed.silenceExpireTime).toBeNull();
    });
    test('ends on defeat and does not respawn or start a later tier', () => {
        const players = createTrialPlayers(scenario().members);
        const sim = new GuildCombatSimulator(players, scenario(), ['/monsters/trial_badger']);
        sim.simulationTime = 5e9;
        sim.enemies = [{ combatDetails: { currentHitpoints: 100 } }];
        players[0].combatDetails.currentHitpoints = 0;
        expect(sim.checkEncounterEnd()).toBe(true);
        expect(sim.reason).toBe('defeat');
        expect(sim.eventQueue.getNextEvent()).toBeUndefined();
        expect(sim.tiers[0].cleared).toBe(false);
    });
    test('a mutual killing blow is a defeat, recorded once', () => {
        const players = createTrialPlayers(scenario().members);
        const sim = new GuildCombatSimulator(players, scenario(), ['/monsters/trial_badger']);
        sim.enemies = [{ combatDetails: { currentHitpoints: 0 } }];
        players[0].combatDetails.currentHitpoints = 0;
        sim.checkEncounterEnd();
        sim.checkEncounterEnd();
        expect(sim.tiers).toHaveLength(1);
        expect(sim.reason).toBe('defeat');
    });
    test('tries at most five distinct eligible parries and excludes downed units', () => {
        const sim = new GuildCombatSimulator([], scenario(), []);
        const targets = Array.from({ length: 6 }, () => ({
            isPlayer: true,
            combatDetails: { currentHitpoints: 100, combatStats: { parry: 0.5 } },
        }));
        const draw = vi.spyOn(rng, 'random').mockReturnValue(0.9);
        expect(sim.checkParry(targets)).toBeUndefined();
        expect(draw).toHaveBeenCalledTimes(10);
        draw.mockClear();
        targets[0].combatDetails.currentHitpoints = 0;
        expect(sim.checkParry(targets)).toBeUndefined();
        expect(draw).toHaveBeenCalledTimes(10);
        draw.mockReturnValue(0);
        expect(sim.checkParry(targets)).toBe(targets[1]);
    });
    test('runs the real boss ability definitions reproducibly with no input mutations', () => {
        const input = scenario();
        const before = structuredClone(input);
        const result = simulateGuildCombat(input);
        expect(result).toEqual(simulateGuildCombat(input));
        expect(input).toEqual(before);
        expect(result.outcomes.defeat).toBe(2);
        expect(result.meanHighestTier).toBe(0);
        expect(result.meanSeconds).toBeLessThan(60);
        expect(result.tiers[1].reachChance).toBe(0);
    });
    test('an unknown boss fails explicitly', () => {
        expect(() => simulateGuildCombat(scenario({ trialHrid: '/guild_combat/missing' }))).toThrow('boss data');
    });
});
