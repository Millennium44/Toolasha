/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../../__fixtures__/talisman-full-modifiers.js';
import { TALISMAN_INFO, ORB_ITEMS, talismanRow } from '../../__fixtures__/talisman-reroll.js';

const mocks = vi.hoisted(() => ({
    test: true,
    characterId: 'c1',
    skill: 'Milking',
    selected: null,
    owned: [],
    gatheringCalculator: null,
}));

function gameData() {
    return {
        talismanModifierDetailMap: FULL_MODIFIER_DETAILS,
        itemDetailMap: { ...BELT_ITEMS, ...ORB_ITEMS },
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
            '/actions/alchemy/coinify': {
                hrid: '/actions/alchemy/coinify',
                type: '/action_types/alchemy',
                name: 'Coinify',
                sortIndex: 1,
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
        getCharacterTalismans: () => mocks.owned,
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
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
vi.mock('../../utils/bundle-bridge.js', () => ({
    gatheringProfit: () => mocks.gatheringCalculator,
    productionProfit: () => null,
    marketUndercutAlerts: () => null,
    guildMemberSkills: () => null,
}));

const { talismanBonusesOf } = await import('../../utils/talisman-bonuses.js');
const { SkillingTalismanSection, skillingTalismansAvailable } = await import('./skilling-talisman-section.js');

let section;
let container;
const q = (role) => container.querySelector(`[data-role="${role}"]`);
const text = () => container.textContent;
const run = () => section._onRun();

beforeEach(() => {
    mocks.test = true;
    mocks.skill = 'Milking';
    mocks.selected = null;
    mocks.owned = [];
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
    section = new SkillingTalismanSection({ getSkill: () => mocks.skill, getSelectedActions: () => mocks.selected });
    section.mount(container);
});

afterEach(() => {
    section?.detach();
    document.body.innerHTML = '';
});

describe('the Optimizer Talismans section', () => {
    test('live server: not drawn', () => {
        expect(skillingTalismansAvailable()).toBe(true);
        mocks.test = false;
        expect(skillingTalismansAvailable()).toBe(false);
    });

    test('ranks the lines for the chosen action with exact figures, a Practical set and value per orb', async () => {
        expect(q('action').value).toBe('/actions/milking/cow');
        await run();
        const shown = text();
        expect(shown).toContain('Milking Speed');
        expect(shown).toContain('exact');
        expect(shown).toContain('live market prices');
        expect(shown).toContain('Practical: grades capped at G3');
        expect(shown).toContain('per orb (G3)');
        expect(shown).toContain('Exact for the whole set');
        expect(shown).not.toMatch(/undefined|NaN/);
    });

    test('no action selected in the Optimizer: says so', async () => {
        mocks.selected = [];
        section.refreshActions();
        expect(q('estimate').textContent).toContain('No action selected');
        await run();
        expect(text()).toContain('No action selected');
    });

    test('Alchemy: refused with a message', async () => {
        mocks.skill = 'Alchemy';
        section.refreshActions();
        expect(q('estimate').textContent).toContain('not Alchemy or Enhancing');
        await run();
        expect(text()).toContain('Only gathering and production actions are ranked');
    });

    test('an action no line applies to says so', async () => {
        const data = gameData();
        const only = {
            '/talisman_modifiers/alchemy_essence_find':
                FULL_MODIFIER_DETAILS['/talisman_modifiers/alchemy_essence_find'],
        };
        const dm = (await import('../../core/data-manager.js')).default;
        const spy = vi.spyOn(dm, 'getInitClientData').mockReturnValue({ ...data, talismanModifierDetailMap: only });
        await run();
        expect(text()).toContain('No talisman line affects this action.');
        spy.mockRestore();
    });

    test('the profit calculators not loaded: nothing to rank by', async () => {
        mocks.gatheringCalculator = null;
        await run();
        expect(text()).toContain('no figures');
    });

    test('Budget: a set within the orb budget', async () => {
        q('set-mode').value = 'budget';
        q('set-mode').dispatchEvent(new Event('change'));
        q('budget').value = '50';
        await run();
        expect(text()).toContain('Budget: 50 orbs per talisman');
        expect(text()).toMatch(/~[\d.]+ orbs/);
    });

    test('Improve mine from a skilling talisman, with Aim for this', async () => {
        mocks.owned = [
            talismanRow(9, [{ hrid: '/talisman_modifiers/milking_speed', grade: 1 }], {
                talismanTypeHrid: '/talisman_types/skilling',
            }),
        ];
        await run();
        await section._onImprove();
        expect(q('improve').textContent).toContain('Talisman #9');
        expect(q('improve').querySelector('[data-role="aim"]')).not.toBeNull();
    });

    test('Improve mine with only combat talismans: says there are no skilling ones', async () => {
        mocks.owned = [talismanRow(3, [{ hrid: '/talisman_modifiers/armor', grade: 1 }])];
        await run();
        await section._onImprove();
        expect(q('improve').textContent).toContain('You own no skilling talismans');
    });
});

describe('missing prices are worded as elsewhere', () => {
    test('"are left out", not "count as zero"', async () => {
        const real = mocks.gatheringCalculator.calculateGatheringProfit;
        mocks.gatheringCalculator = {
            calculateGatheringProfit: async (...args) => ({ ...(await real(...args)), hasMissingPrices: true }),
        };
        await run();
        expect(text()).toContain('Some prices are missing and are left out: profit figures are floors.');
        expect(text()).not.toContain('count as zero');
    });
});
