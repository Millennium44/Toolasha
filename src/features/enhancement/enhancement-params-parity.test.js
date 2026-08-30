/**
 * Whose bench each price-sweeping surface quotes — all of them, on one fixture.
 *
 * The sweep engine and the pricing rule are already one thing (enhancement-protect-sweep.js,
 * enhancement-pricing.js). This file is the third axis: the parameters fed into them. It began
 * as the before-picture, with each surface's own resolution rule transcribed from its source;
 * it is now the after-picture, and every surface below is one `enhancementParamsFor` call.
 *
 * The value of keeping it in that shape is that the differences are visible as differences. Each
 * surface is one line, they all name the same function, and the only thing that varies between
 * them is the surface key and whether an item is passed — so a divergence has to be declared in
 * `SURFACE_RULES` to exist at all, and shows up here as a cell that differs from its neighbours.
 *
 * The table is written out in full rather than snapshotted, so a behaviour change shows up as a
 * line-by-line diff in review rather than as a blob nobody reads.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Three items. The cape is the one that used to divide the surfaces: it is back-slot, which
// the advisor took as a proxy for "non-tradeable", and tradable, which is what the tooltip
// actually asked. Keeping it here is what proves the two now answer alike.
const SWORD = { hrid: '/items/test_sword', slot: '/equipment_types/main_hand', tradable: true };
const CAPE = { hrid: '/items/chance_cape', slot: '/equipment_types/back', tradable: true };
const QUIVER = { hrid: '/items/test_quiver', slot: '/equipment_types/back', tradable: false };
const ITEMS = [SWORD, CAPE, QUIVER];

/** The character the fixture describes: enhancing 42, Observatory 3, no gear, no teas. */
const DETECTED_LEVEL = 42;
/** The pro bench: enhancing 140 plus ultra tea’s +8 effective levels. */
const PRO_LEVEL = 148;
/** The value a test edits into the manual panel, so an override is distinguishable. */
const EDITED_LEVEL = 175;

const character = vi.hoisted(() => ({
    skills: [{ skillHrid: '/skills/enhancing', level: 42 }],
    observatoryLevel: 3,
    equipment: new Map(),
    drinks: [],
    settings: {},
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => character.settings[key] ?? false,
        getSettingValue: (key, fallback) => (key in character.settings ? character.settings[key] : fallback),
        setSetting: (key, value) => {
            character.settings[key] = value;
        },
        isFeatureEnabled: () => false,
        COLOR_TOOLTIP_WARNING: '#ffb020',
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => character.skills,
        getInitClientData: () => ({
            itemDetailMap: Object.fromEntries(
                ITEMS.map((item) => [item.hrid, item.tradable ? {} : { isTradable: false }])
            ),
        }),
        getHouseRoomLevel: () => character.observatoryLevel,
        getHouseRooms: () => new Map(),
        getCommunityBuffLevel: () => 0,
        getAchievementBuffFlatBoost: () => 0,
        getAchievementBuffRatioBoost: () => 0,
        getActionDrinkSlots: () => character.drinks,
        getEquipment: () => character.equipment,
    },
}));

vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ equipment: character.equipment, drinks: character.drinks }),
}));

vi.mock('../../utils/mobile.js', () => ({ isMobileMode: () => false }));

const { getEnhancingParams, getAutoDetectedParams, resetDetectedSettingsCache } =
    await import('../../utils/enhancement-config.js');
const { enhancementParamsFor, describeEnhancementSource, PRO_RATES_SETTING } =
    await import('./enhancement-params-source.js');

// --- the surfaces, each one call ----------------------------------------------------------

/**
 * Tooltip — src/features/market/tooltip-prices.js, src/features/enhancement/tooltip-enhancement.js.
 * @param {Object} item - One of ITEMS
 * @returns {Object} Resolved params
 */
const tooltipParams = (item) => enhancementParamsFor('tooltip', item.hrid);

/**
 * Upgrade advisor — src/features/combat-sim/upgrade-advisor.js (`enhancementSweepParams`).
 * The slot is no longer part of the question, so it is not passed.
 * @param {Object} item - One of ITEMS
 * @returns {Object} Resolved params
 */
const advisorParams = (item) => enhancementParamsFor('advisor', item.hrid);

/**
 * Equipment savings card — src/features/inventory/equipment-savings-row.js, `enhancementCost`.
 * @param {Object} item - One of ITEMS
 * @returns {Object} Resolved params
 */
const savingsParams = (item) => enhancementParamsFor('savings', item.hrid);

/**
 * Lab panel, whole-game ranking — src/features/enhancement/xph-calculator.js, `_compute`.
 * No item to ask about: one bench for every item in the sweep.
 * @returns {Object} Resolved params
 */
const labRankingParams = () => enhancementParamsFor('lab:ranking');

/**
 * Lab panel, single-item route — src/features/enhancement/xph-calculator.js, `_routeItem`.
 * @param {Object} item - One of ITEMS
 * @returns {Object} Resolved params
 */
const labRouteParams = (item) => enhancementParamsFor('lab:route', item.hrid);

