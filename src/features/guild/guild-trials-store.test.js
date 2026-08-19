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
    // A dropped IndexedDB connection: reads say they could not be made
    unavailable: false,
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
        tryGet: async (key) => {
            if (game.unavailable) return null;
            if (game.failNextRead) {
                game.failNextRead = false;
                throw new Error('IndexedDB is having a day');
            }
            return key in game.store
                ? { found: true, value: structuredClone(game.store[key]) }
                : { found: false, value: null };
        },
        set: async (key, value) => {
            game.store[key] = value;
            return true;
        },
        delete: async (key) => {
            delete game.store[key];
            return true;
        },
        getAllKeys: async () => Object.keys(game.store),
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
    GUILD_BUILDING_MAX_LEVEL,
    MAX_SAMPLES,
    buildingBonusFromDetail,
    emptyRecord,
    findBuildingHrid,
    guildTrialsStorageKey,
    loadTrialRecord,
    mergeTrialRecords,
    archiveCycle,
    clearTrialStorage,
    MAX_ARCHIVED_CYCLES,
    isJunkTile,
    purgeJunkTiles,
    purgeLegacyTrialRecord,
    recordProvenance,
    probeBuildingDetailMap,
    readBuildingBonus,
    readBuildingRules,
    readPayoutBonuses,
    recordTileSample,
    saveTrialRecord,
    loadWorkBases,
    saveWorkBases,
    loadTrialRoster,
    saveTrialRoster,
    loadTrialStats,
    saveTrialStats,
    tileKey,
} = await import('./guild-trials-store.js');

const { NOTICE_BOARD_KEY, NOTICE_BOARD_NAME, NOTICE_BOARD_PERSONAL, NOTICE_BOARD_SAMPLES } =
    await import('./guild-notice-board.fixture.js');

const { TRIAL_MAX_TIER, trialWeekStart } = await import('./guild-trials-math.js');

const now = Date.parse('2026-08-04T12:00:00Z');
const thisWeek = trialWeekStart(now);

beforeEach(() => {
    game.store = {};
    game.clientData = {};
    game.buildingLevels = {};
    game.settings = {};
    game.failNextRead = false;
    game.unavailable = false;
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

    test('stated total points are kept as a timestamped series, even with no bar', () => {
        // A trial not joined sends a Trials-tab card with points but no reading —
        // the bar samples stay empty, but the point series grows so a loose rate
        // can be fitted for a trial you are not in.
        const carded = (points, extra = {}) => ({ name: 'Cooking', kind: 'skilling', tier: 2, points, ...extra });
        let record = recordTileSample(emptyRecord(thisWeek), carded(360), now);
        record = recordTileSample(record, carded(420), now + 5000);
        const entry = record.tiles['skilling::cooking'];

        expect(entry.samples).toEqual([]); // no bar readings arrived
        expect(entry.pointSamples).toEqual([
            { t: now, points: 360 },
            { t: now + 5000, points: 420 },
        ]);
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
        game.store['guildTrials_Milky Way'] = {
            weekStart: thisWeek,
            tiles: { 'skilling::milking': { name: 'Milking', kind: 'skilling', samples: [] } },
        };
        const record = await loadTrialRecord('Milky Way', now);

        expect(record.weekStart).toBe(thisWeek);
        expect(Object.keys(record.tiles)).toEqual(['skilling::milking']);
    });

    test('a record from last week is discarded, not merged', async () => {
        game.store['guildTrials_Milky Way'] = {
            weekStart: thisWeek - 7 * 24 * 3600_000,
            tiles: { a: { samples: [1, 2, 3] } },
        };
        const record = await loadTrialRecord('Milky Way', now);

        expect(record).toMatchObject({ weekStart: thisWeek, tiles: {} });
    });

    test('no record at all is a fresh one for this week', async () => {
        expect(await loadTrialRecord('Milky Way', now)).toMatchObject({ weekStart: thisWeek, tiles: {} });
    });

    test('a storage failure is "unreadable", not a fresh record and not a crash', async () => {
        // A fresh record taken for the truth here is what used to be written
        // back over the stored week
        game.failNextRead = true;
        expect(await loadTrialRecord('Milky Way', now)).toBeNull();
        game.unavailable = true;
        expect(await loadTrialRecord('Milky Way', now)).toBeNull();
    });

    test('saving round-trips', async () => {
        const record = recordTileSample(
            emptyRecord(thisWeek),
            { name: 'Trial Swarm', kind: 'combat', tier: 3, level: 120, readings: [{ current: 1, max: 2 }] },
            now
        );
        expect(await saveTrialRecord('Milky Way', record)).toBe(true);
        expect(await loadTrialRecord('Milky Way', now)).toMatchObject({ tiles: record.tiles });
    });
});

