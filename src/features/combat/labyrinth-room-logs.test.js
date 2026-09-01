/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, d) => d, Z_FLOATING_PANEL: 1100 },
}));
const tick = vi.hoisted(() => ({
    status: { capturing: false, ticks: 0, seconds: 0, duplicatesDiscarded: 0, savedAt: null },
    calls: [],
}));
vi.mock('./labyrinth-tick-capture.js', () => ({
    default: {
        captureStatus: () => ({ ...tick.status }),
        isCapturing: () => tick.status.capturing,
        startCapture: (...args) => tick.calls.push(['start', ...args]),
        stopCapture: () => tick.calls.push(['stop']),
        downloadCapture: () => {
            tick.calls.push(['download']);
            tick.status.savedAt = 123;
            return true;
        },
        clearCapture: () => {
            tick.calls.push(['clear']);
            tick.status = { capturing: false, ticks: 0, seconds: 0, duplicatesDiscarded: 0, savedAt: null };
        },
        captureFile: () => ({ ticks: [] }),
    },
}));
const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        },
        getJSON: async () => null,
        setJSON: async () => {},
        tryGet: async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        },
        set: async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
        getAllKeys: async (store = 'settings') => Array.from(storeFor(store).keys()),
    };
});
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => null,
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));

const { groupByFloor, floorSummary, labyrinthRoomLogs, ROOM_TRAVEL_SECONDS, sessionIdentity } =
    await import('./labyrinth-room-logs.js');
const { default: labFightRecorder } = await import('./labyrinth-fight-recorder.js');
const { FINGERPRINT_VERSION } = await import('./labyrinth-fingerprint.js');

const room = (over = {}) => ({
    runKey: 'run|15',
    floor: 15,
    startedAt: 1_000_000,
    endedAt: 1_060_000,
    xp: 30_000,
    completed: true,
    ...over,
});

describe('groupByFloor', () => {
    test('splits a newest-first list into floors', () => {
        const groups = groupByFloor([
            room(),
            room(),
            room({ runKey: 'run|14', floor: 14 }),
            room({ runKey: 'run|13', floor: 13 }),
        ]);
        expect(groups.map((g) => g.floor)).toEqual([15, 14, 13]);
        expect(groups[0].sessions).toHaveLength(2);
    });

    test('a floor revisited on a later run is its own group', () => {
        // Merging every session sharing a floor number would blend two separate
        // visits into one throughput figure
        const groups = groupByFloor([room({ runKey: 'runB|3', floor: 3 }), room({ runKey: 'runA|3', floor: 3 })]);
        expect(groups).toHaveLength(2);
        expect(groups.every((g) => g.floor === 3)).toBe(true);
    });

    test('survives rooms logged before floors were recorded', () => {
        const groups = groupByFloor([{ startedAt: 1 }, { startedAt: 2 }]);
        expect(groups).toHaveLength(1);
        expect(groups[0].floor).toBe(0);
    });

    test('handles nothing at all', () => {
        expect(groupByFloor(null)).toEqual([]);
    });
});

describe('floorSummary', () => {
    test('adds up time, experience and clears', () => {
        const summary = floorSummary([room(), room({ endedAt: 1_120_000, xp: 30_000, completed: false })]);
        expect(summary).toMatchObject({ rooms: 2, cleared: 1, seconds: 180, xp: 60_000 });
        // 180s in the rooms plus the walk to each of the two
        expect(summary.chargedSeconds).toBe(180 + 2 * ROOM_TRAVEL_SECONDS);
        expect(summary.xpPerHour).toBeCloseTo((60_000 / 182) * 3600, 6);
    });

    test('the rate charges the walk to each room, as the forecast does', () => {
        // Same denominator both sides, or the measured rate cannot be set
        // against the predicted one — which is the only reason it is shown
        const summary = floorSummary([room()]);
        expect(summary.seconds).toBe(60);
        expect(summary.chargedSeconds).toBe(60 + ROOM_TRAVEL_SECONDS);
        expect(summary.xpPerHour).toBeCloseTo((30_000 / 61) * 3600, 6);
    });

    test('a room still running contributes no time, and no walk either', () => {
        // An unfinished room has no duration yet, and guessing one would make
        // the floor's rate lurch about while you are standing in it
        const summary = floorSummary([room({ endedAt: 0, xp: 0 })]);
        expect(summary.seconds).toBe(0);
        expect(summary.chargedSeconds).toBe(0);
        expect(summary.xpPerHour).toBeNull();
    });

    test('no experience measured means no rate, not a rate of zero', () => {
        expect(floorSummary([room({ xp: 0 })]).xpPerHour).toBeNull();
    });

    test('handles an empty floor', () => {
        expect(floorSummary([])).toMatchObject({ rooms: 0, cleared: 0, xpPerHour: null });
    });
});

describe('combatMeta reconciles the watched tally against the server count', () => {
    const session = (over = {}) => ({
        predicted: 0.458,
        actions: [],
        entryCount: 0,
        startedAt: 1_000,
        endedAt: 2_000,
        xp: 0,
        ...over,
    });

    test('shows the server total when it counted more attempts than were watched', () => {
        const meta = labyrinthRoomLogs.combatMeta(
            session({ actions: [{ outcome: 'death' }, { outcome: 'death' }, { outcome: 'timeout' }], entryCount: 26 })
        );
        expect(meta).toContain('Won 0/3');
        expect(meta).toContain('· 26 total');
    });

    test('says none were watched when the server counted attempts but no battle data arrived', () => {
        expect(labyrinthRoomLogs.combatMeta(session({ actions: [], entryCount: 26 }))).toContain(
            '26 attempts, none watched'
        );
    });

    test('adds no server clause when the watched count already matches the server', () => {
        const meta = labyrinthRoomLogs.combatMeta(session({ actions: [{ outcome: 'clear' }], entryCount: 1 }));
        expect(meta).toContain('Won 1/1');
        expect(meta).not.toContain('total');
    });

    test('falls back to "No result yet" when nothing is known from either side', () => {
        expect(labyrinthRoomLogs.combatMeta(session({ actions: [], entryCount: 0 }))).toContain('No result yet');
    });
});

