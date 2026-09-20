import { describe, it, expect } from 'vitest';
import {
    createTickPeriodWatch,
    emptyTally,
    enrageBoost,
    foldHpFall,
    foldObservation,
    foldRejection,
    healOverTimeInstances,
    modeCluster,
    multiples,
    summarize,
    EFFECTS,
} from './tick-period.js';
import recordedRun from '../../utils/__fixtures__/combat-run.json';
import recordedRefresh from '../../utils/__fixtures__/combat-refresh.json';
import recordedParty from '../../utils/__fixtures__/combat-party.json';

/**
 * Replay a recording through the watch, using the recorder's own offsets as
 * arrival times.
 * @param {Object} recording - A combat fixture
 * @returns {Object} A tally
 */
function replay(recording) {
    const watch = createTickPeriodWatch();
    const tally = emptyTally();
    for (const tick of recording.ticks) {
        if (tick.type === 'new_battle') watch.newBattle();
        else watch.battleUpdated(tick.payload, tick.at, {});
        const { observations, rejections, hpFalls } = watch.drain();
        for (const observation of observations) foldObservation(tally, observation);
        for (const rejection of rejections) foldRejection(tally, rejection.effect, rejection.reason);
        for (const attributed of hpFalls) foldHpFall(tally, attributed);
    }
    return tally;
}

describe('modeCluster', () => {
    it('finds the period rather than the mean when ticks were missed', () => {
        const cluster = modeCluster([5000, 4990, 5010, 10000, 15000, 5005]);
        expect(cluster.median).toBeGreaterThanOrEqual(5000);
        expect(cluster.median).toBeLessThanOrEqual(5005);
        expect(cluster.n).toBe(4);
    });

    it('does not pull two periods a fifth apart into one cluster', () => {
        const cluster = modeCluster([3000, 3010, 2990, 2500, 2510]);
        expect(cluster.median).toBe(3000);
        expect(cluster.n).toBe(3);
    });

    it('has nothing to say about nothing', () => {
        expect(modeCluster([])).toBeNull();
    });
});

describe('multiples', () => {
    it('counts the echoes a dropped tick leaves', () => {
        expect(multiples([3000, 6000, 6010, 9000, 4400], 3000)).toEqual({ x2: 2, x3: 1, other: 1 });
    });
});

describe('enrageBoost', () => {
    it('sums the enrage entries and ignores everything else', () => {
        const map = {
            '/buff_uniques/enrage_damage': { ratioBoost: 0.2 },
            '/buff_uniques/enrage_accuracy': { ratioBoost: 0.2 },
            '/buff_uniques/drink_concentration': { ratioBoost: 5 },
        };
        expect(enrageBoost(map)).toBeCloseTo(0.4);
        expect(enrageBoost({ '/buff_uniques/other': { ratioBoost: 1 } })).toBeNull();
        expect(enrageBoost(null)).toBeNull();
    });
});

describe('healOverTimeInstances', () => {
    it('identifies a running recovery by hrid and start time together', () => {
        const map = {
            '/buff_uniques/cheese_hp_regen': { typeHrid: '/buff_types/hp_regen', duration: 15e9, startTime: 'A' },
        };
        expect([...healOverTimeInstances(map)]).toEqual(['/buff_uniques/cheese_hp_regen@A']);
        const again = { '/buff_uniques/cheese_hp_regen': { ...map['/buff_uniques/cheese_hp_regen'], startTime: 'B' } };
        expect([...healOverTimeInstances(again)]).toEqual(['/buff_uniques/cheese_hp_regen@B']);
    });

    it('leaves out a loadout drink and a permanent passive, which would bridge two meals', () => {
        expect(
            healOverTimeInstances({
                // Minutes long: a coffee, not one meal's recovery window
                '/buff_uniques/hp_regen_coffee': { typeHrid: '/buff_types/hp_regen', duration: 300e9, startTime: 'A' },
                // No end at all, and not a recovery either way
                '/buff_uniques/house_well': { typeHrid: '/buff_types/max_hitpoints', duration: 0, startTime: 'A' },
                '/buff_uniques/wisdom_tea': { typeHrid: '/buff_types/experience', duration: 30e9, startTime: 'A' },
            }).size
        ).toBe(0);
        expect(healOverTimeInstances(null).size).toBe(0);
    });
});

