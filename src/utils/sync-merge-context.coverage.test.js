/**
 * Every real registered merge, handed a fold context, with values shaped the way the game and the owner store them.
 *
 * A merge's third parameter is the owner's business until the registry says otherwise, and `Function.length` does
 * not see a default, which is how `mergeBoards(base, incoming, now = Date.now())` took the upload's context for a
 * clock and stamped every board in the gist `NaN`. Nothing failed; the gist just stopped being readable. So this
 * imports every module that registers a merge (found by reading `src`, so a new one cannot be forgotten) and checks
 * the registry those imports built, the way `sync-merge-registry.coverage.test.js` checks its keys:
 *
 * 1. a merge that did not ask never receives a third argument, and one that reads the context did ask;
 * 2. no fold returns a NaN or an infinite number, or a value that reads back as nothing once it has been through JSON;
 * 3. no fold drops everything it was given;
 * 4. a merge that did not ask folds the same with a context as without.
 *
 * A registration with no entry in `FIXTURES` fails, so a new record has to say what it stores.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, test, expect, vi } from 'vitest';

const recorded = vi.hoisted(() => ({ options: [], calls: new Map() }));

vi.mock('./sync-merge-registry.js', async (importOriginal) => {
    const actual = await importOriginal();
    const registerSyncMerge = (options) => {
        recorded.options.push(options);
        const spied = (...args) => {
            recorded.calls.set(options.label, [...(recorded.calls.get(options.label) || []), args.length]);
            return options.merge(...args);
        };
        return actual.registerSyncMerge({ ...options, merge: spied });
    };
    return { ...actual, registerSyncMerge, default: { ...actual.default, registerSyncMerge } };
});

const { mergeForKey } = await import('./sync-merge-registry.js');

const SRC = fileURLToPath(new URL('..', import.meta.url));
/** Modules that define a registering helper rather than register anything by being imported */
const DEFINERS =
    /[\\/](sync-merge-registry|chunked-history|daily-checkpoints|alchemy-session-store|libraries[\\/]utils)\.js$/;
const REGISTERS = /\b(registerSyncMerge|createChunkedHistory|createDailyCheckpoints|createAlchemySessionStore)\(/;

/**
 * Every module under `src` that registers a merge when it is imported.
 * @param {string} directory - Absolute path to walk
 * @param {Array<string>} out - Accumulator
 * @returns {Array<string>} Absolute paths
 */
function registeringModules(directory, out = []) {
    for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
            registeringModules(full, out);
            continue;
        }
        if (!entry.endsWith('.js') || entry.includes('.test.') || DEFINERS.test(full)) continue;
        if (REGISTERS.test(readFileSync(full, 'utf8'))) out.push(full);
    }
    return out;
}

const modules = registeringModules(SRC);
for (const path of modules) {
    await import(/* @vite-ignore */ path.replace(/\\/g, '/'));
}

const NOW = Date.UTC(2026, 10, 3, 12);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EARLIER = NOW - 2 * DAY;
const LATER = NOW - DAY;
const FAR_AHEAD = NOW + 365 * DAY;
const CHAR = 'char-A';

const CHUNK = '2026-11-02';

/** A chunked history's record, deletions and legacy key: what each of the three labels stores */
const chunked = (recordPrefix, legacyBase, label, store, makeEntry) => ({
    [`${label} records`]: {
        store,
        key: `${recordPrefix}_${CHAR}_${CHUNK}`,
        a: [makeEntry(1, EARLIER)],
        b: [makeEntry(2, LATER)],
    },
    [`${label} deletions`]: {
        store,
        key: `${recordPrefix}Tomb_${CHAR}`,
        a: { one: { at: EARLIER, fp: 'fp-one', bulk: false } },
        b: { two: { at: LATER, fp: 'fp-two', bulk: true } },
    },
    [`${label} legacy key`]: {
        store,
        key: `${legacyBase}_${CHAR}`,
        a: [makeEntry(3, EARLIER)],
        b: [makeEntry(4, LATER)],
    },
});

