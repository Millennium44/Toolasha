/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../../__fixtures__/talisman-full-modifiers.js';
import { TALISMAN_INFO, ORB_ITEMS, talismanRow } from '../../__fixtures__/talisman-reroll.js';

const mocks = vi.hoisted(() => ({
    test: true,
    characterId: 'c1',
    roster: null,
    stopAfter: Infinity,
    /** Called when the sim count reaches `stopAfter` (the player pressing Stop mid-run); none: a foreign cancel */
    onStop: null,
    simCalls: 0,
    cancelled: 0,
    gatheringCalculator: null,
    /** The standard error every sim's delta carries, in percent */
    noise: 0.2,
    /** The zone is a dungeon */
    dungeon: false,
    /** characterTalismans */
    owned: [],
    /** Stored settings (config.getSettingValue / setSettingValue) */
    settings: {},
    /** Deaths per hour the fake sim gives a line (by hrid fragment) */
    deathsFor: {},
    /** The Talismans panel's fiber (for Aim for this opening the window) */
    panelFiber: null,
    /** Community buffs the sims would run with */
    buffs: null,
}));

const LARGE_10 = { hrid: '/items/large_talisman_belt', enhancementLevel: 10 };

function gameData() {
    return {
        talismansEnabled: mocks.test,
        talismanModifierDetailMap: FULL_MODIFIER_DETAILS,
        itemDetailMap: { ...BELT_ITEMS, ...ORB_ITEMS },
        enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
        talismanInfo: TALISMAN_INFO,
        actionTypeDetailMap: {},
        actionDetailMap: {
            '/actions/combat/golem_cave': {
                hrid: '/actions/combat/golem_cave',
                type: '/action_types/combat',
                name: 'Golem Cave',
                combatZoneInfo: { isDungeon: mocks.dungeon },
            },
            '/actions/milking/cow': {
                hrid: '/actions/milking/cow',
                type: '/action_types/milking',
                name: 'Cow',
                sortIndex: 1,
                levelRequirement: { skillHrid: '/skills/milking', level: 1 },
                experienceGain: { skillHrid: '/skills/milking', value: 10 },
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
        getSettingValue: (key, fallback) => (key in mocks.settings ? mocks.settings[key] : fallback),
        setSettingValue: (key, value) => {
            mocks.settings[key] = value;
        },
        getSetting: () => undefined,
    },
}));
// No orb has a market listing on the test server: the orbs are weighed by item value
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => gameData(),
        getCurrentCharacterId: () => mocks.characterId,
        getSkills: () => [{ skillHrid: '/skills/milking', level: 100 }],
        getCharacterTalismans: () => mocks.owned,
    },
}));
vi.mock('./combat-sim-adapter.js', () => ({
    buildAllPlayerDTOs: async () => ({ players: structuredClone(mocks.roster), selfHrid: '/players/1' }),
    buildGameDataPayload: () => gameData(),
    getCommunityBuffs: () => mocks.buffs ?? {},
    seedSimPriceCache: (cache) => cache,
}));
vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: async (params) => {
        mocks.simCalls++;
        if (mocks.simCalls > mocks.stopAfter) {
            mocks.onStop?.();
            throw new Error('Cancelled');
        }
        let dps = 1000;
        let deaths = 10;
        for (const t of params.playerDTOs[0].talismans || []) {
            for (const m of t.modifiers) {
                if (m.hrid.includes('critical')) dps += 20;
                for (const [part, extra] of Object.entries(mocks.deathsFor)) if (m.hrid.includes(part)) deaths += extra;
            }
        }
        return { dps, deaths: { '/players/1': deaths }, encounters: 500 };
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
    computeDeltas: (b, u) => ({
        dps: ((u.dps - b.dps) / b.dps) * 100,
        xp: 0,
        profit: 0,
        encounters: 0,
        deaths: ((u.deathsPerHour - b.deathsPerHour) / b.deathsPerHour) * 100,
    }),
    rateDeltaNoisePct: () => ({
        dps: mocks.noise,
        xp: mocks.noise,
        profit: mocks.noise,
        encounters: mocks.noise,
        deaths: mocks.noise,
    }),
    resimCloseCallRows: async () => ({ ran: false, rounds: 0, rows: 0 }),
    significantDeltas: (d, n) => Object.fromEntries(Object.keys(d).map((k) => [k, Math.abs(d[k]) > 1.96 * n[k]])),
    saleTaxRateOf: () => null,
}));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({
        equipment: new Map([
            ['/item_locations/belt', { itemHrid: '/items/large_talisman_belt', enhancementLevel: 10 }],
        ]),
        drinks: [],
    }),
}));
vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: 1 }),
}));
vi.mock('../../utils/react-click.js', () => ({
    fiberFor: (el) => (el?.className?.includes?.('TalismansPanel_') ? mocks.panelFiber : null),
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    gatheringProfit: () => mocks.gatheringCalculator,
    productionProfit: () => null,
    marketUndercutAlerts: () => null,
    guildMemberSkills: () => null,
}));

const { talismanBonusesOf } = await import('../../utils/talisman-bonuses.js');
const { TalismanLineRankingSection, talismanRankingAvailable } = await import('./talisman-line-ranking-ui.js');

let host;
let section;
let container;

function makeHost() {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    return {
        panel,
        status: '',
        busy: false,
        _readUpgradeInputs: () => ({ zoneHrid: '/actions/combat/golem_cave', difficultyTier: 1, hours: 10 }),
        _upgradePlayerIndex: () => 0,
        _editor: null,
        _afterRun: vi.fn(),
        _isBusy() {
            return this.busy;
        },
        _setStatus(text) {
            this.status = text;
        },
    };
}

