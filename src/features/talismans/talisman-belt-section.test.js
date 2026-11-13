/** @vitest-environment happy-dom */
/**
 * The belt advisor as the Optimizer's Talismans section draws it: every way a run can end, the controls' hovers, the
 * stale note, and the guards shared with the ranking.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../../__fixtures__/talisman-full-modifiers.js';
import { TALISMAN_INFO, ORB_ITEMS } from '../../__fixtures__/talisman-reroll.js';

const mocks = vi.hoisted(() => ({
    test: true,
    characterId: 'c1',
    skill: 'Milking',
    belt: { hrid: '/items/medium_talisman_belt', level: 4 },
    /** Slotted talismans of the gear (null: none) */
    talismans: null,
    prices: {},
    gatheringCalculator: null,
    evaluations: 0,
    onEvaluate: null,
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
    const { BELT_LOCATION, computeTalismanBonuses, attachTalismanBonuses } =
        await import('../../utils/talisman-bonuses.js');
    return {
        resolveActionTalismans: () => [],
        describeActionContextSource: (type) => ({
            key: `skill:${type}:Milking ★`,
            label: 'Milking ★ (the loadout this skill equips)',
        }),
        resolveActionContext: () => {
            const belt = {
                itemHrid: mocks.belt.hrid,
                enhancementLevel: mocks.belt.level,
                itemLocationHrid: BELT_LOCATION,
            };
            const equipment = new Map(mocks.belt.hrid ? [[BELT_LOCATION, belt]] : []);
            if (mocks.belt.hrid && mocks.talismans) {
                attachTalismanBonuses(
                    equipment,
                    computeTalismanBonuses({
                        talismans: mocks.talismans,
                        belt,
                        itemDetailMap: { ...BELT_ITEMS },
                        modifierDetailMap: FULL_MODIFIER_DETAILS,
                        enhancementTable: TALISMAN_ENHANCEMENT_TABLE,
                    })
                );
            }
            return { equipment, drinks: [] };
        },
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

const { BELT_LOCATION, attachTalismanBonuses, computeTalismanBonuses, talismanBonusesOf } =
    await import('../../utils/talisman-bonuses.js');
const { SkillingTalismanSection } = await import('./skilling-talisman-section.js');

const MILKING = (grade) => ({ hrid: '/talisman_modifiers/milking_speed', grade });
let section;
let container;
const q = (role) => container.querySelector(`[data-role="${role}"]`);
const results = () => q('belt-results').textContent;
const rowsText = () => [...q('belt-results').querySelectorAll('tbody tr, tr')].map((r) => r.textContent);
const belts = () => section._onBelts();

beforeEach(() => {
    mocks.test = true;
    mocks.characterId = 'c1';
    mocks.skill = 'Milking';
    mocks.belt = { hrid: '/items/medium_talisman_belt', level: 4 };
    mocks.talismans = [
        { slotIndex: 1, modifiers: [MILKING(6)] },
        { slotIndex: 2, modifiers: [MILKING(4)] },
    ];
    mocks.prices = {};
    mocks.evaluations = 0;
    mocks.onEvaluate = null;
    mocks.gatheringCalculator = {
        calculateGatheringProfit: async (_hrid, { actionContext }) => {
            mocks.evaluations++;
            await mocks.onEvaluate?.();
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
    section = new SkillingTalismanSection({ getSkill: () => mocks.skill, getSelectedActions: () => null });
    section.mount(container);
});

afterEach(() => {
    section?.detach();
    document.body.innerHTML = '';
});

describe('the belt advisor in the Optimizer', () => {
    test('every control and column has a hover', async () => {
        for (const role of ['belt-cost', 'belt-run']) expect(q(role).title).not.toBe('');
        for (const option of q('belt-cost').options) expect(option.title).not.toBe('');
        expect(q('belt-controls').querySelector('span').title).not.toBe('');
        mocks.prices['/items/medium_talisman_belt@5@buy'] = 5e8;
        await belts();
        const headers = [...q('belt-results').querySelectorAll('th')];
        expect(headers.map((h) => h.textContent)).toEqual(['#', 'Belt', 'Profit/hr', 'Cost', 'per 100m', 'Note']);
        for (const th of headers) expect(th.title).not.toBe('');
    });

    test('ran: the pre-run line counts the candidates, the table shows gain, cost and gain per cost, priced rows first', async () => {
        expect(q('belt-estimate').textContent).toBe('No sims: exact figures for 8 candidate belts.');
        mocks.prices['/items/medium_talisman_belt@5@buy'] = 2e8;
        mocks.prices['/items/large_talisman_belt@0@buy'] = 9e8;
        await belts();
        expect(section._running).toBe(false);
        const shown = results();
        expect(shown).toContain('Belts against Medium Talisman Belt +4');
        expect(shown).toContain('Medium Talisman Belt +5');
        expect(shown).toContain('Large Talisman Belt +0');
        expect(shown).toContain('+1 empty slot, not valued');
        expect(shown).toContain('200.0M');
        expect(shown).not.toMatch(/undefined|NaN|Infinity/);
        const rows = rowsText();
        // Header row, then the two priced rows, then the unpriced
        // Best gain per cost first: the cheap small step is not the best buy here
        expect(rows[1]).toContain('Large Talisman Belt +0');
        expect(rows[2]).toContain('Medium Talisman Belt +5');
        for (const row of rows.slice(3)) expect(row).toContain('No price');
        // A row with a price shows a gain per 100m; an unpriced one does not
        expect(rows[1]).toMatch(/per|\+\d/);
        expect(rows[3]).not.toMatch(/\+[\d.]+K?\s*$/);
    });

    test('every belt unpriced: the gains show, with one line saying none can be set against a cost', async () => {
        await belts();
        expect(results()).toContain('No belt has a price on the "Buy" basis');
        expect(results()).toContain('No price');
        expect(results()).not.toContain('free');
    });

    test('a priced-by-estimate belt (value map) is not a price: it stays unpriced', async () => {
        const marketData = await import('../../utils/market-data.js');
        const spy = vi
            .spyOn(marketData, 'getItemPriceInfo')
            .mockReturnValue({ price: 1000, source: 'value', estimated: true });
        await belts();
        expect(results()).toContain('No price');
        spy.mockRestore();
    });

    test('changing the cost basis redraws the table without running again', async () => {
        mocks.prices['/items/medium_talisman_belt@5@buy'] = 2e8;
        mocks.prices['/items/medium_talisman_belt@4@sell'] = 1.5e8;
        await belts();
        const evaluations = mocks.evaluations;
        q('belt-cost').value = 'net';
        q('belt-cost').dispatchEvent(new Event('change'));
        expect(mocks.evaluations).toBe(evaluations);
        expect(results()).toContain('Cost basis: Buy, sell mine');
        // 200m less 144m (150m after the 4% market tax)
        expect(rowsText()[1]).toContain('56.0M');
    });

    test('the enhancement basis is unpriced here (no recipe in the fixture), and says why on hover', async () => {
        await belts();
        q('belt-cost').value = 'enhance';
        q('belt-cost').dispatchEvent(new Event('change'));
        const cell = q('belt-results').querySelector('tbody td span[title], td span[title]');
        expect(results()).toContain('No price');
        expect(cell).not.toBeNull();
    });

    test('no belt: says so and runs nothing', async () => {
        mocks.belt = { hrid: null, level: 0 };
        await belts();
        expect(results()).toContain('has no Talisman Belt');
        expect(mocks.evaluations).toBe(0);
    });

    test('no slotted talisman: says so and runs nothing', async () => {
        mocks.talismans = null;
        await belts();
        expect(results()).toContain('No skilling talisman is slotted');
        expect(mocks.evaluations).toBe(0);
    });

    test('empty: the largest belt at +20 has nothing to compare', async () => {
        mocks.belt = { hrid: '/items/large_talisman_belt', level: 20 };
        section._updateBeltEstimate();
        expect(q('belt-estimate').textContent).toBe('No larger belt or higher level to check.');
        await belts();
        expect(results()).toContain('Nothing to compare');
        expect(mocks.evaluations).toBe(1);
    });

    test('a current belt that is the largest at a high level is offered only the levels left', async () => {
        mocks.belt = { hrid: '/items/large_talisman_belt', level: 18 };
        mocks.prices['/items/large_talisman_belt@19@buy'] = 1e9;
        await belts();
        const rows = rowsText();
        expect(rows).toHaveLength(3);
        expect(rows[1]).toContain('Large Talisman Belt +19');
        expect(rows[2]).toContain('Large Talisman Belt +20');
    });

    test('Stop ends the run, keeps the belts already valued and says it stopped', async () => {
        let n = 0;
        mocks.onEvaluate = async () => {
            if (++n === 4) section.stop();
        };
        await belts();
        expect(results()).toContain('Stopped early');
        expect(rowsText().length).toBeGreaterThan(1);
        expect(rowsText().length).toBeLessThan(9);
        expect(section._running).toBe(false);
    });

    test('while it runs, Rank is refused and the buttons swap for Stop', async () => {
        let seenRunning = null;
        let rankResult = null;
        mocks.onEvaluate = async () => {
            if (seenRunning === null) {
                seenRunning = {
                    belt: q('belt-run').style.display,
                    stop: q('stop').style.display,
                };
                rankResult = section._onRun();
            }
        };
        await belts();
        await rankResult;
        expect(seenRunning).toEqual({ belt: 'none', stop: '' });
        // The refused Rank did not start a second run or wipe the belt table
        expect(results()).toContain('Belts against');
    });

    test('a result is marked out of date when the gear changes, and the note goes with a new check', async () => {
        await belts();
        expect(q('belt-stale').style.display).toBe('none');
        mocks.belt = { hrid: '/items/medium_talisman_belt', level: 6 };
        section._refreshStale();
        expect(q('belt-stale').style.display).toBe('block');
        expect(q('belt-stale').textContent).toContain('gear');
        await belts();
        expect(q('belt-stale').style.display).toBe('none');
    });

    test('a changed Rank by marks the result out of date', async () => {
        await belts();
        q('metric').value = 'xp';
        q('metric').dispatchEvent(new Event('change'));
        expect(q('belt-stale').textContent).toContain('Rank by');
    });

    test('a character switch mid-run drops the result', async () => {
        mocks.onEvaluate = async () => {
            mocks.characterId = 'c2';
        };
        await belts();
        expect(q('belt-results').innerHTML).toBe('');
        expect(section._belt).toBeNull();
        expect(section._running).toBe(false);
    });

    test('a failing evaluation ends the run with a visible message, not a hang', async () => {
        mocks.gatheringCalculator = {
            calculateGatheringProfit: async () => {
                throw new Error('boom');
            },
        };
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await belts();
        expect(results()).toContain('Failed: boom');
        expect(section._running).toBe(false);
        spy.mockRestore();
    });

    test('on the live server: refused, and nothing evaluated', async () => {
        mocks.test = false;
        await belts();
        expect(results()).toContain('Talismans exist on the test server only.');
        expect(mocks.evaluations).toBe(0);
    });

    test('detach clears the result and the nodes', async () => {
        await belts();
        section.detach();
        expect(section._belt).toBeNull();
        expect(container.querySelector('[data-role="belt-results"]')).toBeNull();
        // A new mount starts clean
        section.mount(container);
        expect(q('belt-results').innerHTML).toBe('');
    });

    test('a new check starts from nothing: no row of the last run survives', async () => {
        mocks.prices['/items/medium_talisman_belt@5@buy'] = 2e8;
        await belts();
        mocks.belt = { hrid: '/items/large_talisman_belt', level: 20 };
        await belts();
        expect(results()).not.toContain('Medium Talisman Belt +5');
    });
});

describe('the belt advisor follows the gear the Optimizer shows', () => {
    let gear;
    const loadoutGear = (key, beltHrid, level) => {
        const equipment = new Map();
        if (beltHrid) {
            const belt = { itemHrid: beltHrid, enhancementLevel: level, itemLocationHrid: BELT_LOCATION };
            equipment.set(BELT_LOCATION, belt);
            attachTalismanBonuses(
                equipment,
                computeTalismanBonuses({
                    talismans: [{ slotIndex: 1, modifiers: [MILKING(6)] }],
                    belt,
                    itemDetailMap: { ...BELT_ITEMS },
                    modifierDetailMap: FULL_MODIFIER_DETAILS,
                    enhancementTable: TALISMAN_ENHANCEMENT_TABLE,
                })
            );
        }
        return { key, label: 'Woodcutting ★ loadout', equipment, drinks: [] };
    };
    const hostWith = () => {
        section.detach();
        container.innerHTML = '';
        section = new SkillingTalismanSection({
            getSkill: () => mocks.skill,
            getSelectedActions: () => null,
            getGearContext: () => gear,
        });
        section.mount(container);
    };

    test('a picked loadout with a belt: belt rows on that loadout, the header names it', async () => {
        gear = loadoutGear('a', '/items/medium_talisman_belt', 2);
        hostWith();
        expect(q('belt-estimate').textContent).toContain('candidate belts');
        await belts();
        expect(results()).toContain('Cow · Woodcutting ★ loadout');
        expect(results()).toContain('Belts against Medium Talisman Belt +2');
        expect(results()).not.toContain('Belts against Medium Talisman Belt +4');
        expect(rowsText().some((r) => r.includes('Medium Talisman Belt +3'))).toBe(true);
    });

    test('a dropdown change marks the belt result out of date', async () => {
        gear = loadoutGear('a', '/items/medium_talisman_belt', 2);
        hostWith();
        await belts();
        expect(q('belt-stale').style.display).toBe('none');
        gear = loadoutGear('b', '/items/medium_talisman_belt', 2);
        section.gearChanged();
        expect(q('belt-stale').style.display).toBe('block');
        expect(q('belt-stale').textContent).toContain('gear');
    });

    test('a picked loadout without a belt is refused by name, not valued on the live belt', async () => {
        gear = loadoutGear('c', null, 0);
        hostWith();
        expect(q('belt-estimate').textContent).toContain('Woodcutting ★ loadout has no Talisman Belt');
        await belts();
        expect(results()).toContain('Woodcutting ★ loadout has no Talisman Belt');
        expect(mocks.evaluations).toBe(0);
    });
});