const checkpoint = (n, at) => ({
    k: `${CHAR}|/skills/milking`,
    d: `2026-11-0${n}`,
    xp: 1000 * n,
    t: at,
});
const lootSession = (n, at) => ({
    startTime: new Date(at).toISOString(),
    actionHrid: '/actions/milking/cow',
    duration: 3600 * n,
    drops: { '/items/milk': 10 * n },
});
const dayRow = (n, at) => ({ d: new Date(at).toISOString().slice(0, 10), drinks: { '/items/milking_tea': n } });
const alchemySession = (n, at) => ({
    id: `s${n}`,
    startTime: at,
    lastAttemptTime: at + HOUR,
    inputItemHrid: '/items/holy_sword',
    attempts: n,
    successes: n,
    results: {},
});
const listing = (id, timestamp) => ({
    id,
    timestamp,
    createdTimestamp: new Date(timestamp).toISOString(),
    itemHrid: '/items/holy_sword',
    enhancementLevel: 3,
    price: 5000000,
    orderQuantity: 1,
    filledQuantity: 1,
    isSell: true,
    status: 'filled',
});
const dungeonRun = (at) => ({
    timestamp: new Date(at).toISOString(),
    duration: 600000,
    dungeonName: 'Chimerical Den',
    teamKey: '/players/1|/players/2',
    validated: true,
    source: 'chat',
});
const trade = (t, hrid = '/items/holy_sword') => ({
    listingId: 190000001,
    t,
    quantity: 2,
    itemHrid: hrid,
    enhancementLevel: 3,
    price: 5000000,
    isSell: true,
});
const trialWeek = (tile) => ({ weekStart: NOW - 3 * DAY, tiles: { [tile]: { tier: 3, at: LATER } }, history: [] });
const xpSamples = (t) => ({ '/skills/milking': [{ t, xp: t / 1000 }] });
const simRecord = (savedAt) => ({ savedAt, scriptVersion: '3.80.0', zones: { '/actions/combat/fly': { rate: 12 } } });
const combatSession = (key, at, zone) => ({
    key,
    combatStartTime: at,
    timestamp: at,
    durationSeconds: 600,
    zone,
    players: [{ name: 'One', damage: 1200 }],
});
const teammate = (id, name, updatedAt) => ({
    id,
    name,
    updatedAt,
    addedAt: updatedAt,
    source: 'editor',
    dto: {
        hrid: `player-${id}`,
        debuffOnLevelGap: 0.1,
        staminaLevel: 90,
        intelligenceLevel: 90,
        attackLevel: 90,
        meleeLevel: 90,
        defenseLevel: 90,
        rangedLevel: 1,
        magicLevel: 95,
        equipment: { '/equipment_types/main_hand': { hrid: '/items/rippling_trident', enhancementLevel: 10 } },
    },
});
const fight = (recordId, at, monsterHrid) => ({
    recordId,
    monsterHrid,
    roomLevel: 90,
    battleStartedAt: at,
    resolvedAt: at + 60000,
    won: true,
});

/**
 * What each registered label stores: two sides, as the owner writes them. Nonzero levels, real hrids, both sides
 * holding something the other lacks. Stamps run to a far-future one where the fold has a clock to read.
 * @type {Record<string, {store: string, key: string, a: *, b: *}>}
 */
