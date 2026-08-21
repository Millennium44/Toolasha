/** @vitest-environment happy-dom
 *
 * The weapon that stands for a class.
 *
 * Two things are worth asserting. The first is that the buckets resolve to the
 * right *kind* of thing off game data rather than off a list — every test here
 * builds its own `itemDetailMap`, so a rule that only worked because somebody
 * memorised an hrid fails. The second is the fallback: the icon must vanish
 * rather than draw an empty box when the data is not there, because the panels
 * fall back to their text chip on exactly that answer.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/data-manager.js', () => ({ default: { getInitClientData: () => null } }));

const { CLASS_WEAPON_LEVEL, classWeapon, classTagIcon, classTagIconHTML } = await import('./class-weapon.js');

const TWO_HAND = '/equipment_types/two_hand';
const MAIN_HAND = '/equipment_types/main_hand';
const OFF_HAND = '/equipment_types/off_hand';
const BODY = '/equipment_types/body';

/**
 * One item as `itemDetailMap` carries it.
 * @param {string} name - Display name
 * @param {Object} spec - `{level, type, style, element, threat}`
 * @returns {Object}
 */
const item = (name, { level = 95, type = TWO_HAND, style = '', element = '', threat = 0 } = {}) => ({
    name,
    itemLevel: level,
    equipmentDetail: {
        type,
        combatStats: {
            ...(style ? { combatStyleHrids: [`/combat_styles/${style}`] } : {}),
            ...(element ? { damageType: `/damage_types/${element}` } : {}),
            ...(threat ? { threat } : {}),
        },
    },
});

/** A map with one weapon per bucket, plus the noise a real map has in it */
const DATA = {
    '/items/chimerical_quarterstaff': item('Chimerical Quarterstaff', { style: 'magic', element: 'fire' }),
    '/items/rippling_trident': item('Rippling Trident', { style: 'magic', element: 'water' }),
    '/items/blooming_trident': item('Blooming Trident', { style: 'magic', element: 'nature' }),
    '/items/arcane_wand': item('Arcane Wand', { type: MAIN_HAND, style: 'magic' }),
    '/items/marksman_bow': item('Marksman Bow', { style: 'ranged' }),
    '/items/sinister_chopper': item('Sinister Chopper', { style: 'slash' }),
    '/items/griffin_bulwark': item('Griffin Bulwark', { type: OFF_HAND, threat: 12 }),
    '/items/spiked_bulwark': item('Spiked Bulwark', { level: 75, type: OFF_HAND, threat: 8 }),
    // Noise: armour, a consumable, and the refined variant of a weapon
    '/items/anchorbound_plate_body': item('Anchorbound Plate Body', { type: BODY }),
    '/items/cheese': { name: 'Cheese', itemLevel: 0 },
    '/items/marksman_bow_refined': item('Marksman Bow (Refined)', { style: 'ranged' }),
};

describe('which weapon stands for which class', () => {
    test('the elements that deal damage get their own weapon', () => {
        expect(classWeapon('fireMage', DATA).hrid).toBe('/items/chimerical_quarterstaff');
        expect(classWeapon('waterMage', DATA).hrid).toBe('/items/rippling_trident');
    });

    test('nature is the healer, not a third mage', () => {
        // The whole point of the correction: `class-inference.js` files a
        // nature caster as the healer, and the drawing has to agree with the
        // verdict or the panel contradicts itself
        expect(classWeapon('healer', DATA).hrid).toBe('/items/blooming_trident');
        expect(classWeapon('natureMage', DATA)).toBeNull();
    });

    test('melee and ranged take a weapon of their style', () => {
        expect(classWeapon('melee', DATA).hrid).toBe('/items/sinister_chopper');
        expect(classWeapon('ranged', DATA).hrid).toBe('/items/marksman_bow');
    });

    test('a refined variant is not the drawing', () => {
        // Same weapon, same tier, a sprite nobody pictures when they think
        // "bow" — and it would win a tie on hrid order
        expect(classWeapon('ranged', DATA).hrid).not.toContain('refined');
    });

    test('the tank is the Bulwark line, at its top tier', () => {
        expect(classWeapon('tank', DATA).hrid).toBe('/items/griffin_bulwark');
    });

    test('the tank is matched by name, not by being an off-hand', () => {
        const data = {
            '/items/watchful_relic': item('Watchful Relic', { type: OFF_HAND, threat: 99 }),
            '/items/griffin_bulwark': item('Griffin Bulwark', { type: OFF_HAND, threat: 1 }),
        };
        // Threat would have picked the relic; a bulwark is what a tank is
        // recognisable by, so the name rule wins
        expect(classWeapon('tank', data).hrid).toBe('/items/griffin_bulwark');
    });

    test('a plain Mage takes any element, for the verdict that could not name one', () => {
        expect(classWeapon('mage', DATA)).not.toBeNull();
        expect(classWeapon('mage', DATA).name).toMatch(/Quarterstaff|Trident|Wand/);
    });
});