describe('the sim accuracy list opens a room type at a time', () => {
    const row = (level, over = {}) => ({
        subjectHrid: '/skills/milking',
        kind: 'skilling',
        monster: 'milking',
        level,
        attempts: 2,
        clears: 1,
        predicted: 0.5,
        observed: 0.5,
        low: 0.1,
        high: 0.9,
        likelihood: 0.5,
        verdict: 'consistent',
        measured: null,
        timing: null,
        rates: null,
        ...over,
    });

    const snapshot = {
        rows: [row(173), row(186), row(191)],
        summary: { buckets: 3, attempts: 6, clears: 3, judged: 6, judgedClears: 3, expected: 3, contested: 0 },
        bySubject: [
            {
                subjectHrid: '/skills/milking',
                kind: 'skilling',
                monster: 'milking',
                levels: 3,
                lowestLevel: 173,
                highestLevel: 191,
                attempts: 6,
                clears: 3,
                judged: 6,
                judgedClears: 3,
                expected: 3,
                predicted: 0.5,
                observed: 0.5,
                low: 0.2,
                high: 0.8,
                offBy: 0,
                verdict: 'consistent',
            },
        ],
    };

    const text = () => document.querySelector('.mwi-lab-logs-list').textContent;
    const cards = () => document.querySelectorAll('.mwi-lab-logs-list > div');

    beforeEach(async () => {
        document.body.innerHTML = '';
        labyrinthRoomLogs.panel = null;
        labyrinthRoomLogs.view = 'accuracy';
        labyrinthRoomLogs.expandedSubjects = new Set();
        labyrinthRoomLogs.replayResult = null;
        labyrinthRoomLogs.simSource = { accuracy: async () => snapshot };
        // The fight recorder's pool is a module-level singleton other tests in
        // this file fill. Any fight in it adds a reliability card above the room
        // list, which moves the cards these tests click by index — so start from
        // an empty pool rather than from whatever ran before.
        labFightRecorder.clearRecording();
        await labyrinthRoomLogs.renderAccuracy();
    });

    test('a room type starts closed, showing its pooled reading only', () => {
        // The record runs to a couple of hundred rooms; opening on all of them
        // is a wall rather than a list
        // Not a bare 'Lv.173' — the pooled row names the range it covers
        expect(text()).toContain('Milking — all levels');
        expect(text()).not.toContain('Milking Lv.173');
    });

    test('and says there is something behind it', () => {
        expect(text()).toContain('click to open');
    });

    test('clicking it shows its levels', async () => {
        [...cards()][1].click();
        await labyrinthRoomLogs.renderAccuracy();

        expect(text()).toContain('Milking Lv.173');
        expect(text()).toContain('Milking Lv.191');
    });

    test('and clicking it again puts them away', async () => {
        [...cards()][1].click();
        await labyrinthRoomLogs.renderAccuracy();
        [...cards()][1].click();
        await labyrinthRoomLogs.renderAccuracy();

        expect(text()).not.toContain('Milking Lv.173');
    });

    test('a replay result draws above the record with its diagnosis and rates', async () => {
        labyrinthRoomLogs.replayResult = {
            groups: [
                {
                    monsterHrid: '/monsters/cyclops',
                    monsterName: 'Cyclops',
                    roomLevel: 200,
                    fights: 6,
                    clears: 2,
                    metrics: [
                        {
                            key: 'dps',
                            label: 'Your damage / s',
                            observed: 8000,
                            predicted: 10000,
                            deviationPct: -20,
                            marginPct: 3,
                            verdict: 'below',
                        },
                        {
                            key: 'taken',
                            label: 'Monster damage / s',
                            observed: 500,
                            predicted: 500,
                            deviationPct: 0,
                            marginPct: 3,
                            verdict: 'consistent',
                        },
                    ],
                    diagnosis: 'Sim over-credits your damage: real fights kill the monster slower.',
                },
            ],
            recordedAt: 123,
        };
        await labyrinthRoomLogs.renderAccuracy();

        expect(text()).toContain('Calibration replay');
        expect(text()).toContain('Cyclops');
        expect(text()).toContain('over-credits your damage');
        expect(text()).toContain('Your damage / s');
        // The observed-vs-sim figure and its deviation both read out
        expect(text()).toContain('vs sim');
    });

    test("the per-source tally says what the sim's damage is made of", async () => {
        labyrinthRoomLogs.replayResult = {
            groups: [
                {
                    monsterHrid: '/monsters/pyre_hunter',
                    monsterName: 'Pyre Hunter',
                    roomLevel: 230,
                    fights: 6,
                    clears: 2,
                    metrics: [
                        {
                            key: 'dotPerSwing',
                            label: 'DoT ticks / swing',
                            observed: 0.26,
                            predicted: 0.1,
                            deviationPct: 160,
                            marginPct: 10,
                            verdict: 'above',
                        },
                    ],
                    simTally: {
                        sources: [
                            {
                                source: 'autoAttack',
                                landedHits: 100,
                                misses: 20,
                                totalDamage: 22000,
                                meanDamage: 220,
                                shareOfLandedHits: 0.8,
                            },
                            {
                                source: 'damageOverTime',
                                landedHits: 25,
                                misses: 0,
                                totalDamage: 2000,
                                meanDamage: 80,
                                shareOfLandedHits: 0.2,
                            },
                            // Nothing landed, so it has no mean and no row
                            {
                                source: '/abilities/maim',
                                landedHits: 0,
                                misses: 4,
                                totalDamage: 0,
                                meanDamage: null,
                                shareOfLandedHits: 0,
                            },
                        ],
                        swings: 100,
                        dotTicks: 25,
                        dotPerSwing: 0.25,
                    },
                    diagnosis: 'Sim over-credits your damage.',
                },
            ],
        };
        await labyrinthRoomLogs.renderAccuracy();

        expect(text()).toContain('Sim damage by source');
        expect(text()).toContain('Auto attack');
        expect(text()).toContain('Damage over time');
        // Share of landed hits and the mean each source lands for
        expect(text()).toContain('20.0%');
        // A ratio reads to two places, not as a percentage
        expect(text()).toContain('0.26 vs sim 0.10');
        // A source that never landed has no mean to print and is left out
        expect(text()).not.toContain('Maim');
    });

    test('one room type opening does not open the others', async () => {
        labyrinthRoomLogs.simSource = {
            accuracy: async () => ({
                ...snapshot,
                rows: [...snapshot.rows, row(200, { subjectHrid: '/skills/brewing', monster: 'brewing' })],
                bySubject: [
                    ...snapshot.bySubject,
                    { ...snapshot.bySubject[0], subjectHrid: '/skills/brewing', monster: 'brewing', levels: 1 },
                ],
            }),
        };
        labyrinthRoomLogs.expandedSubjects = new Set(['/skills/milking']);
        await labyrinthRoomLogs.renderAccuracy();

        expect(text()).toContain('Milking Lv.173');
        expect(text()).not.toContain('Brewing Lv.200');
    });
});