const FIXTURES = {
    ...chunked('abilityCheckpointRec', 'abilityCheckpoints', 'AbilityCheckpoints', 'xpHistory', checkpoint),
    ...chunked('skillCheckpointRec', 'skillCheckpoints', 'SkillCheckpoints', 'xpHistory', checkpoint),
    ...chunked('lootLogRec', 'lootLog', 'LootLogHistory', 'lootLogHistory', lootSession),
    ...chunked('coinifySessionsRec', 'coinifySessions', 'CoinifyHistoryTracker', 'alchemyHistory', alchemySession),
    ...chunked(
        'decomposeSessionsRec',
        'decomposeSessions',
        'DecomposeHistoryTracker',
        'alchemyHistory',
        alchemySession
    ),
    ...chunked(
        'transmuteSessionsRec',
        'transmuteSessions',
        'TransmuteHistoryTracker',
        'alchemyHistory',
        alchemySession
    ),
    ...chunked('itemFlowRec', 'itemFlow', 'ItemFlow', 'networthHistory', dayRow),
    ...chunked('chestOpenRec', 'chestOpenings', 'ChestOpenings', 'networthHistory', dayRow),
    ...chunked('combatLootRec', 'combatLoot', 'CombatLoot', 'networthHistory', dayRow),
    ...chunked('prodIncomeRec', 'prodIncome', 'ProductionIncome', 'networthHistory', dayRow),
    ...chunked('networthSeries', 'networth', 'NetworthHistory', 'networthHistory', (n, t) => ({ t, v: 1000000 * n })),
    ...chunked('taskCompletionRec', 'taskCompletions', 'TaskCompletionTracker', 'rerollSpending', (n, t) => ({
        taskId: 1000 + n,
        t,
        taskType: '/random_task_types/milking',
        rewards: { '/items/coin': 500 * n },
    })),
    ...chunked('marketListingArchiveRec', 'marketListingArchiveNever', 'ListingArchive', 'marketListings', (n, t) =>
        listing(190000000 + n, t)
    ),

    'Inventory reservations': {
        store: 'settings',
        key: `inventoryReservationLedger_${CHAR}`,
        a: { 'plan-1': { updatedAt: EARLIER, lines: [{ itemHrid: '/items/milk', count: 3 }] } },
        b: {
            'plan-2': { updatedAt: LATER, lines: [{ itemHrid: '/items/holy_sword', enhancementLevel: 3, count: 1 }] },
        },
    },
    'Replay check observations': {
        store: 'settings',
        key: `combatReplayCheck_observations_${CHAR}`,
        a: [{ recordedAt: EARLIER, recordingId: 'r1', zoneHrid: '/actions/combat/fly', difficultyTier: 2 }],
        b: [{ recordedAt: LATER, recordingId: 'r2', zoneHrid: '/actions/combat/rat', difficultyTier: 0 }],
    },
    'Replay check history': {
        store: 'settings',
        key: `combatReplayCheck_history_${CHAR}`,
        a: [{ at: EARLIER, zoneHrid: '/actions/combat/fly', ratio: 1.02 }],
        b: [{ at: LATER, zoneHrid: '/actions/combat/rat', ratio: 0.97 }],
    },
    'Dungeon run history': {
        store: 'unifiedRuns',
        key: 'allRuns',
        a: [dungeonRun(EARLIER)],
        b: [dungeonRun(LATER)],
    },
    'Dungeon runs removed': {
        store: 'unifiedRuns',
        key: 'allRunsDeleted',
        a: [{ id: 'run-1', at: EARLIER }],
        b: [{ id: 'run-2', at: LATER }],
    },
    'Dungeon run history clear': { store: 'unifiedRuns', key: 'allRunsClearedAt', a: EARLIER, b: LATER },
    'Dungeon run date-order repair': { store: 'unifiedRuns', key: 'allRunsDateOrderRepairedAt', a: EARLIER, b: LATER },
    'Dungeon average baselines': {
        store: 'unifiedRuns',
        key: 'dungeonAverageBaselines',
        a: { '/players/1::Chimerical Den': EARLIER, poison: FAR_AHEAD },
        b: { '/players/1::Sinister Circus': LATER },
    },
    'Labyrinth fights': {
        store: 'labyrinth',
        key: `labyrinthFightRecorder_${CHAR}`,
        a: [fight('f1', EARLIER, '/monsters/fly')],
        b: [fight('f2', LATER, '/monsters/rat')],
    },
    'Labyrinth fight outcomes': {
        store: 'settings',
        key: `labyrinthFightOutcomes_${CHAR}`,
        a: { version: 2, totals: { 'fly|90': { attempts: 4, rooms: 12, wins: 3, at: EARLIER } }, clearedAt: 0 },
        b: { version: 2, totals: { 'rat|95': { attempts: 3, rooms: 9, wins: 2, at: LATER } }, clearedAt: 0 },
    },
    'Labyrinth room logs': {
        store: 'settings',
        key: `labyrinthRoomLogs_${CHAR}`,
        a: { sessions: [{ runKey: 'run', startedAt: EARLIER }] },
        b: { sessions: [{ runKey: 'run', startedAt: LATER }] },
    },
    'Labyrinth run ledger': {
        store: 'labyrinth',
        key: `labyrinthRunLedger_${CHAR}`,
        a: [{ key: 'run-1', startedAt: EARLIER, floor: 12 }],
        b: [{ key: 'run-2', startedAt: LATER, floor: 13 }],
    },
    'Labyrinth best levels': {
        store: 'labyrinth',
        key: `monsterBestLevels_${CHAR}`,
        a: { '/monsters/fly': { bestLevel: 90, at: EARLIER } },
        b: { '/monsters/rat': { bestLevel: 95, at: LATER } },
    },
    'Saved meter sessions': {
        store: 'combatExport',
        key: `meterHistoryIndex_${CHAR}`,
        a: [{ id: 'm1', savedAt: EARLIER, name: 'Fly' }, { deleted: { m0: EARLIER } }],
        b: [{ id: 'm2', savedAt: LATER, name: 'Rat' }],
    },
    'Lab Sim comparison runs': {
        store: 'settings',
        key: `labSimComparisonRuns_${CHAR}`,
        a: [{ id: 'run-1', savedAt: EARLIER }],
        b: [{ id: 'run-2', savedAt: LATER }],
    },
    'Lab Sim comparison baseline': {
        store: 'settings',
        key: `labSimComparisonBaseline_${CHAR}`,
        a: { id: 'run-1', savedAt: EARLIER },
        b: { id: 'run-2', savedAt: LATER },
    },
    'Lab Sim skill loadouts': {
        store: 'settings',
        key: `labSimSkillingLoadouts_${CHAR}`,
        a: { '/skills/milking': { name: 'Milk', tea: '/items/milking_tea' } },
        b: { '/skills/foraging': { name: 'Forage', tea: '/items/foraging_tea' } },
    },
    'Combat Sim party finder roster': {
        store: 'settings',
        key: `combatSimPartyRoster_${CHAR}`,
        a: { savedAt: EARLIER, entries: [teammate('p1', 'One', EARLIER)], builds: [], removed: {} },
        b: { savedAt: LATER, entries: [teammate('p2', 'Two', LATER)], builds: [], removed: {} },
    },
    'Combat sessions': {
        store: 'combatStats',
        key: `combatSessionHistory_${CHAR}`,
        a: [combatSession('s1', EARLIER, '/actions/combat/fly')],
        b: [combatSession('s2', LATER, '/actions/combat/rat')],
    },
    'Guild loadout sightings': {
        store: 'guildHistory',
        key: `guildLoadouts_${CHAR}`,
        a: { players: { p1: { at: EARLIER, items: ['/items/holy_sword'] } }, updatedAt: EARLIER },
        b: { players: { p2: { at: LATER, items: ['/items/milk'] } }, updatedAt: LATER },
    },
    'Guild XP history': {
        store: 'guildHistory',
        key: 'guildXP_Some Guild',
        a: xpSamples(NOW - HOUR),
        b: xpSamples(NOW - 2 * HOUR),
    },
    'Guild member XP': {
        store: 'guildHistory',
        key: `memberXP_${CHAR}`,
        a: xpSamples(NOW - HOUR),
        b: xpSamples(NOW - 2 * HOUR),
    },
    'Guild leaderboard XP': {
        store: 'guildHistory',
        key: 'guildLeaderboardXP',
        a: xpSamples(NOW - HOUR),
        b: xpSamples(NOW - 2 * HOUR),
    },
    'Guild member skills': {
        store: 'guildHistory',
        key: 'guildMemberSkills_Some Guild',
        a: { One: { at: EARLIER, skills: { milking: 100 } } },
        b: { Two: { at: LATER, skills: { foraging: 110 } } },
    },
    'Guild trial ability plan': {
        store: 'guildHistory',
        key: 'guildTrialAbilityPlan_Some Guild',
        a: { savedAt: EARLIER, text: 'One: Fireball' },
        b: { savedAt: LATER, text: 'Two: Heal' },
    },
    'Guild trial ability session': {
        store: 'guildHistory',
        key: 'guildTrialAbilities_Some Guild',
        a: { startedAt: EARLIER, roster: ['One'], members: { One: { abilities: {} } } },
        b: { startedAt: EARLIER, roster: ['Two'], members: { Two: { abilities: {} } } },
    },
    'Guild trial records': {
        store: 'guildHistory',
        key: 'guildTrials_Some Guild',
        a: trialWeek('milking'),
        b: trialWeek('foraging'),
    },
    'Enhancement calibration': {
        store: 'lootLogHistory',
        key: `calibrationEnhancing_${CHAR}`,
        a: [{ id: 'e1', at: EARLIER, itemHrid: '/items/holy_sword', level: 5 }],
        b: [{ id: 'e2', at: LATER, itemHrid: '/items/holy_sword', level: 7 }],
    },
    'Prediction calibration': {
        store: 'lootLogHistory',
        key: `calibration_${CHAR}`,
        a: [{ id: 'c1', at: EARLIER, actionHrid: '/actions/milking/cow', actual: 1.1 }],
        b: [{ id: 'c2', at: LATER, actionHrid: '/actions/milking/cow', actual: 0.9 }],
    },
    'Custom inventory tabs': {
        store: 'settings',
        key: 'inventoryTabs_config',
        a: { tabs: [{ id: 't1', name: 'Milk', items: ['/items/milk'], updatedAt: EARLIER }], tombstones: {} },
        b: { tabs: [{ id: 't2', name: 'Swords', items: ['/items/holy_sword'], updatedAt: LATER }], tombstones: {} },
    },
    'Leaderboard XP': {
        store: 'leaderboardHistory',
        key: 'playerXP',
        a: { 'total_level|One': [{ t: EARLIER, xp: 1000 }] },
        b: { 'total_level|Two': [{ t: LATER, xp: 2000 }] },
    },
    'Leaderboard rank badges': {
        store: 'leaderboardHistory',
        key: 'rankBoards',
        a: {
            'standard|total_level': { at: EARLIER, source: 'local', rows: [['One', 7]] },
            'standard|milking': { at: FAR_AHEAD, source: 'server', rows: [['Fast', 90]] },
        },
        b: { 'standard|total_level': { at: LATER, source: 'server', rows: [['Two', 15]] } },
    },
    'ListingArchive permanent deletions': {
        store: 'marketListings',
        key: `marketListingArchiveGone_${CHAR}`,
        a: { clearedAt: 0, removed: { 190000001: EARLIER } },
        b: { clearedAt: 0, removed: { 190000002: LATER } },
    },
    'Market listing log': {
        store: 'marketListings',
        key: `marketListingTimestamps_${CHAR}`,
        a: [listing(190000001, EARLIER)],
        b: [listing(190000002, LATER)],
    },
    'Market listing anchors': {
        store: 'marketListings',
        key: 'marketListingAnchors',
        a: [{ id: 190000001, timestamp: EARLIER }],
        b: [{ id: 190000002, timestamp: LATER }],
    },
    'Market listing deletions': {
        store: 'marketListings',
        key: `marketListingGraves_${CHAR}`,
        a: { removed: { 190000001: EARLIER }, restored: [], clearedThrough: 0 },
        b: { removed: { 190000002: LATER }, restored: [], clearedThrough: 0 },
    },
    'Self-use marks': {
        store: 'settings',
        key: `selfUseWanted_${CHAR}`,
        a: { v: 2, items: ['/items/milk'], at: EARLIER },
        b: { v: 2, items: ['/items/holy_sword'], at: LATER },
    },
    'Personal trade prices': {
        store: 'settings',
        key: `tradeHistory_${CHAR}`,
        a: { '/items/milk:0': { buy: 10, buyAt: EARLIER } },
        b: { '/items/holy_sword:3': { sell: 5000000, sellAt: LATER } },
    },
    'Trade ledger fills': {
        store: 'marketListings',
        key: `tradeLedgerRecords_${CHAR}`,
        a: [trade(EARLIER)],
        b: [trade(LATER, '/items/milk')],
    },
    'Trade ledger fills (daily)': {
        store: 'marketListings',
        key: `tradeLedgerRec_${CHAR}_2026-11-02`,
        a: [trade(EARLIER)],
        b: [trade(LATER, '/items/milk')],
    },
    'Trade ledger baselines': {
        store: 'marketListings',
        key: `tradeLedgerState_${CHAR}`,
        a: { 190000001: { filledQuantity: 1, price: 5000000 } },
        b: { 190000002: { filledQuantity: 2, price: 4900000 } },
    },
    'Treasure tally': {
        store: 'settings',
        key: `treasureTally_${CHAR}`,
        a: { '/items/large_treasure_chest': { opened: 3, loot: { '/items/coin': 300 }, since: EARLIER } },
        b: { '/items/small_treasure_chest': { opened: 2, loot: { '/items/coin': 20 }, since: EARLIER } },
    },
    'Networth detail snapshots': {
        store: 'networthHistory',
        key: `networthDetail_${CHAR}_${EARLIER}`,
        a: { at: EARLIER, total: 1000000 },
        b: { at: EARLIER, total: 1000000 },
    },
    'Goal planner goals': {
        store: 'settings',
        key: `goalPlannerGoals_${CHAR}`,
        a: [{ id: 'g1', createdAt: EARLIER, itemHrid: '/items/holy_sword', targetLevel: 5 }],
        b: [{ id: 'g2', createdAt: LATER, itemHrid: '/items/milk', count: 100 }],
    },
    'Skill XP history': {
        store: 'xpHistory',
        key: `xpHistory_${CHAR}`,
        a: { '/skills/milking': [{ t: NOW - HOUR, xp: 1000 }] },
        b: { '/skills/foraging': [{ t: NOW - 2 * HOUR, xp: 2000 }] },
    },
    'Task reroll history': {
        store: 'rerollSpending',
        key: `taskRerollHistory_${CHAR}`,
        a: [{ taskId: 1001, retiredAt: EARLIER, coinRerollCount: 2 }],
        b: [{ taskId: 1002, retiredAt: LATER, cowbellRerollCount: 3 }],
    },
    'Overlay layouts': {
        store: 'settings',
        key: 'overlayLayouts',
        a: { Farming: { savedAt: EARLIER, panels: { a: { x: 1, y: 2 } } } },
        b: { Combat: { savedAt: LATER, panels: { b: { x: 3, y: 4 } } } },
    },
    'Single-zone sim rates': {
        store: 'combatExport',
        key: `zoneSimRates_${CHAR}`,
        a: { rates: { fly: { savedAt: EARLIER, rate: 12 } } },
        b: { rates: { rat: { savedAt: LATER, rate: 9 } } },
    },
    'All-zones sim snapshot': {
        store: 'combatExport',
        key: `allZonesSnapshot_${CHAR}`,
        a: simRecord(EARLIER),
        b: simRecord(LATER),
    },
    'Sim consumable rates': {
        store: 'combatExport',
        key: `simConsumableRates_${CHAR}`,
        a: simRecord(EARLIER),
        b: simRecord(LATER),
    },
    'Sim consumable rates by zone': {
        store: 'combatExport',
        key: `simConsumableRatesByZone_${CHAR}`,
        a: { fly: simRecord(EARLIER) },
        b: { rat: simRecord(LATER) },
    },
    Watchlist: {
        store: 'settings',
        key: `watchlist_${CHAR}`,
        a: { entries: [{ hrid: '/items/milk', level: 0 }], zones: {}, chests: {} },
        b: { entries: [{ hrid: '/items/holy_sword', level: 3 }], zones: {}, chests: {} },
    },
};

