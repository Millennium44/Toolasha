import { describe, test, expect, vi } from 'vitest';

import {
    registerRow,
    registeredRows,
    resolveRows,
    moveRow,
    tileClassFor,
    emptyPolicyFor,
    compactLabel,
    CURATED_ROWS,
    TILE_CLASS,
    EMPTY_POLICY,
    ROW_GROUPS,
    groupFor,
    isRetired,
    isListed,
    listedRows,
    emptyText,
    moveRowWithin,
} from './overlay-rows.js';

const row = (key, defaultVisible = true) => ({ key, name: key, render: () => {}, defaultVisible });

describe('registerRow', () => {
    test('takes a row and hands it back', () => {
        registerRow({ key: 'alpha', name: 'Alpha', render: () => {} });
        expect(registeredRows().some((r) => r.key === 'alpha')).toBe(true);
    });

    test('registering the same key twice replaces rather than duplicates', () => {
        // A feature that re-initialises must not end up drawn twice
        registerRow({ key: 'beta', name: 'First', render: () => {} });
        registerRow({ key: 'beta', name: 'Second', render: () => {} });

        const matches = registeredRows().filter((r) => r.key === 'beta');
        expect(matches).toHaveLength(1);
        expect(matches[0].name).toBe('Second');
    });

    test('refuses a row that cannot be drawn', () => {
        const before = registeredRows().length;
        registerRow({ key: 'broken' });
        registerRow({ name: 'no key', render: () => {} });
        expect(registeredRows()).toHaveLength(before);
    });
});

describe('resolveRows', () => {
    const available = [row('a'), row('b'), row('c')];

    test('follows the saved order', () => {
        const resolved = resolveRows(available, { order: ['c', 'a', 'b'], visible: {} });
        expect(resolved.map((r) => r.key)).toEqual(['c', 'a', 'b']);
    });

    test('a row the saved order has never heard of goes to the end, not missing', () => {
        // This is what happens to every row added by an update
        const resolved = resolveRows(available, { order: ['b'], visible: {} });
        expect(resolved.map((r) => r.key)).toEqual(['b', 'a', 'c']);
    });

    test('a saved key for a row that no longer exists leaves no hole', () => {
        const resolved = resolveRows(available, { order: ['a', 'gone', 'b', 'c'], visible: {} });
        expect(resolved.map((r) => r.key)).toEqual(['a', 'b', 'c']);
    });

    test('visibility comes from settings, falling back to the row default', () => {
        const rows = [row('on', true), row('off', false)];
        const resolved = resolveRows(rows, { order: [], visible: { on: false } });
        expect(resolved.find((r) => r.key === 'on').visible).toBe(false);
        expect(resolved.find((r) => r.key === 'off').visible).toBe(false);
    });

    test('a row explicitly switched on beats a default of off', () => {
        const resolved = resolveRows([row('x', false)], { order: [], visible: { x: true } });
        expect(resolved[0].visible).toBe(true);
    });

    test('survives no settings at all', () => {
        expect(resolveRows(available, null).map((r) => r.key)).toEqual(['a', 'b', 'c']);
    });
});

describe('resolveRows with curated defaults', () => {
    const available = [row('netWorth'), row('dps'), row('luck'), row('coins')];
    const curated = { order: [], visible: {}, curatedDefaults: true };

    test('a character who has never arranged anything gets the curated set only', () => {
        const on = resolveRows(available, curated)
            .filter((r) => r.visible)
            .map((r) => r.key);
        // Of this fixture's rows, all four are curated (netWorth/coins in Wealth,
        // dps/luck in the session cluster), and nothing outside the set turns on
        expect(on.sort()).toEqual(['coins', 'dps', 'luck', 'netWorth']);
    });

    test('and gets them in the curated order, whatever order they registered in', () => {
        const shuffled = [row('coins'), row('dps'), row('netWorth')];
        const order = resolveRows(shuffled, curated).map((r) => r.key);
        expect(order.indexOf('netWorth')).toBeLessThan(order.indexOf('coins'));
        expect(order.indexOf('coins')).toBeLessThan(order.indexOf('dps'));
    });

    test('an explicit choice still beats the curated set, both ways round', () => {
        const settings = { ...curated, visible: { dps: true, netWorth: false } };
        const resolved = resolveRows(available, settings);
        expect(resolved.find((r) => r.key === 'dps').visible).toBe(true);
        expect(resolved.find((r) => r.key === 'netWorth').visible).toBe(false);
    });

    test('without the flag every row falls back to its own default, as it always did', () => {
        // Which is what an existing player's saved settings look like
        const resolved = resolveRows(available, { order: [], visible: {} });
        expect(resolved.every((r) => r.visible)).toBe(true);
    });

    test('a saved order is left alone rather than resorted into curated order', () => {
        const settings = { ...curated, order: ['luck', 'coins', 'dps', 'netWorth'] };
        expect(resolveRows(available, settings).map((r) => r.key)).toEqual(['luck', 'coins', 'dps', 'netWorth']);
    });

    test('the curated set stays small enough to be read at a glance', () => {
        // The wall the curated set guards against is a wall of *value* tiles —
        // the ones that always draw. Those are what has to stay few. Measurements
        // hide until they have data, so a handful of session figures can ride in
        // the set without a fresh character ever seeing them as placeholders.
        const alwaysOn = CURATED_ROWS.filter((key) => tileClassFor({ key }) === TILE_CLASS.VALUE);
        expect(alwaysOn.length).toBeLessThanOrEqual(6);
        expect(CURATED_ROWS.length).toBeGreaterThanOrEqual(6);
        expect(CURATED_ROWS.length).toBeLessThanOrEqual(12);
        expect(new Set(CURATED_ROWS).size).toBe(CURATED_ROWS.length);
    });
});

