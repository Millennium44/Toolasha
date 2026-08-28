/**
 * Claim Toast
 *
 * Claiming a task removes its card from the board and the rewards go with it
 * — there is nothing left on screen saying what it paid, whether the claim
 * came from the game's own button or the Claim Collector's proxy. This turns
 * each claim `task-completion-tracker.js` records into a short toast: the
 * coins, the tokens, and whichever items rode along.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { showToast } from '../../utils/toast.js';
import { formatKMB } from '../../utils/formatters.js';
import taskCompletionTracker from './task-completion-tracker.js';

/**
 * The item names for a claim, resolved at display time.
 *
 * The tracker keeps only hrids and counts — a toast is the one place in this
 * feature set where a lookup for a display name is worth doing per claim.
 *
 * @param {Array<{itemHrid: string, count: number}>} items
 * @returns {string} A short, comma-joined list; '' when there are none
 */
export function describeItems(items) {
    if (!items?.length) return '';

    const names = items.map((item) => {
        const detail = dataManager.getItemDetails?.(item.itemHrid);
        const name = detail?.name || item.itemHrid?.split('/').pop()?.replace(/_/g, ' ') || 'item';
        return item.count > 1 ? `${item.count}x ${name}` : name;
    });

    if (names.length <= 3) return names.join(', ');
    return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

/**
 * The toast's message for one claimed task.
 *
 * @param {Object} entry - A completion, from `task-completion-tracker.js`
 * @returns {string} Plain text
 */
export function formatClaimMessage(entry) {
    const parts = [];
    if (entry?.coins > 0) parts.push(`${formatKMB(entry.coins)} coins`);
    if (entry?.tokens > 0) parts.push(`${entry.tokens} token${entry.tokens === 1 ? '' : 's'}`);

    const items = describeItems(entry?.items);
    if (items) parts.push(items);

    const reward = parts.length ? parts.join(', ') : 'nothing';
    const name = entry?.name || 'Task';
    return `Claimed: ${name} — ${reward}`;
}

class TaskClaimToast {
    constructor() {
        this.isInitialized = false;
        this.unsubscribe = null;
    }

    setupSettingListener() {
        config.onSettingChange('taskClaimToast', (enabled) => {
            if (enabled) {
                this.initialize();
            } else {
                this.disable();
            }
        });
    }

    initialize() {
        if (!config.getSetting('taskClaimToast')) return;
        if (this.isInitialized) return;
        this.isInitialized = true;

        this.unsubscribe = taskCompletionTracker.onCompletion((entries) => {
            for (const entry of entries) {
                try {
                    showToast(formatClaimMessage(entry), { kind: 'info' });
                } catch (error) {
                    console.error('[TaskClaimToast] Showing the toast failed:', error);
                }
            }
        });

        // The rate tile keeps this running unconditionally already; calling it
        // here too costs nothing — it is idempotent — and this feature must
        // not depend on that tile being enabled to see completions.
        taskCompletionTracker.initialize();
    }

    disable() {
        try {
            if (this.unsubscribe) {
                this.unsubscribe();
                this.unsubscribe = null;
            }
        } catch (error) {
            console.error('[TaskClaimToast] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const taskClaimToast = new TaskClaimToast();

taskClaimToast.setupSettingListener();

export default taskClaimToast;
