/** @vitest-environment happy-dom
 *
 * The ROI board as drawn: rows from the live modules (mocked), sim marks where
 * the sim spoke, sortable headers and the tier/party filters.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const DEN = '/actions/combat/chimerical_den';
const COVE = '/actions/combat/pirate_cove';

const state = vi.hoisted(() => ({
    runs: [],
    sessions: [],
    snapshot: null,
    latestCombat: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => fallback,
        getSetting: () => false,
    },
}));

vi.mock('../../core/data-manager.js', () => {
    const actionDetailMap = {
        [DEN]: {
            type: '/action_types/combat',
            name: 'Chimerical Den',
            maxDifficulty: 1,
            sortIndex: 1,
            combatZoneInfo: {
                isDungeon: true,
                dungeonInfo: {
                    maxWaves: 50,
                    keyItemHrid: '/items/chimerical_entry_key',
                    rewardDropTable: [
                        { itemHrid: '/items/chimerical_chest', dropRate: 1, minCount: 1, maxCount: 1 },
                        {
                            itemHrid: '/items/chimerical_refinement_chest',
                            dropRate: 0.02,
                            dropRatePerDifficultyTier: 0.01,
                            minCount: 1,
                            maxCount: 1,
                        },
                        { itemHrid: '/items/chimerical_token', dropRate: 1, minCount: 40, maxCount: 40 },
                    ],
                },
            },
        },
        [COVE]: {
            type: '/action_types/combat',
            name: 'Pirate Cove',
            maxDifficulty: 0,
            sortIndex: 2,
            combatZoneInfo: {
                isDungeon: true,
                dungeonInfo: {
                    maxWaves: 65,
                    keyItemHrid: '/items/pirate_entry_key',
                    rewardDropTable: [
                        { itemHrid: '/items/pirate_chest', dropRate: 1, minCount: 1, maxCount: 1 },
                        { itemHrid: '/items/pirate_token', dropRate: 1, minCount: 50, maxCount: 50 },
                    ],
                },
            },
        },
        '/actions/combat/fly': { type: '/action_types/combat', name: 'Fly', combatZoneInfo: { isDungeon: false } },
    };
    const items = {
        '/items/chimerical_chest': { name: 'Chimerical Chest', isOpenable: true },
        '/items/chimerical_refinement_chest': { name: 'Chimerical Refinement Chest', isOpenable: true },
        '/items/pirate_chest': { name: 'Pirate Chest', isOpenable: true },
        '/items/chimerical_entry_key': { name: 'Chimerical Entry Key' },
        '/items/chimerical_chest_key': { name: 'Chimerical Chest Key' },
        '/items/pirate_entry_key': { name: 'Pirate Entry Key' },
        '/items/pirate_chest_key': { name: 'Pirate Chest Key' },
    };
    return {
        default: {
            getInitClientData: () => ({ actionDetailMap }),
            getActionDetails: (hrid) => actionDetailMap[hrid] || null,
            getItemDetails: (hrid) => items[hrid] || null,
            getCurrentCharacterId: () => 'me',
            getCurrentCharacterName: () => 'Me',
        },
    };
});

vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: () => ({ ask: 200, bid: 180 }) },
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        getCachedValue: (hrid) => (hrid.includes('refinement') ? 50_000 : hrid.endsWith('_chest') ? 20_000 : null),
        calculateSingleContainer: () => null,
        resolveSellSideValue: () => null,
    },
}));

vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    // The sim's own expected-drop routine, as the real one reads a one-completion result
    calculateExpectedDrops: (simResult, gameData, playerHrid) => {
        const table = gameData.actionDetailMap[simResult.zoneName].combatZoneInfo.dungeonInfo.rewardDropTable;
        const chests = (5 / simResult.numberOfPlayers) * (1 + (simResult.combatDropQuantity[playerHrid] || 0));
        const out = new Map();
        for (const drop of table) {
            const rate = drop.dropRate + (drop.dropRatePerDifficultyTier || 0) * simResult.difficultyTier;
            const avg = (drop.minCount + drop.maxCount) / 2;
            out.set(drop.itemHrid, rate >= 1 ? chests * avg : rate * avg);
        }
        return out;
    },
    taxedDropValue: (hrid, value) => value * 0.95,
}));

vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => state.latestCombat },
}));

vi.mock('../combat-stats/combat-session-history.js', () => ({
    loadSessions: async () => state.sessions,
}));

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        getAllRuns: async () => state.runs,
        getDungeonInfo: () => null,
    },
    filterRunsForCharacter: (runs) => runs,
    currentCharacter: () => ({ id: 'me', name: 'Me' }),
}));

vi.mock('../../utils/all-zones-snapshot.js', () => ({
    loadAllZonesSnapshot: async () => state.snapshot,
}));

vi.mock('../../utils/key-cost.js', () => ({
    describeKeyCosts: (hrids) =>
        new Map(hrids.map((hrid) => [hrid, { itemHrid: hrid, unitCost: hrid.endsWith('_entry_key') ? 3_000 : 1_000 }])),
}));

vi.mock('../../utils/token-valuation.js', () => ({
    calculateDungeonTokenValue: () => 100,
}));

const { default: DungeonRoiBoardUI, listDungeons, rewardsPerCompletion } = await import('./dungeon-roi-board-ui.js');

function run(dungeonName, tier, durationMs, team = ['Me']) {
    return { dungeonName, tier, duration: durationMs, team, teamKey: team.join(',') };
}

/** A tracker panel with only the section the board draws into. */
function panel() {
    const container = document.createElement('div');
    container.innerHTML = '<div id="mwi-dt-roi-container"></div>';
    document.body.appendChild(container);
    return container;
}

