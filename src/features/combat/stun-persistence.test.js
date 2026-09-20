/**
 * The whole point of this measurement is that it can be wrong in a way that
 * flatters the model this project already ships: units are only sent when
 * something about them changes, so a stun that nobody reports the end of looks
 * like a stun that lasted. So the tests are mostly about what gets *thrown
 * away* — an episode that qualifies when it should not is worth more damage
 * here than one that is missed.
 *
 * Synthetic ticks rather than a recording for the logic, because no recording
 * contains a monster dying mid-stun on cue. One real recording is driven
 * through the parser at the end to prove it survives real payload shapes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    createStunWatch,
    emptyTally,
    foldEpisode,
    summarize,
    stunSecondsOfAbility,
    monsterStunProfile,
    bracketBucket,
    medianBracket,
    median,
    verdictFor,
    MIN_EPISODES,
    MAX_AUDIT_EPISODES,
    DIRECTIONS,
} from './stun-persistence.js';
import { wilsonInterval } from '../combat-sim/engine/wilson.js';

const STUN_ABILITY = '/abilities/stunning_blow';
const PLAYER_STUN = '/abilities/smack';

/** Game data with two stunning golems, one filler, and one stunning player ability */
const CLIENT_DATA = {
    abilityDetailMap: {
        [STUN_ABILITY]: {
            abilityEffects: [{ stunChance: 0.7, stunDuration: 3e9 }],
        },
        [PLAYER_STUN]: {
            abilityEffects: [{ stunChance: 0.2, stunDuration: 2e9 }],
        },
        '/abilities/plain_hit': {
            // A duration with no chance is not a stunner, and must not be read
            // as one
            abilityEffects: [{ stunChance: 0, stunDuration: 5e9 }],
        },
    },
    combatMonsterDetailMap: {
        '/monsters/magnetic_golem': { abilities: [{ abilityHrid: STUN_ABILITY }] },
        '/monsters/granite_golem': { abilities: [{ abilityHrid: STUN_ABILITY }] },
        '/monsters/stalactite_golem': { abilities: [{ abilityHrid: '/abilities/plain_hit' }] },
    },
};

/**
 * A player-slot snapshot.
 * @param {Object} fields - Overrides
 * @returns {Object} Entry
 */
function player(fields = {}) {
    return { cHP: 100, mHP: 100, cMP: 50, mMP: 50, isActive: true, dmgCounter: 0, ...fields };
}

/**
 * A monster-slot snapshot.
 * @param {Object} fields - Overrides
 * @returns {Object} Entry
 */
function monster(fields = {}) {
    return { cHP: 100, mHP: 100, isActive: true, dmgCounter: 0, ...fields };
}

/**
 * Drive a watch through a wave and hand back everything it finished.
 * @param {Array<Object>} monsters - `new_battle` monsters
 * @param {Array<Object>} ticks - `battle_updated` payloads, one per 200 ms
 * @param {Object} [options] - `{ players, trailingBattle }`
 * @returns {Array<Object>} Judged episodes
 */
function run(monsters, ticks, { players = [{ name: 'P' }], trailingBattle = false } = {}) {
    const watch = createStunWatch({ clientData: CLIENT_DATA });
    let now = 1_000_000;
    watch.newBattle({ monsters, players }, now);
    for (const tick of ticks) {
        now += 200;
        watch.battleUpdated(tick, now);
    }
    if (trailingBattle) watch.newBattle({ monsters, players }, now + 200);
    return watch.drain();
}

const ONE_STUNNER = [{ hrid: '/monsters/magnetic_golem' }, { hrid: '/monsters/stalactite_golem' }];
const TWO_STUNNERS = [{ hrid: '/monsters/magnetic_golem' }, { hrid: '/monsters/granite_golem' }];

describe('reading stun abilities out of game data', () => {
    it('reports a stunning ability in seconds, from nanoseconds', () => {
        expect(stunSecondsOfAbility(STUN_ABILITY, CLIENT_DATA.abilityDetailMap)).toBe(3);
    });

    it('does not call an ability a stunner when its stun chance is zero', () => {
        expect(stunSecondsOfAbility('/abilities/plain_hit', CLIENT_DATA.abilityDetailMap)).toBeNull();
    });

    it('reads a monster through its ability list', () => {
        expect(monsterStunProfile('/monsters/granite_golem', CLIENT_DATA)).toEqual({
            stuns: true,
            unknown: false,
            seconds: 3,
        });
        expect(monsterStunProfile('/monsters/stalactite_golem', CLIENT_DATA).stuns).toBe(false);
    });

    it('treats a monster it has never heard of as a possible stunner', () => {
        // The dangerous direction is the other one: an unrecognised monster that
        // silently could not stun would let an ambiguous wave through
        expect(monsterStunProfile('/monsters/who', CLIENT_DATA)).toEqual({
            stuns: true,
            unknown: true,
            seconds: null,
        });
    });
});

