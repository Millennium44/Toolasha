/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../../__fixtures__/talisman-full-modifiers.js';
import { TALISMAN_INFO, ORB_ITEMS, talismanRow } from '../../__fixtures__/talisman-reroll.js';

const mocks = vi.hoisted(() => ({
    noInfo: false,
    /** Player price overrides by item hrid (market-data's `custom` source); all orbs must have one to be used */
    overrides: {},
    owned: [],
    calculatorCalls: 0,
}));

function gameData() {
    return {
        talismanModifierDetailMap: FULL_MODIFIER_DETAILS,
        itemDetailMap: { ...BELT_ITEMS, ...ORB_ITEMS },
        enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
        talismanInfo: mocks.noInfo ? null : TALISMAN_INFO,
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

// These tests are about the budget (parsing, conversion, labels, stale), not the orb solve, which is slow:
// a flat cost of 5 orbs per grade step of each target line keeps the set and Improve mine paths real and cheap
vi.mock('../../utils/talisman-orb-costs.js', async (importOriginal) => {
    const original = await importOriginal();
    const cost = (solver, targets, status) => ({
        orbs: targets.reduce((sum, t) => sum + 5 * t.minGrade, 0),
        counts: {},
        fresh: true,
        status,
        limits: { gradeClamped: false, clampGrade: 6, mutationLeftOut: false },
        upperBound: false,
    });
    class CheapSolver extends original.OrbCostSolver {
        async freshCost(_type, targets) {
            return cost(this, targets);
        }
        async ownedCost(_talisman, targets) {
            return cost(this, targets, 'steps');
        }
    }
    return { ...original, OrbCostSolver: CheapSolver };
});
vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => true,
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => gameData(),
        getCurrentCharacterId: () => 'c1',
        getCharacterTalismans: () => mocks.owned,
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid) =>
        hrid in mocks.overrides
            ? { price: mocks.overrides[hrid], source: 'custom', estimated: false }
            : { price: null, source: null, estimated: false },
}));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionTalismans: () => [],
    describeActionContextSource: (type) => ({
        key: `skill:${type}:Milking ★`,
        label: 'Milking ★ (the loadout this skill equips)',
    }),
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
vi.mock('../../utils/bundle-bridge.js', () => ({
    gatheringProfit: () => ({
        calculateGatheringProfit: async (_hrid, { actionContext }) => {
            mocks.calculatorCalls++;
            const s = mocks.bonuses(actionContext.equipment).noncombat;
            const rate = 100 * (1 + (s.milkingSpeed || 0) + (s.skillingSpeed || 0));
            return {
                profitPerHour: rate * 10,
                revenuePerHour: rate * 10,
                actionsPerHour: rate,
                efficiencyMultiplier: 1,
                hasMissingPrices: false,
            };
        },
    }),
    productionProfit: () => null,
    marketUndercutAlerts: () => null,
    guildMemberSkills: () => null,
}));

mocks.bonuses = (await import('../../utils/talisman-bonuses.js')).talismanBonusesOf;
const { SkillingTalismanSection } = await import('./skilling-talisman-section.js');
const { budgetCoinsText, parseBudgetCoins, DEFAULT_BUDGET } = await import('./talisman-ranking-view.js');

const SKILL_HOST = { getSkill: () => 'Milking', getSelectedActions: () => null };
let section;
let container;
const q = (role) => container.querySelector(`[data-role="${role}"]`);
const text = () => container.textContent;

function mount() {
    section?.detach();
    container?.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    section = new SkillingTalismanSection(SKILL_HOST);
    section.mount(container);
}
function pick(role, value) {
    q(role).value = value;
    q(role).dispatchEvent(new Event('change'));
}
function type(value) {
    q('budget').value = value;
    q('budget').dispatchEvent(new Event('input'));
}
/** Every orb with an override, the Reforging Orb at its own price */
function overrideAllOrbs(reforging, others = 400000) {
    for (const hrid of [...Object.keys(TALISMAN_INFO.rerollInputMap), TALISMAN_INFO.lockInputItemHrid]) {
        mocks.overrides[hrid] = others;
    }
    mocks.overrides['/items/reforging_orb'] = reforging;
}

