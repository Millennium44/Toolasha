/**
 * Trial samples and building bonuses.
 *
 * Two claims here are load-bearing. A record from a previous week must be thrown
 * away rather than merged, because last week's tiers would be fitted into this
 * week's growth curve and every projection would inherit them. And an
 * unresolvable building bonus must come back as null, not zero: the panel prints
 * a caption off that distinction, and a zero would quietly present base figures
 * as final ones.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    store: {},
    clientData: {},
    buildingLevels: {},
    settings: {},
    failNextRead: false,
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => {
            if (game.failNextRead) {
                game.failNextRead = false;
                throw new Error('IndexedDB is having a day');
            }
            return key in game.store ? game.store[key] : fallback;
        },
        set: async (key, value) => {
            game.store[key] = value;
            return true;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get guildBuildingLevelMap() {
            return game.buildingLevels;
        },
        getInitClientData: () => game.clientData,
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => (key in game.settings ? game.settings[key] : fallback) },
}));

const {
    BUILDING_PATTERNS,
    MAX_SAMPLES,
    buildingBonusFromDetail,
    emptyRecord,
    findBuildingHrid,
    guildTrialsStorageKey,
    loadTrialRecord,
    probeBuildingDetailMap,
    readBuildingBonus,
    readPayoutBonuses,
    recordTileSample,
    saveTrialRecord,
    tileKey,
} = await import('./guild-trials-store.js');

const { trialWeekStart } = await import('./guild-trials-math.js');

const now = Date.parse('2026-08-04T12:00:00Z');
const thisWeek = trialWeekStart(now);

beforeEach(() => {
    game.store = {};
    game.clientData = {};
    game.buildingLevels = {};
    game.settings = {};
    game.failNextRead = false;
});

describe('keys', () => {
    test('a record is keyed by guild name, as the XP history is', () => {
        expect(guildTrialsStorageKey('Milky Way')).toBe('guildTrials_Milky Way');
    });

    test('before the guild is known the record has somewhere to go', () => {
        expect(guildTrialsStorageKey(null)).toBe('guildTrials_default');
    });

    test('a tile is keyed by kind as well as name', () => {
        expect(tileKey({ kind: 'combat', name: 'Trial Chameleon' })).toBe('combat::trial chameleon');
        expect(tileKey({ kind: 'skilling', name: 'Trial Chameleon' })).not.toBe(
            tileKey({ kind: 'combat', name: 'Trial Chameleon' })
        );
    });
});

describe('recording samples', () => {
    const tile = (overrides = {}) => ({
        name: 'Trial Chameleon',
        kind: 'combat',
        level: 140,
        tier: 5,
        readings: [{ current: 618_000, max: 618_000 }],
        ...overrides,
    });

    test('the first sample creates the tile', () => {
        const record = recordTileSample(emptyRecord(thisWeek), tile(), now);
        const entry = record.tiles['combat::trial chameleon'];

        expect(entry.name).toBe('Trial Chameleon');
        expect(entry.kind).toBe('combat');
        expect(entry.tier).toBe(5);
        expect(entry.samples).toEqual([{ t: now, readings: [{ current: 618_000, max: 618_000 }] }]);
    });

    test('samples accumulate in time order', () => {
        let record = recordTileSample(emptyRecord(thisWeek), tile(), now);
        record = recordTileSample(record, tile({ readings: [{ current: 400_000, max: 618_000 }] }), now + 5000);

        expect(record.tiles['combat::trial chameleon'].samples.map((sample) => sample.t)).toEqual([now, now + 5000]);
    });

    test('a repeat at the same instant replaces rather than duplicates', () => {
        // The panel observer fires several times for one React render, and a
        // zero-span pair reads as an infinite rate
        let record = recordTileSample(emptyRecord(thisWeek), tile(), now);
        record = recordTileSample(record, tile({ readings: [{ current: 1, max: 618_000 }] }), now);

        const samples = record.tiles['combat::trial chameleon'].samples;
        expect(samples).toHaveLength(1);
        expect(samples[0].readings[0].current).toBe(1);
    });

    test('a tier total is remembered once per tier, and every new tier is added', () => {
        let record = recordTileSample(emptyRecord(thisWeek), tile(), now);
        record = recordTileSample(record, tile(), now + 1000);
        record = recordTileSample(
            record,
            tile({ tier: 6, level: 150, readings: [{ current: 700_000, max: 760_000 }] }),
            now + 2000
        );

        expect(record.tiles['combat::trial chameleon'].tiers).toEqual([
            { tier: 5, total: 618_000 },
            { tier: 6, total: 760_000 },
        ]);
    });

    test('a bar with no maximum contributes no tier observation', () => {
        const record = recordTileSample(emptyRecord(thisWeek), tile({ readings: [{ current: 5, max: 0 }] }), now);
        expect(record.tiles['combat::trial chameleon'].tiers).toEqual([]);
    });

    test('samples are capped so a whole hour of trial cannot grow without bound', () => {
        let record = emptyRecord(thisWeek);
        for (let index = 0; index < MAX_SAMPLES + 50; index += 1) {
            record = recordTileSample(record, tile(), now + index * 1000);
        }

        const samples = record.tiles['combat::trial chameleon'].samples;
        expect(samples).toHaveLength(MAX_SAMPLES);
        // The newest are the ones kept
        expect(samples[samples.length - 1].t).toBe(now + (MAX_SAMPLES + 49) * 1000);
    });

    test('the record handed in is not mutated', () => {
        const before = emptyRecord(thisWeek);
        recordTileSample(before, tile(), now);
        expect(before.tiles).toEqual({});
    });

    test('two trials live side by side', () => {
        let record = recordTileSample(emptyRecord(thisWeek), tile(), now);
        record = recordTileSample(
            record,
            tile({ name: 'Trial Milking', kind: 'skilling', tier: 2, readings: [{ current: 10, max: 100 }] }),
            now
        );

        expect(Object.keys(record.tiles).sort()).toEqual(['combat::trial chameleon', 'skilling::trial milking']);
    });
});

describe('loading and saving', () => {
    test('a record from this week comes back', async () => {
        game.store['guildTrials_Milky Way'] = { weekStart: thisWeek, tiles: { a: { samples: [] } } };
        const record = await loadTrialRecord('Milky Way', now);

        expect(record.weekStart).toBe(thisWeek);
        expect(Object.keys(record.tiles)).toEqual(['a']);
    });

    test('a record from last week is discarded, not merged', async () => {
        game.store['guildTrials_Milky Way'] = {
            weekStart: thisWeek - 7 * 24 * 3600_000,
            tiles: { a: { samples: [1, 2, 3] } },
        };
        const record = await loadTrialRecord('Milky Way', now);

        expect(record).toEqual({ weekStart: thisWeek, tiles: {} });
    });

    test('no record at all is a fresh one for this week', async () => {
        expect(await loadTrialRecord('Milky Way', now)).toEqual({ weekStart: thisWeek, tiles: {} });
    });

    test('a storage failure is a fresh record, not a crash', async () => {
        game.failNextRead = true;
        expect(await loadTrialRecord('Milky Way', now)).toEqual({ weekStart: thisWeek, tiles: {} });
    });

    test('saving round-trips', async () => {
        const record = recordTileSample(
            emptyRecord(thisWeek),
            { name: 'Trial Swarm', kind: 'combat', tier: 3, level: 120, readings: [{ current: 1, max: 2 }] },
            now
        );
        expect(await saveTrialRecord('Milky Way', record)).toBe(true);
        expect(await loadTrialRecord('Milky Way', now)).toEqual(record);
    });
});

describe('finding a building', () => {
    test('matches however the hrid is punctuated', () => {
        const levels = {
            '/guild_buildings/builders_hall': 4,
            '/guild_buildings/treasury': 2,
            '/guild_buildings/skilling_encampment': 1,
            '/guild_buildings/combat_encampment': 3,
        };

        expect(findBuildingHrid(levels, BUILDING_PATTERNS.buildersHall)).toBe('/guild_buildings/builders_hall');
        expect(findBuildingHrid(levels, BUILDING_PATTERNS.treasury)).toBe('/guild_buildings/treasury');
        expect(findBuildingHrid(levels, BUILDING_PATTERNS.skillingEncampment)).toBe(
            '/guild_buildings/skilling_encampment'
        );
        expect(findBuildingHrid(levels, BUILDING_PATTERNS.combatEncampment)).toBe('/guild_buildings/combat_encampment');
    });

    test('a different spelling of the same building still matches', () => {
        expect(findBuildingHrid({ '/guild_buildings/buildersHall': 1 }, BUILDING_PATTERNS.buildersHall)).toBe(
            '/guild_buildings/buildersHall'
        );
    });

    test('a building the guild has not built is not found', () => {
        expect(findBuildingHrid({ '/guild_buildings/treasury': 1 }, BUILDING_PATTERNS.buildersHall)).toBeNull();
        expect(findBuildingHrid(null, BUILDING_PATTERNS.treasury)).toBeNull();
    });
});

describe('reading a bonus off a detail entry', () => {
    test('the buff shape the rest of the codebase reads', () => {
        // ratioBoost + (level - 1) × ratioBoostLevelBonus, as shrine buffs resolve
        const detail = { buffs: [{ ratioBoost: 0.05, ratioBoostLevelBonus: 0.02 }] };
        expect(buildingBonusFromDetail(detail, 1)).toBeCloseTo(0.05, 12);
        expect(buildingBonusFromDetail(detail, 4)).toBeCloseTo(0.11, 12);
    });

    test('a flat per-level field', () => {
        expect(buildingBonusFromDetail({ bonusPerLevel: 0.03 }, 5)).toBeCloseTo(0.15, 12);
    });

    test('an entry that says nothing usable says nothing', () => {
        expect(buildingBonusFromDetail({ name: 'Builders Hall' }, 4)).toBeNull();
        expect(buildingBonusFromDetail(null, 4)).toBeNull();
    });

    test('an unbuilt building has no bonus', () => {
        expect(buildingBonusFromDetail({ bonusPerLevel: 0.03 }, 0)).toBeNull();
    });
});

describe('the detail map probe', () => {
    test('finds the map whatever the client calls it', () => {
        game.clientData = { guildBuildingDetailDict: { a: 1 } };
        expect(probeBuildingDetailMap()).toEqual({ a: 1 });
    });

    test('prefers the most likely spelling when several are present', () => {
        game.clientData = { guildShrineDetailMap: { b: 2 }, guildBuildingDetailMap: { a: 1 } };
        expect(probeBuildingDetailMap()).toEqual({ a: 1 });
    });

    test('no map at all is an empty one', () => {
        expect(probeBuildingDetailMap()).toEqual({});
    });
});

describe('payout bonuses', () => {
    test('resolved from client data when the game describes the building', () => {
        const bonus = readBuildingBonus({
            pattern: BUILDING_PATTERNS.buildersHall,
            levelMap: { '/guild_buildings/builders_hall': 3 },
            detailMap: {
                '/guild_buildings/builders_hall': { buffs: [{ ratioBoost: 0.1, ratioBoostLevelBonus: 0.05 }] },
            },
        });

        expect(bonus).toEqual({ hrid: '/guild_buildings/builders_hall', level: 3, bonus: 0.2, source: 'client' });
    });

    test('unknown when the level is there but nothing describes it', () => {
        const bonus = readBuildingBonus({
            pattern: BUILDING_PATTERNS.treasury,
            levelMap: { '/guild_buildings/treasury': 6 },
            detailMap: {},
        });

        expect(bonus).toMatchObject({ level: 6, bonus: null, source: 'unknown' });
    });

    test('unknown when nothing is known at all', () => {
        expect(readBuildingBonus({ pattern: BUILDING_PATTERNS.treasury, levelMap: {}, detailMap: {} })).toEqual({
            hrid: null,
            level: 0,
            bonus: null,
            source: 'unknown',
        });
    });

    test('a manual override wins, and is read as a percentage', () => {
        const bonus = readBuildingBonus({
            pattern: BUILDING_PATTERNS.buildersHall,
            override: 25,
            levelMap: { '/guild_buildings/builders_hall': 3 },
            detailMap: { '/guild_buildings/builders_hall': { bonusPerLevel: 0.01 } },
        });

        expect(bonus).toMatchObject({ bonus: 0.25, source: 'manual' });
    });

    test('an override of zero is not an override', () => {
        const bonus = readBuildingBonus({
            pattern: BUILDING_PATTERNS.buildersHall,
            override: 0,
            levelMap: { '/guild_buildings/builders_hall': 2 },
            detailMap: { '/guild_buildings/builders_hall': { bonusPerLevel: 0.01 } },
        });

        expect(bonus).toMatchObject({ bonus: 0.02, source: 'client' });
    });

    test('both buildings are reported together, reading the data manager and settings', () => {
        game.buildingLevels = { '/guild_buildings/builders_hall': 2, '/guild_buildings/treasury': 5 };
        game.clientData = {
            guildBuildingDetailMap: { '/guild_buildings/builders_hall': { bonusPerLevel: 0.05 } },
        };
        game.settings = { guildTrialsTreasuryBonus: 12 };

        const bonuses = readPayoutBonuses();
        expect(bonuses.buildersHall).toMatchObject({ level: 2, bonus: 0.1, source: 'client' });
        expect(bonuses.treasury).toMatchObject({ level: 5, bonus: 0.12, source: 'manual' });
    });

    test('with nothing configured and nothing on the wire, both are unknown', () => {
        const bonuses = readPayoutBonuses();
        expect(bonuses.buildersHall.bonus).toBeNull();
        expect(bonuses.treasury.bonus).toBeNull();
    });
});
