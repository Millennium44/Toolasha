import { describe, test, expect } from 'vitest';
import { CHAT_MAX_BYTES, utf8Length } from '../../utils/chat-fill.js';
import {
    thresholdChangeText,
    conditionChangeText,
    triggerChatPlayers,
    triggerHasChatContent,
    topUpgradeTexts,
    withUpgrades,
    playerMessages,
    buildChatMessages,
    chatCopyBarHtml,
} from './chat-summary.js';

const TARGET = '/combat_trigger_dependencies/targeted_enemy';
const LOWEST = '/combat_trigger_conditions/lowest_hp_percentage';
const GTE = '/combat_trigger_comparators/greater_than_equal';
const LTE = '/combat_trigger_comparators/less_than_equal';

const gameData = {
    combatTriggerDependencyDetailMap: { [TARGET]: { name: "Allies'" } },
    combatTriggerConditionDetailMap: { [LOWEST]: { name: 'Lowest HP %' } },
    combatTriggerComparatorDetailMap: { [GTE]: { name: '>=' }, [LTE]: { name: '<=' } },
};

const change = (over = {}) => ({
    playerHrid: 'p1',
    playerName: 'AFKANDY',
    itemName: 'Quick Aid',
    dependencyHrid: TARGET,
    conditionHrid: LOWEST,
    comparatorHrid: LTE,
    from: 350,
    to: 50,
    ...over,
});

const allWithinCap = (messages) => messages.every((m) => utf8Length(m) <= CHAT_MAX_BYTES);

describe('item text', () => {
    test('a threshold change names the item, the new row and the old value', () => {
        expect(thresholdChangeText(change(), gameData)).toBe("Quick Aid → Allies': Lowest HP % ≤ 50% (was 350)");
    });

    test('a condition change drops the "Activate when" lead and says "always" for no rows', () => {
        const text = conditionChangeText(
            {
                itemName: 'Fireball',
                fromRows: [],
                toRows: [{ dependencyHrid: TARGET, conditionHrid: LOWEST, comparatorHrid: LTE, value: 40 }],
            },
            gameData
        );
        expect(text).toBe("Fireball → Allies' Lowest HP % <= 40 (was always (no conditions))");
    });
});

describe('triggerChatPlayers', () => {
    test('groups threshold changes by player hrid and sends condition changes to the selected player', () => {
        const players = triggerChatPlayers(
            {
                changes: [change(), change({ playerHrid: 'p2', playerName: 'Bob' }), change({ itemName: 'Heal' })],
                conditions: {
                    changes: [{ itemName: 'Smack', fromRows: [], toRows: [] }],
                },
            },
            gameData,
            { hrid: 'p2', name: 'Bob' }
        );
        expect(players.map((p) => [p.name, p.changes.length])).toEqual([
            ['AFKANDY', 2],
            ['Bob', 2],
        ]);
    });

    test('condition-only results work, and an unreliable result lists nothing', () => {
        const only = triggerChatPlayers(
            { noTunables: true, conditions: { changes: [{ itemName: 'X', fromRows: [], toRows: [] }] } },
            gameData,
            { hrid: 'p1', name: 'Solo' }
        );
        expect(only).toHaveLength(1);
        expect(only[0].name).toBe('Solo');
        const unreliable = { reliable: false, changes: [change()], conditions: { reliable: false, changes: [{}] } };
        expect(triggerChatPlayers(unreliable, gameData, {})).toEqual([]);
        expect(triggerHasChatContent(unreliable)).toBe(false);
        expect(triggerHasChatContent(null)).toBe(false);
        expect(triggerHasChatContent({ changes: [] })).toBe(false);
        expect(triggerHasChatContent({ changes: [change()] })).toBe(true);
    });
});

describe('topUpgradeTexts', () => {
    const row = (description, score, over = {}) => ({
        candidate: { description, type: 'equipment' },
        cost: 1000,
        score,
        deltas: { dps: 3.14 },
        ...over,
    });

    test('ranks by score, shows the score and DPS change, labels the first Top upgrade', () => {
        const texts = topUpgradeTexts(
            { results: [row('Low', 10), row('Bishop’s Codex +12', 80.4), row('Mid', 40)] },
            2
        );
        expect(texts).toEqual([
            'Top upgrade: Bishop’s Codex +12 (score 80, +3.1% DPS)',
            'Also: Mid (score 40, +3.1% DPS)',
        ]);
    });

    test('leaves out unpriced, combat-level, ability-order and unscored rows, and a flat DPS change', () => {
        const texts = topUpgradeTexts({
            results: [
                row('Unpriced', 99, { cost: null }),
                row('Level', 99, { candidate: { description: 'Level', type: 'combat_level' } }),
                row('Order', 99, { candidate: { description: 'Order', type: 'x', abilityOrder: true } }),
                row('Zero', 0),
                row('Flat', 5, { deltas: { dps: 0 } }),
            ],
        });
        expect(texts).toEqual(['Top upgrade: Flat (score 5)']);
        expect(topUpgradeTexts(null)).toEqual([]);
        expect(topUpgradeTexts({ results: [] })).toEqual([]);
    });
});

