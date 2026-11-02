/**
 * Choice Dialog
 *
 * A modal that asks a question and offers more than two answers.
 *
 * `window.confirm` offers exactly two, so a three-way choice has to be squeezed
 * into OK and Cancel with a paragraph explaining which is which — "OK to ADD,
 * Cancel to REPLACE" is a question you have to read twice and can still get
 * wrong, and getting it wrong overwrites a ledger. Buttons that say what they do
 * cannot be misread.
 *
 * Deliberately promise-based rather than callback-based so the calling code
 * reads as a decision rather than as a continuation.
 */

import { GAME_COLORS, GAME_FRAME, styleGameButton } from './game-look.js';
import { PANEL_Z_CAP } from './panel-z-index.js';
import { markToolashaSurface } from './surface-marker.js';

/** The game's own warning colors, for the choice that cannot be undone */
const DANGER = { rest: 'var(--color-warning, #db3333)', hover: 'var(--color-warning-hover, #e65c5c)' };

/**
 * Ask a question and wait for an answer.
 *
 * Escape and a click outside both resolve to null, matching what dismissing a
 * dialog means everywhere else: no, and nothing has happened.
 *
 * @param {Object} options - The question
 * @param {string} options.title - Heading
 * @param {string} [options.message] - Body text; newlines become line breaks
 * @param {Array<{value: string, label: string, hint?: string, tone?: string}>} options.choices -
 *   Buttons, in order. `tone` may be `'primary'`, `'danger'` or left off.
 * @returns {Promise<string|null>} The chosen value, or null when dismissed
 */
export function askChoice({ title, message = '', choices = [] }) {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        Object.assign(backdrop.style, {
            position: 'fixed',
            inset: '0',
            background: 'rgba(0, 0, 0, 0.55)',
            // Always above every floating panel, including one raised by
            // bringPanelToFront to PANEL_Z_CAP — this dialog is often opened
            // from that very panel and must never render behind it
            zIndex: String(PANEL_Z_CAP + 1),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
        });
        // Read by text-appearance.js: the dialog inside takes the Toolasha text size and font
        markToolashaSurface(backdrop, 'dialog');

        const dialog = document.createElement('div');
        Object.assign(dialog.style, {
            minWidth: '320px',
            maxWidth: '460px',
            ...GAME_FRAME,
            color: GAME_COLORS.text,
            fontSize: '13px',
            padding: '14px 16px 12px',
        });

        const heading = document.createElement('div');
        heading.textContent = title;
        Object.assign(heading.style, { fontWeight: 'bold', color: GAME_COLORS.text, marginBottom: '6px' });
        dialog.appendChild(heading);

        if (message) {
            const body = document.createElement('div');
            body.textContent = message;
            Object.assign(body.style, {
                color: GAME_COLORS.textDim,
                marginBottom: '12px',
                lineHeight: '1.45',
                whiteSpace: 'pre-wrap',
            });
            dialog.appendChild(body);
        }

        const buttons = document.createElement('div');
        Object.assign(buttons.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' });

        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKeyDown, true);
            backdrop.remove();
            resolve(value);
        };

        const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            // Captured, because the game listens for Escape too and would close
            // whatever is behind this dialog as well
            event.stopPropagation();
            event.preventDefault();
            finish(null);
        };

        for (const choice of choices) {
            const button = document.createElement('button');
            button.textContent = choice.label;
            if (choice.hint) button.title = choice.hint;

            styleGameButton(button, choice.tone === 'primary' ? 'primary' : 'quiet');
            Object.assign(button.style, {
                fontSize: '13px',
                padding: '5px 14px',
                height: 'auto',
                minHeight: '1.875rem',
            });
            if (choice.tone === 'danger') {
                // Filled in the game's warning color so it still reads as the dangerous one; the listeners
                // added here run after the blue hover ones styleGameButton added, so they win
                button._restBg = DANGER.rest;
                button.style.background = DANGER.rest;
                button.addEventListener('mouseover', () => (button.style.background = DANGER.hover));
                button.addEventListener('mouseout', () => (button.style.background = DANGER.rest));
            }
            button.addEventListener('click', () => finish(choice.value));
            buttons.appendChild(button);
        }

        dialog.appendChild(buttons);
        backdrop.appendChild(dialog);

        backdrop.addEventListener('mousedown', (event) => {
            if (event.target === backdrop) finish(null);
        });
        document.addEventListener('keydown', onKeyDown, true);

        document.body.appendChild(backdrop);
        // Focused so Enter and Tab work from the keyboard, and so the dialog
        // takes focus away from whatever was behind it
        buttons.firstElementChild?.focus();
    });
}
