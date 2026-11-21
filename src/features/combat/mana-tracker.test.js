import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    manaTracker: true,
    abilityDetailMap: {},
    handlers: {},
    dataManagerHandlers: {},
    characterId: 'char1',
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => (key === 'manaTracker' ? game.manaTracker : false) },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: game.abilityDetailMap }),
        getCurrentCharacterId: () => game.characterId,
        on: (event, handler) => {
            game.dataManagerHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dataManagerHandlers[event] === handler) delete game.dataManagerHandlers[event];
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.handlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.handlers[event] === handler) delete game.handlers[event];
        },
    },
}));

// The panel prices items through this, which drags in the market API and its socket
vi.mock('../../utils/profit-helpers.js', () => ({ resolveItemPrice: () => ({ price: null }) }));

const { buildBattleConsumableAbilityUpdated } =
    await import('../../__fixtures__/wire/battle-consumable-ability-updated.js');
const manaTracker = (await import('./mana-tracker.js')).default;
const { resetManaTally, manaSpend, abilityLabel, manaRefusals } = await import('./mana-tracker.js');
const { buildNewBattle } = await import('../../__fixtures__/wire/new-battle.js');
const { buildBattleUpdated } = await import('../../__fixtures__/wire/battle-updated.js');

describe('mana tracker wiring', () => {
    beforeEach(() => {
        game.manaTracker = true;
        game.abilityDetailMap = {};
        game.handlers = {};
        game.dataManagerHandlers = {};
        game.characterId = 'char1';
        resetManaTally();
        manaTracker.cleanup();
    });

    test('disabled by setting, initialize registers nothing', () => {
        game.manaTracker = false;
        manaTracker.initialize();

        expect(game.handlers['new_battle']).toBeUndefined();
        expect(game.handlers['battle_consumable_ability_updated']).toBeUndefined();
    });

    test('enabled, initialize subscribes to battle and ability events', () => {
        manaTracker.initialize();

        expect(typeof game.handlers['new_battle']).toBe('function');
        expect(typeof game.handlers['battle_consumable_ability_updated']).toBe('function');
    });

    test('a cast is costed from abilityDetailMap and tallied', () => {
        game.abilityDetailMap['/abilities/entangle'] = { manaCost: 15, name: 'Entangle' };
        manaTracker.initialize();

        game.handlers['new_battle']();
        game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/entangle' });
        game.handlers['battle_consumable_ability_updated'](buildBattleConsumableAbilityUpdated(2));

        const summary = manaSpend();
        expect(summary.fights).toBe(1);
        expect(summary.mana).toBe(30);
        expect(summary.abilities[0].casts).toBe(2);
    });

    test('an ability with no stated cost still counts casts, at zero mana', () => {
        manaTracker.initialize();

        game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/mystery' });

        const summary = manaSpend();
        expect(summary.abilities[0].unknownCost).toBe(true);
        expect(summary.mana).toBe(0);
    });

    test('a spectated guild trial’s casts are ignored', () => {
        // No new_battle ever fires for a trial being watched, so these casts
        // would add mana with no fight to divide it by — inflating
        // Mana/fight and every per-ability share
        game.abilityDetailMap['/abilities/entangle'] = { manaCost: 15 };
        manaTracker.initialize();

        game.handlers['battle_consumable_ability_updated'](
            buildBattleConsumableAbilityUpdated(0, { isGuildBattle: true })
        );

        expect(manaSpend().abilities).toHaveLength(0);
        expect(manaSpend().mana).toBe(0);
    });

    test('a malformed ability payload is ignored rather than crashing', () => {
        manaTracker.initialize();

        expect(() => game.handlers['battle_consumable_ability_updated']({})).not.toThrow();
        expect(() => game.handlers['battle_consumable_ability_updated']({ ability: 42 })).not.toThrow();
        expect(manaSpend().abilities).toHaveLength(0);
    });

    test('cleanup unregisters both listeners', () => {
        manaTracker.initialize();
        manaTracker.cleanup();

        expect(game.handlers['new_battle']).toBeUndefined();
        expect(game.handlers['battle_consumable_ability_updated']).toBeUndefined();
    });

    test('a character switch starts the count over, rather than blending the next character into it', () => {
        // rotation-tracker.js resets its own running state on the same event
        // for the same reason: a mid-run tally is only meaningful for the
        // character it was measured on, and carrying it across a switch mislabels
        // the arriving character's mana spend as including the departing one's.
        game.abilityDetailMap['/abilities/entangle'] = { manaCost: 15 };
        manaTracker.initialize();
        game.handlers['new_battle']();
        game.handlers['battle_consumable_ability_updated'](buildBattleConsumableAbilityUpdated());
        expect(manaSpend().mana).toBe(15);

        game.dataManagerHandlers['character_switching']?.();

        expect(manaSpend().fights).toBe(0);
        expect(manaSpend().mana).toBe(0);
    });

    test('a switch made while disabled clears what the previous character left behind', () => {
        game.abilityDetailMap['/abilities/entangle'] = { manaCost: 15 };
        manaTracker.initialize();
        game.handlers['new_battle']();
        game.handlers['battle_consumable_ability_updated'](buildBattleConsumableAbilityUpdated());
        manaTracker.cleanup();

        game.characterId = 'char2';
        manaTracker.initialize();

        expect(manaSpend().fights).toBe(0);
        expect(manaSpend().mana).toBe(0);
    });

    test('the same character re-enabling keeps the tally', () => {
        game.abilityDetailMap['/abilities/entangle'] = { manaCost: 15 };
        manaTracker.initialize();
        game.handlers['new_battle']();
        game.handlers['battle_consumable_ability_updated'](buildBattleConsumableAbilityUpdated());
        manaTracker.cleanup();

        manaTracker.initialize();

        expect(manaSpend().fights).toBe(1);
        expect(manaSpend().mana).toBe(15);
    });

    test('resetManaTally starts the count over', () => {
        game.abilityDetailMap['/abilities/entangle'] = { manaCost: 15 };
        manaTracker.initialize();
        game.handlers['new_battle']();
        game.handlers['battle_consumable_ability_updated'](buildBattleConsumableAbilityUpdated());

        resetManaTally();

        expect(manaSpend().fights).toBe(0);
        expect(manaSpend().mana).toBe(0);
    });
});

