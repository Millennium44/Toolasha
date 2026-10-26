/**
 * Reconciling the consumable trackers against `new_battle` snapshots.
 *
 * The player's own consumption is counted from consumable events, which only
 * arrive while the page is listening. Before this, a closed tab, a suspended
 * page or a reconnect left that consumption uncounted while its time stayed in
 * the rate, so the rate and the runway read low after every gap. Party members
 * were tracked from snapshots but any drop over 5 between two of them was
 * thrown away, which is every drop across a gap.
 *
 * Fixtures use the game's `new_battle` shape: `players[].character.{id,name}`
 * and `players[].combatConsumables[]` entries with full item hrids and numeric
 * counts.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    characterId: 'char-self',
    actions: [],
    actionDetails: {},
    /** Persisted records by full key */
    stored: new Map(),
    /** Called inside every storage.get, so a test can land a switch inside a read */
    onGet: null,
}));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: () => {},
        off: () => {},
        onSocketEvent: () => {},
        offSocketEvent: () => {},
        activeGameSocket: null,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        getCurrentActions: () => world.actions,
        getActionDetails: (hrid) => world.actionDetails[hrid] || null,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: () => 'ask' } }));
vi.mock('./combat-session-history.js', async () => {
    const actual = await vi.importActual('./combat-session-history.js');
    return { ...actual, archiveSession: vi.fn(async () => []) };
});
vi.mock('../../core/storage.js', () => {
    const get = async (key, _store, fallback = null) => {
        world.onGet?.(key);
        return world.stored.has(key) ? structuredClone(world.stored.get(key)) : fallback;
    };
    return {
        default: {
            get,
            getJSON: get,
            tryGet: async (key) =>
                world.stored.has(key) ? { found: true, value: world.stored.get(key) } : { found: false, value: null },
            set: async (key, value) => {
                if (value === null) world.stored.delete(key);
                else world.stored.set(key, structuredClone(value));
                return true;
            },
            setJSON: async () => true,
            delete: async () => true,
            getAllKeys: async () => [],
        },
    };
});

const { default: collector, _resetReadProbe } = await import('./combat-stats-data-collector.js');

const GUMMY = '/items/dragon_fruit_gummy';
const YOGURT = '/items/peach_yogurt';
const COFFEE = '/items/super_attack_coffee';
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);
const RUN = new Date(T0 - 3600 * 1000).toISOString();
const SECOND = 1000;
const HOUR = 3600 * SECOND;

/** One `combatConsumables` entry, as the game sends it */
const slot = (itemHrid, count) => ({
    itemHash: `char-self::/item_locations/inventory::${itemHrid}::0`,
    itemHrid,
    enhancementLevel: 0,
    count,
    availableTime: null,
});

/** One `players[]` entry */
const player = (id, name, consumables) => ({
    character: { id, name },
    combatConsumables: consumables,
    totalLootMap: {},
    totalSkillExperienceMap: {},
    deathCount: 0,
    combatDetails: { combatStats: {} },
});

/**
 * A `new_battle` message.
 * @param {Object} params
 * @returns {Object}
 */
const battle = ({ battleId = 1, wave = 0, runStart = RUN, self = [], others = [] } = {}) => ({
    type: 'new_battle',
    battleId,
    wave,
    combatStartTime: runStart,
    players: [player('char-self', 'Me', self), ...others],
    monsters: [],
});

/** A `battle_consumable_ability_updated` message for one use */
const used = (itemHrid, count) => ({
    type: 'battle_consumable_ability_updated',
    consumable: { itemHrid, count, enhancementLevel: 0 },
});