const q = (role) => container.querySelector(`[data-role="${role}"]`);
const text = () => container.textContent;
const run = async () => {
    await section._onRun();
};

beforeEach(() => {
    mocks.test = true;
    mocks.characterId = 'c1';
    mocks.stopAfter = Infinity;
    mocks.onStop = null;
    mocks.simCalls = 0;
    mocks.noise = 0.2;
    mocks.dungeon = false;
    mocks.cancelled = 0;
    mocks.owned = [];
    mocks.settings = {};
    mocks.deathsFor = {};
    mocks.buffs = null;
    delete globalThis.window.Toolasha;
    mocks.roster = [{ hrid: '/players/1', equipment: { '/equipment_types/belt': LARGE_10 }, talismans: [] }];
    mocks.gatheringCalculator = {
        calculateGatheringProfit: async (_hrid, { actionContext }) => {
            const s = talismanBonusesOf(actionContext.equipment).noncombat;
            const rate = 100 * (1 + (s.milkingSpeed || 0) + (s.skillingSpeed || 0));
            return {
                profitPerHour: rate * 10,
                revenuePerHour: rate * 10,
                actionsPerHour: rate,
                efficiencyMultiplier: 1,
                hasMissingPrices: false,
            };
        },
    };
    host = makeHost();
    container = document.createElement('div');
    host.panel.appendChild(container);
    section = new TalismanLineRankingSection(host);
    section.mount(container);
});

afterEach(() => {
    section?.detach();
    document.body.innerHTML = '';
});

describe('availability', () => {
    test('drawn on the test server with talisman tables, not on live', () => {
        expect(talismanRankingAvailable()).toBe(true);
        mocks.test = false;
        expect(talismanRankingAvailable()).toBe(false);
    });
});

describe('combat ranking', () => {
    test('opens collapsed, and the estimate names the sims, slots and power', () => {
        expect(q('body').style.display).toBe('none');
        q('header').click();
        expect(q('body').style.display).toBe('block');
    });

    test('a finished run draws the table, the set and the combined check', async () => {
        await run();
        const shown = text();
        expect(shown).toContain('Golem Cave');
        expect(shown).toContain('Critical Damage');
        expect(shown).toContain('Recommended set');
        expect(shown).toContain('Combined sim of the set');
        expect(shown).toContain('No effect for this build here');
        expect(shown).not.toMatch(/undefined|NaN/);
        // Practical by default: G3 cap, one Special per talisman, and each talisman's expected orbs
        expect(text()).toContain('Practical: grades capped at G3');
        expect(text()).toMatch(/~[\d.]+ orbs/);
        expect(text()).toContain('weighed by their game item value');
        expect(text()).toContain('Lines from creation and cores roll G1-G3 only (measured, 396 lines)');
    });

    test('no belt: says so and simulates nothing', async () => {
        mocks.roster[0].equipment = {};
        await run();
        expect(text()).toContain('wears no Talisman Belt');
        expect(text()).not.toMatch(/undefined|NaN/);
        expect(mocks.simCalls).toBe(0);
    });

    test('no zone: says so', async () => {
        host._readUpgradeInputs = () => ({ zoneHrid: '', difficultyTier: 0, hours: 10 });
        await run();
        expect(text()).toContain('Select a zone');
        expect(text()).not.toMatch(/undefined|NaN/);
        expect(mocks.simCalls).toBe(0);
    });

    test('Stop part-way: the measured lines stay, no set', async () => {
        // Stop pressed while the 9th sim runs: baseline and 7 lines are in
        mocks.stopAfter = 8;
        mocks.onStop = () => section.stop();
        await run();
        expect(mocks.cancelled).toBe(1);
        expect(text()).toContain('Stopped early: 7 of 48 lines measured');
        expect(text()).toContain('Talisman Power 25.8%');
        expect(text()).not.toContain('Recommended set');
        expect(text()).not.toMatch(/undefined|NaN/);
    });

    test('Stop during the baseline: nothing measured, still drawn whole', async () => {
        mocks.stopAfter = 0;
        mocks.onStop = () => section.stop();
        await run();
        expect(text()).toContain('Stopped early: 0 of 48 lines measured');
        expect(text()).toContain('3 slots');
        expect(text()).not.toMatch(/undefined|NaN/);
    });

    test('a cancel from elsewhere (another panel) ends the run as stopped, rows kept', async () => {
        mocks.stopAfter = 5;
        await run();
        expect(text()).toContain('another simulation cancelled this run');
        expect(text()).toContain('4 of 48');
        expect(text()).not.toContain('Ranking failed');
    });

    test('a character switch mid-run draws nothing', async () => {
        const pending = run();
        mocks.characterId = 'c2';
        await pending;
        expect(text()).not.toContain('Recommended set');
    });

    test('names the ranked player and hours, and hands the panel its owed redraw when it ends', async () => {
        await run();
        expect(text()).toContain('for /players/1');
        expect(text()).toContain('10 h per sim');
        expect(host._afterRun).toHaveBeenCalledTimes(1);
    });

    test('mostly within noise in a dungeon: warned, with more hours or a zone as the fix', async () => {
        mocks.noise = 5;
        mocks.dungeon = true;
        await run();
        expect(text()).toMatch(/\d+ of \d+ lines are within noise/);
        expect(text()).toContain('a zone instead of a dungeon');
        expect(text()).toContain('Re-sim close calls');
    });

    test('a set filled from lines within noise says so', async () => {
        mocks.noise = 5;
        await run();
        expect(text()).toContain('did not clear their error bar');
        expect(text()).toContain('(noise)');
    });

    test('the zone, hours or build changing after a run marks the figures out of date', async () => {
        await run();
        expect(q('stale').style.display).toBe('none');
        host._readUpgradeInputs = () => ({ zoneHrid: '/actions/combat/golem_cave', difficultyTier: 1, hours: 40 });
        section.onShow();
        expect(q('stale').style.display).toBe('block');
        expect(q('stale').textContent).toContain('hours');
    });

    test('the estimate follows the grade select', () => {
        const dto = { hrid: '/players/1', equipment: { '/equipment_types/belt': LARGE_10 }, talismans: [] };
        host._editor = { getEditedDTOs: () => ({ '/players/1': dto }), getSelfHrid: () => '/players/1' };
        q('estimate').textContent = '';
        q('grade').value = '3';
        q('grade').dispatchEvent(new Event('change'));
        expect(q('estimate').textContent).toContain('Up to 56 sims');
    });

    test('refuses while another Combat Sim run is going', async () => {
        host.busy = true;
        await run();
        expect(host.status).toContain('Something else is running');
        expect(mocks.simCalls).toBe(0);
    });
});

