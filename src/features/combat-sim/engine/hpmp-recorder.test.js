/**
 * The HP/MP recording behind the results charts: bounded in size, the pre-wipe
 * window ends at the wipe and covers ~30 s, and only dungeons keep it.
 */

import { describe, test, expect, afterEach } from 'vitest';
import CombatSimulator from './combat-simulator.js';
import HpMpRecorder, { MAX_POINTS, MAX_WIPE_SAMPLE_SETS } from './hpmp-recorder.js';
import { getGameData, setGameData } from './game-data.js';
import Player from './player.js';
import { clearSimRng, seedSimRng } from './rng.js';
import Zone from './zone.js';

const ONE_SECOND = 1e9;

const ZONE_HRID = '/actions/combat/golden_meadow';
const RAT_HRID = '/monsters/golden_rat';
const TOAD_HRID = '/monsters/golden_toad';

/**
 * A monster the engine can fight without any ability or consumable machinery:
 * an unarmed smash attacker, like the fixture player.
 * @param {Object} levels - The seven base levels
 * @param {number} experience - Experience the monster is worth
 * @returns {Object} combatMonsterDetailMap entry
 */
function monster(levels, experience) {
    return {
        experience,
        // Enrage never fires inside these short fights, but the enrage-based
        // XP-rate arithmetic divides by it, so it must be a real duration
        enrageTime: 300 * ONE_SECOND,
        abilities: [],
        combatDetails: {
            ...levels,
            attackInterval: 3500000000,
            combatStats: {
                combatStyleHrids: ['/combat_styles/smash'],
                damageType: '/damage_types/physical',
                // Zero on purpose: the engine falls back to the
                // combatDetails.attackInterval above, as it does for the
                // game's own monsters
                attackInterval: 0,
            },
        },
    };
}

/** The minimal game data the loop reads: one zone, two monsters, one combat style. */
function installGameData() {
    setGameData({
        actionDetailMap: {
            [ZONE_HRID]: {
                buffs: null,
                combatZoneInfo: {
                    isDungeon: false,
                    dungeonInfo: null,
                    fightInfo: {
                        bossSpawns: null,
                        randomSpawnInfo: {
                            maxSpawnCount: 2,
                            maxTotalStrength: 2,
                            spawns: [
                                { combatMonsterHrid: RAT_HRID, difficultyTier: 0, rate: 2, strength: 1 },
                                { combatMonsterHrid: TOAD_HRID, difficultyTier: 0, rate: 1, strength: 1 },
                            ],
                        },
                    },
                },
            },
        },
        combatMonsterDetailMap: {
            [RAT_HRID]: monster(
                {
                    staminaLevel: 10,
                    intelligenceLevel: 5,
                    attackLevel: 40,
                    meleeLevel: 40,
                    defenseLevel: 30,
                    rangedLevel: 1,
                    magicLevel: 1,
                },
                60
            ),
            [TOAD_HRID]: monster(
                {
                    staminaLevel: 20,
                    intelligenceLevel: 5,
                    attackLevel: 55,
                    meleeLevel: 55,
                    defenseLevel: 40,
                    rangedLevel: 1,
                    magicLevel: 1,
                },
                110
            ),
        },
        combatStyleDetailMap: {
            '/combat_styles/smash': {
                skillExpMap: { '/skills/attack': 1, '/skills/melee': 1 },
            },
        },
    });
}

/**
 * An unarmed, unfed, ability-less player: every swing goes through the full
 * attack pipeline (accuracy, damage roll, threat, XP split) with none of the
 * equipment or consumable machinery in the way.
 * @returns {Player}
 */
function fixturePlayer() {
    const player = Player.createFromDTO({
        hrid: 'player1',
        staminaLevel: 70,
        intelligenceLevel: 40,
        attackLevel: 70,
        meleeLevel: 70,
        defenseLevel: 60,
        rangedLevel: 1,
        magicLevel: 1,
        equipment: {},
        food: [null, null, null],
        drinks: [null, null, null],
        abilities: [null, null, null, null],
        houseRooms: {},
        debuffOnLevelGap: 0,
    });
    return player;
}

const DUNGEON_HRID = '/actions/combat/golden_crypt';
function installDungeon() {
    installGameData();
    getGameData().actionDetailMap[DUNGEON_HRID] = {
        buffs: null,
        combatZoneInfo: {
            isDungeon: true,
            fightInfo: { bossSpawns: null },
            dungeonInfo: {
                maxWaves: 2,
                fixedSpawnsMap: {
                    1: [{ combatMonsterHrid: RAT_HRID, difficultyTier: 0 }],
                    2: [{ combatMonsterHrid: TOAD_HRID, difficultyTier: 0 }],
                },
                randomSpawnInfoMap: null,
            },
        },
    };
}

