/**
 * Game Look
 *
 * The look of the game's own panels, for Toolasha panels to share: its plain dark frame, white text, blue
 * buttons and divider line. Colors come from the game's CSS variables with a measured fallback, so a game
 * theme change carries over. Green and red are for good and bad verdicts only.
 */

export const GAME_COLORS = {
    // Fill measured from the game's Modal_modal; the edge is its quieter divider line, by the maintainer's choice
    background: 'rgb(19, 20, 25)',
    frame: 'var(--color-divider, #323450)',
    frameGlow: '0 4px 12px rgba(0, 0, 0, 0.4)',
    border: 'var(--color-divider, #323450)',
    text: 'var(--color-text-dark-mode, #e7e7e7)',
    textDim: 'rgba(231, 231, 231, 0.6)',
    good: '#4ade80',
    bad: '#f87171',
    // The game's Input_input: the same fill as the panel it sits in, set off by a 1px #454771 border
    inputBackground: 'rgb(19, 20, 25)',
    inputBorder: '#454771',
    // Steps up from the panel for a box, card, tag, track or stripe that has to sit off it (midnight-800, -700)
    raised: 'var(--color-midnight-800, #191a24)',
    raisedMore: 'var(--color-midnight-700, #20212f)',
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
    button._hoverBg = look.hover;
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
    // Read at the time of the event, so a button promoted to another fill hovers to that fill's hover color,
    // and a button a caller has handed back to a host stylesheet (`_noHover`) paints nothing inline
    button.addEventListener('mouseover', () => {
        if (!button._noHover) button.style.background = button._hoverBg;
    });
    button.addEventListener('mouseout', () => {
        if (!button._noHover) button.style.background = button._restBg;
    });
    return button;
}

/**
 * Change the fill a styled button returns to when the pointer leaves.
 *
 * @param {HTMLButtonElement} button - A button from styleGameButton
 * @param {string} background - The new resting fill
 * @param {string} [hover] - The fill under the pointer; left alone when omitted
 */
export function setButtonRest(button, background, hover) {
    button._restBg = background;
    if (hover !== undefined) button._hoverBg = hover;
    button.style.background = background;
}

/**
 * Move a styled button to another variant's fills, rest and hover together.
 *
 * @param {HTMLButtonElement} button - A button from styleGameButton
 * @param {'primary'|'quiet'|'icon'} variant - Which fill
 */
export function setButtonVariant(button, variant) {
    const look = BUTTON_LOOK[variant];
    setButtonRest(button, look.rest, look.hover);
}

/**
 * Stop a styled button painting inline fills, for a button handed back to the host's own stylesheet.
 *
 * @param {HTMLButtonElement} button - A button from styleGameButton
 */
export function stopButtonHover(button) {
    button._noHover = true;
}
