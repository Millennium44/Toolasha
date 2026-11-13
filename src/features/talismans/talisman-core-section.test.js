/** @vitest-environment happy-dom */
/**
 * The core advisor as the Optimizer's Talismans section draws it: it needs a finished ranking, values the next line
 * of each worn talisman from the ranking's rows, prices the cores from the market, and clears with the ranking.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../../__fixtures__/talisman-full-modifiers.js';
import { TALISMAN_INFO, ORB_ITEMS } from '../../__fixtures__/talisman-reroll.js';

const mocks = vi.hoisted(() => ({
    test: true,
    characterId: 'c1',
    belt: { hrid: '/items/medium_talisman_belt', level: 4 },
    /** The worn talisman records of the gear (the game's shape; slotIndex is 1-based) */
    worn: [],
    tool: 0,
    teas: [],
    prices: {},
    gatheringCalculator: null,
}));

function gameData() {
    return {
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
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => gameData(),
        getCurrentCharacterId: () => mocks.characterId,
        getCharacterTalismans: () => [],
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid, options) => {
        const price = mocks.prices[`${hrid}@${options.enhancementLevel}@${options.side}`];
        return price ? { price, source: 'book', estimated: false } : { price: null, source: null, estimated: false };
    },
}));
vi.mock('../../utils/action-context.js', async () => {
    const { BELT_LOCATION } = await import('../../utils/talisman-bonuses.js');
    return {
        resolveActionTalismans: () => mocks.worn,
        describeActionContextSource: (type) => ({
            key: `skill:${type}:Milking`,
            label: 'Milking (the loadout this skill equips)',
        }),
        resolveActionContext: () => ({
            equipment: new Map([
                [
                    BELT_LOCATION,
                    { itemHrid: mocks.belt.hrid, enhancementLevel: mocks.belt.level, itemLocationHrid: BELT_LOCATION },
                ],
                ['/item_locations/main_hand', { itemHrid: '/items/milking_tool', enhancementLevel: mocks.tool }],
            ]),
            drinks: mocks.teas.map((itemHrid) => ({ itemHrid })),
        }),
    };
});
vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: 1 }),
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    gatheringProfit: () => mocks.gatheringCalculator,
    productionProfit: () => null,
    marketUndercutAlerts: () => null,
    guildMemberSkills: () => null,
}));

const { talismanBonusesOf } = await import('../../utils/talisman-bonuses.js');
const { SkillingTalismanSection } = await import('./skilling-talisman-section.js');

const SKILLING = '/talisman_types/skilling';
const MILKING_SPEED = '/talisman_modifiers/milking_speed';
const talisman = (slotIndex, hrids) => ({
    id: 40 + slotIndex,
    talismanTypeHrid: SKILLING,
    slotIndex,
    modifiers: hrids.map((hrid) => ({ hrid, grade: 2 })),
});
const OTHERS = [
    '/talisman_modifiers/skilling_speed',
    '/talisman_modifiers/skilling_efficiency',
    '/talisman_modifiers/skilling_rare_find',
];

let section;
let container;
const q = (role) => container.querySelector(`[data-role="${role}"]`);
const cores = () => q('core-results').textContent;
const rank = () => section._onRun();
const check = () => section._onCores();

beforeEach(() => {
    mocks.test = true;
    mocks.characterId = 'c1';
    mocks.belt = { hrid: '/items/medium_talisman_belt', level: 4 };
    mocks.worn = [talisman(1, [MILKING_SPEED]), talisman(2, [MILKING_SPEED, OTHERS[0]])];
    mocks.tool = 0;
    mocks.teas = [];
    mocks.prices = {};
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
    container = document.createElement('div');
    document.body.appendChild(container);
    section = new SkillingTalismanSection({ getSkill: () => 'Milking', getSelectedActions: () => null });
    section.mount(container);
});

afterEach(() => {
    section?.detach();
    document.body.innerHTML = '';
});

