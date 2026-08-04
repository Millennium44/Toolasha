/**
 * What the Upgrade tab's checkboxes come to.
 *
 * The tab used to be one dropdown whose entries were the cross-product of "what
 * kind of upgrade" and "which fights", with most of the cross missing. These
 * tests are about the replacement mapping: that every old entry still has a
 * selection meaning the same thing, that a multi-set selection reaches the
 * single-fight analysis (which only takes one mode) without losing sets, and
 * that a set a scope cannot answer is reported rather than dropped in silence.
 */

import { describe, test, expect } from 'vitest';

import {
    LAB_UPGRADE_DIMENSION_KEYS,
    defaultLabUpgradeSelection,
    migrateLegacyLabUpgradeMode,
    sanitizeLabUpgradeSelection,
    labScopeTargetCount,
    labDimensionAvailability,
    labAbilityLevelTypeAvailability,
    planLabSingleTargetModes,
    planLabUpgradeRun,
} from './lab-sim-upgrade-modes.js';

const ALL = ['/monsters/a', '/monsters/b', '/monsters/c'];

describe('the retired Mode dropdown, as a selection', () => {
    test.each([
        ['equipment', ['equipment'], 'current'],
        ['ability_level', ['ability_level'], 'current'],
        ['ability_swap', ['ability_swap'], 'current'],
        ['combined', ['equipment', 'ability_level'], 'current'],
        ['guild_shrine', ['guild_shrine'], 'current'],
        ['combat_level', ['combat_level'], 'current'],
        ['combat_level_all', ['combat_level'], 'all'],
    ])('%s becomes %j at %s scope', (mode, dimensions, scopeMode) => {
        expect(migrateLegacyLabUpgradeMode(mode)).toEqual({ dimensions, scopeMode });
    });

    test('"Everything — All Fights" was only ever every set across every fight', () => {
        expect(migrateLegacyLabUpgradeMode('everything_all')).toEqual({
            dimensions: ['equipment', 'ability_level', 'combat_level'],
            scopeMode: 'all',
        });
    });

    test('a mode nobody recognises is not a selection', () => {
        expect(migrateLegacyLabUpgradeMode('sideways')).toBeNull();
    });
});

describe('reading a saved selection back', () => {
    test('nothing saved opens where the old dropdown opened', () => {
        expect(sanitizeLabUpgradeSelection(null, null)).toEqual({
            dimensions: ['equipment'],
            scopeMode: 'current',
            monsters: [],
        });
        expect(defaultLabUpgradeSelection().scopeMode).toBe('current');
    });

    test('a legacy mode string in the dimensions slot is migrated, not discarded', () => {
        expect(sanitizeLabUpgradeSelection('everything_all', null)).toEqual({
            dimensions: ['equipment', 'ability_level', 'combat_level'],
            scopeMode: 'all',
            monsters: [],
        });
    });

    test('an explicit scope wins over the one a migration implied', () => {
        const restored = sanitizeLabUpgradeSelection(['combat_level'], { mode: 'selected', monsters: ALL.slice(0, 2) });
        expect(restored).toEqual({ dimensions: ['combat_level'], scopeMode: 'selected', monsters: ALL.slice(0, 2) });
    });

    test('keys this version does not have are dropped, and duplicates collapse', () => {
        const restored = sanitizeLabUpgradeSelection(['equipment', 'equipment', 'house', 'drink'], null);
        expect(restored.dimensions).toEqual(['equipment']);
    });

    test('an all-unknown selection falls back rather than leaving nothing checked', () => {
        expect(sanitizeLabUpgradeSelection(['house'], null).dimensions).toEqual(['equipment']);
    });

    test('junk in the scope slot is not a scope', () => {
        expect(sanitizeLabUpgradeSelection(null, { mode: 'everywhere', monsters: [1, '/monsters/a'] })).toEqual({
            dimensions: ['equipment'],
            scopeMode: 'current',
            monsters: ['/monsters/a'],
        });
    });
});

describe('how many fights a scope is', () => {
    test('the Configure fight is one, whatever the labyrinth holds', () => {
        expect(labScopeTargetCount('current', 8, 5)).toBe(1);
    });

    test('all targets is however many resolve', () => {
        expect(labScopeTargetCount('all', 8, 5)).toBe(8);
    });

    test('a subset is what is ticked', () => {
        expect(labScopeTargetCount('selected', 8, 5)).toBe(5);
    });
});

describe('sets a scope genuinely cannot answer', () => {
    test('every set is offered for a single fight', () => {
        const availability = labDimensionAvailability('current', 1);
        for (const key of LAB_UPGRADE_DIMENSION_KEYS) {
            expect(availability[key].enabled).toBe(true);
        }
    });

    test('ability swaps are not offered across several fights, and say why', () => {
        const availability = labDimensionAvailability('all', 8);
        expect(availability.ability_swap.enabled).toBe(false);
        expect(availability.ability_swap.reason).toMatch(/single target|Configure fight/);
        // and nothing else is collateral damage
        expect(availability.equipment.enabled).toBe(true);
        expect(availability.combat_level.enabled).toBe(true);
        expect(availability.guild_shrine.enabled).toBe(true);
    });

    test('a subset of exactly one fight is a single fight', () => {
        expect(labDimensionAvailability('selected', 1).ability_swap.enabled).toBe(true);
    });

    test('the per-ability target level is only meaningful for one loadout', () => {
        expect(labAbilityLevelTypeAvailability('current', 1).enabled).toBe(true);
        const multi = labAbilityLevelTypeAvailability('all', 4);
        expect(multi.enabled).toBe(false);
        expect(multi.reason).toMatch(/uniform/);
    });
});

