/** @vitest-environment happy-dom */

/**
 * The Guild Trials tile.
 *
 * The whole reason this tile is difficult is that its data is not live: it comes
 * off the guild panel's In Progress tab and stops the moment that tab closes. So
 * the tests that matter are the honesty ones — that the age of the reading is on
 * the tile itself rather than buried in a tooltip, and that a record older than
 * the hour a trial runs for stops projecting a pace instead of confidently
 * describing an event that has ended.
 *
 * `analyseTrial` is the real one. Mocking it would leave the one thing this
 * tile actually does — pick the newest tile out of the record and hand it over —
 * tested against a stub that agrees with whatever it is given.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ rows: {}, record: null }));

vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
}));

vi.mock('./guild-trials.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        guildTrials: {
            get record() {
                return game.record;
            },
        },
    };
});

const { latestTrialTile, STALE_MS } = await import('./guild-trials-row.js');

/**
 * A tile record, as `recordTileSample` builds one.
 *
 * The readings are a skilling pool: one number rising towards a maximum, which
 * is the shape `analyseTrial` fits a fill rate to.
 *
 * @param {Object} input - Inputs
 * @param {string} input.name - Trial name
 * @param {number} input.tier - Tier in progress
 * @param {number} input.at - When the newest sample was taken
 * @param {Array<number>} [input.values] - Pool readings, oldest first
 * @param {number} [input.max] - The tier's total
 * @returns {Object} A tile record
 */
function tile({ name, tier, at, values = [0, 5000], max = 10_000 }) {
    const spacing = 60_000;
    return {
        name,
        kind: 'skilling',
        level: 100 + (tier - 1) * 10,
        tier,
        // A card states points once it has banked a tier, which is what makes
        // its badge a count of finished tiers rather than the one in progress
        pointsByTier: { [tier]: 600 },
        samples: values.map((current, index) => ({
            t: at - (values.length - 1 - index) * spacing,
            readings: [{ current, max }],
        })),
        tiers: [
            { tier, total: max },
            { tier: tier - 1, total: max / 2 },
        ],
    };
}

/**
 * Draw the tile into a fresh container.
 * @returns {HTMLElement} The container
 */
function draw() {
    const container = document.createElement('div');
    game.rows.guildTrialsPace.render(container);
    return container;
}

describe('the guild trials tile', () => {
    beforeEach(() => {
        game.record = null;
    });

    test('registers, off by default', () => {
        expect(game.rows.guildTrialsPace).toBeDefined();
        expect(game.rows.guildTrialsPace.defaultVisible).toBe(false);
    });

    test('has nothing to open — the detail behind it is a page of the game', () => {
        expect(typeof game.rows.guildTrialsPace.onOpen).not.toBe('function');
    });

    test('draws nothing before any trial has been looked at', () => {
        expect(draw().textContent).toBe('');

        game.record = { weekStart: 0, tiles: {} };
        expect(draw().textContent).toBe('');
    });

    test('a tile with no samples in it is not a reading', () => {
        game.record = {
            weekStart: 0,
            tiles: { 'skilling::brewing': { name: 'Brewing', kind: 'skilling', samples: [] } },
        };

        expect(latestTrialTile(game.record)).toBeNull();
        expect(draw().textContent).toBe('');
    });

    test('the newest reading is the one shown, whichever trial it belongs to', () => {
        const now = Date.now();
        game.record = {
            weekStart: 0,
            tiles: {
                'skilling::brewing': tile({ name: 'Brewing', tier: 3, at: now - 30 * 60_000 }),
                'combat::badger': tile({ name: 'Badger', tier: 7, at: now - 60_000 }),
            },
        };

        expect(latestTrialTile(game.record).tile.name).toBe('Badger');
        // The badge counts banked tiers, so the tile shows the one being fought
        expect(draw().textContent).toContain('T8');
    });

    test('the age of the reading is on the tile, not only in the tooltip', () => {
        game.record = { weekStart: 0, tiles: { a: tile({ name: 'Brewing', tier: 4, at: Date.now() - 2 * 3600_000 }) } };

        const container = draw();
        expect(container.textContent).toContain('2h ago');
        expect(container.title).toContain('open the guild In Progress tab to refresh');
    });

    test('a fresh reading projects when the tier in progress clears', () => {
        const now = Date.now();
        // Half the pool filled over a minute, so the other half takes another
        game.record = {
            weekStart: 0,
            tiles: { a: tile({ name: 'Brewing', tier: 4, at: now - 10_000, values: [0, 5000], max: 10_000 }) },
        };

        const container = draw();
        expect(container.textContent).toContain('1m');
        expect(container.title).toContain('this tier clears in');
    });

    test('a reading older than the trial itself stops projecting, and says why', () => {
        const now = Date.now();
        game.record = {
            weekStart: 0,
            tiles: { a: tile({ name: 'Brewing', tier: 4, at: now - STALE_MS - 60_000 }) },
        };

        const container = draw();
        expect(container.textContent).toContain('stale');
        expect(container.title).toContain('older than the hour a trial runs for');
    });

    test('a single reading says it is still measuring, rather than showing a dash', () => {
        // A trial that started thirty seconds ago has one reading, and a dash is
        // what this tile shows for a trial it knows nothing about at all. The
        // first half-minute of every trial looked like a broken tile.
        game.record = {
            weekStart: 0,
            tiles: { a: tile({ name: 'Brewing', tier: 4, at: Date.now() - 5000, values: [4000] }) },
        };

        const container = draw();
        expect(container.textContent).toContain('T5');
        expect(container.textContent).toContain('measuring…');
        expect(container.title).toContain('One reading so far');
    });

    test('two readings that did not move is a different answer from one reading', () => {
        // Nothing was gained in a minute, which is a fact about the trial rather
        // than a measurement still in progress
        game.record = {
            weekStart: 0,
            tiles: { a: tile({ name: 'Brewing', tier: 4, at: Date.now() - 5000, values: [4000, 4000] }) },
        };

        const container = draw();
        expect(container.textContent).not.toContain('measuring…');
        expect(container.title).toContain('Not enough movement');
    });

    test('the tier and what is banked are both said, since they differ by one', () => {
        game.record = { weekStart: 0, tiles: { a: tile({ name: 'Brewing', tier: 4, at: Date.now() - 5000 }) } };

        expect(draw().title).toContain('4 banked');
    });
});