describe('Balanced', () => {
    const pick = (role, value) => {
        q(role).value = value;
        q(role).dispatchEvent(new Event('change'));
    };

    test('shows the weights, stores a change, and explains the score and its error bar', async () => {
        pick('metric', 'balanced');
        expect(q('weights').style.display).toBe('inline-flex');
        q('weight-dps').value = '3';
        q('weight-dps').dispatchEvent(new Event('change'));
        expect(mocks.settings.combatSim_talismanBalanceDps).toBe(3);
        await run();
        expect(text()).toContain('XP 1 : Profit 1 : DPS 3');
        expect(text()).toContain('as if fully correlated');
        expect(text()).not.toMatch(/undefined|NaN/);
    });

    test('a line that raises deaths/hr beyond its error bar is flagged ⚠ and scored lower', async () => {
        mocks.deathsFor = { armor: 10 };
        pick('metric', 'balanced');
        await run();
        const armorRow = [...container.querySelectorAll('tr')].find((tr) => tr.textContent.includes('Armor'));
        expect(armorRow.textContent).toContain('⚠');
        expect(armorRow.textContent).toContain('−');
    });
});

describe('set modes and orbs', () => {
    const pick = (role, value) => {
        q(role).value = value;
        q(role).dispatchEvent(new Event('change'));
    };

    test('Budget: the set fits the budget per talisman', async () => {
        pick('set-mode', 'budget');
        expect(q('budget-box').style.display).toBe('inline-flex');
        q('budget').value = '15m';
        await run();
        expect(text()).toContain('Budget: 15m coins (≈50 orbs) per talisman');
        expect(text()).toContain('Recommended set');
    });

    test('Budget too small for any target: says what the cheapest needs', async () => {
        pick('set-mode', 'budget');
        q('budget').value = '3000';
        await run();
        expect(text()).toMatch(
            /No talisman target fits a budget of 3k coins \(≈0\.01 orbs\); the cheapest one measured needs ~[\d.]+/
        );
        expect(text()).not.toContain('Recommended set (');
    });

    test('Budget in coins: shorthand converts at the item value, a bad value blocks the run, a change marks it stale', async () => {
        pick('set-mode', 'budget');
        expect(q('budget').value).toBe('6m');
        q('budget').value = '200m';
        q('budget').dispatchEvent(new Event('input'));
        expect(q('budget-note').textContent).toBe('≈ 667 Reforging Orbs');
        q('budget').value = '15m';
        q('budget').dispatchEvent(new Event('input'));
        await run();
        expect(text()).toContain('Budget: 15m coins (≈50 orbs) per talisman');
        expect(q('stale').style.display).toBe('none');
        q('budget').value = '20m';
        q('budget').dispatchEvent(new Event('input'));
        expect(q('stale').textContent).toContain('Budget changed');
        expect(q('stale').querySelector('[data-role="rebuild"]')).not.toBeNull();
        const sims = mocks.simCalls;
        q('budget').value = 'junk';
        q('budget').dispatchEvent(new Event('input'));
        await run();
        expect(mocks.simCalls).toBe(sims);
        expect(q('notice').textContent).toContain('"junk" is not an amount');
    });

    test('every control and label carries a hover, Balanced weights included', async () => {
        pick('metric', 'balanced');
        pick('set-mode', 'budget');
        const titled = (node) => (node.getAttribute('title') || '').trim().length > 0;
        for (const node of container.querySelectorAll('label, select, input, button')) {
            expect(titled(node), node.outerHTML.slice(0, 80)).toBe(true);
        }
        for (const option of [...q('metric').options, ...q('set-mode').options]) expect(titled(option)).toBe(true);
        await run();
        for (const th of container.querySelectorAll('th')) expect(titled(th), th.textContent).toBe(true);
    });

    test('Ideal keeps the simulated grade', async () => {
        pick('set-mode', 'ideal');
        expect(q('cap-box').style.display).toBe('none');
        await run();
        expect(text()).toContain('Ideal: G6');
    });

    test('value per orb is a column and a sort', async () => {
        await run();
        expect(text()).toContain('per orb (G3)');
        const sort = container.querySelector('[data-role="sort"]');
        sort.value = 'perOrb';
        sort.dispatchEvent(new Event('change', { bubbles: true }));
        expect(container.querySelector('[data-role="sort"]').value).toBe('perOrb');
    });
});