/*
 * The sim's choices and remembered results go through three plain folds (`sim-sync-keys.js`). Each key holds whatever
 * the sim wrote, so a stamped record stands for them all, read off the real registrations so a new key is covered.
 */
const PLAIN_FOLDS = new Set(['incomingWins', 'mergeFieldRecord', 'laterSavedAtWins']);
for (const { store, base, label, merge } of recorded.options) {
    if (!PLAIN_FOLDS.has(merge.name) || FIXTURES[label]) continue;
    FIXTURES[label] = { store, key: `${base}_${CHAR}`, a: simRecord(EARLIER), b: simRecord(LATER) };
}

const CONTEXTS = [{ forUpload: true }, { forUpload: false }, { download: true }];

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * Every number and string inside a value, its keys left out: a record's own field names and an empty shell of it
 * prove nothing was kept.
 * @param {*} value - Any JSON-ish value (a NaN stays a NaN)
 * @param {Array<*>} out - Accumulator
 * @returns {Array<*>} The leaves
 */
function leaves(value, out = []) {
    if (Array.isArray(value)) value.forEach((item) => leaves(item, out));
    else if (value && typeof value === 'object') Object.values(value).forEach((item) => leaves(item, out));
    else if (typeof value === 'number' || typeof value === 'string') out.push(value);
    return out;
}

