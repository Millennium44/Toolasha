import { describe, test, expect } from 'vitest';
import { tileBadgeFontCSS, ZOOM_VARIABLE, FONT_VARIABLE, TILE_BADGE_ZOOM_CAP } from './tile-badge-text.js';

describe('tileBadgeFontCSS', () => {
    test('scales the base size by the published zoom, capped, falling back to 1', () => {
        expect(tileBadgeFontCSS(0.7)).toContain(
            `font-size: calc(0.7rem * min(var(${ZOOM_VARIABLE}, 1), ${TILE_BADGE_ZOOM_CAP}))`
        );
    });

    test('takes the published font stack, inheriting when none is chosen', () => {
        expect(tileBadgeFontCSS(0.7)).toContain(`font-family: var(${FONT_VARIABLE}, inherit)`);
    });
});
