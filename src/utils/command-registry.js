/**
 * Command Registry
 *
 * What the command palette can do, declared by the features that can do it.
 *
 * The palette used to hold a hand-written array of fifteen entries, and every
 * one of them was a small tax on the feature it pointed at. A panel in another
 * bundle cannot be imported by the palette — the production build is several
 * iife bundles and a cross-bundle import *copies* the module, state and all, so
 * the palette would have toggled a second invisible instance — which meant each
 * target also needed an accessor in `bundle-bridge.js`. The result was that
 * roughly a dozen perfectly good panels were unreachable from the palette for
 * no better reason than that nobody had written their two lines yet, and the
 * list of what was missing existed nowhere.
 *
 * So the direction is inverted: a feature says what it offers, here, and the
 * palette reads the list. Same shape and same reasoning as
 * `utils/overlay-rows.js`, and here for the same reason it is — utils loads
 * before every feature bundle and is declared shared in `rollup.config.js`, so
 * there is exactly one list and it exists before anyone registers into it. A
 * registry in `features/ui` would give each bundle its own copy and the palette
 * a third, and the ui bundle loads last, so a combat feature registering at
 * module scope would be reaching for a bundle that does not exist yet.
 *
 * ## Switched-off panels are still not offered
 *
 * The palette's own documentation promises that "a panel whose feature is
 * switched off is simply not offered", and that promise is worth more than the
 * old mechanism behind it. The old mechanism was thin: `bundle-bridge` answers
 * null only when a *bundle* is absent, and each bundle publishes its singletons
 * unconditionally, so a disabled feature's panel was still offered on any
 * ordinary install.
 *
 * Registration is what keeps the promise properly. A feature registers from its
 * `initialize()` and unregisters from its `disable()`/`cleanup()`, and the
 * feature registry only initializes features the settings have switched on — so
 * a switched-off feature never registers, and one switched off mid-session
 * takes its command with it. Where a feature has no lifecycle of its own, it
 * registers at import time and passes a `when` predicate for anything that has
 * to be re-asked each time the palette opens.
 *
 * ## Panels and verbs
 *
 * Almost everything here opens a panel, and for those the palette's job ends
 * when it closes: the panel is on screen, and that *is* the feedback. A verb —
 * "Recompute lab sims", "Snapshot briefing now" — has no such tell. The palette
 * closes, something happens off screen or does not, and the player is left
 * looking at the game with no way to tell which. Worse, `run()` was called
 * synchronously inside a `try` that only logged, so a verb that threw was
 * indistinguishable from a verb that worked, and an async one was not waited
 * for at all.
 *
 * So a command declares a `kind`. `'panel'` is the default and keeps the old
 * behaviour exactly. `'verb'` says: this *does* a thing rather than showing
 * one, its `run()` may be async, and it answers with a short string saying what
 * it did — which the palette puts in a toast. Throwing (or rejecting) is the
 * other half of the same contract: the palette says so on screen, rather than
 * in a console nobody has open.
 *
 * ## A verb with nothing to do still lists, and says so
 *
 * The result string is wanted even when the answer is "nothing" — a verb
 * returns `"nothing stale"`, not silence, and it stays in the list rather than
 * hiding itself while idle. That is the whole reason the result is a string and
 * not a boolean. A palette entry that vanishes when there is nothing to do is
 * unlearnable: you cannot form the habit of reaching for a command you can only
 * find on the days it would have done something, and its absence is silently
 * identical to the feature being switched off. `when` is for genuine
 * unavailability — the feature is off, the target is not on the page — and
 * having nothing to do is not that.
 */

/**
 * Commands, in registration order.
 *
 * Module-level so a feature can register long before the palette exists — the
 * palette is a ui-bundle feature and most registrants are not.
 * @type {Array<{name: string, hint: string, kind: string, run: Function, when: Function|null}>}
 */
const commands = [];

/**
 * What a command does when it is picked.
 *
 * `panel` shows something and the showing is its own feedback; `verb` does
 * something and has to say what it did. Anything unrecognised is treated as
 * `panel`, because that is the behaviour every existing registrant was written
 * against and a typo must not silently start awaiting and toasting.
 */
