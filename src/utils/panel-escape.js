/**
 * Escape closes the panel in front.
 *
 * The game's own popovers and modals all answer Escape, and the script's
 * floating panels did not — except the one that grew its own hand-rolled
 * listener, which is how a script ends up with twenty listeners disagreeing
 * about what Escape means. So: one document-level listener, and a stack of
 * open panels underneath it. Escape closes the panel most recently opened or
 * raised, and pressing it again peels the next one — which is what closing
 * "the one on top" feels like from the keyboard.
 *
 * What Escape must *not* do is reach past something nearer to the user:
 *
 * - A keystroke aimed at an input, a select or anything editable belongs to
 *   it — Escape there means "cancel what I am typing" or "shut this
 *   dropdown", never "take my panel away".
 * - A game modal or popover on screen owns Escape outright; the game closes
 *   it with the same key, and a panel closing alongside it reads as two
 *   things flinching at once.
 * - Anything of ours that answers Escape itself — the overlay's gear popover,
 *   for one — registers a hold while it is up, so the panel underneath
 *   survives the keypress that dismisses it. A hold is a predicate rather
 *   than an open/close pair because the things that need one already track
 *   their own openness, and asking them at keypress time cannot drift.
 * - An Escape something else already acted on arrives with `defaultPrevented`
 *   set, and is not acted on twice.
 *
 * The listener exists only while at least one panel is registered, so a page
 * with every panel shut carries no keydown listener for this at all.
 */

import { isTypingTarget } from './dom.js';

/**
 * Anything of the game's that is dismissed by Escape. Presence is enough:
 * the game unmounts its modals and popovers when they close, rather than
 * hiding them.
 */
const GAME_ESCAPE_OWNERS = '[class*="Modal_modalContainer"], .MuiModal-root, .MuiPopover-root';

/** Open panels, in the order they were opened or last raised. Last is front. */
const stack = [];

/** Predicates from things that want Escape kept off the panels while true */
const holds = new Set();

function onKeydown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (isTypingTarget(event.target)) return;
    for (const isHolding of holds) {
        if (isHolding()) return;
    }
    if (document.querySelector(GAME_ESCAPE_OWNERS)) return;

    const front = stack[stack.length - 1];
    if (!front) return;
    // Spent, so whatever else listens for Escape after this can decline it
    event.preventDefault();
    front.close();
}

let listening = false;

function syncListener() {
    const wanted = stack.length > 0;
    if (wanted === listening) return;
    listening = wanted;
    if (wanted) document.addEventListener('keydown', onKeydown);
    else document.removeEventListener('keydown', onKeydown);
}

/**
 * Put a panel under Escape's care.
 *
 * Call on open; the panel joins the stack in front. `raise()` when an
 * already-open panel is brought forward, so Escape agrees with the eye about
 * which panel is on top. `release()` on close — a close by any gesture, since
 * a closed panel left in the stack is a stale `close` waiting for a keypress.
 *
 * @param {Function} close - What closing this panel is
 * @returns {{raise: Function, release: Function}}
 */
export function registerEscapeClose(close) {
    const entry = { close };
    stack.push(entry);
    syncListener();
    return {
        raise() {
            const at = stack.indexOf(entry);
            if (at !== -1 && at !== stack.length - 1) {
                stack.splice(at, 1);
                stack.push(entry);
            }
        },
        release() {
            const at = stack.indexOf(entry);
            if (at !== -1) stack.splice(at, 1);
            syncListener();
        },
    };
}

/**
 * Keep Escape off the panels while something nearer the user answers it.
 *
 * @param {Function} isHolding - Asked at each keypress; `true` while the
 *   thing that registered it is up and spoken for
 * @returns {Function} Forgets the predicate
 */
export function holdEscapeWhile(isHolding) {
    holds.add(isHolding);
    return () => holds.delete(isHolding);
}
