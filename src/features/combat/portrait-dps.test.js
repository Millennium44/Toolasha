/** @vitest-environment happy-dom
 *
 * Portrait DPS.
 *
 * The join between a portrait and a tally row is the whole of the risk here, and
 * it is the same trap the damage tally itself fell into: matching by position
 * works right up until somebody leaves, and then it silently draws one
 * character's damage on another's face. So the matching is by name, and these
 * tests are mostly about what happens when a name is not there to match.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const opts = vi.hoisted(() => ({ position: 'above', players: [], fight: { players: {}, enemies: {} } }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: () => opts.position },
}));
vi.mock('./damage-tracker.js', () => ({
    damageBreakdown: () => ({ players: opts.players }),
    battleBreakdown: () => opts.fight,
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerInterval: () => {}, clearAll: () => {} }),
}));

const {
    matchPortraits,
    portraitName,
    meterText,
    enemyMeterText,
    default: portraitDps,
} = await import('./portrait-dps.js');

/** A portrait tile as the game builds it, hashed class names and all */
const portrait = (name) => {
    const unit = document.createElement('div');
    unit.className = 'CombatUnit_combatUnit__1a2b3';
    const label = document.createElement('div');
    label.className = 'CombatUnit_name__4c5d6';
    label.textContent = name;
    unit.appendChild(label);
    return unit;
};

describe('reading a portrait', () => {
    test('the name is what the tile says', () => {
        expect(portraitName(portrait('Millennium44'))).toBe('Millennium44');
    });

    test('a tile with no name is not a match for anybody', () => {
        const bare = document.createElement('div');
        expect(portraitName(bare)).toBe('');
        expect(portraitName(null)).toBe('');
    });
});

describe('pairing portraits with the tally', () => {
    const players = [
        { name: 'Millennium44', damage: 98000, dps: 239 },
        { name: 'Gold999', damage: 58000, dps: 142 },
    ];

    test('each portrait gets the row with its own name', () => {
        const units = [portrait('Gold999'), portrait('Millennium44')];
        const pairs = matchPortraits(units, players);

        expect(pairs).toHaveLength(2);
        expect(pairs[0].player.name).toBe('Gold999');
        expect(pairs[1].player.name).toBe('Millennium44');
    });

    test('order is irrelevant, which is the entire point', () => {
        // Matching by position would put Gold999's damage on Millennium44's
        // portrait here, which is the bug the damage tally already had once
        const [first] = matchPortraits([portrait('Gold999')], players);

        expect(first.player.damage).toBe(58000);
    });

    test('a portrait nobody has damage for gets nothing', () => {
        // Rather than falling back to position and borrowing somebody else's
        expect(matchPortraits([portrait('Stranger')], players)).toHaveLength(0);
    });

    test('a tally row with no portrait is simply not drawn', () => {
        expect(matchPortraits([portrait('Gold999')], players)).toHaveLength(1);
    });

    test('nothing to match is nothing, not a crash', () => {
        expect(matchPortraits([], players)).toEqual([]);
        expect(matchPortraits(null, null)).toEqual([]);
    });
});

describe('what a meter says', () => {
    test('the run alone still reserves the fight line, dashed', () => {
        // Two lines whether or not this player has acted this fight: a meter
        // that grows a line when they do gives five portraits three different
        // heights, and shifts them all again at every fight boundary
        const meter = meterText({ name: 'A', damage: 98000, dps: 239.4 });

        expect(meter.lines).toHaveLength(2);
        expect(meter.lines[0]).toBe('— cur');
        expect(meter.lines[1]).toContain('239');
        expect(meter.lines[1]).toContain('total');
    });

    test('with a fight in progress it is two, this fight first', () => {
        // DPs' order, and the point of it: the fight in front of you is the one
        // you can still change, the run is what you read it against
        const meter = meterText({ name: 'A', damage: 88500, dps: 374 }, { damage: 1900, dps: 1052 });

        expect(meter.lines).toHaveLength(2);
        expect(meter.lines[0]).toContain('cur');
        expect(meter.lines[1]).toContain('total');
        expect(meter.lines[0]).toContain('1,052');
    });

    test('too early for a rate reads as no rate, not as zero', () => {
        const meter = meterText({ name: 'A', damage: 120, dps: null });

        expect(meter.lines[1]).toContain('—');
        expect(meter.lines[1]).not.toContain('0 DPS');
        expect(meter.title).toContain('not yet long enough');
    });
});

