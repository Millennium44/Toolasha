/**
 * Lab Sim upgrade selection
 *
 * The Upgrade tab used to be one `Mode` dropdown, which forced two unrelated
 * questions through a single control: *what kind of upgrade* am I weighing
 * (gear, ability levels, combat levels, shrines) and *which fights* am I
 * weighing it for. Options like "Combat Levels — All Fights" and "Everything —
 * All Fights" were the cross-product leaking into the menu, and the cross had
 * holes in it — there was no way to ask for equipment across all fights, or for
 * shrines across the three rooms that are actually giving you trouble.
 *
 * So the two questions are separated here. A selection is a set of *dimensions*
 * (multi-select, exactly like the combat sim panel's Upgrade tab) and a *target
 * scope* (the Configure tab's fight, every fight, or a chosen subset). This
 * module owns the vocabulary, the migration from the old mode strings, the
 * handful of places where a dimension genuinely cannot be asked of a scope, and
 * the translation from a selection into the arguments the existing analysis
 * functions take.
 *
 * Kept free of the DOM and of the analysis itself so the mapping can be tested
 * as the arithmetic it is.
 */

/**
 * Candidate sets the Upgrade tab can include, in the order they are drawn.
 *
 * Deliberately the same keys `generateCandidates` takes, so a selection is
 * passed through rather than translated.
 */
export const LAB_UPGRADE_DIMENSIONS = [
    {
        key: 'equipment',
        label: 'Equipment',
        defaultOn: true,
        title: 'Enhancement breakpoints and tier swaps for every combat slot, plus the labyrinth armor sets',
    },
    {
        key: 'ability_level',
        label: 'Ability Lv',
        defaultOn: false,
        title: 'Leveling the abilities this loadout already has slotted',
    },
    {
        key: 'ability_swap',
        label: 'Ability Swaps',
        defaultOn: false,
        title:
            'Replacing a slotted ability with a different one.\n\n' +
            'Slow and rough: it sims every style-compatible ability for every slot, and a swapped-in ability is ' +
            'simmed at the level of the one it replaces with default triggers. Treat it as a hint about what to ' +
            'try by hand rather than a verdict.\n\n' +
            'Across several fights a swap is only weighed in the loadouts that actually cast the ability it ' +
            'replaces, and a big run shortens each simulation rather than leaving fights out — the status line ' +
            'says how many simulations it comes to before it starts.',
    },
    {
        key: 'house',
        label: 'House Rooms',
        defaultOn: false,
        title:
            'One more level on each house room the combat engine actually reads — the rooms whose buffs are ' +
            'combat stats (damage, armor, accuracy, evasion, resistances, crit, tenacity, life steal and the ' +
            'rest), plus any room the game itself tags as usable in combat.\n\n' +
            'Cost is the build cost of that one level: the coins at face value plus the materials at their ' +
            'buy price. Ranked on the same win rate and Gold/1% as every other row.',
    },
    {
        key: 'combat_level',
        label: 'Combat Lv',
        defaultOn: false,
        title: 'Raising combat skill levels. Levels cost grind time rather than gold, so read these rows on their delta rather than on cost.',
    },
    {
        key: 'guild_shrine',
        label: 'Guild Shrine',
        defaultOn: false,
        title:
            'One level on each combat guild shrine buff.\n\n' +
            'Cost covers the guild credits plus the tokens, the tokens priced through the guild shop ' +
            'token→credit exchange when a rate is known; without one, credits only.',
    },
];

/** Every dimension key, for validating what came back from storage. */
export const LAB_UPGRADE_DIMENSION_KEYS = LAB_UPGRADE_DIMENSIONS.map((d) => d.key);

/**
 * Dimensions the shared analysis cannot generate for itself, and which the panel
 * therefore measures in a pass of its own.
 *
 * House rooms are the only one. A room level lives on the character rather than
 * in a loadout, and the candidate applier the labyrinth analyses share installs
 * equipment, abilities, skill levels, shrines and drinks — but not a room level,
 * so a house candidate handed to it would be simulated as no change at all and
 * come back at a confident +0.00%. Keeping them out of the mode lists here is
 * what stops that row from ever being drawn.
 */
export const LAB_STANDALONE_DIMENSIONS = new Set(['house']);

/**
 * How many fights an analysis is about.
 *
 * `current` is the fight the Configure tab is set up for, edited loadout and
 * all — the only scope that can use the single-fight analysis, which is the
 * richer of the two (it prices each candidate, ranks the labyrinth token buffs
 * beside them, and feeds the budget planner). The other two walk the labyrinth's
 * own fight list, each room with its assigned loadout at its skip-derived level.
 */