const self = () => collector.consumableTracker;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    world.characterId = 'char-self';
    world.actions = [];
    world.actionDetails = {};
    world.stored = new Map();
    world.onGet = null;
    _resetReadProbe();
    collector.isInitialized = false;
    collector.onCharacterSwitching();
    // The fresh tracker a cold page load starts with
    collector.consumableTracker.startTime = null;
    collector.currentBattleId = null;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the first battle after load', () => {
    test('with no prior count it only takes a baseline', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));

        expect(self().actualConsumed[GUMMY]).toBeUndefined();
        expect(self().inventoryAmount[GUMMY]).toBe(1000);
        expect(self().excludedMs).toBe(0);
        expect(self().lastObservedAt).toBe(T0);
    });

    test('after a reload it credits what was used while the page was closed, from the saved observation point', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        await collector.onConsumableUsed(used(GUMMY, 999));
        vi.advanceTimersByTime(10 * SECOND);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 999)] }));

        // Page closed for an hour; the character kept fighting
        collector.onCharacterSwitching();
        vi.advanceTimersByTime(HOUR);
        await collector.loadConsumableTracking();
        await collector.onNewBattle(battle({ battleId: 300, self: [slot(GUMMY, 939)] }));

        expect(self().actualConsumed[GUMMY]).toBe(61);
        // The hour was spent consuming, so it stays in the time base
        expect(self().excludedMs).toBe(0);
        expect(collector.calcElapsedSeconds()).toBeCloseTo(HOUR / SECOND + 10, 0);
    });

    test('a record saved by an older build is a fresh baseline, not a gap to credit', async () => {
        world.stored.set('consumableTracker_char-self', {
            actualConsumed: { [GUMMY]: 5 },
            defaultConsumed: { [GUMMY]: 10 },
            inventoryAmount: { [GUMMY]: 1000 },
            lastUpdate: T0 - 2 * HOUR,
            elapsedMs: 600 * SECOND,
            saveTimestamp: T0 - 2 * HOUR,
        });
        await collector.loadConsumableTracking();
        await collector.onNewBattle(battle({ battleId: 300, self: [slot(GUMMY, 900)] }));

        // Its elapsed time already left the closed hours out, so crediting them would inflate the rate
        expect(self().actualConsumed[GUMMY]).toBe(5);
        expect(self().lastObservedAt).toBe(T0);
        expect(collector.calcElapsedSeconds()).toBeCloseTo(600, 0);
    });
});

describe('a normal tick', () => {
    test('events count the uses and a matching snapshot adds nothing', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        vi.advanceTimersByTime(5 * SECOND);
        await collector.onConsumableUsed(used(GUMMY, 999));
        vi.advanceTimersByTime(10 * SECOND);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 999)] }));

        expect(self().actualConsumed[GUMMY]).toBe(1);
        expect(self().excludedMs).toBe(0);
    });

    test('a single event lost on a short gap is recovered from the snapshot', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        vi.advanceTimersByTime(15 * SECOND);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 999)] }));

        expect(self().actualConsumed[GUMMY]).toBe(1);
    });

    test('the event for a use the snapshot already credited is not counted again', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        vi.advanceTimersByTime(15 * SECOND);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 999)] }));
        // The use's event lands after the snapshot that already reflected it
        await collector.onConsumableUsed(used(GUMMY, 999));
        expect(self().actualConsumed[GUMMY]).toBe(1);

        // The next use counts as usual
        vi.advanceTimersByTime(60 * SECOND);
        await collector.onConsumableUsed(used(GUMMY, 998));
        expect(self().actualConsumed[GUMMY]).toBe(2);
    });

    test('a duplicated slot is reconciled once', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000), slot(GUMMY, 1000)] }));
        vi.advanceTimersByTime(HOUR);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 940), slot(GUMMY, 940)] }));

        expect(self().actualConsumed[GUMMY]).toBe(60);
    });
});

