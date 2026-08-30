/**
 * Whose bench each price-sweeping surface quotes — all of them, on one fixture.
 *
 * The sweep engine and the pricing rule are already one thing (enhancement-protect-sweep.js,
 * enhancement-pricing.js). The remaining axis is the parameters fed into them: four surfaces
 * each pick their own, by their own rule, and then print a chip that claims to say which.
 *
 * Each surface lives behind a different module-mock graph — the advisor pulls in the combat
 * simulator, the savings card reaches its config through the bundle bridge — and vitest's mocks
 * are per-file. So the *resolution rule* of each surface is transcribed here from its source
 * (marked with file and line) and driven by the real `enhancement-config.js` and the real
 * `enhancement-params-source.js`. A transcription that drifts from its original is caught by
 * that surface's own suite, not by this file; what this file is for is putting all four answers
 * in one table so the disagreements are visible at once.
 *
 * The table is written out in full rather than snapshotted, so a behaviour change shows up as a
 * line-by-line diff in review rather than as a blob nobody reads.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Three items, chosen so the two rules currently in play come apart:
//   - the advisor asks "is this the back slot?"
//   - the tooltip asks "is this item untradable?"
// A cape answers yes to the first and no to the second, which is where they disagree.
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
const { getTooltipEnhancementParams, describeEnhancementSource, PRO_RATES_SETTING } =
    await import('./enhancement-params-source.js');

// --- the four surfaces, transcribed ------------------------------------------------------

/**
 * Tooltip — src/features/enhancement/enhancement-params-source.js:67.
 * The real function; this surface already owns the toggle.
 * @param {Object} item - One of ITEMS
 * @returns {Object} Resolved params
 */
const tooltipParams = (item) => getTooltipEnhancementParams(item.hrid);

/**
 * Upgrade advisor — src/features/combat-sim/upgrade-advisor.js:441 (`enhancementSweepParams`).
 * `return slot === '/equipment_types/back' ? getAutoDetectedParams() : getEnhancingParams();`
 * @param {Object} item - One of ITEMS
 * @returns {Object} Resolved params
 */
const advisorParams = (item) =>
    item.slot === '/equipment_types/back' ? getAutoDetectedParams() : getEnhancingParams();

/**
 * Equipment savings card — src/features/inventory/equipment-savings-row.js:1140.
 * `const params = enhancementConfig()?.getAutoDetectedParams?.();` — no condition at all.
 * @returns {Object} Resolved params
 */
const savingsParams = () => getAutoDetectedParams();

/**
 * Lab panel, whole-game ranking — src/features/enhancement/xph-calculator.js:460.
 * `const params = getEnhancingParams();` — one set of params for every item in the sweep.
 * @returns {Object} Resolved params
 */
const labRankingParams = () => getEnhancingParams();

/**
 * Lab panel, single-item route — src/features/enhancement/xph-calculator.js:388.
 * `calculateEnhancementPath(hrid, target, getTooltipEnhancementParams(hrid))`.
 * @param {Object} item - One of ITEMS
 * @returns {Object} Resolved params
 */
const labRouteParams = (item) => getTooltipEnhancementParams(item.hrid);

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