describe('Improve mine', () => {
    const improve = async () => {
        await section._onImprove();
    };
    const armorTalisman = (id, extra = {}) =>
        talismanRow(
            id,
            [
                { hrid: '/talisman_modifiers/armor', grade: 1 },
                { hrid: '/talisman_modifiers/tenacity', grade: 1 },
                { hrid: '/talisman_modifiers/max_hitpoints', grade: 1 },
                { hrid: '/talisman_modifiers/hp_regen', grade: 1 },
            ],
            extra
        );

    test('no owned talismans: says so', async () => {
        await run();
        await improve();
        expect(q('improve').textContent).toContain('You own no talismans yet.');
    });

    test('only skilling talismans: says there are no combat ones', async () => {
        mocks.owned = [armorTalisman(7, { talismanTypeHrid: '/talisman_types/skilling' })];
        await run();
        await improve();
        expect(q('improve').textContent).toContain('You own no combat talismans (1 of the other type)');
    });

    test('options by value per orb, and Aim for this hands the target to the reroll advisor', async () => {
        mocks.owned = [armorTalisman(42, { slotIndex: 2 })];
        const aimAt = vi.fn(() => true);
        globalThis.window.Toolasha = { UI: { talismanRerollAdvisor: { aimAt } } };
        await run();
        await improve();
        const box = q('improve').textContent;
        expect(box).toContain('Talisman #42');
        expect(box).toContain('slot 2');
        expect(box).toMatch(/Critical (Damage|Rate) G\d\+/);
        expect(box).not.toMatch(/undefined|NaN/);
        q('improve').querySelector('[data-role="aim"]').click();
        expect(aimAt).toHaveBeenCalledWith(
            42,
            expect.arrayContaining([expect.objectContaining({ minGrade: expect.any(Number) })])
        );
        expect(q('improve').textContent).toContain('Open talisman #42');
    });

    test('the reroll advisor off: Aim for this says to turn it on', async () => {
        mocks.owned = [armorTalisman(42)];
        await run();
        await improve();
        q('improve').querySelector('[data-role="aim"]').click();
        expect(q('improve').textContent).toContain('reroll advisor is not running');
    });

    test('Stop during the solves: says it stopped', async () => {
        mocks.owned = [armorTalisman(42)];
        await run();
        const pending = improve();
        section.stop();
        await pending;
        expect(q('improve').textContent).toContain('Stopped while working out expected orbs');
    });

    test('every line within noise: the options say so', async () => {
        mocks.owned = [armorTalisman(42)];
        mocks.noise = 50;
        await run();
        await improve();
        expect(q('improve').textContent).toContain('Every line is within noise');
    });
});

describe('detach', () => {
    test('removes the section and stops a run', async () => {
        const pending = run();
        section.detach();
        await pending;
        expect(container.querySelector('#mwi-csim-talisman-rank')).toBeNull();
        expect(section.isBusy()).toBe(false);
        section = null;
    });
});

describe('Improve mine: progress, a second press, the window', () => {
    const armorTalisman = (id) =>
        talismanRow(id, [
            { hrid: '/talisman_modifiers/armor', grade: 1 },
            { hrid: '/talisman_modifiers/tenacity', grade: 1 },
            { hrid: '/talisman_modifiers/max_hitpoints', grade: 1 },
            { hrid: '/talisman_modifiers/hp_regen', grade: 1 },
        ]);

    test('says which solve it is on while it works', async () => {
        mocks.owned = [armorTalisman(42)];
        await run();
        const seen = [];
        const progress = q('progress');
        const observer = new MutationObserver(() => seen.push(progress.textContent));
        observer.observe(progress, { childList: true, characterData: true, subtree: true });
        await section._onImprove();
        observer.disconnect();
        expect(seen.some((t) => /orb solve \d+ \(at most \d+\)/.test(t))).toBe(true);
    });

    test('a second press while it runs stops it, and starts nothing', async () => {
        mocks.owned = [armorTalisman(42)];
        await run();
        const first = section._onImprove();
        expect(container.querySelector('[data-role="improve-run"]').textContent).toBe('Stop Improve mine');
        await section._onImprove();
        await first;
        expect(q('improve').textContent).toContain('Stopped while working out expected orbs');
        expect(section.isBusy()).toBe(false);
        expect(container.querySelector('[data-role="improve-run"]').textContent).toBe('Improve mine');
    });

    test('one "Improve mine" control on the panel, before and after a run', async () => {
        mocks.owned = [armorTalisman(42)];
        await run();
        await section._onImprove();
        const exact = [...container.querySelectorAll('*')].filter(
            (el) => el.children.length === 0 && el.textContent.trim() === 'Improve mine'
        );
        expect(exact).toHaveLength(1);
        expect(exact[0].dataset.role).toBe('improve-run');
    });

    test('Aim for this opens that talisman in the game window when the Talismans panel is on the page', async () => {
        mocks.owned = [armorTalisman(42)];
        const aimAt = vi.fn(() => true);
        globalThis.window.Toolasha = { UI: { talismanRerollAdvisor: { aimAt } } };
        const panelEl = document.createElement('div');
        panelEl.className = 'TalismansPanel_talismansPanel__gLgnr';
        document.body.appendChild(panelEl);
        const setState = vi.fn();
        // The game passes the panel this character's talismans as a Map of id to record
        const own = new Map([[42, { ...mocks.owned[0], characterID: mocks.characterId }]]);
        mocks.panelFiber = {
            stateNode: { state: { selectedTalismanId: 7 }, setState, props: { characterTalismanMap: own } },
            return: null,
        };
        await run();
        await section._onImprove();
        q('improve').querySelector('[data-role="aim"]').click();
        expect(aimAt).toHaveBeenCalled();
        expect(setState).toHaveBeenCalledWith({ selectedTalismanId: 42 });
        // The target goes in before the window opens, so its first draw shows it
        expect(aimAt.mock.invocationCallOrder[0]).toBeLessThan(setState.mock.invocationCallOrder[0]);
        expect(q('improve').textContent).toContain('Talisman #42 is open in the game');
        mocks.panelFiber = null;
    });
});