describe('provenance, and healing what is already stored', () => {
    test('a record naming another guild is not this guild\u2019s', () => {
        // The reported failure lived exactly here: the poisoned copy had been
        // adopted onto the *new* guild's own key, so nothing about keying could
        // reach it. What it could not fake is which guild it was recorded in.
        expect(recordProvenance({ guildId: 'g1' }, { guildId: 'g2' })).toBe('foreign');
        expect(recordProvenance({ guildName: 'Old Guild' }, { guildName: 'New Guild' })).toBe('foreign');
        expect(recordProvenance({ guildId: 'g1' }, { guildId: 'g1' })).toBe('own');
        expect(recordProvenance({ guildName: 'Milky Way' }, { guildName: 'milky way' })).toBe('own');
    });

    test('a record from before provenance existed is unknown, not foreign', () => {
        // Discarding these outright would throw away every correct record the
        // moment this shipped. They are settled by the panel instead
        expect(recordProvenance({ tiles: {} }, { guildId: 'g1' })).toBe('unknown');
        expect(recordProvenance({ guildId: 'g1' }, {})).toBe('unknown');
        expect(recordProvenance(null, {})).toBe('unknown');
    });

    test('loading refuses a record belonging to another guild', async () => {
        game.store['guildTrials_New Guild'] = {
            weekStart: thisWeek,
            guildId: 'old-guild',
            tiles: { 'skilling::milking': { name: 'Milking', samples: [{ t: 1, readings: [] }] } },
        };

        const record = await loadTrialRecord('New Guild', now, null, { guildId: 'new-guild' });
        expect(record.tiles).toEqual({});
    });

    test('a record that names this guild is loaded as ever', async () => {
        game.store['guildTrials_New Guild'] = {
            weekStart: thisWeek,
            guildId: 'new-guild',
            tiles: { 'skilling::milking': { name: 'Milking', samples: [] } },
        };

        const record = await loadTrialRecord('New Guild', now, null, { guildId: 'new-guild' });
        expect(Object.keys(record.tiles)).toEqual(['skilling::milking']);
    });

    test('saving stamps which guild the record belongs to', async () => {
        await saveTrialRecord('Milky Way', emptyRecord(thisWeek), null, { guildId: 'g1' });
        expect(game.store['guildTrials_Milky Way']).toMatchObject({ guildId: 'g1', guildName: 'Milky Way' });
    });

    test('the legacy shared bucket is purged', async () => {
        game.store['guildTrials_default'] = { weekStart: thisWeek, tiles: {} };
        expect(await purgeLegacyTrialRecord()).toBe(true);
        expect(game.store['guildTrials_default']).toBeUndefined();
    });

    test('the escape hatch clears trial keys and leaves the XP history alone', async () => {
        game.store['guildTrials_Milky Way'] = { weekStart: thisWeek, tiles: {} };
        game.store['guildTrials_char_30404'] = { weekStart: thisWeek, tiles: {} };
        game.store['guildTrialSession_Milky Way'] = { startedAt: 1 };
        game.store['guildXP_Milky Way'] = { 'Milky Way': [{ t: 1, xp: 2 }] };

        const { removed } = await clearTrialStorage();

        expect(removed.sort()).toEqual([
            'guildTrialSession_Milky Way',
            'guildTrials_Milky Way',
            'guildTrials_char_30404',
        ]);
        // Months of guild XP, nothing to do with trials
        expect(game.store['guildXP_Milky Way']).toBeTruthy();
    });
});