describe('a stun that outlives its caster', () => {
    const episodes = run(ONE_STUNNER, [
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster(), 1: monster() } },
        // The golem dies here, tick 2
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster({ cHP: 0, isActive: false }), 1: monster() } },
        // Still flagged two ticks later, which nothing but persistence explains
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 1: monster() } },
        { pMap: { 0: player() }, mMap: { 1: monster() } },
    ]);

    it('qualifies', () => {
        expect(episodes).toHaveLength(1);
        expect(episodes[0].discard).toBeNull();
        expect(episodes[0].qualifies).toBe(true);
    });

    it('counts it toward persistence', () => {
        expect(episodes[0].outlivedCaster).toBe(true);
        expect(episodes[0].postDeathSeconds).toBeCloseTo(0.2, 5);
    });

    it('reports a tight end bracket', () => {
        expect(episodes[0].bracketSeconds).toBeCloseTo(0.2, 5);
    });

    it('files it under the monster-caster direction', () => {
        expect(episodes[0].direction).toBe(DIRECTIONS.monsterCaster);
    });
});

describe('a stun that ends exactly at its caster’s death', () => {
    // The cleanest possible observation of a cancel-on-death rule: the death
    // and the missing flag arrive in the same payload
    const episodes = run(ONE_STUNNER, [
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster(), 1: monster() } },
        { pMap: { 0: player() }, mMap: { 0: monster({ cHP: 0, isActive: false }), 1: monster() } },
        { pMap: { 0: player() }, mMap: { 1: monster() } },
    ]);

    it('is kept rather than thrown away', () => {
        expect(episodes[0].qualifies).toBe(true);
    });

    it('counts against persistence', () => {
        expect(episodes[0].outlivedCaster).toBe(false);
        expect(episodes[0].postDeathSeconds).toBe(0);
    });
});

describe('a wave with two stunners', () => {
    const episodes = run(TWO_STUNNERS, [
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster(), 1: monster() } },
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster({ cHP: 0, isActive: false }), 1: monster() } },
        { pMap: { 0: player() }, mMap: { 1: monster() } },
    ]);

    it('is discarded rather than attributed to a guess', () => {
        expect(episodes[0].qualifies).toBe(false);
        expect(episodes[0].discard).toBe('ambiguousCaster');
    });
});

describe('a caster that was the last thing alive', () => {
    const episodes = run(
        [{ hrid: '/monsters/magnetic_golem' }],
        [
            { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster() } },
            { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster({ cHP: 0, isActive: false }) } },
        ],
        { trailingBattle: true }
    );

    it('is discarded, because the evidence stops with the wave', () => {
        expect(episodes[0].discard).toBe('waveEnded');
    });
});

describe('a stun still running when the next wave starts', () => {
    const episodes = run(
        ONE_STUNNER,
        [
            { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster(), 1: monster() } },
            {
                pMap: { 0: player({ isStunned: true }) },
                mMap: { 0: monster({ cHP: 0, isActive: false }), 1: monster() },
            },
            { pMap: { 0: player({ isStunned: true }) }, mMap: { 1: monster() } },
        ],
        { trailingBattle: true }
    );

    it('is discarded even though it looks like the strongest evidence there is', () => {
        expect(episodes[0].discard).toBe('waveEnded');
    });
});

describe('another stunner landing a hit after the caster died', () => {
    // The roster names one stunner, but a third slot the wave never declared
    // turns up mid-fight and hits. An unknown unit has to count as a possible
    // re-stunner
    const watch = createStunWatch({ clientData: CLIENT_DATA });
    let now = 2_000_000;
    watch.newBattle({ monsters: ONE_STUNNER, players: [{ name: 'P' }] }, now);
    const ticks = [
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster(), 1: monster() } },
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster({ cHP: 0, isActive: false }), 1: monster() } },
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 2: monster({ dmgCounter: 0 }) } },
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 2: monster({ dmgCounter: 7 }) } },
        { pMap: { 0: player() }, mMap: { 2: monster({ dmgCounter: 7 }) } },
    ];
    for (const tick of ticks) {
        now += 200;
        watch.battleUpdated(tick, now);
    }
    const episodes = watch.drain();

    it('is discarded as a possible re-stun', () => {
        expect(episodes[0].discard).toBe('possibleRestun');
    });
});

