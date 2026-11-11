import { describe, test, expect } from 'vitest';
import { createWipeNamer, analyzeWipe, describeWipe, summarizeWipes } from './wipe-summary.js';

const BOSS = '/monsters/gummy_bear';
const STRIKE = '/abilities/crushing_strike';
const playerInfo = [
    { hrid: 'player1', name: 'AFKANDY' },
    { hrid: 'player2', name: 'Bee' },
    { hrid: 'player3', name: 'Cee' },
    { hrid: 'player4', name: 'Dee' },
];
const gameData = {
    combatMonsterDetailMap: { [BOSS]: { name: 'Gummy Bear' } },
    abilityDetailMap: { [STRIKE]: { name: 'Crushing Strike' } },
};
const namer = createWipeNamer({ playerInfo, gameData });
const S = 1e9;

/** A hit as the engine logs it: beforeHp = afterHp + damage */
const hit = (time, target, damage, afterHp, extra = {}) => ({
    time: time * S,
    wave: 60,
    source: BOSS,
    ability: STRIKE,
    target,
    damage,
    beforeHp: afterHp + damage,
    afterHp,
    isCrit: false,
    playersHp: [],
    ...extra,
});

// Four players; one falls to a crit, one to a DoT tick (the engine logs its
// source as UNKNOWN_SOURCE), then two fall on the same tick
const fourPlayerWipe = () => [
    hit(9, 'player3', 300, 700),
    hit(10, 'player2', 1240, 0, { isCrit: true }),
    hit(11, 'player1', 500, 900),
    hit(12, 'player3', 700, 0, { source: 'UNKNOWN_SOURCE', ability: 'damageOverTime' }),
    hit(14, 'player1', 900, 0, { ability: 'autoAttack' }),
    hit(14, 'player4', 800, 0, { ability: 'autoAttack' }),
];

describe('analyzeWipe', () => {
    test('derives deaths from afterHp reaching 0, in order, with same-tick falls sharing a tick', () => {
        const { down } = analyzeWipe(fourPlayerWipe());

        expect(down.map((d) => d.target)).toEqual(['player2', 'player3', 'player1', 'player4']);
        expect(down.map((d) => d.tick)).toEqual([0, 1, 2, 2]);
        expect(down[0]).toMatchObject({ damage: 1240, isCrit: true, ability: STRIKE });
        expect(down[1].ability).toBe('damageOverTime');
    });

    test('a player hit again after falling was revived: only the last fall counts', () => {
        const logs = [hit(1, 'player2', 100, 0), hit(5, 'player2', 50, 450), hit(8, 'player2', 450, 0)];
        const { down } = analyzeWipe(logs);

        expect(down).toHaveLength(1);
        expect(down[0].time).toBe(8 * S);
    });

    test('empty, missing and error entries yield no falls and no hits', () => {
        expect(analyzeWipe([]).down).toEqual([]);
        expect(analyzeWipe(undefined).hits).toEqual([]);
        expect(analyzeWipe([{ error: 'boom' }, null]).hits).toEqual([]);
    });

    test('a window that never reaches 0 HP reports no one down', () => {
        expect(analyzeWipe([hit(1, 'player1', 100, 900)]).down).toEqual([]);
    });
});

describe('describeWipe', () => {
    test('names the first fall by member name, monster and ability, and the order after', () => {
        const text = describeWipe(analyzeWipe(fourPlayerWipe()), namer);

        expect(text.first).toBe("Bee — Gummy Bear's Crushing Strike 1,240 (crit)");
        expect(text.order).toBe('Bee → Cee → AFKANDY + Dee');
    });

    test('two players falling first on one tick are both named', () => {
        const logs = [hit(3, 'player1', 10, 0), hit(3, 'player4', 20, 0, { isCrit: true })];
        const text = describeWipe(analyzeWipe(logs), namer);

        expect(text.first).toBe(
            "AFKANDY — Gummy Bear's Crushing Strike 10; Dee — Gummy Bear's Crushing Strike 20 (crit)"
        );
        expect(text.order).toBe('AFKANDY + Dee');
    });

    test('a DoT first fall has no monster to blame', () => {
        const logs = [hit(3, 'player1', 10, 0, { source: 'UNKNOWN_SOURCE', ability: 'damageOverTime' })];

        expect(describeWipe(analyzeWipe(logs), namer).first).toBe('AFKANDY — damage over time 10');
    });

    test('an empty log describes nothing', () => {
        expect(describeWipe(analyzeWipe([]), namer)).toEqual({ first: '', order: '' });
    });

    test('unknown hrids fall back to a readable name rather than blank', () => {
        const bare = createWipeNamer({ playerInfo: [], gameData: null });
        const logs = [hit(3, 'player9', 10, 0, { source: '/monsters/jelly_fish', ability: '/abilities/zap' })];

        expect(describeWipe(analyzeWipe(logs), bare).first).toBe("player9 — Jelly Fish's Zap 10");
    });
});

describe('summarizeWipes', () => {
    const events = () => [
        { wave: 60, logs: fourPlayerWipe() },
        { wave: 60, logs: [hit(1, 'player1', 100, 0)] },
        { wave: 55, logs: [hit(1, 'player4', 100, 0, { ability: 'autoAttack' })] },
        { wave: 60, logs: [] },
    ];

    test('counts wipe waves, first-down members, killing blows and damage', () => {
        const sum = summarizeWipes(events(), namer);

        expect(sum.waves).toEqual([
            { wave: 60, count: 3 },
            { wave: 55, count: 1 },
        ]);
        expect(sum.firstDown).toEqual([
            { name: 'AFKANDY', count: 1 },
            { name: 'Bee', count: 1 },
            { name: 'Dee', count: 1 },
        ]);
        expect(sum.killers[0]).toEqual({ label: 'Gummy Bear — Auto Attack', blows: 3 });
        expect(sum.killers[1]).toEqual({ label: 'Gummy Bear — Crushing Strike', blows: 2 });
        expect(sum.damage[0].label).toBe('Gummy Bear — Crushing Strike');
        expect(sum.withLog).toBe(3);
    });

    test('a list of wipes with no logs still reports the waves', () => {
        const sum = summarizeWipes([{ wave: 12, logs: [] }], namer);

        expect(sum.waves).toEqual([{ wave: 12, count: 1 }]);
        expect(sum.firstDown).toEqual([]);
        expect(sum.killers).toEqual([]);
        expect(sum.withLog).toBe(0);
    });

    test('a DoT kill is credited to damage over time, not to a monster', () => {
        const sum = summarizeWipes([{ wave: 1, logs: fourPlayerWipe() }], namer);

        expect(sum.killers.map((k) => k.label)).toContain('Damage over time');
    });
});