describe('the accuracy view keeps sim-model cohorts apart', () => {
    const snapshot = (cohort) => ({
        rows: [
            {
                subjectHrid: '/monsters/mimic',
                kind: 'combat',
                monster: 'mimic',
                level: 252,
                attempts: 21,
                clears: 0,
                predicted: 0.244,
                observed: 0,
                low: 0,
                high: 0.15,
                likelihood: 0.003,
                verdict: 'sim too high',
                measured: null,
                timing: null,
                fightLength: null,
                rates: null,
            },
        ],
        summary: {
            buckets: 1,
            attempts: 21,
            clears: 0,
            judged: 21,
            judgedClears: 0,
            expected: 5.1,
            sd: 2,
            sigma: -2.5,
            contested: 1,
            contestedByChance: 0.3,
            cohort,
        },
        bySubject: [],
        baselineAt: null,
        since: false,
    });

    const setup = async (snap) => {
        document.body.innerHTML = '';
        labyrinthRoomLogs.panel = null;
        labyrinthRoomLogs.view = 'accuracy';
        labyrinthRoomLogs.replayResult = null;
        labyrinthRoomLogs.expandedSubjects = new Set();
        labyrinthRoomLogs.simSource = { accuracy: async () => snap };
        await labyrinthRoomLogs.renderAccuracy();
    };

    const text = () => document.querySelector('.mwi-lab-logs-list').textContent;

    afterEach(() => {
        labFightRecorder.clearRecording();
    });

    test('legacy fights are excluded from the headline and counted in a one-line note', async () => {
        await setup(
            snapshot({ judged: 0, judgedClears: 0, expected: null, sd: null, sigma: null, legacyExcluded: 21 })
        );
        expect(text()).toContain('21 older fights from a previous sim model excluded');
        expect(text()).toContain('No fights under the current sim model');
        // The pooled expectation must not headline as if the old model still claimed it
        expect(text()).not.toContain('expected 5.1 clears');
    });

    test('a current-model cohort headlines with its own expectation', async () => {
        await setup(snapshot({ judged: 10, judgedClears: 4, expected: 4.4, sd: 1.5, sigma: -0.3, legacyExcluded: 11 }));
        expect(text()).toContain('Over the 10 it had a rate for, the sim expected 4.4 clears');
        expect(text()).toContain('11 older fights from a previous sim model excluded');
    });

    const fight = (predicted, cleared) => ({
        monsterHrid: '/monsters/cyclops',
        roomLevel: 200,
        seconds: 40,
        outcome: cleared ? 'clear' : 'death',
        cleared,
        monsterMaxHp: 1000,
        monsterHpEnd: cleared ? 0 : 300,
        playerMaxHp: 500,
        playerHpStart: 500,
        playerHpEnd: cleared ? 200 : 0,
        predicted,
    });

    test('recorded fights with stored predictions draw the reliability bands', async () => {
        // Enough to be a reading rather than "too few to call"
        for (let i = 0; i < 10; i++) {
            labFightRecorder.noteAttempt(fight(0.8, true));
            labFightRecorder.noteAttempt(fight(0.8, false));
        }
        await setup(snapshot(undefined));

        expect(text()).toContain('Reliability — stored predictions vs outcomes');
        expect(text()).toContain('70–90%');
        expect(text()).toContain('expected 16.0');
        expect(text()).toContain('Brier');
    });

    test('a cohort too thin to judge says so instead of quoting a Brier score', () => {
        const current = (predicted, cleared) => ({
            ...fight(predicted, cleared),
            model: { fullKit: true },
            fingerprintVersion: FINGERPRINT_VERSION,
        });
        const card = labyrinthRoomLogs.renderReliability([current(0.8, true), current(0.8, false)]);

        expect(card.textContent).toContain('too few to call');
        expect(card.textContent).not.toContain('Brier');
    });

    test('a pool of pre-migration fights is not pooled to reach the bar', async () => {
        // Thirty fights of history, all from before the fingerprint learned
        // about combat levels, and two on the current one. The card reports
        // two — too few to call — and names what it set aside.
        const pool = [];
        for (let i = 0; i < 30; i++) {
            const stored = { ...fight(0.8, true), model: { fullKit: true, version: '3.0.0' }, complete: true };
            delete stored.fingerprintVersion;
            pool.push(stored);
        }
        const card = labyrinthRoomLogs.renderReliability([
            ...pool,
            { ...fight(0.8, true), model: { fullKit: true }, fingerprintVersion: FINGERPRINT_VERSION },
            { ...fight(0.8, false), model: { fullKit: true }, fingerprintVersion: FINGERPRINT_VERSION },
        ]);

        expect(card.textContent).toContain('2 fights with a stored prediction — too few to call');
        expect(card.textContent).toContain('30 older fights from a previous build fingerprint excluded');
        expect(card.textContent).not.toContain('Brier');
    });

    test('the sanitized export is offered on the accuracy view, labelled for public bug reports', async () => {
        await setup(snapshot(undefined));
        expect(labyrinthRoomLogs.sanitizedButton.style.display).not.toBe('none');
        expect(labyrinthRoomLogs.sanitizedButton.title).toContain('public bug report');
    });
});

