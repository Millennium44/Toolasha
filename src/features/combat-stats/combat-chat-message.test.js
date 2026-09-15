/**
 * The one-line chat message for a Combat Statistics card.
 *
 * Pure: every live reading arrives through the context, so these pin what the
 * message says — the default fields, fields that drop out when their data is
 * missing rather than printing "null", and the custom template path that keeps
 * an edited `combatStatsChatMessage` working.
 */

import { describe, test, expect } from 'vitest';

import {
    buildCombatChatMessage,
    COMBAT_CHAT_FIELDS,
    DEFAULT_COMBAT_CHAT_FIELDS,
    isCustomChatTemplate,
    normalizeChatFields,
    ordinalRank,
} from './combat-chat-message.js';
import { utf8Length } from '../../utils/chat-fill.js';

const stats = (overrides = {}) => ({
    name: 'Me',
    durationFormatted: '2h 5m',
    encountersPerHour: 120,
    income: { ask: 5000, bid: 4000 },
    dailyIncome: { ask: 60000, bid: 48000 },
    dailyConsumableCosts: 3000,
    dailyKeyCosts: 0,
    keyBreakdown: [],
    dailyProfit: { ask: 57000, bid: 45000 },
    expPerHour: 900,
    deathCount: 0,
    lootList: [
        { itemName: 'Chimerical Chest', count: 3, totalValue: 90000 },
        { itemName: 'Coin', count: 5000, totalValue: 5000 },
    ],
    ...overrides,
});

describe('buildCombatChatMessage — the default fields', () => {
    test('carries the eight original figures in one " | "-joined line', () => {
        const message = buildCombatChatMessage(stats(), DEFAULT_COMBAT_CHAT_FIELDS);
        expect(message).toBe(
            'Combat Stats: 2h 5m duration | 120 EPH | 5000 income | 60000 income/d | 3000 consumables/d | ' +
                '57000 profit/d | 900 exp/h | 0 deaths'
        );
        expect(message).not.toContain('\n');
    });

    test('drop luck is on by default and joins the line when there is a result', () => {
        const message = buildCombatChatMessage(stats(), DEFAULT_COMBAT_CHAT_FIELDS, { luckPercentile: 0.73 });
        expect(message.endsWith('0 deaths | 73rd pct luck')).toBe(true);
    });

    test('no luck result leaves luck out rather than printing null', () => {
        for (const luckPercentile of [null, undefined, NaN]) {
            const message = buildCombatChatMessage(stats(), DEFAULT_COMBAT_CHAT_FIELDS, { luckPercentile });
            expect(message).not.toMatch(/luck|null|NaN|undefined/);
        }
    });

    test('the price side follows the context', () => {
        const message = buildCombatChatMessage(stats(), ['income', 'dailyProfit'], { priceKey: 'bid' });
        expect(message).toBe('Combat Stats: 4000 income | 45000 profit/d');
    });

    test('the formatter decides how every number reads', () => {
        const message = buildCombatChatMessage(stats(), ['income', 'exp'], { formatNum: (n) => `<${n}>` });
        expect(message).toBe('Combat Stats: <5000> income | <900> exp/h');
    });

    test('fields join in their fixed order, however they were listed', () => {
        const message = buildCombatChatMessage(stats(), ['deathCount', 'duration']);
        expect(message).toBe('Combat Stats: 2h 5m duration | 0 deaths');
    });
});

describe('buildCombatChatMessage — optional fields', () => {
    const all = COMBAT_CHAT_FIELDS.map((f) => f.key);

    test('DPS, kills, top drop, boss ETA and zone when their data is there', () => {
        const message = buildCombatChatMessage(stats(), ['zone', 'dps', 'kills', 'topDrop', 'bossEta'], {
            dps: 1234.4,
            kills: 17,
            bossEta: '3 to boss · ~2m left',
            zoneName: 'Chimerical Den',
        });
        expect(message).toBe(
            'Combat Stats: Chimerical Den | 1234 DPS | 17 kills | top: 3 × Chimerical Chest | 3 to boss · ~2m left'
        );
    });

    test('every field with no data drops out — nothing prints null or a fake zero', () => {
        const message = buildCombatChatMessage(stats({ lootList: [] }), all, {
            dps: null,
            kills: null,
            bossEta: null,
            zoneName: null,
            luckPercentile: null,
        });
        expect(message).not.toMatch(/null|undefined|NaN|DPS|kills|top:|keys\/d|luck/);
        expect(message).toContain('0 deaths');
    });

    test('key costs only for a run that used keys', () => {
        expect(buildCombatChatMessage(stats(), ['keyCosts'])).toBe('Combat Stats');
        const keyed = stats({ keyBreakdown: [{ itemName: 'Key' }], dailyKeyCosts: 8000 });
        expect(buildCombatChatMessage(keyed, ['keyCosts'])).toBe('Combat Stats: 8000 keys/d');
    });

    test('nothing ticked is just the header', () => {
        expect(buildCombatChatMessage(stats(), [])).toBe('Combat Stats');
    });
});

