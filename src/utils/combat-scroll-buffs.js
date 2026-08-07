/**
 * Combat scrolls from the Labyrinth.
 *
 * Each is opened for a 30-minute buff that applies to ordinary combat — the
 * tooltip says "effective outside of Labyrinth and Guild Trials", i.e. exactly
 * the zones the Combat Simulator runs. The game renders each magnitude in its own
 * item tooltip; the values below are those, mapped to the ratio- or flat-boost
 * slot the combat engine reads for that buff type (see engine/combat-unit.js):
 *
 *   - Damage and Attack Speed are ratio boosts (damageRatioBoost; attack interval
 *     divides by 1 + Σ ratioBoost).
 *   - Cast Speed, Critical Rate, Combat Drop, Wisdom and Rare Find are flat.
 *
 * Wisdom raises combat experience and Rare Find raises the rare-drop multiplier —
 * the same buffs a skilling seal grants, so their magnitudes match the documented
 * seal values in scroll-buff-values.js.
 *
 * Hardcoded, like the skilling seals and the labyrinth token buffs, because the
 * value is a fixed item property; refresh here if the game rebalances a scroll.
 */

export const COMBAT_SCROLLS = [
    { buffTypeHrid: '/buff_types/damage', valueKey: 'ratioBoost', value: 0.08, label: 'Scroll of Damage (+8%)' },
    {
        buffTypeHrid: '/buff_types/attack_speed',
        valueKey: 'ratioBoost',
        value: 0.15,
        label: 'Scroll of Attack Speed (+15%)',
    },
    {
        buffTypeHrid: '/buff_types/cast_speed',
        valueKey: 'flatBoost',
        value: 0.15,
        label: 'Scroll of Cast Speed (+15%)',
    },
    {
        buffTypeHrid: '/buff_types/critical_rate',
        valueKey: 'flatBoost',
        value: 0.1,
        label: 'Scroll of Critical Rate (+10%)',
    },
    {
        buffTypeHrid: '/buff_types/combat_drop_quantity',
        valueKey: 'flatBoost',
        value: 0.15,
        label: 'Scroll of Combat Drop (+15%)',
    },
    { buffTypeHrid: '/buff_types/wisdom', valueKey: 'flatBoost', value: 0.2, label: 'Scroll of Wisdom (+20%)' },
    { buffTypeHrid: '/buff_types/rare_find', valueKey: 'flatBoost', value: 0.6, label: 'Scroll of Rare Find (+60%)' },
];

/** Buff-type hrids of every combat scroll, in display order. @type {string[]} */
export const COMBAT_SCROLL_BUFF_TYPES = COMBAT_SCROLLS.map((scroll) => scroll.buffTypeHrid);

/** Buff-type hrid → display label. @type {Object.<string, string>} */
export const COMBAT_SCROLL_LABELS = Object.fromEntries(
    COMBAT_SCROLLS.map((scroll) => [scroll.buffTypeHrid, scroll.label])
);

const BY_TYPE = new Map(COMBAT_SCROLLS.map((scroll) => [scroll.buffTypeHrid, scroll]));

/**
 * The engine buff object a combat scroll grants, in the permanent-buff shape the
 * server sends, or null for an unknown buff type.
 * @param {string} buffTypeHrid
 * @returns {Object|null}
 */
export function combatScrollBuff(buffTypeHrid) {
    const def = BY_TYPE.get(buffTypeHrid);
    if (!def) return null;
    const buff = {
        uniqueHrid: `/buff_uniques/toolasha_scroll_${buffTypeHrid.split('/').pop()}`,
        typeHrid: buffTypeHrid,
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
