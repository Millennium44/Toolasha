/**
 * Combat Chat Message
 *
 * The one-line chat version of a player's Combat Statistics card.
 *
 * Pure — every live reading (drop luck, DPS, boss ETA) comes in through
 * `context`, already read, so what a message says is testable without a game.
 * Chat input is a single line, so the message is " | "-joined; the popup's
 * clipboard copy keeps its own multi-line text.
 *
 * Two ways to decide what goes in:
 * - **Fields** — the popover's checkboxes, persisted per character. A field
 *   whose data is unavailable (no luck result yet, DPS still under its
 *   measuring floor, an archived run's live-only figures) is left out rather
 *   than printed as "null" or "0".
 * - **Template** — the older `combatStatsChatMessage` setting. When the user has
 *   edited it away from its default it wins, so a custom format keeps working.
 */

/**
 * A percentile as a rank — "73rd". The same wording as `formatOrdinal` in
 * `combat-drop-luck.js`, kept here so this pure module does not pull that
 * feature's websocket and dungeon-tracker graph in behind it.
 * @param {number} percentile - In [0, 1]
 * @returns {string}
 */
export function ordinalRank(percentile) {
    const rank = Math.min(Math.max(Math.round(percentile * 100), 1), 99);
    const lastTwo = rank % 100;
    const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[rank % 10] || 'th';
    return `${rank}${suffix}`;
}

/**
 * Every field the chat message can carry, in the order they are joined.
 *
 * `value` answers the bare figure (what a template variable is replaced with)
 * or null when there is nothing honest to say; `part` wraps it for the
 * " | "-joined message.
 *
 * @type {Array<{key: string, variable: string, label: string, defaultOn: boolean,
 *   value: Function, part: Function}>}
 */
export const COMBAT_CHAT_FIELDS = [
    {
        key: 'zone',
        variable: '{zone}',
        label: 'Zone',
        defaultOn: false,
        value: (_stats, ctx) => ctx.zoneName || null,
        part: (v) => v,
    },
    {
        key: 'duration',
        variable: '{duration}',
        label: 'Duration',
        defaultOn: true,
        value: (stats) => stats.durationFormatted || '0s',
        part: (v) => `${v} duration`,
    },
    {
        key: 'encountersPerHour',
        variable: '{encountersPerHour}',
        label: 'Encounters/hour',
        defaultOn: true,
        value: (stats, ctx) => num(ctx, stats.encountersPerHour),
        part: (v) => `${v} EPH`,
    },
    {
        key: 'income',
        variable: '{income}',
        label: 'Income',
        defaultOn: true,
        value: (stats, ctx) => num(ctx, stats.income?.[ctx.priceKey]),
        part: (v) => `${v} income`,
    },
    {
        key: 'dailyIncome',
        variable: '{dailyIncome}',
        label: 'Income/day',
        defaultOn: true,
        value: (stats, ctx) => num(ctx, stats.dailyIncome?.[ctx.priceKey]),
        part: (v) => `${v} income/d`,
    },
    {
        key: 'dailyConsumableCosts',
        variable: '{dailyConsumableCosts}',
        label: 'Consumables/day',
        defaultOn: true,
        value: (stats, ctx) => num(ctx, stats.dailyConsumableCosts),
        part: (v) => `${v} consumables/d`,
    },
    {
        key: 'keyCosts',
        variable: '{keyCosts}',
        label: 'Key costs/day',
        defaultOn: false,
        // A run that used no keys has no key cost to report, not a zero one
        value: (stats, ctx) => (stats.keyBreakdown?.length > 0 ? num(ctx, stats.dailyKeyCosts) : null),
        part: (v) => `${v} keys/d`,
    },
    {
        key: 'dailyProfit',
        variable: '{dailyProfit}',
        label: 'Profit/day',
        defaultOn: true,
        value: (stats, ctx) => num(ctx, stats.dailyProfit?.[ctx.priceKey]),
        part: (v) => `${v} profit/d`,
    },
    {
        key: 'exp',
        variable: '{exp}',
        label: 'XP/hour',
        defaultOn: true,
        value: (stats, ctx) => num(ctx, stats.expPerHour),
        part: (v) => `${v} exp/h`,
    },
    {
        key: 'deathCount',
        variable: '{deathCount}',
        label: 'Deaths',
        defaultOn: true,
        value: (stats) => (Number.isFinite(stats.deathCount) ? String(stats.deathCount) : null),
        part: (v) => `${v} deaths`,
    },
    {
        key: 'luck',
        variable: '{luck}',
        label: 'Drop luck',
        defaultOn: true,
        value: (_stats, ctx) => (Number.isFinite(ctx.luckPercentile) ? ordinalRank(ctx.luckPercentile) : null),
        part: (v) => `${v} pct luck`,
    },
    {
        key: 'dps',
        variable: '{dps}',
        label: 'DPS',
        defaultOn: false,
        value: (_stats, ctx) => (Number.isFinite(ctx.dps) ? num(ctx, ctx.dps) : null),
        part: (v) => `${v} DPS`,
    },
    {
        key: 'kills',
        variable: '{kills}',
        label: 'Kills',
        defaultOn: false,
        value: (_stats, ctx) => (Number.isFinite(ctx.kills) ? String(ctx.kills) : null),
        part: (v) => `${v} kills`,
    },
    {
        key: 'topDrop',
        variable: '{topDrop}',
        label: 'Top drop',
        defaultOn: false,
        value: (stats, ctx) => {
            const top = stats.lootList?.[0];
            return top?.itemName ? `${num(ctx, top.count) ?? top.count} × ${top.itemName}` : null;
        },
        part: (v) => `top: ${v}`,
    },
    {
        key: 'bossEta',
        variable: '{bossEta}',
        label: 'Boss ETA',
        defaultOn: false,
        value: (_stats, ctx) => ctx.bossEta || null,
        part: (v) => v,
    },
];