describe('a gap the page did not see', () => {
    test('with consumption: the drop is credited and the time kept', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000), slot(COFFEE, 500)] }));
        vi.advanceTimersByTime(HOUR);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 940), slot(COFFEE, 486)] }));

        expect(self().actualConsumed[GUMMY]).toBe(60);
        expect(self().actualConsumed[COFFEE]).toBe(14);
        expect(self().excludedMs).toBe(0);
        expect(collector.calcElapsedSeconds()).toBeCloseTo(3600, 0);
        // And the rate handed to the panel and the runway reflects it
        const row = collector.latestCombatData.players[0].consumables.find((c) => c.itemHrid === GUMMY);
        expect(row.actualConsumed).toBe(60);
        expect(row.elapsedSeconds).toBeCloseTo(3600, 0);
    });

    test('with a refill: nothing is consumption, and the unseen time is left out of the rate', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 100)] }));
        await collector.onConsumableUsed(used(GUMMY, 99));
        vi.advanceTimersByTime(HOUR);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 2000)] }));

        expect(self().actualConsumed[GUMMY]).toBe(1);
        expect(self().inventoryAmount[GUMMY]).toBe(2000);
        expect(self().excludedMs).toBe(HOUR);
        // Not an hour of one gummy: the hour's consumption is unknown, so the hour is not counted
        const row = collector.latestCombatData.players[0].consumables[0];
        expect(row.elapsedSeconds).toBeCloseTo(0, 0);
    });

    test('with a refill and use: a net drop within the cooldowns is credited as the net drop', async () => {
        // Refilled 20 and used 60 unseen: only the net 40 is visible
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        vi.advanceTimersByTime(HOUR);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 960)] }));

        expect(self().actualConsumed[GUMMY]).toBe(40);
        expect(self().excludedMs).toBe(0);
    });

    test('with a refill and use: a net rise credits nothing and the time is left out', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        await collector.onConsumableUsed(used(GUMMY, 999));
        vi.advanceTimersByTime(HOUR);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 1500)] }));

        expect(self().actualConsumed[GUMMY]).toBe(1);
        expect(self().excludedMs).toBe(HOUR);
    });

    test('a drop no cooldown allows (items sold or moved) is rejected and the time left out', async () => {
        await collector.onNewBattle(battle({ self: [slot(COFFEE, 5552)] }));
        await collector.onConsumableUsed(used(COFFEE, 5551));
        vi.advanceTimersByTime(11 * HOUR);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(COFFEE, 1667)] }));

        expect(self().actualConsumed[COFFEE]).toBe(1);
        expect(self().inventoryAmount[COFFEE]).toBe(1667);
        expect(self().excludedMs).toBe(11 * HOUR);
    });

    test('in a dungeon, only the waves fought count as time to have consumed in', async () => {
        const DUNGEON = '/actions/combat/pirate_cove';
        world.actions = [{ actionHrid: DUNGEON, isDone: false, type: '/action_types/combat' }];
        world.actionDetails[DUNGEON] = { combatZoneInfo: { isDungeon: true, dungeonInfo: { maxWaves: 65 } } };

        // About 15 s a wave
        for (let wave = 1; wave <= 5; wave++) {
            await collector.onNewBattle(battle({ battleId: 30, wave, self: [slot(GUMMY, 1000)] }));
            vi.advanceTimersByTime(15 * SECOND);
        }
        // Ten silent hours, but only two runs of waves (~32 minutes of fighting)
        vi.advanceTimersByTime(10 * HOUR);
        await collector.onNewBattle(battle({ battleId: 32, wave: 5, self: [slot(GUMMY, 700)] }));

        // 300 gummies in ~32 minutes at one a minute is impossible
        expect(self().actualConsumed[GUMMY]).toBeUndefined();
    });
});

describe('a new battle', () => {
    test('the next battleId of the same run is an ordinary tick', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        await collector.onConsumableUsed(used(GUMMY, 999));
        vi.advanceTimersByTime(20 * SECOND);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 999)] }));

        expect(self().actualConsumed[GUMMY]).toBe(1);
        expect(self().runKey).toBe(RUN);
    });

    test('a different run seen first after a reload starts over, whatever its battleId', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        await collector.onConsumableUsed(used(GUMMY, 999));
        vi.advanceTimersByTime(20 * SECOND);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 999)] }));

        // Closed for five hours; a new run began four hours ago and is well past battle 2
        collector.onCharacterSwitching();
        vi.advanceTimersByTime(5 * HOUR);
        await collector.loadConsumableTracking();
        const newRun = new Date(Date.now() - 4 * HOUR).toISOString();
        await collector.onNewBattle(battle({ battleId: 900, runStart: newRun, self: [slot(GUMMY, 700)] }));

        expect(self().actualConsumed[GUMMY]).toBeUndefined();
        expect(self().runKey).toBe(newRun);
        expect(self().inventoryAmount[GUMMY]).toBe(700);
    });
});

describe('a character swap mid-gap', () => {
    test("the arriving character starts from their own counts, never the departing one's", async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        vi.advanceTimersByTime(HOUR);

        collector.onCharacterSwitching();
        world.characterId = 'char-alt';
        await collector.loadConsumableTracking();
        await collector.onNewBattle({
            ...battle({ battleId: 5 }),
            players: [player('char-alt', 'Alt', [slot(GUMMY, 400)])],
        });

        expect(self().actualConsumed[GUMMY]).toBeUndefined();
        expect(self().inventoryAmount[GUMMY]).toBe(400);
    });

    test('a load parked on a read when the switch lands does not pour the departing record back', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        vi.advanceTimersByTime(HOUR);

        // The departing character's load is reading when the switch arrives
        world.onGet = (key) => {
            if (!key.startsWith('consumableTracker_char-self')) return;
            world.onGet = null;
            collector.onCharacterSwitching();
            world.characterId = 'char-alt';
        };
        await collector.loadConsumableTracking();

        expect(self().inventoryAmount).toEqual({});
        expect(self().lastObservedAt).toBeNull();

        // So the arriving character's first battle is a baseline, not a 600-gummy credit
        await collector.onNewBattle({
            ...battle({ battleId: 5 }),
            players: [player('char-alt', 'Alt', [slot(GUMMY, 400)])],
        });
        expect(self().actualConsumed[GUMMY]).toBeUndefined();
    });
});