describe('marking a point to measure from', () => {
    const ROW = {
        subjectHrid: '/skills/milking',
        kind: 'skilling',
        monster: 'milking',
        level: 200,
        attempts: 2,
        clears: 1,
        predicted: 0.5,
        observed: 0.5,
        low: 0.1,
        high: 0.9,
        likelihood: 0.5,
        verdict: 'consistent',
        measured: null,
        timing: null,
        fightLength: null,
        rates: null,
    };

    const snapshot = (over = {}) => ({
        rows: [ROW],
        summary: {
            buckets: 1,
            attempts: 2,
            clears: 1,
            judged: 2,
            judgedClears: 1,
            expected: 1,
            sd: null,
            sigma: null,
            contested: 0,
            contestedByChance: 0,
        },
        bySubject: [],
        baselineAt: null,
        since: false,
        ...over,
    });

    let marked;
    let cleared;
    let asked;

    const setup = async (snap) => {
        document.body.innerHTML = '';
        labyrinthRoomLogs.panel = null;
        labyrinthRoomLogs.view = 'accuracy';
        labyrinthRoomLogs.sinceBaseline = false;
        marked = 0;
        cleared = 0;
        asked = [];
        labyrinthRoomLogs.simSource = {
            accuracy: async (options) => {
                asked.push(options);
                return snap;
            },
            markBaseline: async () => {
                marked += 1;
            },
            clearBaseline: async () => {
                cleared += 1;
            },
        };
        await labyrinthRoomLogs.renderAccuracy();
    };

    const text = () => document.querySelector('.mwi-lab-logs-list').textContent;
    const click = (label) => {
        const found = [...document.querySelectorAll('.mwi-lab-logs-list span')].find(
            (span) => span.textContent === label
        );
        found.click();
        return found;
    };

    test('is offered before there is one', async () => {
        await setup(snapshot());
        expect(text()).toContain('mark a point to measure from');
    });

    test('and marking one switches to the period since', async () => {
        await setup(snapshot());
        click('mark a point to measure from');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(marked).toBe(1);
        expect(labyrinthRoomLogs.sinceBaseline).toBe(true);
    });

    test('the view asks for the period it is showing', async () => {
        await setup(snapshot({ baselineAt: Date.now() }));
        expect(asked.at(-1)).toEqual({ since: false });

        labyrinthRoomLogs.sinceBaseline = true;
        await labyrinthRoomLogs.renderAccuracy();
        expect(asked.at(-1)).toEqual({ since: true });
    });

    test('both views are reachable from either', async () => {
        await setup(snapshot({ baselineAt: Date.now() }));
        expect(text()).toContain('show only since then');

        await setup(snapshot({ baselineAt: Date.now(), since: true }));
        expect(text()).toContain('show everything');
    });

    test('forgetting the mark leaves the record alone and returns to everything', async () => {
        await setup(snapshot({ baselineAt: Date.now(), since: true }));
        labyrinthRoomLogs.sinceBaseline = true;
        click('forget the mark');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(cleared).toBe(1);
        expect(labyrinthRoomLogs.sinceBaseline).toBe(false);
    });

    test('a period with nothing in it still offers a way back', async () => {
        // Otherwise the only escape from an empty view is a page reload
        await setup(snapshot({ rows: [], baselineAt: Date.now(), since: true }));

        expect(text()).toContain('Nothing recorded since the mark');
        expect(text()).toContain('show everything');
    });

    test('and Reset is still there, because it answers a different question', () => {
        expect(labyrinthRoomLogs.clearButton.textContent).toBe('Reset');
    });
});