export const LAB_SCOPES = [
    {
        key: 'current',
        label: 'Configure fight',
        title: 'The monster, room level and edited loadout set up on the Configure tab. The only scope that also ranks labyrinth token buffs and can feed the budget planner.',
    },
    {
        key: 'all',
        label: 'All targets',
        title: 'Every labyrinth combat room with a resolvable level, each wearing its assigned loadout',
    },
    {
        key: 'selected',
        label: 'Chosen targets…',
        title: 'Pick the rooms to weigh — leave out the ones you already clear comfortably',
    },
];

/** Scope keys, for validating what came back from storage. */
export const LAB_SCOPE_KEYS = LAB_SCOPES.map((s) => s.key);

/**
 * The old `Mode` dropdown values, as a dimension set plus a scope.
 *
 * Users who had a mode selected should land on the equivalent selection rather
 * than on an empty one. `everything_all` was never anything but
 * all-dimensions-that-existed × all-targets, which is what it becomes.
 */
const LEGACY_MODE_MAP = {
    equipment: { dimensions: ['equipment'], scopeMode: 'current' },
    ability_level: { dimensions: ['ability_level'], scopeMode: 'current' },
    ability_swap: { dimensions: ['ability_swap'], scopeMode: 'current' },
    combined: { dimensions: ['equipment', 'ability_level'], scopeMode: 'current' },
    guild_shrine: { dimensions: ['guild_shrine'], scopeMode: 'current' },
    combat_level: { dimensions: ['combat_level'], scopeMode: 'current' },
    combat_level_all: { dimensions: ['combat_level'], scopeMode: 'all' },
    everything_all: { dimensions: ['equipment', 'ability_level', 'combat_level'], scopeMode: 'all' },
};

/**
 * The selection an old mode string stands for.
 * @param {string} mode - A value from the retired `Mode` dropdown
 * @returns {{dimensions: string[], scopeMode: string}|null} Null when unrecognised
 */
export function migrateLegacyLabUpgradeMode(mode) {
    const mapped = LEGACY_MODE_MAP[mode];
    return mapped ? { dimensions: [...mapped.dimensions], scopeMode: mapped.scopeMode } : null;
}

/**
 * The selection to start from when nothing has been saved: what the old
 * dropdown opened on.
 * @returns {{dimensions: string[], scopeMode: string}}
 */
export function defaultLabUpgradeSelection() {
    return {
        dimensions: LAB_UPGRADE_DIMENSIONS.filter((d) => d.defaultOn).map((d) => d.key),
        scopeMode: 'current',
    };
}

/**
 * Whatever came back from storage, made into a selection.
 * @param {*} rawDimensions - Stored dimension array, or a legacy mode string
 * @param {*} rawScope - Stored `{ mode, monsters }`
 * @returns {{dimensions: string[], scopeMode: string, monsters: string[]}}
 */
export function sanitizeLabUpgradeSelection(rawDimensions, rawScope) {
    const fallback = defaultLabUpgradeSelection();

    let dimensions = null;
    let scopeMode = null;

    if (typeof rawDimensions === 'string') {
        const migrated = migrateLegacyLabUpgradeMode(rawDimensions);
        if (migrated) {
            dimensions = migrated.dimensions;
            scopeMode = migrated.scopeMode;
        }
    } else if (Array.isArray(rawDimensions)) {
        const kept = rawDimensions.filter((key) => LAB_UPGRADE_DIMENSION_KEYS.includes(key));
        if (kept.length) dimensions = [...new Set(kept)];
    }

    const rawMode = rawScope && typeof rawScope === 'object' ? rawScope.mode : rawScope;
    if (typeof rawMode === 'string' && LAB_SCOPE_KEYS.includes(rawMode)) scopeMode = rawMode;

    const monsters =
        rawScope && Array.isArray(rawScope.monsters) ? rawScope.monsters.filter((h) => typeof h === 'string') : [];

    return {
        dimensions: dimensions || fallback.dimensions,
        scopeMode: scopeMode || fallback.scopeMode,
        monsters,
    };
}

/**
 * How many fights a scope resolves to, for the availability rules below.
 * @param {string} scopeMode
 * @param {number} allCount - How many labyrinth fights exist
 * @param {number} chosenCount - How many are ticked in the subset list
 * @returns {number}
 */
export function labScopeTargetCount(scopeMode, allCount, chosenCount) {
    if (scopeMode === 'all') return Math.max(0, allCount);
    if (scopeMode === 'selected') return Math.max(0, chosenCount);
    return 1;
}