describe('stopped runs and ambiguous names', () => {
    test('a stopped run says it is partial; a food-only stop does not', () => {
        const rows = [{ candidate: { description: 'G', type: 'equipment' }, cost: 1, score: 9, deltas: {} }];
        expect(topUpgradeTexts({ results: rows, stopped: { completed: 1, total: 5 } })[0]).toMatch(
            /^Top upgrade \(partial run\): G/
        );
        expect(topUpgradeTexts({ results: rows, foodStopped: true })[0]).toMatch(/^Top upgrade: G/);
    });

    test('upgrades keyed by name only attach to nobody when two players share the name', () => {
        const players = [
            { key: 'p1', name: 'Andy', changes: ['a'], upgrades: [] },
            { key: 'p2', name: 'Andy', changes: ['b'], upgrades: [] },
        ];
        const out = withUpgrades(players, { key: null, name: 'Andy', upgrades: ['u'] });
        expect(out).toHaveLength(2);
        expect(out.every((p) => p.upgrades.length === 0)).toBe(true);
    });
});

describe('withUpgrades', () => {
    const base = () => [{ key: 'p1', name: 'A', changes: ['c'], upgrades: [] }];

    test('attaches by key, by name when there is no key, and adds a player who had no changes', () => {
        expect(withUpgrades(base(), { key: 'p1', name: 'A', upgrades: ['u'] })[0].upgrades).toEqual(['u']);
        expect(withUpgrades(base(), { key: null, name: 'A', upgrades: ['u'] })[0].upgrades).toEqual(['u']);
        const added = withUpgrades(base(), { key: 'p9', name: 'Z', upgrades: ['u'] });
        expect(added[1]).toMatchObject({ name: 'Z', changes: [], upgrades: ['u'] });
    });

    test('does not change its input and ignores an empty or unnamed owner', () => {
        const input = base();
        withUpgrades(input, { key: 'p1', upgrades: ['u'] });
        expect(input[0].upgrades).toEqual([]);
        expect(withUpgrades(input, { key: 'p1', upgrades: [] })).toEqual(input);
        expect(withUpgrades(input, { upgrades: ['u'] })[0].upgrades).toEqual([]);
    });
});

describe('playerMessages', () => {
    test('a player with nothing gets "no changes"', () => {
        expect(playerMessages('Bob', [])).toEqual(['Bob: no changes']);
    });

    test('items that fit make one unlabeled message', () => {
        expect(playerMessages('Bob', ['a', 'b'])).toEqual(['Bob: a; b']);
    });

    test('exactly 400 bytes stays whole; one byte more splits with numbered parts', () => {
        const prefix = 'Bob: ';
        const fill = 'x'.repeat(CHAT_MAX_BYTES - prefix.length - 4);
        const exact = playerMessages('Bob', [fill, 'yyyy'.slice(0, 4 - 2)]);
        // fill + "; " + 2 chars = exactly 400 - prefix
        expect(exact).toHaveLength(1);
        expect(utf8Length(exact[0])).toBe(CHAT_MAX_BYTES);
        const over = playerMessages('Bob', [fill, 'yyy']);
        expect(over).toHaveLength(2);
        expect(over[0].startsWith('(1/2) Bob: ')).toBe(true);
        expect(over[1].startsWith('(2/2) Bob: ')).toBe(true);
        expect(allWithinCap(over)).toBe(true);
    });

    test('splits only at item boundaries and loses nothing', () => {
        const items = Array.from({ length: 30 }, (_, i) => `Item number ${i} → Allies: HP <= ${i}% (was 350)`);
        const parts = playerMessages('AFKANDY', items);
        expect(parts.length).toBeGreaterThan(2);
        expect(allWithinCap(parts)).toBe(true);
        const bodies = parts.map((p) => p.replace(/^\(\d+\/\d+\) AFKANDY: /, ''));
        expect(bodies.join('; ').split('; ')).toEqual(items);
        parts.forEach((p, i) => expect(p.startsWith(`(${i + 1}/${parts.length}) `)).toBe(true));
    });

    test('ten or more parts: the wider label still fits', () => {
        const items = Array.from({ length: 12 }, (_, i) => `${i}`.padEnd(370, 'z'));
        const parts = playerMessages('P', items);
        expect(parts).toHaveLength(12);
        expect(parts[0].startsWith('(1/12) P: ')).toBe(true);
        expect(allWithinCap(parts)).toBe(true);
    });

    test('one item longer than the cap is cut with an ellipsis, alone, within the cap', () => {
        const parts = playerMessages('Bob', ['short', `${'word '.repeat(200)}end`, 'tail']);
        expect(allWithinCap(parts)).toBe(true);
        const cut = parts.find((p) => p.includes('…'));
        expect(cut).toBeTruthy();
        expect(cut.endsWith('…')).toBe(true);
        expect(cut).not.toMatch(/wor…$/);
        expect(parts.join('\n')).toContain('short');
        expect(parts.join('\n')).toContain('tail');
    });

    test('a single oversize item with nothing else stays one plain message', () => {
        const parts = playerMessages('Bob', ['q'.repeat(900)]);
        expect(parts).toHaveLength(1);
        expect(parts[0].startsWith('Bob: ')).toBe(true);
        expect(utf8Length(parts[0])).toBeLessThanOrEqual(CHAT_MAX_BYTES);
    });

    test('Chinese item names and emoji are counted in bytes and never cut mid-character', () => {
        const items = Array.from({ length: 25 }, (_, i) => `主教法典${i} → 友方最低生命 <= ${i}% 🔥👨‍👩‍👧 (was 350)`);
        const parts = playerMessages('小明', items);
        expect(parts.length).toBeGreaterThan(1);
        expect(allWithinCap(parts)).toBe(true);
        expect(parts.join('')).not.toContain('�');
        const long = playerMessages('小明', [`${'主教'.repeat(300)}`]);
        expect(utf8Length(long[0])).toBeLessThanOrEqual(CHAT_MAX_BYTES);
        expect(long[0].endsWith('…')).toBe(true);
        // an emoji family cut near the end must come out whole or not at all
        const emoji = playerMessages('E', ['a'.repeat(380) + '👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧']);
        expect(emoji[0]).not.toMatch(/‍…?$/);
        expect(utf8Length(emoji[0])).toBeLessThanOrEqual(CHAT_MAX_BYTES);
    });
});