beforeEach(() => {
    mocks.noInfo = false;
    mocks.overrides = {};
    mocks.owned = [];
    mocks.calculatorCalls = 0;
    mount();
});
afterEach(() => {
    section?.detach();
    document.body.innerHTML = '';
});

describe('parsing the budget', () => {
    test('shorthand and plain amounts are coins; junk and blank are errors', () => {
        for (const [raw, coins] of [
            ['200m', 200e6],
            ['1.5b', 1.5e9],
            ['500k', 5e5],
            ['6,000,000', 6e6],
            ['6000000', 6e6],
            ['0', 0],
        ]) {
            expect(parseBudgetCoins(raw)).toEqual({ ok: true, coins });
        }
        for (const raw of ['', '  ', 'abc', '12 bananas', '-5', '1..5m']) {
            const parsed = parseBudgetCoins(raw);
            expect(parsed.ok).toBe(false);
            expect(parsed.error.length).toBeGreaterThan(0);
        }
    });

    test('coins print back as shorthand', () => {
        expect(budgetCoinsText(6e6)).toBe('6m');
        expect(budgetCoinsText(1.5e9)).toBe('1.5b');
        expect(budgetCoinsText(250000)).toBe('250k');
        expect(budgetCoinsText(1234567)).toBe('1,234,567');
        expect(parseBudgetCoins(budgetCoinsText(1234567))).toEqual({ ok: true, coins: 1234567 });
    });
});