describe('review round', () => {
    const armorTalisman = (id) =>
        talismanRow(id, [
            { hrid: '/talisman_modifiers/armor', grade: 1 },
            { hrid: '/talisman_modifiers/tenacity', grade: 1 },
            { hrid: '/talisman_modifiers/max_hitpoints', grade: 1 },
            { hrid: '/talisman_modifiers/hp_regen', grade: 1 },
        ]);

    test('a ranking for another player has no Improve mine, and says why', async () => {
        mocks.roster = [
            { hrid: '/players/1', equipment: { '/equipment_types/belt': LARGE_10 }, talismans: [] },
            { hrid: '/players/2', name: 'Mate', equipment: { '/equipment_types/belt': LARGE_10 }, talismans: [] },
        ];
        host._upgradePlayerIndex = () => 1;
        mocks.owned = [armorTalisman(42)];
        await run();
        expect(container.querySelector('[data-role="improve-run"]')).toBeNull();
        expect(text()).toContain('Improve mine is for your own talismans: this ranking is for Mate');
        await section._onImprove();
        expect(q('improve').textContent).not.toContain('Talisman #42');
    });

    test('options from before a character switch are never aimed', async () => {
        mocks.owned = [armorTalisman(42)];
        const aimAt = vi.fn(() => true);
        globalThis.window.Toolasha = { UI: { talismanRerollAdvisor: { aimAt } } };
        await run();
        await section._onImprove();
        mocks.characterId = 'c2';
        q('improve').querySelector('[data-role="aim"]').click();
        expect(aimAt).not.toHaveBeenCalled();
        expect(q('improve').textContent).toContain('for another character');
    });

    test('the advisor refusing a talisman is said as such', async () => {
        mocks.owned = [armorTalisman(42)];
        globalThis.window.Toolasha = { UI: { talismanRerollAdvisor: { initialized: true, aimAt: () => false } } };
        await run();
        await section._onImprove();
        q('improve').querySelector('[data-role="aim"]').click();
        expect(q('improve').textContent).toContain('did not take it: talisman #42 is not one of this character');
    });

    test("a Talismans panel listing another character's talismans is never steered", async () => {
        mocks.owned = [armorTalisman(42)];
        globalThis.window.Toolasha = { UI: { talismanRerollAdvisor: { aimAt: () => true } } };
        const panelEl = document.createElement('div');
        panelEl.className = 'TalismansPanel_talismansPanel__x';
        document.body.appendChild(panelEl);
        const setState = vi.fn();
        const theirs = new Map([[42, { ...mocks.owned[0], characterID: 'someone-else' }]]);
        mocks.panelFiber = {
            stateNode: { state: { selectedTalismanId: 1 }, setState, props: { characterTalismanMap: theirs } },
            return: null,
        };
        await run();
        await section._onImprove();
        q('improve').querySelector('[data-role="aim"]').click();
        expect(setState).not.toHaveBeenCalled();
        expect(q('improve').textContent).toContain('Target handed to the reroll advisor. Open talisman #42');
        mocks.panelFiber = null;
    });

    test('Improve mine counts its own solves, and says when it hit the limit', async () => {
        mocks.owned = [armorTalisman(42)];
        await run();
        // The ranking used the solver; a counter left at the cap must not starve Improve mine
        section._orbs.solves = section._orbs.maxSolves;
        section._orbs.limited = true;
        await section._onImprove();
        expect(q('improve').textContent).toContain('Talisman #42');
        expect(q('improve').textContent).not.toContain('solve limit');
        section._orbs.maxSolves = 0;
        section._orbs.cache.clear();
        await section._onImprove();
        expect(q('improve').textContent).toContain('The orb solve limit (0) was reached');
    });

    test('a press refused while the Combat Sim is busy keeps the ranking table', async () => {
        mocks.owned = [armorTalisman(42)];
        await run();
        host.busy = true;
        await section._onImprove();
        expect(text()).toContain('Critical Damage');
        expect(q('notice').textContent).toContain('Something else is running');
        host.busy = false;
    });

    test('changing a Balanced weight marks a Balanced result out of date', async () => {
        q('metric').value = 'balanced';
        q('metric').dispatchEvent(new Event('change'));
        await run();
        expect(q('stale').style.display).toBe('none');
        q('weight-xp').value = '4';
        q('weight-xp').dispatchEvent(new Event('change'));
        expect(q('stale').textContent).toContain('Balanced weights');
    });

    test('the progress line is cleared when Improve mine ends', async () => {
        mocks.owned = [armorTalisman(42)];
        await run();
        await section._onImprove();
        expect(q('progress').textContent).toBe('');
    });

    test('a Budget set cut short says how many slots it filled', async () => {
        q('set-mode').value = 'budget';
        q('set-mode').dispatchEvent(new Event('change'));
        q('budget').value = '300m';
        await run();
        const result = section._result;
        const one = result.set.talismans[0];
        // As the planner returns it when the solve cap stops it after one slot
        section._render({
            ...result,
            set: { ...result.set, talismans: [one], slots: 3, slotsFilled: 1, limited: true },
        });
        expect(text()).toContain(
            '1 of 3 slots filled: the orb solve limit was reached before the rest could be planned.'
        );
        section._render({
            ...result,
            set: { ...result.set, talismans: [one], slots: 3, slotsFilled: 1, limited: false },
        });
        expect(text()).toContain('1 of 3 slots filled: no further target fit the budget.');
    });
});