describe('what a tile does when it has drawn nothing', () => {
    test('it keeps its slot and shrinks to its name, measurement or not', () => {
        // Tiles sit in a grid with saved positions, and a tile that goes away
        // does not take its slot with it — it leaves a hole in the line
        expect(tileClassFor({ key: 'dps' })).toBe(TILE_CLASS.MEASUREMENT);
        expect(emptyPolicyFor({ key: 'dps' })).toBe(EMPTY_POLICY.COMPACT);
        expect(tileClassFor({ key: 'coins' })).toBe(TILE_CLASS.VALUE);
        expect(emptyPolicyFor({ key: 'coins' })).toBe(EMPTY_POLICY.COMPACT);
    });

    test('a watch tile only says so when there is somewhere to click', () => {
        expect(emptyPolicyFor({ key: 'watchlist', onOpen: () => {} })).toBe(EMPTY_POLICY.COMPACT);
        expect(emptyPolicyFor({ key: 'equipmentWatch' })).toBe(EMPTY_POLICY.HIDE);
    });

    test('a compact tile says its own name, never its placeholder', () => {
        // Two tiles are allowed to be idle in the same words; their names are
        // the one thing that is theirs
        const watchlist = { key: 'watchlist', name: 'Watchlist', empty: 'Nothing watched', onOpen: () => {} };
        const equipment = { key: 'equipmentWatch', name: 'Equipment Watch', empty: 'Nothing watched' };
        expect(compactLabel(watchlist)).not.toBe(compactLabel(equipment));
        expect(compactLabel(equipment)).toBe('Equipment Watch');
    });

    test('a nameless row falls back to its key rather than to nothing', () => {
        expect(compactLabel({ key: 'mystery' })).toBe('mystery');
    });

    test('a row may declare its own class and its own answer', () => {
        expect(tileClassFor({ key: 'dps', tileClass: TILE_CLASS.WATCH })).toBe(TILE_CLASS.WATCH);
        expect(tileClassFor({ key: 'dps', tileClass: 'nonsense' })).toBe(TILE_CLASS.MEASUREMENT);
        expect(emptyPolicyFor({ key: 'coins', whenEmpty: EMPTY_POLICY.HIDE })).toBe(EMPTY_POLICY.HIDE);
    });

    test('the panel setting is the last word', () => {
        for (const setting of [EMPTY_POLICY.HIDE, EMPTY_POLICY.COMPACT, EMPTY_POLICY.FULL]) {
            expect(emptyPolicyFor({ key: 'dps' }, setting)).toBe(setting);
        }
        expect(emptyPolicyFor({ key: 'dps' }, 'nonsense')).toBe(EMPTY_POLICY.COMPACT);
    });

    test('registerRow carries a row’s own class and answer through', () => {
        registerRow({
            key: 'declared',
            name: 'Declared',
            render: () => {},
            tileClass: TILE_CLASS.WATCH,
            whenEmpty: EMPTY_POLICY.FULL,
        });
        const found = registeredRows().find((r) => r.key === 'declared');
        expect(emptyPolicyFor(found)).toBe(EMPTY_POLICY.FULL);
        expect(tileClassFor(found)).toBe(TILE_CLASS.WATCH);
    });
});