describe('createTickPeriodWatch', () => {
    /**
     * A tick in which one player gained both resources with no counters moving.
     * @param {number} hp - Hitpoints now
     * @param {number} mp - Mana now
     * @returns {Object} Payload
     */
    const regenTick = (hp, mp) => ({ pMap: { 0: { cHP: hp, cMP: mp, mHP: 1000, mMP: 500 } }, mMap: {} });

    it('times regeneration from a simultaneous rise in both resources', () => {
        const watch = createTickPeriodWatch();
        // The first tick is only a baseline — a delta needs something to be a
        // delta from, and the first rise seen is a tick with no predecessor
        watch.battleUpdated(regenTick(480, 185), 0, {});
        watch.battleUpdated(regenTick(500, 200), 5000, {});
        watch.battleUpdated(regenTick(520, 215), 15_000, {});
        watch.battleUpdated(regenTick(540, 230), 25_003, {});

        const { observations } = watch.drain();
        expect(observations.map((entry) => entry.effect)).toEqual([EFFECTS.regen, EFFECTS.regen]);
        expect(observations.map((entry) => entry.intervalMs)).toEqual([10_000, 10_003]);
    });

    it('will not call a health rise recovery while the other resource is full', () => {
        const watch = createTickPeriodWatch();
        watch.battleUpdated({ pMap: { 0: { cHP: 500, cMP: 500, mHP: 1000, mMP: 500 } } }, 0, {});
        watch.battleUpdated({ pMap: { 0: { cHP: 560 } } }, 5000, {});

        const { observations, rejections } = watch.drain();
        expect(observations).toEqual([]);
        expect(rejections).toEqual([{ effect: EFFECTS.hot, reason: 'otherResourceFull' }]);
    });

    it('will not call a health rise recovery on a tick where something was cast', () => {
        const watch = createTickPeriodWatch();
        watch.battleUpdated({ pMap: { 0: { cHP: 500, cMP: 100, mHP: 1000, mMP: 500 } }, mMap: {} }, 0, {});
        watch.battleUpdated({ pMap: { 0: { cHP: 560 }, 1: { abilityHrid: '/abilities/heal' } } }, 5000, {});

        const { observations, rejections } = watch.drain();
        expect(observations).toEqual([]);
        expect(rejections).toEqual([{ effect: EFFECTS.hot, reason: 'abilityInTick' }]);
    });

    /**
     * A recovery effect as the wire states one: named, nanosecond duration,
     * and a start time that changes when the unit eats again.
     * @param {string} startTime - The server's start time for this instance
     * @returns {Object} A `combatBuffMap`
     */
    const recovering = (startTime) => ({
        '/buff_uniques/cheese_hp_regen': { typeHrid: '/buff_types/hp_regen', duration: 15e9, startTime },
    });

    it('times recovery when the untouched resource proves it was not regeneration', () => {
        const watch = createTickPeriodWatch();
        const food = (hp) => ({
            pMap: { 0: { cHP: hp, cMP: 100, mHP: 1000, mMP: 500, combatBuffMap: recovering('A') } },
        });
        watch.battleUpdated(food(440), 0, {});
        watch.battleUpdated(food(500), 2000, {});
        watch.battleUpdated(food(560), 7000, {});
        watch.battleUpdated(food(620), 12_010, {});

        const { observations } = watch.drain();
        expect(observations.map((entry) => entry.effect)).toEqual([EFFECTS.hot, EFFECTS.hot]);
        expect(observations.map((entry) => entry.intervalMs)).toEqual([5000, 5010]);
    });

    it('will not chain a fresh meal onto the last tick of the one before it', () => {
        const watch = createTickPeriodWatch();
        const food = (hp, startTime) => ({
            pMap: { 0: { cHP: hp, cMP: 100, mHP: 1000, mMP: 500, combatBuffMap: recovering(startTime) } },
        });
        watch.battleUpdated(food(440, 'A'), 0, {});
        watch.battleUpdated(food(500, 'A'), 2000, {});
        watch.battleUpdated(food(560, 'A'), 7000, {});
        // A minute of not needing food, then a second helping: the same hrid,
        // a new start time, and a gap that is a trigger condition and not a period
        watch.battleUpdated(food(700, 'B'), 68_000, {});
        watch.battleUpdated(food(760, 'B'), 73_000, {});

        const { observations, rejections } = watch.drain();
        expect(observations.map((entry) => entry.intervalMs)).toEqual([5000, 5000]);
        expect(rejections).toContainEqual({ effect: EFFECTS.hot, reason: 'effectNotContinuous' });
    });

    it('keeps a doubled interval inside one continuous effect, because a missed tick is never sent', () => {
        const watch = createTickPeriodWatch();
        const food = (hp) => ({
            pMap: { 0: { cHP: hp, cMP: 100, mHP: 1000, mMP: 500, combatBuffMap: recovering('A') } },
        });
        watch.battleUpdated(food(440), 0, {});
        watch.battleUpdated(food(500), 2000, {});
        watch.battleUpdated(food(560), 12_000, {});

        const { observations, rejections } = watch.drain();
        expect(observations.map((entry) => entry.intervalMs)).toEqual([10_000]);
        expect(rejections).toEqual([]);
    });

    it('discards an interval spanning a lapse, and says that is why', () => {
        const watch = createTickPeriodWatch();
        const food = (hp, buffMap) => ({
            pMap: { 0: { cHP: hp, cMP: 100, mHP: 1000, mMP: 500, combatBuffMap: buffMap } },
        });
        watch.battleUpdated(food(440, recovering('A')), 0, {});
        watch.battleUpdated(food(500, recovering('A')), 2000, {});
        // The effect ran out; whatever raised health five seconds later was not
        // the same recovery still ticking
        watch.battleUpdated(food(560, {}), 7000, {});

        const { observations, rejections } = watch.drain();
        expect(observations).toEqual([]);
        expect(rejections).toEqual([{ effect: EFFECTS.hot, reason: 'effectNotContinuous' }]);
    });

    it('refuses a health fall that a swing explains, and says which it was', () => {
        const watch = createTickPeriodWatch();
        watch.battleUpdated({ mMap: { 0: { cHP: 900, mHP: 1000, cMP: 10, mMP: 10, dmgCounter: 4 } } }, 0, {});
        watch.battleUpdated({ mMap: { 0: { cHP: 800, dmgCounter: 5 } } }, 1000, {});
        watch.battleUpdated({ mMap: { 0: { cHP: 770 } } }, 2000, {});
        watch.battleUpdated({ mMap: { 0: { cHP: 740 } } }, 5000, {});

        const { observations, rejections, hpFalls } = watch.drain();
        expect(rejections).toContainEqual({ effect: EFFECTS.dot, reason: 'hpFallAttributed' });
        expect(hpFalls).toEqual([true, false, false]);
        expect(observations).toEqual([{ effect: EFFECTS.dot, intervalMs: 3000, at: 5000, simultaneous: 1 }]);
    });

    it('times the enrage ramp off the boost the buff map restates', () => {
        const watch = createTickPeriodWatch();
        const enraged = (boost) => ({
            mMap: { 0: { cHP: 100, combatBuffMap: { '/buff_uniques/enrage_damage': { ratioBoost: boost } } } },
        });
        watch.battleUpdated(enraged(0.1), 0, {});
        watch.battleUpdated(enraged(0.2), 60_000, {});
        watch.battleUpdated(enraged(0.2), 90_000, {});
        watch.battleUpdated(enraged(0.3), 120_040, {});

        const { observations } = watch.drain();
        expect(observations.map((entry) => entry.effect)).toEqual([EFFECTS.enrage]);
        expect(observations[0].intervalMs).toBe(60_040);
    });

    it('starts the clocks again rather than timing across a backgrounded tab', () => {
        const watch = createTickPeriodWatch();
        watch.battleUpdated(regenTick(480, 185), 0, {});
        watch.battleUpdated(regenTick(500, 200), 5000, {});
        watch.battleUpdated(regenTick(520, 215), 15_000, {});
        watch.battleUpdated({ pMap: {} }, 20_000, { hidden: true });
        watch.battleUpdated(regenTick(540, 230), 400_000, {});
        watch.battleUpdated(regenTick(560, 245), 410_000, {});

        const { observations, rejections } = watch.drain();
        expect(observations.map((entry) => entry.intervalMs)).toEqual([10_000, 10_000]);
        expect(rejections.filter((entry) => entry.reason === 'hidden')).toHaveLength(4);
    });

    it('forgets monsters at a wave boundary, because the slots are reused', () => {
        const watch = createTickPeriodWatch();
        const dot = (hp) => ({ mMap: { 0: { cHP: hp, mHP: 1000, cMP: 5, mMP: 10 } } });
        watch.battleUpdated(dot(930), 0, {});
        watch.battleUpdated(dot(900), 1000, {});
        watch.battleUpdated(dot(870), 4000, {});
        watch.newBattle();
        watch.battleUpdated(dot(990), 6000, {});
        watch.battleUpdated(dot(960), 9000, {});

        const { observations } = watch.drain();
        // The rise across the boundary is a different monster, not a heal, and
        // the interval either side of it is never joined into one
        expect(observations.map((entry) => entry.intervalMs)).toEqual([3000]);
    });
});

