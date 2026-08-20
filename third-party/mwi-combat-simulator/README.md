# MWI Combat Simulator

The combat/labyrinth simulation engine under `src/features/combat-sim/engine/`
is ported from the [MWI Combat Simulator](https://github.com/shykai/MWICombatSimulatorTest)
(MIT, (c) 2024 AmVoidGuy) — the KuganDev -> AmVoidGuy -> shykai line, with vlad
among its contributors. The port keeps the engine's structure (combat units,
buffs, triggers, the event queue and its event classes) and adapts it to run
inside Toolasha; the export format the sim site reads is implemented in
`src/features/combat-sim/` alongside it. `LICENSE.md` is the repository's
license verbatim.
