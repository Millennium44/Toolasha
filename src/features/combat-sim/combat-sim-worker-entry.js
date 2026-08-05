/**
 * Combat Simulator Worker Entry
 *
 * This file is bundled into a string at build time by the workerBundlePlugin
 * and runs inside a Web Worker. It receives simulation parameters via
 * postMessage and returns results.
 */

import { buildPlayerExtraBuffs } from './engine/extra-buffs.js';
import { setGameData } from './engine/game-data.js';
import CombatSimulator from './engine/combat-simulator.js';
import Labyrinth from './engine/labyrinth.js';
import Player from './engine/player.js';
import { seedSimRng } from './engine/rng.js';
import Zone from './engine/zone.js';

onmessage = function (event) {
    const { type, taskId } = event.data;

    if (type !== 'start_simulation') return;

    try {
        const {
            gameData,
            playerDTOs,
            zoneHrid,
            difficultyTier,
            simulationTimeLimit,
            extraBuffs,
            labyrinth: labyrinthData,
            precision,
            seed,
            isTaskFight,
        } = event.data;

        // Set game data for the engine singleton
        setGameData(gameData);

        // Seed this worker's RNG streams. Runs compared against each other pass
        // the same seed so their shared random draws cancel out of the delta;
        // with no seed the engine stays on Math.random().
        seedSimRng(seed);

        // Create Zone (used as fallback even in labyrinth mode for SimResult constructor)
        const zone = new Zone(zoneHrid, difficultyTier);

        // Create Labyrinth if specified
        let labyrinth = null;
        if (labyrinthData) {
            labyrinth = new Labyrinth(
                labyrinthData.monsterHrid,
                labyrinthData.roomLevel,
                labyrinthData.crates || [],
                labyrinthData.liveState || null
            );
        }

        // Create Players
        const players = playerDTOs.map((dto) => {
            const cloned = structuredClone(dto);
            if (labyrinth) {
                cloned.food = cloned.food.map(() => null);
                cloned.drinks = cloned.drinks.map(() => null);
            }
            const player = Player.createFromDTO(cloned);
            // Labyrinth: crate buffs go to zoneBuffs; otherwise use zone buffs
            player.zoneBuffs = labyrinth ? labyrinth.buffs : zone.buffs;
            // Guild and achievement buffs come from each player's own DTO — the
            // shared extraBuffs used to carry player 1's, handing their guild's
            // bonuses to every teammate in a party sim
            player.extraBuffs = buildPlayerExtraBuffs(extraBuffs, cloned);
            return player;
        });

        // Create simulator with progress callback
        const combatSimulator = new CombatSimulator(
            players,
            zone,
            (progressData) => {
                postMessage({
                    type: 'progress',
                    taskId,
                    progress: Math.round(progressData.progress * 100),
                });
            },
            labyrinth,
            // Absent (every caller that has not opted in) this is false, and
            // taskDamage sits out the run
            Boolean(isTaskFight)
        );

        // Run simulation
        const simResult = combatSimulator.simulate(simulationTimeLimit, precision);

        postMessage({
            type: 'result',
            taskId,
            simResult,
        });
    } catch (error) {
        postMessage({
            type: 'error',
            taskId,
            error: error.message || String(error),
        });
    }
};
