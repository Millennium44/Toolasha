/**
 * The "Performance" strip shared by the Combat Sim and Lab Sim panels: one collapsed line that opens to the
 * limits that decide how hard a simulation run leans on the machine.
 *
 * Every control is a player setting read when the strip is built or reopened and written on change; the
 * simulators themselves read the settings at run time, never from the strip. Nothing here throws on a missing
 * node or a missing runner export, so a panel never fails to build because of it.
 */

import config from '../../core/config.js';
import { getMaxWorkers } from './combat-sim-runner.js';
import { GAME_COLORS } from '../../utils/game-look.js';
import {
    readNumberSetting,
    MAX_CONCURRENT_SIMS_KEY,
    RESIM_MAX_MINUTES_KEY,
    ALL_FIGHTS_SIM_BUDGET_KEY,
    DEFAULT_MAX_CONCURRENT_SIMS,
    MIN_MAX_CONCURRENT_SIMS,
    MAX_MAX_CONCURRENT_SIMS,
    DEFAULT_RESIM_MAX_MINUTES,
} from './sim-performance-settings.js';

const THREADS_KEY = 'combatSim_maxThreads';
const UNCAP_KEY = 'combatSim_uncapThreads';
const MAX_THREADS = 32;

const INPUT_CSS =
    `width:46px; background:${GAME_COLORS.inputBackground}; color:#e0e0e0; ` +
    `border:1px solid ${GAME_COLORS.inputBorder}; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;`;
const LABEL_CSS = 'display:flex; align-items:center; gap:4px; color:#888;';

/**
 * What the thread count will actually be, for the text beside the box.
 * @returns {string} e.g. "→ 4 of 16 cores", empty when the runner cannot say
 */
export function effectiveThreadsText() {
    try {
        const workers = getMaxWorkers();
        if (!Number.isFinite(workers)) return '';
        const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency;
        return cores ? `→ ${workers} of ${cores} cores` : `→ ${workers}`;
    } catch {
        return '';
    }
}

/**
 * Parse what was typed into a whole-number box.
 * @param {string} text - The box's value
 * @param {number} min - Lowest allowed
 * @param {number} max - Highest allowed
 * @returns {number|null} The clamped whole number; null for an empty or non-numeric box
 */