/**
 * Whether a fold kept anything of what it was handed. A small number is a version or a count that an empty record
 * can carry too, so it does not count: a stamp, an id or a name does.
 * @param {*} result - What the fold returned
 * @param {Array<*>} inputs - What it was given
 * @returns {boolean} True when some telling leaf of an input is in the result
 */
function keptSomething(result, inputs) {
    const kept = new Set(leaves(result));
    return inputs.some((input) =>
        leaves(input).some((leaf) => kept.has(leaf) && (typeof leaf === 'string' || leaf >= 1000))
    );
}

const badNumbers = (value) => leaves(value).filter((leaf) => typeof leaf === 'number' && !Number.isFinite(leaf));

/** Which labels were registered, one row per distinct label: a chunked history's three, each sim key, each record */
const registered = () => [...new Map(recorded.options.map((options) => [options.label, options])).values()];

/**
 * The parameter list of a function, as written.
 * @param {Function} fn - Any function
 * @returns {Array<string>} Parameter names, defaults kept
 */
function paramsOf(fn) {
    const text = String(fn);
    const open = text.indexOf('(');
    let depth = 0;
    for (let index = open; index < text.length; index += 1) {
        if (text[index] === '(') depth += 1;
        if (text[index] === ')' && --depth === 0) {
            return text
                .slice(open + 1, index)
                .split(',')
                .map((param) => param.trim())
                .filter(Boolean);
        }
    }
    return [];
}

beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});

afterAll(() => {
    vi.useRealTimers();
});

describe('the enumeration is whole', () => {
    test('every module that registers a merge was found and every registration landed', () => {
        expect(modules.length).toBeGreaterThan(40);
        expect(registered().length).toBeGreaterThan(100);
    });

    test('every registered label says what it stores', () => {
        const missing = registered()
            .map((options) => options.label)
            .filter((label) => !FIXTURES[label]);

        expect(
            missing,
            'Give each new registration a fixture in FIXTURES: two sides, as the owner stores them'
        ).toEqual([]);
    });

    test('every fixture still resolves to the registration it is written for', () => {
        const wrong = Object.entries(FIXTURES)
            .filter(([label, { store, key }]) => mergeForKey(store, key)?.label !== label)
            .map(([label, { store, key }]) => `${label}: ${store}/${key} is ${mergeForKey(store, key)?.label}`);

        expect(wrong).toEqual([]);
    });
});

describe('who asks for the context', () => {
    /** Set apart so nobody widens it by accident: every fold that reads `forUpload` */
    const ASKING = /^(.+ (records|legacy key)|Labyrinth room logs|Market listing log)$/;

    test('a merge reads the context exactly when it asked for it', () => {
        const wrong = registered()
            .filter(
                (options) => /\bcontext\b|forUpload/.test(String(options.merge)) !== (options.wantsContext === true)
            )
            .map((options) => options.label);

        expect(wrong).toEqual([]);
    });

    test('the merges that ask are the ones that trim by a device setting', () => {
        const asking = registered().filter((options) => options.wantsContext === true);

        expect(asking.length).toBeGreaterThan(10);
        expect(asking.filter((options) => !ASKING.test(options.label)).map((options) => options.label)).toEqual([]);
    });

    test('the two merges with a third parameter of their own did not ask, and keep their default', () => {
        const own = registered().filter((options) => {
            const third = paramsOf(options.merge)[2];
            return third !== undefined && !third.startsWith('context');
        });

        expect(own.map((options) => [options.label, paramsOf(options.merge)[2]]).sort()).toEqual([
            ['Dungeon average baselines', 'now = Date.now()'],
            ['Leaderboard rank badges', 'now = Date.now()'],
        ]);
        expect(own.every((options) => options.wantsContext !== true)).toBe(true);
    });

    test("only the ledger's own pull takes a third parameter, and it reads that as the context", () => {
        const pulls = registered().filter((options) => typeof options.pull === 'function');

        expect(pulls.length).toBeGreaterThan(5);
        expect(pulls.filter((options) => paramsOf(options.pull).length > 2).map((options) => options.label)).toEqual([
            'Trade ledger fills (daily)',
        ]);
    });
});

