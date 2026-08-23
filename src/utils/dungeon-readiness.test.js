import { describe, test, expect } from 'vitest';
import {
    runsCovered,
    typicalRunSeconds,
    keyReadiness,
    memberReadiness,
    whoStopsFirst,
    levelGapWarnings,
    buildReadiness,
    UNKNOWN_CONSUMABLES,
} from './dungeon-readiness.js';

const RUN = 600;

describe('runsCovered', () => {
    test('whole runs only', () => {
        expect(runsCovered(1800, RUN)).toBe(3);
        expect(runsCovered(1799, RUN)).toBe(2);
        expect(runsCovered(0, RUN)).toBe(0);
    });

    test('unknown without a run length or a finite stock', () => {
        expect(runsCovered(1800, null)).toBeNull();
        expect(runsCovered(1800, 0)).toBeNull();
        expect(runsCovered(Infinity, RUN)).toBeNull();
    });
});

describe('typicalRunSeconds', () => {
    const runs = [
        { dungeonName: 'Chimerical Den', tier: 0, duration: 600_000 },
        { dungeonName: 'Chimerical Den', tier: 0, duration: 660_000 },
        { dungeonName: 'Chimerical Den', tier: 0, duration: 14_400_000 },
        { dungeonName: 'Pirate Cove', tier: 0, duration: 100_000 },
    ];

    test('the median, so one afk run cannot move it', () => {
        expect(typicalRunSeconds(runs, { dungeonName: 'Chimerical Den' })).toEqual({ seconds: 660, samples: 3 });
    });

    test('a run with no tier recorded still counts against a tiered query', () => {
        const mixed = [
            { dungeonName: 'Chimerical Den', tier: null, duration: 600_000 },
            { dungeonName: 'Chimerical Den', tier: 2, duration: 900_000 },
        ];
        expect(typicalRunSeconds(mixed, { dungeonName: 'Chimerical Den', tier: 2 }).samples).toBe(2);
        expect(typicalRunSeconds(mixed, { dungeonName: 'Chimerical Den', tier: 0 }).samples).toBe(1);
    });

    test('no history is null, not zero', () => {
        expect(typicalRunSeconds(runs, { dungeonName: 'Enchanted Fortress' })).toBeNull();
        expect(typicalRunSeconds([], { dungeonName: 'Chimerical Den' })).toBeNull();
        expect(typicalRunSeconds(runs, { dungeonName: 'Unknown' })).toBeNull();
    });
});

describe('keyReadiness', () => {
    test('one key per run, and the shortfall for the plan', () => {
        const keys = keyReadiness({
            itemHrid: '/items/chimerical_entry_key',
            itemName: 'Chimerical Entry Key',
            held: 4,
            runsPlanned: 10,
        });
        expect(keys).toMatchObject({ held: 4, runsCovered: 4, shortfall: 6, enough: false });
    });

    test('enough is enough', () => {
        expect(keyReadiness({ itemHrid: '/items/pirate_entry_key', held: 10, runsPlanned: 10 })).toMatchObject({
            enough: true,
            shortfall: 0,
        });
    });

    test('outside a dungeon there is no key line at all', () => {
        expect(keyReadiness({ itemHrid: null, held: 5, runsPlanned: 5 })).toBeNull();
    });
});

describe('memberReadiness', () => {
    const forecasts = [
        { itemHrid: '/items/blueberry_cake', name: 'Blueberry Cake', secondsLeft: 3000 },
        { itemHrid: '/items/swiftness_coffee', name: 'Swiftness Coffee', secondsLeft: 1200 },
        { itemHrid: '/items/spare', name: 'Spare', secondsLeft: Infinity },
    ];

    test('the soonest slot decides, and it converts to runs', () => {
        const row = memberReadiness({ name: 'Me', isSelf: true, forecasts, runSeconds: RUN, measuredFrom: 'live run' });
        expect(row).toMatchObject({
            runsCovered: 2,
            secondsLeft: 1200,
            limitedBy: 'Swiftness Coffee',
            unknown: null,
            measuredFrom: 'live run',
        });
    });

    test('no run length leaves the time known and the runs unknown', () => {
        const row = memberReadiness({ name: 'Me', forecasts });
        expect(row.secondsLeft).toBe(1200);
        expect(row.runsCovered).toBeNull();
        expect(row.unknown).toBeNull();
    });

    test('a member never seen is unknown, not stocked', () => {
        const row = memberReadiness({ name: 'Stranger', forecasts: null, combatLevel: 140 });
        expect(row).toMatchObject({ runsCovered: null, secondsLeft: null, unknown: UNKNOWN_CONSUMABLES });
        expect(row.combatLevel).toBe(140);
    });

    test('slots that are filled but not being consumed are not "lasts forever"', () => {
        const row = memberReadiness({ name: 'Idle', forecasts: [{ name: 'Cake', secondsLeft: Infinity }] });
        expect(row.unknown).toBe(UNKNOWN_CONSUMABLES);
    });
});