/** The field keys ticked for someone who has never opened the picker */
export const DEFAULT_COMBAT_CHAT_FIELDS = COMBAT_CHAT_FIELDS.filter((f) => f.defaultOn).map((f) => f.key);

/** What a message starts with */
export const COMBAT_CHAT_HEADER = 'Combat Stats';

/**
 * A number through the caller's formatter, or null when it is not a number.
 * @param {Object} ctx - Needs `formatNum`
 * @param {*} value
 * @returns {string|null}
 */
function num(ctx, value) {
    if (!Number.isFinite(value)) return null;
    return ctx.formatNum(value);
}

/**
 * A stored field selection, cleaned: unknown keys dropped, and anything that is
 * not a list read as "never chosen" so the defaults apply.
 * @param {*} stored - Whatever storage handed back
 * @returns {string[]}
 */
export function normalizeChatFields(stored) {
    if (!Array.isArray(stored)) return [...DEFAULT_COMBAT_CHAT_FIELDS];
    const known = new Set(COMBAT_CHAT_FIELDS.map((f) => f.key));
    return stored.filter((key) => known.has(key));
}

/**
 * Whether the template setting has been edited away from its default.
 *
 * Compared by content rather than identity, because settings storage hands
 * back a parsed copy. Nothing stored counts as the default.
 *
 * @param {Array|string|null|undefined} value - `config.getSettingValue('combatStatsChatMessage')`
 * @param {Array} defaultValue - The schema default
 * @returns {boolean}
 */
export function isCustomChatTemplate(value, defaultValue) {
    if (value === null || value === undefined || value === '') return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return JSON.stringify(value) !== JSON.stringify(defaultValue);
}

/**
 * Build the chat message for one player.
 *
 * @param {Object} stats - One player's stats from `calculateAllPlayerStats`
 * @param {string[]} fields - Field keys to include, from {@link COMBAT_CHAT_FIELDS}
 * @param {Object} [context]
 * @param {string} [context.priceKey='ask'] - Which side income and profit are reported on
 * @param {Function} [context.formatNum] - Number formatter matching the cards
 * @param {number|null} [context.luckPercentile] - Drop luck in [0, 1], or null
 * @param {number|null} [context.dps] - Live DPS, or null
 * @param {number|null} [context.kills] - Live kill count, or null
 * @param {string|null} [context.bossEta] - Boss ETA text, or null
 * @param {string|null} [context.zoneName] - Zone name, or null
 * @param {Array|string|null} [context.template] - A custom template; when given, it decides the message
 * @returns {string}
 */
export function buildCombatChatMessage(stats, fields, context = {}) {
    if (!stats) return '';
    const ctx = {
        priceKey: 'ask',
        formatNum: (n) => String(Math.round(n)),
        ...context,
    };

    const values = {};
    for (const field of COMBAT_CHAT_FIELDS) {
        try {
            values[field.key] = field.value(stats, ctx);
        } catch {
            values[field.key] = null;
        }
    }

    if (ctx.template) return renderTemplate(ctx.template, values);

    const wanted = new Set(fields || DEFAULT_COMBAT_CHAT_FIELDS);
    const parts = COMBAT_CHAT_FIELDS.filter((f) => wanted.has(f.key) && values[f.key] !== null).map((f) =>
        f.part(values[f.key])
    );
    return parts.length > 0 ? `${COMBAT_CHAT_HEADER}: ${parts.join(' | ')}` : COMBAT_CHAT_HEADER;
}

/**
 * Fill a template — the setting's array form, or a legacy string.
 *
 * A variable with no data reads as "—": a template's surrounding words are the
 * user's own and cannot be dropped with it, so the gap is marked instead.
 *
 * @param {Array|string} template
 * @param {Object<string, string|null>} values - Field key → value
 * @returns {string}
 */
function renderTemplate(template, values) {
    const byVariable = new Map(COMBAT_CHAT_FIELDS.map((f) => [f.variable, values[f.key] ?? '—']));

    if (Array.isArray(template)) {
        return template
            .map((item) => {
                if (item?.type === 'variable') return byVariable.has(item.key) ? byVariable.get(item.key) : item.key;
                return item?.value ?? '';
            })
            .join('');
    }

    let message = String(template);
    for (const [variable, value] of byVariable) message = message.split(variable).join(value);
    return message;
}