function party(count, zoneHrid) {
    const zone = new Zone(zoneHrid, 0);
    const players = Array.from({ length: count }, (_, i) => {
        const p = fixturePlayer();
        p.hrid = 'player' + (i + 1);
        p.zoneBuffs = zone.buffs;
        p.extraBuffs = [];
        return p;
    });
    return { zone, players };
}

/** Players that need no game data: the recorder only reads combatDetails. */
function fakePlayers(count) {
    return Array.from({ length: count }, (_, i) => ({
        hrid: 'player' + (i + 1),
        combatDetails: { currentHitpoints: 100, maxHitpoints: 100, currentManapoints: 50, maxManapoints: 100 },
    }));
}

afterEach(() => {
    clearSimRng();
    setGameData(null);
});

describe('HpMpRecorder', () => {
    test('a ten-hour run never exceeds the point cap, and merged buckets keep the average', () => {
        const players = fakePlayers(5);
        const rec = new HpMpRecorder(players, { preWipe: true });
        const end = 10 * 3600 * ONE_SECOND;
        for (let t = 0; t <= end; t += 0.5 * ONE_SECOND) {
            players[0].combatDetails.currentHitpoints = t < end / 2 ? 100 : 0;
            rec.sample(t);
        }
        const series = rec.toSeries(end);
        expect(series.hp[0].length).toBeLessThanOrEqual(MAX_POINTS);
        expect(series.hp[0].length).toBeGreaterThan(MAX_POINTS / 2 - 1);
        expect(series.stepSeconds).toBeGreaterThan(60);
        expect(series.hp[0][0]).toBe(100);
        expect(series.hp[0][series.hp[0].length - 1]).toBe(0);
        expect(series.mp[1].every((v) => v === 50)).toBe(true);
        // The ring is a fixed size however long the run
        expect(rec.ringTimes.length).toBeLessThan(70);
        expect(JSON.stringify(series).length).toBeLessThan(60000);
    });

    test('the pre-wipe window covers about 30 s and ends at the wipe', () => {
        const players = fakePlayers(2);
        const rec = new HpMpRecorder(players, { preWipe: true });
        for (let t = 0; t <= 100 * ONE_SECOND; t += 0.5 * ONE_SECOND) rec.sample(t);
        players.forEach((p) => (p.combatDetails.currentHitpoints = 0));
        const out = rec.takePreWipe(100.2 * ONE_SECOND);

        expect(out.playerHrids).toEqual(['player1', 'player2']);
        expect(out.secondsBefore[out.secondsBefore.length - 1]).toBe(0);
        expect(out.secondsBefore[0]).toBeGreaterThan(29);
        expect(out.secondsBefore[0]).toBeLessThanOrEqual(30);
        expect(out.secondsBefore.length).toBeLessThanOrEqual(62);
        expect(out.secondsBefore).toEqual([...out.secondsBefore].sort((a, b) => b - a));
        expect(out.hp.map((line) => line[line.length - 1])).toEqual([0, 0]);
        expect(out.hp[0]).toHaveLength(out.secondsBefore.length);
        expect(out.mp[0]).toHaveLength(out.secondsBefore.length);
    });

    test('a wipe right after the last one does not reach back into it', () => {
        const players = fakePlayers(1);
        const rec = new HpMpRecorder(players, { preWipe: true });
        for (let t = 0; t <= 20 * ONE_SECOND; t += 0.5 * ONE_SECOND) rec.sample(t);
        rec.takePreWipe(20 * ONE_SECOND);
        rec.clearPreWipe();
        rec.sample(25 * ONE_SECOND);
        const out = rec.takePreWipe(26 * ONE_SECOND);
        expect(out.secondsBefore[0]).toBe(1);
    });

    test('only the first MAX_WIPE_SAMPLE_SETS wipes carry samples', () => {
        const rec = new HpMpRecorder(fakePlayers(1), { preWipe: true });
        let taken = 0;
        for (let i = 0; i < MAX_WIPE_SAMPLE_SETS + 10; i++) {
            if (rec.takePreWipe((i + 1) * ONE_SECOND)) taken++;
        }
        expect(taken).toBe(MAX_WIPE_SAMPLE_SETS);
    });

    test('a recorder outside a dungeon keeps no ring', () => {
        const rec = new HpMpRecorder(fakePlayers(1), { preWipe: false });
        for (let t = 0; t < 60 * ONE_SECOND; t += 5 * ONE_SECOND) rec.sample(t);
        expect(rec.takePreWipe(60 * ONE_SECOND)).toBeNull();
        expect(rec.toSeries(60 * ONE_SECOND)).not.toBeNull();
    });

    test('time under 10% MP is weighted by time; a player with no mana pool has none', () => {
        const players = fakePlayers(2);
        players[1].combatDetails.maxManapoints = 0;
        const rec = new HpMpRecorder(players, { preWipe: false });
        players[0].combatDetails.currentManapoints = 5;
        rec.sample(0);
        rec.sample(30 * ONE_SECOND);
        players[0].combatDetails.currentManapoints = 80;
        rec.sample(35 * ONE_SECOND);
        const series = rec.toSeries(100 * ONE_SECOND);
        // Held values: 0-35 s at 5%, 35-100 s at 80%
        expect(series.lowMpShare[0]).toBeCloseTo(0.35, 5);
        expect(series.lowMpShare[1]).toBeNull();
        expect(series.hasMp).toEqual([true, false]);
    });

    test('an interval that crosses a bucket boundary is split between the buckets', () => {
        const players = fakePlayers(1);
        const recorder = new HpMpRecorder(players);
        const mp = (value) => {
            players[0].combatDetails.currentManapoints = value;
        };
        mp(0);
        recorder.sample(0);
        recorder.sample(55 * ONE_SECOND);
        mp(100);
        recorder.sample(65 * ONE_SECOND);
        const series = recorder.toSeries(120 * ONE_SECOND);
        // Second minute: 5 s at 0% then 55 s at 100%
        expect(series.mp[0]).toEqual([0, 91.7]);
    });

    test('run starts are capped', () => {
        const rec = new HpMpRecorder(fakePlayers(1), { preWipe: true });
        for (let i = 0; i < 1000; i++) rec.markRunStart(i * ONE_SECOND);
        rec.sample(0);
        rec.sample(ONE_SECOND);
        expect(rec.toSeries(2 * ONE_SECOND).runStarts.length).toBeLessThanOrEqual(240);
    });
});