/**
 * Which dimensions can be asked of a given scope, and why not when they cannot.
 *
 * Nothing is off the table any more. Ability Swaps used to be refused for a
 * multi-fight scope on the grounds that a hundred-odd candidates times a full
 * labyrinth is thousands of simulations — which was true, and still the wrong
 * answer: the question "which ability should I change" is a question about the
 * whole run, and refusing it for the whole run left the one scope where it
 * mattered least. The size is handled where size belongs instead — swaps are
 * only weighed in the loadouts that cast the ability they replace, the trial
 * budget per fight shrinks on a big run, and `estimateLabUpgradeSims` puts the
 * count in front of the player before anything starts. Fights are never sampled.
 *
 * House rooms are the one entry that still has a rule, and it is a genuine
 * limit rather than a size worry: the whole-run analysis installs each candidate
 * into each fight's own loadout, and a room level is not something a loadout
 * carries — so across several fights there is nowhere for it to land.
 *
 * Keyed on the scope rather than on how many fights it came to: a subset of one
 * is still the whole-run analysis, so "one fight" is not the question — "is this
 * the Configure fight" is.
 *
 * @param {string} scopeMode - `current` | `all` | `selected`
 * @param {number} _targetCount - From `labScopeTargetCount`
 * @returns {Object<string, {enabled: boolean, reason: string}>} Keyed by dimension
 */
export function labDimensionAvailability(scopeMode, _targetCount) {
    const availability = {};
    for (const dimension of LAB_UPGRADE_DIMENSIONS) {
        availability[dimension.key] = { enabled: true, reason: '' };
    }
    if (scopeMode !== 'current') {
        availability.house = {
            enabled: false,
            reason: 'House rooms are weighed for the Configure fight only — the whole-run analysis installs each candidate into a fight’s loadout, and a room level is not part of a loadout.',
        };
    }
    return availability;
}

/**
 * Roughly how many simulations one fight contributes, per dimension.
 *
 * Deliberately an order-of-magnitude figure rather than a computed one: the
 * exact number needs every fight's loadout, the whole item map and the ability
 * map, and the point of this estimate is to be available *before* any of that
 * is loaded, while the player still has a hand on the Analyze button. The
 * analysis reports its own exact count the moment it has pooled its candidates,
 * and the status line is overwritten with it.
 *
 * Per *fight* rather than per candidate, because that is the shape the analysis
 * has: each candidate is simmed only against the fights it is about, so a
 * loadout-specific dimension contributes roughly its own candidate count to its
 * own fight, and a character-wide one contributes its candidate count to every
 * fight.
 */
export const LAB_DIMENSION_SIMS_PER_FIGHT = {
    // Two-ish per combat slot, plus the forced labyrinth armor sets, plus what
    // other loadouts contribute that this one can also wear
    equipment: 60,
    ability_level: 6,
    // Every style-compatible ability in every slot, weighed in the loadouts
    // that cast the ability it replaces
    ability_swap: 100,
    // One per combat skill, and a combat level is every fight
    combat_level: 6,
    guild_shrine: 6,
    // One per combat-relevant room, plus the pass's own baseline
    house: 12,
};

/** Sims above which a run is worth warning about before it starts */
export const LAB_HEAVY_RUN_SIMS = 400;

/**
 * About how much work the checked selection comes to.
 *
 * @param {string[]} dimensions - Checked dimension keys
 * @param {number} targetCount - From `labScopeTargetCount`
 * @returns {{sims: number, heavy: boolean, text: string}} `text` is the phrase
 *   for the status line, already rounded to something honest about its precision
 */
export function estimateLabUpgradeSims(dimensions, targetCount) {
    const fights = Math.max(0, Math.floor(targetCount) || 0);
    const perFight = (dimensions || [])
        .filter((key) => LAB_UPGRADE_DIMENSION_KEYS.includes(key))
        .reduce((sum, key) => sum + (LAB_DIMENSION_SIMS_PER_FIGHT[key] || 0), 0);
    // The baseline pass is one sim per fight on top of the candidate passes
    const sims = fights * (perFight + 1);
    // Two significant figures: a number like 1,043 would claim a precision this
    // estimate has not got
    const rounded = sims >= 100 ? Math.round(sims / 100) * 100 : Math.round(sims / 10) * 10;
    return {
        sims,
        heavy: sims > LAB_HEAVY_RUN_SIMS,
        text: `about ${rounded.toLocaleString()} simulations (${fights} fight${fights === 1 ? '' : 's'})`,
    };
}

/**
 * Whether the per-ability "Target Lv" mode can be honoured.
 *
 * The multi-fight analysis fixes the ability level rule to a uniform increment,
 * because a target level means something different in each loadout. Saying so
 * beats quietly running an increment when a target was asked for.
 * @param {string} scopeMode
 * @param {number} targetCount
 * @returns {{enabled: boolean, reason: string}}
 */