describe('the budget field', () => {
    test('default is 20 Reforging Orbs in coins (6m at item value) with the conversion beside it', () => {
        expect(DEFAULT_BUDGET).toBe(20);
        expect(q('budget').value).toBe('6m');
        expect(q('budget-note').textContent).toBe('≈ 20 Reforging Orbs');
        expect(q('budget').style.borderColor).toBe('');
    });

    test('200m converts at the reference weight, updating as typed', () => {
        type('200m');
        expect(q('budget-note').textContent).toBe('≈ 667 Reforging Orbs');
        expect(section._readControls().budget).toBeCloseTo(200e6 / 300000, 6);
        type('1.5b');
        expect(q('budget-note').textContent).toBe('≈ 5000 Reforging Orbs');
    });

    test('a player price override moves the scale: default and conversion follow it', () => {
        overrideAllOrbs(500000);
        mount();
        expect(q('budget').value).toBe('10m');
        type('200m');
        expect(q('budget-note').textContent).toBe('≈ 400 Reforging Orbs');
        expect(section._readControls().budget).toBeCloseTo(400, 6);
    });

    test('the run converts with its own solver weights', async () => {
        pick('set-mode', 'budget');
        type('15m');
        await section._onRun();
        expect(section._result.budget).toBeCloseTo(50, 6);
        expect(section._result.budgetCoins).toBe(15e6);
        expect(text()).toContain('Budget: 15m coins (≈50 orbs) per talisman');
        overrideAllOrbs(500000);
        expect(section._readControls().budget).toBeCloseTo(30, 6);
    });

    test('invalid text marks the field with the reason and blocks Rank', async () => {
        pick('set-mode', 'budget');
        type('lots');
        expect(q('budget').style.borderColor).toBe('#f44336');
        expect(q('budget').title).toContain('not an amount');
        expect(q('budget-note').textContent).toContain('not an amount');
        await section._onRun();
        expect(mocks.calculatorCalls).toBe(0);
        expect(text()).toContain('"lots" is not an amount');
        expect(section._result).toBeNull();
        type('');
        await section._onRun();
        expect(mocks.calculatorCalls).toBe(0);
        expect(text()).toContain('Type a budget in coins');
    });

    test('a bad budget with a ranking drawn leaves it and says why', async () => {
        await section._onRun();
        const drawn = q('results').innerHTML;
        pick('set-mode', 'budget');
        type('x');
        await section._onRun();
        expect(q('results').innerHTML).toBe(drawn);
        expect(q('notice').textContent).toContain('is not an amount');
    });

    test('a bad budget does not matter outside Budget mode', async () => {
        type('x');
        await section._onRun();
        expect(text()).toContain('Practical');
    });

    test('no orb values (game data not loaded): says so and refuses a Budget run', async () => {
        mocks.noInfo = true;
        mount();
        expect(q('budget').value).toBe('');
        expect(q('budget-note').textContent).toContain('not available');
        expect(section._readControls().budget).toBe(0);
        pick('set-mode', 'budget');
        type('200m');
        await section._onRun();
        expect(mocks.calculatorCalls).toBe(0);
        expect(text()).toContain('not available');
        expect(text()).not.toMatch(/NaN|Infinity|undefined/);
    });

    test('a changed budget marks a Budget result stale; changing it back clears it', async () => {
        pick('set-mode', 'budget');
        type('15m');
        await section._onRun();
        expect(q('stale').style.display).toBe('none');
        type('30m');
        expect(q('stale').style.display).toBe('block');
        expect(q('stale').textContent).toContain('another budget');
        type('15m');
        expect(q('stale').style.display).toBe('none');
        // A Practical result has no budget to go stale
        section._result = { ...section._result, setMode: 'practical' };
        type('31m');
        expect(q('stale').style.display).toBe('none');
    });

    test('editing the budget while a run is in flight leaves the result labelled with the run-start budget', async () => {
        pick('set-mode', 'budget');
        type('15m');
        const running = section._onRun();
        type('6m');
        await running;
        expect(section._result.budget).toBeCloseTo(50, 6);
        expect(section._result.budgetCoins).toBe(15e6);
        expect(text()).toContain('Budget: 15m coins (≈50 orbs)');
        // The field now differs from what was ranked, so the result is stale
        expect(q('stale').style.display).toBe('block');
    });

    test('the budget is not persisted: a new section starts at the default', () => {
        type('99m');
        mount();
        expect(q('budget').value).toBe('6m');
    });
});

describe('hover text on every control', () => {
    const titled = (node) => (node.getAttribute('title') || '').trim().length > 0;

    test('labels, controls and options carry a title', () => {
        pick('set-mode', 'budget');
        for (const role of ['metric', 'grade', 'set-mode', 'cap', 'budget', 'budget-note', 'run', 'stop', 'action']) {
            expect(titled(q(role)), role).toBe(true);
        }
        for (const label of container.querySelectorAll('label')) expect(titled(label), label.textContent).toBe(true);
        for (const option of [...q('metric').options, ...q('set-mode').options]) {
            expect(titled(option), option.textContent).toBe(true);
        }
    });

    test('the result: table headers, sort, copy targets, Improve mine, Aim for this', async () => {
        mocks.owned = [
            talismanRow(9, [{ hrid: '/talisman_modifiers/milking_speed', grade: 1 }], {
                talismanTypeHrid: '/talisman_types/skilling',
            }),
        ];
        pick('set-mode', 'budget');
        await section._onRun();
        await section._onImprove();
        const headers = [...container.querySelectorAll('th')];
        expect(headers.length).toBeGreaterThan(8);
        for (const th of headers) expect(titled(th), th.textContent).toBe(true);
        for (const selector of [
            '[data-role="sort"]',
            '[data-role="copy-targets"]',
            '[data-role="improve-run"]',
            '[data-role="aim"]',
        ]) {
            expect(titled(container.querySelector(selector)), selector).toBe(true);
        }
        for (const option of container.querySelector('[data-role="sort"]').options) expect(titled(option)).toBe(true);
    });
});
