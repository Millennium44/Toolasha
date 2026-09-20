# Toolasha tests deferred until after reset

The user requested short checks now and a saved plan for longer testing. Nothing here is
scheduled or running automatically. Fetch current main and open PRs before starting; another
reviewer owns merges. Record the exact Git commit, userscript version, test-server host and
capture IDs. Do not mix evidence from different game balance versions without labeling it.

The [assumptions register](combat-validation-handoff-2026-09-20.md) distinguishes observed
behavior from unverified mechanics. OOM autoattacks are confirmed; do not test a proposed
wait-without-autoattacking model as though it were established game behavior.

## What the short checks established

- A complete Siren Lv.35 fight auto-swapped from Blooming Trident +10 and Bishop's Codex +10
  to Arcane Bow +0. The client equipment update was received 2.943 seconds before `new_battle`;
  the opening client snapshot and persisted replay DTO both contained the bow. This validates
  that transition, not every room/refresh/retry path.
- Two clean, full-HP labyrinth fights retained separate saved DTOs and replayed with
  `inputSource: recorded` and no exclusions after an unrelated loadout was created. Each had
  only one observation and correctly received insufficient-evidence verdicts.
- After two reloads, both saved input objects were deeply equal to their earlier exports and
  replayed again with distinct weapon/build labels and zero exclusions or failures.
- The earlier Low Mana experiment produced no equipment change and cannot establish swap order.
- The 105-fight Zombie baseline's DPS difference was +2.06% with a ±7.21% panel band. It did
  not establish ±5% precision or broad engine parity. The first five-fight discrepancy did not persist.
- A 30-minute party session retained all 7,381 ticks across two segments (`ticksComplete: true`).
  Offline replay exposed one omitted opening-counter baseline, fixed in PR #148.

## Planned experiments

### P1 — Repeat fight-opening input checks (20–40 minutes; A1–A5)

Use the existing labyrinth tick capture with **All rooms** enabled and arm it before travel.
Keep a paired pool/accuracy export. Use two loadouts with explicit different items; an empty
slot is not evidence of an unequip. The test character has a `Codex room swap` fixture using
Arcane Bow; ordinary Combat uses Blooming Trident. The temporary room assignments were restored.

1. Alternate explicit builds across several combat rooms, including a direct room-to-room path,
   retries, first room after refresh, and a switch between one- and two-handed weapons.
2. Compare ordered item/ability messages, the `new_battle` client build and every saved DTO.
   Check enhancement, ability order/levels/triggers, combat levels, crates and resolved buffs.
3. Change a combat level and a relevant buff independently; inspect the next captured DTO.
4. Capture a partial join, a wounded start, and reduced-MP/cooldown carryover. Check exclusions
   and determine whether a full-HP start alone is adequate for replay eligibility.

Pass: saved effective inputs agree with the build actually in the opening feed; unavailable or
partial data is explained. A mismatch needs its exact message sequence. Do not infer simultaneous
server operation order from message arrival timestamps.

### P2 — Historical replay behavior (20–45 minutes; A1, A3, A11)

Collect at least five clean attempts per build against the same monster at comparable levels.
That is an application minimum, not a guarantee of sufficient precision.

1. Export the pool, change an unrelated saved loadout/current kit, and replay the original fights.
2. Record a relevant build change and verify distinct, labeled historical cohorts; ensure no
   averaging across builds. Verify unused metadata does not split otherwise equivalent inputs.
3. Refresh, export again, and compare saved DTOs exactly, ignoring export timestamps. Replay
   again; unseeded predictions may vary, while retained inputs must not.
4. Exercise legacy mismatch, invalid snapshot, partial/wounded exclusion and more than three
   eligible groups. Verify the report identifies each exclusion/failure/deferred group.

Pass: usable historical fights remain usable, incompatible builds remain separate, inputs survive
refresh, and exclusions are explicit. Save comparison JSON as well as the raw trace.

### P3 — Controlled mechanics (30–90 minutes per setup; A6–A10, A14)

Use normal combat/dungeon whole-session exports for multi-target fights, or labyrinth tick capture
plus accuracy export for a controlled single opponent. Preserve `ticksComplete`, gaps and partial
starts. Prefer one changed variable per setup.

