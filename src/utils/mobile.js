/**
 * Whether this is a touch device, and whether to act like it.
 *
 * Two questions, deliberately separate. `hasCoarsePointer` is a fact about the
 * hardware — the primary pointer cannot hit a 14px target — and things sized
 * for fingers key on it directly. `isMobileMode` is a *choice* that defaults to
 * that fact: auto-detection is right until the one person on a touchscreen
 * laptop wants desktop layouts, and a setting that cannot be overridden is a
 * bug report waiting to be written.
 */

import config from '../core/config.js';

/**
 * Whether the primary pointer is a finger rather than a cursor.
 *
 * `pointer: coarse` rather than user-agent sniffing: it asks about the actual
 * input device instead of guessing from a browser string that lies for
 * compatibility reasons.
 *
 * @returns {boolean}
 */
export function hasCoarsePointer() {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/**
 * Whether features should adjust for a phone-sized, touch-driven screen.
 *
 * @returns {boolean}
 */
export function isMobileMode() {
    const mode = config.getSettingValue('mobileMode', 'auto');
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return hasCoarsePointer();
}

/**
 * What auto-detection is deciding right now, in a word.
 *
 * "Auto-detect" is a promise the settings page cannot keep quietly: on the one
 * machine where the detection is wrong, the setting looks correct and the
 * layout does not, and there is nothing on screen to tell the two apart. The
 * settings UI shows this beside the option so the answer is visible before the
 * override is needed.
 *
 * @returns {string} `'mobile'` or `'desktop'`
 */
export function detectedModeLabel() {
    return hasCoarsePointer() ? 'mobile' : 'desktop';
}