describe('the fight recorder path measures whole fights', () => {
    const context = () => ({
        runKey: 'run|10',
        roomKey: '2,3',
        floor: 10,
        room: { monsterHrid: '/monsters/cyclops', recommendedLevel: 200, entryCount: 1 },
    });

    // The full start snapshot, `new_battle` spelling: long field names,
    // players/monsters as arrays
    const newBattle = (monsterHp, over = {}) => ({
        players: [
            {
                currentHitpoints: 500,
                maxHitpoints: 500,
                atkCounter: 0,
                currentManapoints: 100,
                isPreparingAutoAttack: true,
            },
        ],
        monsters: [{ currentHitpoints: monsterHp, maxHitpoints: 14320, dmgCounter: 0, critCounter: 0 }],
        ...over,
    });

    // A battle_updated delta — sparse: either unit may be absent
    const tick = ({ player, monster, battleId = 1 }) => ({
        battleId,
        pMap: player ? { 0: player } : {},
        mMap: monster ? { 0: monster } : {},
    });
    const p = (cHP, atk = 1) => ({ cHP, mHP: 500, atkCounter: atk, cMP: 90 });
    const m = (cHP, dmg = 0, crit = 0) => ({ cHP, mHP: 14320, dmgCounter: dmg, critCounter: crit });

    let noted;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        labyrinthRoomLogs.labContext = context();
        labyrinthRoomLogs.inLabyrinthFight = () => true;
        labyrinthRoomLogs.simSource = null;
        labyrinthRoomLogs.roomData = null;
        labyrinthRoomLogs.activeSession = null;
        labyrinthRoomLogs.fight = null;
        labyrinthRoomLogs.sessions = [];
        noted = vi.spyOn(labFightRecorder, 'noteAttempt');
    });

    afterEach(() => {
        // The singleton remembers its fight between tests, which is right for
        // a recorder and wrong for a test
        labyrinthRoomLogs.fight = null;
        if (labyrinthRoomLogs.fightTimer) {
            clearTimeout(labyrinthRoomLogs.fightTimer);
            labyrinthRoomLogs.fightTimer = null;
        }
        labyrinthRoomLogs.flushReport();
        labyrinthRoomLogs.activeSession = null;
        labyrinthRoomLogs.sessions = [];
        labyrinthRoomLogs.labContext = null;
        labyrinthRoomLogs.simSource = null;
        delete labyrinthRoomLogs.inLabyrinthFight;
        noted.mockRestore();
        labFightRecorder.clearRecording();
        vi.useRealTimers();
    });

    test('the opening hit between the snapshot and the first retained tick is counted', () => {
        // The reviewer's capture: monster spawns at 14320, the first retained
        // battle_updated already shows 14024 — a 296 opening hit the recorder
        // used to silently baseline away
        labyrinthRoomLogs.onNewBattle(newBattle(14_320));
        expect(labyrinthRoomLogs.fight.caughtStart).toBe(true);

        vi.setSystemTime(1_001_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(500, 1), monster: m(14_024, 1) }));
        vi.setSystemTime(1_040_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(0, 2), monster: m(8_943, 2) }));
        labyrinthRoomLogs.resolveFight('stale');

        const attempt = noted.mock.calls.at(-1)[0];
        expect(attempt.monsterDamage).toBe(5_377); // 14320 − 8943, not 14024 − 8943
        expect(attempt.monsterHpStart).toBe(14_320);
        // Every point of endpoint damage was carried by the ticks
        expect(attempt.unattributedDealt).toBe(0);
        // The opening hit is attributed too, not only totalled
        expect(attempt.playerHits).toBe(2);
        expect(attempt.outcome).toBe('death');
        expect(attempt.complete).toBe(true);
        expect(attempt.resolveReason).toBe('stale');
    });

    test('consecutive new_battle snapshots split attempts even with an identical battleId', () => {
        // The labyrinth reuses battleId 1 for every retry, so the snapshot is
        // the only trustworthy boundary
        labyrinthRoomLogs.onNewBattle({ ...newBattle(14_320), battleId: 1 });
        vi.setSystemTime(1_005_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(400), monster: m(10_000, 1) }));

        vi.setSystemTime(1_010_000);
        labyrinthRoomLogs.onNewBattle({ ...newBattle(14_320), battleId: 1 });
        expect(noted).toHaveBeenCalledTimes(1);
        expect(noted.mock.calls[0][0].resolveReason).toBe('new_battle');

        // The second fight is seeded from its own snapshot, and the reset back
        // to full was not read as the first fight's healing
        expect(labyrinthRoomLogs.fight.caughtStart).toBe(true);
        expect(labyrinthRoomLogs.fight.prevMonsterHp).toBe(14_320);
        expect(labyrinthRoomLogs.fight.monsterHealed).toBe(0);

        vi.setSystemTime(1_015_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(0, 1), monster: m(9_000, 1) }));
        labyrinthRoomLogs.resolveFight('stale');
        expect(noted).toHaveBeenCalledTimes(2);
        expect(noted.mock.calls[1][0].monsterDamage).toBe(5_320);
    });

    test('single-unit ticks advance the fight instead of being dropped', () => {
        labyrinthRoomLogs.onNewBattle(newBattle(14_320));

        vi.setSystemTime(1_001_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ monster: m(14_000, 1) })); // monster only
        expect(labyrinthRoomLogs.fight.grossDealt).toBe(320);

        vi.setSystemTime(1_002_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(450) })); // player only
        expect(labyrinthRoomLogs.fight.grossTaken).toBe(50);

        vi.setSystemTime(1_005_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(0, 2), monster: m(9_000, 2) }));
        labyrinthRoomLogs.resolveFight('stale');

        const attempt = noted.mock.calls.at(-1)[0];
        expect(attempt.monsterDamage).toBe(5_320);
        expect(attempt.playerDamageTaken).toBe(500);
        // The monster-only tick's hit was attributed, not only totalled
        expect(attempt.playerHits).toBe(2);
        expect(attempt.unattributedDealt).toBe(0);
    });

    test('a fight joined mid-stream without a snapshot is marked incomplete', () => {
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(400), monster: m(9_000, 1) }));
        expect(labyrinthRoomLogs.fight.caughtStart).toBe(false);

        vi.setSystemTime(1_030_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(0, 2), monster: m(5_000, 2) }));
        labyrinthRoomLogs.resolveFight('room_switch');

        const attempt = noted.mock.calls.at(-1)[0];
        expect(attempt.outcome).toBe('death'); // known ending
        expect(attempt.complete).toBe(false); // but not measured whole
        expect(attempt.monsterHpStart).toBe(9_000); // where it was first seen, not full
        expect(attempt.resolveReason).toBe('room_switch');
    });

    test('a page loaded mid-fight learns its room from the init payload, so the fight is watched', async () => {
        // No labyrinth_updated has arrived: only the init character data says
        // which room the character is standing in
        const { default: dataManager } = await import('../../core/data-manager.js');
        labyrinthRoomLogs.labContext = null;
        dataManager.characterData = {
            labyrinth: {
                isActive: true,
                currentFloor: 10,
                startedAt: 'run',
                pathData: JSON.stringify([{ x: 2, y: 3 }]),
                roomData: { 3: { 2: { monsterHrid: '/monsters/cyclops', recommendedLevel: 200, entryCount: 3 } } },
            },
        };
        try {
            labyrinthRoomLogs.seedFromCharacterData();
            expect(labyrinthRoomLogs.labContext).toMatchObject({ runKey: 'run|10', roomKey: '2,3' });
            expect(labyrinthRoomLogs.labContext.room.monsterHrid).toBe('/monsters/cyclops');

            // The tick heuristic opens the fight — late, and honest about it
            labyrinthRoomLogs.onBattleUpdated(tick({ player: p(400), monster: m(9_000, 1) }));
            expect(labyrinthRoomLogs.fight.caughtStart).toBe(false);
            vi.setSystemTime(1_030_000);
            labyrinthRoomLogs.onBattleUpdated(tick({ player: p(0, 2), monster: m(5_000, 2) }));
            labyrinthRoomLogs.onNewBattle(newBattle(14_320)); // the retry files it
            expect(noted.mock.calls.at(-1)[0]).toMatchObject({ complete: false, resolveReason: 'new_battle' });

            // Seeding never overrides a context an update message has set
            dataManager.characterData.labyrinth.pathData = JSON.stringify([{ x: 0, y: 0 }]);
            labyrinthRoomLogs.seedFromCharacterData();
            expect(labyrinthRoomLogs.labContext.roomKey).toBe('2,3');
        } finally {
            delete dataManager.characterData;
        }
    });

    test('a fight cannot be opened from half a tick', () => {
        labyrinthRoomLogs.onBattleUpdated(tick({ monster: m(9_000, 1) }));
        expect(labyrinthRoomLogs.fight).toBeNull();
    });

    test('the retry gap after the last tick is not billed to the fight', () => {
        labyrinthRoomLogs.onNewBattle(newBattle(14_320));
        vi.setSystemTime(1_020_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(0, 1), monster: m(9_000, 1) }));

        // Ticks stop; the stale timer files the fight 4 seconds later
        vi.advanceTimersByTime(4_000);

        const attempt = noted.mock.calls.at(-1)[0];
        expect(attempt.seconds).toBe(20); // last tick − snapshot, not +4s of silence
        expect(attempt.resolveReason).toBe('stale');
    });

    test('monster self-healing is recorded and reconciles the endpoints', () => {
        labyrinthRoomLogs.onNewBattle(newBattle(14_320));
        vi.setSystemTime(1_001_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(500, 1), monster: m(14_000, 1) }));
        vi.setSystemTime(1_002_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(500, 1), monster: m(14_100, 1) })); // heals 100
        vi.setSystemTime(1_010_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(0, 2), monster: m(9_000, 2) }));
        labyrinthRoomLogs.resolveFight('stale');

        const attempt = noted.mock.calls.at(-1)[0];
        expect(attempt.monsterHealed).toBe(100);
        // Drops: 320 + 5100; endpoints: 14320 − 9000 + 100 healed — the same
        expect(attempt.monsterDamage).toBe(5_420);
        expect(attempt.unattributedDealt).toBe(0);
    });

    test('a prediction landing mid-fight is still captured on ordinary ticks', () => {
        labyrinthRoomLogs.onNewBattle(newBattle(14_320));
        labyrinthRoomLogs.simSource = { forecast: () => ({ clearChance: 0.42 }) };
        vi.setSystemTime(1_010_000);
        labyrinthRoomLogs.onBattleUpdated(tick({ player: p(0, 1), monster: m(9_000, 1) }));
        labyrinthRoomLogs.resolveFight('stale');

        expect(noted.mock.calls.at(-1)[0].predicted).toBe(0.42);
    });

    test('unknown-outcome attempts stay out of the fight-length aggregate', () => {
        const recorded = [];
        labyrinthRoomLogs.simSource = { record: (entry) => recorded.push(entry) };
        labyrinthRoomLogs.reportRoomResult({
            subjectHrid: '/monsters/cyclops',
            roomLevel: 200,
            mode: 'combat',
            completed: false,
            startedAt: 0,
            endedAt: 60_000,
            xp: 0,
            actions: [
                { outcome: 'death', seconds: 40 },
                // Filed by a room switch mid-fight: its clock stopped early
                { outcome: 'unknown', seconds: 7, complete: false },
            ],
        });

        expect(recorded[0].fights).toBe(1);
        expect(recorded[0].fightSeconds).toBe(40);
        expect(recorded[0].fightSquares).toBe(1_600);
    });
});

