import { describe, test, expect, vi, beforeEach } from 'vitest';

const values = {};
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => values[key] === true,
        getSettingValue: (key, fallback) => (key in values ? values[key] : fallback),
        onSettingChange: () => {},
        offSettingChange: () => {},
    },
}));
vi.mock('../../utils/dom.js', () => ({ addStyles: () => {}, removeStyles: () => {} }));

const { buildCombatScaleCSS } = await import('./combat-panel-scale.js');

beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
});

describe('buildCombatScaleCSS', () => {
    test('emits nothing when nothing is being overridden', () => {
        // Everything at its default has to be silent — a stylesheet full of
        // !important rules that restate the game's own layout is a stylesheet
        // that breaks the next time the game changes it
        expect(buildCombatScaleCSS()).toBe('');
    });

    test('scales each side on its own', () => {
        values.combatScalePlayers = 60;
        values.combatScaleMonsters = 130;
        const css = buildCombatScaleCSS();
        expect(css).toContain('BattlePanel_playersArea');
        expect(css).toMatch(/playersArea[^{]*{ zoom: 0\.6/);
        expect(css).toMatch(/monstersArea[^{]*{ zoom: 1\.3/);
    });

    test('a side left at 100 gets no rule at all', () => {
        values.combatScalePlayers = 50;
        const css = buildCombatScaleCSS();
        expect(css).toContain('playersArea');
        expect(css).not.toContain('monstersArea');
    });

    test('transform reclaims the space its layout box keeps', () => {
        // scale() alone leaves the full-size box behind, so a 50% side still
        // reserves the room it no longer uses
        values.combatScaleMethod = 'transform';
        values.combatScalePlayers = 50;
        values.combatScaleOrigin = 'top left';
        const css = buildCombatScaleCSS();
        expect(css).toContain('transform: scale(0.5)');
        expect(css).toContain('transform-origin: top left');
        expect(css).toContain('margin-bottom: -50%');
    });

    test('clamps a scale nobody could have meant', () => {
        values.combatScalePlayers = 5000;
        expect(buildCombatScaleCSS()).toContain('zoom: 2');
        values.combatScalePlayers = -3;
        expect(buildCombatScaleCSS()).toBe('');
        values.combatScalePlayers = 'nonsense';
        expect(buildCombatScaleCSS()).toBe('');
    });

    test('leaves the layout alone unless asked', () => {
        values.combatScalePlayers = 50;
        expect(buildCombatScaleCSS()).not.toContain('flex-direction');
    });

    test('forces a layout when asked, in either direction', () => {
        values.combatScaleLayout = 'side';
        expect(buildCombatScaleCSS()).toContain('flex-direction: row');
        values.combatScaleLayout = 'stack';
        expect(buildCombatScaleCSS()).toContain('flex-direction: column');
    });

    test('the character panel height is opt-in and clamped', () => {
        expect(buildCombatScaleCSS()).not.toContain('vh');
        values.combatScalePanelHeight = 65;
        expect(buildCombatScaleCSS()).toContain('height: 65vh');
        values.combatScalePanelHeight = 500;
        expect(buildCombatScaleCSS()).toContain('height: 100vh');
    });

    test('targets classes by prefix, never by build hash', () => {
        // The original pinned BattlePanel_playersArea__vvwlB; those suffixes are
        // regenerated every game build, so the script would break silently
        values.combatScalePlayers = 50;
        values.combatScaleLayout = 'side';
        values.combatScalePanelHeight = 50;
        const css = buildCombatScaleCSS();
        expect(css).not.toMatch(/__[A-Za-z0-9]{5}/);
        expect(css).toContain('[class*="BattlePanel_combatUnitGrid"]');
    });
});
