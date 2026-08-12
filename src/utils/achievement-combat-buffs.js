/**
 * Labels for the combat buffs a player's completed achievements grant.
 *
 * Unlike scrolls (a fixed catalog of item magnitudes), achievement combat buffs
 * are read live off the player's own data — `dataManager.getAchievementBuffs(
 * '/action_types/combat')` — as already-resolved buff objects carrying the exact
 * value the game awards. The sim already folds them into every fight; this module
 * only turns one of those buff objects into a human label for the Configure
 * section that lets you toggle them, e.g. `{ typeHrid: '/buff_types/damage',
 * ratioBoost: 0.02 }` → "Damage +2%".
 */

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
