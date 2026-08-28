/**
 * Labels for the combat buffs a player's completed achievements grant.
 *
 * For your own character, achievement combat buffs are read live off your own
 * data — `dataManager.getAchievementBuffs('/action_types/combat')` — as
 * already-resolved buff objects carrying the exact value the game awards. The
 * sim already folds them into every fight; this module turns one of those buff
 * objects into a human label for the Configure section that lets you toggle
 * them, e.g. `{ typeHrid: '/buff_types/damage', ratioBoost: 0.02 }` →
 * "Damage +2%".
 *
 * A `profile_shared` payload (what a shared/imported profile carries) has no
 * equivalent resolved field — it lists completed achievements
 * (`characterAchievements`, hrid + isCompleted) but not the per-action-type buff
 * a completed tier grants directly. What it does carry is enough to derive it:
 * each entry names its `achievementHrid`, and the game's own
 * `achievementDetailMap` (from `dataManager.getInitClientData()`) maps every
 * achievement to a `tierHrid`. Completing every achievement in a tier is what
 * lights up that tier's buff in the game's own Achievement Buffs popup —
 * `ACHIEVEMENT_TIER_BUFFS` below encodes that static tier → buff mapping (as
 * supplied by the maintainer from the popup), and `deriveAchievementCombatBuffs`
 * turns a profile's achievement list plus the detail map into which of the
 * combat-relevant buffs (Novice → Wisdom, Veteran → Rare Find, Elite → Damage)
 * are actually active for that player. When the profile or the detail map is
 * missing (older payloads, or data not loaded yet), callers fall back to
 * `MANUAL_ACHIEVEMENT_COMBAT_BUFFS` — the same three buffs offered as
 * manually-toggled checkboxes, defaulted off, so a sim of someone else's
 * character never silently omits up to +2% damage/wisdom/rare-find.
 */

/**
 * The full tier → buff mapping from the game's Achievement Buffs popup:
 * completing every achievement in a tier grants that tier's buff. Only three
 * tiers are combat-relevant (Novice, Veteran, Elite); the rest are included
 * here for completeness of the static mapping the maintainer supplied. Ratio
 * vs. flat classification for the three combat buffs matches the observed
 * values for your own character and `combat-scroll-buffs.js` (damage is a
 * ratio boost; wisdom and rare find are flat boosts). The classification for
 * the non-combat tiers (Gathering, Efficiency) is inferred from that same
 * flat-percentage pattern and is not exercised by the sim — verify in-game if
 * it is ever needed for a skilling buff.
 * @type {Array<{tierHrid: string, typeHrid: string, valueKey: 'ratioBoost'|'flatBoost', value: number, label: string}>}
 */
export const ACHIEVEMENT_TIER_BUFFS = [
    {
        tierHrid: '/achievement_tiers/beginner',
        typeHrid: '/buff_types/gathering',
        valueKey: 'flatBoost',
        value: 0.02,
        label: 'Gathering +2%',
    },
    {
        tierHrid: '/achievement_tiers/novice',
        typeHrid: '/buff_types/wisdom',
        valueKey: 'flatBoost',
        value: 0.02,
        label: 'Wisdom +2%',
    },
    {
        tierHrid: '/achievement_tiers/adept',
        typeHrid: '/buff_types/efficiency',
        valueKey: 'flatBoost',
        value: 0.02,
        label: 'Efficiency +2%',
    },
    {
        tierHrid: '/achievement_tiers/veteran',
        typeHrid: '/buff_types/rare_find',
        valueKey: 'flatBoost',
        value: 0.02,
        label: 'Rare Find +2%',
    },
    {
        tierHrid: '/achievement_tiers/elite',
        typeHrid: '/buff_types/damage',
        valueKey: 'ratioBoost',
        value: 0.02,
        label: 'Damage +2%',
    },
    {
        tierHrid: '/achievement_tiers/champion',
        typeHrid: '/buff_types/enhancing_success',
        valueKey: 'ratioBoost',
        value: 0.002,
        label: 'Enhancing Success +0.2%',
    },
];

const COMBAT_ACHIEVEMENT_BUFF_TYPES = ['/buff_types/damage', '/buff_types/wisdom', '/buff_types/rare_find'];

/**
 * The fixed catalog of achievement-granted combat buffs offered as manual
 * toggles for a player whose achievements were not read live or could not be
 * derived. The combat subset of `ACHIEVEMENT_TIER_BUFFS`, in the same
 * damage/wisdom/rare-find order as before.
 * @type {Array<{tierHrid: string, typeHrid: string, valueKey: 'ratioBoost'|'flatBoost', value: number, label: string}>}
 */
export const MANUAL_ACHIEVEMENT_COMBAT_BUFFS = COMBAT_ACHIEVEMENT_BUFF_TYPES.map((typeHrid) =>
    ACHIEVEMENT_TIER_BUFFS.find((def) => def.typeHrid === typeHrid)
);

