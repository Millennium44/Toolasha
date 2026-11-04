/** @vitest-environment happy-dom */
import { describe, test, expect, afterEach } from 'vitest';
import { createSimTabButton, removeSimTabStyleIfUnused } from './sim-tab-button.js';

afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
});

describe('sim tab button', () => {
    test('compact sizing is a wide-screen rule, not inline, so a phone takes the game tab sizing', () => {
        const button = createSimTabButton('Combat Sim', 'toolasha-combat-sim-btn', () => {});
        expect(button.style.padding).toBe('');
        expect(button.style.fontSize).toBe('');
        expect(button.style.background).toContain('linear-gradient');
        const css = document.getElementById('toolasha-sim-tab-style').textContent;
        expect(css).toContain('@media (min-width: 769px)');
        expect(css).toContain('font-size: 12px');
    });

    test('the rule stays while either button is on the page and goes with the last one', () => {
        const a = createSimTabButton('Combat Sim', 'toolasha-combat-sim-btn', () => {});
        const b = createSimTabButton('Lab Sim', 'toolasha-lab-sim-btn', () => {});
        document.body.append(a, b);
        expect(document.querySelectorAll('#toolasha-sim-tab-style')).toHaveLength(1);
        a.remove();
        removeSimTabStyleIfUnused();
        expect(document.getElementById('toolasha-sim-tab-style')).not.toBeNull();
        b.remove();
        removeSimTabStyleIfUnused();
        expect(document.getElementById('toolasha-sim-tab-style')).toBeNull();
    });
});
