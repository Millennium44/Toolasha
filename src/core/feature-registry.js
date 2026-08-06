/**
 * Feature Registry
 * Centralized feature initialization system
 */

import config from './config.js';
import dataManager from './data-manager.js';
import performanceMonitor from '../utils/performance-monitor.js';

/**
 * Feature Registry
 * Populated at runtime by the entrypoint to avoid bundling feature code in core.
 */
const featureRegistry = [];

/**
 * Initialize all enabled features
 *
 * Returns what failed rather than only logging it. An initializer that throws
 * used to reach the player as a feature that is simply absent, with the reason
 * in a console nobody has open; the caller needs the list to be able to say so.
 *
 * @returns {Promise<Array<{key: string, name: string, reason: string}>>} Failures, in registry order
 */
async function initializeFeatures() {
    // Block feature initialization during character switch
    if (dataManager.getIsCharacterSwitching()) {
        return [];
    }

    const errors = [];
    performanceMonitor.mark('features:start', { registered: featureRegistry.length });

    for (const feature of featureRegistry) {
        try {
            const isEnabled = feature.customCheck ? feature.customCheck() : config.isFeatureEnabled(feature.key);

            if (!isEnabled) {
                continue;
            }

            // Initialize feature. Always await so rejections from async
            // initializers land in this try/catch even when the registry
            // entry forgot to set the async flag (awaiting sync undefined
            // is harmless).
            //
            // The timing is split on purpose. The old single wall-clock span
            // around `await feature.initialize()` blamed a feature for time
            // it merely *parked* in — a sync feature (e.g. autoAllButton) that
            // happens to `await undefined` at the moment a heavy storage read
            // resolves elsewhere would absorb that read's cost and top the
            // "slowest features" list while doing nothing. `own` is the
            // feature's synchronous work up to the point it returns/suspends;
            // `total` still spans the await so a genuinely async initializer is
            // not undercounted. A large gap between them means the cost is
            // deferred work draining here, not this feature.
            const startedAt = performanceMonitor.sinceBoot();
            const pending = feature.initialize();
            const ownMs = performanceMonitor.sinceBoot() - startedAt;
            await pending;
            const totalMs = performanceMonitor.sinceBoot() - startedAt;
            performanceMonitor.snapshot(`init:${feature.key}`, totalMs, startedAt);
            if (totalMs - ownMs >= 1) {
                performanceMonitor.snapshot(`init:${feature.key}:own`, ownMs, startedAt);
            }
        } catch (error) {
            errors.push({
                key: feature.key,
                name: feature.name,
                reason: `Initialization threw: ${error.message}`,
            });
            console.error(`[Toolasha] Failed to initialize ${feature.name}:`, error);
        }
    }

    performanceMonitor.mark('features:done', { failed: errors.length });

    // Log errors if any occurred
    if (errors.length > 0) {
        console.error(`[Toolasha] ${errors.length} feature(s) failed to initialize`, errors);
    }

    return errors;
}

/**
 * Get feature by key
 * @param {string} key - Feature key
 * @returns {Object|null} Feature definition or null
 */
function getFeature(key) {
    return featureRegistry.find((f) => f.key === key) || null;
}

/**
 * Get all features
 * @returns {Array} Feature registry
 */
function getAllFeatures() {
    return [...featureRegistry];
}

/**
 * Get features by category
 * @param {string} category - Category name
 * @returns {Array} Features in category
 */
function getFeaturesByCategory(category) {
    return featureRegistry.filter((f) => f.category === category);
}

/**
 * Check health of all initialized features
 * @returns {Array<Object>} Array of failed features with details
 */
function checkFeatureHealth() {
    const failed = [];

    for (const feature of featureRegistry) {
        // Skip if feature has no health check
        if (!feature.healthCheck) continue;

        // Skip if feature is not enabled
        const isEnabled = feature.customCheck ? feature.customCheck() : config.isFeatureEnabled(feature.key);

        if (!isEnabled) continue;

        try {
            const result = feature.healthCheck();

            // null = can't verify (DOM not ready), false = failed, true = healthy
            if (result === false) {
                failed.push({
                    key: feature.key,
                    name: feature.name,
                    reason: 'Health check returned false',
                });
            }
        } catch (error) {
            failed.push({
                key: feature.key,
                name: feature.name,
                reason: `Health check error: ${error.message}`,
            });
        }
    }

    return failed;
}

/**
 * Setup character switch handler
 * Re-initializes all features when character switches
 */
