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
    }

    initialize() {
        if (this.initialized) return;

        if (!this.settingChangeHandler) {
            this.settingChangeHandler = (enabled) => {
                if (enabled) {
                    this.initialized = false;
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
        this._parseTotalTime();
        this._startLoop();
    }

    _parseTotalTime() {
        if (!this.textEl) return;
        const span = this.textEl.querySelector('span');
        if (!span) return;
        const val = parseFloat(span.textContent);
        if (!isNaN(val) && val > 0) {
            this.totalTime = val;
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
                    if (duration > 0) {
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
     * The bar's `--duration`, cached per action.
     * @returns {number} Seconds, or NaN when the bar has none
     */
    _readDuration() {
        if (this.cachedDuration !== null) return this.cachedDuration;
        const progressBar = this.fillBar?.parentElement?.parentElement;
        const duration = progressBar
            ? parseFloat(getComputedStyle(progressBar).getPropertyValue('--duration'))
            : this.totalTime;
        if (duration > 0) {
            this.cachedDuration = duration;
        }
        return duration;
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