const SURFACES = [
    ['tooltip', tooltipParams],
    ['advisor', advisorParams],
    ['savings', savingsParams],
    ['lab:rank', labRankingParams],
    ['lab:route', labRouteParams],
];

// --- the matrix ---------------------------------------------------------------------------

const SCENARIOS = [
    { name: 'auto-detect on', autoDetect: true, edited: false, pro: false },
    { name: 'auto-detect on, pro', autoDetect: true, edited: false, pro: true },
    { name: 'manual, untouched', autoDetect: false, edited: false, pro: false },
    { name: 'manual, untouched, pro', autoDetect: false, edited: false, pro: true },
    { name: 'manual, edited', autoDetect: false, edited: true, pro: false },
    { name: 'manual, edited, pro', autoDetect: false, edited: true, pro: true },
];

/**
 * Put the character and the settings into one scenario.
 * @param {Object} scenario - One of SCENARIOS
 */
function applyScenario(scenario) {
    character.settings = {
        enhanceSim_autoDetect: scenario.autoDetect,
        [PRO_RATES_SETTING]: scenario.pro,
    };
    if (scenario.edited) {
        character.settings.enhanceSim_enhancingLevel = EDITED_LEVEL;
    }
    resetDetectedSettingsCache();
}

/**
 * What a surface resolved, in the three terms that matter: the bench it landed on (read off the
 * enhancing level, which is distinct per bench in this fixture), the tag the params carry, and
 * the word the chip prints.
 * @param {Object} params - Resolved enhancement parameters
 * @returns {string} `lvl<level> <paramsSource> "<chip label>"`
 */
function describeCell(params) {
    const chip = describeEnhancementSource(params);
    return `lvl${params.enhancingLevel} ${params.paramsSource} "${chip.label}"`;
}

/**
 * Render the whole matrix as a fixed-width table.
 * @returns {string} One line per scenario × item
 */
function renderTable() {
    const lines = [];
    for (const scenario of SCENARIOS) {
        applyScenario(scenario);
        for (const item of ITEMS) {
            const label = `${scenario.name.padEnd(22)} ${(item.hrid.split('/').pop() + (item.tradable ? '' : ' (untradable)')).padEnd(22)}`;
            const cells = SURFACES.map(([name, resolve]) => `${name}=${describeCell(resolve(item))}`);
            lines.push(`${label} | ${cells.join(' | ')}`);
        }
    }
    return lines.join('\n');
}

beforeEach(() => {
    character.settings = {};
    resetDetectedSettingsCache();
});

describe('enhancement parameter sources', () => {
    test('the benches are distinguishable in this fixture', () => {
        applyScenario(SCENARIOS[0]);
        expect(getAutoDetectedParams().enhancingLevel).toBe(DETECTED_LEVEL);
        applyScenario(SCENARIOS[4]);
        expect(getEnhancingParams().enhancingLevel).toBe(EDITED_LEVEL);
        applyScenario(SCENARIOS[1]);
        expect(enhancementParamsFor('tooltip', SWORD.hrid).enhancingLevel).toBe(PRO_LEVEL);
    });

    test('the resolution table', () => {
        expect('\n' + renderTable() + '\n').toBe(`
auto-detect on         test_sword             | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl42 auto "Yours"
auto-detect on         chance_cape            | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl42 auto "Yours"
auto-detect on         test_quiver (untradable) | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl42 auto "Yours"
auto-detect on, pro    test_sword             | tooltip=lvl148 pro "Pro" | advisor=lvl148 pro "Pro" | savings=lvl148 pro "Pro" | lab:rank=lvl148 pro "Pro" | lab:route=lvl148 pro "Pro"
auto-detect on, pro    chance_cape            | tooltip=lvl148 pro "Pro" | advisor=lvl148 pro "Pro" | savings=lvl148 pro "Pro" | lab:rank=lvl148 pro "Pro" | lab:route=lvl148 pro "Pro"
auto-detect on, pro    test_quiver (untradable) | tooltip=lvl148 pro "Pro" | advisor=lvl148 pro "Pro" | savings=lvl148 pro "Pro" | lab:rank=lvl148 pro "Pro" | lab:route=lvl148 pro "Pro"
manual, untouched      test_sword             | tooltip=lvl42 manual "Manual" | advisor=lvl42 manual "Manual" | savings=lvl42 auto "Yours" | lab:rank=lvl42 manual "Manual" | lab:route=lvl42 manual "Manual"
manual, untouched      chance_cape            | tooltip=lvl42 manual "Manual" | advisor=lvl42 manual "Manual" | savings=lvl42 auto "Yours" | lab:rank=lvl42 manual "Manual" | lab:route=lvl42 manual "Manual"
manual, untouched      test_quiver (untradable) | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 manual "Manual" | lab:route=lvl42 auto "Yours"
manual, untouched, pro test_sword             | tooltip=lvl148 pro "Pro" | advisor=lvl148 pro "Pro" | savings=lvl148 pro "Pro" | lab:rank=lvl148 pro "Pro" | lab:route=lvl148 pro "Pro"
manual, untouched, pro chance_cape            | tooltip=lvl148 pro "Pro" | advisor=lvl148 pro "Pro" | savings=lvl148 pro "Pro" | lab:rank=lvl148 pro "Pro" | lab:route=lvl148 pro "Pro"
manual, untouched, pro test_quiver (untradable) | tooltip=lvl148 pro "Pro" | advisor=lvl148 pro "Pro" | savings=lvl148 pro "Pro" | lab:rank=lvl148 pro "Pro" | lab:route=lvl148 pro "Pro"
manual, edited         test_sword             | tooltip=lvl175 manual "Manual" | advisor=lvl175 manual "Manual" | savings=lvl42 auto "Yours" | lab:rank=lvl175 manual "Manual" | lab:route=lvl175 manual "Manual"
manual, edited         chance_cape            | tooltip=lvl175 manual "Manual" | advisor=lvl175 manual "Manual" | savings=lvl42 auto "Yours" | lab:rank=lvl175 manual "Manual" | lab:route=lvl175 manual "Manual"
manual, edited         test_quiver (untradable) | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl175 manual "Manual" | lab:route=lvl42 auto "Yours"
manual, edited, pro    test_sword             | tooltip=lvl148 pro "Pro" | advisor=lvl148 pro "Pro" | savings=lvl148 pro "Pro" | lab:rank=lvl148 pro "Pro" | lab:route=lvl148 pro "Pro"
manual, edited, pro    chance_cape            | tooltip=lvl148 pro "Pro" | advisor=lvl148 pro "Pro" | savings=lvl148 pro "Pro" | lab:rank=lvl148 pro "Pro" | lab:route=lvl148 pro "Pro"
manual, edited, pro    test_quiver (untradable) | tooltip=lvl148 pro "Pro" | advisor=lvl148 pro "Pro" | savings=lvl148 pro "Pro" | lab:rank=lvl148 pro "Pro" | lab:route=lvl148 pro "Pro"
`);
    });
});