describe('solver limits beside every cost', () => {
    test('a set line, value per orb and an Improve mine option carry the note', async () => {
        mocks.owned = [
            talismanRow(42, [
                { hrid: '/talisman_modifiers/armor', grade: 1 },
                { hrid: '/talisman_modifiers/tenacity', grade: 1 },
                { hrid: '/talisman_modifiers/max_hitpoints', grade: 1 },
                { hrid: '/talisman_modifiers/hp_regen', grade: 1 },
            ]),
        ];
        await run();
        const limits = { gradeClamped: true, clampGrade: 5, mutationLeftOut: true };
        const result = section._result;
        const row = result.rows.find((r) => Number.isFinite(r.perOrb));
        row.orbLimits = limits;
        const set = {
            ...result.set,
            talismans: result.set.talismans.map((t) => ({ ...t, cost: { ...t.cost, limits, upperBound: true } })),
        };
        section._render({ ...result, set });
        expect(text()).toContain('upper bound: grades above G5 counted as G5; Mutation left out');
        expect(container.querySelector('td[title*="upper bound"]')).not.toBeNull();
        section._improve = {
            status: 'done',
            ownerId: mocks.characterId,
            options: [
                {
                    talisman: mocks.owned[0],
                    targets: [{ hrid: '/talisman_modifiers/critical_damage', minGrade: 3 }],
                    gain: 5,
                    cost: { orbs: 10, limits, upperBound: true },
                    perOrb: 0.5,
                    withinNoise: 0,
                },
            ],
        };
        section._renderImprove();
        expect(q('improve').textContent).toContain('upper bound: grades above G5 counted as G5; Mutation left out');
    });

    test('Budget says when a target over the budget was only an upper bound', async () => {
        await run();
        section._render({
            ...section._result,
            set: null,
            setReason: 'budget',
            budget: 2,
            cheapest: 3,
            cheapestIsUpperBound: true,
            overUpperBound: 2,
        });
        expect(text()).toContain('2 targets over the budget were costed only as an upper bound');
    });
});