describe('the capture button knows its three states', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        labyrinthRoomLogs.panel = null;
        tick.status = { capturing: false, ticks: 0, seconds: 0, duplicatesDiscarded: 0, savedAt: null };
        tick.calls = [];
        labyrinthRoomLogs.ensurePanel();
    });

    test('idle: plain Capture, no discard on offer', () => {
        expect(labyrinthRoomLogs.captureButton.textContent).toBe('Capture');
        expect(labyrinthRoomLogs.captureDiscardButton.style.display).toBe('none');
    });

    test('recording: the tick count is live, not painted once and left', () => {
        tick.status = { ...tick.status, capturing: true, ticks: 12 };
        labyrinthRoomLogs.paintCapture();
        expect(labyrinthRoomLogs.captureButton.textContent).toBe('Stop & save (12)');

        // More ticks arrive; the next paint (the 1s refresh) must show them
        tick.status.ticks = 40;
        labyrinthRoomLogs.paintCapture();
        expect(labyrinthRoomLogs.captureButton.textContent).toBe('Stop & save (40)');
    });

    test('stopped holding an unsaved capture: Save is offered, and Discard appears', () => {
        // The auto-stop case — the monster changed or the time limit hit
        tick.status = { ...tick.status, capturing: false, ticks: 300 };
        labyrinthRoomLogs.paintCapture();
        expect(labyrinthRoomLogs.captureButton.textContent).toBe('Save capture (300)');
        expect(labyrinthRoomLogs.captureDiscardButton.style.display).not.toBe('none');
    });

    test('clicking Save downloads the held capture and cannot start a new one over it', () => {
        tick.status = { ...tick.status, capturing: false, ticks: 300 };
        labyrinthRoomLogs.paintCapture();

        labyrinthRoomLogs.onCaptureClicked();

        expect(tick.calls).toContainEqual(['download']);
        expect(tick.calls.some(([what]) => what === 'start')).toBe(false);
        // Saved: the button falls back to a plain Capture
        expect(labyrinthRoomLogs.captureButton.textContent).toBe('Capture');
    });

    test('Discard throws the held capture away deliberately', () => {
        tick.status = { ...tick.status, capturing: false, ticks: 300 };
        labyrinthRoomLogs.paintCapture();

        labyrinthRoomLogs.captureDiscardButton.click();

        expect(tick.calls).toContainEqual(['clear']);
        expect(labyrinthRoomLogs.captureButton.textContent).toBe('Capture');
    });

    test('an already-saved capture offers a fresh start, not a second download', () => {
        tick.status = { ...tick.status, capturing: false, ticks: 300, savedAt: 99 };
        labyrinthRoomLogs.paintCapture();
        expect(labyrinthRoomLogs.captureButton.textContent).toBe('Capture');

        labyrinthRoomLogs.onCaptureClicked();
        expect(tick.calls.some(([what]) => what === 'start')).toBe(true);
    });

    test('discarded repeats are reported where there is room — the title', () => {
        tick.status = { ...tick.status, capturing: true, ticks: 50, duplicatesDiscarded: 7 };
        labyrinthRoomLogs.paintCapture();
        expect(labyrinthRoomLogs.captureButton.title).toContain('7 repeated ticks discarded');
    });
});

