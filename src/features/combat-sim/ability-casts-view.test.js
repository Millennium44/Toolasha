import { describe, test, expect } from 'vitest';
import { abilityCastRows, abilityCastsHtml } from './ability-casts-view.js';

const gameData = {
    abilityDetailMap: {
        '/abilities/quick_aid': { name: 'Quick Aid' },
        '/abilities/fireball': { name: 'Fireball' },
    },
};
const styles = { rowStyle: 'r', labelStyle: 'l', valueStyle: 'v' };

describe('abilityCastRows', () => {
    test('rates are per simulated hour, busiest first, never-cast last', () => {
        const rows = abilityCastRows(
            { '/abilities/quick_aid': 0, '/abilities/fireball': 600, '/abilities/unknown_one': 30 },
            2,
            gameData
        );
        expect(rows.map((r) => [r.name, r.casts, r.perHour])).toEqual([
            ['Fireball', 600, 300],
            ['unknown one', 30, 15],
            ['Quick Aid', 0, 0],
        ]);
    });

    test('no counts and no hours do not divide by zero', () => {
        expect(abilityCastRows({}, 1, gameData)).toEqual([]);
        expect(abilityCastRows({ '/abilities/fireball': 5 }, 0, gameData)[0].perHour).toBe(0);
    });
});

describe('abilityCastsHtml', () => {
    test('an ability with 0 casts is flagged "never cast" and one with casts shows its rate', () => {
        const html = abilityCastsHtml({ '/abilities/quick_aid': 0, '/abilities/fireball': 720 }, 1, gameData, styles);
        expect(html).toContain('never cast');
        expect(html).toContain('720');
        expect(html.indexOf('Fireball')).toBeLessThan(html.indexOf('Quick Aid'));
    });

    test('nothing to show returns an empty string', () => {
        expect(abilityCastsHtml({}, 1, gameData, styles)).toBe('');
    });
});