describe('archiving a finished cycle', () => {
    /**
     * A record with one tile that has been sampled.
     * @param {number[]} times - Sample times
     * @returns {Object} The record
     */
    const sampled = (times) => ({
        weekStart: thisWeek,
        tiles: {
            'skilling::milking': {
                name: 'Milking',
                kind: 'skilling',
                tier: 2,
                samples: times.map((t) => ({ t, readings: [{ current: t, max: 4000 }] })),
                tiers: [],
            },
        },
    });

    test('the tiles are put away rather than thrown away', () => {
        const before = sampled([10, 20]);
        const after = archiveCycle(before, 'a new cycle is scheduled', now);

        expect(after.tiles).toEqual({});
        expect(after.history).toHaveLength(1);
        expect(after.history[0]).toMatchObject({ reason: 'a new cycle is scheduled', archivedAt: now });
        expect(Object.keys(after.history[0].tiles)).toEqual(['skilling::milking']);
    });

    test('archiving nothing adds no entry', () => {
        const after = archiveCycle(emptyRecord(thisWeek), 'nothing to keep', now);
        expect(after.history).toEqual([]);
    });

    test('only the last few cycles are kept', () => {
        let held = sampled([10]);
        for (let cycle = 0; cycle < MAX_ARCHIVED_CYCLES + 3; cycle += 1) {
            held = archiveCycle(held, `cycle ${cycle}`, now + cycle);
            held.tiles = sampled([cycle]).tiles;
        }
        expect(held.history.length).toBeLessThanOrEqual(MAX_ARCHIVED_CYCLES);
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

describe('the game’s own building rules', () => {
    // Read out of `initClientData` by the player: the Builder's Hall entry
    // carries `guildPointsBonusPerLevel: 0.02` and the Treasury
    // `guildTokenBonusPerLevel: 0.02`, both with `maxLevel: 20` — the same
    // numbers the upgrade popups quote, now available at runtime instead of
    // only as a rule this file hardcodes.
    const detailMap = {
        '/guild_buildings/builders_hall': { name: "Builder's Hall", guildPointsBonusPerLevel: 0.02, maxLevel: 20 },
        '/guild_buildings/treasury': { name: 'Treasury', guildTokenBonusPerLevel: 0.02, maxLevel: 20 },
    };

    test('the per-level bonus comes off the entry, not the constant', () => {
        expect(readBuildingRules(BUILDING_PATTERNS.buildersHall, { detailMap })).toEqual({
            bonusPerLevel: 0.02,
            maxLevel: 20,
            source: 'client',
        });
        expect(readBuildingRules(BUILDING_PATTERNS.treasury, { detailMap })).toMatchObject({
            bonusPerLevel: 0.02,
            source: 'client',
        });
    });

    test('a rebalance moves the panel with it', () => {
        const rebalanced = {
            '/guild_buildings/builders_hall': { guildPointsBonusPerLevel: 0.03, maxLevel: 25 },
        };
        expect(readBuildingRules(BUILDING_PATTERNS.buildersHall, { detailMap: rebalanced })).toMatchObject({
            bonusPerLevel: 0.03,
            maxLevel: 25,
        });

        const bonus = readBuildingBonus({
            pattern: BUILDING_PATTERNS.buildersHall,
            levelMap: { '/guild_buildings/builders_hall': 24 },
            detailMap: rebalanced,
        });
        // Twenty-four levels is within the rebalanced cap, at the rebalanced rate
        expect(bonus.level).toBe(24);
        expect(bonus.bonus).toBeCloseTo(0.72, 10);
    });

    test('with no client data the confirmed constants stand in', () => {
        expect(readBuildingRules(BUILDING_PATTERNS.treasury, { detailMap: {} })).toEqual({
            bonusPerLevel: 0.02,
            maxLevel: 20,
            source: 'constant',
        });
    });

    test('the detail map is found by what it contains when its name is not known', () => {
        game.clientData = { someRenamedGuildBuildings: detailMap };
        expect(probeBuildingDetailMap()).toEqual(detailMap);
    });

    test('the payout bonus is read straight off the entry', () => {
        const bonus = readBuildingBonus({
            pattern: BUILDING_PATTERNS.buildersHall,
            levelMap: { '/guild_buildings/builders_hall': 10 },
            detailMap,
        });
        // The guild the panel was calibrated against: level 10, +20%
        expect(bonus).toMatchObject({ level: 10, source: 'client' });
        expect(bonus.bonus).toBeCloseTo(0.2, 10);
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

        expect(bonus).toMatchObject({
            hrid: '/guild_buildings/builders_hall',
            level: 3,
            bonus: 0.2,
            source: 'client',
        });
    });

    test('a level with nothing describing it falls back to the confirmed 2% per level', () => {
        // From the Build dialog: Level 10 → Level 11 moves Guild Points from
        // +20% to +22%, so the bonus is the level times 2%
        const hall = readBuildingBonus({
            pattern: BUILDING_PATTERNS.buildersHall,
            levelMap: { '/guild_buildings/builders_hall': 10 },
            detailMap: {},
        });
        expect(hall).toMatchObject({ level: 10, bonus: 0.2, source: 'formula' });

        const treasury = readBuildingBonus({
            pattern: BUILDING_PATTERNS.treasury,
            levelMap: { '/guild_buildings/treasury': 5 },
            detailMap: {},
        });
        expect(treasury).toMatchObject({ level: 5, bonus: 0.1, source: 'formula' });
    });

    test('client data still wins over the formula when the game describes the building', () => {
        const bonus = readBuildingBonus({
            pattern: BUILDING_PATTERNS.treasury,
            levelMap: { '/guild_buildings/treasury': 10 },
            detailMap: { '/guild_buildings/treasury': { bonusPerLevel: 0.05 } },
        });

        expect(bonus).toMatchObject({ bonus: 0.5, source: 'client' });
    });

    test('unknown when nothing is known at all', () => {
        expect(readBuildingBonus({ pattern: BUILDING_PATTERNS.treasury, levelMap: {}, detailMap: {} })).toMatchObject({
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

describe('the building level cap', () => {
    // Buildings and shrines max out at level 20 in-game (Buildings tab: "Lv. x
    // / 20") — a different ladder from the 21 trial tiers, and GUILD_BUILDING_MAX_LEVEL
    // must stay 20 regardless of what TRIAL_MAX_TIER is.
    test('is 20, and is a different number from the 21-tier trial ladder', () => {
        expect(GUILD_BUILDING_MAX_LEVEL).toBe(20);
        expect(GUILD_BUILDING_MAX_LEVEL).not.toBe(TRIAL_MAX_TIER);
    });

    test('level 20 itself is trusted as-is, via the formula', () => {
        const hall = readBuildingBonus({
            pattern: BUILDING_PATTERNS.buildersHall,
            levelMap: { '/guild_buildings/builders_hall': 20 },
            detailMap: {},
        });
        expect(hall).toMatchObject({ level: 20, bonus: 0.4, source: 'formula' });
    });

    test('a level past 20 on the wire is clamped, not trusted or extrapolated', () => {
        const hall = readBuildingBonus({
            pattern: BUILDING_PATTERNS.buildersHall,
            levelMap: { '/guild_buildings/builders_hall': 21 },
            detailMap: {},
        });
        // Clamped to 20 (bonus 0.4), not read as a 21st level (which would be 0.42)
        expect(hall).toMatchObject({ level: 20, bonus: 0.4, source: 'formula' });

        const wayOver = readBuildingBonus({
            pattern: BUILDING_PATTERNS.treasury,
            levelMap: { '/guild_buildings/treasury': 300 },
            detailMap: {},
        });
        expect(wayOver).toMatchObject({ level: 20, bonus: 0.4, source: 'formula' });
    });

    test('the clamp applies to the client-detail path too, not only the formula fallback', () => {
        const bonus = readBuildingBonus({
            pattern: BUILDING_PATTERNS.treasury,
            levelMap: { '/guild_buildings/treasury': 25 },
            detailMap: { '/guild_buildings/treasury': { bonusPerLevel: 0.01 } },
        });
        expect(bonus).toMatchObject({ level: 20, bonus: 0.2, source: 'client' });
    });
});

describe('a guild notice board that is already on disk', () => {
    /** The tile exactly as the live export carried it */
    const noticeTile = () => ({
        name: NOTICE_BOARD_NAME,
        kind: 'skilling',
        level: null,
        tier: null,
        points: null,
        completed: false,
        personal: { ...NOTICE_BOARD_PERSONAL },
        samples: NOTICE_BOARD_SAMPLES.map((sample) => ({ ...sample })),
        tiers: [],
    });

    test('it is recognised as junk on every count', () => {
        expect(isJunkTile(noticeTile(), NOTICE_BOARD_KEY)).toBe(true);
        // The Overview tab's guild statistics, attached to it as a player's own
        expect(noticeTile().personal['Guild Members']).toBe('106');
    });

    test('a real trial is not', () => {
        expect(
            isJunkTile(
                { name: 'Milking', kind: 'skilling', samples: [{ t: 1, readings: [{ current: 20, max: 57_120 }] }] },
                'skilling::milking'
            )
        ).toBe(false);
    });

    test('a real trial carrying one impossible reading is refused too', () => {
        // Whatever the name says, a nineteen-digit bar is not a bar
        const tile = {
            name: 'Milking',
            kind: 'skilling',
            samples: [{ t: 1, readings: [{ current: 1_309_080_597_314_011_148, max: 1_525_897_111_936_438_314 }] }],
        };
        expect(isJunkTile(tile, 'skilling::milking')).toBe(true);
    });

    test('purging drops it and names what went, keeping everything else', () => {
        const record = {
            weekStart: 1,
            tiles: {
                [NOTICE_BOARD_KEY]: noticeTile(),
                'skilling::milking': { name: 'Milking', kind: 'skilling', samples: [] },
            },
        };

        const { record: cleaned, purged } = purgeJunkTiles(record);
        expect(Object.keys(cleaned.tiles)).toEqual(['skilling::milking']);
        expect(purged).toHaveLength(1);
        // One short line of it, so a log line stays a log line
        expect(purged[0].length).toBeLessThan(50);
    });

    test('an archived cycle is cleaned too, or the export carries it a week later', () => {
        const record = {
            weekStart: 1,
            tiles: {},
            history: [{ endedAt: 2, tiles: { [NOTICE_BOARD_KEY]: noticeTile() } }],
        };

        const { record: cleaned, purged } = purgeJunkTiles(record);
        expect(cleaned.history[0].tiles).toEqual({});
        expect(purged).toHaveLength(1);
    });

    test('nothing to purge is the same record back, so there is no needless write', () => {
        const record = { weekStart: 1, tiles: { 'skilling::milking': { name: 'Milking', samples: [] } } };
        expect(purgeJunkTiles(record).record).toBe(record);
        expect(purgeJunkTiles(null).purged).toEqual([]);
    });

    test('loading heals what is stored, once, and writes the clean copy back', async () => {
        game.store['guildTrials_MilkMaxxing'] = {
            weekStart: thisWeek,
            tiles: {
                [NOTICE_BOARD_KEY]: noticeTile(),
                'skilling::milking': { name: 'Milking', kind: 'skilling', samples: [] },
            },
        };

        const record = await loadTrialRecord('MilkMaxxing', now);
        expect(Object.keys(record.tiles)).toEqual(['skilling::milking']);
        // And it is gone from storage rather than filtered on every read
        expect(Object.keys(game.store['guildTrials_MilkMaxxing'].tiles)).toEqual(['skilling::milking']);
    });
});

describe('a tile that never gained points', () => {
    // A trial the party wiped on: completed, zero points, and nothing else on
    // the card. It has to survive a merge and an archive like any other, or a
    // failed trial disappears from the week's history instead of being in it
    const wiped = () => ({
        name: 'Trial Hedgehog',
        kind: 'combat',
        tier: 1,
        points: 0,
        completed: true,
        pointsByTier: { 1: 0 },
        samples: [],
        tiers: [],
    });

    test('a stated zero survives a sample that carries no points at all', () => {
        const record = { weekStart: 1, tiles: { 'combat::trial hedgehog': wiped() } };
        const after = recordTileSample(record, { name: 'Trial Hedgehog', kind: 'combat', readings: [] }, 2);

        const tile = after.tiles['combat::trial hedgehog'];
        expect(tile.points).toBe(0);
        expect(tile.completed).toBe(true);
        expect(tile.pointsByTier).toEqual({ 1: 0 });
    });

    test('and survives a merge with a record that never saw it', () => {
        const mine = { weekStart: 1, tiles: { 'combat::trial hedgehog': wiped() } };
        const theirs = { weekStart: 1, tiles: {} };

        const merged = mergeTrialRecords(mine, theirs);
        expect(merged.tiles['combat::trial hedgehog'].points).toBe(0);
        expect(mergeTrialRecords(theirs, mine).tiles['combat::trial hedgehog'].points).toBe(0);
    });

    test('and is archived with the rest of the cycle', () => {
        const record = { weekStart: 1, tiles: { 'combat::trial hedgehog': wiped() } };
        const archived = archiveCycle(record, 2);

        expect(archived.tiles).toEqual({});
        expect(archived.history?.length).toBe(1);
        expect(archived.history[0].tiles['combat::trial hedgehog'].points).toBe(0);
    });
});

describe('merging two records for one guild', () => {
    /**
     * A record holding one skilling tile with the given sample times.
     * @param {number} weekStart - Which week it belongs to
     * @param {number[]} times - Sample timestamps
     * @param {Object} [extra] - Fields to override on the tile
     * @returns {Object} A record
     */
    function record(weekStart, times, extra = {}) {
        return {
            weekStart,
            tiles: {
                'skilling::milking': {
                    name: 'Trial Milking',
                    kind: 'skilling',
                    level: 110,
                    tier: 2,
                    samples: times.map((t) => ({ t, readings: [{ current: t % 1000, max: 4000 }] })),
                    tiers: [{ tier: 2, total: 4000 }],
                    ...extra,
                },
            },
        };
    }

    test('unions the samples, in order, without duplicating the shared one', () => {
        // The two records are two views of one series: this session's, written
        // under `default` before the guild name arrived, and the last session's,
        // written under the name
        const merged = mergeTrialRecords(record(thisWeek, [10, 20]), record(thisWeek, [20, 30]));

        expect(merged.tiles['skilling::milking'].samples.map((sample) => sample.t)).toEqual([10, 20, 30]);
    });

    test('a tile only one of them has is kept', () => {
        const stored = record(thisWeek, [10]);
        const held = record(thisWeek, [20]);
        held.tiles['combat::badger'] = { name: 'Trial Badger', kind: 'combat', samples: [{ t: 5, readings: [] }] };

        expect(Object.keys(mergeTrialRecords(stored, held).tiles).length).toBe(2);
        expect(Object.keys(mergeTrialRecords(stored, held).tiles).sort()).toEqual([
            'combat::badger',
            'skilling::milking',
        ]);
    });

    test('the tier from whichever record saw the trial most recently wins', () => {
        const older = record(thisWeek, [10], { tier: 2, level: 110 });
        const newer = record(thisWeek, [90], { tier: 5, level: 140 });

        expect(mergeTrialRecords(older, newer).tiles['skilling::milking'].tier).toBe(5);
        expect(mergeTrialRecords(newer, older).tiles['skilling::milking'].tier).toBe(5);
    });

    test('last week is not spliced onto this week', () => {
        // A different ladder entirely: merging them would fit a growth curve
        // across two of them
        const lastWeek = record(thisWeek - 7 * 24 * 3600_000, [10]);
        const merged = mergeTrialRecords(lastWeek, record(thisWeek, [20]));

        expect(merged.weekStart).toBe(thisWeek);
        expect(merged.tiles['skilling::milking'].samples.map((sample) => sample.t)).toEqual([20]);
    });

    test('the sample cap still holds after a merge', () => {
        const many = (from) => Array.from({ length: MAX_SAMPLES }, (unused, index) => from + index);
        const merged = mergeTrialRecords(record(thisWeek, many(0)), record(thisWeek, many(MAX_SAMPLES)));

        expect(merged.tiles['skilling::milking'].samples).toHaveLength(MAX_SAMPLES);
        // The newest are the ones kept
        expect(merged.tiles['skilling::milking'].samples[0].t).toBe(MAX_SAMPLES);
    });

    test('nothing on one side is the other side, unchanged', () => {
        const held = record(thisWeek, [10]);
        expect(mergeTrialRecords(null, held).tiles).toEqual(held.tiles);
        expect(mergeTrialRecords(held, null).tiles).toEqual(held.tiles);
    });
});

describe('what the game says a tier is worth', () => {
    const tile = (overrides = {}) => ({
        name: 'Trial Chameleon',
        kind: 'combat',
        level: 140,
        tier: 5,
        points: 1200,
        readings: [{ current: 618_000, max: 618_000 }],
        ...overrides,
    });

    test('a card carrying both a tier and a points line is filed against that tier', () => {
        const record = recordTileSample(emptyRecord(thisWeek), tile(), now);
        expect(record.tiles['combat::trial chameleon'].pointsByTier).toEqual({ 5: 1200 });
    });

    test('a card with no tier of its own files nothing', () => {
        // The In Progress card carries the reading and no tier. The record's
        // carried-over tier is good enough for a total that is checked against
        // movement, and not good enough to hang a payout figure on
        let record = recordTileSample(emptyRecord(thisWeek), tile(), now);
        record = recordTileSample(record, tile({ tier: null, level: null, points: 9999 }), now + 5000);

        expect(record.tiles['combat::trial chameleon'].pointsByTier).toEqual({ 5: 1200 });
    });

    test('each tier keeps its own figure as the trial climbs', () => {
        let record = recordTileSample(emptyRecord(thisWeek), tile({ tier: 5, points: 1200 }), now);
        record = recordTileSample(record, tile({ tier: 6, points: 1400 }), now + 5000);

        expect(record.tiles['combat::trial chameleon'].pointsByTier).toEqual({ 5: 1200, 6: 1400 });
    });

    test('the merge that runs when the guild name arrives keeps the Trials tab’s data', () => {
        // Found by the payout block reading as zero: `mergeTrialRecords` rebuilt
        // each tile without `points`, `signups` or `pointsByTier`, so the first
        // render of every session threw away everything the Trials tab had said
        const named = {
            weekStart: thisWeek,
            tiles: {
                'combat::trial chameleon': {
                    name: 'Trial Chameleon',
                    kind: 'combat',
                    tier: 5,
                    points: 1200,
                    signups: { signed: 3, total: 56 },
                    pointsByTier: { 5: 1200 },
                    samples: [{ t: 10, readings: [{ current: 1, max: 2 }] }],
                    tiers: [],
                },
            },
        };
        const fresh = {
            weekStart: thisWeek,
            tiles: {
                'combat::trial chameleon': {
                    name: 'Trial Chameleon',
                    kind: 'combat',
                    samples: [{ t: 20, readings: [{ current: 1, max: 2 }] }],
                    tiers: [],
                },
            },
        };

        const merged = mergeTrialRecords(named, fresh).tiles['combat::trial chameleon'];
        expect(merged.points).toBe(1200);
        expect(merged.signups).toEqual({ signed: 3, total: 56 });
        expect(merged.pointsByTier).toEqual({ 5: 1200 });
        expect(merged.tier).toBe(5);
    });
});

describe('the record cannot be wiped by a failed read or a stale copy', () => {
    const KEY = 'guildTrials_Milky Way';
    const sample = (t) => ({ t, readings: [{ current: t % 1000, max: 4000 }] });
    const record = (times, extra = {}) => ({
        weekStart: thisWeek,
        guildName: 'Milky Way',
        tiles: {
            'skilling::milking': { name: 'Milking', kind: 'skilling', tier: 2, samples: times.map(sample), tiers: [] },
        },
        history: [],
        ...extra,
    });
    const storedTimes = () => (game.store[KEY]?.tiles['skilling::milking']?.samples || []).map((s) => s.t);

    test('a save while storage cannot be read is skipped, not written blind over the stored record', async () => {
        game.store[KEY] = record([1, 2, 3]);
        game.unavailable = true;

        expect(await saveTrialRecord('Milky Way', record([4]))).toBe(false);
        expect(storedTimes()).toEqual([1, 2, 3]);
    });

    test('a save merges what is stored under the record in hand, so another writer’s samples survive', async () => {
        game.store[KEY] = record([1, 2]);

        expect(await saveTrialRecord('Milky Way', record([2, 3]))).toBe(true);
        expect(storedTimes()).toEqual([1, 2, 3]);
    });

    test('once storage is back, the next save lands everything', async () => {
        game.store[KEY] = record([1]);
        game.unavailable = true;
        await saveTrialRecord('Milky Way', record([2]));
        expect(storedTimes()).toEqual([1]);

        game.unavailable = false;
        await saveTrialRecord('Milky Way', record([2, 3]));
        expect(storedTimes()).toEqual([1, 2, 3]);
    });

    test('an overwrite is the one save that may lose tiles, and it keeps the archive', async () => {
        game.store[KEY] = record([1, 2]);
        const archived = archiveCycle(record([1, 2]), 'a new cycle is scheduled', now);

        await saveTrialRecord('Milky Way', archived, null, { overwrite: true });
        expect(game.store[KEY].tiles).toEqual({});
        expect(game.store[KEY].history).toHaveLength(1);

        // A tab that never archived cannot bring the tile back to life
        await saveTrialRecord('Milky Way', record([1, 2]));
        expect(game.store[KEY].tiles).toEqual({});
        expect(game.store[KEY].history).toHaveLength(1);
    });

    test('a merge does not double up the archived cycles both sides hold', () => {
        const cycle = { archivedAt: now, reason: 'a new cycle is scheduled', weekStart: thisWeek, tiles: {} };
        const merged = mergeTrialRecords(record([1], { history: [cycle] }), record([2], { history: [cycle] }));
        expect(merged.history).toHaveLength(1);
    });

    test('a record that has moved on a week keeps its archive and provenance through a merge', () => {
        const lastWeek = record([1], { weekStart: thisWeek - 7 * 24 * 3600_000 });
        const cycle = { archivedAt: now, reason: 'a new cycle is scheduled', weekStart: thisWeek, tiles: {} };
        const merged = mergeTrialRecords(lastWeek, record([2], { history: [cycle], guildId: 'g1' }));
        expect(merged.weekStart).toBe(thisWeek);
        expect(merged.history).toEqual([cycle]);
        expect(merged.guildId).toBe('g1');
        expect(merged.guildName).toBe('Milky Way');
    });

    test('the learned work bases, the roster and the stats merge the same way and refuse a blind write', async () => {
        game.store.guildTrialsWorkBases = { crafting: { baseWork: 40_000 } };
        await saveWorkBases({ milking: { baseWork: 30_000 } });
        expect(await loadWorkBases()).toEqual({ crafting: { baseWork: 40_000 }, milking: { baseWork: 30_000 } });

        game.store.guildTrialsStats = { weekStart: thisWeek, trials: { a: { reported: 1 } } };
        await saveTrialStats({ weekStart: thisWeek, trials: { b: { reported: 2 } } });
        expect((await loadTrialStats(now)).trials).toEqual({ a: { reported: 1 }, b: { reported: 2 } });
        // Last week's comparison is not folded into this week's
        await saveTrialStats({ weekStart: thisWeek + 7 * 24 * 3600_000, trials: { c: { reported: 3 } } });
        expect(game.store.guildTrialsStats.trials).toEqual({ c: { reported: 3 } });

        game.store.guildTrialsRoster = { battleId: 1, roster: { 0: 'Ada' }, at: 1 };
        await saveTrialRoster({ battleId: 2, roster: { 0: 'Bea' }, at: 2 });
        expect(await loadTrialRoster()).toEqual({ battleId: 2, roster: { 0: 'Bea' }, at: 2 });

        game.unavailable = true;
        expect(await saveWorkBases({ milking: { baseWork: 1 } })).toBe(false);
        expect(await saveTrialStats({ weekStart: thisWeek, trials: {} })).toBe(false);
        expect(await saveTrialRoster({ battleId: 3, roster: {}, at: 3 })).toBe(false);
        expect(game.store.guildTrialsWorkBases.milking.baseWork).toBe(30_000);
        expect(game.store.guildTrialsRoster.battleId).toBe(2);
    });
});