describe('a multi-set selection through the single-fight analysis', () => {
    test('equipment and ability levels is the mode that already meant both', () => {
        expect(planLabSingleTargetModes(['equipment', 'ability_level'])).toEqual({
            upgradeMode: 'combined',
            extraModes: [],
        });
    });

    test('anything else rides along as extra candidates', () => {
        expect(planLabSingleTargetModes(['equipment', 'guild_shrine'])).toEqual({
            upgradeMode: 'equipment',
            extraModes: ['guild_shrine'],
        });
    });

    test('equipment leads whenever it is checked, so the labyrinth armor sets still get generated', () => {
        expect(planLabSingleTargetModes(['guild_shrine', 'combat_level', 'equipment'])).toEqual({
            upgradeMode: 'equipment',
            extraModes: ['guild_shrine', 'combat_level'],
        });
    });

    test('everything checked keeps every set', () => {
        const plan = planLabSingleTargetModes(LAB_UPGRADE_DIMENSION_KEYS);
        expect(plan.upgradeMode).toBe('combined');
        expect(plan.extraModes.sort()).toEqual(['ability_swap', 'combat_level', 'guild_shrine']);
    });

    test('without equipment the first checked set leads', () => {
        expect(planLabSingleTargetModes(['combat_level', 'guild_shrine'])).toEqual({
            upgradeMode: 'combat_level',
            extraModes: ['guild_shrine'],
        });
    });
});

describe('a selection, resolved into the analysis to run', () => {
    test('nothing checked is not a run', () => {
        const plan = planLabUpgradeRun({ dimensions: [], allMonsters: ALL });
        expect(plan.kind).toBe('none');
        expect(plan.error).toMatch(/at least one upgrade type/);
    });

    test('the Configure scope runs the single-fight analysis on that monster', () => {
        const plan = planLabUpgradeRun({
            dimensions: ['equipment', 'ability_level'],
            scopeMode: 'current',
            configureMonsterHrid: '/monsters/b',
            allMonsters: ALL,
        });
        expect(plan).toMatchObject({
            kind: 'single',
            monsterHrids: ['/monsters/b'],
            upgradeMode: 'combined',
            extraModes: [],
        });
    });

    test('the Configure scope with no monster set says so rather than simming nothing', () => {
        const plan = planLabUpgradeRun({ dimensions: ['equipment'], scopeMode: 'current', allMonsters: ALL });
        expect(plan.kind).toBe('none');
        expect(plan.error).toMatch(/Configure tab/);
    });

    test('all targets walks every fight with every checked set', () => {
        const plan = planLabUpgradeRun({
            dimensions: ['equipment', 'combat_level'],
            scopeMode: 'all',
            allMonsters: ALL,
        });
        expect(plan).toMatchObject({ kind: 'allFights', monsterHrids: ALL, modes: ['equipment', 'combat_level'] });
    });

    test('a subset keeps the labyrinth order, not the click order', () => {
        const plan = planLabUpgradeRun({
            dimensions: ['equipment'],
            scopeMode: 'selected',
            chosenMonsters: ['/monsters/c', '/monsters/a'],
            allMonsters: ALL,
        });
        expect(plan.monsterHrids).toEqual(['/monsters/a', '/monsters/c']);
    });

    test('a subset of one is still the multi-fight walk, with its assigned loadout', () => {
        const plan = planLabUpgradeRun({
            dimensions: ['ability_swap'],
            scopeMode: 'selected',
            chosenMonsters: ['/monsters/a'],
            allMonsters: ALL,
        });
        expect(plan).toMatchObject({ kind: 'allFights', monsterHrids: ['/monsters/a'], modes: ['ability_swap'] });
    });

    test('a subset with nothing ticked asks for a tick rather than running everything', () => {
        const plan = planLabUpgradeRun({ dimensions: ['equipment'], scopeMode: 'selected', allMonsters: ALL });
        expect(plan.kind).toBe('none');
        expect(plan.error).toMatch(/at least one target/);
    });

    test('a set the scope cannot answer is reported, and the rest still run', () => {
        const plan = planLabUpgradeRun({
            dimensions: ['equipment', 'ability_swap'],
            scopeMode: 'all',
            allMonsters: ALL,
        });
        expect(plan.kind).toBe('allFights');
        expect(plan.modes).toEqual(['equipment']);
        expect(plan.dropped).toEqual(['ability_swap']);
    });

    test('a selection that is nothing but an unavailable set does not quietly run empty', () => {
        const plan = planLabUpgradeRun({ dimensions: ['ability_swap'], scopeMode: 'all', allMonsters: ALL });
        expect(plan.kind).toBe('none');
        expect(plan.error).toMatch(/unavailable for this target scope/);
    });

    test('all targets with no fights resolving explains itself', () => {
        const plan = planLabUpgradeRun({ dimensions: ['equipment'], scopeMode: 'all', allMonsters: [] });
        expect(plan.kind).toBe('none');
        expect(plan.error).toMatch(/skip levels/);
    });
});