describe('buildCombatChatMessage — the chat byte limit', () => {
    const all = COMBAT_CHAT_FIELDS.map((f) => f.key);

    test('a message that already fits is untouched', () => {
        const message = buildCombatChatMessage(stats(), DEFAULT_COMBAT_CHAT_FIELDS, { maxBytes: 400 });
        expect(utf8Length(message)).toBeLessThanOrEqual(400);
        expect(message).not.toContain('…');
    });

    test('off-by-default extras go before luck, and luck before the default set', () => {
        // Every field on, and a budget wide enough for the defaults but not for
        // the extras and luck too — the bare-header case flushed out that this
        // was ever miscounted before
        const message = buildCombatChatMessage(stats(), all, {
            dps: 1234.4,
            kills: 17,
            bossEta: '3 to boss · ~2m left',
            zoneName: 'Chimerical Den',
            luckPercentile: 0.73,
            maxBytes: 90,
        });
        expect(message).not.toMatch(/DPS|kills|zone|Chimerical Den|to boss|luck/);
        expect(utf8Length(message)).toBeLessThanOrEqual(90);
    });

    test('never drops the first field, even under a very tight budget', () => {
        // 30 bytes fits "Combat Stats: 2h 5m duration" (28) alone but not that
        // plus a second field, so every other default field gives way to it
        const message = buildCombatChatMessage(stats(), DEFAULT_COMBAT_CHAT_FIELDS, { maxBytes: 30 });
        expect(message).toBe('Combat Stats: 2h 5m duration');
    });

    test('a budget too tight even for the first field cuts it on a byte boundary with an ellipsis', () => {
        const message = buildCombatChatMessage(stats(), DEFAULT_COMBAT_CHAT_FIELDS, { maxBytes: 10 });
        expect(utf8Length(message)).toBeLessThanOrEqual(10);
        expect(message.endsWith('…')).toBe(true);
    });

    test('an emoji-bearing formatted number still respects the byte budget, not the character count', () => {
        // A pathological formatter to prove the trim counts bytes, not `.length`
        const message = buildCombatChatMessage(stats(), ['income'], {
            formatNum: () => '💬'.repeat(60),
            maxBytes: 50,
        });
        expect(utf8Length(message)).toBeLessThanOrEqual(50);
    });
});

describe('buildCombatChatMessage — a custom template', () => {
    test('the array form fills every variable, old and new', () => {
        const template = [
            { type: 'text', value: 'GG ' },
            { type: 'variable', key: '{dailyProfit}' },
            { type: 'text', value: '/d, luck ' },
            { type: 'variable', key: '{luck}' },
            { type: 'text', value: ', ' },
            { type: 'variable', key: '{dps}' },
            { type: 'text', value: ' dps' },
        ];
        const message = buildCombatChatMessage(stats(), DEFAULT_COMBAT_CHAT_FIELDS, {
            template,
            luckPercentile: 0.12,
            dps: null,
        });
        // The user's own words stay; a figure with no data is marked, not "null"
        expect(message).toBe('GG 57000/d, luck 12th, — dps');
    });

    test('the template wins over the field selection', () => {
        const message = buildCombatChatMessage(stats(), ['income'], {
            template: [{ type: 'variable', key: '{exp}' }],
        });
        expect(message).toBe('900');
    });

    test('a legacy string template replaces every occurrence, not just the first', () => {
        const message = buildCombatChatMessage(stats(), [], {
            template: '{income} then {income} and {deathCount}',
        });
        expect(message).toBe('5000 then 5000 and 0');
    });

    test('an unknown variable is left as written', () => {
        const message = buildCombatChatMessage(stats(), [], { template: [{ type: 'variable', key: '{nope}' }] });
        expect(message).toBe('{nope}');
    });
});

describe('isCustomChatTemplate', () => {
    const defaults = [{ type: 'text', value: 'Combat Stats: ' }];

    test('the default, compared by content, is not custom', () => {
        expect(isCustomChatTemplate(JSON.parse(JSON.stringify(defaults)), defaults)).toBe(false);
    });

    test('nothing stored is not custom', () => {
        expect(isCustomChatTemplate(null, defaults)).toBe(false);
        expect(isCustomChatTemplate(undefined, defaults)).toBe(false);
        expect(isCustomChatTemplate([], defaults)).toBe(false);
    });

    test('an edited template is custom', () => {
        expect(isCustomChatTemplate([{ type: 'text', value: 'Mine' }], defaults)).toBe(true);
        expect(isCustomChatTemplate('legacy {income}', defaults)).toBe(true);
    });
});

describe('normalizeChatFields', () => {
    test('never chosen reads as the defaults, which include luck but not DPS', () => {
        const fields = normalizeChatFields(null);
        expect(fields).toEqual(DEFAULT_COMBAT_CHAT_FIELDS);
        expect(fields).toContain('luck');
        expect(fields).not.toContain('dps');
    });

    test('unknown keys are dropped; an emptied selection stays empty', () => {
        expect(normalizeChatFields(['dps', 'gone'])).toEqual(['dps']);
        expect(normalizeChatFields([])).toEqual([]);
    });
});

describe('ordinalRank', () => {
    test('reads as a rank, clamped to 1–99', () => {
        expect(ordinalRank(0.73)).toBe('73rd');
        expect(ordinalRank(0.11)).toBe('11th');
        expect(ordinalRank(0.01)).toBe('1st');
        expect(ordinalRank(0)).toBe('1st');
        expect(ordinalRank(1)).toBe('99th');
    });
});
