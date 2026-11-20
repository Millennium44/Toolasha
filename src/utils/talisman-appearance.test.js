/** @vitest-environment happy-dom */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    CHOSEN_ICON_RECORD,
    NEVER_CHOSEN_RECORD,
    APPEARANCE_GAME_DATA as DATA,
} from '../__fixtures__/talisman-appearance.js';

vi.mock('../core/data-manager.js', () => ({ default: { getInitClientData: () => null } }));

const { talismanAppearance, talismanIconHrid, talismanBadgeHTML, talismanMarkerNote } =
    await import('./talisman-appearance.js');
const { resetSpriteSheetCache } = await import('./overlay-format.js');

const SKILLS = '/static/media/skills_sprite.aaa.svg';
const MISC = '/static/media/misc_sprite.bbb.svg';

function drawSheets() {
    document.body.innerHTML = `<svg><use href="${SKILLS}#alchemy"></use></svg><svg><use href="${MISC}#coin"></use></svg>`;
}
const html = (t) => talismanBadgeHTML(t, { gameData: DATA });

beforeEach(() => resetSpriteSheetCache());
afterEach(() => {
    document.body.innerHTML = '';
    resetSpriteSheetCache();
});

describe('talismanIconHrid, the game rule', () => {
    test('a valid chosen icon is kept; "" falls back to the type default', () => {
        expect(talismanIconHrid(CHOSEN_ICON_RECORD, DATA)).toBe('/talisman_icons/combat');
        expect(talismanIconHrid(NEVER_CHOSEN_RECORD, DATA)).toBe('/talisman_icons/combat');
        const skilling = { talismanTypeHrid: '/talisman_types/skilling', iconHrid: '/talisman_icons/alchemy' };
        expect(talismanIconHrid(skilling, DATA)).toBe('/talisman_icons/alchemy');
    });

    test('an icon of the other type, or an unknown one, falls back to the type default', () => {
        expect(talismanIconHrid({ ...CHOSEN_ICON_RECORD, iconHrid: '/talisman_icons/alchemy' }, DATA)).toBe(
            '/talisman_icons/combat'
        );
        expect(talismanIconHrid({ ...CHOSEN_ICON_RECORD, iconHrid: '/talisman_icons/nope' }, DATA)).toBe(
            '/talisman_icons/combat'
        );
    });

    test('without game data the constants are the last resort; without a type there is no icon', () => {
        expect(talismanIconHrid({ talismanTypeHrid: '/talisman_types/skilling', iconHrid: '' }, {})).toBe(
            '/talisman_icons/skilling'
        );
        expect(talismanIconHrid({ talismanTypeHrid: '/talisman_types/combat' }, {})).toBe('/talisman_icons/combat');
        expect(talismanIconHrid({ iconHrid: '/talisman_icons/combat', marker: 3 }, DATA)).toBeNull();
        expect(talismanIconHrid(null, DATA)).toBeNull();
    });
});

describe('talismanAppearance and marker note', () => {
    test('marker is an integer from 1 to maxMarker, else 0', () => {
        const m = (marker) => talismanAppearance({ ...CHOSEN_ICON_RECORD, marker }, DATA).marker;
        expect([m(0), m(1), m(9), m(10), m(-1), m(2.5), m('3'), m(undefined)]).toEqual([0, 1, 9, 0, 0, 0, 0, 0]);
        expect(
            talismanAppearance({ ...CHOSEN_ICON_RECORD, marker: 10 }, { talismanInfo: { maxMarker: 12 } }).marker
        ).toBe(10);
    });

    test('the note names a marker and is empty for none', () => {
        expect(talismanMarkerNote({ talismanTypeHrid: '/talisman_types/combat', marker: 5 })).toBe('marker 5');
        expect(talismanMarkerNote({ marker: 0 })).toBe('');
        expect(talismanMarkerNote({})).toBe('');
    });
});

describe('talismanBadgeHTML', () => {
    test('the combat icon is the misc sheet #combat, a skill icon is the skills sheet', () => {
        drawSheets();
        expect(html(CHOSEN_ICON_RECORD)).toContain(`href="${MISC}#combat"`);
        const alchemy = { talismanTypeHrid: '/talisman_types/skilling', iconHrid: '/talisman_icons/alchemy' };
        expect(html(alchemy)).toContain(`href="${SKILLS}#alchemy"`);
        // the plain skilling icon is the misc sheet #skills
        expect(html({ talismanTypeHrid: '/talisman_types/skilling', iconHrid: '' })).toContain(`href="${MISC}#skills"`);
    });

    test('icon and marker 9 both draw; marker 0 draws only the icon', () => {
        drawSheets();
        const nine = html({ ...CHOSEN_ICON_RECORD, marker: 9 });
        expect(nine).toContain('<svg');
        expect(nine).toContain('data-talisman-marker="9"');
        expect(html({ ...CHOSEN_ICON_RECORD, marker: 0 })).not.toContain('data-talisman-marker');
    });

    test('two talismans of one type with different markers differ', () => {
        drawSheets();
        const a = html({ ...CHOSEN_ICON_RECORD, marker: 1 });
        const b = html({ ...NEVER_CHOSEN_RECORD, marker: 7 });
        expect(a).toContain('data-talisman-marker="1"');
        expect(b).toContain('data-talisman-marker="7"');
    });

    test('a record with no type (a party member or sim copy) draws nothing, marker or not', () => {
        drawSheets();
        expect(html({ marker: 3, iconHrid: '/talisman_icons/combat', modifiers: [] })).toBe('');
        expect(html({})).toBe('');
        expect(html(undefined)).toBe('');
    });

    test('a type but no fields draws the type default icon and no marker', () => {
        drawSheets();
        const out = html({ talismanTypeHrid: '/talisman_types/combat' });
        expect(out).toContain('<svg');
        expect(out).not.toContain('data-talisman-marker');
    });

    test('a sheet the game has not named draws no icon, but the marker still shows', () => {
        const out = html({ ...CHOSEN_ICON_RECORD, marker: 2 });
        expect(out).not.toContain('<svg');
        expect(out).toContain('data-talisman-marker="2"');
        expect(html({ ...CHOSEN_ICON_RECORD, marker: 0 })).toBe('');
    });
});
