/**
 * Action Countdown
 * Replaces the static time text on the action progress bar with a live countdown.
 * Syncs to the game's progress bar fill via scaleX transform.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';

/** How often the countdown redraws. The readout only shows tenths. */
const TICK_MS = 100;

/**
 * Sanity bounds on the bar's `--duration`, in seconds.
 *
 * The game's own floor is MIN_ACTION_TIME_SECONDS (3s) and no single action
 * runs for ten minutes, so a value outside this window is a corrupt custom
 * property rather than a slow craft. The floor sits well below the game's own
 * so a future balance change cannot make an honest bar look broken.
 */
const MIN_DURATION_SECONDS = 0.5;
const MAX_DURATION_SECONDS = 600;

/**
 * How far `--duration` may sit from the total the game printed on the bar
 * before the animation stops being believed. The larger of the two applies.
 *
 * 0.06s covers half a step of a one-decimal readout plus float slop, so a bar
 * rendered "8.5s" against a duration of 8.51764572272224 still agrees. The 5%
 * ratio absorbs a coarser rendering on a long action, and is still an order of
 * magnitude below the reported failure — a three-second animation sitting on a
 * twenty-eight-second action.
 */
const DURATION_TOLERANCE_SECONDS = 0.06;
const DURATION_TOLERANCE_RATIO = 0.05;

/**
 * Whether a `--duration` reading is a number an action could plausibly take.
 * @param {number} duration - Seconds, as parsed from the custom property
 * @returns {boolean} True when finite and inside the sanity bounds
 */
function isPlausibleDuration(duration) {
    return Number.isFinite(duration) && duration >= MIN_DURATION_SECONDS && duration <= MAX_DURATION_SECONDS;
}

class ActionCountdown {
    constructor() {
        this.initialized = false;
        this.timerId = null;
        this.textEl = null;
        this.fillBar = null;
        this.totalTime = null;
        this.unregisterObserver = null;
        this.unregisterReady = null;
        this.actionCompletedHandler = null;
        this.lastCompletedAt = null;
        this.settingChangeHandler = null;
        this.cachedDuration = null;
        /**
         * The total the game itself printed on the bar, kept apart from
         * `totalTime` so the animation's `--duration` can be cross-checked
         * against a number the animation did not produce.
         * @type {number|null}
         */
        this.textTotalTime = null;
    }

