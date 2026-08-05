/** @vitest-environment happy-dom */

/**
 * The "Iron Bell next step" overlay tile.
 *
 * Mirrors the pattern in `networth-rows.test.js`: mock the registry to capture
 * what gets registered, mock the feature the tile reads from (here, the panel
 * singleton) rather than the tile itself, and drive `render` directly.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const panel = vi.hoisted(() => ({ overrides: {}, loop: null, toggles: 0 }));
const plan = vi.hoisted(() => ({ state: null }));

const rows = vi.hoisted(() => ({}));

vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        rows[definition.key] = definition;
    },
}));

vi.mock('./ironcow-runtime.js', () => ({
    default: {
        get overrides() {
            return panel.overrides;
        },
        get loop() {
            return panel.loop;
        },
        toggle: () => {
            panel.toggles += 1;
        },
    },
}));

vi.mock('./ironcow-plan.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        readCharacterState: () => {
            if (plan.state instanceof Error) throw plan.state;
            return plan.state;
        },
    };
});

const { formatLargeNumber } = await import('../../utils/formatters.js');
await import('./ironcow-overlay-row.js');

/** A character part-way through the plan, as `readCharacterState` returns one */
function character(overrides = {}) {
    return {
        levels: { milking: 80, woodcutting: 80, cheesesmithing: 80, foraging: 80, alchemy: 65, crafting: 34 },
        held: new Set(),
        rooms: {},
        coins: 10_000_000,
        queueLength: 3,
        gameMode: 'ironcow',
        alchemyTarget: 65,
        alchemyTargetAssumed: false,
        ...overrides,
    };
}

/**
 * Draw the tile into a fresh container.
 * @returns {HTMLElement} The container it drew into
 */
function draw() {
    const container = document.createElement('div');
    rows.ironBellNextStep.render(container);
    return container;
}

beforeEach(() => {
    panel.overrides = {};
    panel.loop = null;
    panel.toggles = 0;
    plan.state = character();
});

describe('registration', () => {
    test('registers, off by default', () => {
        expect(rows.ironBellNextStep).toBeDefined();
        expect(rows.ironBellNextStep.defaultVisible).toBe(false);
    });

    test('opening it toggles the panel', () => {
        rows.ironBellNextStep.onOpen();
        expect(panel.toggles).toBe(1);
    });
});

describe('who it draws for', () => {
    test('draws nothing when game data has not loaded', () => {
        plan.state = null;
        expect(draw().textContent).toBe('');
    });

    test('draws nothing for a character that is not an iron cow', () => {
        plan.state = character({ gameMode: 'standard' });
        expect(draw().textContent).toBe('');
    });

    test('draws nothing, rather than throwing, when reading the character fails', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        plan.state = new Error('half-loaded');
        expect(draw().textContent).toBe('');
        vi.restoreAllMocks();
    });
});

describe('what it says', () => {
    test('names the blocking stage while the loop is not ready', () => {
        plan.state = character({ levels: { ...character().levels, foraging: 62 } });
        expect(draw().textContent).toBe('Foraging 62/80');
    });

    test('names alchemy when foraging is done but alchemy is not', () => {
        plan.state = character({ levels: { ...character().levels, alchemy: 40 } });
        expect(draw().textContent).toBe('Alchemy 40/65');
    });

    test('says the loop is ready once foraging and alchemy are both done', () => {
        expect(draw().textContent).toBe('Loop ready');
    });

    test('adds the going rate once the loop has been costed', () => {
        panel.loop = { bells: { perWeek: 41_234 } };
        expect(draw().textContent).toBe(`Loop ready — ${formatLargeNumber(41_234)} bells/week`);
    });

    test('a costed loop with nothing in bells still just says the loop is ready', () => {
        panel.loop = { bells: null };
        expect(draw().textContent).toBe('Loop ready');
    });

    test('says what double-clicking does', () => {
        expect(draw().title).toContain('Double-click to open the panel');
    });
});
