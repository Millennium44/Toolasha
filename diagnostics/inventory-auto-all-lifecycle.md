# Auto All menu lifecycle audit

## Source regression

The tooltip observer delivers a `closed` event when a popper leaves the document and
allows the same DOM element to deliver another `opened` event later. Auto All used
to ignore `closed`, keep its delayed click pending and permanently mark that node
processed. A closed menu could receive the click; a reopened node was skipped.

Timers now belong to individual menus. Closing a menu cancels its timer and clears
its processed marker. The delayed callback also checks that the menu remains in
the document. Other menus keep their pending work and duplicate open events still
produce one click per opening.

Five new DOM regressions failed against the previous source and pass with the fix:

- Close before the 50 ms render delay expires.
- Detach before the closed event reaches the feature.
- Reopen the same menu node after a completed click.
- Reopen during the delay and allow the new opening its own full delay.
- Close one of two pending menus without canceling the other.

These tests establish the observer contract and feature behavior. They do not
measure how often the current game reuses menu nodes or verify loot mechanics.

## Short live follow-up

Coordinate tab ownership before using a separately approved test build. Do not
confirm any loot opening or ability-book consumption during these checks.

1. Enable Auto All, open a loot-container menu and wait at least 50 ms. Confirm
   the quantity field selects the available count, then dismiss the menu.
2. Open and quickly dismiss the menu before the delay; check for a delayed action.
   Reopen it and confirm All works. Repeat ordinary open/dismiss cycles.
3. Open an ability-book menu and confirm the available quantity is selected.
4. Enable the exclude-seals option and confirm a seal menu retains its initial
   quantity. Disable the option and confirm normal selection returns.
5. Toggle Auto All off during an opening. Confirm no delayed selection occurs and
   another newly opened menu remains unchanged. Re-enable and check selection.

No live game access, shared-server deployment, private capture or long recording
was used in this source audit. The optional full suite was stopped to reduce
concurrent load; no tests were removed and that run is not a passing check.
