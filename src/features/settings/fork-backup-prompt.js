/**
 * Fork Backup Prompt
 *
 * A one-time offer, the first time this fork runs on a browser that already
 * carries Toolasha data, to download a full backup before the fork's new
 * settings and defaults come into play — so anyone who later wants to go back
 * to upstream Toolasha (or just undo a bad settings import) has a restore point
 * of exactly the state they had before switching.
 *
 * ## Why it runs before the What's New popup
 *
 * The What's New first-run popup can apply a preset or copy another character's
 * settings, which changes settings in place. The backup has to capture the
 * *pre-fork* state, so the entrypoint awaits this before calling `maybeShow()`.
 *
 * ## Why only for existing users
 *
 * A fresh install has nothing worth backing up, and prompting someone with an
 * empty database to "back up before switching" is just noise — so the prompt is
 * gated on there being real, pre-existing data in the shared database.
 */

import storage from '../../core/storage.js';
import { askChoice } from '../../utils/choice-dialog.js';
import { exportEverythingJSON } from '../../utils/full-backup.js';
import { downloadFile } from '../../utils/csv-export.js';

/** Shown-once flag. Global (not per character): a backup covers every character. */
const PROMPTED_KEY = 'toolasha_forkBackupPrompted';

/** Data stores whose contents mark a browser as an existing Toolasha user. */
const EVIDENCE_STORES = ['networthHistory', 'marketListings', 'xpHistory', 'combatStats', 'alchemyHistory'];

/**
 * Whether the shared database already holds real Toolasha data — i.e. this is
 * an upgrade from (or a switch to) the fork, not a first-ever install.
 * @returns {Promise<boolean>}
 */
async function hasExistingData() {
    for (const store of EVIDENCE_STORES) {
        try {
            const keys = await storage.getAllKeys(store);
            if (keys && keys.length > 0) return true;
        } catch {
            // Store may not exist yet on a very old/new database — not evidence.
        }
    }
    return false;
}

/**
 * Offer a one-time full backup on first fork run. No-ops after it has run once,
 * and for a fresh install with nothing to back up. Never throws — a failure
 * here must not hold up startup.
 *
 * @returns {Promise<void>}
 */
async function maybeShow() {
    try {
        if (await storage.get(PROMPTED_KEY, 'settings', false)) return;

        if (!(await hasExistingData())) {
            await storage.set(PROMPTED_KEY, true, 'settings', true);
            return;
        }

        const choice = await askChoice({
            title: 'Back up before switching to the fork?',
            message:
                "You're now running the Millennium44 fork of Toolasha. It adds a lot of settings and shares your " +
                'existing Toolasha data. Back up everything now so you can restore your current setup if you ever ' +
                'switch back to upstream Toolasha — or need to undo a settings change. You can always back up later ' +
                'from Settings → Back Up Everything.',
            choices: [
                { value: 'backup', label: '💾 Back up everything', tone: 'primary' },
                { value: 'skip', label: 'Skip' },
            ],
        });

        if (choice === 'backup') {
            const json = await exportEverythingJSON();
            const stamp = new Date().toISOString().slice(0, 10);
            downloadFile(`toolasha-backup-${stamp}.json`, json, 'application/json;charset=utf-8;');
        }

        await storage.set(PROMPTED_KEY, true, 'settings', true);
    } catch (error) {
        console.error('[ForkBackupPrompt] Could not show the backup prompt:', error);
    }
}

export default { maybeShow };