describe('a party', () => {
    test('each member is credited from their own entry; the player only from theirs', async () => {
        const ally = (consumables) => player('char-ally', 'Ally', consumables);
        const quiet = (consumables) => player('char-quiet', 'Quiet', consumables);

        await collector.onNewBattle(
            battle({
                self: [slot(GUMMY, 1000)],
                others: [ally([slot(GUMMY, 800), slot(YOGURT, 300)]), quiet([slot(GUMMY, 50)])],
            })
        );
        vi.advanceTimersByTime(HOUR);
        // The quiet member's consumables are missing from this message
        await collector.onNewBattle(
            battle({
                battleId: 2,
                self: [slot(GUMMY, 1000)],
                others: [ally([slot(GUMMY, 750), slot(YOGURT, 280)]), quiet([])],
            })
        );

        const allyTracker = collector.partyConsumableTrackers.Ally;
        expect(allyTracker.actualConsumed[GUMMY]).toBe(50);
        expect(allyTracker.actualConsumed[YOGURT]).toBe(20);
        expect(allyTracker.excludedMs).toBe(0);
        // The ally's drop of the same item is never the player's
        expect(self().actualConsumed[GUMMY]).toBeUndefined();
        // Nothing is invented for the member whose data is missing
        expect(collector.partyConsumableTrackers.Quiet.actualConsumed[GUMMY] || 0).toBe(0);
        expect(collector.partyConsumableTrackers.Quiet.excludedMs).toBe(HOUR);
    });

    test('a member tracker survives a reload with its observation point', async () => {
        const ally = (consumables) => player('char-ally', 'Ally', consumables);
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)], others: [ally([slot(GUMMY, 800)])] }));
        vi.advanceTimersByTime(10 * SECOND);
        await collector.onNewBattle(
            battle({ battleId: 2, self: [slot(GUMMY, 1000)], others: [ally([slot(GUMMY, 800)])] })
        );

        collector.onCharacterSwitching();
        vi.advanceTimersByTime(HOUR);
        await collector.loadConsumableTracking();
        await collector.onNewBattle(
            battle({ battleId: 200, self: [slot(GUMMY, 1000)], others: [ally([slot(GUMMY, 760)])] })
        );

        expect(collector.partyConsumableTrackers.Ally.actualConsumed[GUMMY]).toBe(40);
    });
});

describe('disable and re-enable', () => {
    test('what was used while the feature was off is reconciled on the first battle back', async () => {
        await collector.initialize();
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        vi.advanceTimersByTime(10 * SECOND);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 1000)] }));

        collector.cleanup();
        vi.advanceTimersByTime(HOUR);
        await collector.initialize();
        await collector.onNewBattle(battle({ battleId: 250, self: [slot(GUMMY, 940)] }));

        expect(self().actualConsumed[GUMMY]).toBe(60);
        collector.cleanup();
    });
});

describe('the clock and the baseline stay in step', () => {
    test('a gap left out before the clock started does not hold the time base at zero afterwards', async () => {
        // No use seen yet, so nothing has started the clock
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 100)] }));
        vi.advanceTimersByTime(HOUR);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 2000)] }));
        await collector.onConsumableUsed(used(GUMMY, 1999));
        vi.advanceTimersByTime(60 * SECOND);

        expect(collector.calcElapsedSeconds()).toBeCloseTo(60, 0);
    });

    test('an event without a count still moves the baseline, so the next snapshot does not count it again', async () => {
        await collector.onNewBattle(battle({ self: [slot(GUMMY, 1000)] }));
        vi.advanceTimersByTime(5 * SECOND);
        await collector.onConsumableUsed({ consumable: { itemHrid: GUMMY } });
        vi.advanceTimersByTime(10 * SECOND);
        await collector.onNewBattle(battle({ battleId: 2, self: [slot(GUMMY, 999)] }));

        expect(self().actualConsumed[GUMMY]).toBe(1);
    });
});
