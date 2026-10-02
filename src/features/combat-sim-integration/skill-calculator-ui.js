/**
 * Skill Calculator UI
 * UI generation and management for combat sim skill calculator
 */

import { calculateTimeToLevel, calculateLevelsAfterDays, getLevelFromExp } from './skill-calculator-logic.js';
import { parseGameNumber } from '../../utils/number-parser.js';

/**
 * Create the skill calculator UI
 * @param {HTMLElement} container - Container element to append to
 * @param {Array} characterSkills - Character skills from dataManager
 * @param {Object} expRates - Exp/hour rates for each skill
 * @param {Object} levelExpTable - Level experience table
 * @param {Object|null} [previous] - `getState()` of the calculator being replaced, so a rebuild
 *   after a re-run keeps the targets and the skill the user was looking at
 * @returns {Object} UI elements for later updates
 */
export function createCalculatorUI(container, characterSkills, expRates, levelExpTable, previous = null) {
    const wrapper = document.createElement('div');
    wrapper.id = 'mwi-skill-calculator';
    wrapper.style.cssText = `
        background: rgba(0, 0, 0, 0.4);
        color: #ffffff;
        padding: 12px;
        border: 1px solid #555;
        border-radius: 4px;
        margin-top: 10px;
        font-family: inherit;
    `;

    const skillOrder = ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'];
    const skillData = {};

    // Build skill data map
    for (const skillName of skillOrder) {
        const skill = characterSkills.find((s) => s.skillHrid.includes(skillName));
        if (skill) {
            // If skill has experience, calculate level from exp
            // If skill only has level (from simulator extraction), use that directly
            const currentLevel = skill.experience ? getLevelFromExp(skill.experience, levelExpTable) : skill.level;
            const currentExp = skill.experience || 0;

            skillData[skillName] = {
                displayName: capitalize(skillName),
                currentLevel,
                currentExp,
            };
        }
    }

    // Create skill input rows
    const skillInputs = {};
    for (const skillName of skillOrder) {
        if (!skillData[skillName]) continue;

        const row = document.createElement('div');
        row.style.cssText = 'display: flex; justify-content: flex-end; margin-bottom: 4px; align-items: center;';

        const label = document.createElement('span');
        label.textContent = `${skillData[skillName].displayName} to level `;
        label.style.marginRight = '6px';

        const input = document.createElement('input');
        input.type = 'number';
        input.value = skillData[skillName].currentLevel + 1;
        input.min = skillData[skillName].currentLevel + 1;
        input.max = 200;
        input.style.cssText =
            'width: 60px; padding: 4px; background: #2a2a2a; color: white; border: 1px solid #555; border-radius: 3px;';
        input.dataset.skill = skillName;

        const restored = Number(previous?.targets?.[skillName]);
        if (Number.isFinite(restored) && restored > 0) input.value = restored;

        skillInputs[skillName] = input;

        row.appendChild(label);
        row.appendChild(input);
        wrapper.appendChild(row);
    }

    // Create days input row
    const daysRow = document.createElement('div');
    daysRow.style.cssText =
        'display: flex; justify-content: flex-end; margin-bottom: 8px; margin-top: 8px; align-items: center;';

    const daysInput = document.createElement('input');
    daysInput.type = 'number';
    daysInput.id = 'mwi-days-input';
    const restoredDays = Number(previous?.days);
    daysInput.value = Number.isFinite(restoredDays) && restoredDays >= 0 && previous?.days !== '' ? restoredDays : 1;
    daysInput.min = 0;
    daysInput.max = 200;
    daysInput.style.cssText = 'width: 60px; padding: 2px 4px; margin-right: 6px;';

    const daysLabel = document.createElement('span');
    daysLabel.textContent = 'days after';

    daysRow.appendChild(daysInput);
    daysRow.appendChild(daysLabel);
    wrapper.appendChild(daysRow);

    // Create results display divs
    const resultsHeader = document.createElement('div');
    resultsHeader.id = 'mwi-calc-results-header';
    resultsHeader.style.cssText = 'margin-top: 8px; font-weight: bold; border-top: 1px solid #ccc; padding-top: 8px;';
    wrapper.appendChild(resultsHeader);

    const resultsContent = document.createElement('div');
    resultsContent.id = 'mwi-calc-results-content';
    resultsContent.style.cssText = 'margin-top: 4px;';
    wrapper.appendChild(resultsContent);

    container.appendChild(wrapper);

    // The mode follows the input the user last touched, not document.activeElement: clicking
    // into a number field fires no input event, and a spinner click or a programmatic change
    // may not move focus at all, so a focus-based check showed the days projection until a key
    // was typed. A skill input selects its skill; the days input selects the projection.
    let activeSkill = previous?.activeSkill && skillInputs[previous.activeSkill] ? previous.activeSkill : null;

    const select = (skillName) => {
        activeSkill = skillName;
        refresh();
    };

    const refresh = () => {
        updateCalculatorResults(
            skillInputs,
            daysInput,
            skillData,
            expRates,
            levelExpTable,
            resultsHeader,
            resultsContent,
            characterSkills,
            activeSkill
        );
    };

    for (const [skillName, input] of Object.entries(skillInputs)) {
        for (const eventName of ['input', 'change', 'focus']) {
            input.addEventListener(eventName, () => select(skillName));
        }
    }

    for (const eventName of ['input', 'change', 'focus']) {
        daysInput.addEventListener(eventName, () => select(null));
    }

    refresh();

    return {
        wrapper,
        skillInputs,
        daysInput,
        resultsHeader,
        resultsContent,
        getState: () => ({
            activeSkill,
            days: daysInput.value,
            targets: Object.fromEntries(Object.entries(skillInputs).map(([name, input]) => [name, input.value])),
        }),
    };
}