describe('the pool tab browses what the recorder holds', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        labyrinthRoomLogs.panel = null;
        labyrinthRoomLogs.expandedPoolGroups = new Set();
        labyrinthRoomLogs.poolAllGear = false;
        labyrinthRoomLogs.simSource = { fingerprint: () => 'fp-now' };
        labFightRecorder.clearRecording();
        const base = {
            monsterName: 'Cyclops',
            roomLevel: 200,
            seconds: 50,
            outcome: 'death',
            cleared: false,
            monsterMaxHp: 10_000,
            monsterHpEnd: 6_000,
            playerMaxHp: 500,
            playerHpStart: 500,
            playerHpEnd: 0,
            monsterDamage: 4_000,
            playerDamageTaken: 500,
            complete: true,
            fingerprint: 'fp-now',
        };
        for (let i = 0; i < 4; i++) labFightRecorder.noteAttempt({ ...base, monsterHrid: '/monsters/cyclops' });
        labFightRecorder.noteAttempt({
            ...base,
            monsterHrid: '/monsters/dryad',
            monsterName: 'Dryad',
            fingerprint: 'fp-old',
        });
        labyrinthRoomLogs.ensurePanel();
        labyrinthRoomLogs.view = 'pool';
    });

    afterEach(() => {
        labFightRecorder.clearRecording();
        labyrinthRoomLogs.simSource = null;
        labyrinthRoomLogs.view = 'rooms';
        labyrinthRoomLogs.panel = null;
    });

    const listText = () => labyrinthRoomLogs.panel.querySelector('.mwi-lab-logs-list').textContent;

    test('this gear by default, with the group summary drawn', () => {
        labyrinthRoomLogs.render(false);
        const text = listText();
        expect(text).toContain('4 fights over 1 monster/level group');
        expect(text).toContain('Cyclops');
        expect(text).not.toContain('Dryad'); // other gear
        expect(text).toContain('win 0%');
        expect(text).toContain('complete 100%');
    });

    test('four losses is under the gate, so no near-miss line is drawn at all', () => {
        labyrinthRoomLogs.render(false);
        expect(listText()).not.toContain('losses end with the monster');
    });

    test('the fifth loss earns the near-miss line, normalised against the monster maximum', () => {
        labFightRecorder.noteAttempt({
            monsterHrid: '/monsters/cyclops',
            monsterName: 'Cyclops',
            roomLevel: 200,
            seconds: 50,
            outcome: 'death',
            cleared: false,
            monsterMaxHp: 10_000,
            monsterHpEnd: 6_000,
            playerMaxHp: 500,
            playerHpStart: 500,
            playerHpEnd: 0,
            complete: true,
            fingerprint: 'fp-now',
        });

        labyrinthRoomLogs.render(false);
        // 6000 of 10000 left, five times over
        expect(listText()).toContain('losses end with the monster at 60% median (n=5)');
    });

    test('the header says how much of the pool was measured whole, and what closed the rest', () => {
        labFightRecorder.noteAttempt({
            monsterHrid: '/monsters/cyclops',
            monsterName: 'Cyclops',
            roomLevel: 200,
            seconds: 50,
            outcome: 'death',
            cleared: false,
            monsterMaxHp: 10_000,
            monsterHpEnd: 6_000,
            playerMaxHp: 500,
            playerHpStart: 500,
            playerHpEnd: 0,
            monsterDamage: 4_000,
            playerDamageTaken: 500,
            complete: false,
            resolveReason: 'stale',
            fingerprint: 'fp-now',
        });

        labyrinthRoomLogs.render(false);
        const text = listText();

        expect(text).toContain('4 of 5 complete');
        expect(text).toContain('1 stale');
        // The four fixture fights carry no resolveReason at all, and are filed as
        // unknown rather than being attributed to whatever closed the fifth
        expect(text).toContain('4 unknown');
    });

    test('the gear toggle widens the scope to everything recorded', () => {
        labyrinthRoomLogs.poolAllGear = true;
        labyrinthRoomLogs.render(false);
        const text = listText();
        expect(text).toContain('5 fights over 2 monster/level groups');
        expect(text).toContain('Dryad');
    });

    test('expanding a group lists its recent attempts', () => {
        labyrinthRoomLogs.expandedPoolGroups.add('/monsters/cyclops:200');
        labyrinthRoomLogs.render(false);
        expect(listText()).toContain('lvl 200 · 50s');
    });

    test('the clear button hides on the pool view — its reset lives on Accuracy', () => {
        labyrinthRoomLogs.render(false);
        labyrinthRoomLogs.paintChrome();
        expect(labyrinthRoomLogs.clearButton.style.display).toBe('none');
    });

    test('Save pool hands the recorder the summary to embed', () => {
        const spy = vi.spyOn(labFightRecorder, 'downloadRecording').mockReturnValue(true);
        labyrinthRoomLogs.render(false);
        const save = [...labyrinthRoomLogs.panel.querySelectorAll('button')].find((b) => b.textContent === 'Save pool');
        save.click();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0].poolSummary.length).toBeGreaterThan(0);
        spy.mockRestore();
    });

    test('nothing recorded on this gear says so rather than drawing a blank', () => {
        labFightRecorder.clearRecording();
        labyrinthRoomLogs.render(false);
        expect(listText()).toContain('No fights recorded on this gear yet');
    });
});

