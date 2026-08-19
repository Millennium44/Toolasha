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
/**
 * Feature keys whose most recent teardown threw. Read by `getDisableFailures()`.
 * @type {Set<string>}
 */
const disableFailures = new Set();

/**
 * Record — loudly — that a feature's teardown threw.
 *
 * A teardown that throws part-way is the shape of bug that costs a player the
 * feature for the rest of the session: the old log said only "Failed to disable
 * X" among a screenful of other noise, while the actual damage was that the
 * feature had removed its own UI and then thrown before clearing its
 * initialised flag, so the re-initialise on `character_switched` returned early
 * and the feature stayed dead until a page reload. Every feature's teardown now
 * clears that flag in a `finally`, so this should not happen — which is exactly
 * why it deserves a line that names the feature and says what it costs, visible
 * in the first console screenshot anybody sends.
 *
 * @param {Object} feature - Registry entry that failed
 * @param {Error} error - What its teardown threw
 * @returns {void}
 */
function noteDisableFailure(feature, error) {
    disableFailures.add(feature.key);
    console.error(
        `[FeatureRegistry] ${feature.name} (${feature.key}) threw while disabling — if it did not clear its own ` +
            'initialised flag it will not re-initialise cleanly until the page is reloaded:',
        error
    );
}

/**
 * Feature keys whose last teardown threw, newest state only.
 * @returns {Array<string>} Keys, in insertion order
 */
function getDisableFailures() {
    return [...disableFailures];
}

/**
 * Disable every active feature — the cleanup half of a character switch.
 * @returns {Promise<void>}
 */
async function disableAllFeatures() {
    const cleanupPromises = [];
    disableFailures.clear();
    for (const feature of featureRegistry) {
        try {
            const featureInstance = getFeatureInstance(feature.key);
            if (featureInstance && typeof featureInstance.disable === 'function') {
                const result = featureInstance.disable();
                if (result && typeof result.then === 'function') {
                    cleanupPromises.push(
                        result.catch((error) => {
                            noteDisableFailure(feature, error);
                        })
                    );
                }
            }
        } catch (error) {
            noteDisableFailure(feature, error);
        }
    }
    if (cleanupPromises.length > 0) {
        await Promise.all(cleanupPromises);
    }
    if (disableFailures.size > 0) {
        console.error(
            `[FeatureRegistry] ${disableFailures.size} feature(s) threw while disabling: ${[...disableFailures].join(', ')}`
        );
    }
}

/**
 * Re-initialize all features when the character switches.
 *
 * The switch is driven off two events — `character_switching` (tear down) and
 * `character_switched` (reload settings, re-enable) — and rapid switches used to
 * corrupt the result two ways: a boolean "reinit scheduled" guard silently
 * *dropped* a later switch (A→B→A ended with B's per-character settings applied
 * under A), and `Promise.race([cleanup, setTimeout(500)])` let a rebuild start
 * before the previous character's teardown finished, so init overlapped cleanup.
 *
 * This serializes the whole lifecycle through one promise chain — cleanup and
 * reinit for any switch, and successive switches, run strictly in order, none
 * dropped. And each reinit verifies it is still for the current character
 * (`currentCharacterId` is updated to the new target before `character_switched`
 * fires) before and after every await, so a reinit a newer switch has
 * superseded aborts instead of clobbering the newer character's state — the
 * "latest character wins" invariant. Ported from upstream Celasha/Toolasha#622.
 */
function setupCharacterSwitchHandler() {
    // One chain that every switch step is appended to, so no two ever overlap.
    let lifecycleChain = Promise.resolve();
    const enqueue = (step) => {
        lifecycleChain = lifecycleChain.then(step).catch((error) => {
            console.error('[FeatureRegistry] Character-switch lifecycle step failed:', error);
        });
        return lifecycleChain;
    };

    // Cleanup phase
    dataManager.on('character_switching', () => {
        // Clear the config cache synchronously, before the chain awaits anything,
        // so nothing reads the previous character's settings in the gap.
        if (config && typeof config.clearSettingsCache === 'function') {
            config.clearSettingsCache();
        }
        enqueue(() => disableAllFeatures());
    });

    // Re-initialization phase
    dataManager.on('character_switched', (data) => {
        const targetId = data?.newId ?? null;
        // Still the character this reinit is for? A newer switch updates
        // currentCharacterId synchronously, so a mismatch means this one is stale.
        const isStale = () => targetId !== null && dataManager.getCurrentCharacterId() !== targetId;

        enqueue(async () => {
            if (isStale()) return;

            // Load settings BEFORE any feature initialization so every feature
            // sees the new character's values (loadSettings reads the current id).
            await config.loadSettings();
            config.applyColorSettings();
            if (isStale()) return;

            // Small delay to let game state settle, then re-init with fresh settings
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (isStale()) return;

            await initializeFeatures();
        });
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
    disableAllFeatures,
    getDisableFailures,
    setupCharacterSwitchHandler,
    checkFeatureHealth,
    retryFailedFeatures,
    getFeature,
    getAllFeatures,
    replaceFeatures,
    getFeaturesByCategory,
};