describe('rebuilding a finished ranking without new line sims', () => {
    const pick = (role, value) => {
        q(role).value = value;
        q(role).dispatchEvent(new Event('change'));
    };
    const rebuildButton = () => q('stale').querySelector('[data-role="rebuild"]');

    test('Rank by: offers a re-score, which sims at most the new set and says what it could not redo', async () => {
        await run();
        const ranked = mocks.simCalls;
        pick('metric', 'deaths');
        expect(q('stale').style.display).toBe('block');
        expect(q('stale').textContent).toContain('Rank by changed');
        expect(q('stale').textContent).not.toContain('These figures are out of date');
        expect(rebuildButton().textContent).toBe('Re-score and rebuild set');
        await section._onRebuild();
        expect(mocks.simCalls - ranked).toBeLessThanOrEqual(1);
        expect(text()).toContain('Rebuilt from the saved line measurements (scored again by Deaths/hr)');
        expect(text()).toContain('ranked by Deaths/hr');
        expect(text()).toContain('Rank again for the exact picture');
        expect(text()).not.toMatch(/undefined|NaN/);
        expect(q('stale').style.display).toBe('none');
        expect(section._result.rankingId).toBe(2);
    });

    test('Balanced weights that leave the set alone cost no sim at all', async () => {
        pick('metric', 'balanced');
        await run();
        const ranked = mocks.simCalls;
        q('weight-xp').value = '4';
        q('weight-xp').dispatchEvent(new Event('change'));
        expect(q('stale').textContent).toContain('Balanced weights changed');
        await section._onRebuild();
        // The fake sim moves DPS only, so the weights re-score the same order: the stored combined sim stands
        expect(mocks.simCalls).toBe(ranked);
        expect(text()).toContain('no new sims');
        expect(section._result.balanceWeights.xp).toBe(4);
    });

    test('Set mode: rebuilds the set from the same rows with one combined sim', async () => {
        await run();
        const ranked = mocks.simCalls;
        pick('set-mode', 'ideal');
        expect(q('stale').textContent).toContain('Set changed');
        expect(rebuildButton().textContent).toBe('Rebuild set');
        await section._onRebuild();
        expect(mocks.simCalls - ranked).toBe(1);
        expect(text()).toContain('Ideal: G6');
        expect(text()).toContain('the new set was checked with one more sim');
        expect(text()).toContain('Combined sim of the set');
        expect(q('stale').style.display).toBe('none');
        // Cores and Improve mine read a result that is still the ranking's: kept for a set-only rebuild
        expect(section._result.rebuilt.rescored).toBe(false);
    });

    test('Cap: a Practical set is rebuilt for it, and in Ideal the Cap is not an input', async () => {
        await run();
        pick('cap', '2');
        expect(q('stale').textContent).toContain('Cap changed');
        await section._onRebuild();
        expect(text()).toContain('Practical: grades capped at G2');
        pick('set-mode', 'ideal');
        await section._onRebuild();
        pick('cap', '4');
        expect(q('stale').style.display).toBe('none');
    });

    test('grade, zone, tier, hours and build need a new Rank: no button, and the press is refused', async () => {
        await run();
        const ranked = mocks.simCalls;
        pick('grade', '4');
        expect(q('stale').textContent).toContain('the grade changed since the ranking ran. Rank again.');
        expect(rebuildButton()).toBeNull();
        pick('metric', 'deaths');
        // Rank-forcing inputs win: only "Rank again" is offered, never a rebuild on a stale measurement
        expect(rebuildButton()).toBeNull();
        await section._onRebuild();
        expect(mocks.simCalls).toBe(ranked);
        expect(q('notice').textContent).toContain('grade changed');
        expect(section._result.metricKey).toBe('dps');
    });

    test('a stopped ranking still says a changed weight or budget needs a new Rank', async () => {
        pick('metric', 'balanced');
        mocks.stopAfter = 5;
        mocks.onStop = () => section.stop();
        await run();
        expect(section._result.status).toBe('stopped');
        expect(q('stale').style.display).toBe('none');
        q('weight-dps').value = '3';
        q('weight-dps').dispatchEvent(new Event('change'));
        expect(q('stale').textContent).toContain('Balanced weights changed');
        expect(q('stale').textContent).toContain('Rank again.');
        expect(rebuildButton()).toBeNull();
    });

    test('a character switch or a changed community buff forces a Rank, not a rebuild', async () => {
        await run();
        mocks.buffs = { experience: 5 };
        section.onShow();
        expect(q('stale').textContent).toContain('community buffs');
        expect(rebuildButton()).toBeNull();
        mocks.buffs = null;
        section.onShow();
        expect(q('stale').style.display).toBe('none');
        mocks.characterId = 'c2';
        section.onShow();
        expect(q('stale').textContent).toContain('character');
        expect(q('stale').textContent).toContain('Rank again.');
        expect(rebuildButton()).toBeNull();
    });

    test('the core advisor keeps its figures through a set-only rebuild, and loses them to a re-score', async () => {
        await run();
        const before = section._coreInputsNow().ranking;
        pick('set-mode', 'ideal');
        await section._onRebuild();
        expect(section._coreInputsNow().ranking).toBe(before);
        pick('metric', 'deaths');
        await section._onRebuild();
        expect(section._coreInputsNow().ranking).not.toBe(before);
    });

    test('a stopped rebuild leaves the ranking exactly as it was', async () => {
        await run();
        const before = section._result;
        const drawn = q('results').innerHTML;
        mocks.stopAfter = mocks.simCalls;
        mocks.onStop = () => section.stop();
        pick('set-mode', 'ideal');
        await section._onRebuild();
        expect(section._result).toBe(before);
        expect(q('results').innerHTML).toBe(drawn);
        expect(q('notice').textContent).toContain('Rebuild stopped');
        expect(q('notice').textContent).toContain('unchanged');
        // The control still differs, so the way to try again is still offered
        expect(rebuildButton()).not.toBeNull();
        expect(section.isBusy()).toBe(false);
    });

    test('refused while the Combat Sim is busy, with the ranking kept', async () => {
        await run();
        pick('set-mode', 'ideal');
        host.busy = true;
        const drawn = q('results').innerHTML;
        await section._onRebuild();
        expect(q('notice').textContent).toContain('Something else is running');
        expect(q('results').innerHTML).toBe(drawn);
        host.busy = false;
    });

    test('a Budget rebuild with an unreadable budget is refused with the reason', async () => {
        await run();
        pick('set-mode', 'budget');
        q('budget').value = 'junk';
        q('budget').dispatchEvent(new Event('input'));
        const ranked = mocks.simCalls;
        await section._onRebuild();
        expect(mocks.simCalls).toBe(ranked);
        expect(q('notice').textContent).toContain('"junk" is not an amount');
    });

    test('the rebuilt result is what Copy targets, Improve mine and the cores read', async () => {
        mocks.owned = [
            talismanRow(42, [
                { hrid: '/talisman_modifiers/armor', grade: 1 },
                { hrid: '/talisman_modifiers/tenacity', grade: 1 },
            ]),
        ];
        await run();
        await section._onImprove();
        expect(section._improve).not.toBeNull();
        pick('set-mode', 'ideal');
        await section._onRebuild();
        // The options were worked out for the old set mode
        expect(section._improve).toBeNull();
        expect(q('improve').innerHTML).toBe('');
        const targets = section._result.rerollTargets;
        expect(targets.length).toBeGreaterThan(0);
        expect(targets.flat().every((t) => t.minGrade === 6)).toBe(true);
        await section._onImprove();
        expect(section._improve.status).not.toBe('none_owned');
    });
});

