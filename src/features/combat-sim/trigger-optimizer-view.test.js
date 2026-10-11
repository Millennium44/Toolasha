/**
 * Trigger optimizer results box: grouped by player, ordered as given, honest
 * about the all-together check, and never offering to touch the game.
 */

import { describe, test, expect } from 'vitest';
import { renderTriggerResultsHtml, triggerChipOptionsHtml, esc } from './trigger-optimizer-view.js';

const gameData = {
    combatTriggerDependencyDetailMap: { '/combat_trigger_dependencies/targeted_enemy': { name: 'Targeted enemy' } },
    combatTriggerConditionDetailMap: { '/combat_trigger_conditions/current_hp': { name: 'Current HP' } },
};

const change = (over = {}) => ({
    playerHrid: 'player1',
    playerName: 'Milkman',
    slotType: 'abilities',
    itemName: 'Fireball',
    dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
    conditionHrid: '/combat_trigger_conditions/current_hp',
    comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
    from: 1,
    to: 600,
    deltaScore: 7.25,
    se: 1.5,
    deltaXp: 1500,
    deltaProfit: -2000,
    deltaDeaths: -0.25,
    ...over,
});

describe('renderTriggerResultsHtml', () => {
    test('shows old -> new, the score with its error bar and the information deltas', () => {
        const html = renderTriggerResultsHtml(
            { scope: 'me', changes: [change()], unchanged: [], combined: null, simCount: 80 },
            gameData
        );
        expect(html).toContain('Fireball');
        expect(html).toContain('Targeted enemy: Current HP ≥ 600');
        expect(html).toContain('(was 1)');
        expect(html).toContain('Δscore +7.3 ± 1.5');
        expect(html).toContain('ΔEXP/h +1.5K');
        expect(html).toContain('Δprofit/h -2.0K');
        expect(html).toContain('Δdeaths/h -0.250');
        expect(html).toContain('mwi-csim-trigger-apply');
        expect(html).toContain('mwi-csim-trigger-copy');
    });

    test('rows that never came into play are listed as not used in this fight', () => {
        const html = renderTriggerResultsHtml(
            {
                scope: 'me',
                changes: [change()],
                unchanged: [{ itemName: 'Donut' }],
                unused: [{ itemName: 'Ice Spear' }, { itemName: 'Ice Spear' }],
                simCount: 1,
            },
            gameData
        );
        expect(html).toContain('Not used in this fight: Ice Spear.');
        expect(html).toContain('Kept as is: Donut.');
        const allUnused = renderTriggerResultsHtml(
            { scope: 'me', changes: [], unchanged: [], unused: [{ itemName: 'Ice Spear' }], simCount: 4 },
            gameData
        );
        expect(allUnused).toContain('None of these triggers came into play');
        expect(allUnused).not.toContain('No change beat');
    });

    test('the footer shows the chosen minimum gain', () => {
        const render = (minGain) =>
            renderTriggerResultsHtml(
                { scope: 'me', changes: [change()], unchanged: [], minGain, simCount: 1 },
                gameData
            );
        expect(render(2)).toContain('gains at least 2 points');
        expect(render(0.25)).toContain('gains at least 0.25 points');
        expect(render(undefined)).toContain('gains at least 0.5 points');
    });

    test('a party run groups rows under each player', () => {
        const html = renderTriggerResultsHtml(
            {
                scope: 'party',
                changes: [change(), change({ playerHrid: 'player2', playerName: 'Cheesy', itemName: 'Donut' })],
                unchanged: [],
                simCount: 1,
            },
            gameData
        );
        expect(html.indexOf('Milkman')).toBeGreaterThan(-1);
        expect(html.indexOf('Cheesy')).toBeGreaterThan(html.indexOf('Milkman'));
    });

    test('the combined line is the last word when it exists, and its absence is said', () => {
        const combined = { deltaScore: 6, se: 1, deltaXp: 1, deltaProfit: 1, deltaDeaths: 0, seeds: 6 };
        const withLine = renderTriggerResultsHtml(
            { scope: 'me', changes: [change()], unchanged: [], combined, simCount: 1 },
            gameData
        );
        expect(withLine).toContain('All changes together');
        const without = renderTriggerResultsHtml(
            { scope: 'me', changes: [change()], unchanged: [], combined: null, stopped: true, simCount: 1 },
            gameData
        );
        expect(without).toContain('Stopped before the all-together check');
    });

    test('a rejected combination says so, recommends nothing and offers no buttons', () => {
        const html = renderTriggerResultsHtml(
            {
                scope: 'me',
                changes: [],
                rejected: [change()],
                unchanged: [{ itemName: 'Fireball' }],
                reliable: false,
                combined: { deltaScore: -0.2, se: 0.4, deltaXp: 0, deltaProfit: 0, deltaDeaths: 0, seeds: 8 },
                simCount: 100,
            },
            gameData
        );
        expect(html).toContain('No reliable improvement found');
        expect(html).toContain('All changes together');
        expect(html).not.toContain('Targeted enemy: Current HP');
        expect(html).not.toContain('mwi-csim-trigger-apply');
        expect(html).not.toContain('mwi-csim-trigger-copy');
    });

    test('no changes means no buttons and an honest sentence', () => {
        const html = renderTriggerResultsHtml(
            { scope: 'me', changes: [], unchanged: [{ itemName: 'Donut' }] },
            gameData
        );
        expect(html).toContain('No change beat the current thresholds');
        expect(html).not.toContain('mwi-csim-trigger-apply');
        expect(html).toContain('Kept as is: Donut');
    });

    test('nothing to tune and a stop before the baseline each get a line', () => {
        expect(renderTriggerResultsHtml({ noTunables: true, scope: 'me', changes: [] }, gameData)).toContain(
            'Nothing to tune'
        );
        expect(renderTriggerResultsHtml(null, gameData)).toContain('Stopped before the baseline');
    });

    test('an empty scope says which kind of trigger is missing', () => {
        const empty = (include) =>
            renderTriggerResultsHtml({ noTunables: true, scope: 'me', include, changes: [] }, gameData);
        expect(empty('abilities')).toContain('No tunable ability triggers in this setup');
        expect(empty('consumables')).toContain('No tunable food or drink triggers in this setup');
    });

    test('Apply is disabled when there is no sim editor to write into, and names are escaped', () => {
        const html = renderTriggerResultsHtml(
            { scope: 'me', changes: [change({ itemName: '<b>x</b>' })], unchanged: [], simCount: 1 },
            gameData,
            { canApply: false }
        );
        expect(html).toMatch(/mwi-csim-trigger-apply"[^>]*disabled/);
        expect(html).not.toContain('<b>x</b>');
        expect(esc('a"<')).toBe('a&quot;&lt;');
    });
});

describe('triggerChipOptionsHtml', () => {
    test('offers Just me / Whole party and the three precisions, Standard selected', () => {
        const html = triggerChipOptionsHtml();
        expect(html).toContain('value="me" selected');
        expect(html).toContain('value="party"');
        expect(html).toContain('value="quick"');
        expect(html).toContain('value="standard" selected');
        expect(html).toContain('value="precise"');
        for (const v of [0.25, 0.5, 1, 2]) expect(html).toContain(`value="${v}"`);
        expect(html).toContain('value="0.5" selected');
        expect(html).toContain('smallest score gain worth offering');
        expect(html).toContain('id="mwi-csim-trigger-include"');
        expect(html).toContain('value="both" selected');
        expect(html).toContain('value="abilities"');
        expect(html).toContain('value="consumables"');
    });
});