export function clampTyped(text, min, max) {
    if (typeof text !== 'string' || text.trim() === '') return null;
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Build the strip.
 * @param {Object} [options]
 * @param {boolean} [options.includeShorten=false] - Add the Lab-only "Shorten above N sims" box
 * @param {boolean} [options.includeResim=true] - Show "Re-sim time cap" (only the Combat Sim Upgrade tab has that phase)
 * @param {string} [options.idPrefix='mwi-sim'] - Prefix for the element ids (one strip per panel)
 * @returns {HTMLElement} The strip, with `refresh()` on it to re-read every control
 */
export function createPerformanceStrip({ includeShorten = false, includeResim = true, idPrefix = 'mwi-sim' } = {}) {
    const strip = document.createElement('div');
    strip.id = `${idPrefix}-perf`;
    strip.style.cssText = 'flex-shrink:0; border-bottom:1px solid #222; font-size:12px;';

    const numberBox = (suffix, key, min, max, step, title) => `
        <input id="${idPrefix}-perf-${suffix}" data-perf-key="${key}" type="number" min="${min}"${
            Number.isFinite(max) ? ` max="${max}"` : ''
        } step="${step}" title="${title}" style="${INPUT_CSS}">`;

    const shorten = includeShorten
        ? `<label style="${LABEL_CSS}" title="A whole-run analysis that plans more simulations than this runs each one for a smaller share of the hours asked for (never below 25%): noisier win rates, finished sooner. 0 = never shorten.">
                Shorten above
                ${numberBox('shorten', ALL_FIGHTS_SIM_BUDGET_KEY, 0, Infinity, 50, 'Sims. 0 = never shorten.')}
                sims (0 = never)
           </label>`
        : '';

    const resim = includeResim
        ? `<label style="${LABEL_CSS}" title="Longest the Upgrade tab's Re-sim close calls phase may run, in minutes. 0 = no time cap: it runs until the rows separate, its round limit or Stop.">
                Re-sim time cap
                ${numberBox('resim', RESIM_MAX_MINUTES_KEY, 0, Infinity, 1, 'Minutes. 0 = no cap.')}
                min (0 = none)
            </label>`
        : '';

    strip.innerHTML = `
        <button type="button" id="${idPrefix}-perf-toggle" aria-expanded="false" style="background:none; border:none; color:#888; cursor:pointer; padding:3px 14px; font-size:11px; text-align:left;">⚙ Performance ▸</button>
        <div id="${idPrefix}-perf-body" style="display:none; flex-wrap:wrap; align-items:center; gap:6px 14px; padding:4px 14px 8px;">
            <label style="${LABEL_CSS}" title="Web Worker threads for simulations. 0 = auto (4, or fewer on a smaller machine). Normally clamped to your core count; tick Ignore thread caps to take it literally (0 then means every core).">
                Threads
                ${numberBox('threads', THREADS_KEY, 0, MAX_THREADS, 1, 'Threads. 0 = auto.')}
                <span id="${idPrefix}-perf-effective" style="color:${GAME_COLORS.textDim};"></span>
            </label>
            <label id="${idPrefix}-perf-sims-label" style="${LABEL_CSS}" title="Most simulations one analysis runs together, never more than Threads allows. Ignored while Ignore thread caps is on.">
                Sims at once
                ${numberBox('sims', MAX_CONCURRENT_SIMS_KEY, MIN_MAX_CONCURRENT_SIMS, MAX_MAX_CONCURRENT_SIMS, 1, 'Simulations at once, 1 to 32.')}
            </label>
            <label style="${LABEL_CSS} cursor:pointer;" title="Lifts the core-count clamp on Threads (0 then means every core), the phone 2-thread limit, and Sims at once. It does NOT lift Max hrs, the re-sim time cap or Shorten above. Each simulation holds its own copy of the game data, so this can use a lot of memory.">
                <input type="checkbox" id="${idPrefix}-perf-uncap" style="margin:0; cursor:pointer;">
                Ignore thread caps
            </label>
            ${resim}
            ${shorten}
        </div>
    `;

    const $ = (suffix) => strip.querySelector(`#${idPrefix}-perf-${suffix}`);

    const refresh = () => {
        const threads = $('threads');
        if (threads) threads.value = String(Math.floor(readNumberSetting(THREADS_KEY, 0, 0, MAX_THREADS)));
        const sims = $('sims');
        if (sims) {
            sims.value = String(
                Math.floor(
                    readNumberSetting(
                        MAX_CONCURRENT_SIMS_KEY,
                        DEFAULT_MAX_CONCURRENT_SIMS,
                        MIN_MAX_CONCURRENT_SIMS,
                        MAX_MAX_CONCURRENT_SIMS
                    )
                )
            );
        }
        const resim = $('resim');
        if (resim)
            resim.value = String(Math.floor(readNumberSetting(RESIM_MAX_MINUTES_KEY, DEFAULT_RESIM_MAX_MINUTES, 0)));
        const shortenBox = $('shorten');
        if (shortenBox) shortenBox.value = String(Math.floor(readNumberSetting(ALL_FIGHTS_SIM_BUDGET_KEY, 0, 0)));
        const uncapBox = $('uncap');
        const uncapped = Boolean(config.getSetting?.(UNCAP_KEY));
        if (uncapBox) uncapBox.checked = uncapped;
        // Sims at once has no effect while the caps are ignored: show it as such
        if (sims) sims.disabled = uncapped;
        const simsLabel = $('sims-label');
        if (simsLabel) {
            simsLabel.style.opacity = uncapped ? '0.45' : '1';
            simsLabel.title = uncapped
                ? 'Not used while Ignore thread caps is on: simulations run as many at once as Threads allows.'
                : 'Most simulations one analysis runs together, never more than Threads allows. Ignored while Ignore thread caps is on.';
        }
        const effective = $('effective');
        if (effective) effective.textContent = effectiveThreadsText();
    };
    strip.refresh = refresh;

    // Write a clamped whole number; a blank or non-number box goes back to the stored value
    const wireNumber = (suffix, key, min, max) => {
        const box = $(suffix);
        box?.addEventListener('change', () => {
            const typed = clampTyped(box.value, min, max);
            if (typed !== null) config.setSettingValue?.(key, typed);
            refresh();
        });
    };
    wireNumber('threads', THREADS_KEY, 0, MAX_THREADS);
    wireNumber('sims', MAX_CONCURRENT_SIMS_KEY, MIN_MAX_CONCURRENT_SIMS, MAX_MAX_CONCURRENT_SIMS);
    wireNumber('resim', RESIM_MAX_MINUTES_KEY, 0, 1_000_000);
    wireNumber('shorten', ALL_FIGHTS_SIM_BUDGET_KEY, 0, 1_000_000_000);

    $('uncap')?.addEventListener('change', (event) => {
        config.setSetting?.(UNCAP_KEY, Boolean(event.target.checked));
        refresh();
    });

    const toggle = $('toggle');
    const body = $('body');
    toggle?.addEventListener('click', () => {
        const open = body?.style.display === 'none';
        if (body) body.style.display = open ? 'flex' : 'none';
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = `⚙ Performance ${open ? '▾' : '▸'}`;
        if (open) refresh();
    });

    // The same settings can change from the other panel's strip or from Settings. Re-read when the pointer or
    // focus comes back to an open strip, rather than through a document listener: one of those per panel build
    // keeps every closed panel alive (a leak that ran the test worker out of memory)
    // Never while a box here is being typed into: a re-read would undo the half-typed value
    body?.addEventListener('pointerenter', () => {
        if (body.style.display === 'none' || body.contains(document.activeElement)) return;
        refresh();
    });
    body?.addEventListener('focusin', (event) => {
        if (body.style.display === 'none' || (event.relatedTarget && body.contains(event.relatedTarget))) return;
        refresh();
    });

    refresh();
    return strip;
}