describe('the core advisor in the Optimizer', () => {
    test('before the ranking ran it says to run the ranking first', async () => {
        await check();
        expect(cores()).toContain('Run the ranking first');
        expect(section._core).toBeNull();
    });

    test('unpriced is shown plainly: the gain, no gain per cost, the reason on hover', async () => {
        await rank();
        await check();
        const text = cores();
        expect(text).toContain('line 2');
        const bySlot = Object.fromEntries(section._core.rows.map((r) => [r.slotIndex, r]));
        expect(bySlot[1].value).toBeGreaterThan(0);
        expect(bySlot[1].pUseful).toBeGreaterThan(0);
        expect(bySlot[1].best).not.toBeNull();
        // Slot 2 already holds the only two lines that change this action: nothing it can roll is worth anything
        expect(bySlot[2].value).toBe(0);
        expect(text).toContain('No line it can roll is worth anything here.');
        expect(text).toContain('line 3');
        expect(text).toContain('No price');
        expect(text).toContain('Unpriced: no gain per cost.');
        expect(text).not.toMatch(/undefined|NaN|Infinity|free/);
        const unpriced = [...q('core-results').querySelectorAll('span[title]')].find(
            (s) => s.textContent === 'No price'
        );
        expect(unpriced.title).toContain('Basic Talisman Core');
        expect(section._core.rows).toHaveLength(2);
    });

    test('an expert core quoted but a basic one not: only the priced row gets a cost', async () => {
        mocks.worn = [talisman(1, [MILKING_SPEED]), talisman(2, [MILKING_SPEED, OTHERS[0], OTHERS[1]])];
        mocks.prices['/items/expert_talisman_core@0@buy'] = 3e8;
        await rank();
        await check();
        const byLine = Object.fromEntries(section._core.rows.map((r) => [r.lineNumber, r.costs.market.price]));
        expect(byLine).toEqual({ 2: null, 4: 3e8 });
        expect(cores()).toContain('300.0M');
        // The priced row never sorts below an unpriced one
        expect(section._core.rows[section._core.rows.length - 1].costs.market.price).toBeNull();
    });

    test('every control and column has a hover', async () => {
        for (const role of ['core-run']) expect(q(role).title).not.toBe('');
        expect(q('core-controls').querySelector('span').title).not.toBe('');
        await rank();
        await check();
        for (const th of q('core-results').querySelectorAll('th')) expect(th.title).not.toBe('');
    });

    test('every worn talisman has 4 lines: nothing to add', async () => {
        mocks.worn = [talisman(1, [MILKING_SPEED, ...OTHERS])];
        await rank();
        await check();
        expect(cores()).toContain('already has 4 lines');
    });

    test('no skilling talisman worn: says so', async () => {
        mocks.worn = [];
        await rank();
        await check();
        expect(cores()).toContain('No talisman of this type is worn');
    });

    test('a new ranking clears the cores and a stopped ranking is not used', async () => {
        await rank();
        await check();
        expect(section._core).not.toBeNull();
        await rank();
        expect(section._core).toBeNull();
        expect(q('core-results').innerHTML).toBe('');
    });

    test('a belt change after the ranking is said: rank again', async () => {
        await rank();
        mocks.belt = { hrid: '/items/medium_talisman_belt', level: 6 };
        await check();
        expect(cores()).toContain('out of date for this gear');
    });

    test('a core price moving, or the worn lines changing, marks the figures out of date', async () => {
        await rank();
        await check();
        expect(q('core-stale').style.display).toBe('none');
        mocks.prices['/items/basic_talisman_core@0@buy'] = 1e6;
        section._refreshStale();
        expect(q('core-stale').style.display).toBe('block');
        expect(q('core-stale').textContent).toContain('core prices');
        await check();
        expect(q('core-stale').style.display).toBe('none');
        mocks.worn = [talisman(1, [MILKING_SPEED])];
        section._refreshStale();
        expect(q('core-stale').textContent).toContain('gear');
    });

    test('detach drops the result', async () => {
        await rank();
        await check();
        section.detach();
        expect(section._core).toBeNull();
    });

    test('off the test server the advisor refuses', async () => {
        await rank();
        mocks.test = false;
        await check();
        expect(section._core).toBeNull();
    });

    test('a loadout picked after the ranking is not valued with the old rows', async () => {
        const beltMap = () =>
            new Map([['/item_locations/belt', { itemHrid: '/items/medium_talisman_belt', enhancementLevel: 4 }]]);
        let gear = { key: 'A', label: 'A loadout', equipment: beltMap(), drinks: [], talismans: mocks.worn };
        section.detach();
        container.innerHTML = '';
        section = new SkillingTalismanSection({
            getSkill: () => 'Milking',
            getSelectedActions: () => null,
            getGearContext: () => gear,
        });
        section.mount(container);
        await rank();
        gear = { ...gear, key: 'B', label: 'B loadout', talismans: [talisman(1, [OTHERS[1]])] };
        await check();
        expect(cores()).toContain('out of date for this gear');
        expect(section._core.rows).toHaveLength(0);
    });

    test('a worn talisman with no lines is not valued', async () => {
        mocks.worn = [talisman(1, []), talisman(2, [MILKING_SPEED])];
        await rank();
        await check();
        expect(section._core.rows.map((r) => r.slotIndex)).toEqual([2]);
    });

    test('live shape: nothing slotted live, the picked loadout names a 1-line talisman: a row for line 2 is drawn', async () => {
        mocks.worn = [];
        const gear = {
            key: JSON.stringify(['loadout', 'Woodcutting', ['/items/large_talisman_belt', 20], { 1: 2837 }]),
            label: 'Woodcutting ★ loadout',
            equipment: new Map([
                ['/item_locations/belt', { itemHrid: '/items/medium_talisman_belt', enhancementLevel: 4 }],
            ]),
            drinks: [],
            talismans: [talisman(1, [MILKING_SPEED])],
        };
        section.detach();
        container.innerHTML = '';
        section = new SkillingTalismanSection({
            getSkill: () => 'Milking',
            getSelectedActions: () => null,
            getGearContext: () => ({ ...gear, equipment: new Map(gear.equipment) }),
        });
        section.mount(container);
        await rank();
        await check();
        expect(cores()).not.toBe('');
        expect(section._core.status).toBe('done');
        expect(section._core.rows.map((r) => r.lineNumber)).toEqual([2]);
        expect(cores()).toContain('No price');
    });

    test('a ranking replaced while the check waits is said, not left blank', async () => {
        await rank();
        section._coreContext = async () => {
            section._result = { ...section._result };
            return { status: 'refused', message: 'x' };
        };
        await check();
        expect(cores()).toContain('The ranking changed while checking');
    });

    test('a result that draws nothing is reported, not left blank', async () => {
        await rank();
        section._renderCores = () => {};
        await check();
        expect(cores()).not.toBe('');
    });

    test('a DOM click on the Check cores button runs the check, as the belt button does', async () => {
        await rank();
        q('core-run').click();
        await vi.waitFor(() => expect(cores()).not.toBe(''));
        expect(section._core.status).toBe('done');
        expect(q('core-run').style.display).toBe('');
    });

    test('the belt and core results sit right under their own controls, not below the ranking table', () => {
        const next = (role, n = 1) => {
            let el = q(role);
            for (let k = 0; k < n; k++) el = el.nextElementSibling;
            return el?.dataset.role;
        };
        expect(next('core-controls')).toBe('core-stale');
        expect(next('core-controls', 2)).toBe('core-results');
        expect(next('belt-controls')).toBe('belt-stale');
        expect(next('belt-controls', 2)).toBe('belt-results');
        const order = [...q('core-controls').parentElement.children].map((el) => el.dataset.role);
        expect(order.indexOf('core-results')).toBeLessThan(order.indexOf('results'));
        expect(order.indexOf('belt-results')).toBeLessThan(order.indexOf('results'));
    });

    test('a tool or a tea changed after the ranking (same loadout name) is not valued with the old rows', async () => {
        await rank();
        mocks.tool = 5;
        await check();
        expect(cores()).toContain('out of date for this gear');
        await rank();
        mocks.teas = ['/items/efficiency_tea'];
        await check();
        expect(cores()).toContain('out of date for this gear');
        await rank();
        await check();
        expect(section._core.status).toBe('done');
    });

    test('a profit ranking with missing output prices says so, and labels the rows as floors', async () => {
        const base = mocks.gatheringCalculator.calculateGatheringProfit;
        mocks.gatheringCalculator = {
            calculateGatheringProfit: async (...args) => ({
                ...(await base(...args)),
                hasMissingPrices: true,
            }),
        };
        await rank();
        await check();
        expect(section._core.hasMissingPrices).toBe(true);
        expect(cores()).toContain('Some prices are missing and are left out: profit figures are floors.');
        expect(cores()).toContain('Some prices are missing: profit is a floor.');
        expect(cores()).toMatch(/≥\+?\d/);
    });
});