/**
 * Build one buff object in the permanent-buff shape the server sends (and
 * `combatScrollBuff` already builds them in), from a catalog definition and a
 * unique-hrid namespace tag.
 * @param {Object} def - Entry from `ACHIEVEMENT_TIER_BUFFS`/`MANUAL_ACHIEVEMENT_COMBAT_BUFFS`
 * @param {string} tag - Namespace tag distinguishing manual vs. derived buffs in the unique hrid
 * @returns {Object} Buff object
 */
function buildBuffFromDef(def, tag) {
    const buff = {
        uniqueHrid: `/buff_uniques/toolasha_${tag}_achievement_${def.typeHrid.split('/').pop()}`,
        typeHrid: def.typeHrid,
        ratioBoost: 0,
        ratioBoostLevelBonus: 0,
        flatBoost: 0,
        flatBoostLevelBonus: 0,
        startTime: '0001-01-01T00:00:00Z',
        duration: 0,
    };
    buff[def.valueKey] = def.value;
    return buff;
}

/**
 * Build the manual achievement combat buff objects, in the same permanent-buff
 * shape the server sends, so they can sit in a player DTO's
 * `achievementCombatBuffs` array exactly like a live-read achievement buff
 * would.
 * @returns {Array<Object>} Buff objects for all three manual achievement buffs
 */
export function manualAchievementCombatBuffs() {
    return MANUAL_ACHIEVEMENT_COMBAT_BUFFS.map((def) => buildBuffFromDef(def, 'manual'));
}

/**
 * Per-tier achievement completion counts, derived from a shared profile's
 * completed-achievement list against the game's achievement catalog.
 *
 * `characterAchievements` (from a `profile_shared` payload) carries only
 * `achievementHrid` + `isCompleted` per entry — no tier. `achievementDetailMap`
 * (from `dataManager.getInitClientData()`) is the other half: every achievement
 * hrid maps to a `tierHrid` there, and the map's own size gives each tier's
 * total. Cross-referencing the two gives, per tier, how many of that tier's
 * achievements exist and how many this player has completed.
 *
 * @param {Array<{achievementHrid: string, isCompleted: boolean}>} characterAchievements
 * @param {Object} achievementDetailMap - hrid → { tierHrid, ... }
 * @returns {Object} tierHrid → { completedCount: number, totalCount: number }
 */
export function achievementTierCounts(characterAchievements, achievementDetailMap) {
    const counts = {};
    if (!achievementDetailMap || typeof achievementDetailMap !== 'object') return counts;

    for (const details of Object.values(achievementDetailMap)) {
        const tierHrid = details?.tierHrid;
        if (!tierHrid) continue;
        if (!counts[tierHrid]) counts[tierHrid] = { completedCount: 0, totalCount: 0 };
        counts[tierHrid].totalCount++;
    }

    if (Array.isArray(characterAchievements)) {
        for (const achievement of characterAchievements) {
            if (!achievement?.isCompleted || !achievement.achievementHrid) continue;
            const tierHrid = achievementDetailMap[achievement.achievementHrid]?.tierHrid;
            if (tierHrid && counts[tierHrid]) counts[tierHrid].completedCount++;
        }
    }

    return counts;
}

/**
 * The combat-relevant achievement buffs derived from a shared profile's
 * completed achievements: all three combat buff objects (same shape as
 * `manualAchievementCombatBuffs()`), plus which of them are actually ACTIVE —
 * a tier is active only when every one of its achievements is completed,
 * matching how the game's own Achievement Buffs popup highlights a buff only
 * once its tier reads e.g. "11/11".
 *
 * @param {Array<{achievementHrid: string, isCompleted: boolean}>} characterAchievements
 * @param {Object} achievementDetailMap - hrid → { tierHrid, ... }
 * @returns {{buffs: Array<Object>, activeTypeHrids: string[]}}
 */
export function deriveAchievementCombatBuffs(characterAchievements, achievementDetailMap) {
    const counts = achievementTierCounts(characterAchievements, achievementDetailMap);
    const buffs = [];
    const activeTypeHrids = [];

    for (const def of MANUAL_ACHIEVEMENT_COMBAT_BUFFS) {
        buffs.push(buildBuffFromDef(def, 'derived'));
        const tierCount = counts[def.tierHrid];
        const isActive = !!tierCount && tierCount.totalCount > 0 && tierCount.completedCount === tierCount.totalCount;
        if (isActive) activeTypeHrids.push(def.typeHrid);
    }

    return { buffs, activeTypeHrids };
}

/**
 * A display label for a resolved achievement combat buff — its prettified buff
 * type plus its magnitude as a percentage, e.g. "Damage +2%". A buff with no
 * magnitude is labelled by name alone.
 * @param {Object} buff - A resolved buff object ({ typeHrid, ratioBoost, flatBoost })
 * @returns {string}
 */
export function achievementBuffLabel(buff) {
    const name =
        String(buff?.typeHrid || '')
            .split('/')
            .pop()
            .split('_')
            .filter(Boolean)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ') || 'Buff';
    const magnitude = Number(buff?.ratioBoost) || Number(buff?.flatBoost) || 0;
    if (!magnitude) return name;
    const pct = Math.round(magnitude * 1000) / 10;
    const sign = pct >= 0 ? '+' : '';
    return `${name} ${sign}${pct}%`;
}
