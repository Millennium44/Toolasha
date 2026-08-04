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

import { PANEL_Z_CAP } from './panel-z-index.js';

const COLORS = {
    background: 'rgba(12, 15, 26, 0.98)',
    border: 'rgba(120, 160, 255, 0.35)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.65)',
    accent: '#9ec4ff',
};

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

        const dialog = document.createElement('div');
        Object.assign(dialog.style, {
            minWidth: '320px',
            maxWidth: '460px',
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 12px 48px rgba(0, 0, 0, 0.7)',
            color: COLORS.text,
            fontSize: '13px',
            padding: '14px 16px 12px',
        });

        const heading = document.createElement('div');
        heading.textContent = title;
        Object.assign(heading.style, { fontWeight: 'bold', color: COLORS.accent, marginBottom: '6px' });
        dialog.appendChild(heading);

        if (message) {
            const body = document.createElement('div');
            body.textContent = message;
            Object.assign(body.style, {
                color: COLORS.textDim,
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

            const tone = choice.tone === 'danger' ? '#ff8080' : choice.tone === 'primary' ? COLORS.accent : COLORS.text;
            Object.assign(button.style, {
                background: choice.tone === 'primary' ? 'rgba(158, 196, 255, 0.18)' : 'rgba(255, 255, 255, 0.07)',
                border: `1px solid ${COLORS.border}`,
                borderRadius: '4px',
                color: tone,
                cursor: 'pointer',
                fontSize: '13px',
                padding: '5px 14px',
            });
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