describe('against the recorded stream', () => {
    it('recovers a 10 s regeneration period from a solo recording', () => {
        const tally = replay(recordedRun);
        const summary = summarize(tally);
        const regen = summary.effects.find((effect) => effect.key === EFFECTS.regen);
        expect(regen.cluster.median).toBe(10_000);
        expect(regen.cluster.n).toBeGreaterThanOrEqual(4);
    });

    it('recovers the same period from an unrelated recording', () => {
        const regen = summarize(replay(recordedRefresh)).effects.find((effect) => effect.key === EFFECTS.regen);
        expect(regen.cluster.median).toBeGreaterThan(9900);
        expect(regen.cluster.median).toBeLessThan(10_100);
    });

    it('reports damage over time as settled rather than as zero', () => {
        const tally = replay(recordedParty);
        const summary = summarize(tally);
        const dot = summary.effects.find((effect) => effect.key === EFFECTS.dot);
        // Every health fall in these recordings came with a damage counter, and
        // a run made to settle it found the same for all 539 of its falls, so
        // the row states a finding rather than waiting for a sample
        expect(summary.hpFalls.attributed).toBeGreaterThan(0);
        expect(dot.state).toBe('settled');
        expect(dot.text).toContain('not measurable');
        expect(dot.text).toContain('539');
    });
});

