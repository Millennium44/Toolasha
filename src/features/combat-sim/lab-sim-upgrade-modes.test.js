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
    estimateLabUpgradeSims,
    LAB_HEAVY_RUN_SIMS,
    LAB_LEVEL_SOURCE_KEYS,
    DEFAULT_CONFIGURE_LEVEL,
    defaultLabLevelSource,
    sanitizeLabLevelSource,
    resolveLabTargetLevel,
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
            dimensions: ['equipment', 'labyrinth_buff'],
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
        const restored = sanitizeLabUpgradeSelection(['equipment', 'equipment', 'moon_phase', 'drink'], null);
        expect(restored.dimensions).toEqual(['equipment']);
    });

    test('an all-unknown selection falls back rather than leaving nothing checked', () => {
        expect(sanitizeLabUpgradeSelection(['moon_phase'], null).dimensions).toEqual(['equipment', 'labyrinth_buff']);
    });

    test('junk in the scope slot is not a scope', () => {
        expect(sanitizeLabUpgradeSelection(null, { mode: 'everywhere', monsters: [1, '/monsters/a'] })).toEqual({
            dimensions: ['equipment', 'labyrinth_buff'],
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

describe('what a scope can be asked', () => {
    test('every set is offered for a single fight', () => {
        const availability = labDimensionAvailability('current', 1);
        for (const key of LAB_UPGRADE_DIMENSION_KEYS) {
            expect(availability[key].enabled).toBe(true);
        }
    });

    test('and every set but the community buffs is offered across a whole labyrinth too', () => {
        // Ability Swaps used to be refused here on size — thousands of sims —
        // which put the refusal on the one scope where "which ability should I
        // change" is most worth asking. Size is handled by shortening the sims
        // and saying the count, not by declining the question.
        const availability = labDimensionAvailability('all', 8);
        for (const key of LAB_UPGRADE_DIMENSION_KEYS) {
            if (key === 'community_buff') continue;
            expect(availability[key].enabled).toBe(true);
            expect(availability[key].reason).toBe('');
        }
    });

    test('token buffs reach a whole run — the applier was the blocker, not the scope', () => {
        for (const scope of ['current', 'all', 'selected']) {
            expect(labDimensionAvailability(scope, 8).labyrinth_buff).toEqual({ enabled: true, reason: '' });
        }
    });

    test('community buffs are the one set a whole run declines, and it says why', () => {
        expect(labDimensionAvailability('current', 1).community_buff).toEqual({ enabled: true, reason: '' });
        for (const scope of ['all', 'selected']) {
            const rule = labDimensionAvailability(scope, 8).community_buff;
            expect(rule.enabled).toBe(false);
            expect(rule.reason).toMatch(/expected attempts/);
        }
    });

    test('house rooms included — the shared applier installs a room level now', () => {
        // The refusal was never about the scope: the whole-run analysis could
        // not install a room level at all. It can, and a room level being
        // character-wide is what makes the multi-fight question interesting.
        expect(labDimensionAvailability('all', 8).house).toEqual({ enabled: true, reason: '' });
        expect(labDimensionAvailability('selected', 1).house.enabled).toBe(true);
        expect(labDimensionAvailability('current', 1).house.enabled).toBe(true);
    });

    test('the per-ability target level is only meaningful for one loadout', () => {
        expect(labAbilityLevelTypeAvailability('current', 1).enabled).toBe(true);
        const multi = labAbilityLevelTypeAvailability('all', 4);
        expect(multi.enabled).toBe(false);
        expect(multi.reason).toMatch(/uniform/);
    });
});

describe('how big a run the checkboxes are asking for', () => {
    test('a single fight of equipment is a run nobody needs warning about', () => {
        const estimate = estimateLabUpgradeSims(['equipment'], 1);
        expect(estimate.heavy).toBe(false);
        expect(estimate.text).toContain('1 fight');
    });

    test('swaps across a full labyrinth no longer are, since the guide narrowed them', () => {
        // This used to be the heaviest thing the tab could be asked for: every
        // style-compatible ability in every slot, in every room. The build
        // guide cut the offers to one archetype's own set, and a whole
        // labyrinth of them now fits under the bar that triggers the warning
        const estimate = estimateLabUpgradeSims(['ability_swap'], 12);
        expect(estimate.heavy).toBe(false);
        expect(estimate.sims).toBeLessThan(LAB_HEAVY_RUN_SIMS);
        // The number is rounded, because it is an estimate and printing 1,043
        // would claim a precision it has not got
        expect(estimate.text).toMatch(/about [\d,]+ simulations \(12 fights\)/);
    });

    test('a run big enough to warn about still says so', () => {
        // Equipment is now the expensive set, and the warning still fires for
        // the shape that earns it
        const estimate = estimateLabUpgradeSims(['equipment', 'ability_swap'], 12);
        expect(estimate.heavy).toBe(true);
        expect(estimate.sims).toBeGreaterThan(LAB_HEAVY_RUN_SIMS);
    });

    test('more fights and more sets is more work, monotonically', () => {
        const one = estimateLabUpgradeSims(['equipment'], 4).sims;
        const two = estimateLabUpgradeSims(['equipment', 'ability_swap'], 4).sims;
        expect(two).toBeGreaterThan(one);
        expect(estimateLabUpgradeSims(['equipment'], 8).sims).toBeGreaterThan(one);
    });

    test('a set this version does not have counts for nothing rather than NaN', () => {
        expect(estimateLabUpgradeSims(['equipment', 'moon_phase'], 2).sims).toBe(
            estimateLabUpgradeSims(['equipment'], 2).sims
        );
        expect(estimateLabUpgradeSims(null, 0).sims).toBe(0);
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
        expect(plan.extraModes.sort()).toEqual([
            'ability_swap',
            'combat_level',
            'community_buff',
            'guild_shrine',
            'house',
        ]);
    });

    test('token buffs never become a mode — the single-fight analysis generates them itself', () => {
        // `generateCandidates` has no `labyrinth_buff` branch, so handing it the
        // key would ask for a set and get an empty list back, while the analysis
        // went on ranking the token buffs it always ranks
        expect(planLabSingleTargetModes(['equipment', 'labyrinth_buff'])).toEqual({
            upgradeMode: 'equipment',
            extraModes: [],
        });
        expect(planLabSingleTargetModes(['labyrinth_buff'])).toEqual({ upgradeMode: 'none', extraModes: [] });
    });

    test('nothing left for the analysis to generate is not a quiet fallback to equipment', () => {
        // Reached when the only thing checked is measured in a pass of its own.
        // `equipment` here used to rank a table of gear nobody asked about.
        expect(planLabSingleTargetModes([])).toEqual({ upgradeMode: 'none', extraModes: [] });
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

    test('ability swaps ride along across every target rather than being dropped', () => {
        const plan = planLabUpgradeRun({
            dimensions: ['equipment', 'ability_swap'],
            scopeMode: 'all',
            allMonsters: ALL,
        });
        expect(plan.kind).toBe('allFights');
        expect(plan.modes).toEqual(['equipment', 'ability_swap']);
        expect(plan.dropped).toEqual([]);
    });

    test('and a selection of nothing but swaps is a run, not a refusal', () => {
        const plan = planLabUpgradeRun({ dimensions: ['ability_swap'], scopeMode: 'all', allMonsters: ALL });
        expect(plan).toMatchObject({ kind: 'allFights', modes: ['ability_swap'], monsterHrids: ALL });
    });

    test('house rooms ride along with everything else rather than being asked for separately', () => {
        // They used to be pulled out into a `standaloneModes` list, because the
        // shared applier had no branch for a room level and would have installed
        // the candidate as a piece of equipment in a slot called
        // `house|/house_rooms/…` — changing nothing, and reading +0.00%
        const plan = planLabUpgradeRun({
            dimensions: ['equipment', 'house'],
            scopeMode: 'current',
            configureMonsterHrid: '/monsters/b',
            allMonsters: ALL,
        });
        expect(plan).toMatchObject({
            kind: 'single',
            upgradeMode: 'equipment',
            extraModes: ['house'],
        });
        expect(plan.standaloneModes).toBeUndefined();
    });

    test('house rooms on their own are the whole run rather than nothing for it to generate', () => {
        const plan = planLabUpgradeRun({
            dimensions: ['house'],
            scopeMode: 'current',
            configureMonsterHrid: '/monsters/b',
            allMonsters: ALL,
        });
        expect(plan).toMatchObject({ kind: 'single', upgradeMode: 'house', extraModes: [] });
    });

    test('and across several fights they are weighed rather than dropped', () => {
        // The whole-run question — one room level, measured against each fight
        // it changes — is the one this used to refuse
        const plan = planLabUpgradeRun({
            dimensions: ['equipment', 'house'],
            scopeMode: 'all',
            allMonsters: ALL,
        });
        expect(plan).toMatchObject({ kind: 'allFights', modes: ['equipment', 'house'], dropped: [] });
    });

    test('all targets with no fights resolving explains itself', () => {
        const plan = planLabUpgradeRun({ dimensions: ['equipment'], scopeMode: 'all', allMonsters: [] });
        expect(plan.kind).toBe('none');
        expect(plan.error).toMatch(/skip levels/);
    });
});

describe('where the Configure fight takes its level from', () => {
    test('the three levels a fight actually has, and no others', () => {
        expect(LAB_LEVEL_SOURCE_KEYS).toEqual(['sim_max', 'skip', 'configure']);
    });

    test('a Level box sitting on its default is not a request for that level', () => {
        expect(defaultLabLevelSource(DEFAULT_CONFIGURE_LEVEL)).toBe('sim_max');
        expect(defaultLabLevelSource(0)).toBe('sim_max');
        expect(defaultLabLevelSource(NaN)).toBe('sim_max');
    });

    test('but a box holding anything else was typed into, and the typed number wins', () => {
        expect(defaultLabLevelSource(232)).toBe('configure');
        expect(defaultLabLevelSource(20)).toBe('configure');
    });

    test('a stored choice is kept, and anything else falls to the rule', () => {
        expect(sanitizeLabLevelSource('skip', 100)).toBe('skip');
        expect(sanitizeLabLevelSource('moon_phase', 100)).toBe('sim_max');
        expect(sanitizeLabLevelSource(null, 232)).toBe('configure');
    });
});

describe('a level source, resolved into a level', () => {
    const at = (over) => resolveLabTargetLevel({ simMaxLevel: 232, skipLevel: 130, configureLevel: 100, ...over });

    test('each source comes to its own number, labelled with it', () => {
        expect(at({ source: 'sim_max' })).toMatchObject({ level: 232, usedSource: 'sim_max', label: 'Sim max (L232)' });
        expect(at({ source: 'skip' })).toMatchObject({ level: 130, label: 'Skip level (L130)' });
        expect(at({ source: 'configure' })).toMatchObject({ level: 100, label: 'Configure value (L100)' });
    });

    test('a sim max nothing has searched for yet falls through to the skip level', () => {
        expect(at({ source: 'sim_max', simMaxLevel: 0 })).toMatchObject({
            level: 130,
            usedSource: 'skip',
            fellBack: true,
        });
    });

    test('and with no skip threshold either, to the box that always holds something', () => {
        expect(at({ source: 'sim_max', simMaxLevel: 0, skipLevel: 0 })).toMatchObject({
            level: 100,
            usedSource: 'configure',
            fellBack: true,
        });
    });

    test('nothing at all is not a level, and says so rather than offering zero', () => {
        const resolved = resolveLabTargetLevel({ source: 'sim_max' });
        expect(resolved.level).toBe(0);
        expect(resolved.label).toMatch(/not resolved/);
    });

    test('an unknown source is read as the box, which is where this started', () => {
        expect(at({ source: 'moon_phase' })).toMatchObject({ level: 100, usedSource: 'configure', fellBack: false });
    });

    test('a source that produced its own number never reports a fallback', () => {
        expect(at({ source: 'skip' }).fellBack).toBe(false);
    });
});