describe('a caster that outlived the stun it cast', () => {
    // A 3 s stun; the golem dies 3.6 s in, after the stun should already have
    // expired, so its death says nothing either way
    const long = [];
    for (let i = 0; i < 18; i += 1) {
        long.push({ pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster(), 1: monster() } });
    }
    long.push({
        pMap: { 0: player({ isStunned: true }) },
        mMap: { 0: monster({ cHP: 0, isActive: false }), 1: monster() },
    });
    long.push({ pMap: { 0: player() }, mMap: { 1: monster() } });
    const episodes = run(ONE_STUNNER, long);

    it('is discarded', () => {
        expect(episodes[0].discard).toBe('deathAfterDuration');
    });
});

describe('a caster that never died', () => {
    const episodes = run(ONE_STUNNER, [
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster(), 1: monster() } },
        { pMap: { 0: player() }, mMap: { 0: monster(), 1: monster() } },
    ]);

    it('is discarded', () => {
        expect(episodes[0].discard).toBe('casterSurvived');
    });
});

describe('a wide end bracket', () => {
    // The unit is flagged, then simply stops being sent for three seconds
    // before turning up unflagged. The stun "ran" far longer than it did
    const episodes = run(ONE_STUNNER, [
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster(), 1: monster() } },
        { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster({ cHP: 0, isActive: false }), 1: monster() } },
        { mMap: { 1: monster() } },
        { mMap: { 1: monster() } },
        ...Array.from({ length: 12 }, () => ({ mMap: { 1: monster() } })),
        { pMap: { 0: player() }, mMap: { 1: monster() } },
    ]);

    it('still qualifies, because the unit was never reported unstunned', () => {
        expect(episodes[0].qualifies).toBe(true);
    });

    it('carries a bracket wide enough to be distrusted', () => {
        expect(episodes[0].bracketSeconds).toBeCloseTo(3.0, 5);
        expect(bracketBucket(episodes[0].bracketSeconds)).toBe(5);
    });

    it('does not let the artefact hide — the tally records the width', () => {
        const tally = foldEpisode(emptyTally(), episodes[0], 5);
        expect(tally.monsterCaster.brackets[5]).toBe(1);
        expect(summarize(tally, wilsonInterval).directions.monsterCaster.medianBracketSeconds).toBe('>2s');
    });
});

describe('a unit missing from the map entirely', () => {
    it('is not read as the stun having ended', () => {
        const episodes = run(ONE_STUNNER, [
            { pMap: { 0: player({ isStunned: true }) }, mMap: { 0: monster(), 1: monster() } },
            // pMap absent altogether — nothing about the player changed
            { mMap: { 0: monster({ cHP: 0, isActive: false }), 1: monster() } },
            { pMap: { 0: player({ isStunned: true }) }, mMap: { 1: monster() } },
            { pMap: { 0: player() }, mMap: { 1: monster() } },
        ]);
        expect(episodes).toHaveLength(1);
        expect(episodes[0].qualifies).toBe(true);
        expect(episodes[0].outlivedCaster).toBe(true);
    });
});

describe('the reverse direction', () => {
    it('needs the player to have been seen using a stunning ability', () => {
        const watch = createStunWatch({ clientData: CLIENT_DATA });
        let now = 3_000_000;
        watch.newBattle({ monsters: ONE_STUNNER, players: [{ name: 'A' }, { name: 'B' }] }, now);
        const ticks = [
            // Only slot 0 ever casts the stunning ability, which is what makes
            // it the one candidate
            { pMap: { 0: player({ abilityHrid: PLAYER_STUN }), 1: player({ abilityHrid: '/abilities/plain_hit' }) } },
            { mMap: { 0: monster({ isStunned: true }) } },
            { pMap: { 0: player({ cHP: 0, isActive: false }) }, mMap: { 0: monster({ isStunned: true }) } },
            { mMap: { 0: monster({ isStunned: true }) } },
            { mMap: { 0: monster() } },
        ];
        for (const tick of ticks) {
            now += 200;
            watch.battleUpdated(tick, now);
        }
        const episodes = watch.drain();
        expect(episodes[0].direction).toBe(DIRECTIONS.playerCaster);
        expect(episodes[0].qualifies).toBe(true);
        expect(episodes[0].outlivedCaster).toBe(true);
    });
});

