/**
 * Trigger optimizer results box: grouped by player, ordered as given, honest
 * about the all-together check, and never offering to touch the game.
 */

import { describe, test, expect } from 'vitest';
import {
    renderTriggerResultsHtml,
    triggerChipOptionsHtml,
    triggerHeadline,
    esc,
    triggerVerifyHtml,
    verifyChipHtml,
    formatVerifyFigure,
} from './trigger-optimizer-view.js';

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

    test('the footer explains the chosen objective', () => {
        const render = (objective) =>
            renderTriggerResultsHtml(
                { scope: 'me', changes: [change()], unchanged: [], objective, simCount: 1 },
                gameData
            );
        expect(render(undefined)).toContain(
            'Score is the average of the EXP/h, profit/h, DPS and encounters/h changes'
        );
        expect(render('balanced')).toContain('Score is the average of the EXP/h');
        expect(render('xp')).toContain('Optimizing for XP/h: score is the percent change in EXP/h, less 10 points');
        expect(render('profit')).toContain('Optimizing for profit/h: score is the percent change in profit/h');
    });

    test('Profit/h that could not value profit recommends nothing and names the unpriced items', () => {
        const html = renderTriggerResultsHtml(
            {
                scope: 'me',
                objective: 'profit',
                changes: [],
                unchanged: [],
                reliable: false,
                profitLeftOut: true,
                unpriced: ['/items/donut', '/items/chimerical_chest_key'],
                simCount: 4,
            },
            { ...gameData, itemDetailMap: { '/items/donut': { name: 'Donut' } } }
        );
        expect(html).toContain(
            "Nothing recommended: profit can't be valued: Donut, Chimerical Chest Key have no price."
        );
        expect(html).not.toContain('No reliable improvement found');
        expect(html).not.toContain('mwi-csim-trigger-apply');
    });

    test('a food left untuned for want of a price is named', () => {
        const html = renderTriggerResultsHtml(
            {
                scope: 'me',
                changes: [],
                unchanged: [],
                notPriced: [{ itemName: 'Donut' }, { itemName: 'Donut' }],
                profitLeftOut: true,
                unpriced: ['/items/donut'],
                simCount: 4,
            },
            gameData
        );
        expect(html).toContain("Not tuned: Donut has no price, so the gold effect can't be checked.");
    });

    test('Balanced says profit was left out, and does not print a profit delta it could not value', () => {
        const html = renderTriggerResultsHtml(
            {
                scope: 'me',
                changes: [change()],
                unchanged: [],
                combined: { deltaScore: 2, se: 0.5, deltaXp: 10, deltaProfit: 50, deltaDeaths: 0, seeds: 8 },
                reliable: true,
                profitLeftOut: true,
                unpriced: ['/items/donut'],
                valuationFailed: true,
                simCount: 4,
            },
            gameData
        );
        expect(html).toContain('Profit/h left out of the score where it could not be counted');
        expect(html).toContain('Donut has no price; the valuation failed.');
        expect(html).toContain('Δprofit/h ? (not valued)');
        expect(html).not.toContain('Not tuned');
        expect(html).not.toContain('Δprofit/h +50');
        expect(html).not.toContain('Δprofit/h -2.0K');
    });

    test('a remembered result is labelled and offers Run again; a fresh one does not', () => {
        const result = { scope: 'me', changes: [change()], unchanged: [], simCount: 1 };
        const cached = renderTriggerResultsHtml(result, gameData, { cached: true });
        expect(cached).toContain('Last result (unchanged setup)');
        expect(cached).toContain('mwi-csim-trigger-rerun');
        expect(cached).toContain('mwi-csim-trigger-apply');
        const fresh = renderTriggerResultsHtml(result, gameData);
        expect(fresh).not.toContain('Last result');
        expect(fresh).not.toContain('mwi-csim-trigger-rerun');
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

describe('best found when nothing is accepted', () => {
    const best = (over = {}) => change({ key: 'k1', deltaScore: 0.3, se: 0.9, ...over });

    test('a run with no accepted change shows the best candidate in the objective score points', () => {
        const html = renderTriggerResultsHtml(
            { scope: 'me', objective: 'xp', changes: [], unchanged: [], bestMeasured: best(), simCount: 9 },
            gameData
        );
        expect(html).toContain('Best found: Fireball — Targeted enemy: Current HP ≥ 600 (was 1), Δscore +0.3 ± 0.9');
        expect(html).toContain('within noise, not a recommendation');
        expect(html).not.toContain('mwi-csim-trigger-apply');
    });

    test('a rejected all-together check keeps the best-found line', () => {
        const html = renderTriggerResultsHtml(
            {
                scope: 'me',
                changes: [],
                reliable: false,
                bestMeasured: best({ deltaScore: -0 + 1.25 }),
                unchanged: [],
                simCount: 9,
            },
            gameData
        );
        expect(html).toContain('No reliable improvement found.');
        expect(html).toContain('Best found: Fireball');
        expect(html).toContain('Δscore +1.3');
    });

    test('says the current setting measured best when no candidate beat it', () => {
        const html = renderTriggerResultsHtml(
            { scope: 'me', changes: [], bestMeasured: best({ deltaScore: -0.4 }), unchanged: [], simCount: 9 },
            gameData
        );
        expect(html).toContain('Current setting measured best.');
        expect(html).not.toContain('Best found:');
    });

    test('accepted changes render as before, with no best-found line', () => {
        const html = renderTriggerResultsHtml(
            { scope: 'me', changes: [change()], bestMeasured: best(), unchanged: [], simCount: 9 },
            gameData
        );
        expect(html).not.toContain('Best found');
        expect(html).toContain('Δscore +7.3 ± 1.5');
    });
});

describe('new conditions block', () => {
    const rows = (value) => [
        {
            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
            conditionHrid: '/combat_trigger_conditions/current_hp',
            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
            value,
        },
    ];
    const cond = (over = {}) => ({
        key: 'abilities|1',
        slotType: 'abilities',
        itemName: 'Fireball',
        fromRows: rows(1),
        toRows: [...rows(1), ...rows(50)],
        deltaScore: 5,
        se: 0.4,
        ...over,
    });
    const render = (conditions, extra = {}) =>
        renderTriggerResultsHtml(
            { scope: 'me', changes: [], unchanged: [], simCount: 9, conditions, ...extra },
            gameData
        );

    test('lists an accepted condition in the game wording, with was: and the objective score points', () => {
        const html = render({ changes: [cond()], bestMeasured: [], reliable: true, slotCount: 1 });
        expect(html).toContain('New conditions');
        expect(html).toContain('Activate when: Targeted enemy Current HP');
        expect(html).toContain('was: Activate when: Targeted enemy Current HP');
        expect(html).toContain('Δscore +5.0 ± 0.4');
    });

    test('with no accepted condition it shows the best found, or that the current rows measured best', () => {
        const best = render({ changes: [], bestMeasured: [cond({ deltaScore: 0.6 })], slotCount: 1 });
        expect(best).toContain('No condition beat the current triggers by a clear margin');
        expect(best).toContain('Best found: Fireball (ability)');
        expect(best).toContain('not a recommendation');
        const current = render({ changes: [], bestMeasured: [cond({ deltaScore: -1 })], slotCount: 1 });
        expect(current).toContain('Fireball (ability): Current setting measured best.');
    });

    test('is absent when the search was not run, and still drawn when there were no thresholds to tune', () => {
        expect(render(undefined)).not.toContain('New conditions');
        const html = render({ changes: [cond()], bestMeasured: [], reliable: true }, { noTunables: true });
        expect(html).toContain('Nothing to tune');
        expect(html).toContain('New conditions');
    });

    test('says why a skipped search did not run, and when it hit the sim limit', () => {
        expect(render({ changes: [], skipped: 'cap' })).toContain('sim limit is too small');
        expect(render({ changes: [], bestMeasured: [], capped: true })).toContain('limit on condition-search sims');
    });

    test('the chip offers the unchecked "Search new conditions (slow)" box', () => {
        const html = triggerChipOptionsHtml();
        expect(html).toContain('id="mwi-csim-trigger-conditions"');
        expect(html).toContain('Search new conditions (slow)');
        expect(html).not.toMatch(/id="mwi-csim-trigger-conditions"[^>]*checked/);
    });
});

describe('triggerChipOptionsHtml', () => {
    test('offers Optimize for: Balanced (selected), XP/h and Profit/h', () => {
        const html = triggerChipOptionsHtml();
        expect(html).toContain('Optimize for');
        expect(html).toContain('id="mwi-csim-trigger-objective"');
        expect(html).toContain('<option value="balanced" selected>Balanced</option>');
        expect(html).toContain('<option value="xp">XP/h</option>');
        expect(html).toContain('<option value="profit">Profit/h</option>');
    });

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

describe('condition changes stopped before the all-together check', () => {
    const condChange = {
        key: 'abilities|1',
        slotType: 'abilities',
        itemName: 'Fireball',
        fromRows: [],
        toRows: [],
        deltaScore: 2,
        se: 0.5,
    };
    const run = (conditions) =>
        renderTriggerResultsHtml(
            { scope: 'me', changes: [], unchanged: [], combined: null, simCount: 10, conditions },
            gameData
        );

    test('are flagged as not yet confirmed together', () => {
        const html = run({ changes: [condChange], stopped: true, combined: null });
        expect(html).toContain('data-csim-condition-unconfirmed');
    });

    test('carry no such flag once the all-together check ran', () => {
        const html = run({
            changes: [condChange],
            reliable: true,
            combined: { deltaScore: 2, se: 0.4, seeds: 8 },
        });
        expect(html).not.toContain('data-csim-condition-unconfirmed');
    });
});

describe('a condition-only run that left profit out', () => {
    test('still carries the profit-left-out warning', () => {
        const html = renderTriggerResultsHtml(
            {
                scope: 'me',
                noTunables: true,
                include: 'both',
                objective: 'balanced',
                profitLeftOut: true,
                unpriced: ['/items/mystery'],
                changes: [],
                conditions: { changes: [], bestMeasured: [] },
            },
            gameData
        );
        expect(html).toContain('Profit/h left out of the score');
    });
});

describe('triggerHeadline with no thresholds to tune', () => {
    const cond = { playerHrid: 'player1', deltaScore: 5 };
    test('counts the condition changes the expanded view still shows', () => {
        expect(triggerHeadline({ noTunables: true, changes: [], conditions: { changes: [cond] } })).toBe(
            '1 condition change recommended'
        );
        expect(triggerHeadline({ noTunables: true, changes: [], conditions: { changes: [cond, cond] } })).toBe(
            '2 condition changes recommended'
        );
    });
    test('still says there is nothing to tune when the condition search found nothing or did not run', () => {
        expect(triggerHeadline({ noTunables: true, changes: [], conditions: { changes: [] } })).toBe('Nothing to tune');
        expect(triggerHeadline({ noTunables: true, changes: [] })).toBe('Nothing to tune');
    });
});

describe('the Verify block', () => {
    const result = { scope: 'me', changes: [change()], unchanged: [], simCount: 1 };

    test('offers a button when the result can be verified, and nothing without the verify option', () => {
        const withVerify = renderTriggerResultsHtml(result, gameData, { verify: { canVerify: true } });
        expect(withVerify).toContain('mwi-csim-trigger-verify-btn');
        expect(renderTriggerResultsHtml(result, gameData)).not.toContain('mwi-csim-trigger-verify');
    });

    test('a remembered result that cannot be verified says to re-run, with no button', () => {
        const html = renderTriggerResultsHtml(result, gameData, { cached: true, verify: { canVerify: false } });
        expect(html).toContain('re-run to verify');
        expect(html).not.toContain('mwi-csim-trigger-verify-btn');
        // a fresh result without a context says nothing at all
        const fresh = renderTriggerResultsHtml(result, gameData, { verify: { canVerify: false } });
        expect(fresh).not.toContain('re-run to verify');
    });

    test('draws the verdict with mean and se in points, and the basis', () => {
        const html = triggerVerifyHtml(
            {
                ...result,
                verifyOutcome: {
                    unit: 'points',
                    basis: 'best-found',
                    rows: [{ verdict: 'confirmed', mean: 3, se: 1, seeds: 8 }],
                },
            },
            { canVerify: true }
        );
        expect(html).toContain('✓ confirmed +3.00 pts ±1.00 pts');
        expect(html).toContain('best found');
        expect(html).toContain('over 8 fresh seeds');
    });

    test('says when a confirmed verdict is below the minimum gain or profit could not be valued', () => {
        const draw = (row) =>
            triggerVerifyHtml(
                { ...result, verifyOutcome: { unit: 'points', basis: 'recommended', rows: [row] } },
                { canVerify: true }
            );
        const plain = draw({
            verdict: 'confirmed',
            mean: 3,
            se: 1,
            seeds: 8,
            meetsMinGain: true,
            profitLeftOut: false,
        });
        expect(plain).not.toContain('below your minimum gain');
        expect(plain).not.toContain('profit could not be valued');
        const below = draw({ verdict: 'confirmed', mean: 0.1, se: 0.01, seeds: 8, meetsMinGain: false });
        expect(below).toContain('below your minimum gain');
        const unvalued = draw({ verdict: 'confirmed', mean: 3, se: 1, seeds: 8, profitLeftOut: true });
        expect(unvalued).toContain('profit could not be valued');
    });

    test('refused, failed and still-running states each read plainly', () => {
        const refused = triggerVerifyHtml(
            { ...result, verifyOutcome: { refused: 'nothing', rows: [] } },
            { canVerify: true }
        );
        expect(refused).toContain('Not verified: nothing to verify');
        const failed = triggerVerifyHtml(
            { ...result, verifyOutcome: { error: 'boom', rows: [] } },
            { canVerify: true }
        );
        expect(failed).toContain('Verify failed: boom');
        const running = triggerVerifyHtml(result, { canVerify: true, running: true });
        expect(running).toContain('Verifying…');
        expect(running).toContain('disabled');
    });
});

describe('verify chips and figures', () => {
    test('each verdict has its own wording, in the result unit', () => {
        const chip = (verdict, mean) => verifyChipHtml({ verdict, mean, se: 2, unit: '%', seeds: 8 });
        expect(chip('confirmed', 1.5)).toContain('✓ confirmed +1.50% ±2.00%');
        expect(chip('worse', -1.5)).toContain('✗ worse −1.50% ±2.00%');
        expect(chip('not-confirmed', 0.1)).toContain('not confirmed');
        expect(verifyChipHtml({ verdict: 'error', error: '<b>' })).toContain('&lt;b&gt;');
        expect(verifyChipHtml({ verdict: 'confirmed', mean: 1, se: 1, unit: '%', stopped: true })).toContain(
            '(stopped)'
        );
    });

    test('a row whose profit could not be valued says so, and names the unpriced items', () => {
        const chip = verifyChipHtml({
            verdict: 'not-confirmed',
            mean: null,
            se: null,
            profitLeftOut: true,
            unpriced: ['Rare Drop'],
        });
        expect(chip).toContain('profit could not be valued');
        expect(chip).toContain('Rare Drop');
        expect(verifyChipHtml({ verdict: 'confirmed', mean: 1, se: 1, unit: 'points', profitLeftOut: true })).toContain(
            'profit left out'
        );
    });

    test('gold per hour is abbreviated and a missing figure is a dash', () => {
        expect(formatVerifyFigure(1500, 'gold/hr')).toBe('+1.5K');
        expect(formatVerifyFigure(NaN, 'gold/hr')).toBe('—');
        expect(formatVerifyFigure(2, 'attempts', { signed: false })).toBe('2.00 attempts');
    });
});

describe('the Verify block on a condition-only result', () => {
    const condRow = {
        dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
        conditionHrid: '/combat_trigger_conditions/current_hp',
        comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
        value: 50,
    };
    const conditionChange = {
        key: 'abilities|1',
        slotType: 'abilities',
        itemName: 'Fireball',
        fromRows: [],
        toRows: [condRow],
        deltaScore: 5,
        se: 0.4,
    };
    const condOnly = (extra = {}) => ({
        noTunables: true,
        scope: 'me',
        changes: [],
        conditions: { changes: [conditionChange], bestMeasured: [], reliable: true, slotCount: 1 },
        verifyContext: { kind: 'combat', tunables: [], playerDTOs: [{}] },
        ...extra,
    });

    test('a recommended condition shows Verify', () => {
        const html = renderTriggerResultsHtml(condOnly(), gameData, { verify: { canVerify: true } });
        expect(html).toContain('New conditions');
        expect(html).toContain('mwi-csim-trigger-verify-btn');
    });

    test('a best-found-only condition result shows Verify too, and nothing to verify shows none', () => {
        const best = condOnly({ conditions: { changes: [], bestMeasured: [conditionChange], slotCount: 1 } });
        expect(renderTriggerResultsHtml(best, gameData, { verify: { canVerify: true } })).toContain(
            'mwi-csim-trigger-verify-btn'
        );
        const none = condOnly({ conditions: { changes: [], bestMeasured: [], slotCount: 1 } });
        expect(renderTriggerResultsHtml(none, gameData, { verify: { canVerify: true } })).not.toContain(
            'mwi-csim-trigger-verify-btn'
        );
    });

    test('a verdict renders under the condition-only result', () => {
        const row = { key: 'triggers', verdict: 'confirmed', mean: 4.2, se: 0.9, seeds: 8, meetsMinGain: true };
        const html = renderTriggerResultsHtml(
            condOnly({ verifyOutcome: { unit: 'points', basis: 'recommended', rows: [row] } }),
            gameData,
            { verify: { canVerify: true } }
        );
        expect(html).toContain('data-verify-chip="confirmed"');
        expect(html).toContain('recommended changes');
    });

    test('a remembered condition-only result says to re-run to verify', () => {
        const html = renderTriggerResultsHtml(condOnly({ verifyContext: undefined }), gameData, {
            cached: true,
            verify: { canVerify: false },
        });
        expect(html).toContain('re-run to verify');
        expect(html).not.toContain('mwi-csim-trigger-verify-btn');
    });

    test('without the verify option nothing is added', () => {
        expect(renderTriggerResultsHtml(condOnly(), gameData)).not.toContain('mwi-csim-trigger-verify');
    });
});
