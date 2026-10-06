/**
 * @vitest-environment happy-dom
 *
 * The enhancing panel's Target Level and Protect From Level inputs, found on a client in any
 * language. A player may run the game in Chinese, where there is no "Target Level" text to match.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { findEnhancingInput } from './enhancing-inputs.js';

/** The enhancing settings as the panel lays them out: label beside input, then the Repeat field */
function panelWith({ target = '目标等级', protectFrom = '保护等级', extra = '' } = {}) {
    const panel = document.createElement('div');
    panel.innerHTML =
        extra +
        `<div><span>${target}</span><input type="number" value="12"></div>` +
        `<div><span>${protectFrom}</span><input type="number" value="4"></div>` +
        '<div class="SkillActionDetail_maxActionCountInput__1C0Pw"><span>重复</span><input type="text" value="∞"></div>';
    document.body.appendChild(panel);
    return panel;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('findEnhancingInput', () => {
    test('finds both inputs on a Chinese client', () => {
        const panel = panelWith();
        expect(findEnhancingInput(panel, 'target').value).toBe('12');
        expect(findEnhancingInput(panel, 'protectFrom').value).toBe('4');
    });

    test('finds both inputs by their English labels', () => {
        const panel = panelWith({ target: 'Target Level', protectFrom: 'Protect From Level' });
        expect(findEnhancingInput(panel, 'target').value).toBe('12');
        expect(findEnhancingInput(panel, 'protectFrom').value).toBe('4');
    });

    test("does not take Toolasha's own inputs or the Repeat field for the game's", () => {
        const panel = panelWith({
            extra:
                '<div id="mwi-enhancement-stats"><div><span>模拟</span><input type="number" value="99"></div></div>' +
                '<div data-toolasha-surface="panel"><div><span>x</span><input type="number" value="98"></div></div>',
        });
        expect(findEnhancingInput(panel, 'target').value).toBe('12');
        expect(findEnhancingInput(panel, 'protectFrom').value).toBe('4');
    });

    test('nothing to find is null', () => {
        const panel = document.createElement('div');
        expect(findEnhancingInput(panel, 'target')).toBeNull();
        expect(findEnhancingInput(null, 'target')).toBeNull();
    });
});