describe('the tally', () => {
    it('keeps counts, brackets and a bounded audit trail', () => {
        const tally = emptyTally();
        for (let i = 0; i < MAX_AUDIT_EPISODES + 5; i += 1) {
            foldEpisode(
                tally,
                {
                    qualifies: true,
                    direction: DIRECTIONS.monsterCaster,
                    outlivedCaster: true,
                    postDeathSeconds: 0.4,
                    bracketSeconds: 0.05,
                    observedSeconds: 2.8,
                    durationSeconds: 3,
                    casterHrid: '/monsters/magnetic_golem',
                    startTick: 1,
                    deathTick: 2,
                    lastStunnedTick: 3,
                    endTick: 4,
                },
                1000 + i
            );
        }
        expect(tally.monsterCaster.episodes).toBe(MAX_AUDIT_EPISODES + 5);
        expect(tally.monsterCaster.brackets[0]).toBe(MAX_AUDIT_EPISODES + 5);
        expect(tally.audit).toHaveLength(MAX_AUDIT_EPISODES);
        expect(tally.startedAt).toBe(1000);
    });

    it('counts discards by reason', () => {
        const tally = emptyTally();
        foldEpisode(tally, { qualifies: false, discard: 'ambiguousCaster' }, 1);
        foldEpisode(tally, { qualifies: false, discard: 'waveEnded' }, 2);
        foldEpisode(tally, { qualifies: false, discard: 'waveEnded' }, 3);
        const summary = summarize(tally, wilsonInterval);
        expect(summary.discarded).toBe(3);
        expect(summary.discards.find((row) => row.reason === 'waveEnded').count).toBe(2);
    });
});

describe('the verdict', () => {
    /**
     * A direction summary with a given persistence rate.
     * @param {number} episodes - Qualifying episodes
     * @param {number} outlived - Of which persisted
     * @param {string} bracket - Median bracket label
     * @returns {Object} Direction summary
     */
    function direction(episodes, outlived, bracket = '<0.1s') {
        const interval = wilsonInterval(outlived, episodes);
        return {
            episodes,
            outlived,
            fraction: outlived / episodes,
            low: interval.low,
            high: interval.high,
            medianBracketSeconds: bracket,
        };
    }

    it('refuses to say anything below the episode floor', () => {
        const verdict = verdictFor(direction(MIN_EPISODES - 1, MIN_EPISODES - 1), null);
        expect(verdict.decided).toBe(false);
        expect(verdict.text).toContain('Not enough');
    });

    it('backs the simulator when the stun persists and the brackets are tight', () => {
        const verdict = verdictFor(direction(40, 40), null);
        expect(verdict.decided).toBe(true);
        expect(verdict.text).toContain('outlives');
        expect(verdict.text).not.toContain('treat it as weak');
    });

    it('caveats the same result when the brackets are wide', () => {
        expect(verdictFor(direction(40, 40, '>2s'), null).text).toContain('treat it as weak');
    });

    it('contradicts the simulator when the stun stops at the death', () => {
        const verdict = verdictFor(direction(40, 0), null);
        expect(verdict.decided).toBe(true);
        expect(verdict.text).toContain('cancel');
    });

    it('stays undecided in the middle', () => {
        expect(verdictFor(direction(40, 20), null).decided).toBe(false);
    });

    it('says so when the two directions disagree', () => {
        const verdict = verdictFor(direction(40, 40), direction(40, 0));
        expect(verdict.text).toContain('disagree');
    });
});

describe('small helpers', () => {
    it('buckets bracket widths', () => {
        expect(bracketBucket(0.05)).toBe(0);
        expect(bracketBucket(0.3)).toBe(2);
        expect(bracketBucket(9)).toBe(5);
    });

    it('takes a median, and nothing from nothing', () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([])).toBeNull();
        expect(medianBracket([0, 0, 0])).toBeNull();
        expect(medianBracket([1, 0, 3])).toBe('0.25–0.5s');
    });
});

describe('a real recording', () => {
    const fixture = JSON.parse(
        readFileSync(fileURLToPath(new URL('../../utils/__fixtures__/combat-five.json', import.meta.url)), 'utf8')
    );

    it('parses real payload shapes without throwing, and finds the stuns in them', () => {
        const watch = createStunWatch({ clientData: CLIENT_DATA });
        let now = 0;
        let flagged = 0;
        for (const tick of fixture.ticks) {
            now += 200;
            if (tick.type === 'new_battle') {
                watch.newBattle(tick.payload, now);
                continue;
            }
            watch.battleUpdated(tick.payload, now);
            for (const entry of Object.values(tick.payload.mMap || {})) if (entry?.isStunned) flagged += 1;
        }
        const episodes = watch.drain();

        // 74 monster-side isStunned entries in this recording, which is far
        // fewer than 74 episodes — they are restatements of a handful of stuns
        expect(flagged).toBe(74);
        expect(episodes.length).toBeGreaterThan(0);
        expect(episodes.every((episode) => typeof episode.discard === 'string' || episode.qualifies)).toBe(true);
    });

    it('produces nothing in the reverse direction, because no player ever dies in it', () => {
        // Stated rather than assumed: none of the fixtures contain a player
        // death, so the control cannot be tested against a recording
        const deaths = fixture.ticks.filter(
            (tick) =>
                tick.type === 'battle_updated' &&
                Object.values(tick.payload.pMap || {}).some((entry) => entry?.cHP === 0 || entry?.isActive === false)
        );
        expect(deaths).toHaveLength(0);
    });
});
