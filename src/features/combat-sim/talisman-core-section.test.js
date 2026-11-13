/** @vitest-environment happy-dom */
/**
 * The core advisor as the Combat Sim's Talisman lines section draws it: it values the next line of each worn
 * talisman from the ranking's rows with no sim of its own, for the build the section is shown.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../../__fixtures__/talisman-full-modifiers.js';
import { TALISMAN_INFO, ORB_ITEMS } from '../../__fixtures__/talisman-reroll.js';

const mocks = vi.hoisted(() => ({
    test: true,
    characterId: 'c1',
    roster: null,
    prices: {},
    sims: [],
    /** Called at the start of every sim */
    onSim: null,
    cancelled: 0,
    throwCancel: false,
}));

const crit = (grade) => ({ hrid: '/talisman_modifiers/critical_damage', grade });
const MEDIUM_4 = { hrid: '/items/medium_talisman_belt', enhancementLevel: 4 };

function gameData() {
    return {
        talismansEnabled: mocks.test,
        talismanModifierDetailMap: FULL_MODIFIER_DETAILS,
        itemDetailMap: {
            ...BELT_ITEMS,
            ...ORB_ITEMS,
            '/items/basic_talisman_core': { name: 'Basic Talisman Core' },
            '/items/advanced_talisman_core': { name: 'Advanced Talisman Core' },
            '/items/expert_talisman_core': { name: 'Expert Talisman Core' },
        },
        enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
        talismanInfo: TALISMAN_INFO,
        actionDetailMap: {
            '/actions/combat/golem_cave': {
                hrid: '/actions/combat/golem_cave',
                type: '/action_types/combat',
                name: 'Golem Cave',
                combatZoneInfo: { isDungeon: false },
            },
        },
    };
}

vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => mocks.test,
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => fallback,
        setSettingValue: () => {},
        getSetting: () => undefined,
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid, options) => {
        const price = mocks.prices[`${hrid}@${options.enhancementLevel}@${options.side}`];
        return price ? { price, source: 'book', estimated: false } : { price: null, source: null, estimated: false };
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => gameData(),
        getCurrentCharacterId: () => mocks.characterId,
        getSkills: () => [],
        getCharacterTalismans: () => [],
    },
}));
vi.mock('./combat-sim-adapter.js', () => ({
    buildAllPlayerDTOs: async () => ({ players: structuredClone(mocks.roster), selfHrid: '/players/1' }),
    buildGameDataPayload: () => gameData(),
    getCommunityBuffs: () => ({}),
    seedSimPriceCache: (cache) => cache,
}));
vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: async (params) => {
        const dto = params.playerDTOs[0];
        await mocks.onSim?.(dto);
        if (mocks.throwCancel) throw new Error('Cancelled');
        const { computeTalismanCombat } = await import('./engine/talisman-combat.js');
        const { TALISMAN_MODELED_STATS } = await import('./engine/player.js');
        const out = computeTalismanCombat({
            talismans: dto.talismans,
            belt: dto.equipment['/equipment_types/belt'],
            gameData: gameData(),
            modeledStats: TALISMAN_MODELED_STATS,
        });
        mocks.sims.push(dto.equipment['/equipment_types/belt']);
        return {
            dps: 1000 * (1 + Object.values(out.stats).reduce((a, b) => a + b, 0)),
            deaths: { '/players/1': 1 },
            encounters: 500,
        };
    },
    cancelActiveSimulations: () => {
        mocks.cancelled++;
    },
}));
vi.mock('./upgrade-advisor.js', () => ({
    analysisConcurrency: () => 1,
    computeMetrics: (r) => ({
        dps: r.dps,
        xpPerHour: 0,
        profitPerHour: 0,
        encountersPerHour: 5,
        deathsPerHour: r.deaths['/players/1'],
    }),
    computeDeltas: (b, u) => ({ dps: ((u.dps - b.dps) / b.dps) * 100, xp: 0, profit: 0, encounters: 0, deaths: 0 }),
    rateDeltaNoisePct: () => ({ dps: 0.001, xp: 0.001, profit: 0.001, encounters: 0.001, deaths: 0.001 }),
    resimCloseCallRows: async () => ({ ran: false, rounds: 0, rows: 0 }),
    significantDeltas: (d, n) => Object.fromEntries(Object.keys(d).map((k) => [k, Math.abs(d[k]) > 1.96 * n[k]])),
    saleTaxRateOf: () => null,
}));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionTalismans: () => [],
    resolveActionContext: () => ({ equipment: new Map(), drinks: [] }),
}));
vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: 1 }),
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    gatheringProfit: () => null,
    productionProfit: () => null,
    marketUndercutAlerts: () => null,
    guildMemberSkills: () => null,
}));

const { TalismanLineRankingSection } = await import('./talisman-line-ranking-ui.js');

let host;
let section;
let container;
let dto;

function makeHost() {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    return {
        panel,
        busy: false,
        status: '',
        _readUpgradeInputs: () => ({ zoneHrid: '/actions/combat/golem_cave', difficultyTier: 1, hours: 10 }),
        _upgradePlayerIndex: () => 0,
        _editor: null,
        _afterRun: vi.fn(),
        _isBusy() {
            return this.busy || section?.isBusy();
        },
        _setStatus(text) {
            this.status = text;
        },
    };
}
const q = (role) => container.querySelector(`[data-role="${role}"]`);
const cores = () => q('core-results').textContent;
const rank = () => section._onRun();
const check = () => section._onCores();

