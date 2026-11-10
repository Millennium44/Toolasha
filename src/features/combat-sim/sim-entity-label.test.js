/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetSpriteSheetCache } from '../../utils/overlay-format.js';
import { simEntityIconHtml, simEntityLabelHtml, simSkillHrid, simScrollItemHrid } from './sim-entity-label.js';

const game = vi.hoisted(() => ({ actions: {} }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ actionDetailMap: game.actions }) },
}));

function render(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
}

beforeEach(() => {
    resetSpriteSheetCache();
    game.actions = { '/actions/combat/golem_cave': {}, '/actions/combat/chimerical_den': {} };
    document.body.innerHTML = ['actions', 'combat_monsters', 'abilities', 'skills', 'items', 'misc']
        .map((sheet) => `<svg><use xlink:href="/static/media/${sheet}_sprite.current.svg#seed"></use></svg>`)
        .join('');
});
afterEach(() => {
    document.body.innerHTML = '';
    resetSpriteSheetCache();
});

describe('simulator entity artwork', () => {
    test('Promote has no native ability icon and remains text-only even with a loaded ability sheet', () => {
        const host = render(simEntityLabelHtml('/abilities/promote', 'Promote L75'));
        expect(host.textContent).toBe('Promote L75');
        expect(host.children).toHaveLength(0);
        expect(simEntityIconHtml('/abilities/promote')).toBe('');
    });
    test.each([
        ['/actions/combat/golem_cave', 'actions', 'zone', '石像鬼洞窟 T5'],
        ['/actions/combat/chimerical_den', 'actions', 'zone', '[D] Chimerical Den T2'],
        ['/monsters/rat', 'combat_monsters', 'monster', 'Jerry'],
        ['/monsters/mimic', 'combat_monsters', 'monster', 'Mimic L130'],
        ['/abilities/water_strike', 'abilities', 'ability', 'Water Strike Lv75'],
        ['/skills/alchemy', 'skills', 'skill', '炼金术'],
        ['/items/cheese', 'items', 'item', 'Cheese'],
    ])('uses identity %s rather than the translated/displayed name', (hrid, sheet, type, name) => {
        const host = render(simEntityLabelHtml(hrid, name));
        expect(host.textContent).toBe(name);
        expect(host.querySelector('use').getAttribute('href')).toBe(
            `/static/media/${sheet}_sprite.current.svg#${hrid.split('/').pop()}`
        );
        expect(host.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
        expect(host.querySelector('svg').getAttribute('focusable')).toBe('false');
        expect(
            host.querySelector('svg').getAttribute(type === 'item' ? 'data-sim-item-icon' : 'data-sim-entity-icon')
        ).toBe(hrid);
    });

    test.each([
        null,
        '',
        'regen',
        '/buffs/luck',
        '/actions/foraging/egg',
        '/monsters/rat#fly',
        '/abilities/a"><img src=x>',
    ])('keeps unsupported or malformed %s as escaped text without invented artwork', (hrid) => {
        const host = render(simEntityLabelHtml(hrid, '<img src=x> & "unknown"'));
        expect(host.textContent).toBe('<img src=x> & "unknown"');
        expect(host.children).toHaveLength(0);
        expect(simEntityIconHtml(hrid)).toBe('');
    });

    test('missing artwork reserves space, and late-arriving game assets work on the next render', () => {
        document.body.innerHTML = '';
        const first = render(simEntityLabelHtml('/abilities/water_strike', 'Water Strike'));
        expect(first.querySelector('svg')).toBeNull();
        expect(first.querySelector('span').style.width).toBe('18px');
        expect(first.textContent).toBe('Water Strike');
        document.body.innerHTML = '<svg><use href="/static/media/abilities_sprite.new.svg#heal"></use></svg>';
        const next = render(simEntityLabelHtml('/abilities/water_strike', 'Water Strike'));
        expect(next.querySelector('use').getAttribute('href')).toBe(
            '/static/media/abilities_sprite.new.svg#water_strike'
        );
    });

    test('same-name monsters keep separate identities and do not mutate labels', () => {
        const first = render(simEntityLabelHtml('/monsters/rat', 'Same name'));
        const second = render(simEntityLabelHtml('/monsters/frog', 'Same name'));
        expect(first.textContent).toBe(second.textContent);
        expect(first.querySelector('use').getAttribute('href')).not.toBe(
            second.querySelector('use').getAttribute('href')
        );
    });
});

describe('native house, shrine and single-monster zone artwork', () => {
    test.each([
        ['/house_rooms/dojo', 'house_dojo'],
        ['/house_rooms/dairy_barn', 'house_dairy_barn'],
        ['/guild_shrines/force', 'guild_shrine_force'],
        ['/guild_shrines/scholar', 'guild_shrine_scholar'],
    ])('uses the native misc-sheet mapping for %s', (hrid, fragment) => {
        const host = render(simEntityLabelHtml(hrid, 'Same display name'));
        expect(host.querySelector('use').getAttribute('href')).toBe(
            `/static/media/misc_sprite.current.svg#${fragment}`
        );
        expect(host.textContent).toBe('Same display name');
    });
    test('single-spawn zones use the explicit monster, including a differently named action', () => {
        game.actions['/actions/combat/jerry'] = {
            combatZoneInfo: {
                fightInfo: { randomSpawnInfo: { spawns: [{ combatMonsterHrid: '/monsters/rat', difficultyTier: 4 }] } },
            },
        };
        const host = render(simEntityLabelHtml('/actions/combat/jerry', 'Jerry T4'));
        expect(host.querySelector('use').getAttribute('href')).toBe(
            '/static/media/combat_monsters_sprite.current.svg#rat'
        );
        expect(host.querySelector('[data-sim-entity-icon]').dataset.simEntityIcon).toBe('/actions/combat/jerry');
        expect(host.textContent).toBe('Jerry T4');
    });
    test('unknown actions and malformed spawn identities do not guess an action icon', () => {
        expect(simEntityIconHtml('/actions/combat/unknown')).toBe('');
        game.actions['/actions/combat/broken'] = {
            combatZoneInfo: { fightInfo: { randomSpawnInfo: { spawns: [{}] } } },
        };
        expect(simEntityIconHtml('/actions/combat/broken')).toBe('');
    });
    test.each(['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'])(
        'combat %s uses its stable skill identity',
        (skill) => {
            expect(simSkillHrid(`${skill}Level`)).toBe(`/skills/${skill}`);
        }
    );
    test('unknown skill fields stay unsupported, and scroll IDs retain the historical seal namespace', () => {
        expect(simSkillHrid('unknownLevel')).toBeNull();
        expect(simScrollItemHrid('/buff_types/combat_drop_quantity')).toBe('/items/seal_of_combat_drop');
        expect(simScrollItemHrid('/buff_types/damage')).toBe('/items/seal_of_damage');
        expect(simScrollItemHrid('/buff_types/wisdom')).toBe('/items/seal_of_wisdom');
        expect(simScrollItemHrid('/buff_types/unknown')).toBeNull();
        expect(simScrollItemHrid('toString')).toBeNull();
    });
});