function setupCharacterSwitchHandler() {
    // Promise that resolves when cleanup is complete
    let cleanupPromise = null;
    let reinitScheduled = false;

    // Handle character_switching event (cleanup phase)
    dataManager.on('character_switching', async (_data) => {
        cleanupPromise = (async () => {
            try {
                // Clear config cache IMMEDIATELY to prevent stale settings
                if (config && typeof config.clearSettingsCache === 'function') {
                    config.clearSettingsCache();
                }

                // Disable all active features (cleanup DOM elements, event listeners, etc.)
                const cleanupPromises = [];
                for (const feature of featureRegistry) {
                    try {
                        const featureInstance = getFeatureInstance(feature.key);
                        if (featureInstance && typeof featureInstance.disable === 'function') {
                            const result = featureInstance.disable();
                            if (result && typeof result.then === 'function') {
                                cleanupPromises.push(
                                    result.catch((error) => {
                                        console.error(`[FeatureRegistry] Failed to disable ${feature.name}:`, error);
                                    })
                                );
                            }
                        }
                    } catch (error) {
                        console.error(`[FeatureRegistry] Failed to disable ${feature.name}:`, error);
                    }
                }

                // Wait for all cleanup in parallel
                if (cleanupPromises.length > 0) {
                    await Promise.all(cleanupPromises);
                }
            } catch (error) {
                console.error('[FeatureRegistry] Error during character switch cleanup:', error);
            }
        })();

        await cleanupPromise;
    });

    // Handle character_switched event (re-initialization phase)
    dataManager.on('character_switched', async (_data) => {
        // Prevent multiple overlapping reinits
        if (reinitScheduled) {
            return;
        }

        reinitScheduled = true;

        try {
            // Wait for cleanup to complete (with safety timeout)
            if (cleanupPromise) {
                await Promise.race([cleanupPromise, new Promise((resolve) => setTimeout(resolve, 500))]);
            }

            // CRITICAL: Load settings BEFORE any feature initialization
            // This ensures all features see the new character's settings
            await config.loadSettings();
            config.applyColorSettings();

            // Small delay to ensure game state is stable
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Now re-initialize all features with fresh settings
            await initializeFeatures();
        } catch (error) {
            console.error('[FeatureRegistry] Error during feature reinitialization:', error);
        } finally {
            reinitScheduled = false;
        }
    });
}

/**
 * Get feature instance from imported module
 * @param {string} key - Feature key
 * @returns {Object|null} Feature instance or null
 * @private
 */
function getFeatureInstance(key) {
    const feature = getFeature(key);
    if (!feature) {
        return null;
    }

    return feature.module || feature;
}

/**
 * Retry initialization for specific features
 *
 * Reports back what is still broken afterwards, so a caller can tell the
 * difference between a feature that recovered on the second attempt — the
 * common case, where the game panel it anchors to had not been drawn yet — and
 * one that is genuinely not coming up. Only the second is worth interrupting
 * anybody about.
 *
 * @param {Array<Object>} failedFeatures - Array of failed feature objects
 * @returns {Promise<Array<{key: string, name: string, reason: string}>>} Those still failing
 */
async function retryFailedFeatures(failedFeatures) {
    const stillFailed = [];

    for (const failed of failedFeatures) {
        const feature = getFeature(failed.key);
        if (!feature) continue;

        try {
            await feature.initialize();

            // Verify the retry actually worked by running health check
            if (feature.healthCheck) {
                const healthResult = feature.healthCheck();
                if (healthResult === false) {
                    console.warn(`[Toolasha] ${feature.name} retry completed but health check still fails`);
                    stillFailed.push({
                        key: feature.key,
                        name: feature.name,
                        reason: 'Retried, but its health check still fails',
                    });
                }
            }
        } catch (error) {
            console.error(`[Toolasha] ${feature.name} retry failed:`, error);
            stillFailed.push({
                key: feature.key,
                name: feature.name,
                reason: `Retry threw: ${error.message}`,
            });
        }
    }

    return stillFailed;
}

/**
 * Replace the feature registry (for library split)
 * @param {Array} newFeatures - New feature registry array
 */
function replaceFeatures(newFeatures) {
    featureRegistry.length = 0; // Clear existing array
    featureRegistry.push(...newFeatures); // Add new features
}

export default {
    initializeFeatures,
    setupCharacterSwitchHandler,
    checkFeatureHealth,
    retryFailedFeatures,
    getFeature,
    getAllFeatures,
    replaceFeatures,
    getFeaturesByCategory,
};