describe('what the table shows', () => {
    test('the pro toggle reaches every surface', () => {
        applyScenario({ autoDetect: true, edited: false, pro: true });

        for (const [, resolve] of SURFACES) {
            expect(resolve(SWORD).paramsSource).toBe('pro');
            expect(resolve(QUIVER).paramsSource).toBe('pro');
        }
    });

    test('"Yours" means detected, and nothing else does', () => {
        applyScenario({ autoDetect: false, edited: false, pro: false });

        // The savings card really did detect, and says Yours. The lab ranking read the manual
        // panel — untouched, so numerically identical — and says Manual. Same numbers, and the
        // chips no longer claim the same thing about where they came from.
        expect(describeEnhancementSource(savingsParams(SWORD)).label).toBe('Yours');
        expect(describeEnhancementSource(labRankingParams()).label).toBe('Manual');
        expect(labRankingParams().enhancingLevel).toBe(savingsParams(SWORD).enhancingLevel);
    });

    test('a manual bench that matches what was detected still prints "Manual"', () => {
        character.settings = {
            enhanceSim_autoDetect: false,
            // Told the panel exactly what the character has. It is the bench the player typed
            // in, and it says so — matching detection by coincidence does not make it detected.
            enhanceSim_enhancingLevel: DETECTED_LEVEL,
        };
        resetDetectedSettingsCache();

        const params = getEnhancingParams();
        expect(params.enhancingLevel).toBe(DETECTED_LEVEL);
        expect(describeEnhancementSource(params).label).toBe('Manual');
    });

    test('the advisor and the tooltip cost the same cape at the same bench', () => {
        applyScenario({ autoDetect: false, edited: true, pro: false });

        // The advisor used to ask the slot and answer DETECTED_LEVEL here, while the tooltip
        // beside it answered EDITED_LEVEL for the same piece.
        expect(advisorParams(CAPE).enhancingLevel).toBe(EDITED_LEVEL);
        expect(tooltipParams(CAPE).enhancingLevel).toBe(EDITED_LEVEL);

        // A quiver cannot be bought finished at any price, so both still quote the character.
        expect(advisorParams(QUIVER).enhancingLevel).toBe(DETECTED_LEVEL);
        expect(tooltipParams(QUIVER).enhancingLevel).toBe(DETECTED_LEVEL);
    });

    test('the savings card still ignores the manual panel, and still obeys the pro toggle', () => {
        for (const scenario of SCENARIOS) {
            applyScenario(scenario);
            expect(savingsParams(SWORD).enhancingLevel).toBe(scenario.pro ? PRO_LEVEL : DETECTED_LEVEL);
        }
    });

    test('an unknown surface is reported and falls back to the item rule', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        applyScenario({ autoDetect: false, edited: true, pro: false });

        expect(enhancementParamsFor('not-a-surface', SWORD.hrid).enhancingLevel).toBe(EDITED_LEVEL);
        expect(enhancementParamsFor('not-a-surface', QUIVER.hrid).enhancingLevel).toBe(DETECTED_LEVEL);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});