describe('Use in Configure', () => {
    const dtoOf = (hrid, talismans = []) => ({
        hrid,
        equipment: { '/equipment_types/belt': LARGE_10 },
        talismans,
    });
    let dtos;
    let editor;

    beforeEach(() => {
        dtos = { '/players/1': dtoOf('/players/1'), '/players/2': dtoOf('/players/2') };
        mocks.roster = Object.values(dtos);
        editor = {
            getEditedDTOs: () => dtos,
            getSelfHrid: () => '/players/1',
            getPlayerInfo: () => [
                { hrid: '/players/1', name: 'Me' },
                { hrid: '/players/2', name: 'Mate' },
            ],
            applyTalismans: vi.fn((hrid, talismans) => {
                dtos[hrid].talismans = talismans;
                return { ok: true, slots: 3 };
            }),
        };
        host._editor = editor;
    });

    const pick = (role, value) => {
        q(role).value = value;
        q(role).dispatchEvent(new Event('change'));
    };
    const useButton = () => container.querySelector('[data-role="use-configure"]');
    const noteText = () => container.querySelector('[data-role="use-configure-note"]').textContent;

    test('the button sits beside Copy targets and says what it replaces', async () => {
        await run();
        expect(useButton()).not.toBeNull();
        expect(useButton().title).toContain("Belt rows of Me's seat");
        expect(useButton().title).toContain('replacing the talismans in every belt slot');
        expect(useButton().previousElementSibling.dataset.role).toBe('copy-targets');
    });

    test('writes the recommended set to the player the ranking was run for, found by hrid', async () => {
        await run();
        const set = section._result.set.talismans;
        useButton().click();
        expect(editor.applyTalismans).toHaveBeenCalledTimes(1);
        expect(editor.applyTalismans.mock.calls[0][0]).toBe('/players/1');
        expect(editor.applyTalismans.mock.calls[0][1].map((t) => [t.slotIndex, t.modifiers])).toEqual(
            set.map((t) => [t.slotIndex, t.modifiers])
        );
        expect(dtos['/players/2'].talismans).toEqual([]);
        expect(noteText()).toContain("Written to Me's Belt rows in Configure");
        // The build changed on purpose: the note says it is out of date and why
        expect(q('stale').textContent).toContain('build');
        expect(q('stale').textContent).toContain('a set applied in Configure counts');
        // Only this player's talismans changed: pressing it again is fine
        useButton().click();
        expect(editor.applyTalismans).toHaveBeenCalledTimes(2);
    });

    test('a seat that now holds someone else, or a reordered roster, is refused', async () => {
        await run();
        // Configure loaded another person into the same seat (same hrid)
        editor.getPlayerInfo = () => [
            { hrid: '/players/1', name: 'Bob' },
            { hrid: '/players/2', name: 'Mate' },
        ];
        useButton().click();
        expect(editor.applyTalismans).not.toHaveBeenCalled();
        expect(noteText()).toContain('now holds Bob, not Me');
        editor.getPlayerInfo = () => [{ hrid: '/players/1', name: 'Me' }];
        dtos = { '/players/2': dtos['/players/2'], '/players/1': dtos['/players/1'] };
        editor.getEditedDTOs = () => dtos;
        useButton().click();
        expect(editor.applyTalismans).not.toHaveBeenCalled();
        expect(noteText()).toContain('The player, ');
    });

    test('a changed zone, hours, grade, gear, party member or buff refuses; talismans alone do not', async () => {
        await run();
        const refused = (word) => {
            useButton().click();
            expect(editor.applyTalismans).not.toHaveBeenCalled();
            expect(noteText()).toContain(word);
        };
        const inputs = host._readUpgradeInputs;
        host._readUpgradeInputs = () => ({ ...inputs(), zoneHrid: '/actions/combat/other' });
        refused('zone');
        host._readUpgradeInputs = () => ({ ...inputs(), hours: 99 });
        refused('hours');
        host._readUpgradeInputs = inputs;
        pick('grade', '4');
        refused('grade');
        pick('grade', '6');
        dtos['/players/1'].equipment['/equipment_types/head'] = { hrid: '/items/hat', enhancementLevel: 0 };
        refused('gear or build');
        delete dtos['/players/1'].equipment['/equipment_types/head'];
        dtos['/players/2'].attackLevel = 99;
        refused('party');
        dtos['/players/2'].attackLevel = undefined;
        dtos['/players/1'].talismans = [{ slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 1 }] }];
        useButton().click();
        expect(editor.applyTalismans).toHaveBeenCalledTimes(1);
    });

    test('a player no longer in the roster is refused, and nothing is written', async () => {
        await run();
        delete dtos['/players/1'];
        useButton().click();
        expect(editor.applyTalismans).not.toHaveBeenCalled();
        expect(noteText()).toContain('Me is no longer in the Configure roster');
    });

    test('the editor refusing (the belt is gone) is said, not hidden', async () => {
        await run();
        editor.applyTalismans = vi.fn(() => ({ ok: false, reason: 'no_belt', slots: 0 }));
        useButton().click();
        expect(noteText()).toContain('wears no Talisman Belt in Configure now');
        editor.applyTalismans = vi.fn(() => ({ ok: false, reason: 'too_many_slots', slots: 2 }));
        useButton().click();
        expect(noteText()).toContain('belt has 2 slots, fewer than this set uses');
    });

    test('no editor, a run in flight and another character each refuse', async () => {
        await run();
        host._editor = null;
        useButton().click();
        expect(noteText()).toContain('Configure tab has no build loaded');
        host._editor = editor;
        mocks.characterId = 'c2';
        useButton().click();
        expect(noteText()).toContain('character changed');
        expect(editor.applyTalismans).not.toHaveBeenCalled();
    });

    test('a rebuilt set is the one written', async () => {
        await run();
        q('set-mode').value = 'ideal';
        q('set-mode').dispatchEvent(new Event('change'));
        await section._onRebuild();
        useButton().click();
        const written = editor.applyTalismans.mock.calls[0][1];
        expect(written.flatMap((t) => t.modifiers).every((m) => m.grade === 6)).toBe(true);
    });
});
