/**
 * @vitest-environment happy-dom
 *
 * The summary is arithmetic (revenue, exp/hour, encounters/hour) glued onto a
 * battle panel that shows up asynchronously, so it is driven the way
 * combat-level-panel.js is: build the panel, fire the WebSocket message, read
 * the injected text back out.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    setting: true,
    marketLoaded: true,
    prices: {},
    wsHandlers: {},
    characterId: 'me-1',
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'combatSummary' ? game.setting : null),
        getSettingValue: (key, fallback) => fallback,
        COLOR_TEXT_PRIMARY: '#fff',
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        isLoaded: () => game.marketLoaded,
        fetch: vi.fn(async () => ({})),
        getPrice: (itemHrid) => game.prices[itemHrid] ?? null,
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.wsHandlers[event] === handler) delete game.wsHandlers[event];
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
    },
}));

const combatSummary = (await import('./combat-summary.js')).default;

/** Build the battle panel shape the feature injects into. */
function buildBattlePanel(combatInfoHTML) {
    document.body.innerHTML = '';
    const gainedExp = document.createElement('div');
    gainedExp.className = 'BattlePanel_gainedExp_x';
    const parent = document.createElement('div');
    parent.appendChild(gainedExp);
    document.body.appendChild(parent);

    if (combatInfoHTML !== null) {
        const combatInfo = document.createElement('div');
        combatInfo.className = 'BattlePanel_combatInfo_x';
        combatInfo.innerHTML = combatInfoHTML;
        document.body.appendChild(combatInfo);
    }
    return parent;
}

function text(id) {
    return document.getElementById(id)?.textContent ?? null;
}