beforeEach(() => {
    mocks.test = true;
    mocks.characterId = 'c1';
    mocks.prices = {};
    mocks.sims = [];
    mocks.onSim = null;
    mocks.cancelled = 0;
    mocks.throwCancel = false;
    dto = {
        hrid: '/players/1',
        equipment: { '/equipment_types/belt': { ...MEDIUM_4 } },
        talismans: [
            { slotIndex: 1, modifiers: [crit(6)] },
            { slotIndex: 2, modifiers: [crit(4)] },
        ],
    };
    mocks.roster = [dto];
    host = makeHost();
    host._editor = {
        getEditedDTOs: () => ({ '/players/1': dto }),
        getSelfHrid: () => '/players/1',
        getPlayerInfo: () => [{ name: 'Tester' }],
    };
    container = document.createElement('div');
    host.panel.appendChild(container);
    section = new TalismanLineRankingSection(host);
    section.mount(container);
});

afterEach(() => {
    section?.detach();
    document.body.innerHTML = '';
});

describe('the core advisor in the Combat Sim', () => {
    test('before the ranking ran it says to run the ranking first, and runs no sim', async () => {
        await check();
        expect(cores()).toContain('Run the ranking first');
        expect(mocks.sims).toHaveLength(0);
    });

    test('after the ranking: one row per talisman with room, valued with no sim of its own, unpriced plainly', async () => {
        await rank();
        const sims = mocks.sims.length;
        await check();
        expect(mocks.sims).toHaveLength(sims);
        expect(section._core.status).toBe('done');
        expect(section._core.rows.map((r) => r.slotIndex).sort()).toEqual([1, 2]);
        for (const r of section._core.rows) {
            expect(r.lineNumber).toBe(2);
            expect(r.costs.market.price).toBeNull();
        }
        expect(cores()).toContain('No price');
        expect(cores()).toContain('Unpriced: no gain per cost.');
        expect(cores()).not.toMatch(/undefined|NaN|Infinity/);
        const headers = [...q('core-results').querySelectorAll('th')].map((h) => h.textContent);
        expect(headers).toEqual(['#', 'Talisman', 'Adds', 'DPS', 'Useful', 'Best', 'Cost', 'per 100m', 'Note']);
        for (const th of q('core-results').querySelectorAll('th')) expect(th.title).not.toBe('');
    });

    test('the cores are priced from the market at the Buy quote, five basic cores for the second line', async () => {
        mocks.prices['/items/basic_talisman_core@0@buy'] = 2e6;
        await rank();
        await check();
        for (const r of section._core.rows) expect(r.costs.market.price).toBe(1e7);
        expect(cores()).toContain('10.0M');
    });

    test('a sim talisman carries no type: the lines say which talismans are combat ones', async () => {
        dto.talismans = [
            { slotIndex: 1, modifiers: [crit(6)] },
            { slotIndex: 2, modifiers: [{ hrid: '/talisman_modifiers/milking_speed', grade: 3 }] },
        ];
        await rank();
        await check();
        expect(section._core.rows.map((r) => r.slotIndex)).toEqual([1]);
    });

    test('every worn talisman has 4 lines', async () => {
        const four = ['critical_damage', 'critical_rate', 'armor', 'melee_damage'].map((n) => ({
            hrid: `/talisman_modifiers/${n}`,
            grade: 2,
        }));
        dto.talismans = [{ slotIndex: 1, modifiers: four }];
        await rank();
        await check();
        expect(cores()).toContain('already has 4 lines');
    });

    test('no talisman is worn', async () => {
        dto.talismans = [];
        await rank();
        await check();
        expect(cores()).toContain('No talisman of this type is worn');
    });

    test('a belt changed after the ranking is said: rank again', async () => {
        await rank();
        dto.equipment['/equipment_types/belt'] = { hrid: '/items/medium_talisman_belt', enhancementLevel: 9 };
        await check();
        expect(cores()).toContain('out of date for this gear');
    });

    test('a new ranking clears the cores; a changed build marks them out of date', async () => {
        await rank();
        await check();
        expect(q('core-stale').style.display).toBe('none');
        dto.talismans = [{ slotIndex: 1, modifiers: [crit(6)] }];
        section._refreshStale();
        expect(q('core-stale').style.display).toBe('block');
        await rank();
        expect(section._core).toBeNull();
        expect(q('core-results').innerHTML).toBe('');
    });

    test('detach drops the result', async () => {
        await rank();
        await check();
        section.detach();
        expect(section._core).toBeNull();
    });

    test('a build edited after the ranking is not valued with the old rows', async () => {
        await rank();
        dto.talismans = [{ slotIndex: 1, modifiers: [crit(6), { hrid: '/talisman_modifiers/armor', grade: 2 }] }];
        await check();
        expect(cores()).toContain('out of date for this gear');
        expect(section._core.rows).toHaveLength(0);
    });
});
