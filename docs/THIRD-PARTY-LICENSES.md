# Third-party licences

Code in this repository that came from somewhere else, and the terms it came under.

## Scaley Way Idle

`src/features/ui/combat-panel-scale.js` implements the idea behind **Scaley Way Idle** by
Frotty — scaling the two sides of the battle panel independently, and setting the height of
the character panel beside it.

The published script carries no licence, so nothing was copied from it. The feature was
written against Toolasha's own settings, style helpers, and feature lifecycle, and differs
in substance: a single stylesheet in place of a `MutationObserver` sweep that re-set inline
styles on every combat tick, class-prefix selectors in place of pinned CSS-module hashes
that the game regenerates each build, `zoom` in place of `transform` so a shrunk side gives
its space back instead of needing a spacer element and a forced 50/50 split, and per-
character settings in the settings page in place of a floating control panel. The free
repositioning of the two areas by drag handle is not reproduced.

Credit for the idea and for working out which parts of the battle panel are worth resizing
belongs to Frotty.

## mooket II

`src/features/market/mooket/` is adapted from **mooket II** by Q7, used under the MIT
licence. The Chinese-language strings and item dictionaries were replaced with English and
with Toolasha's own game data, the storage moved from `localStorage` to Toolasha's
IndexedDB layer, and the WebSocket interception dropped in favour of Toolasha's existing
hook — but the market history API, the volume-split estimate, and the shape of the price
panel are Q7's work.

<https://greasyfork.org/scripts/531109>

```text
MIT License

Copyright (c) Q7

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