function rowTexts(container) {
    return [...container.querySelectorAll('.mwi-dt-roi-row')].map((tr) => tr.firstChild.textContent);
}

beforeEach(() => {
    state.runs = [];
    state.sessions = [];
    state.snapshot = null;
    state.latestCombat = null;
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('gathering', () => {
    test('lists only dungeons, in data order, with waves and tiers', () => {
        expect(listDungeons()).toEqual([
            { hrid: DEN, name: 'Chimerical Den', maxWaves: 50, maxDifficulty: 1, sortIndex: 1 },
            { hrid: COVE, name: 'Pirate Cove', maxWaves: 65, maxDifficulty: 0, sortIndex: 2 },
        ]);
    });

    test('rewards per completion go through the sim adapter with a one-completion result', () => {
        const rewards = rewardsPerCompletion(DEN, 1, 5, 0.2);
        expect(rewards.get('/items/chimerical_chest')).toBeCloseTo(1.2);
        expect(rewards.get('/items/chimerical_refinement_chest')).toBeCloseTo(0.03);
        expect(rewards.get('/items/chimerical_token')).toBeCloseTo(48);
    });
});

describe('drawing', () => {
    test('one row per dungeon and tier, sorted by gold/hr, measured where there are runs', async () => {
        state.runs = [run('Chimerical Den', 0, 600_000), run('Chimerical Den', 0, 660_000)];
        const board = new DungeonRoiBoardUI({ filterCharacter: 'mine' });
        const container = panel();

        await board.render(container);

        expect(container.textContent).not.toContain('could not be drawn');
        const table = container.querySelector('#mwi-dt-roi-table');
        expect(table).not.toBeNull();
        expect(rowTexts(container)).toEqual(['Chimerical Den T0', 'Chimerical Den T1', 'Pirate Cove T0']);

        const den0 = container.querySelector('.mwi-dt-roi-row');
        const cells = [...den0.children].map((td) => td.textContent);
        expect(cells[1]).toBe('2'); // runs
        expect(cells[2]).toBe('10:30'); // median of 10:00 and 11:00
        expect(cells[11]).toBe('low');
        // Measured rows carry no sim mark
        expect(den0.textContent).not.toContain('sim');
    });

    test('a tier with no runs takes the sim and says so on every simulated cell', async () => {
        state.snapshot = {
            zones: [
                {
                    zoneHrid: DEN,
                    difficultyTier: 1,
                    xpPerHour: 80_000,
                    dungeon: {
                        completions: 6,
                        simHours: 2,
                        partySize: 1,
                        consumableCostPerHour: 6_000,
                        deathsPerHour: 0,
                    },
                },
            ],
        };
        const board = new DungeonRoiBoardUI({ filterCharacter: 'mine' });
        const container = panel();

        await board.render(container);

        const den1 = [...container.querySelectorAll('.mwi-dt-roi-row')].find((tr) =>
            tr.firstChild.textContent.includes('T1')
        );
        const cells = [...den1.children].map((td) => td.textContent);
        expect(cells[2]).toBe('20:00 sim');
        expect(cells[7]).toBe('2.0K sim'); // 6,000/hr at three runs an hour
        expect(cells[10]).toBe('80.0K sim');
        expect(cells[11]).toBe('sim');
        expect(container.textContent).toContain('Rows marked "sim"');

        // A tier with neither runs nor sim has no food bill, so both net cells
        // read "—" and say why rather than reporting the revenue as profit
        expect(rowTexts(container).at(-1)).toBe('Pirate Cove T0');
        const cove = container.querySelectorAll('.mwi-dt-roi-row')[2];
        expect(cove.children[9].textContent).toBe('—');
        expect(cove.children[8].textContent).toBe('—');
        expect(cove.children[8].title).toContain('No net');
        expect(cove.children[8].title).toContain('consumable');
        expect(cove.children[11].title).toContain('No net');
    });

    test('a header click re-sorts, and a second click flips it', async () => {
        state.runs = [run('Chimerical Den', 0, 600_000), run('Pirate Cove', 0, 300_000)];
        const board = new DungeonRoiBoardUI({ filterCharacter: 'mine' });
        const container = panel();
        await board.render(container);

        const header = (key) => container.querySelector(`th[data-column="${key}"]`);
        header('dungeon').click();
        expect(rowTexts(container)).toEqual(['Chimerical Den T0', 'Chimerical Den T1', 'Pirate Cove T0']);
        expect(header('dungeon').textContent).toContain('▲');

        header('dungeon').click();
        expect(rowTexts(container)[0]).toBe('Pirate Cove T0');
        expect(header('dungeon').textContent).toContain('▼');
    });

    test('the tier and party filters narrow the board and redraw it', async () => {
        state.runs = [run('Chimerical Den', 0, 600_000, ['Me', 'Pal', 'Kid'])];
        const board = new DungeonRoiBoardUI({ filterCharacter: 'mine' });
        const container = panel();
        await board.render(container);

        const tier = container.querySelector('#mwi-dt-roi-filter-tier');
        tier.value = '1';
        tier.dispatchEvent(new Event('change'));
        await board._rendering;
        expect(rowTexts(container)).toEqual(['Chimerical Den T1']);

        tier.value = 'all';
        // The select was rebuilt by the redraw, so reach for it again
        container.querySelector('#mwi-dt-roi-filter-tier').value = 'all';
        container.querySelector('#mwi-dt-roi-filter-tier').dispatchEvent(new Event('change'));
        await board._rendering;

        const party = container.querySelector('#mwi-dt-roi-filter-party');
        party.value = '3';
        party.dispatchEvent(new Event('change'));
        await board._rendering;
        const den0 = [...container.querySelectorAll('.mwi-dt-roi-row')].find((tr) =>
            tr.firstChild.textContent.includes('Den T0')
        );
        expect(den0.children[1].textContent).toBe('1');
        expect(den0.firstChild.title).toContain('Party of 3 (from the filter)');
    });

    test('the drop quantity bonus is read off the latest combat snapshot', async () => {
        state.latestCombat = { players: [{ isCurrentPlayer: true, combatStats: { combatDropQuantity: 0.2 } }] };
        const board = new DungeonRoiBoardUI({ filterCharacter: 'mine' });
        const container = panel();
        await board.render(container);

        const cove = [...container.querySelectorAll('.mwi-dt-roi-row')].find((tr) =>
            tr.firstChild.textContent.includes('Pirate')
        );
        expect(cove.children[6].title).toContain('6.00 chests');
    });
});