describe('the simulator records HP and MP', () => {
    test('a long party dungeon stays under the point cap and a small payload', () => {
        installDungeon();
        seedSimRng(5);
        const { zone, players } = party(5, DUNGEON_HRID);
        const result = new CombatSimulator(players, zone).simulate(10 * 3600 * ONE_SECOND);

        expect(result.hpMpSeries.playerHrids).toHaveLength(5);
        expect(result.hpMpSeries.hp[0].length).toBeLessThanOrEqual(MAX_POINTS);
        expect(result.hpMpSeries.mp[4].length).toBe(result.hpMpSeries.hp[0].length);
        expect(result.hpMpSeries.runStarts.length).toBeGreaterThan(0);
        expect(JSON.stringify(result.hpMpSeries).length).toBeLessThan(40000);
        // Clean clears: no wipe, so no pre-wipe sample set anywhere
        expect(result.wipeEvents).toEqual([]);
    });

    test('a wipe in a dungeon saves the last 30 s with its event', () => {
        installDungeon();
        seedSimRng(3);
        const { zone, players } = party(2, DUNGEON_HRID);
        const sim = new CombatSimulator(players, zone);
        sim.reset();
        sim.simulationTime = 10 * ONE_SECOND;
        players.forEach((p) => p.reset(sim.simulationTime));
        sim.enemies = zone.getNextWave();
        sim.enemies.forEach((enemy) => enemy.reset(sim.simulationTime));
        sim.simResult.updateTimeSpentAlive('#' + (zone.encountersKilled - 1).toString(), true, sim.simulationTime);
        for (let t = 10; t < 50; t += 0.5) {
            sim.simulationTime = t * ONE_SECOND;
            if (sim.simulationTime >= sim.hpMpRecorder.nextSampleTime) sim.hpMpRecorder.sample(sim.simulationTime);
        }
        sim.simulationTime = 50 * ONE_SECOND;
        players.forEach((p) => (p.combatDetails.currentHitpoints = 0));
        sim.checkEncounterEnd();

        expect(sim.simResult.wipeEvents).toHaveLength(1);
        const hpMp = sim.simResult.wipeEvents[0].hpMp;
        expect(hpMp.playerHrids).toEqual(['player1', 'player2']);
        expect(hpMp.secondsBefore[hpMp.secondsBefore.length - 1]).toBe(0);
        expect(hpMp.secondsBefore[0]).toBeGreaterThan(29);
        expect(hpMp.hp[0][hpMp.hp[0].length - 1]).toBe(0);
        expect(hpMp.hp[0][0]).toBeGreaterThan(0);
    });

    test('outside a dungeon there is no pre-wipe ring and no wipe sample, but a run series', () => {
        installGameData();
        seedSimRng(2);
        const { zone, players } = party(1, ZONE_HRID);
        const sim = new CombatSimulator(players, zone);
        const result = sim.simulate(3600 * ONE_SECOND);

        expect(sim.hpMpRecorder.preWipe).toBe(false);
        expect(sim.hpMpRecorder.takePreWipe(1)).toBeNull();
        expect(result.hpMpSeries.hp[0].length).toBeGreaterThan(30);
        expect(result.wipeEvents).toEqual([]);
        sim.saveWipeLogsToSimResult(0);
        expect(sim.simResult.wipeEvents[0].hpMp).toBeUndefined();
    });
});
