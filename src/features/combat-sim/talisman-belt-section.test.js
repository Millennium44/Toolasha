/** @vitest-environment happy-dom */
/**
 * The belt advisor as the Combat Sim's Talisman lines section draws it: the sim runs against the build it is shown for
 * (the editor's, or the live character's), every way a run can end, and the guards shared with the ranking.
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
        itemDetailMap: { ...BELT_ITEMS, ...ORB_ITEMS },
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
const results = () => q('belt-results').textContent;
const rowsText = () => [...q('belt-results').querySelectorAll('tr')].map((r) => r.textContent);
const belts = () => section._onBelts();

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

describe('the belt advisor in the Combat Sim', () => {
    test('the pre-run line counts the sims; every control and column has a hover', async () => {
        expect(q('belt-estimate').textContent).toBe('Up to 9 sims for 8 candidate belts.');
        for (const role of ['belt-cost', 'belt-run']) expect(q(role).title).not.toBe('');
        mocks.prices['/items/medium_talisman_belt@5@buy'] = 5e8;
        await belts();
        const headers = [...q('belt-results').querySelectorAll('th')];
        expect(headers.map((h) => h.textContent)).toEqual(['#', 'Belt', 'DPS', '%', 'Cost', 'per 100m', 'Note']);
        for (const th of headers) expect(th.title).not.toBe('');
    });

    test('ran: one sim per belt on the edited build, priced rows first, unpriced last and marked', async () => {
        mocks.prices['/items/medium_talisman_belt@5@buy'] = 2e8;
        mocks.prices['/items/medium_talisman_belt@10@buy'] = 3e9;
        await belts();
        // The baseline and 8 candidates, each with its own belt
        expect(mocks.sims).toHaveLength(9);
        expect(mocks.sims[0]).toEqual(MEDIUM_4);
        const shown = results();
        expect(shown).toContain('Golem Cave T1 for Tester');
        expect(shown).toContain('Belts against Medium Talisman Belt +4');
        expect(shown).toContain('+1 empty slot, not valued');
        expect(shown).not.toMatch(/undefined|NaN|Infinity/);
        const rows = rowsText();
        expect(rows[1]).toContain('Medium Talisman Belt +5');
        expect(rows[2]).toContain('Medium Talisman Belt +10');
        for (const row of rows.slice(3)) expect(row).toContain('No price');
        // The build the run read is untouched, and nothing was written back to it
        expect(dto.equipment['/equipment_types/belt']).toEqual(MEDIUM_4);
        expect(dto.talismans).toHaveLength(2);
    });

    test('an edited sim player is what is valued, not the live character', async () => {
        // The roster the live character would give wears a Large; the editor's player wears the Medium
        mocks.roster = [
            {
                ...dto,
                equipment: { '/equipment_types/belt': { hrid: '/items/large_talisman_belt', enhancementLevel: 20 } },
            },
        ];
        await belts();
        expect(mocks.sims[0]).toEqual(MEDIUM_4);
        expect(section._belt.belt).toEqual(MEDIUM_4);
    });

    test('with no editor yet, the live character is valued', async () => {
        host._editor = null;
        await belts();
        expect(mocks.sims[0]).toEqual(MEDIUM_4);
        expect(section._belt.status).toBe('done');
    });

    test('no belt: says so and runs nothing', async () => {
        dto.equipment = {};
        await belts();
        expect(results()).toContain('wears no Talisman Belt');
        expect(mocks.sims).toHaveLength(0);
    });

    test('no talisman slotted: says so and runs nothing', async () => {
        dto.talismans = [];
        await belts();
        expect(results()).toContain('no talisman slotted');
        expect(mocks.sims).toHaveLength(0);
    });

    test('every belt unpriced: gains show, one line says none can be set against a cost', async () => {
        await belts();
        expect(results()).toContain('No belt has a price on the "Buy" basis');
        expect(results()).not.toContain('free');
    });

    test('empty: the largest belt at +20', async () => {
        dto.equipment['/equipment_types/belt'] = { hrid: '/items/large_talisman_belt', enhancementLevel: 20 };
        await belts();
        expect(results()).toContain('Nothing to compare');
        expect(mocks.sims).toHaveLength(0);
    });

    test('a Large already at a high level is offered only the levels left, with talismans of three or four lines', async () => {
        dto.equipment['/equipment_types/belt'] = { hrid: '/items/large_talisman_belt', enhancementLevel: 17 };
        dto.talismans = [
            {
                slotIndex: 1,
                modifiers: [
                    crit(6),
                    { hrid: '/talisman_modifiers/critical_rate', grade: 5 },
                    { hrid: '/talisman_modifiers/ability_damage', grade: 4 },
                    { hrid: '/talisman_modifiers/attack_speed', grade: 3 },
                ],
            },
            {
                slotIndex: 2,
                modifiers: [
                    crit(2),
                    { hrid: '/talisman_modifiers/smite', grade: 6 },
                    { hrid: '/talisman_modifiers/armor', grade: 3 },
                ],
            },
            { slotIndex: 3, modifiers: [crit(6)] },
        ];
        mocks.prices['/items/large_talisman_belt@18@buy'] = 1e9;
        await belts();
        const rows = rowsText();
        expect(rows).toHaveLength(4);
        expect(
            rows
                .slice(1)
                .map((r) => r.match(/\+(\d+)/)?.[0])
                .sort()
        ).toEqual(['+18', '+19', '+20']);
        expect(results()).not.toContain('empty slot');
        // Every sim kept all three talismans
        expect(mocks.sims.every((belt) => belt.hrid === '/items/large_talisman_belt')).toBe(true);
    });

    test('Stop ends the run, keeps the belts valued, and cancels the sims', async () => {
        let n = 0;
        mocks.onSim = () => {
            if (++n === 4) section.stop();
        };
        await belts();
        expect(mocks.cancelled).toBeGreaterThan(0);
        expect(results()).toContain('Stopped early');
        expect(rowsText().length).toBeLessThan(9);
        expect(section._running).toBe(false);
    });

    test('a cancel from elsewhere stops the run and says so', async () => {
        mocks.throwCancel = true;
        await belts();
        expect(results()).toContain('Stopped early');
        expect(results()).toContain('another simulation cancelled this run');
    });

    test('refused while the Combat Sim runs something else, with the status line', async () => {
        host.busy = true;
        await belts();
        expect(host.status).toContain('Something else is running');
        expect(results()).toContain('Something else is running');
        expect(mocks.sims).toHaveLength(0);
    });

    test('a changed build or zone marks the result out of date', async () => {
        await belts();
        expect(q('belt-stale').style.display).toBe('none');
        dto.talismans = [{ slotIndex: 1, modifiers: [crit(1)] }];
        section._refreshStale();
        expect(q('belt-stale').textContent).toContain('build');
        await belts();
        expect(q('belt-stale').style.display).toBe('none');
        host._readUpgradeInputs = () => ({ zoneHrid: '/actions/combat/golem_cave', difficultyTier: 3, hours: 10 });
        section._refreshStale();
        expect(q('belt-stale').textContent).toContain('tier');
    });

    test('a character switch mid-run drops the result', async () => {
        mocks.onSim = () => {
            mocks.characterId = 'c2';
        };
        await belts();
        expect(section._belt).toBeNull();
        expect(q('belt-results').innerHTML).toBe('');
        expect(section._running).toBe(false);
    });

    test('a failing sim ends the run with a message', async () => {
        mocks.onSim = () => {
            throw new Error('worker crashed');
        };
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await belts();
        expect(results()).toContain('Failed: worker crashed');
        expect(section._running).toBe(false);
        spy.mockRestore();
    });

    test('the live server: refused', async () => {
        mocks.test = false;
        await belts();
        expect(results()).toContain('Talismans exist on the test server only.');
        expect(mocks.sims).toHaveLength(0);
    });

    test('detach drops the result and a fresh mount is clean', async () => {
        await belts();
        section.detach();
        expect(section._belt).toBeNull();
        section.mount(container);
        expect(q('belt-results').innerHTML).toBe('');
    });
});