describe.each(Object.entries(FIXTURES))('%s, handed a context', (label, { store, key, a, b }) => {
    const options = () => recorded.options.find((candidate) => candidate.label === label);

    test.each(CONTEXTS)('the upload fold with %j keeps the input, with no bad number', (context) => {
        const { merge } = mergeForKey(store, key);

        for (const [first, second] of [
            [a, b],
            [b, a],
        ]) {
            const result = merge(clone(first), clone(second), context);
            expect(badNumbers(result)).toEqual([]);
            expect(keptSomething(result, [first, second])).toBe(true);

            // What goes to the gist is this as JSON, and the next device folds that
            const stored = clone(result);
            const again = merge(stored, clone(stored), context);
            expect(keptSomething(again, [first, second])).toBe(true);
        }
    });

    test.each(CONTEXTS)('the pull fold with %j keeps the input, with no bad number', (context) => {
        const { mergeForPull } = mergeForKey(store, key);

        const result = mergeForPull(clone(a), clone(b), context);
        expect(badNumbers(result)).toEqual([]);
        expect(keptSomething(result, [a, b])).toBe(true);
    });

    test('a merge that did not ask folds the same with a context as without', () => {
        const { merge, mergeForPull } = mergeForKey(store, key);
        if (options().wantsContext === true) return;

        for (const context of CONTEXTS) {
            expect(merge(clone(a), clone(b), context)).toEqual(merge(clone(a), clone(b)));
            if (!options().pull) {
                expect(mergeForPull(clone(a), clone(b), context)).toEqual(mergeForPull(clone(a), clone(b)));
            }
        }
    });

    test('a merge that did not ask receives two arguments and no more', () => {
        const { merge, mergeForPull } = mergeForKey(store, key);
        if (options().wantsContext === true) return;
        recorded.calls.delete(label);

        merge(clone(a), clone(b), CONTEXTS[0]);
        if (!options().pull) mergeForPull(clone(a), clone(b), CONTEXTS[2]);

        expect(new Set(recorded.calls.get(label))).toEqual(new Set([2]));
    });
});
