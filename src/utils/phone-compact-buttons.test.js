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

    it('sizes the Philo Gamba and XPH Calc buttons to their label at phone width only', () => {
        expect(PHONE_COMPACT_BUTTONS_CSS).toMatch(
            /@media \(max-width: 768px\)\s*\{\s*\.mwi-philo-calc-button,\s*\.mwi-xph-calc-btn \{[^}]*width: fit-content/
        );
    });
});
