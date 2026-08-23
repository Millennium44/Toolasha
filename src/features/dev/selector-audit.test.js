/** @vitest-environment happy-dom
 *
 * The stylesheet diff that found four broken selectors on 2026-08-17, as a
 * unit. The stylesheets are the game's own complete inventory of class names,
 * so "does any of them contain this prefix" is the whole verdict.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { collectStylesheetClasses, auditSelector, auditSelectors } from './selector-audit.js';

const CLASSES = new Set([
    'Header_actionName__2Y0Cf',
    'GuildPanel_tileName__mol0E',
    'ChatMessage_name__1UZ8t',
    'Collection_collectionContainer__3ZlUO',
]);

describe('auditSelector', () => {
    test('a prefix selector passes when some class contains it', () => {
        expect(auditSelector('[class*="Header_actionName"]', CLASSES).status).toBe('ok');
        expect(auditSelector('div[class*="GuildPanel_tile"]', CLASSES).status).toBe('ok');
    });

    test('a prefix no class contains is broken, and named', () => {
        const verdict = auditSelector('[class*="ChatMessage_username"]', CLASSES);
        expect(verdict.status).toBe('broken');
        expect(verdict.missing).toEqual(['ChatMessage_username']);
    });

    test('a compound selector is judged on every class it names', () => {
        const verdict = auditSelector('[class*="Header_actionName"] [class*="Collection_collections"]', CLASSES);
        expect(verdict.status).toBe('broken');
        expect(verdict.missing).toEqual(['Collection_collections']);
    });

    test('a full hashed literal must match exactly', () => {
        expect(auditSelector('.ChatMessage_name__1UZ8t', CLASSES).status).toBe('ok');
        // The rotated hash that silently killed the pinned-nav clear
        expect(auditSelector('.ChatMessage_name__2Oj_e', CLASSES).status).toBe('broken');
    });

    test('a selector naming no game class is unchecked, not passed', () => {
        expect(auditSelector('[role="tablist"]', CLASSES).status).toBe('unchecked');
        expect(auditSelector('#mwi-panel', CLASSES).status).toBe('unchecked');
    });

    test('a MUI prefix is unchecked — real, but never in the module-class inventory', () => {
        // Live run 2026-08-17: MuiTabs-flexContainer read as broken until
        // non-module-shaped prefixes were routed here
        expect(auditSelector('[class*="MuiTabs-flexContainer"]', CLASSES).status).toBe('unchecked');
    });

    test('class^= (starts-with) prefixes are audited the same way', () => {
        expect(auditSelector('[class^="ChatMessage_name"]', CLASSES).status).toBe('ok');
        expect(auditSelector('[class^="ChatMessage_username"]', CLASSES).status).toBe('broken');
    });
});

describe('auditSelectors', () => {
    test('splits an inventory into checked, broken and unchecked', () => {
        const report = auditSelectors(
            {
                good: '[class*="Header_actionName"]',
                bad: '[class*="NavigationBar_ocean"]',
                odd: '[role="tab"]',
            },
            CLASSES
        );
        expect(report.checked).toBe(2);
        expect(report.broken).toEqual([
            { name: 'bad', selector: '[class*="NavigationBar_ocean"]', missing: 'NavigationBar_ocean' },
        ]);
        expect(report.unchecked).toEqual(['odd']);
    });
});

describe('collectStylesheetClasses', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
    });

    test('reads CSS-module class names out of the live stylesheets', () => {
        const style = document.createElement('style');
        style.textContent =
            '.Header_actionName__2Y0Cf { color: red; } ' +
            '.GuildPanel_tileName__mol0E .Item_name__2C42x { color: blue; } ' +
            '.plain-class { color: green; }';
        document.head.appendChild(style);

        const classes = collectStylesheetClasses(document);
        expect(classes.has('Header_actionName__2Y0Cf')).toBe(true);
        expect(classes.has('GuildPanel_tileName__mol0E')).toBe(true);
        expect(classes.has('Item_name__2C42x')).toBe(true);
        expect(classes.has('plain-class')).toBe(false);
    });
});

describe('what the audit does not cover', () => {
    test('the most-used inline prefixes are in the registry, so the audit can see them', async () => {
        const { GAME } = await import('../../utils/selectors.js');
        const registered = Object.values(GAME).join(' ');

        // Each of these was written out at a dozen or more call sites and registered
        // nowhere, which meant a rename would not have shown up in the audit at all
        for (const prefix of [
            'Item_enhancementLevel',
            'Collection_tooltipContent',
            'GuildPanel',
            'MarketplacePanel_myListingsTable',
            'BattlePanel_playersArea',
            'SkillActionDetail_alchemyComponent',
            'EnhancingPanel_enhancingPanel',
        ]) {
            expect(registered).toContain(prefix);
        }
    });

    test('a CSS-module registry entry is always judgeable; only foreign prefixes are not', async () => {
        const { GAME } = await import('../../utils/selectors.js');
        const report = auditSelectors(GAME, CLASSES);

        // Everything the audit had to pass on names something the game's CSS-module
        // pipeline did not generate — MUI's own classes, or a bare camelCase class. Those
        // are real selectors that never enter the module-class inventory. Nothing
        // Component_name-shaped should end up unchecked.
        for (const name of report.unchecked) {
            expect(GAME[name]).not.toMatch(/class[*^]?=["'][A-Z][A-Za-z]*_[A-Za-z]/);
        }

        // And the prefixes just moved out of the feature files are all judged
        for (const name of [
            'ITEM_ENHANCEMENT_LEVEL',
            'COLLECTION_TOOLTIP_CONTENT',
            'GUILD_PANEL',
            'MARKETPLACE_MY_LISTINGS_TABLE',
            'BATTLE_PLAYERS_AREA',
            'SKILL_ACTION_DETAIL_ALCHEMY',
            'ENHANCING_PANEL',
        ]) {
            expect(report.unchecked).not.toContain(name);
        }
    });
});
