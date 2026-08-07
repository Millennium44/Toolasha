/**
 * The combat scrolls the sim can carry.
 *
 * The values are read off the game's own item tooltips; what this guards is that
 * each lands on the boost slot the combat engine actually reads for its buff type
 * — damage and attack speed as ratio boosts, the rest flat — because a value on
 * the wrong slot is silently ignored by the engine and would sim as no buff.
 */

import { describe, test, expect } from 'vitest';
import {
    COMBAT_SCROLLS,
    COMBAT_SCROLL_BUFF_TYPES,
    COMBAT_SCROLL_LABELS,
    combatScrollBuff,
} from './combat-scroll-buffs.js';

describe('combat scroll catalog', () => {
    test('offers the seven combat scrolls', () => {
        expect(COMBAT_SCROLL_BUFF_TYPES).toEqual([
            '/buff_types/damage',
            '/buff_types/attack_speed',
            '/buff_types/cast_speed',
            '/buff_types/critical_rate',
            '/buff_types/combat_drop_quantity',
            '/buff_types/wisdom',
            '/buff_types/rare_find',
        ]);
    });

    test('labels are keyed by buff type', () => {
        expect(COMBAT_SCROLL_LABELS['/buff_types/damage']).toBe('Scroll of Damage (+8%)');
        expect(COMBAT_SCROLL_LABELS['/buff_types/rare_find']).toBe('Scroll of Rare Find (+60%)');
    });

    test('every catalog entry declares a ratio or flat slot and a value', () => {
        for (const scroll of COMBAT_SCROLLS) {
            expect(['ratioBoost', 'flatBoost']).toContain(scroll.valueKey);
            expect(scroll.value).toBeGreaterThan(0);
        }
    });
});

describe('combatScrollBuff', () => {
    test('damage and attack speed are ratio boosts', () => {
        expect(combatScrollBuff('/buff_types/damage')).toMatchObject({ ratioBoost: 0.08, flatBoost: 0 });
        expect(combatScrollBuff('/buff_types/attack_speed')).toMatchObject({ ratioBoost: 0.15, flatBoost: 0 });
    });

    test('cast speed, crit, combat drop, wisdom and rare find are flat boosts', () => {
        expect(combatScrollBuff('/buff_types/cast_speed')).toMatchObject({ flatBoost: 0.15, ratioBoost: 0 });
        expect(combatScrollBuff('/buff_types/critical_rate')).toMatchObject({ flatBoost: 0.1, ratioBoost: 0 });
        expect(combatScrollBuff('/buff_types/combat_drop_quantity')).toMatchObject({ flatBoost: 0.15, ratioBoost: 0 });
        expect(combatScrollBuff('/buff_types/wisdom')).toMatchObject({ flatBoost: 0.2, ratioBoost: 0 });
        expect(combatScrollBuff('/buff_types/rare_find')).toMatchObject({ flatBoost: 0.6, ratioBoost: 0 });
    });

    test('carries the permanent-buff shape the engine expects', () => {
        const buff = combatScrollBuff('/buff_types/damage');
        expect(buff).toMatchObject({
            uniqueHrid: '/buff_uniques/toolasha_scroll_damage',
            typeHrid: '/buff_types/damage',
            ratioBoostLevelBonus: 0,
            flatBoostLevelBonus: 0,
            duration: 0,
        });
    });

    test('an unknown buff type yields nothing', () => {
        expect(combatScrollBuff('/buff_types/gourmet')).toBeNull();
        expect(combatScrollBuff('nonsense')).toBeNull();
    });
});