    initialize() {
        if (this.initialized) return;

        if (!this.settingChangeHandler) {
            this.settingChangeHandler = (enabled) => {
                if (enabled) {
                    // Do NOT force `this.initialized = false` here: config.setSetting()
                    // notifies on every call, even when the new value equals the old one
                    // (there is no old-vs-new guard in config.js), so a settings resave or
                    // import can deliver a second "enabled" notification with no
                    // "disabled" in between. Forcing the flag defeated initialize()'s own
                    // `if (this.initialized) return;` guard and re-ran every registration
                    // — a second 'action_completed' listener that disable() could no
                    // longer remove (this.actionCompletedHandler gets overwritten,
                    // orphaning the first one) and a leaked domObserver registration.
                    this.initialize();
                } else {
                    this.disable();
                }
            };
            config.onSettingChange('actionPanel_liveCountdown', this.settingChangeHandler);
        }

        if (!config.getSetting('actionPanel_liveCountdown')) return;

        this.actionCompletedHandler = () => this._onActionCompleted();
        dataManager.on('action_completed', this.actionCompletedHandler);

        this.unregisterObserver = domObserver.onClass('ActionCountdown', 'ProgressBar_text', (el) => {
            this._onProgressBarText(el);
        });

        // @run-at document-start: a progress bar rendered before the shared observer attaches to
        // document.body is invisible to the class watcher, so the catch-up scan waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterReady = domObserver.onReady('ActionCountdownCatchUp', () => {
            const existing = document.querySelector('[class*="ProgressBar_text"]');
            if (existing) {
                this._onProgressBarText(existing);
            }
        });

        this.initialized = true;
    }

    _onProgressBarText(textEl) {
        this.textEl = textEl;
        this.fillBar = null;
        this.cachedDuration = null;
        this.textTotalTime = null;
        this._parseTotalTime();
        this._startLoop();
    }

    /**
     * Re-read the total the game printed on the bar.
     *
     * Our own readout is "3.2s / 8.5s", whose leading number is the time
     * REMAINING. Parsing that back walks the total down towards zero every time
     * this runs, and only `--duration` overwriting it on the next tick hid the
     * damage — the very crutch the cross-check below takes away. The game's own
     * text carries a single number; anything with a separator in it is ours.
     */
    _parseTotalTime() {
        if (!this.textEl) return;
        const span = this.textEl.querySelector('span');
        if (!span) return;
        const text = span.textContent || '';
        if (text.includes('/')) return;
        const val = parseFloat(text);
        if (!isNaN(val) && val > 0) {
            this.totalTime = val;
            this.textTotalTime = val;
        }
    }

    _onActionCompleted() {
        this.lastCompletedAt = Date.now();
        // The bar's `--duration` only changes when a new action starts, so it is
        // re-read once here rather than on every tick
        this.cachedDuration = null;
        setTimeout(() => this._parseTotalTime(), 50);
    }

    /**
     * Find the animated inner bar element.
     * DOM: progressBar > innerBarContainer > innerBar (scaleX animated)
     */
    _findFillBar() {
        if (!this.textEl) return null;
        const parent = this.textEl.parentElement;
        if (!parent) return null;

        for (const child of parent.children) {
            if (child === this.textEl) continue;
            if (child.children.length > 0) {
                for (const grandchild of child.children) {
                    if (grandchild.className?.includes('innerBar')) {
                        return grandchild;
                    }
                }
            }
        }
        return null;
    }

    _startLoop() {
        if (this.timerId) return;
        // The readout shows tenths of a second, so ten redraws a second is all it
        // can display. A rAF loop re-armed every frame woke the countdown 60–120
        // times a second to throw all but every sixth wake-up away; a plain
        // interval asks for exactly the ten it uses, and a background tab gets
        // the browser's own interval throttling for free.
        this.timerId = setInterval(() => this._tick(), TICK_MS);
        this._tick();
    }

    _stopLoop() {
        if (this.timerId) {
            clearInterval(this.timerId);
            this.timerId = null;
        }
    }

    _tick() {
        // No bar to drive: let the loop end. The ProgressBar_text class watcher
        // restarts it when the game renders a new one, so there is no point
        // paying for a wake-up (and two style reads) in the meantime.
        if (!this.textEl || !this.textEl.isConnected) {
            this._stopLoop();
            return;
        }

        // A background tab shows the readout to nobody, and each tick below
        // pays for a computed-style read of the animated bar. The browser
        // throttles the interval to about one wake a second back there; this
        // makes those wakes free, and the first visible tick repaints.
        if (document.hidden) return;

        if (!this.totalTime) return;

        const span = this.textEl.querySelector('span');
        if (!span) return;

        if (!this.fillBar || !this.fillBar.isConnected) {
            this.fillBar = this._findFillBar();
            this.cachedDuration = null;
        }

        let remaining;
        if (this.fillBar) {
            const transform = getComputedStyle(this.fillBar).transform;
            if (transform && transform !== 'none') {
                const match = transform.match(/matrix\(([^)]+)\)/);
                if (match) {
                    const scaleX = parseFloat(match[1]);
                    const duration = this._readDuration();
                    if (this._durationTrusted(duration)) {
                        this.totalTime = duration;
                        remaining = duration * (1 - scaleX);
                    }
                }
            }
        }

        if (remaining === undefined && this.lastCompletedAt) {
            const elapsed = (Date.now() - this.lastCompletedAt) / 1000;
            remaining = Math.max(0, this.totalTime - elapsed);
        }

        if (remaining !== undefined) {
            remaining = Math.max(0, remaining);
            span.textContent = remaining.toFixed(1) + 's / ' + this.totalTime.toFixed(1) + 's';
        }
    }

    /**
     * The bar's `--duration`, cached per action, refused when implausible.
     *
     * A NaN, zero, negative or absurd value is neither cached nor returned: the
     * caller falls through to the wall-clock countdown rather than dividing the
     * readout by nonsense.
     * @returns {number} Seconds, or NaN when the bar has none worth using
     */
    _readDuration() {
        if (this.cachedDuration !== null) return this.cachedDuration;
        const progressBar = this.fillBar?.parentElement?.parentElement;
        const duration = progressBar
            ? parseFloat(getComputedStyle(progressBar).getPropertyValue('--duration'))
            : this.totalTime;
        if (!isPlausibleDuration(duration)) return NaN;
        this.cachedDuration = duration;
        return duration;
    }

    /**
     * Whether the animation's own duration may drive the readout.
     *
     * `--duration` is the game's number, not ours, and it has been seen to
     * disagree with the action the server is actually running: a bar that fills
     * in three seconds and then holds full for twenty-five, because
     * `fill: forwards` parks it there until something restarts it. Adopting the
     * animation's total in that state made our readout repeat the wrong number,
     * and `duration * (1 - scaleX)` doubly wrong — scaleX races the same bad
     * clock.
     *
     * The total the game printed on the bar is the cross-check, because none of
     * it comes from the animation. Past the tolerance the animation is refused
     * and the caller falls back to the wall-clock countdown from that printed
     * total, which needs no animation at all. With no printed total on hand
     * there is nothing to cross-check against, and a plausible duration is
     * accepted exactly as before.
     *
     * @param {number} duration - What `_readDuration()` returned
     * @returns {boolean} True when the animation may be believed
     */
    _durationTrusted(duration) {
        if (!isPlausibleDuration(duration)) return false;
        if (!(this.textTotalTime > 0)) return true;
        const tolerance = Math.max(DURATION_TOLERANCE_SECONDS, this.textTotalTime * DURATION_TOLERANCE_RATIO);
        return Math.abs(duration - this.textTotalTime) <= tolerance;
    }

    disable() {
        try {
            this._stopLoop();
            if (this.textEl && this.totalTime) {
                const span = this.textEl.querySelector('span');
                if (span) {
                    span.textContent = this.totalTime.toFixed(1) + 's';
                }
            }
            if (this.actionCompletedHandler) {
                dataManager.off('action_completed', this.actionCompletedHandler);
                this.actionCompletedHandler = null;
            }
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }
            if (this.unregisterReady) {
                this.unregisterReady();
                this.unregisterReady = null;
            }
            this.textEl = null;
            this.fillBar = null;
            this.totalTime = null;
            this.textTotalTime = null;
            this.cachedDuration = null;
            this.lastCompletedAt = null;
            this.initialized = false;
        } catch (error) {
            console.error('[Action Bar Countdown] Disable failed part-way:', error);
        } finally {
            this.initialized = false;
        }
    }
}

const actionCountdown = new ActionCountdown();

export default actionCountdown;
