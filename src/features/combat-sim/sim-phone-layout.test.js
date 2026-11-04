/** @vitest-environment happy-dom */
import { describe, it, expect, beforeEach } from 'vitest';
import { SIM_PHONE_CSS, SIM_PHONE_STYLE_ID, ensureSimPhoneStyles } from './sim-phone-layout.js';

describe('sim phone layout', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
    });

    it('installs one stylesheet however often it is asked', () => {
        ensureSimPhoneStyles();
        ensureSimPhoneStyles();
        expect(document.querySelectorAll(`#${SIM_PHONE_STYLE_ID}`)).toHaveLength(1);
    });

    it('wraps the lab crate row at phone width only', () => {
        expect(SIM_PHONE_CSS).toMatch(/@media \(max-width: 768px\)[\s\S]*#mwi-labsim-crate-row \{ flex-wrap: wrap; \}/);
    });

    it('spans both sim panels across the viewport at phone width, over any saved geometry', () => {
        const rule = SIM_PHONE_CSS.match(/#mwi-combat-sim-panel,\s*#mwi-lab-sim-panel \{([^}]*)\}/)?.[1] || '';
        expect(rule).toContain('left: 0 !important');
        expect(rule).toContain('width: 100vw !important');
        expect(rule).toContain('max-width: 100vw !important');
    });

    it('gives the combat zone select a line of its own at phone width', () => {
        expect(SIM_PHONE_CSS).toMatch(
            /@media \(max-width: 768px\)[\s\S]*#mwi-csim-zone \{ flex: 1 1 calc\(100% - 60px\)/
        );
    });
});