export function labAbilityLevelTypeAvailability(scopeMode, targetCount) {
    if (targetCount > 1) {
        return {
            enabled: false,
            reason: 'Across several fights, ability levels are always weighed as a uniform +N boost — a target level would mean a different boost in every loadout.',
        };
    }
    return { enabled: true, reason: '' };
}

/**
 * Split a dimension set into the single-fight analysis's arguments.
 *
 * `runLabyrinthUpgradeAnalysis` takes one mode, plus `combined` as the special
 * case for equipment-and-abilities, plus a list of extra candidates it ranks
 * beside whatever the mode generated. So a multi-dimension selection is one
 * mode — chosen so the equipment path keeps its forced labyrinth armor
 * candidates — and the rest generated by the caller and handed over as extras.
 *
 * @param {string[]} dimensions - Checked dimension keys
 * @returns {{upgradeMode: string, extraModes: string[]}}
 */
export function planLabSingleTargetModes(dimensions) {
    const dims = [...new Set((dimensions || []).filter((key) => LAB_UPGRADE_DIMENSION_KEYS.includes(key)))];
    // Nothing for the analysis to generate — which happens when the only thing
    // checked is measured in a pass of its own. `none` matches no branch in the
    // generator, so it produces an empty candidate list rather than quietly
    // falling back to equipment and ranking gear nobody asked about.
    if (!dims.length) return { upgradeMode: 'none', extraModes: [] };

    if (dims.includes('equipment') && dims.includes('ability_level')) {
        return {
            upgradeMode: 'combined',
            extraModes: dims.filter((key) => key !== 'equipment' && key !== 'ability_level'),
        };
    }

    // Equipment first when it is in, so the forced labyrinth armor candidates —
    // which only the `equipment` branch adds — are still generated
    const primary = dims.includes('equipment') ? 'equipment' : dims[0];
    return { upgradeMode: primary, extraModes: dims.filter((key) => key !== primary) };
}

/**
 * Turn a selection into the analysis to run.
 *
 * @param {Object} params
 * @param {string[]} params.dimensions - Checked dimensions
 * @param {string} params.scopeMode - `current` | `all` | `selected`
 * @param {string[]} [params.chosenMonsters] - Ticked monsters, for `selected`
 * @param {string[]} [params.allMonsters] - Every labyrinth fight's monster hrid
 * @param {string} [params.configureMonsterHrid] - The Configure tab's monster
 * @returns {Object} `{ kind, error, monsterHrids, dropped, upgradeMode, extraModes, modes }`
 *   where `kind` is `single`, `allFights` or `none`
 */
export function planLabUpgradeRun({
    dimensions = [],
    scopeMode = 'current',
    chosenMonsters = [],
    allMonsters = [],
    configureMonsterHrid = '',
} = {}) {
    const targetCount = labScopeTargetCount(scopeMode, allMonsters.length, chosenMonsters.length);
    const availability = labDimensionAvailability(scopeMode, targetCount);

    const requested = [...new Set((dimensions || []).filter((key) => LAB_UPGRADE_DIMENSION_KEYS.includes(key)))];
    const kept = requested.filter((key) => availability[key]?.enabled);
    const dropped = requested.filter((key) => !availability[key]?.enabled);

    if (!kept.length) {
        return {
            kind: 'none',
            dropped,
            error: requested.length
                ? 'Every checked upgrade type is unavailable for this target scope.'
                : 'Check at least one upgrade type to include.',
        };
    }

    // What the shared analysis generates, and what the panel has to measure for
    // itself alongside it
    const standaloneModes = kept.filter((key) => LAB_STANDALONE_DIMENSIONS.has(key));
    const analysisModes = kept.filter((key) => !LAB_STANDALONE_DIMENSIONS.has(key));

    if (scopeMode === 'current') {
        if (!configureMonsterHrid) {
            return { kind: 'none', dropped, error: 'Select a monster in the Configure tab first.' };
        }
        return {
            kind: 'single',
            dropped,
            monsterHrids: [configureMonsterHrid],
            standaloneModes,
            ...planLabSingleTargetModes(analysisModes),
        };
    }

    // Subset order follows the labyrinth's own fight order rather than click
    // order, so two selections of the same rooms produce the same run
    const monsterHrids =
        scopeMode === 'all' ? [...allMonsters] : allMonsters.filter((hrid) => chosenMonsters.includes(hrid));

    if (!monsterHrids.length) {
        return {
            kind: 'none',
            dropped,
            error:
                scopeMode === 'selected'
                    ? 'Tick at least one target to analyze.'
                    : 'No labyrinth fights found — set combat skip levels in the game (or enter the labyrinth) so fights have room levels.',
        };
    }

    return { kind: 'allFights', dropped, monsterHrids, modes: analysisModes, standaloneModes: [] };
}
