/**
 * Tests for the skill level-up alert.
 *
 * The level comes off `skills_updated`, which republishes the whole skill array
 * every time, so the cases that matter are the ones where a level did not
 * actually rise: the login seed, an unchanged republish, and a reseed to a
 * lower level after a character switch.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    settings: {},
    skills: [],
    dmHandlers: {},
    notified: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => (Array.isArray(game.skills) ? [...game.skills] : null),
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));
vi.mock('./notification-service.js', () => ({
    default: {
        notify: (key, message, options) => {
            game.notified.push({ key, message, options });
            return { fired: true, channels: ['toast'] };
        },
    },
}));

const { default: skillLevelUpAlerts, MASTER_SETTING } = await import('./skill-level-up-alerts.js');

/** A `characterSkills`-shaped array from `[hrid, level]` pairs */
function skills(...pairs) {
    return pairs.map(([skillHrid, level]) => ({ skillHrid, level, experience: 0 }));
}

const send = (arr) => game.dmHandlers.skills_updated({ characterSkills: arr });

describe('skill level-up alerts', () => {
    beforeEach(async () => {
        game.settings = { [MASTER_SETTING]: true };
        game.skills = skills(['/skills/cooking', 40], ['/skills/mining', 10]);
        game.dmHandlers = {};
        game.notified = [];
        skillLevelUpAlerts.disable();
        await skillLevelUpAlerts.initialize();
    });

    afterEach(() => {
        skillLevelUpAlerts.disable();
    });

    test('the master switch off wires nothing at all', async () => {
        skillLevelUpAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        await skillLevelUpAlerts.initialize();

        expect(game.dmHandlers.skills_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });

    test('a level that rises above the seed is announced with skill and level', () => {
        send(skills(['/skills/cooking', 41], ['/skills/mining', 10]));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('You reached level 41 Cooking!');
        expect(game.notified[0].options.title).toBe('Level up');
    });

    test('the levels present at login are the baseline, not level-ups', () => {
        send(skills(['/skills/cooking', 40], ['/skills/mining', 10]));

        expect(game.notified).toHaveLength(0);
    });

    test('a skill unseen at seed that arrives is a baseline, not a level-up', () => {
        send(skills(['/skills/cooking', 40], ['/skills/mining', 10], ['/skills/foraging', 5]));

        expect(game.notified).toHaveLength(0);
    });

    test('a skill unseen at seed then rising is announced once it does', () => {
        send(skills(['/skills/foraging', 5]));
        send(skills(['/skills/foraging', 6]));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('You reached level 6 Foraging!');
    });

    test('an unchanged republish says nothing', () => {
        send(skills(['/skills/cooking', 41]));
        send(skills(['/skills/cooking', 41]));

        expect(game.notified).toHaveLength(1);
    });

    test('each level gained gets its own event key so the service cannot swallow it', () => {
        send(skills(['/skills/cooking', 41]));
        send(skills(['/skills/cooking', 42]));

        expect(game.notified.map((entry) => entry.key)).toEqual([
            'skill-levelup:/skills/cooking:41',
            'skill-levelup:/skills/cooking:42',
        ]);
    });

    test('a reseed to a lower level re-baselines instead of announcing', () => {
        send(skills(['/skills/cooking', 42]));
        send(skills(['/skills/cooking', 20]));

        // Only the 40 -> 42 climb counts; the drop is a new baseline
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('42');
    });

    test('the master switch is re-checked per message, not only at initialize', () => {
        game.settings[MASTER_SETTING] = false;
        send(skills(['/skills/cooking', 41]));

        expect(game.notified).toHaveLength(0);
    });

    test('a character switch tears the listeners down and forgets the levels', () => {
        game.dmHandlers.character_switching();

        expect(game.dmHandlers.skills_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });
});

describe('settings schema backs the level-up alert', () => {
    test('the switch exists and is off until asked for', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
    });
});
