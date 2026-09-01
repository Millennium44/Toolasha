/**
 * Insights
 *
 * Features that measure this script against reality rather than adding to the
 * page. Prediction calibration checks the profit calculators' forecasts
 * against what the loot log says the runs actually paid; combat calibration
 * checks the all-zones simulator against archived combat sessions; enhancement
 * calibration reads finished enhancement runs back as percentiles of the
 * attempt distributions predicted for them.
 *
 * The recorders and the panel are separate files so the panel can read the
 * recorders without them having to know a panel exists. This module is where
 * they are put together and handed to the feature registry.
 */

import { predictionCalibration } from './prediction-calibration.js';
import { combatCalibration } from './combat-calibration.js';
import { enhancementCalibration } from './enhancement-calibration.js';
import { calibrationPanel, registerCalibrationRow, forgetAlchemySessions } from './calibration-panel.js';

export { calibrationPanel, predictionCalibration, combatCalibration, enhancementCalibration };

export default {
    name: 'Prediction Calibration',
    initialize: async () => {
        const enabled = await predictionCalibration.initialize();
        // One switch for the whole ledger: the combat recorder writes into the
        // same history, so it comes up and goes down with the main one. The
        // enhancement recorder is passive — the tracker calls it on completion
        // and it checks the setting itself — so it has nothing to bring up.
        if (enabled) {
            await combatCalibration.initialize();
            // Registered here rather than at module scope so switching the
            // feature off leaves no tile in the overlay and no entry in the
            // command palette
            registerCalibrationRow();
        }
    },
    cleanup: () => {
        combatCalibration.disable();
        predictionCalibration.disable();
        enhancementCalibration.disable();
        // The panel's own cache of the alchemy trackers' sessions is character
        // data too, and outlived the two record caches above by up to fifteen
        // seconds — enough for the panel opened right after a switch to show
        // the departing character's success rates
        forgetAlchemySessions();
    },
    getRecords: () => predictionCalibration.getRecords(),
    clear: () => predictionCalibration.clear(),
};
