/**
 * A plain-text report of the last pull, for pasting to a developer.
 *
 * When a pull asks for "Reload now", some keys latched — the stores took the write and refuse more until
 * a reload. Making each of those live-safe takes knowing which they were and what the sync knows about
 * them; this names them. It carries key names and counts only: never a stored value, token, gist id or
 * character name. Character ids are part of key names and stay.
 */

import { mergeForKey } from '../../utils/sync-merge-registry.js';
import { OWNED_KEY_PREFIXES, ownsKey } from './sync-ownership.js';
import { formatPullSummaryLine, formatPullStoreLine } from './pull-summary.js';

/** The line the report opens with, so a reader knows what it holds */
export const REPORT_PRIVACY_LINE = 'Contains key names and counts only, no saved values.';

/** Keys named per list before the rest are counted */
const MAX_KEYS = 400;

/**
 * A key with its per-character suffix removed (`watchlist_30404` → `watchlist`).
 * `character-key.js` builds `${base}_${characterId}` (or `_default` before login). A few records lead with the
 * id instead (`603281_inventoryTabs_config`), so a leading `<digits>_` is removed too.
 * @param {string} key - Storage key
 * @returns {string} The base
 */
export function stripCharacterSuffix(key) {
    return String(key)
        .replace(/_(?:default|[0-9]+)$/, '')
        .replace(/^[0-9]+_/, '');
}

/**
 * What the sync knows about one key.
 * @param {string} store - Object store
 * @param {string} key - Storage key
 * @returns {{base: string, registered: boolean, label: string|null, liveSafe: boolean, owned: boolean,
 *   ownerPrefix: string|null}} The facts
 */
export function describeSyncKey(store, key) {
    let registration = null;
    try {
        registration = mergeForKey(store, key);
    } catch {
        registration = null;
    }
    let owned = false;
    try {
        owned = ownsKey(store, key);
    } catch {
        owned = false;
    }
    return {
        base: stripCharacterSuffix(key),
        registered: Boolean(registration),
        label: registration?.label || null,
        liveSafe: registration?.liveSafe === true,
        owned,
        ownerPrefix: OWNED_KEY_PREFIXES.find((prefix) => String(key).startsWith(prefix)) || null,
    };
}

/**
 * @param {string} store - Store name
 * @param {string} key - Storage key
 * @param {string} status - `LATCHED`, `MERGE FAILED`, both, or `written whole`
 * @returns {string} One report line
 */
function keyLine(store, key, status) {
    const info = describeSyncKey(store, key);
    const registration = info.registered
        ? `registered="${info.label}"${info.liveSafe ? ' live-safe' : ' NOT live-safe'}`
        : 'unregistered';
    const owner = info.owned
        ? info.ownerPrefix
            ? `prefix ${info.ownerPrefix}`
            : 'owned (store or pattern)'
        : 'not owned';
    return [
        `${store} / ${key}`,
        status,
        `base=${info.base}`,
        registration,
        `owner=${owner}`,
        'writer=not recorded',
    ].join(' | ');
}

/**
 * Build the report text.
 * @param {Object|null} summary - From `buildPullSummary`
 * @param {Object} [env] - Where the report was made
 * @param {string|null} [env.version] - Script version, with the build stamp when there is one
 * @param {string|null} [env.host] - `location.hostname`
 * @returns {string} The report
 */
export function buildPullReport(summary, { version = null, host = null } = {}) {
    const lines = [REPORT_PRIVACY_LINE, ''];
    if (!summary) {
        lines.push('No pull has run in this session.');
        return lines.join('\n');
    }
    const lower = String(host || '').toLowerCase();
    const server = lower.startsWith('test.') ? 'test' : lower ? 'live' : 'unknown';
    lines.push(`Toolasha: ${version || 'unknown'}`);
    lines.push(`Host: ${host || 'unknown'} (${server})`);
    lines.push(`Pull time: ${summary.at || 'unknown'}`);
    lines.push(`Summary: ${formatPullSummaryLine(summary)}`);
    const latchedCount = Number.isFinite(summary.latched) ? summary.latched : null;
    const advice = latchedCount === null ? 'unknown' : latchedCount > 0 ? 'yes' : 'no';
    lines.push(`Reload advice shown: ${advice} (latched keys: ${latchedCount === null ? 'unknown' : latchedCount})`);

    const failed = summary.stores.flatMap((store) =>
        store.overwrittenRecords.map((record) => `${store.store}/${record.label}`)
    );
    const held = summary.stores.flatMap((store) => store.heldRecords.map((record) => `${store.store}/${record.label}`));
    if (failed.length) lines.push(`Merge failed: ${failed.join(', ')}`);
    if (held.length) lines.push(`Held: ${held.join(', ')}`);

    lines.push('', 'Stores:');
    for (const store of summary.stores) lines.push(`  ${formatPullStoreLine(store)}`);

    const keyed = [];
    for (const store of summary.stores) {
        const latched = new Set((store.latchedRecords || []).map((record) => record.key));
        const failed = new Set((store.overwrittenRecords || []).map((record) => record.key));
        const named = new Set([...latched, ...failed]);
        for (const key of named) {
            const status = [latched.has(key) ? 'LATCHED' : null, failed.has(key) ? 'MERGE FAILED' : null];
            keyed.push([store.store, key, status.filter(Boolean).join(', '), latched.has(key) ? 0 : 1]);
        }
        for (const record of store.wholeRecords || []) {
            if (!named.has(record.key)) keyed.push([store.store, record.key, 'written whole', 2]);
        }
    }
    // Latched keys first: they are what forced the reload; failed folds next
    keyed.sort((a, b) => a[3] - b[3]);
    lines.push('', `Keys (latched, merge failed or written whole): ${keyed.length}`);
    for (const [store, key, status] of keyed.slice(0, MAX_KEYS)) lines.push(`  ${keyLine(store, key, status)}`);
    if (keyed.length > MAX_KEYS) lines.push(`  ...and ${keyed.length - MAX_KEYS} more`);
    return lines.join('\n');
}

export default { REPORT_PRIVACY_LINE, stripCharacterSuffix, describeSyncKey, buildPullReport };