describe('putting a meter on the tile', () => {
    /** The players area as the game builds it, with one portrait inside */
    const battlePanel = (name) => {
        document.body.innerHTML = '';
        const area = document.createElement('div');
        area.className = 'BattlePanel_playersArea__9xk2j';
        const unit = portrait(name);
        area.appendChild(unit);
        document.body.appendChild(area);
        return unit;
    };

    const meterOf = (unit) => unit.querySelector('[data-toolasha-portrait-dps]');

    beforeEach(() => {
        opts.position = 'above';
        opts.players = [{ name: 'Millennium44', damage: 20_100, dps: 316 }];
        opts.fight = { players: {}, enemies: {} };
    });

    afterEach(() => portraitDps.cleanup());

    test('the meter is a child of the tile, not hung outside it', () => {
        // The first version positioned it at `top: -14px`, outside the tile's
        // box. The battle panel clips its children, so it drew nothing at all —
        // present in the DOM and cropped away.
        const unit = battlePanel('Millennium44');
        portraitDps.initialize();

        const meter = meterOf(unit);
        expect(meter).not.toBeNull();
        expect(meter.style.position).not.toBe('absolute');
        expect(meter.textContent).toContain('316');
    });

    test('above puts it first, below puts it last', () => {
        const unit = battlePanel('Millennium44');
        portraitDps.initialize();
        expect(unit.firstElementChild).toBe(meterOf(unit));

        opts.position = 'below';
        portraitDps.redraw();
        expect(unit.lastElementChild).toBe(meterOf(unit));
    });

    test('a redraw does not leave two', () => {
        const unit = battlePanel('Millennium44');
        portraitDps.initialize();
        portraitDps.redraw();
        portraitDps.redraw();

        expect(unit.querySelectorAll('[data-toolasha-portrait-dps]')).toHaveLength(1);
    });

    test('a portrait with nobody to match gets no meter', () => {
        const unit = battlePanel('Stranger');
        portraitDps.initialize();

        expect(meterOf(unit)).toBeNull();
    });
});

describe('a rate on the monsters', () => {
    test('per slot, so two of the same monster differ', () => {
        // Averaging by name would put one number on both tiles that was true of
        // neither — which is the whole reason enemies are keyed by slot for a
        // fight and by name for a run
        expect(enemyMeterText({ name: 'Veyes', damage: 987, dps: 493 }).text).toBe('493/s');
        expect(enemyMeterText({ name: 'Veyes', damage: 1188, dps: 594 }).text).toBe('594/s');
    });

    test('too early for a rate is a dash', () => {
        expect(enemyMeterText({ name: 'Eye', damage: 40, dps: null }).text).toBe('—');
    });
});

describe('drawing on the monster tiles', () => {
    const monstersArea = (count) => {
        document.body.innerHTML = '';
        const area = document.createElement('div');
        area.className = 'BattlePanel_monstersArea__7z1k';
        for (let i = 0; i < count; i++) area.appendChild(portrait('Veyes'));
        document.body.appendChild(area);
        return [...area.children];
    };

    afterEach(() => portraitDps.cleanup());

    test('each tile gets its own slot’s rate', () => {
        const tiles = monstersArea(2);
        opts.players = [];
        opts.fight = {
            players: {},
            enemies: { 0: { name: 'Veyes', damage: 987, dps: 493 }, 1: { name: 'Veyes', damage: 1188, dps: 594 } },
        };

        portraitDps.initialize();

        expect(tiles[0].textContent).toContain('493/s');
        expect(tiles[1].textContent).toContain('594/s');
    });

    test('a tile with no slot in the fight gets nothing', () => {
        const tiles = monstersArea(2);
        opts.players = [];
        opts.fight = { players: {}, enemies: { 0: { name: 'Veyes', damage: 987, dps: 493 } } };

        portraitDps.initialize();

        expect(tiles[1].querySelector('[data-toolasha-portrait-dps]')).toBeNull();
    });
});
