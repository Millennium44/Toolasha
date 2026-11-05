/**
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ settings: {}, listeners: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        onSettingChange: (key, fn) => {
            const entry = { key, fn };
            game.listeners.push(entry);
            return () => {
                game.listeners = game.listeners.filter((l) => l !== entry);
            };
        },
    },
}));

const {
    default: feature,
    SETTING,
    STYLE_MARK,
    AREA_SEL,
    GRID_CSS,
    PHONE_MIN_WIDTH,
} = await import('./guild-trial-unit-grid.js');

const sheets = () => document.head.querySelectorAll(`style[${STYLE_MARK}]`);

/** The game's trial fight: a self card and columns of three minis */
const TRIAL = `<div class="BattlePanel_guildPartyArea__a"><div class="MiniUnitGrid_miniUnitGrid__b">
  <div class="CombatUnit_combatUnit__c" id="self"><div class="CombatUnit_name__d">Me</div></div>
  <div class="MiniUnitGrid_miniUnitColumn__e" id="col">
    <div class="MiniUnit_miniUnit__f"><div class="MiniUnit_name__g">Bo</div></div>
    <div class="MiniUnit_miniUnit__f"><div class="MiniUnit_name__g">Dee</div></div>
  </div></div></div>`;

/** A normal party fight: same grid classes, different container */
const NORMAL = `<div class="BattlePanel_playersArea__z"><div class="MiniUnitGrid_miniUnitGrid__b">
  <div class="MiniUnitGrid_miniUnitColumn__e"><div class="MiniUnit_miniUnit__f"></div></div></div></div>`;

describe('guild trial unit grid', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        game.settings = {};
        game.listeners = [];
    });
    afterEach(() => feature.cleanup());

    test('default on: the rule is present', () => {
        feature.initialize();
        expect(sheets().length).toBe(1);
        expect(sheets()[0].textContent).toBe(GRID_CSS);
        expect(GRID_CSS).toContain('display: contents');
        expect(GRID_CSS).toContain('span 3');
        expect(GRID_CSS).toContain(`min-width: ${PHONE_MIN_WIDTH}px`);
    });

    test('setting off: no style; turning it on and off follows live, without duplicates', () => {
        game.settings[SETTING] = false;
        feature.initialize();
        expect(sheets().length).toBe(0);
        for (const l of game.listeners.filter((x) => x.key === SETTING)) l.fn(true);
        for (const l of game.listeners.filter((x) => x.key === SETTING)) l.fn(true);
        expect(sheets().length).toBe(1);
        for (const l of game.listeners.filter((x) => x.key === SETTING)) l.fn(false);
        expect(sheets().length).toBe(0);
    });

    test('cleanup removes the style and the listener; re-initialize redoes it', () => {
        feature.initialize();
        feature.cleanup();
        expect(sheets().length).toBe(0);
        expect(game.listeners.length).toBe(0);
        feature.initialize();
        expect(sheets().length).toBe(1);
    });

    test('every rule is scoped under the trial party area; a normal party grid is not matched', () => {
        const rules = GRID_CSS.split('\n').filter((l) => l.includes(AREA_SEL));
        expect(rules.length).toBe(3);
        for (const line of GRID_CSS.split('\n').filter((l) => l.includes('{') && !l.startsWith('@media'))) {
            expect(line.startsWith(AREA_SEL)).toBe(true);
        }
        document.body.innerHTML = TRIAL + NORMAL;
        const col = (root) => root.querySelector('[class*="MiniUnitGrid_miniUnitColumn"]');
        expect(
            col(document.querySelector('[class*="guildPartyArea"]')).matches(
                `${AREA_SEL} [class*="MiniUnitGrid_miniUnitColumn"]`
            )
        ).toBe(true);
        const normalCol = col(document.querySelector('[class*="playersArea"]'));
        expect(normalCol.matches(`${AREA_SEL} [class*="MiniUnitGrid_miniUnitColumn"]`)).toBe(false);
        expect(normalCol.closest(AREA_SEL)).toBeNull();
    });

    test('readers that walk the area still find every unit with the rule applied', () => {
        feature.initialize();
        document.body.innerHTML = TRIAL;
        const area = document.querySelector(AREA_SEL);
        expect(area.querySelectorAll('[class*="MiniUnit_miniUnit"]').length).toBe(2);
        expect(area.querySelectorAll('[class*="CombatUnit_combatUnit"], [class*="MiniUnit_miniUnit"]').length).toBe(3);
        expect([...area.querySelectorAll('[class*="MiniUnit_name"]')].map((n) => n.textContent)).toEqual(['Bo', 'Dee']);
        // a badge attached to the tile reads its parent as the tile, not the column
        const tile = area.querySelector('[class*="MiniUnit_miniUnit"]');
        const badge = document.createElement('span');
        tile.appendChild(badge);
        expect(badge.parentElement).toBe(tile);
    });
});