/**
 * Update calculator results based on current inputs
 * @param {Object} skillInputs - Skill input elements
 * @param {HTMLElement} daysInput - Days input element
 * @param {Object} skillData - Skill data (levels, exp)
 * @param {Object} expRates - Exp/hour rates
 * @param {Object} levelExpTable - Level experience table
 * @param {HTMLElement} resultsHeader - Results header element
 * @param {HTMLElement} resultsContent - Results content element
 * @param {Array} characterSkills - Character skills array
 * @param {string|null} activeSkill - Skill whose target input was touched last, or null for the days projection
 */
function updateCalculatorResults(
    skillInputs,
    daysInput,
    skillData,
    expRates,
    levelExpTable,
    resultsHeader,
    resultsContent,
    characterSkills,
    activeSkill
) {
    const activeInput = activeSkill ? skillInputs[activeSkill] : null;

    if (activeSkill && activeInput) {
        // Calculate time to reach specific level
        const targetLevel = Number(activeInput.value);
        const currentLevel = skillData[activeSkill].currentLevel;
        const currentExp = skillData[activeSkill].currentExp;
        const expRate = expRates[activeSkill] || 0;

        resultsHeader.textContent = `${skillData[activeSkill].displayName} to level ${targetLevel} takes:`;

        if (expRate === 0) {
            resultsContent.innerHTML = '<div>No experience gain (not trained in simulation)</div>';
        } else if (targetLevel <= currentLevel) {
            resultsContent.innerHTML = '<div>Already achieved</div>';
        } else {
            const timeResult = calculateTimeToLevel(currentExp, targetLevel, expRate, levelExpTable);
            if (timeResult) {
                resultsContent.innerHTML = `<div>[${timeResult.readable}]</div>`;
            } else {
                resultsContent.innerHTML = '<div>Invalid target level</div>';
            }
        }
    } else {
        // Calculate levels after X days
        const days = Number(daysInput.value);
        resultsHeader.textContent = `After ${days} days:`;

        const projected = calculateLevelsAfterDays(characterSkills, expRates, days, levelExpTable);

        if (projected) {
            let html = '';
            const skillOrder = ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'];

            for (const skillName of skillOrder) {
                if (projected[skillName]) {
                    html += `<div>${capitalize(skillName)} level ${projected[skillName].level} ${projected[skillName].percentage}%</div>`;
                }
            }

            html += `<div style="margin-top: 4px; font-weight: bold;">Combat level: ${projected.combatLevel.toFixed(1)}</div>`;
            resultsContent.innerHTML = html;
        } else {
            resultsContent.innerHTML = '<div>Unable to calculate projection</div>';
        }
    }
}

/**
 * Capitalize first letter of string
 * @param {string} str - String to capitalize
 * @returns {string} Capitalized string
 */
function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Parse an exp/hour figure out of the sim results panel.
 *
 * The panel formats these with thousand separators once the number gets
 * large enough (`12,345`), same as the rest of the game's DOM — `Number()`
 * on that text is NaN, which `expRates[skillName] || 0` then silently turns
 * into "not trained in simulation" for a skill that is actually gaining exp.
 * @param {string} text - Cell text from the results row
 * @returns {number} The value, or NaN when it is not one
 */
function parseExpValue(text) {
    return parseGameNumber(text);
}

/**
 * Extract exp/hour rates from combat sim DOM
 * @returns {Object|null} Exp rates object or null if not found
 */
export function extractExpRates() {
    const expDiv = document.querySelector('#simulationResultExperienceGain');
    if (!expDiv) {
        return null;
    }

    const rates = {};
    const rows = expDiv.querySelectorAll('.row');

    for (const row of rows) {
        if (row.children.length >= 2) {
            const skillText = row.children[0]?.textContent?.toLowerCase() || '';
            const expText = row.children[1]?.textContent || '';
            const expValue = parseExpValue(expText);

            // Match skill names
            if (skillText.includes('stamina')) {
                rates.stamina = expValue;
            } else if (skillText.includes('intelligence')) {
                rates.intelligence = expValue;
            } else if (skillText.includes('attack')) {
                rates.attack = expValue;
            } else if (skillText.includes('melee')) {
                rates.melee = expValue;
            } else if (skillText.includes('defense')) {
                rates.defense = expValue;
            } else if (skillText.includes('ranged')) {
                rates.ranged = expValue;
            } else if (skillText.includes('magic')) {
                rates.magic = expValue;
            }
        }
    }

    return rates;
}
