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
 * a completed tier grants, and this codebase has no static achievement-tier →
 * buff table to derive it from (the server keeps that mapping to itself). So an
 * imported player cannot have their achievement buffs auto-detected; instead
 * `MANUAL_ACHIEVEMENT_COMBAT_BUFFS` below offers the same three buffs as
 * manually-toggled checkboxes, defaulted off, so a sim of someone else's
 * character does not silently omit up to +2% damage/wisdom/rare-find while
 * still leaving the choice to the person running the sim, who can check their
 * subject's achievement tab and tick accordingly.
 */

/**
 * The fixed catalog of achievement-granted combat buffs offered as manual
 * toggles for a player whose achievements were not read live. Magnitudes and
 * ratio/flat classification match the observed values for your own character
 * (see the class-doc example above) and the same buff types' classification in
 * `combat-scroll-buffs.js` (damage is a ratio boost; wisdom and rare find are
 * flat boosts).
 * @type {Array<{typeHrid: string, valueKey: 'ratioBoost'|'flatBoost', value: number, label: string}>}
 */
export const MANUAL_ACHIEVEMENT_COMBAT_BUFFS = [
    { typeHrid: '/buff_types/damage', valueKey: 'ratioBoost', value: 0.02, label: 'Damage +2%' },
    { typeHrid: '/buff_types/wisdom', valueKey: 'flatBoost', value: 0.02, label: 'Wisdom +2%' },
    { typeHrid: '/buff_types/rare_find', valueKey: 'flatBoost', value: 0.02, label: 'Rare Find +2%' },
];

/**
 * Build the manual achievement combat buff objects, in the same permanent-buff
 * shape the server sends (and `combatScrollBuff` already builds them in), so
 * they can sit in a player DTO's `achievementCombatBuffs` array exactly like a
 * live-read achievement buff would.
 * @returns {Array<Object>} Buff objects for all three manual achievement buffs
 */
export function manualAchievementCombatBuffs() {
    return MANUAL_ACHIEVEMENT_COMBAT_BUFFS.map((def) => {
        const buff = {
            uniqueHrid: `/buff_uniques/toolasha_manual_achievement_${def.typeHrid.split('/').pop()}`,
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
    });
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
