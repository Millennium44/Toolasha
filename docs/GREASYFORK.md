# GreasyFork listing — Additional info

Paste-ready body for the GreasyFork listing's "Additional info" section. Keep the
Credits section intact when editing — it is where the scripts this fork builds on
get their visible recognition, per their licences and plain courtesy.

---

## What this fork adds

This is the **Millennium44 fork of Toolasha** (itself a rewrite of MWITools). The
biggest changes since forking, in rough order of how much they change the game:

- **Combat Recorder & Sim Accuracy** — record your real fights (loadout snapshots,
  XP, drops, fight boundaries that survive refresh), replay them against the
  simulator, and get a verdict with honest noise bands. Record to N fights, M
  minutes, or a ±% precision target; export everything for sharing.
- **Upgrade advisors in both simulators** — every candidate that could move your
  numbers (equipment, enhancement, ability levels, ability swaps, charms, house
  rooms, guild shrines, drinks, community buffs) ranked on gold-per-result, with a
  budget planner, rank-blend scoring, and per-row handoffs: save the gold for it,
  watch it, or jump straight to it on the marketplace.
- **Labyrinth simulator, grown up** — multi-target analysis with combined armor
  swaps, supply-aware planning (torches/shrouds/beacons from the actual run),
  max-level and skip-level finding, house rooms per fight, and a skilling sim that
  scopes candidates to the skill you're simming.
- **Per-character everything** — settings, panels, histories, market state and sim
  state are scoped per character, with consent-gated adoption of legacy data and
  repair tools. No more iron cow reading the market cow's books.
- **Cross-device sync** — your whole Toolasha database carried between browsers
  through one private GitHub gist you own: gzip-compressed, optionally AES-256
  encrypted with a passphrase, conflict-aware, and guarded so a fresh device can't
  overwrite a year of data.
- **Goal planner** — "get me X gold / level N" turned into a ranked, dependency-
  ordered plan built from your real measured rates: gathering, production,
  alchemy, and combat income from your own all-zones sims.
- **Guild tools** — trials pace/ETA/payout math, shrine levels everywhere they
  matter (scores, net worth, sims), and guild token valuation from the game's real
  credit exchange rates.
- **Iron Bell Farming & Iron Cow mode** — a costed starfruit→decompose→coinify
  loop planner for bell-farming characters, plus one-click Iron Cow settings
  management (presets, copy-to-IC-characters, instant re-force).
- **Overlay redesign** — curated tile defaults, bundled presets, activity
  auto-switching, tiles that open their panels, and full mobile support: a
  floating launcher on every screen and layouts that re-flow to the width they're
  given without touching your desktop arrangement.
- **Mobile support throughout** — panels clamp to the viewport, close buttons stay
  reachable, touch targets grow, and the mobile-mode setting shows what
  auto-detection decided.
- **Notifications** — empty queue, community buff expiry (per-buff, with lead
  time), labyrinth run finished, and more.
- **Task tools** — measured tokens/hour and net task income, reroll protection
  that respects free MooPass rerolls, task sorting and inventory highlighting.
- **Equipment Savings ("eWatch")** — savings goals for gear _and_ ability levels,
  fed straight from the simulators, with progress and ETA from your gold.
- **Storage that survives months** — chunked per-period history records, honest
  quota handling, per-character backups that say whose they are.
- Hundreds of bug fixes over the upstream base, and a test suite grown from
  ~2,300 to over 6,500 tests.

## Credits

This fork stands on other people's work, and the recognition belongs here where
it can be seen:

- **bot7420** — author of the original
  [MWITools](https://greasyfork.org/en/scripts/494467), which Toolasha began as a
  rewrite of.
- **Celasha** — author and maintainer of upstream
  [Toolasha](https://greasyfork.org/en/scripts/562662-toolasha), the script this
  fork tracks and ports fixes from.
- **Frotty** — author of **MWI Combat Suite** (MIT), from which this fork ports
  the drop-luck analysis (characteristic-function income model), the expected-
  spawn dynamic programme, the combat drop-rate model, the chest ledger
  (TReasure), and the watchlist model (NTally); also the idea behind the battle
  panel scaling (**Scaley Way Idle**) and the overlay's one-row-per-feature shape
  (**OPanel**).
- **Q7** — author of the
  [market history viewer](https://greasyfork.org/scripts/531109) (MIT) whose API
  usage, volume-split estimate and price panel shape this fork's market history
  is built on.
- **jigglymoose** — author of
  [JIGS](https://greasyfork.org/en/scripts/550346-jigs-jigglymoose-s-intelligent-gear-simulator),
  for several of the ideas behind the upgrade advisor.
- **dakonglong** — author of the
  [Labyrinth Win Rate Calculator](https://greasyfork.org/en/scripts/566829-%E8%BF%B7%E5%AE%AB%E8%83%9C%E7%8E%87%E8%AE%A1%E7%AE%97%E5%99%A8),
  for the code and inspiration behind the labyrinth simulator.
- **Shykai, amVoidGuy, vlad and kuganDev** — for their immense work on the
  [MWI Combat Simulator](https://shykai.github.io/MWICombatSimulatorTest/dist/)
  this script integrates with.
- And everyone in the upstream header's thank-you list — testers, bug-finders,
  and contributors whose time shaped both the upstream script and this fork.

Exact licence terms and a per-file record of what was taken from where live in
[`docs/THIRD-PARTY-LICENSES.md`](https://github.com/Millennium44/Toolasha/blob/main/docs/THIRD-PARTY-LICENSES.md)
in the repository.
