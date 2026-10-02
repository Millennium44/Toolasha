/**
 * @vitest-environment happy-dom
 */

import { describe, test, expect, afterEach } from 'vitest';
import { createCalculatorUI, extractExpRates } from './skill-calculator-ui.js';

/**
 * Builds the `#simulationResultExperienceGain` structure the combat sim
 * renders its exp/hour rows into: one `.row` per skill, first child the
 * skill name, second child the formatted number.
 * @param {Array<[string, string]>} rows - [skillLabel, expText] pairs
 */
function mountExpDiv(rows) {
    const expDiv = document.createElement('div');
    expDiv.id = 'simulationResultExperienceGain';
    for (const [label, text] of rows) {
        const row = document.createElement('div');
        row.className = 'row';
        const nameCell = document.createElement('div');
        nameCell.textContent = label;
        const valueCell = document.createElement('div');
        valueCell.textContent = text;
        row.appendChild(nameCell);
        row.appendChild(valueCell);
        expDiv.appendChild(row);
    }
    document.body.appendChild(expDiv);
    return expDiv;
}

describe('extractExpRates', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('returns null when the sim results panel is not in the DOM', () => {
        expect(extractExpRates()).toBeNull();
    });

    test('parses plain exp/hour figures', () => {
        mountExpDiv([
            ['Stamina Experience', '450'],
            ['Attack Experience', '900'],
        ]);
        expect(extractExpRates()).toEqual({ stamina: 450, attack: 900 });
    });

    test('parses thousand-separated exp/hour figures instead of dropping them to NaN', () => {
        // A high-level loadout easily clears four digits of exp/hour, and the
        // sim panel formats that with a comma the same way the rest of the
        // game's DOM does. Number('12,345') is NaN, which the calculator UI
        // then reads as "not trained in simulation" for a skill that is
        // actually gaining exp the fastest of any of them.
        mountExpDiv([
            ['Melee Experience', '12,345'],
            ['Defense Experience', '1,234,567'],
        ]);
        expect(extractExpRates()).toEqual({ melee: 12345, defense: 1234567 });
    });
});

describe('createCalculatorUI mode switching', () => {
    const levelExpTable = {};
    for (let level = 1; level <= 201; level++) levelExpTable[level] = (level - 1) * 1000;
    const characterSkills = [
        { skillHrid: '/skills/attack', level: 10, experience: levelExpTable[10] },
        { skillHrid: '/skills/melee', level: 10, experience: levelExpTable[10] },
    ];
    const expRates = { attack: 1000, melee: 500 };

    function build(previous = null) {
        const container = document.createElement('div');
        document.body.appendChild(container);
        return createCalculatorUI(container, characterSkills, expRates, levelExpTable, previous);
    }

    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('starts on the days projection', () => {
        const ui = build();
        expect(ui.resultsHeader.textContent).toBe('After 1 days:');
    });

    test('a focus event alone on a skill input switches to that skill ETA', () => {
        const ui = build();
        ui.skillInputs.attack.dispatchEvent(new Event('focus'));
        expect(ui.resultsHeader.textContent).toBe('Attack to level 11 takes:');
    });

    test('a change event switches too, even though focus is elsewhere', () => {
        const ui = build();
        ui.daysInput.focus();
        ui.skillInputs.melee.value = '15';
        ui.skillInputs.melee.dispatchEvent(new Event('change'));
        expect(document.activeElement).toBe(ui.daysInput);
        expect(ui.resultsHeader.textContent).toBe('Melee to level 15 takes:');
    });

    test('touching the days input goes back to the projection', () => {
        const ui = build();
        ui.skillInputs.attack.dispatchEvent(new Event('focus'));
        ui.daysInput.dispatchEvent(new Event('focus'));
        expect(ui.resultsHeader.textContent).toBe('After 1 days:');
    });

    test('a rebuild keeps the targets and the active skill', () => {
        const first = build();
        first.skillInputs.melee.value = '20';
        first.skillInputs.melee.dispatchEvent(new Event('input'));
        document.body.innerHTML = '';

        const second = build(first.getState());

        expect(second.skillInputs.melee.value).toBe('20');
        expect(second.resultsHeader.textContent).toBe('Melee to level 20 takes:');
    });
});
