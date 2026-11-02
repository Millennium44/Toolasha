/**
 * Game Look
 *
 * The look of the game's own panels, for Toolasha panels to share: its plain dark frame, white text, blue
 * buttons and divider line. Colors come from the game's CSS variables with a measured fallback, so a game
 * theme change carries over. Green and red are for good and bad verdicts only.
 */

export const GAME_COLORS = {
    // Measured from the game's Modal_modal: its near-black fill, thin light edge and faint glow
    background: 'rgb(19, 20, 25)',
    frame: 'rgb(208, 208, 208)',
    frameGlow: 'rgba(208, 208, 208, 0.282) 0 0 4px 4px',
    border: 'var(--color-divider, #323450)',
    text: 'var(--color-text-dark-mode, #e7e7e7)',
    textDim: 'rgba(231, 231, 231, 0.6)',
    good: '#4ade80',
    bad: '#f87171',
};

/** The frame of a panel, popup or dialog, to spread into its style */
export const GAME_FRAME = {
    background: GAME_COLORS.background,
    border: `1px solid ${GAME_COLORS.frame}`,
    borderRadius: 'var(--radius-sm, 0.25rem)',
    boxShadow: GAME_COLORS.frameGlow,
};

/** Button fills: primary blue, the quieter secondary blue, and the selected state */
export const BUTTON_LOOK = {
    primary: { rest: 'var(--color-primary, #4357af)', hover: 'var(--color-primary-hover, #546ddb)' },
    quiet: { rest: 'var(--color-space-800, #273366)', hover: 'var(--color-space-700, #35458b)' },
    icon: { rest: 'transparent', hover: 'var(--color-space-800, #273366)' },
};

/**
 * Make a button look like the game's.
 *
 * `primary` is the full blue button, `quiet` the secondary blue for rows of controls, `icon` a bare glyph
 * that only shows a fill on hover. `compact` is the same button at a smaller height, for controls that sit
 * inline in a header or a row.
 *
 * @param {HTMLButtonElement} button - The button
 * @param {'primary'|'quiet'|'icon'} variant - Which fill
 * @param {boolean} [compact] - Smaller height and text
 * @returns {HTMLButtonElement} The same button
 */
export function styleGameButton(button, variant, compact = false) {
    const look = BUTTON_LOOK[variant];
    button._restBg = look.rest;
    Object.assign(button.style, {
        background: look.rest,
        border: 'none',
        borderRadius: 'var(--radius-sm, 0.25rem)',
        color: GAME_COLORS.text,
        cursor: 'pointer',
        fontWeight: '600',
        fontFamily: 'inherit',
        fontSize: compact ? '0.75rem' : 'var(--font-size-base, 0.875rem)',
        height: compact
            ? 'calc(var(--button-height-normal, 1.875rem) - 0.375rem)'
            : 'var(--button-height-normal, 1.875rem)',
        padding: compact ? '0 0.5rem' : '0 0.75rem',
        lineHeight: '1',
        boxSizing: 'border-box',
    });
    button.addEventListener('mouseover', () => (button.style.background = look.hover));
    button.addEventListener('mouseout', () => (button.style.background = button._restBg));
    return button;
}

/**
 * Change the fill a styled button returns to when the pointer leaves.
 *
 * @param {HTMLButtonElement} button - A button from styleGameButton
 * @param {string} background - The new resting fill
 */
export function setButtonRest(button, background) {
    button._restBg = background;
    button.style.background = background;
}