describe('buildChatMessages', () => {
    const player = (name, changes = [], upgrades = [], key = name) => ({ key, name, changes, upgrades });

    test('matches the approved shape for one player', () => {
        const [line] = buildChatMessages(
            [player('AFKANDY', ['Quick Aid → Allies: Lowest HP % <= 50 (was 350)'], ['Top upgrade: Codex (score 80)'])],
            { includeUpgrades: true }
        );
        expect(line).toBe('AFKANDY: Quick Aid → Allies: Lowest HP % <= 50 (was 350); Top upgrade: Codex (score 80)');
    });

    test('upgrades are left out unless asked for', () => {
        expect(buildChatMessages([player('A', ['c'], ['u'])])).toEqual(['A: c']);
        expect(buildChatMessages([player('A', [], ['u'])])).toEqual(['A: no changes']);
    });

    test('three players make at least three messages in order, each within the cap', () => {
        const big = Array.from({ length: 14 }, (_, i) => `change ${i} `.padEnd(60, '.'));
        const out = buildChatMessages([player('A', ['a']), player('B', big), player('C', ['c'])]);
        expect(out[0]).toBe('A: a');
        expect(out.at(-1)).toBe('C: c');
        expect(out.filter((m) => m.includes('B: ')).length).toBeGreaterThan(1);
        expect(allWithinCap(out)).toBe(true);
    });

    test('players with the same name are told apart, and players with a blank name get a stand-in', () => {
        const out = buildChatMessages([
            player('Andy', ['a'], [], 'p1'),
            player('Andy', ['b'], [], 'p2'),
            player('', ['c']),
        ]);
        expect(out).toEqual(['Andy: a', 'Andy (2): b', 'Player: c']);
    });

    test('a huge name is cut so the item still gets room', () => {
        const out = buildChatMessages([player('N'.repeat(500), ['x'])]);
        expect(utf8Length(out[0])).toBeLessThanOrEqual(CHAT_MAX_BYTES);
        expect(out[0].endsWith(': x')).toBe(true);
    });

    test('nothing in, nothing out', () => {
        expect(buildChatMessages([])).toEqual([]);
    });
});

describe('chatCopyBarHtml', () => {
    test('draws the button, and the toggle only when given an id', () => {
        const plain = chatCopyBarHtml({ buttonId: 'b' });
        expect(plain).toContain('id="b"');
        expect(plain).not.toContain('checkbox');
        const toggled = chatCopyBarHtml({ buttonId: 'b', toggleId: 't', includeUpgrades: true });
        expect(toggled).toMatch(/id="t" checked|id="t"[^>]*checked/);
        expect(toggled).toContain('Include upgrades');
    });
});