describe('moveRow', () => {
    test('moves a key up and down', () => {
        expect(moveRow(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
        expect(moveRow(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    });

    test('will not move past either end', () => {
        const order = ['a', 'b', 'c'];
        expect(moveRow(order, 'a', -1)).toBe(order);
        expect(moveRow(order, 'c', 1)).toBe(order);
    });

    test('ignores a key that is not in the order', () => {
        const order = ['a', 'b'];
        expect(moveRow(order, 'zzz', 1)).toBe(order);
    });

    test('leaves the order it was given alone', () => {
        const order = ['a', 'b', 'c'];
        moveRow(order, 'a', 1);
        expect(order).toEqual(['a', 'b', 'c']);
    });
});

describe('the picker groups', () => {
    const SHIPPED = {
        Wealth: ['netWorth', 'coins', 'inventoryValue', 'marketListings', 'watchlist', 'equipmentWatch'],
        'Combat and skilling': ['experiencePerHour', 'totalProfit', 'consumables', 'timeToLevel', 'combatStatus'],
        Skilling: ['skillLevel', 'queueTimeLeft', 'taskTokens'],
        Combat: ['combatLevel', 'dps', 'deathsPerHour', 'treasure', 'combatText'],
        'Account and goals': ['accountView', 'buildScore', 'noticeLog', 'sessionBriefing', 'goalNextStep'],
        Guild: ['guildTrialsPace', 'guildRoster', 'guildTrialLedger'],
        Readouts: ['replayCheck', 'predictionCalibration', 'stunPersistence', 'waveGap', 'tickPeriod'],
    };

    test('every shipped row is filed where the maintainer put it', () => {
        for (const [group, keys] of Object.entries(SHIPPED)) {
            for (const key of keys) expect(groupFor({ key })).toBe(group);
        }
        expect(groupFor({ key: 'charmValue' })).toBe('Wealth');
        expect(groupFor({ key: 'skillBooks' })).toBe('Wealth');
        expect(groupFor({ key: 'houses' })).toBe('Skilling');
        expect(groupFor({ key: 'ironBellNextStep' })).toBe('Skilling');
        expect(groupFor({ key: 'enhancementSession' })).toBe('Skilling');
        expect(groupFor({ key: 'luck' })).toBe('Combat');
    });

    test('a row nothing names lands in Other, and a row can say for itself', () => {
        expect(groupFor({ key: 'someExternalTile' })).toBe('Other');
        expect(groupFor(undefined)).toBe('Other');
        expect(groupFor({ key: 'someExternalTile', group: 'Guild' })).toBe('Guild');
        expect(groupFor({ key: 'someExternalTile', group: 'Not a group' })).toBe('Other');
        expect(ROW_GROUPS[ROW_GROUPS.length - 1]).toBe('Other');
        expect(ROW_GROUPS[0]).toBe('Combat and skilling');
    });
});

describe('retired rows', () => {
    test('a retired row that is off is unlisted; on, it is listed', () => {
        expect(isListed({ key: 'a', retired: true, visible: false })).toBe(false);
        expect(isListed({ key: 'a', retired: true, visible: true })).toBe(true);
        expect(isListed({ key: 'a', visible: false })).toBe(true);
    });

    test('a predicate is read each time, and one that throws leaves the row listed', () => {
        let retired = true;
        const entry = { key: 'a', retired: () => retired, visible: false };
        expect(isRetired(entry)).toBe(true);
        retired = false;
        expect(isRetired(entry)).toBe(false);

        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(isListed({ key: 'b', retired: () => Reflect.ownKeys(null), visible: false })).toBe(true);
        quiet.mockRestore();
    });

    test('registerRow keeps the flag, and a row without one is not retired', () => {
        registerRow({ key: 'retiredProbe', name: 'Probe', render: () => {}, retired: true });
        registerRow({ key: 'liveProbe', name: 'Live', render: () => {} });
        expect(registeredRows().find((r) => r.key === 'retiredProbe').retired).toBe(true);
        expect(isRetired(registeredRows().find((r) => r.key === 'liveProbe'))).toBe(false);
    });

    test('listedRows keeps a retired row that the saved settings have on, and resolveRows still returns it', () => {
        const rowsIn = [
            { key: 'a', name: 'a', render: () => {}, defaultVisible: true },
            { key: 'old', name: 'old', render: () => {}, defaultVisible: false, retired: true },
            { key: 'gone', name: 'gone', render: () => {}, defaultVisible: false, retired: true },
        ];
        const saved = { order: ['old', 'a', 'gone'], visible: { old: true } };

        expect(listedRows(saved, rowsIn).map((r) => r.key)).toEqual(['a', 'old']);
        // The panel's own resolution is untouched: all three still resolve, in order
        expect(resolveRows(rowsIn, saved).map((r) => [r.key, r.visible])).toEqual([
            ['old', true],
            ['a', true],
            ['gone', false],
        ]);
    });
});

describe('emptyText', () => {
    test('reads a function each time it is asked, and a plain string as it is', () => {
        let state = 'one';
        expect(emptyText({ empty: () => state })).toBe('one');
        state = 'two';
        expect(emptyText({ empty: () => state })).toBe('two');
        expect(emptyText({ empty: 'plain' })).toBe('plain');
        expect(emptyText({})).toBe('');
        expect(emptyText({ empty: () => undefined })).toBe('');
    });
});

describe('moveRowWithin', () => {
    const order = ['w1', 'c1', 'w2', 'c2', 'w3'];
    const wealth = (key) => key.startsWith('w');

    test('moves past the next tile of the same group, skipping the ones between', () => {
        expect(moveRowWithin(order, 'w1', 1, wealth)).toEqual(['c1', 'w2', 'w1', 'c2', 'w3']);
        expect(moveRowWithin(order, 'w3', -1, wealth)).toEqual(['w1', 'c1', 'w3', 'w2', 'c2']);
    });

    test('does nothing at the end of the group, and for a key that is not there', () => {
        expect(moveRowWithin(order, 'w3', 1, wealth)).toBe(order);
        expect(moveRowWithin(order, 'w1', -1, wealth)).toBe(order);
        expect(moveRowWithin(order, 'missing', 1, wealth)).toBe(order);
    });

    test('never mutates its input', () => {
        const before = [...order];
        moveRowWithin(order, 'w1', 1, wealth);
        expect(order).toEqual(before);
    });
});
