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
