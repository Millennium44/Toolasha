/**
 * The single-zone run behind a queued fight's "sim 24h" button: one zone, one tier, the row's own
 * loadout, solo, 24 hours, through the simulator's ordinary worker path, into its own store.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const env = vi.hoisted(() => ({ characterId: 'char1' }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => env.characterId },
}));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (key) => `${key}_${env.characterId}`,
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { snapshots: {}, whenReady: async () => true } }));
vi.mock('./combat-sim-adapter.js', () => ({
    applyLoadoutSnapshotToDTO: vi.fn(),
    buildGameDataPayload: vi.fn(),
    buildPlayerDTO: vi.fn(),
    calculateSimRevenue: vi.fn(),
    getCommunityBuffs: vi.fn(),
}));
vi.mock('./combat-sim-runner.js', () => ({ runSimulation: vi.fn() }));

const { prepareZoneRateRun, simulateZoneRate, zoneRateEntry, ZONE_RATE_SIM_HOURS } = await import('./zone-rate-sim.js');

const FLY = '/actions/combat/fly';
const DEN = '/actions/combat/chimerical_den';
const HOUR_NS = 3600 * 1e9;

const combatSnapshot = {
    name: 'Combat',
    equipment: [{ itemHrid: '/items/sword' }],
    abilities: [{ abilityHrid: '/abilities/slash' }],
    food: [],
    drinks: [],
};

function deps(overrides = {}) {
    const applied = [];
    return {
        applied,
        store: { snapshots: { 41704: combatSnapshot }, whenReady: vi.fn(async () => true) },
        makeDTO: () => ({ hrid: 'player1', equipment: {} }),
        makeGameData: () => ({
            actionDetailMap: {
                [FLY]: { combatZoneInfo: { isDungeon: false } },
                [DEN]: { combatZoneInfo: { isDungeon: true } },
            },
        }),
        communityBuffs: () => ({ mooPass: true }),
        applyLoadout: (dto, snapshot) => {
            applied.push(snapshot);
            dto.equipment = { sword: snapshot.equipment[0].itemHrid };
            return true;
        },
        ...overrides,
    };
}

describe('prepareZoneRateRun', () => {
    test("configures the row's zone, tier and loadout, solo, for 24 hours", async () => {
        const d = deps();
        const run = await prepareZoneRateRun({ zoneHrid: FLY, difficultyTier: 2, loadoutId: 41704 }, d);

        expect(run.ok).toBe(true);
        expect(run.params).toMatchObject({ zoneHrid: FLY, difficultyTier: 2, hours: 24 });
        expect(ZONE_RATE_SIM_HOURS).toBe(24);
        expect(run.params.playerDTOs).toHaveLength(1);
        expect(run.params.playerDTOs[0].equipment).toEqual({ sword: '/items/sword' });
        expect(run.params.communityBuffs).toEqual({ mooPass: true });
        // Applied by the id the row carries, never looked up again by name
        expect(d.applied).toEqual([combatSnapshot]);
        expect(d.store.whenReady).toHaveBeenCalled();
        expect(run.loadout).toMatchObject({ id: '41704', source: 'loadout', name: 'Combat' });
        expect(run.loadout.signature).toBeTruthy();
    });

    test('a row with no loadout is simulated in worn gear, and says so', async () => {
        const d = deps();
        const run = await prepareZoneRateRun({ zoneHrid: FLY, loadoutId: 0 }, d);
        expect(run.ok).toBe(true);
        expect(d.applied).toEqual([]);
        expect(run.loadout).toEqual({ id: '0', source: 'worn', name: null, signature: null });
    });

    test('a loadout that cannot be resolved is reported, and nothing is configured', async () => {
        const run = await prepareZoneRateRun({ zoneHrid: FLY, loadoutId: 99 }, deps());
        expect(run.ok).toBe(false);
        expect(run.error).toMatch(/Could not read the loadout/);
    });

    test('a dungeon is refused', async () => {
        const run = await prepareZoneRateRun({ zoneHrid: DEN }, deps());
        expect(run.ok).toBe(false);
        expect(run.error).toMatch(/Dungeons/);
    });

    test('missing game or character data is reported', async () => {
        expect((await prepareZoneRateRun({ zoneHrid: FLY }, deps({ makeGameData: () => null }))).ok).toBe(false);
        expect((await prepareZoneRateRun({ zoneHrid: FLY }, deps({ makeDTO: () => null }))).ok).toBe(false);
    });
});

describe('zoneRateEntry', () => {
    test("divides the run's encounters by its own simulated hours", () => {
        const prepared = {
            params: { zoneHrid: FLY, difficultyTier: 2, hours: 24, gameData: {} },
            loadout: { id: '41704', source: 'loadout', name: 'Combat', signature: 'sig' },
        };
        const entry = zoneRateEntry(
            {
                encounters: 4800,
                simulatedTime: 24 * HOUR_NS,
                experienceGained: { player1: { attack: 240, defense: 240 } },
                deaths: { player1: 2 },
            },
            prepared,
            { revenue: () => ({ netPerHour: 1000 }), now: 5 }
        );
        expect(entry).toEqual({
            zoneHrid: FLY,
            difficultyTier: 2,
            loadoutId: '41704',
            loadoutSource: 'loadout',
            loadoutName: 'Combat',
            signature: 'sig',
            encountersPerHour: 200,
            profitPerHour: 1000,
            xpPerHour: 20,
            deathsPerHour: 2 / 24,
            hours: 24,
            savedAt: 5,
        });
    });

    test('a run that cleared nothing has no rate', () => {
        const prepared = { params: { hours: 24 }, loadout: {} };
        expect(zoneRateEntry({ encounters: 0, simulatedTime: HOUR_NS }, prepared)).toBeNull();
    });
});

describe('simulateZoneRate', () => {
    beforeEach(() => {
        env.characterId = 'char1';
    });

    const finished = { encounters: 2400, simulatedTime: 24 * HOUR_NS, experienceGained: {}, deaths: {} };

    test('runs through the ordinary sim path without preempting, and stores under its own key', async () => {
        const run = vi.fn(async () => finished);
        const save = vi.fn(async () => true);
        const outcome = await simulateZoneRate(
            { zoneHrid: FLY, difficultyTier: 1, loadoutId: 41704 },
            { deps: { ...deps(), run, save } }
        );

        expect(outcome.ok).toBe(true);
        expect(outcome.entry.encountersPerHour).toBe(100);
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][0]).toMatchObject({ zoneHrid: FLY, difficultyTier: 1, hours: 24 });
        expect(run.mock.calls[0][2]).toEqual({ preempt: false });
        expect(save).toHaveBeenCalledWith('zoneSimRates_char1', outcome.entry);
    });

    test('an unresolvable loadout is reported and nothing runs', async () => {
        const run = vi.fn();
        const outcome = await simulateZoneRate({ zoneHrid: FLY, loadoutId: 7 }, { deps: { ...deps(), run } });
        expect(outcome.ok).toBe(false);
        expect(run).not.toHaveBeenCalled();
    });

    test('a character switch during the run discards the result', async () => {
        const save = vi.fn(async () => true);
        const run = vi.fn(async () => {
            env.characterId = 'char2';
            return finished;
        });
        const outcome = await simulateZoneRate({ zoneHrid: FLY }, { deps: { ...deps(), run, save } });
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toMatch(/character changed/);
        expect(save).not.toHaveBeenCalled();
    });

    test('a cancelled or failed run is reported, never thrown', async () => {
        const cancelled = await simulateZoneRate(
            { zoneHrid: FLY },
            {
                deps: {
                    ...deps(),
                    run: async () => {
                        throw new Error('Cancelled');
                    },
                },
            }
        );
        expect(cancelled).toEqual({ ok: false, error: expect.stringMatching(/cancelled/) });

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failed = await simulateZoneRate(
            { zoneHrid: FLY },
            {
                deps: {
                    ...deps(),
                    run: async () => {
                        throw new Error('worker died');
                    },
                },
            }
        );
        errorSpy.mockRestore();
        expect(failed).toEqual({ ok: false, error: 'Simulation failed: worker died' });
    });

    test('a save that fails is reported', async () => {
        const outcome = await simulateZoneRate(
            { zoneHrid: FLY },
            { deps: { ...deps(), run: async () => finished, save: async () => false } }
        );
        expect(outcome).toEqual({ ok: false, error: 'The rate could not be saved.' });
    });
});
