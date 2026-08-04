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
            'try by hand rather than a verdict.',
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
            'Cost is the gold value of the guild credits only — guild tokens are not priced, because nothing ' +
            'converts into them.',
    },
];

/** Every dimension key, for validating what came back from storage. */
export const LAB_UPGRADE_DIMENSION_KEYS = LAB_UPGRADE_DIMENSIONS.map((d) => d.key);

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
 * Only one rule, and it is a real one rather than a tidiness one. The
 * multi-fight analysis pools candidates across every fight's loadout and then
 * sims each candidate against each fight it applies to; ability swaps generate
 * one candidate per compatible ability per slot, which is a hundred-odd
 * candidates before the fight count multiplies them. Across a full labyrinth
 * that is thousands of simulations for a ranking the mode's own tooltip already
 * calls a hint. It is offered for a single fight, where it costs what it costs.
 *
 * @param {string} scopeMode - `current` | `all` | `selected`
 * @param {number} targetCount - From `labScopeTargetCount`
 * @returns {Object<string, {enabled: boolean, reason: string}>} Keyed by dimension
 */
export function labDimensionAvailability(scopeMode, targetCount) {
    const multiTarget = targetCount > 1;
    const availability = {};
    for (const dimension of LAB_UPGRADE_DIMENSIONS) {
        if (dimension.key === 'ability_swap' && multiTarget) {
            availability[dimension.key] = {
                enabled: false,
                reason:
                    `Ability Swaps sims every compatible ability in every slot. Across ${targetCount} fights that ` +
                    'is thousands of simulations, so it is offered one fight at a time — pick a single target, or ' +
                    'the Configure fight.',
            };
            continue;
        }
        availability[dimension.key] = { enabled: true, reason: '' };
    }
    return availability;
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
    if (!dims.length) return { upgradeMode: 'equipment', extraModes: [] };

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

    if (scopeMode === 'current') {
        if (!configureMonsterHrid) {
            return { kind: 'none', dropped, error: 'Select a monster in the Configure tab first.' };
        }
        return {
            kind: 'single',
            dropped,
            monsterHrids: [configureMonsterHrid],
            ...planLabSingleTargetModes(kept),
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

    return { kind: 'allFights', dropped, monsterHrids, modes: kept };
}
