/**
 * The pre-fix session marker and the "include sessions recorded before the
 * fix" totals toggle, shared by the transmute, decompose and coinify history
 * windows.
 *
 * A session recorded before the 2026-09-23 tracker fixes may undercount its
 * first batch of attempts (coinify/decompose) or have missed its first
 * self-return (transmute). The session list keeps showing every such session,
 * marked; the totals table can leave them out, per window, remembered through
 * Toolasha's storage. Totals include them by default, so nothing changes until
 * the box is unticked.
 */

import storage from '../../core/storage.js';
import { isPreFixSession } from './alchemy-tracker-version.js';
import { HISTORY_TYPE_SCALE } from './history-totals-table.js';

/**
 * Marker glyph for a pre-fix session. Chosen to collide with no marker any of
 * the three windows already uses (* † ‡ ◇ ¶ § ‖ ⚠).
 */
export const PRE_FIX_MARKER = '◷';

/** @type {Record<string, string>} What the fix corrected, per window */
const PRE_FIX_EFFECT = {
    coinify: 'its first batch of attempts may be undercounted',
    decompose: 'its first batch of attempts may be undercounted',
    transmute: 'a first self-return may have been missed and the input charged twice',
};

/**
 * Tooltip for a pre-fix session's marker.
 * @param {'coinify'|'decompose'|'transmute'} kind - The window
 * @returns {string}
 */
export function preFixTitle(kind) {
    return `Recorded before the 2026-09-23 tracker fix — ${PRE_FIX_EFFECT[kind] || 'its counts may be off'}.`;
}

/**
 * Legend line for the pre-fix marker.
 * @param {'coinify'|'decompose'|'transmute'} kind - The window
 * @returns {string}
 */
export function preFixLegend(kind) {
    return (
        `${PRE_FIX_MARKER} recorded before the 2026-09-23 tracker fix — ${PRE_FIX_EFFECT[kind] || 'counts may be off'}; ` +
        'untick "Include sessions recorded before the fix" to leave these out of the totals'
    );
}

/**
 * The CSV Data Note text for a pre-fix session, or '' for one recorded after the fix.
 * @param {Object} session - The exported session
 * @param {'coinify'|'decompose'|'transmute'} kind - The window
 * @returns {string}
 */
export function preFixDataNote(session, kind) {
    if (!isPreFixSession(session)) return '';
    return `recorded before the 2026-09-23 tracker fix — ${PRE_FIX_EFFECT[kind] || 'its counts may be off'}`;
}

/**
 * The sessions a totals table sums: every filtered session, or only those
 * recorded after the fix when pre-fix sessions are excluded.
 * @param {Array<Object>} sessions - The window's filtered sessions
 * @param {boolean} includePreFix - The toggle's state
 * @returns {Array<Object>}
 */
export function totalsSessions(sessions, includePreFix) {
    return includePreFix ? sessions : sessions.filter((session) => !isPreFixSession(session));
}

/**
 * Storage key for one window's toggle.
 * @param {string} kind - The window
 * @returns {string}
 */
function storageKey(kind) {
    return `alchemyHistory_includePreFix_${kind}`;
}

/**
 * Read one window's remembered toggle state; true when never set or unreadable.
 * @param {string} kind - The window
 * @returns {Promise<boolean>}
 */
export async function loadIncludePreFix(kind) {
    try {
        return (await storage.get(storageKey(kind), 'settings', true)) !== false;
    } catch (error) {
        console.error('[AlchemyPreFixSessions] Failed to read toggle state:', error);
        return true;
    }
}

/**
 * Remember one window's toggle state.
 * @param {string} kind - The window
 * @param {boolean} include - Whether totals include pre-fix sessions
 * @returns {Promise<void>}
 */
export async function saveIncludePreFix(kind, include) {
    try {
        await storage.set(storageKey(kind), !!include, 'settings');
    } catch (error) {
        console.error('[AlchemyPreFixSessions] Failed to save toggle state:', error);
    }
}

/**
 * Append the pre-fix marker to a session row's cell when the session predates the fix.
 * @param {HTMLElement} cell - The cell to mark
 * @param {Object} session - The session the row shows
 * @param {'coinify'|'decompose'|'transmute'} kind - The window
 */
export function appendPreFixMarker(cell, session, kind) {
    if (!isPreFixSession(session)) return;
    const mark = document.createElement('span');
    mark.className = 'mwi-alchemy-pre-fix-marker';
    mark.textContent = ` ${PRE_FIX_MARKER}`;
    mark.title = preFixTitle(kind);
    mark.setAttribute('aria-label', preFixTitle(kind));
    mark.style.color = '#fbbf24';
    cell.appendChild(mark);
}

/**
 * The "Include sessions recorded before the fix" checkbox for a totals
 * section, or null when no filtered session predates the fix — then the
 * choice changes nothing and is left off the panel.
 *
 * @param {Object} opts
 * @param {Array<Object>} opts.sessions - The window's filtered sessions
 * @param {boolean} opts.includePreFix - Current state
 * @param {(include: boolean) => void} opts.onChange - Called with the new state
 * @returns {HTMLElement|null}
 */
export function createPreFixToggle({ sessions, includePreFix, onChange }) {
    const preFixCount = sessions.filter((session) => isPreFixSession(session)).length;
    if (preFixCount === 0) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'mwi-alchemy-pre-fix-toggle';
    wrapper.style.cssText = `display: flex; align-items: center; gap: 8px; margin-bottom: 6px; color: #aaa; font-size: ${HISTORY_TYPE_SCALE.note};`;

    const label = document.createElement('label');
    label.style.cssText = 'display: flex; align-items: center; gap: 4px; cursor: pointer;';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = includePreFix;
    checkbox.style.cursor = 'pointer';
    checkbox.addEventListener('change', () => onChange(checkbox.checked));
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode('Include sessions recorded before the fix'));
    wrapper.appendChild(label);

    if (!includePreFix) {
        const note = document.createElement('span');
        note.textContent = `${preFixCount} session${preFixCount === 1 ? '' : 's'} marked ${PRE_FIX_MARKER} left out`;
        wrapper.appendChild(note);
    }
    return wrapper;
}
