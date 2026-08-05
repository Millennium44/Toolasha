/**
 * Insights
 *
 * Features that measure this script against reality rather than adding to the
 * page. The first of them is prediction calibration: the profit calculators'
 * forecasts, checked against what the loot log says the runs actually paid.
 *
 * The recorder and the panel are separate files so the panel can read the
 * recorder without the recorder having to know a panel exists. This module is
 * where the two are put together and handed to the feature registry.
 */

import { predictionCalibration } from './prediction-calibration.js';
import { calibrationPanel, registerCalibrationRow } from './calibration-panel.js';

export { calibrationPanel, predictionCalibration };

export default {
    name: 'Prediction Calibration',
    initialize: async () => {
        const enabled = await predictionCalibration.initialize();
        // Registered here rather than at module scope so switching the feature
        // off leaves no tile in the overlay and no entry in the command palette
        if (enabled) registerCalibrationRow();
    },
    cleanup: () => predictionCalibration.disable(),
    getRecords: () => predictionCalibration.getRecords(),
    clear: () => predictionCalibration.clear(),
};
