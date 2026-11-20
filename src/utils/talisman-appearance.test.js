/** @vitest-environment happy-dom */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { talismanAppearance, talismanBadgeHTML, talismanMarkerNote } from './talisman-appearance.js';
import { resetSpriteSheetCache } from './overlay-format.js';

const SHEET = '/static/media/items_sprite.abc123.svg';

function drawItemSheet() {
    document.body.innerHTML = `<svg><use href="${SHEET}#coin"></use></svg>`;
}

beforeEach(() => resetSpriteSheetCache());
afterEach(() => {
    document.body.innerHTML = '';
    resetSpriteSheetCache();
});

describe('talismanAppearance', () => {
    test('reads icon and marker, and defaults missing or bad fields', () => {
        expect(talismanAppearance({ iconHrid: '/items/x', marker: 3 })).toEqual({ iconHrid: '/items/x', marker: 3 });
        expect(talismanAppearance({})).toEqual({ iconHrid: null, marker: 0 });
        expect(talismanAppearance(null)).toEqual({ iconHrid: null, marker: 0 });
        expect(talismanAppearance({ iconHrid: '', marker: 0 })).toEqual({ iconHrid: null, marker: 0 });
        expect(talismanAppearance({ marker: -2 }).marker).toBe(0);
        expect(talismanAppearance({ marker: 'x' }).marker).toBe(0);
    });
});

describe('talismanMarkerNote', () => {
    test('names a marker, and is empty for none', () => {
        expect(talismanMarkerNote({ marker: 5 })).toBe('marker 5');
        expect(talismanMarkerNote({ marker: 0 })).toBe('');
        expect(talismanMarkerNote({})).toBe('');
    });
});

describe('talismanBadgeHTML', () => {
    test('icon and marker 9 both draw', () => {
        drawItemSheet();
        const html = talismanBadgeHTML({ iconHrid: '/items/small_talisman_belt', marker: 9 });
        expect(html).toContain(`href="${SHEET}#small_talisman_belt"`);
        expect(html).toContain('data-talisman-marker="9"');
    });

    test('marker 1 draws a badge', () => {
        expect(talismanBadgeHTML({ marker: 1 })).toContain('data-talisman-marker="1"');
    });

    test('marker 0 draws no badge, and no icon means no gap at all', () => {
        expect(talismanBadgeHTML({ marker: 0 })).toBe('');
        expect(talismanBadgeHTML({})).toBe('');
        expect(talismanBadgeHTML(undefined)).toBe('');
    });

    test('an icon the sheet is not known for draws nothing, but the marker still does', () => {
        const html = talismanBadgeHTML({ iconHrid: '/items/x', marker: 2 });
        expect(html).not.toContain('<svg');
        expect(html).toContain('data-talisman-marker="2"');
        expect(talismanBadgeHTML({ iconHrid: '/items/x', marker: 0 })).toBe('');
    });

    test('an icon with marker 0 draws only the icon', () => {
        drawItemSheet();
        const html = talismanBadgeHTML({ iconHrid: '/items/x', marker: 0 });
        expect(html).toContain('<svg');
        expect(html).not.toContain('data-talisman-marker');
    });

    test('the hrid is escaped', () => {
        drawItemSheet();
        expect(talismanBadgeHTML({ iconHrid: '/items/"><b>' })).not.toContain('"><b>');
    });
});
