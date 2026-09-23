/** Injects an import button beside Metz's paste-to-import field. */

import config from '../../core/config.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { constructMetzTeamExport } from './combat-sim-export-metz.js';

const timerRegistry = createTimerRegistry();
const BUTTON_ID = 'toolasha-metz-import-button';
const WARNINGS_ID = 'toolasha-metz-import-warnings';
const DEFAULT_LABEL = 'Import from Toolasha';
let mutationObserver = null;
let mountTimeout = null;
let domReadyHandler = null;

export function initialize() {
    disable();
    if (document.body) start();
    else {
        domReadyHandler = () => {
            domReadyHandler = null;
            start();
        };
        document.addEventListener('DOMContentLoaded', domReadyHandler, { once: true });
    }
}

function start() {
    mount();
    mutationObserver = new MutationObserver(scheduleMount);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
}

export function disable() {
    timerRegistry.clearAll();
    if (domReadyHandler) document.removeEventListener('DOMContentLoaded', domReadyHandler);
    domReadyHandler = null;
    mutationObserver?.disconnect();
    mutationObserver = null;
    if (mountTimeout) clearTimeout(mountTimeout);
    mountTimeout = null;
    document.getElementById(BUTTON_ID)?.remove();
    document.getElementById(WARNINGS_ID)?.remove();
}

function scheduleMount() {
    if (mountTimeout) return;
    mountTimeout = setTimeout(() => {
        mountTimeout = null;
        mount();
    }, 250);
}

function findImportTextarea() {
    const textareas = Array.from(document.querySelectorAll('textarea'));
    if (textareas.length <= 1) return textareas[0] || null;
    return textareas.find((textarea) => /export|import/i.test(textarea.placeholder || '')) || textareas[0];
}

function mount() {
    const textarea = findImportTextarea();
    const existing = document.getElementById(BUTTON_ID);
    if (!textarea) {
        existing?.remove();
        document.getElementById(WARNINGS_ID)?.remove();
        return;
    }
    if (existing) {
        if (existing.previousElementSibling !== textarea) textarea.insertAdjacentElement('afterend', existing);
        const warnings = document.getElementById(WARNINGS_ID);
        if (warnings && warnings.previousElementSibling !== existing)
            existing.insertAdjacentElement('afterend', warnings);
        return;
    }

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = DEFAULT_LABEL;
    button.style.cssText =
        `background:${config.COLOR_ACCENT};color:white;padding:6px 16px;border:0;border-radius:4px;` +
        'cursor:pointer;font-weight:bold;margin:8px 0;display:block;';
    button.addEventListener('mouseenter', () => (button.style.opacity = '0.8'));
    button.addEventListener('mouseleave', () => (button.style.opacity = '1'));
    button.addEventListener('click', (event) => {
        event.preventDefault();
        importIntoMetz(button);
    });
    textarea.insertAdjacentElement('afterend', button);
}

/**
 * Show, under the import button, the party members whose cached profiles the import could not
 * trust: none cached (left out), no gear (imported naked), or older than a day. Replaced on every
 * import and removed when there is nothing to say.
 * @param {Element} button - The import button
 * @param {Array<{level: string, text: string}>} warnings - From `constructMetzTeamExport`
 */
function showProfileWarnings(button, warnings) {
    document.getElementById(WARNINGS_ID)?.remove();
    if (!warnings?.length) return;
    const list = document.createElement('div');
    list.id = WARNINGS_ID;
    list.style.cssText = 'margin:0 0 8px; font-size:12px; line-height:1.4;';
    for (const warning of warnings) {
        const line = document.createElement('div');
        line.style.color = warning.level === 'stale' ? '#c9a227' : '#e0703a';
        line.textContent = `⚠ ${warning.text}`;
        list.appendChild(line);
    }
    button.insertAdjacentElement('afterend', list);
}

function setButtonStatus(button, label, backgroundColor) {
    button.textContent = label;
    button.style.backgroundColor = backgroundColor;
    timerRegistry.registerTimeout(
        setTimeout(() => {
            button.textContent = DEFAULT_LABEL;
            button.style.backgroundColor = config.COLOR_ACCENT;
        }, 3000)
    );
}

function setTextareaValue(textarea, value) {
    // React tracks controlled inputs by wrapping the element's own `value` setter. Calling that
    // wrapper and then dispatching input can look unchanged to React. Metz itself uses the native
    // prototype setter for programmatic imports; follow the same path before emitting input.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, value);
    else textarea.value = value;
}

async function importIntoMetz(button) {
    try {
        const expectedCharacterId = new URL(window.location.href).searchParams.get('toolashaCharacterId');
        if (!expectedCharacterId) {
            setButtonStatus(button, 'Open from game tab', '#dc3545');
            alert('Open Metz from the game page so Toolasha knows which character to import.');
            return;
        }
        const warnings = [];
        const team = await constructMetzTeamExport(expectedCharacterId, { warnings });
        showProfileWarnings(button, team ? warnings : []);
        if (!team) {
            setButtonStatus(button, 'Character data mismatch', '#dc3545');
            alert(
                'Another game tab has synced a different character since this page was opened. Return to the game tab playing the character you want and click its Metz link again.'
            );
            return;
        }
        const json = JSON.stringify(team);
        const textarea = findImportTextarea();
        if (!textarea) {
            await navigator.clipboard.writeText(json);
            setButtonStatus(button, 'Copied - paste manually', '#28a745');
            return;
        }
        textarea.focus();
        setTextareaValue(textarea, json);
        if (typeof ClipboardEvent === 'function' && typeof DataTransfer === 'function') {
            const clipboardData = new DataTransfer();
            clipboardData.setData('text/plain', json);
            textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        setButtonStatus(button, '✓ Imported', '#28a745');
    } catch (error) {
        console.error('[Toolasha Metz Sim] Import failed:', error);
        setButtonStatus(button, 'Import Failed', '#dc3545');
    }
}
