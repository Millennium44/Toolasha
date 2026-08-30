/**
 * Consent gate for the adopt-once migration.
 *
 * Legacy account-wide data is never silently claimed by whichever character
 * logs in first. The first time an adoptable value is found, one modal asks
 * which character should inherit the pre-scoping data; until the user
 * confirms, every legacy value stays where it is. The heuristics (game mode,
 * test names, networth history) only choose which character the dialog
 * preselects.
 *
 * The decision is stored account-wide under `adoptionTargetCharacterId` and
 * can be reopened from the console via `Toolasha.debug.chooseDataOwner()`.
 */
import dataManager from '../core/data-manager.js';
import storage from '../core/storage.js';
import { escapeText } from './damage-board.js';

const DECISION_KEY = 'adoptionTargetCharacterId';

/** undefined = not read yet, null = undecided, string = chosen character id. */
let cachedDecision;

/** One prompt per session, shared by every concurrent readScoped call. */
let promptPromise = null;

/**
 * The character chosen to inherit legacy data, or null while undecided.
 * @returns {Promise<string|null>} Chosen character id
 */
export async function getAdoptionTargetId() {
    if (cachedDecision === undefined) {
        cachedDecision = await storage.get(DECISION_KEY, 'settings', null);
    }
    return cachedDecision;
}

/**
 * Record the choice.
 * @param {string} id - Character id that inherits legacy data
 * @returns {Promise<void>}
 */
export async function setAdoptionTargetId(id) {
    cachedDecision = id;
    await storage.set(DECISION_KEY, id, 'settings', true);
}

/**
 * Clear the stored decision and allow the dialog to show again.
 * @returns {Promise<void>}
 */
export async function resetAdoptionDecision() {
    cachedDecision = null;
    promptPromise = null;
    await storage.delete(DECISION_KEY, 'settings');
}

/**
 * Show the choose-a-character dialog (once per session).
 *
 * Fire-and-forget from data paths: callers must not await this before
 * returning a fallback, or a modal would block feature initialization.
 * @param {{recommendedId?: string|null}} [options] - Which character to preselect
 * @returns {Promise<string|null>} The chosen id, or null for "not now"
 */
export function requestAdoptionConsent(options = {}) {
    if (promptPromise) return promptPromise;
    if (typeof document === 'undefined' || !document.body) return Promise.resolve(null);

    promptPromise = (async () => {
        try {
            const names = (await storage.get('accountCharacterNames', 'settings', null)) || {};
            const currentId = dataManager.getCurrentCharacterId();
            const currentName = dataManager.getCurrentCharacterName?.() || '';
            const known = { ...names };
            if (currentId && !known[currentId]) known[currentId] = currentName || String(currentId);
            const recommended = options.recommendedId || currentId;
            const chosen = await showDialog(known, recommended, currentId);
            if (chosen) await setAdoptionTargetId(chosen);
            return chosen;
        } catch (error) {
            console.error('[AdoptionConsent] Prompt failed:', error);
            return null;
        }
    })();
    return promptPromise;
}

/**
 * The dialog itself. Resolves with a character id or null for "not now".
 * @param {Record<string, string>} characters - id → display name
 * @param {string|null} recommendedId - Preselected id
 * @param {string|null} currentId - The logged-in character, labeled as such
 * @returns {Promise<string|null>} Choice
 */
function showDialog(characters, recommendedId, currentId) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        // Above every panel tier — this blocks a data migration, nothing may cover it
        overlay.style.cssText =
            'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:2147483600; ' +
            'display:flex; align-items:center; justify-content:center;';

        const ids = Object.keys(characters);
        const rows = ids
            .map((id) => {
                const checked = id === recommendedId ? ' checked' : '';
                const who = `${escapeText(characters[id])}${id === currentId ? ' (this character)' : ''}`;
                return (
                    `<label style="display:block; margin:4px 0; cursor:pointer;">` +
                    `<input type="radio" name="mwi-adopt-target" value="${escapeText(id)}"${checked}> ${who}</label>`
                );
            })
            .join('');

        const card = document.createElement('div');
        card.style.cssText =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:8px; ' +
            'padding:16px 20px; max-width:420px; font-size:13px; line-height:1.5;';
        card.innerHTML =
            `<div style="font-weight:700; font-size:14px; margin-bottom:8px;">Toolasha — who owns the saved data?</div>` +
            `<div style="color:#aaa; margin-bottom:10px;">Saved data from before per-character scoping was found ` +
            `(watchlist, savings targets, trackers, panel state…). Choose which character should inherit it — ` +
            `nothing moves until you confirm.</div>` +
            rows +
            `<div style="margin-top:12px; display:flex; gap:8px; justify-content:flex-end;">` +
            `<button id="mwi-adopt-later" style="background:#333; color:#ccc; border:1px solid #555; border-radius:4px; padding:4px 12px; cursor:pointer;">Not now</button>` +
            `<button id="mwi-adopt-confirm" style="background:#4a6fdc; color:#fff; border:none; border-radius:4px; padding:4px 12px; cursor:pointer;">Confirm</button>` +
            `</div>` +
            `<div style="color:#777; margin-top:8px; font-size:11px;">Applies as data is next read; reload to apply everywhere. ` +
            `Reopen later with Toolasha.debug.chooseDataOwner().</div>`;

        overlay.appendChild(card);
        document.body.appendChild(overlay);

        const done = (value) => {
            overlay.remove();
            resolve(value);
        };
        card.querySelector('#mwi-adopt-confirm').addEventListener('click', () => {
            const picked = card.querySelector('input[name="mwi-adopt-target"]:checked');
            done(picked ? picked.value : null);
        });
        card.querySelector('#mwi-adopt-later').addEventListener('click', () => done(null));
    });
}

/**
 * Test-only: forget the cached decision and any open prompt.
 */
export function _resetConsentCache() {
    cachedDecision = undefined;
    promptPromise = null;
}