describe('the room log survives a failed read and a second tab', () => {
    const LOG_KEY = 'labyrinthRoomLogs_char1';
    const stored = () => storageMock.storeFor('settings').get(LOG_KEY)?.sessions;
    const roomAt = (startedAt, over = {}) => room({ startedAt, endedAt: startedAt + 60_000, ...over });

    beforeEach(() => {
        storageMock.reset();
        labyrinthRoomLogs.record.reset();
        labyrinthRoomLogs.sessions = [];
    });

    afterEach(() => {
        labyrinthRoomLogs.record.reset();
        labyrinthRoomLogs.sessions = [];
        storageMock.reset();
    });

    test('a room is told apart by its run and the moment it began', () => {
        expect(sessionIdentity(roomAt(5))).toBe('run|15|5');
        expect(sessionIdentity({ runKey: 'x' })).toBeNull();
    });

    test('a load that cannot read storage keeps the rooms already in memory', async () => {
        labyrinthRoomLogs.sessions = [roomAt(1)];
        labyrinthRoomLogs.record.set({ sessions: labyrinthRoomLogs.sessions });
        storageMock.unavailable = true;

        await labyrinthRoomLogs.record.load();
        labyrinthRoomLogs.adoptMerged();

        expect(labyrinthRoomLogs.sessions).toHaveLength(1);
    });

    test('a save while storage is unreadable is skipped and what is stored stays', async () => {
        labyrinthRoomLogs.sessions = [roomAt(1)];
        await labyrinthRoomLogs.persist();
        expect(stored()).toHaveLength(1);

        storageMock.unavailable = true;
        labyrinthRoomLogs.sessions = [roomAt(2), ...labyrinthRoomLogs.sessions];
        expect(await labyrinthRoomLogs.persist()).toBe(false);

        storageMock.unavailable = false;
        expect(stored()).toHaveLength(1);
        expect(labyrinthRoomLogs.sessions).toHaveLength(2);
    });

    test('a save folds in rooms another tab stored meanwhile, newest first', async () => {
        labyrinthRoomLogs.sessions = [roomAt(1)];
        await labyrinthRoomLogs.persist();
        storageMock.storeFor('settings').set(LOG_KEY, { sessions: [roomAt(3), roomAt(1)] });

        labyrinthRoomLogs.sessions = [roomAt(2), roomAt(1)];
        await labyrinthRoomLogs.persist();

        expect(stored().map((s) => s.startedAt)).toEqual([3, 2, 1]);
        expect(labyrinthRoomLogs.sessions.map((s) => s.startedAt)).toEqual([3, 2, 1]);
    });

    test('once storage reads again the next save lands everything', async () => {
        storageMock.unavailable = true;
        labyrinthRoomLogs.sessions = [roomAt(1)];
        await labyrinthRoomLogs.persist();
        labyrinthRoomLogs.sessions = [roomAt(2), ...labyrinthRoomLogs.sessions];
        await labyrinthRoomLogs.persist();
        expect(stored()).toBeUndefined();

        storageMock.unavailable = false;
        labyrinthRoomLogs.sessions = [roomAt(3), ...labyrinthRoomLogs.sessions];
        await labyrinthRoomLogs.persist();

        expect(stored().map((s) => s.startedAt)).toEqual([3, 2, 1]);
    });

    test('the tab keeps its own room objects through a merge', async () => {
        const mine = roomAt(1);
        labyrinthRoomLogs.sessions = [mine];
        await labyrinthRoomLogs.persist();

        expect(labyrinthRoomLogs.sessions[0]).toBe(mine);
    });
});

describe('teardown is awaitable, so the switch waits for the log to land', () => {
    const LOG_KEY = 'labyrinthRoomLogs_char1';
    const stored = () => storageMock.storeFor('settings').get(LOG_KEY)?.sessions;

    beforeEach(() => {
        storageMock.reset();
        labyrinthRoomLogs.record.reset();
        labyrinthRoomLogs.sessions = [];
    });

    afterEach(() => {
        labyrinthRoomLogs.record.reset();
        labyrinthRoomLogs.sessions = [];
        storageMock.reset();
    });

    test('disable() does not resolve until the finalized session is written', async () => {
        // `disable()` finalizes the room in progress and persists it, but the
        // write goes through the record's save chain, so it lands a microtask
        // or two later. The registry's `disableAllFeatures()` only waits for a
        // teardown that hands back a promise; without one, a character switch
        // moves `currentCharacterId` while this save is still queued and
        // `characterKey()` files this character's labyrinth rooms under the
        // arriving character's key — rooms they never ran.
        labyrinthRoomLogs.sessions = [];
        labyrinthRoomLogs.activeSession = room({ startedAt: 1, endedAt: 0, cleared: true, mode: 'combat' });

        await labyrinthRoomLogs.disable();

        expect(stored()?.map((s) => s.startedAt)).toEqual([1]);
    });

    test('disable() leaves no experience-grace timer to fire into a torn-down feature', async () => {
        // `disable()` flushes the pending report early on, then finalizes the
        // room in progress — and finalizing schedules the XP grace timer that
        // holds a finished room back for a few seconds in case its experience
        // has not been credited yet. Scheduled during a teardown, that timer
        // outlives the feature: it fires into a disabled module, and on a
        // character switch it fires after `currentCharacterId` has moved, so
        // the departing character's room is recorded against the arriving
        // character's sim record. There is no grace left to wait for once the
        // feature is going away, so the room is reported now instead.
        vi.useFakeTimers();
        const recorded = [];
        labyrinthRoomLogs.simSource = { record: (entry) => recorded.push(entry) };
        labyrinthRoomLogs.activeSession = room({
            subjectHrid: '/monsters/cyclops',
            roomLevel: 200,
            mode: 'combat',
            startedAt: 1,
            endedAt: 0,
            cleared: true,
            actions: [],
        });

        await labyrinthRoomLogs.disable();

        // Reported by the teardown itself, while the departing character is
        // still the current one
        expect(recorded).toHaveLength(1);
        expect(labyrinthRoomLogs.reportTimer).toBeNull();
        expect(labyrinthRoomLogs.pendingReport).toBeNull();

        // ...and nothing is left to go off afterwards
        vi.advanceTimersByTime(10 * 1000);
        expect(recorded).toHaveLength(1);

        vi.useRealTimers();
        labyrinthRoomLogs.simSource = null;
    });
});