describe('abilityLabel', () => {
    beforeEach(() => {
        game.abilityDetailMap = {};
    });

    test('uses the game-supplied name when the ability is known', () => {
        game.abilityDetailMap['/abilities/entangle'] = { name: 'Entangle' };
        expect(abilityLabel('/abilities/entangle')).toBe('Entangle');
    });

    test('falls back to a de-slugged hrid tail for an unknown ability', () => {
        expect(abilityLabel('/abilities/arcane_burst')).toBe('arcane burst');
    });

    test('an empty hrid does not throw', () => {
        expect(abilityLabel('')).toBe('');
        expect(abilityLabel(undefined)).toBe('');
    });
});

describe('refused casts on the mana tracker', () => {
    const DRAIN = '/abilities/life_drain';

    /** The fixture battle, this character in slot 0 preparing Life Drain with 500 mana */
    function battle() {
        const data = buildNewBattle();
        const player = data.players[0];
        player.combatAbilities = [{ abilityHrid: DRAIN, level: 1 }];
        player.combatDetails.combatStats.abilityHaste = 0;
        player.currentManapoints = 500;
        player.attackAttemptCounter = 10;
        player.isPreparingAutoAttack = false;
        player.preparingAbilityHrid = DRAIN;
        return data;
    }

    /** A tick for slot 0: the counter, the bar, and an auto attack being prepared */
    function tick(counter, mana, extra = {}) {
        const data = buildBattleUpdated(1, extra);
        const entry = data.pMap[0];
        entry.atkCounter = counter;
        entry.cMP = mana;
        delete entry.abilityHrid;
        entry.isAutoAtk = true;
        return data;
    }

    beforeEach(() => {
        game.manaTracker = true;
        game.abilityDetailMap = { [DRAIN]: { manaCost: 100, cooldownDuration: 10e9, name: 'Life Drain' } };
        game.handlers = {};
        game.dataManagerHandlers = {};
        game.characterId = 900001;
        resetManaTally();
        manaTracker.cleanup();
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });

    afterEach(() => {
        manaTracker.cleanup();
        vi.useRealTimers();
    });

    test('an auto attack while Life Drain is ready and unaffordable is counted, and Reset clears it', () => {
        manaTracker.initialize();
        game.handlers['new_battle'](battle());
        game.handlers['battle_updated'](tick(11, 30));
        vi.setSystemTime(11_000);
        game.handlers['battle_updated'](tick(12, 30));

        expect(manaRefusals()).toEqual({ turns: 1, abilities: [{ abilityHrid: DRAIN, refused: 1 }] });
        resetManaTally();
        expect(manaRefusals().turns).toBe(0);
    });

    test('a watched guild trial and a battle nothing announced count nothing', () => {
        manaTracker.initialize();
        game.handlers['new_battle'](battle());
        game.handlers['battle_updated'](tick(11, 30));
        vi.setSystemTime(11_000);
        game.handlers['battle_updated'](tick(12, 30, { isGuildBattle: true }));
        // Another battle's ticks: the first is only a baseline
        game.handlers['battle_updated'](tick(500, 30, { battleId: 99 }));
        expect(manaRefusals().turns).toBe(0);
    });

    test('a character switch starts the count again', () => {
        manaTracker.initialize();
        game.handlers['new_battle'](battle());
        game.handlers['battle_updated'](tick(11, 30));
        vi.setSystemTime(11_000);
        game.handlers['battle_updated'](tick(12, 30));
        expect(manaRefusals().turns).toBe(1);

        game.dataManagerHandlers['character_switching']();
        expect(manaRefusals().turns).toBe(0);
    });
});