- **AoE after lethal reflect:** multiple targets, reflect on an early target, caster near lethal HP.
  Look for damage/counters on later targets after the lethal event. Bundled, ambiguous outcomes
  remain inconclusive; keep collecting rather than changing the engine from one final HP value.
- **Reflect versus lifesteal/Life Drain:** isolate each healing source, vary starting HP around
  lethal thresholds, and compare survival/death plus damage/healing evidence across repeats.
- **Stun expiry/wake-up:** capture overlapping statuses and mana recovery around expiry. First
  establish what each counter counts; an advancing counter need not mean a damaging hit.
- **Labyrinth task bonuses (A15):** compare otherwise identical matching-task and nonmatching-task
  opponents/builds. Current recorded replay leaves task damage off; establish whether live server
  damage follows that assumption before changing the model or its build grouping.

Exact same-time server ordering may remain unobservable. FIFO tests and the Ripple guard describe
implementation conventions/hardening, not measured game behavior.

### P4 — Precision and room-level pooling (60–120 minutes; A10–A13)

Run separate stable-build, current-engine sessions. For Zombie, the earlier panel projected about
240 total fights for ±5% at the observed spread; this is an estimate, not a fixed target. Record
to the measured band and preserve all segments. Use several independent runs and more than one
zone/monster before making broad parity claims. Inspect autocorrelation, spawn mix and transient
buff uptime; do not assume the confidence formula's independence/stationarity assumptions hold.

Compare exact-level labyrinth cohorts with the current ten-level/median grouping, especially near
death and timeout thresholds. Report differences and uncertainty, including the simulator's own
sampling variation. Never classify an inside-band difference as a confirmed defect.

### P5 — Recorder boundaries and retention (5–10 minute boundaries; 90–120 minute retention)

Use PR #147/#152 or their reviewed main equivalents. PR #152 now stacks on #147; their focused
regression verifies recording ID is cleared along with discarded session metadata. Export two separate equal-damage five-fight sessions and
confirm both survive ingest/sync without duplication. Check a partial summary being replaced by
its completed counterpart.

During recording, exercise reconnect and character switching. No fight may bridge disconnected
time or be labeled with another character's loadout. Preserve the stopped reason. Separately test
zone/loadout changes inside a session; this remains a distinct audit concern from socket guards.

For retention, collect enough banked segments to exceed the current raw retention limit (inspect
the code first), export the whole session, and verify expired segments are explicitly marked while
their summaries remain. Test deterministic limits locally instead of waiting hours when possible.

### P6 — Guild trace persistence (30–120 minutes; lifecycle tests first)

Use the existing persisted Guild Trial trace, with reviewed PR #151 and its character-ownership
follow-up PR #153. Export during traffic and after completion. Count NDJSON body events and compare with
`exportedEventCount`; check `exportComplete`, missing/unreadable chunk lists, dropped-event counts,
partial starts and gaps independently. A missing chunk must never look like a complete export.

Export while clearing, refresh after new events arrive, and switch between two disposable test
characters with both old manifests present. Each trace must retain its own owner and data. Use
controlled storage-delay tests for restore races; ordinary browser timing does not prove them absent.

### P7 — Storage and performance (30–60 minutes, plus optional longer endurance)

Use a disposable profile for synthetic near-cap data. Measure actual browser memory, serialized
bytes, IndexedDB load/save latency, capture callback time, replay latency and refresh responsiveness
at representative pool sizes up to 1,000 fights. Keep real and synthetic measurements separate.

The two live DTOs were 6,823 and 6,717 serialized bytes. A prior synthetic 1,000-fight pool was
about 5.84 MB and grouped in roughly 50 ms in Node; neither is an IndexedDB endurance result.
Test two-device pool merging/capping and marker-rich captures near the ring bound. Adding/removing
diagnostic equipment/ability markers must not alter battle attribution, duration or gap diagnostics.

## Evidence handoff

For every case record: assumption ID, setup, exact builds, expected distinction, actions, observed
result, pass/fail/inconclusive, sample size, completeness, filenames and hashes. Keep raw files local
until sanitized and reviewed; new build metadata omits identities but whole raw `new_battle`
payloads still contain participants. Report simulator regressions separately from live game evidence.