describe('the gate leaves the other three alone', () => {
    it('does not move the regeneration period in either recorded run', () => {
        const run = summarize(replay(recordedRun)).effects.find((effect) => effect.key === EFFECTS.regen);
        expect(run.cluster.median).toBe(10_000);
        // Nothing was dropped for a reason that only applies to recovery
        expect(run.rejections).toEqual([]);
        const refresh = summarize(replay(recordedRefresh)).effects.find((effect) => effect.key === EFFECTS.regen);
        expect(refresh.cluster.median).toBeGreaterThan(9900);
        expect(refresh.cluster.median).toBeLessThan(10_100);
    });

    it('times regeneration with no buff map in sight at all', () => {
        const watch = createTickPeriodWatch();
        const tick = (hp, mp) => ({ pMap: { 0: { cHP: hp, cMP: mp, mHP: 1000, mMP: 500 } }, mMap: {} });
        watch.battleUpdated(tick(480, 185), 0, {});
        watch.battleUpdated(tick(500, 200), 10_000, {});
        watch.battleUpdated(tick(520, 215), 20_000, {});
        watch.battleUpdated(tick(540, 230), 30_000, {});

        const { observations, rejections } = watch.drain();
        expect(observations.map((entry) => entry.intervalMs)).toEqual([10_000, 10_000]);
        expect(rejections).toEqual([]);
    });
});

describe('summarize', () => {
    it('says nothing measured when nothing has been', () => {
        expect(summarize(emptyTally()).verdict).toContain('Nothing measured yet');
    });

    it('makes an effect it could not isolate a stated result, not an empty row', () => {
        const tally = emptyTally();
        for (let index = 0; index < 12; index += 1) foldRejection(tally, EFFECTS.hot, 'effectNotContinuous');
        const hot = summarize(tally).effects.find((effect) => effect.key === EFFECTS.hot);
        expect(hot.state).toBe('unresolved');
        expect(hot.text).toContain('not resolvable');
        expect(hot.rejections.map((row) => row.key)).toEqual(['effectNotContinuous']);
    });

    it('calls a cluster on the assumed constant consistent, and one off it a difference', () => {
        const consistent = emptyTally();
        const differing = emptyTally();
        for (let index = 0; index < 30; index += 1) {
            foldObservation(consistent, { effect: EFFECTS.regen, intervalMs: 10_000 + (index % 5) - 2, at: index });
            foldObservation(differing, { effect: EFFECTS.regen, intervalMs: 10_400 + (index % 5) - 2, at: index });
        }
        expect(summarize(consistent).effects.find((e) => e.key === EFFECTS.regen).state).toBe('consistent');
        expect(summarize(differing).effects.find((e) => e.key === EFFECTS.regen).state).toBe('differs');
    });

    it('holds a thin sample back as provisional rather than quoting it', () => {
        const tally = emptyTally();
        foldObservation(tally, { effect: EFFECTS.enrage, intervalMs: 60_000, at: 1 });
        const enrage = summarize(tally).effects.find((effect) => effect.key === EFFECTS.enrage);
        expect(enrage.state).toBe('provisional');
    });
});