describe('whoStopsFirst', () => {
    test('the soonest of the members that could be read, and says how many that was', () => {
        const rows = [
            memberReadiness({ name: 'Me', isSelf: true, forecasts: [{ name: 'Cake', secondsLeft: 4000 }] }),
            memberReadiness({ name: 'Ally', forecasts: [{ name: 'Coffee', secondsLeft: 900 }] }),
            memberReadiness({ name: 'Stranger', forecasts: null }),
        ];
        expect(whoStopsFirst(rows)).toMatchObject({ name: 'Ally', secondsLeft: 900, known: 2, total: 3 });
    });

    test('nobody readable is null rather than a guess', () => {
        expect(whoStopsFirst([memberReadiness({ name: 'Stranger', forecasts: null })])).toBeNull();
        expect(whoStopsFirst([])).toBeNull();
    });
});

describe('levelGapWarnings', () => {
    test('flags the members below the party and names the ones it could not check', () => {
        const rows = [
            { name: 'Top', combatLevel: 200 },
            { name: 'Low', combatLevel: 100 },
            { name: 'Stranger', combatLevel: null },
        ];
        const result = levelGapWarnings(rows);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].name).toBe('Low');
        expect(result.warnings[0].debuff).toBeLessThan(0);
        expect(result.unknownLevels).toEqual(['Stranger']);
    });

    test('one known level cannot establish a top, so nothing is claimed', () => {
        expect(levelGapWarnings([{ name: 'Me', combatLevel: 100 }, { name: 'Stranger' }]).warnings).toEqual([]);
    });
});

describe('buildReadiness', () => {
    const dungeon = { actionHrid: '/actions/combat/chimerical_den', name: 'Chimerical Den', tier: 0 };

    test('assembles the card and footnotes exactly what was missing', () => {
        const model = buildReadiness({
            dungeon,
            runsPlanned: 10,
            keys: keyReadiness({ itemHrid: '/items/chimerical_entry_key', held: 4, runsPlanned: 10 }),
            members: [
                memberReadiness({
                    name: 'Me',
                    isSelf: true,
                    combatLevel: 200,
                    forecasts: [{ name: 'Cake', secondsLeft: 3000 }],
                    runSeconds: RUN,
                }),
                memberReadiness({ name: 'Ally', forecasts: null, combatLevel: 100 }),
            ],
            lint: ['Ally has skilling gear equipped: Cheese Hatchet'],
            lintScope: 'Gear is read from captured profiles only.',
            runLength: { seconds: RUN, samples: 12 },
        });

        expect(model.keys.shortfall).toBe(6);
        expect(model.stopsFirst).toMatchObject({ name: 'Me', known: 1, total: 2 });
        expect(model.levelGap.warnings[0].name).toBe('Ally');
        expect(model.runSeconds).toBe(RUN);
        expect(model.footnotes.some((note) => note.includes('after the key is spent'))).toBe(true);
        expect(model.footnotes).toContain('Gear is read from captured profiles only.');
        expect(model.footnotes.some((note) => note.includes('how long one takes'))).toBe(false);
    });

    test('no run history footnotes the missing conversion', () => {
        const model = buildReadiness({ dungeon, runsPlanned: 3, members: [] });
        expect(model.runSeconds).toBeNull();
        expect(model.footnotes.some((note) => note.includes('how long one takes'))).toBe(true);
        expect(model.stopsFirst).toBeNull();
    });
});