export const COMMAND_KINDS = ['panel', 'verb'];

/**
 * Offer a command in the palette.
 *
 * Safe to call before the palette exists, and safe to call twice — a repeated
 * name replaces the earlier definition rather than listing the command twice,
 * so a feature that re-initialises does not double up. Same contract as
 * `registerRow`, and for the same reason: features re-initialise.
 *
 * @param {Object} command - The command
 * @param {string} command.name - What it reads as in the list, e.g. `Trade Ledger`
 * @param {string} command.hint - The dim text on the right; one short phrase
 *   saying what selecting it does
 * @param {Function} command.run - What selecting it does. Called with no
 *   arguments; the palette closes first. For a `panel` it may return anything
 *   and the palette only catches what it throws. For a `verb` it may be async,
 *   and should settle with a short phrase saying what it did — "3 stale rooms
 *   queued", "nothing stale" — which the palette shows in a toast; throwing or
 *   rejecting gets an error toast instead.
 * @param {'panel'|'verb'} [command.kind='panel'] - `panel` opens something and
 *   needs no report; `verb` does something and is awaited and reported on.
 *   Unrecognised values fall back to `panel`.
 * @param {Function} [command.when] - `() => boolean`, asked each time the
 *   palette opens. For a command whose availability is not simply "the feature
 *   initialised" — a setting that can be turned off without disabling anything,
 *   a target that has to be on the page. Omitted means always. Not for a verb
 *   that merely has nothing to do right now: that case is a result string.
 * @returns {boolean} Whether it was accepted
 */
export function registerCommand({ name, hint = '', run, kind = 'panel', when = null }) {
    if (!name || typeof run !== 'function') {
        console.error('[CommandRegistry] A command needs a name and a run function:', name);
        return false;
    }

    const definition = {
        name: String(name),
        hint: String(hint || ''),
        kind: COMMAND_KINDS.includes(kind) ? kind : 'panel',
        run,
        when: typeof when === 'function' ? when : null,
    };
    const existing = commands.findIndex((command) => command.name === definition.name);
    if (existing >= 0) commands[existing] = definition;
    else commands.push(definition);
    return true;
}

/**
 * Withdraw a command, by name.
 *
 * The other half of registering on `initialize()`: a feature switched off in
 * Settings runs its `disable()` and must stop being offered, or the palette
 * becomes a list of things that quietly do nothing.
 *
 * @param {string} name - As registered
 * @returns {boolean} Whether there was one to withdraw
 */
export function unregisterCommand(name) {
    const at = commands.findIndex((command) => command.name === name);
    if (at < 0) return false;
    commands.splice(at, 1);
    return true;
}

/**
 * Every command on offer right now, in a stable order.
 *
 * Sorted by name rather than left in registration order, because registration
 * order is now an accident of bundle load order and feature-registry
 * sequencing: it would put the same commands in a different order on an install
 * with one feature switched off, and a palette whose empty-query list reshuffles
 * between sessions is one you cannot learn. Ties — which only a duplicate name
 * could produce, and `registerCommand` prevents those — keep registration order,
 * so the sort is stable in both senses.
 *
 * `when` is asked here rather than at registration because that is the point of
 * it: the palette calls this every time it opens, and a predicate answered once
 * at import time would be a constant.
 *
 * @returns {Array<{name: string, hint: string, kind: string, run: Function}>}
 */
export function registeredCommands() {
    return commands
        .map((command, index) => ({ command, index }))
        .filter(({ command }) => {
            if (!command.when) return true;
            try {
                return command.when() !== false;
            } catch (error) {
                // A predicate that throws is a broken feature, not a reason to
                // hide a command the player may be reaching for to fix it
                console.error(`[CommandRegistry] "${command.name}" could not say whether it applies:`, error);
                return true;
            }
        })
        .sort((a, b) => a.command.name.localeCompare(b.command.name) || a.index - b.index)
        .map(({ command }) => ({ name: command.name, hint: command.hint, kind: command.kind, run: command.run }));
}

/**
 * Forget everything. For tests, which share a module instance between cases.
 */
export function resetCommands() {
    commands.length = 0;
}
