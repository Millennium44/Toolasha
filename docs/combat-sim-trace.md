# Combat simulation trace

This is an opt-in worker diagnostic, not a new UI control. Normal runs do not
capture a trace or wrap combat processing.

For a single diagnostic `start_simulation` worker message, supply a numeric
`seed` and `captureTrace: { maxEvents: 200 }` alongside the existing simulation
inputs. `captureTrace: true` uses the default 200-event limit. The reply includes
`simResult.combatTrace`. Use the same game data, player DTOs, zone, stopping rule,
seed, and code version when reproducing it. The trace is not a complete input
export and cannot reconstruct a build by itself.

Direct engine callers can use `runTracedSimulation` from
`src/features/combat-sim/engine/combat-trace.js` instead of `simulate`. Its
arguments are the simulator, nanosecond time limit, stopping rule, and optional
`{ seed, maxEvents }` metadata/settings. Seed the RNG as usual before calling:
the helper records the supplied seed but deliberately does not alter RNG state.

## Recorded data

- Actual processed-event order, type, timestamp, source, target, ability, and consumable.
- HP, mana, stun, blindness, silence, and mana-wait flags before and after the event.
- Each attack reported through `SimResult.addAttack`, including misses and critical hits.
- A time-sorted copy of the pending queue after each captured event.
- Numeric identities distinguish different unit objects with the same monster HRID.

All times are nanoseconds. The queue preview is not an event-priority assertion:
equal-time entries retain their heap-array order for display. The top-level
event list records the order that actually executed. State snapshots show net
changes across an event, not every intermediate HP change inside an attack.

## Limits and safety

Capture defaults to 200 events and is clamped to 1–2,000 events. The simulation
continues normally after capture fills; `truncated` reports omitted events.
Per-event attack lists and queue previews are capped at 200 entries, with
`attacksTruncated` and `queueTruncated` flags when needed.

Tracing does not draw random numbers, reorder the queue, or change the result
accounting. Snapshots contain values rather than live unit references and are
safe to serialize or send through `postMessage`. Temporary method wrappers are
restored on both success and exceptions. Do not enable this on routine
multi-chunk runs: it is intended for one short reproducible diagnostic run, and
the normal aggregate-result UI does not display or merge these traces.
