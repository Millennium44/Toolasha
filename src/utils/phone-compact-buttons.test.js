/** @vitest-environment happy-dom */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    PHONE_COMPACT_BUTTONS_CSS,
    PHONE_COMPACT_BUTTONS_STYLE_ID,
    ensurePhoneCompactButtonStyles,
} from './phone-compact-buttons.js';

describe('phone compact buttons', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
    });

    it('installs one stylesheet however often it is asked', () => {
        ensurePhoneCompactButtonStyles();
        ensurePhoneCompactButtonStyles();
        expect(document.querySelectorAll(`#${PHONE_COMPACT_BUTTONS_STYLE_ID}`)).toHaveLength(1);
    });

    it('sizes Philo Gamba to its label at every width and XPH Calc at phone width only', () => {
        const [wide, phone] = PHONE_COMPACT_BUTTONS_CSS.split('@media');
        expect(wide).toMatch(/\.mwi-philo-calc-button \{[^}]*width: fit-content/);
        expect(wide).not.toContain('.mwi-xph-calc-btn');
        expect(phone).toMatch(/\(max-width: 768px\)\s*\{\s*\.mwi-xph-calc-btn \{[^}]*width: fit-content/);
    });
});
