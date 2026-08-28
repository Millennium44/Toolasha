/**
 * @vitest-environment happy-dom
 */

import { describe, test, expect, afterEach } from 'vitest';
import { extractExpRates } from './skill-calculator-ui.js';

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