describe('choosing the tier', () => {
    test('the highest at or below ninety-five, not an equality test', () => {
        const data = {
            '/items/old_bow': item('Old Bow', { level: 75, style: 'ranged' }),
            '/items/newer_bow': item('Newer Bow', { level: 90, style: 'ranged' }),
        };
        expect(classWeapon('ranged', data)).toMatchObject({ hrid: '/items/newer_bow', itemLevel: 90 });
    });

    test('a future tier does not silently promote the icon', () => {
        const data = {
            '/items/marksman_bow': item('Marksman Bow', { level: CLASS_WEAPON_LEVEL, style: 'ranged' }),
            '/items/future_bow': item('Future Bow', { level: 105, style: 'ranged' }),
        };
        expect(classWeapon('ranged', data).hrid).toBe('/items/marksman_bow');
    });

    test('a line that only exists above the ceiling draws its lowest rung rather than nothing', () => {
        const data = { '/items/future_bow': item('Future Bow', { level: 105, style: 'ranged' }) };
        expect(classWeapon('ranged', data).hrid).toBe('/items/future_bow');
    });

    test('ties break the same way every session', () => {
        const data = {
            '/items/b_bow': item('B Bow', { style: 'ranged' }),
            '/items/a_bow': item('A Bow', { style: 'ranged' }),
        };
        expect(classWeapon('ranged', data).hrid).toBe('/items/a_bow');
        expect(classWeapon('ranged', data).hrid).toBe('/items/a_bow');
    });
});

describe('failing to a chip rather than a blank', () => {
    test('no game data resolves nothing', () => {
        expect(classWeapon('melee', null)).toBeNull();
        expect(classWeapon('melee', undefined)).toBeNull();
    });

    test('a key that is not a bucket resolves nothing rather than the first entry', () => {
        expect(classWeapon('sorcerer', DATA)).toBeNull();
    });

    test('a bucket nothing in the data matches resolves nothing', () => {
        expect(classWeapon('ranged', { '/items/cheese': { name: 'Cheese' } })).toBeNull();
    });
});

describe('drawing the icon', () => {
    beforeEach(() => {
        document.body.replaceChildren();
    });

    /** The game having drawn an item sprite, which is where the sheet URL comes from */
    function gameHasDrawnItems() {
        document.body.innerHTML =
            '<svg><use href="https://www.milkywayidle.com/static/media/items_sprite.abc.svg#cheese"></use></svg>';
    }

    // First in this block on purpose: the sheet URL is resolved off the
    // page once and remembered, so a test that wants the not-yet-drawn case
    // has to ask before anything else has looked
    test('no sprite sheet yet draws nothing, so the caller keeps its chip', () => {
        // A spacer where an icon should be reads as a broken icon; the chip
        // says more than a gap does
        expect(classTagIcon({ key: 'melee' }, { itemDetailMap: DATA })).toBeNull();
        expect(classTagIconHTML({ key: 'melee' }, { itemDetailMap: DATA })).toBe('');
    });

    test('the icon points at the resolved weapon on the game’s own sheet', () => {
        gameHasDrawnItems();
        const icon = classTagIcon({ key: 'waterMage', label: 'Water Mage' }, { itemDetailMap: DATA });

        expect(icon).not.toBeNull();
        expect(icon.querySelector('use').getAttribute('href')).toContain('#rippling_trident');
    });

    test('the text it replaces becomes the tooltip, and says what the sprite is', () => {
        gameHasDrawnItems();
        const icon = classTagIcon(
            { key: 'healer', label: 'Healer' },
            { title: 'HEAL — inferred from entangle.', itemDetailMap: DATA }
        );

        // An SVG takes its tooltip from a child <title>, not the attribute
        const title = icon.querySelector('title').textContent;
        expect(title).toContain('HEAL — inferred from entangle.');
        expect(title).toContain('Blooming Trident');
        // It is a stand-in for the class, and saying so is what stops it being
        // read as a statement about this player's kit
        expect(title).toContain('stand-in');
    });

    test('no verdict draws nothing', () => {
        gameHasDrawnItems();
        expect(classTagIcon(null, { itemDetailMap: DATA })).toBeNull();
        expect(classTagIconHTML(null, { itemDetailMap: DATA })).toBe('');
    });

    test('the markup form draws the same sprite and escapes its title', () => {
        gameHasDrawnItems();
        const html = classTagIconHTML({ key: 'tank', label: 'Tank' }, { title: '<b>TANK</b>', itemDetailMap: DATA });

        expect(html).toContain('#griffin_bulwark');
        expect(html).toContain('&lt;b&gt;TANK&lt;/b&gt;');
        expect(html).not.toContain('<b>');
    });
});
