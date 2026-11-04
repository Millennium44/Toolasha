/** @vitest-environment happy-dom */
import { describe, it, expect, beforeEach } from 'vitest';
import { SIM_PHONE_CSS, SIM_PHONE_STYLE_ID, SIM_UPGRADE_PHONE_CSS, ensureSimPhoneStyles } from './sim-phone-layout.js';

describe('sim phone layout', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
    });

    it('installs one stylesheet however often it is asked', () => {
        ensureSimPhoneStyles();
        ensureSimPhoneStyles();
        expect(document.querySelectorAll(`#${SIM_PHONE_STYLE_ID}`)).toHaveLength(1);
    });

    it('lays the lab crate row on one grid line, labels beside their selects, at phone width only', () => {
        expect(SIM_PHONE_CSS).toMatch(/@media \(max-width: 768px\)[\s\S]*#mwi-labsim-crate-row \{\s*display: grid/);
        expect(SIM_PHONE_CSS).toContain('grid-template-columns: repeat(3, auto minmax(0, 1fr))');
        expect(SIM_PHONE_CSS).not.toContain('flex-wrap');
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

    it('wraps the Lab chips, the solo+party loadouts and the Lab skilling crate row too', () => {
        expect(SIM_UPGRADE_PHONE_CSS).toContain('[data-lab-mode-chip]');
        expect(SIM_UPGRADE_PHONE_CSS).toMatch(/#mwi-csim-soloparty-loadouts \{ flex-wrap: wrap/);
        expect(SIM_UPGRADE_PHONE_CSS).toMatch(/#mwi-labsim-skilling-crate-row \{\s*display: grid/);
    });

    it('lets the include chips wrap and the results tables scroll inside their wrapper at phone width only', () => {
        expect(SIM_UPGRADE_PHONE_CSS).toMatch(/^\s*@media \(max-width: 768px\) \{/);
        expect(SIM_UPGRADE_PHONE_CSS).toMatch(/\[data-lab-mode-options\] \{[^}]*flex-wrap: wrap/);
        expect(SIM_UPGRADE_PHONE_CSS).toMatch(
            /\.mwi-utable-wrap \{[^}]*overflow: auto; -webkit-overflow-scrolling: touch/
        );
        expect(SIM_UPGRADE_PHONE_CSS).toMatch(/th:first-child,[\s\S]*position: sticky; left: 0;/);
        expect(SIM_UPGRADE_PHONE_CSS).toMatch(/td:first-child:not\(\[colspan\]\) \{\s*background: rgb/);
        expect(SIM_UPGRADE_PHONE_CSS).toMatch(/\.mwi-utable-detail \{[^}]*position: sticky; left: 0/);
    });
});