describe('combat summary', () => {
    beforeEach(() => {
        game.setting = true;
        game.marketLoaded = true;
        game.prices = {};
        game.wsHandlers = {};
        combatSummary.disable();
        combatSummary.initialize();
    });

    test('disabled by setting, initialize wires nothing', () => {
        combatSummary.disable();
        game.setting = false;
        combatSummary.initialize();

        expect(game.wsHandlers.battle_unit_fetched).toBeUndefined();
    });

    test('an invalid message is ignored rather than throwing', () => {
        expect(() => game.wsHandlers.battle_unit_fetched(null)).not.toThrow();
        expect(() => game.wsHandlers.battle_unit_fetched({})).not.toThrow();
    });

    test('coins count at face value, other loot at market price, and exp sums across skills', async () => {
        buildBattlePanel('Combat Duration: 1h 0m 0s | Battles: 11 | Deaths: 0');
        game.prices['/items/bones'] = { ask: 10, bid: 8 };

        await game.wsHandlers.battle_unit_fetched({
            unit: {
                totalLootMap: {
                    a: { itemHrid: '/items/coin', count: 500 },
                    b: { itemHrid: '/items/bones', count: 20 },
                },
                totalSkillExperienceMap: { '/skills/attack': 1000, '/skills/defense': 500 },
            },
        });

        // ask: 500 + 20*10 = 700, bid: 500 + 20*8 = 660
        expect(text('mwi-combat-revenue')).toBe('Total revenue: 700 / 660');
        expect(text('mwi-combat-total-exp')).toBe('Total exp: 1.50K');
    });

    test('battle count in the header excludes the battle in progress', async () => {
        // 10 battles over exactly 1 hour → 10/hr encounter rate (11 shown, minus the current one)
        buildBattlePanel('Combat Duration: 1h 0m 0s | Battles: 11 | Deaths: 0');

        await game.wsHandlers.battle_unit_fetched({
            unit: { totalLootMap: {}, totalSkillExperienceMap: {} },
        });

        expect(text('mwi-combat-encounters')).toBe('Encounters/hour: 10.0');
    });

    test('a multi-unit duration (days, hours, minutes, seconds) is parsed correctly', async () => {
        // 1d 1h 1m 1s = 90061s; 91 battles - 1 = 90 encounters; 90/90061*3600 ≈ 3.6
        buildBattlePanel('Combat Duration: 1d 1h 1m 1s | Battles: 91 | Deaths: 0');

        await game.wsHandlers.battle_unit_fetched({
            unit: { totalLootMap: {}, totalSkillExperienceMap: {} },
        });

        expect(text('mwi-combat-encounters')).toBe('Encounters/hour: 3.6');
    });

    test('per-hour and per-day revenue derive from the parsed duration', async () => {
        // 30 minutes, ask revenue 500 -> /hour = 1000, /day = 24000
        buildBattlePanel('Combat Duration: 30m 0s | Battles: 2 | Deaths: 0');
        game.prices['/items/bones'] = { ask: 50, bid: 40 };

        await game.wsHandlers.battle_unit_fetched({
            unit: {
                totalLootMap: { a: { itemHrid: '/items/bones', count: 10 } },
                totalSkillExperienceMap: {},
            },
        });

        expect(text('mwi-combat-revenue')).toBe('Total revenue: 500 / 400');
        expect(text('mwi-combat-revenue-hour')).toBe('Revenue/hour: 1.00K / 800');
        expect(text('mwi-combat-revenue-day')).toBe('Revenue/day: 24.00K / 19.20K');
    });

    test('a zero-second duration is treated as unparseable — no hourly figures at all', async () => {
        buildBattlePanel('Combat Duration: 0s | Battles: 1 | Deaths: 0');

        await game.wsHandlers.battle_unit_fetched({
            unit: { totalLootMap: {}, totalSkillExperienceMap: {} },
        });

        expect(text('mwi-combat-encounters')).toBeNull();
        expect(text('mwi-combat-revenue-hour')).toBeNull();
        expect(text('mwi-combat-total-exp-hour')).toBeNull();
        // The duration-independent totals still show
        expect(document.getElementById('mwi-combat-revenue')).not.toBeNull();
    });

    test('per-skill exp/hour only lists skills that were actually gained', async () => {
        buildBattlePanel('Combat Duration: 1h 0m 0s | Battles: 2 | Deaths: 0');

        await game.wsHandlers.battle_unit_fetched({
            unit: {
                totalLootMap: {},
                totalSkillExperienceMap: { '/skills/attack': 100 },
            },
        });

        const container = document.querySelector('[class*="BattlePanel_gainedExp"]').parentElement;
        expect(container.textContent).toContain('Attack exp/hour: 100');
        expect(container.textContent).not.toContain('Magic exp/hour');
    });

    test('a missing combatInfo element skips duration parsing without throwing', async () => {
        buildBattlePanel(null);

        await game.wsHandlers.battle_unit_fetched({ unit: { totalLootMap: {}, totalSkillExperienceMap: {} } });

        expect(text('mwi-combat-revenue')).toBe('Total revenue: 0 / 0');
    });

    test('stats are injected once — a repeat message does not duplicate them', async () => {
        buildBattlePanel('Combat Duration: 1h 0m 0s | Battles: 2 | Deaths: 0');

        await game.wsHandlers.battle_unit_fetched({
            unit: { totalLootMap: {}, totalSkillExperienceMap: {} },
        });
        await game.wsHandlers.battle_unit_fetched({
            unit: { totalLootMap: {}, totalSkillExperienceMap: {} },
        });

        expect(document.querySelectorAll('#mwi-combat-revenue')).toHaveLength(1);
    });

    test('market data is fetched when not yet loaded, and the summary still renders', async () => {
        game.marketLoaded = false;
        buildBattlePanel('Combat Duration: 1h 0m 0s | Battles: 2 | Deaths: 0');

        await game.wsHandlers.battle_unit_fetched({
            unit: { totalLootMap: {}, totalSkillExperienceMap: {} },
        });

        expect(text('mwi-combat-revenue')).toBe('Total revenue: 0 / 0');
    });

    test('a unit sheet is ignored silently — no warning, no injection', async () => {
        // Clicking a monster mid-fight sends the same message with that unit's
        // resolved stats and no session totals. It is not a summary.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        buildBattlePanel('Combat Duration: 1h 0m 0s | Battles: 2 | Deaths: 0');

        await game.wsHandlers.battle_unit_fetched({
            unit: { hrid: '/monsters/vampire', combatDetails: { maxHitpoints: 1000 } },
        });

        expect(text('mwi-combat-revenue')).toBeNull();
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        warn.mockRestore();
        error.mockRestore();
    });

    test("another player's sheet with their session totals is not a summary", async () => {
        // A trial capture opens dozens of other players' Battle Infos; each
        // carries THAT player's totals and must not draw a revenue block
        buildBattlePanel('Combat Duration: 1h 0m 0s | Battles: 2 | Deaths: 0');

        await game.wsHandlers.battle_unit_fetched({
            unit: {
                character: { id: 'someone-else' },
                totalLootMap: { '/items/coin': { itemHrid: '/items/coin', count: 100 } },
                totalSkillExperienceMap: { '/skills/attack': 50 },
            },
        });

        expect(text('mwi-combat-revenue')).toBeNull();
    });

    test("the player's own sheet, named as theirs, still summarises", async () => {
        buildBattlePanel('Combat Duration: 1h 0m 0s | Battles: 2 | Deaths: 0');

        await game.wsHandlers.battle_unit_fetched({
            unit: {
                character: { id: 'me-1' },
                totalLootMap: { '/items/coin': { itemHrid: '/items/coin', count: 100 } },
                totalSkillExperienceMap: { '/skills/attack': 50 },
            },
        });

        expect(text('mwi-combat-revenue')).toContain('Total revenue');
    });

    test('a unit sheet with no battle panel on screen never starts the panel hunt', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        document.body.innerHTML = '';
        vi.useFakeTimers();

        await game.wsHandlers.battle_unit_fetched({
            unit: { hrid: '/monsters/vampire', combatDetails: { maxHitpoints: 1000 } },
        });
        // Ten retries at 200ms is the whole hunt; none of it should be pending.
        await vi.advanceTimersByTimeAsync(3000);

        expect(error).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        vi.useRealTimers();
        error.mockRestore();
        warn.mockRestore();
    });

    test('disable stops the feature from reacting to further messages', async () => {
        combatSummary.disable();
        buildBattlePanel('Combat Duration: 1h 0m 0s | Battles: 2 | Deaths: 0');

        expect(game.wsHandlers.battle_unit_fetched).toBeUndefined();
    });
});
