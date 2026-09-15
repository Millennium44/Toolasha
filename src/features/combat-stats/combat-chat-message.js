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
 *
 * Either way the result is held to the game's own chat limit (400 UTF-8 bytes,
 * see `chat-fill.js`). The two paths cannot be trimmed the same way: a fields
 * message can give up whole fields and stay readable, but a custom template's
 * words are the user's own and cutting one out mid-sentence would be worse
 * than cutting the tail off — so a template is cut at the byte limit on a
 * separator boundary and marked with "…" instead.
 */

import { CHAT_MAX_BYTES, utf8Length, trimToFit } from '../../utils/chat-fill.js';

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
 * How far a session's take sat from what was modelled, as a signed whole
 * percent in parentheses — "(+2% vs expected)". Rides beside the ordinal so
 * a session that reads unlucky by percentile (common on a zone where a rare
 * carries the value) can still be seen as ordinary against the mean.
 *
 * Empty whenever there is nothing honest to pair it with: no reading yet, or
 * `percentOfExpected` itself returning null (no expectation to compare
 * against) — the field then reads exactly as it did before this existed.
 *
 * @param {Object} ctx - Needs `luckOverExpected`
 * @returns {string}
 */
function overExpectedNote(ctx) {
    const pct = ctx?.luckOverExpected;
    if (!Number.isFinite(pct)) return '';
    const rounded = Math.round(pct);
    const sign = rounded >= 0 ? '+' : '';
    return ` (${sign}${rounded}% vs expected)`;
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
        // A dungeon has no per-monster model to place a session in — its luck
        // comes from `dungeonChestLuckFor` instead, watching chests rather than
        // loot value, but it is still "how this run compares" and gets the same
        // field rather than a second one. `ctx.luckIsChest` says which the
        // number behind `ctx.luckPercentile` is, so `part` can call it out.
        value: (_stats, ctx) => (Number.isFinite(ctx.luckPercentile) ? ordinalRank(ctx.luckPercentile) : null),
        part: (v, ctx) => (ctx?.luckIsChest ? `chest luck ${v} pct` : `${v} pct luck`) + overExpectedNote(ctx),
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
 * Which selected field gives way first when the message does not fit the
 * chat limit, lowest priority first.
 *
 * Off-by-default extras go first — nobody who ticked one expected it to cost
 * the fields everyone has on by default. Luck goes next: real information,
 * but the one most default fields can do without. What is left is the
 * default set itself, thinnest first; `duration` is last because a message
 * of bare numbers with nothing saying how long they cover reads as nothing
 * at all.
 *
 * A field not in this list (there should not be one) is treated as lowest
 * priority of all, so it drops before anything named here rather than
 * silently surviving every cut.
 *
 * @type {string[]}
 */
const CHAT_FIELD_DROP_ORDER = [
    'bossEta',
    'topDrop',
    'kills',
    'dps',
    'zone',
    'keyCosts',
    'luck',
    'deathCount',
    'exp',
    'dailyConsumableCosts',
    'encountersPerHour',
    'dailyIncome',
    'dailyProfit',
    'income',
    'duration',
];

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
 * @param {boolean} [context.luckIsChest] - Whether `luckPercentile` is a dungeon's
 *   chest reading rather than the per-monster model, so the field can say so
 * @param {number|null} [context.luckOverExpected] - The session's take as a signed
 *   percent of what was modelled, or null when there is nothing to compare against
 * @param {number|null} [context.dps] - Live DPS, or null
 * @param {number|null} [context.kills] - Live kill count, or null
 * @param {string|null} [context.bossEta] - Boss ETA text, or null
 * @param {string|null} [context.zoneName] - Zone name, or null
 * @param {Array|string|null} [context.template] - A custom template; when given, it decides the message
 * @param {number} [context.maxBytes] - The chat limit to fit under; defaults to the game's own
 * @returns {string}
 */
export function buildCombatChatMessage(stats, fields, context = {}) {
    if (!stats) return '';
    const ctx = {
        priceKey: 'ask',
        formatNum: (n) => String(Math.round(n)),
        maxBytes: CHAT_MAX_BYTES,
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

    if (ctx.template) return trimToFit(renderTemplate(ctx.template, values), ctx.maxBytes);

    const wanted = new Set(fields || DEFAULT_COMBAT_CHAT_FIELDS);
    const included = COMBAT_CHAT_FIELDS.filter((f) => wanted.has(f.key) && values[f.key] !== null);
    return fitFieldsToLimit(included, values, ctx.maxBytes, ctx);
}

/**
 * Render the selected fields, dropping the lowest-priority ones until the
 * message fits — never the highest-priority one present (`duration`, unless
 * the user never ticked it), since a message with nothing anchoring it to a
 * run reads as no run at all rather than as a run with less said about it.
 *
 * The field that happens to render *first* is not necessarily the one kept:
 * `zone` sits first in `COMBAT_CHAT_FIELDS` so it reads naturally at the
 * front of a message, but it is also an off-by-default extra and the lowest
 * priority there is — it goes before default fields positioned after it.
 *
 * @param {Array<Object>} included - `COMBAT_CHAT_FIELDS` entries with a value to show, in message order
 * @param {Object<string, string|null>} values - Field key to value, from `buildCombatChatMessage`
 * @param {number} maxBytes
 * @param {Object} [ctx] - The same context `value()` saw, for a `part()` whose wording depends on it
 * @returns {string}
 */
function fitFieldsToLimit(included, values, maxBytes, ctx) {
    const render = (fields) => {
        const parts = fields.map((f) => f.part(values[f.key], ctx));
        return parts.length > 0 ? `${COMBAT_CHAT_HEADER}: ${parts.join(' | ')}` : COMBAT_CHAT_HEADER;
    };

    let remaining = included;
    let message = render(remaining);
    if (utf8Length(message) <= maxBytes) return message;

    const rank = (field) => {
        const index = CHAT_FIELD_DROP_ORDER.indexOf(field.key);
        return index === -1 ? -1 : index;
    };
    // The single highest-priority field present is protected; everything else
    // is a drop candidate, lowest priority removed first
    const keep = remaining.reduce((best, field) => (rank(field) > rank(best) ? field : best), remaining[0]);
    const droppable = remaining.filter((field) => field !== keep).sort((a, b) => rank(a) - rank(b));

    while (utf8Length(message) > maxBytes && droppable.length > 0) {
        droppable.shift();
        // Rendered in `COMBAT_CHAT_FIELDS` order, not drop order, so the
        // message reads the same as it always would with these fields on
        const keepSet = new Set([keep, ...droppable]);
        remaining = included.filter((field) => keepSet.has(field));
        message = render(remaining);
    }

    // Even the protected field alone does not fit — a pathological case (a
    // very low byte budget, or a value too long to shorten by dropping
    // fields), so fall back to the same byte-accurate cut a custom template gets
    return utf8Length(message) <= maxBytes ? message : trimToFit(message, maxBytes);
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