describe('enhancement parameter sources, before unification', () => {
    test('the benches are distinguishable in this fixture', () => {
        applyScenario(SCENARIOS[0]);
        expect(getAutoDetectedParams().enhancingLevel).toBe(DETECTED_LEVEL);
        applyScenario(SCENARIOS[4]);
        expect(getEnhancingParams().enhancingLevel).toBe(EDITED_LEVEL);
        applyScenario(SCENARIOS[1]);
        expect(getTooltipEnhancementParams(SWORD.hrid).enhancingLevel).toBe(PRO_LEVEL);
    });

    test('the resolution table', () => {
        expect('\n' + renderTable() + '\n').toBe(`
auto-detect on         test_sword             | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl42 auto "Yours"
auto-detect on         chance_cape            | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl42 auto "Yours"
auto-detect on         test_quiver (untradable) | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl42 auto "Yours"
auto-detect on, pro    test_sword             | tooltip=lvl148 pro "Pro" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl148 pro "Pro"
auto-detect on, pro    chance_cape            | tooltip=lvl148 pro "Pro" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl148 pro "Pro"
auto-detect on, pro    test_quiver (untradable) | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl42 auto "Yours"
manual, untouched      test_sword             | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl42 auto "Yours"
manual, untouched      chance_cape            | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl42 auto "Yours"
manual, untouched      test_quiver (untradable) | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl42 auto "Yours"
manual, untouched, pro test_sword             | tooltip=lvl148 pro "Pro" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl148 pro "Pro"
manual, untouched, pro chance_cape            | tooltip=lvl148 pro "Pro" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl148 pro "Pro"
manual, untouched, pro test_quiver (untradable) | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl42 auto "Yours" | lab:route=lvl42 auto "Yours"
manual, edited         test_sword             | tooltip=lvl175 manual "Manual" | advisor=lvl175 manual "Manual" | savings=lvl42 auto "Yours" | lab:rank=lvl175 manual "Manual" | lab:route=lvl175 manual "Manual"
manual, edited         chance_cape            | tooltip=lvl175 manual "Manual" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl175 manual "Manual" | lab:route=lvl175 manual "Manual"
manual, edited         test_quiver (untradable) | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl175 manual "Manual" | lab:route=lvl42 auto "Yours"
manual, edited, pro    test_sword             | tooltip=lvl148 pro "Pro" | advisor=lvl175 manual "Manual" | savings=lvl42 auto "Yours" | lab:rank=lvl175 manual "Manual" | lab:route=lvl148 pro "Pro"
manual, edited, pro    chance_cape            | tooltip=lvl148 pro "Pro" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl175 manual "Manual" | lab:route=lvl148 pro "Pro"
manual, edited, pro    test_quiver (untradable) | tooltip=lvl42 auto "Yours" | advisor=lvl42 auto "Yours" | savings=lvl42 auto "Yours" | lab:rank=lvl175 manual "Manual" | lab:route=lvl42 auto "Yours"
`);
    });
});

describe('what the table shows', () => {
    test('the pro toggle reaches the tooltip and nothing else', () => {
        applyScenario({ autoDetect: true, edited: false, pro: true });

        expect(tooltipParams(SWORD).paramsSource).toBe('pro');
        expect(advisorParams(SWORD).paramsSource).not.toBe('pro');
        expect(savingsParams().paramsSource).not.toBe('pro');
        expect(labRankingParams().paramsSource).not.toBe('pro');
    });

    test('"Yours" is printed by two surfaces meaning two different benches', () => {
        applyScenario({ autoDetect: false, edited: false, pro: false });

        // The savings card really did detect. The lab ranking read the manual panel, which
        // happens to be untouched — and both chips say the same word.
        expect(describeEnhancementSource(savingsParams()).label).toBe('Yours');
        expect(describeEnhancementSource(labRankingParams()).label).toBe('Yours');
        expect(labRankingParams().paramsSource).toBe('auto');
    });

    test('a manual bench that matches what was detected still prints "Yours"', () => {
        character.settings = {
            enhanceSim_autoDetect: false,
            // Told the panel exactly what the character has. It is still a bench the player
            // typed in, but nothing downstream can tell.
            enhanceSim_enhancingLevel: DETECTED_LEVEL,
        };
        resetDetectedSettingsCache();

        const params = getEnhancingParams();
        expect(params.enhancingLevel).toBe(DETECTED_LEVEL);
        expect(describeEnhancementSource(params).label).toBe('Yours');
    });

    test('the advisor costs a cape at the manual bench and a quiver at the detected one', () => {
        applyScenario({ autoDetect: false, edited: true, pro: false });

        // Its rule is the slot, not the item: a cape is back-slot and tradable, so the
        // "back items are non-tradeable" premise the rule was written on does not hold for it.
        expect(advisorParams(CAPE).enhancingLevel).toBe(DETECTED_LEVEL);
        expect(tooltipParams(CAPE).enhancingLevel).toBe(EDITED_LEVEL);
    });

    test('the savings card ignores every setting there is', () => {
        for (const scenario of SCENARIOS) {
            applyScenario(scenario);
            expect(savingsParams().enhancingLevel).toBe(DETECTED_LEVEL);
        }
    });
});
