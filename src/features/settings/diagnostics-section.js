/**
 * Diagnostics section of the settings panel.
 *
 * The script already knows when it is broken — a health pass, a selector
 * canary, a data-shape canary, and every module's `[Module]` error logs — but
 * all of it surfaced in the console, or in a toast that is gone by the time
 * anybody wonders why a readout disappeared. This section puts the same
 * evidence on the settings page: what build this is and where it is running,
 * what the checks find when asked, and the errors the script's own code has
 * logged this session.
 *
 * Nothing runs until the section is opened, and the checks run only on the
 * button — the health pass walks the page, the selector audit walks every
 * stylesheet, and neither belongs in a settings panel's render.
 *
 * Everything it reads is injectable, so the section can be drawn and driven
 * in a test without a game page behind it; the defaults reach the real
 * modules.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import featureRegistry from '../../core/feature-registry.js';
import * as defaultErrorLog from '../../core/error-log.js';
import { isTestServer } from '../../utils/game-server.js';
import { toolashaRoot } from '../../utils/bundle-bridge.js';
import { buildDiagnosticReport, refreshStorageFacts } from '../dev/health-status.js';

export const DIAGNOSTICS_GROUP_KEY = 'diagnostics';

/** How many errors the copied report carries */
const REPORT_ERROR_LIMIT = 50;

const MONO = 'font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px;';
const PRE_STYLE =
    `${MONO} white-space: pre-wrap; word-break: break-word; margin: 0; padding: 8px 10px; ` +
    'background: #14141f; border: 1px solid #333; border-radius: 4px; color: #ccc; max-height: 320px; overflow: auto;';
const MUTED = 'font-size: 12px; color: #aaa; line-height: 1.5;';
const OK_COLOR = '#4caf50';
const BAD_COLOR = '#ff6b6b';

/**
 * The `@version` Tampermonkey sees — on a dev build it carries a 14-digit
 * build stamp as a fourth segment.
 * @returns {string|null} The installed version string
 */
function installedVersion() {
    try {
        return typeof GM_info !== 'undefined' ? GM_info?.script?.version || null : null;
    } catch {
        return null;
    }
}

/**
 * `3.19.0.20260822153000` → `2026-08-22 15:30:00`, or null when the version
 * carries no stamp.
 * @param {string|null} version - The installed version
 * @returns {string|null} The stamp, readable
 */
export function buildStampFrom(version) {
    const match = /\.(\d{14})$/.exec(version || '');
    if (!match) return null;
    const s = match[1];
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
}

/**
 * Whether a registry entry counts as switched on — the registry's own rule.
 * @param {Object} feature - A registry entry
 * @returns {boolean} True when enabled
 */
function featureEnabled(feature) {
    try {
        return feature.customCheck ? Boolean(feature.customCheck()) : Boolean(config.isFeatureEnabled(feature.key));
    } catch {
        return false;
    }
}

/**
 * The facts the status line states, read fresh each time.
 * @returns {{version: string, build: string|null, server: string, character: string, enabled: number, total: number}}
 */
export function readStatus() {
    const root = toolashaRoot();
    const installed = installedVersion();
    const features = typeof featureRegistry.getAllFeatures === 'function' ? featureRegistry.getAllFeatures() : [];
    let character = null;
    try {
        character = dataManager.getCurrentCharacterName?.() || null;
    } catch {
        character = null;
    }
    return {
        version: root?.version || installed || 'unknown',
        build: buildStampFrom(installed),
        server: isTestServer() ? 'test' : 'live',
        character: character || 'not loaded',
        enabled: features.filter(featureEnabled).length,
        total: features.length,
    };
}

/**
 * The status as one line of text.
 * @param {ReturnType<typeof readStatus>} status - The facts
 * @param {number} errorCount - How many error entries are captured
 * @returns {string} The line
 */
export function statusLine(status, errorCount) {
    const build = status.build ? ` (build ${status.build})` : '';
    return (
        `Toolasha ${status.version}${build} · ${status.server} server · ${status.character} · ` +
        `features ${status.enabled}/${status.total} enabled · errors captured: ${errorCount}`
    );
}

/**
 * "just now", "4m ago", "2h ago", "3d ago".
 * @param {number} ts - When
 * @param {number} now - Now
 * @returns {string} The relative time
 */
export function timeAgo(ts, now = Date.now()) {
    const seconds = Math.max(0, Math.round((now - ts) / 1000));
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

/**
 * The default checks: the entrypoint's canaries through the page's debug
 * namespace, and the health report assembled the way the startup pass does —
 * without opening the health panel, since this *is* the panel now.
 * @returns {Object} The four checks
 */
function defaultChecks() {
    const debug = () => toolashaRoot()?.debug || {};
    const canary = () => (typeof debug().canary === 'function' ? debug().canary() : []);
    const schema = () => (typeof debug().schema === 'function' ? debug().schema() : []);
    return {
        canary,
        schema,
        selectorAudit: () =>
            typeof debug().selectorAudit === 'function'
                ? debug().selectorAudit()
                : { classes: 0, checked: 0, broken: [], unchecked: [] },
        health: async () => {
            const byKey = new Map();
            const lists = [
                typeof featureRegistry.checkFeatureHealth === 'function' ? featureRegistry.checkFeatureHealth() : [],
                canary(),
                schema(),
            ];
            for (const list of lists) {
                for (const failure of list || []) {
                    if (failure?.key && !byKey.has(failure.key)) byKey.set(failure.key, failure);
                }
            }
            await refreshStorageFacts();
            return buildDiagnosticReport([...byKey.values()]);
        },
    };
}

/**
 * Put text on the clipboard; the async API where it exists, a hidden
 * textarea and execCommand where it does not.
 * @param {string} text - What to copy
 * @returns {Promise<boolean>} True when something accepted the text
 */
async function defaultWriteClipboard(text) {
    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* fall through to the textarea */
    }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed; top:-1000px; left:-1000px; opacity:0;';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand ? document.execCommand('copy') : false;
        area.remove();
        return Boolean(ok);
    } catch {
        return false;
    }
}

/**
 * Run every check, tolerating any one of them failing.
 * @param {Object} checks - The four checks
 * @returns {Promise<Object>} Their results, with `errors` for any that threw
 */
export async function runAllChecks(checks) {
    const results = { health: '', canary: [], schema: [], selectorAudit: null, errors: [] };
    const attempt = async (name, run) => {
        try {
            return await run();
        } catch (error) {
            results.errors.push(`${name}: ${error?.message || error}`);
            return null;
        }
    };
    results.canary = (await attempt('canary', checks.canary)) || [];
    results.schema = (await attempt('schema', checks.schema)) || [];
    results.selectorAudit = await attempt('selectorAudit', checks.selectorAudit);
    results.health = (await attempt('health', checks.health)) || '';
    return results;
}

/**
 * Whether a set of results has nothing to complain about.
 * @param {Object} results - From runAllChecks
 * @returns {boolean} True when every list is empty
 */
export function allClear(results) {
    return (
        results.canary.length === 0 &&
        results.schema.length === 0 &&
        (results.selectorAudit?.broken?.length || 0) === 0 &&
        results.errors.length === 0
    );
}

/**
 * One failure as text.
 * @param {{name?: string, key?: string, reason?: string}} failure - A canary or health failure
 * @returns {string} The line
 */
function failureLine(failure) {
    const name = failure?.name || failure?.key || 'unknown';
    const key = failure?.key && failure.key !== name ? ` [${failure.key}]` : '';
    return `${name}${key}: ${failure?.reason || 'failed'}`;
}

/**
 * One broken selector from the audit as text.
 * @param {{name?: string, selector?: string, missing?: string}|string} item - An audit row
 * @returns {string} The line
 */
function brokenSelectorLine(item) {
    if (typeof item === 'string') return item;
    const missing = item?.missing ? ` — missing ${item.missing}` : '';
    return `${item?.name || '?'}: ${item?.selector || ''}${missing}`;
}

/**
 * The check results as pasteable text.
 * @param {Object|null} results - From runAllChecks, or null when not yet run
 * @returns {string[]} Lines
 */
export function checkResultLines(results) {
    if (!results) return ['Checks: not run'];
    const lines = [];
    lines.push(`Checks: ${allClear(results) ? 'all clear' : 'problems found'}`);
    lines.push(`Selector canary (${results.canary.length}):`);
    for (const failure of results.canary) lines.push(`- ${failureLine(failure)}`);
    lines.push(`Schema canary (${results.schema.length}):`);
    for (const failure of results.schema) lines.push(`- ${failureLine(failure)}`);
    const audit = results.selectorAudit;
    if (audit) {
        lines.push(`Selector audit: ${audit.checked} checked against ${audit.classes} classes`);
        lines.push(`- broken (${audit.broken?.length || 0}):`);
        for (const item of audit.broken || []) {
            lines.push(`  - ${brokenSelectorLine(item)}`);
        }
        lines.push(`- unchecked (${audit.unchecked?.length || 0}): ${(audit.unchecked || []).join(', ') || 'none'}`);
    } else {
        lines.push('Selector audit: unavailable');
    }
    for (const error of results.errors) lines.push(`Check failed — ${error}`);
    if (results.health) {
        lines.push('');
        lines.push(results.health);
    }
    return lines;
}

/**
 * One captured error as text.
 * @param {Object} entry - An error-log entry
 * @param {number} now - Now
 * @returns {string} The line
 */
function errorLine(entry, now) {
    const when = new Date(entry.ts).toISOString();
    const count = entry.count > 1 ? ` ×${entry.count}` : '';
    const prefixed = entry.module && entry.message.startsWith(`[${entry.module}]`);
    const module = entry.module && !prefixed ? `[${entry.module}] ` : '';
    const stack = entry.stack ? `\n    ${entry.stack.split('\n').join('\n    ')}` : '';
    return `- ${when} (${timeAgo(entry.ts, now)}) ${entry.kind}${count}: ${module}${entry.message}${stack}`;
}

/**
 * The whole report: status line, check results, the last errors. No setting
 * values and nothing from storage — this is meant to be pasted anywhere.
 * @param {Object} parts - What to include
 * @param {ReturnType<typeof readStatus>} parts.status - The facts
 * @param {Object|null} parts.results - From runAllChecks, or null
 * @param {Array<Object>} parts.errors - Error-log entries, newest first
 * @param {number} [parts.now] - Now
 * @returns {string} The report
 */
export function buildReport({ status, results, errors, now = Date.now() }) {
    const lines = [];
    lines.push('Toolasha diagnostics');
    lines.push('='.repeat(60));
    lines.push(statusLine(status, errors.length));
    lines.push(`takenAt: ${new Date(now).toISOString()}`);
    lines.push(`agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`);
    lines.push('');
    lines.push(...checkResultLines(results));
    lines.push('');
    const shown = errors.slice(0, REPORT_ERROR_LIMIT);
    lines.push(`Captured errors (${shown.length} of ${errors.length}, newest first)`);
    lines.push('-'.repeat(60));
    if (shown.length === 0) lines.push('none');
    for (const entry of shown) lines.push(errorLine(entry, now));
    return lines.join('\n');
}

/**
 * A small element.
 * @param {string} tag - Tag name
 * @param {string} [style] - Inline style
 * @param {string} [text] - Text content
 * @returns {HTMLElement} The element
 */
function el(tag, style = '', text = '') {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text) node.textContent = text;
    return node;
}

/**
 * A button in the settings page's own style.
 * @param {string} label - Its text
 * @param {Function} onClick - What it does
 * @returns {HTMLButtonElement} The button
 */
function button(label, onClick) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'toolasha-utility-button';
    node.textContent = label;
    node.addEventListener('click', onClick);
    return node;
}

/**
 * Build the Diagnostics group: a collapsible section like the schema-driven
 * ones, starting collapsed, whose body is drawn the first time it is opened.
 *
 * @param {Object} [options] - Injection points, all optional
 * @param {Object} [options.errorLog] - getEntries/clear/subscribe
 * @param {Object} [options.checks] - health/canary/schema/selectorAudit
 * @param {Function} [options.status] - Returns the status facts
 * @param {Function} [options.writeClipboard] - Puts text on the clipboard
 * @param {Function} [options.now] - The clock
 * @returns {{element: HTMLElement, open: Function, runChecks: Function, copyReport: Function, destroy: Function}}
 */
export function createDiagnosticsSection(options = {}) {
    const errorLog = options.errorLog || defaultErrorLog;
    const checks = { ...defaultChecks(), ...(options.checks || {}) };
    const status = options.status || readStatus;
    const writeClipboard = options.writeClipboard || defaultWriteClipboard;
    const now = options.now || (() => Date.now());

    const group = document.createElement('div');
    group.className = 'toolasha-settings-group collapsed';
    group.dataset.group = DIAGNOSTICS_GROUP_KEY;

    const header = document.createElement('h3');
    header.className = 'toolasha-settings-group-header';
    header.innerHTML = '<span class="collapse-icon">▼</span><span class="icon">🩺</span>Diagnostics';

    const content = document.createElement('div');
    content.className = 'toolasha-settings-group-content toolasha-diagnostics';

    group.appendChild(header);
    group.appendChild(content);

    let built = false;
    let unsubscribe = null;
    let lastResults = null;
    let statusEl = null;
    let resultsEl = null;
    let errorsEl = null;
    let errorsTitle = null;

    const currentErrors = () => {
        try {
            return errorLog.getEntries() || [];
        } catch {
            return [];
        }
    };

    const renderStatus = () => {
        if (!statusEl) return;
        try {
            statusEl.textContent = statusLine(status(), currentErrors().length);
        } catch (error) {
            statusEl.textContent = `Status unavailable: ${error?.message || error}`;
        }
    };

    const renderErrors = () => {
        if (!errorsEl) return;
        const entries = currentErrors();
        errorsTitle.textContent = entries.length
            ? `Captured errors (${entries.length}, newest first)`
            : 'Captured errors: none this session';
        errorsEl.textContent = '';
        const nowTs = now();
        for (const entry of entries) {
            const row = el('div', 'padding: 6px 8px; border-bottom: 1px solid #2a2a3a; cursor: pointer;');
            row.className = 'toolasha-diagnostics-error';
            row.dataset.kind = entry.kind;
            const head = el('div', 'display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;');
            const badge = el(
                'span',
                `${MONO} padding: 1px 6px; border-radius: 3px; background: #3a2a5a; color: #d7c4ff;`,
                entry.module || entry.kind
            );
            badge.className = 'toolasha-diagnostics-module';
            head.appendChild(badge);
            head.appendChild(el('span', 'font-size: 11px; color: #888;', timeAgo(entry.ts, nowTs)));
            if (entry.count > 1) {
                const count = el('span', 'font-size: 11px; color: #ffa726;', `×${entry.count}`);
                count.className = 'toolasha-diagnostics-count';
                head.appendChild(count);
            }
            const message = el('div', 'font-size: 12px; color: #ddd; word-break: break-word;', entry.message);
            message.className = 'toolasha-diagnostics-message';
            row.appendChild(head);
            row.appendChild(message);
            if (entry.stack) {
                const stack = el('pre', `${PRE_STYLE} display: none; margin-top: 6px; max-height: 200px;`, entry.stack);
                stack.className = 'toolasha-diagnostics-stack';
                row.appendChild(stack);
                row.addEventListener('click', () => {
                    stack.style.display = stack.style.display === 'none' ? 'block' : 'none';
                });
            }
            errorsEl.appendChild(row);
        }
    };

    /**
     * A titled list of failures, or nothing when the list is empty.
     * @param {string} title - What these are
     * @param {Array} items - The failures
     * @param {Function} [format] - Item → text
     * @returns {HTMLElement|null} The block
     */
    const failureBlock = (title, items, format = failureLine) => {
        if (!items?.length) return null;
        const block = el('div', 'margin-top: 8px;');
        block.appendChild(
            el('div', `font-size: 12px; color: ${BAD_COLOR}; font-weight: 600;`, `${title} (${items.length})`)
        );
        const list = el('ul', 'margin: 4px 0 0 18px; padding: 0; font-size: 12px; color: #ddd;');
        for (const item of items) list.appendChild(el('li', '', format(item)));
        block.appendChild(list);
        return block;
    };

    const renderResults = (results) => {
        if (!resultsEl) return;
        resultsEl.textContent = '';
        if (!results) return;
        const verdict = el(
            'div',
            `font-size: 12px; font-weight: 600; color: ${allClear(results) ? OK_COLOR : BAD_COLOR};`,
            allClear(results) ? '✓ All clear — every check passed' : '✗ Problems found'
        );
        verdict.className = 'toolasha-diagnostics-verdict';
        resultsEl.appendChild(verdict);

        const canaryBlock = failureBlock('Selector canary', results.canary);
        if (canaryBlock) resultsEl.appendChild(canaryBlock);
        const schemaBlock = failureBlock('Schema canary', results.schema);
        if (schemaBlock) resultsEl.appendChild(schemaBlock);

        const audit = results.selectorAudit;
        if (audit) {
            const auditLine = el(
                'div',
                `${MUTED} margin-top: 8px;`,
                `Selector audit: ${audit.checked} selectors checked against ${audit.classes} game classes`
            );
            auditLine.className = 'toolasha-diagnostics-audit';
            resultsEl.appendChild(auditLine);
            const broken = failureBlock('Broken selectors', audit.broken, brokenSelectorLine);
            if (broken) resultsEl.appendChild(broken);
            if (audit.unchecked?.length) {
                resultsEl.appendChild(
                    el(
                        'div',
                        `${MUTED} margin-top: 4px;`,
                        `Unchecked (not class-shaped, verify by hand): ${audit.unchecked.join(', ')}`
                    )
                );
            }
        }
        const checkErrors = failureBlock('Checks that could not run', results.errors, (text) => text);
        if (checkErrors) resultsEl.appendChild(checkErrors);

        if (results.health) {
            const details = document.createElement('details');
            details.style.cssText = 'margin-top: 8px;';
            const summary = el('summary', `${MUTED} cursor: pointer;`, 'Health report');
            details.appendChild(summary);
            const pre = el('pre', `${PRE_STYLE} margin-top: 6px;`, results.health);
            pre.className = 'toolasha-diagnostics-health';
            details.appendChild(pre);
            resultsEl.appendChild(details);
        }
    };

    const runChecks = async () => {
        lastResults = await runAllChecks(checks);
        renderResults(lastResults);
        renderStatus();
        return lastResults;
    };

    const copyReport = async () => {
        const text = buildReport({ status: status(), results: lastResults, errors: currentErrors(), now: now() });
        const ok = await writeClipboard(text);
        return { ok, text };
    };

    const build = () => {
        if (built) return;
        built = true;

        statusEl = el('div', `${MUTED} ${MONO} padding: 6px 0;`);
        statusEl.className = 'toolasha-diagnostics-status';
        content.appendChild(statusEl);

        const buttons = el('div', 'display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 8px;');
        const runBtn = button('Run checks', async () => {
            if (runBtn.disabled) return;
            runBtn.disabled = true;
            runBtn.textContent = 'Running…';
            try {
                await runChecks();
            } finally {
                runBtn.disabled = false;
                runBtn.textContent = 'Run checks';
            }
        });
        runBtn.className += ' toolasha-diagnostics-run';
        const copyBtn = button('Copy report', async () => {
            const { ok } = await copyReport();
            copyBtn.textContent = ok ? 'Copied ✓' : 'Copy failed';
            setTimeout(() => {
                copyBtn.textContent = 'Copy report';
            }, 2000);
        });
        copyBtn.className += ' toolasha-diagnostics-copy';
        const clearBtn = button('Clear errors', () => {
            try {
                errorLog.clear();
            } catch {
                /* nothing to clear */
            }
            renderErrors();
            renderStatus();
        });
        clearBtn.className += ' toolasha-diagnostics-clear';
        buttons.appendChild(runBtn);
        buttons.appendChild(copyBtn);
        buttons.appendChild(clearBtn);
        content.appendChild(buttons);

        resultsEl = el('div', 'margin-bottom: 8px;');
        resultsEl.className = 'toolasha-diagnostics-results';
        content.appendChild(resultsEl);

        errorsTitle = el('div', 'font-size: 12px; font-weight: 600; color: #ccc; margin: 8px 0 4px;');
        errorsTitle.className = 'toolasha-diagnostics-errors-title';
        content.appendChild(errorsTitle);
        errorsEl = el('div', 'border: 1px solid #2a2a3a; border-radius: 4px; max-height: 360px; overflow: auto;');
        errorsEl.className = 'toolasha-diagnostics-errors';
        content.appendChild(errorsEl);

        renderStatus();
        renderErrors();
        try {
            unsubscribe = errorLog.subscribe(() => {
                renderErrors();
                renderStatus();
            });
        } catch {
            unsubscribe = null;
        }
    };

    const open = () => {
        group.classList.remove('collapsed');
        build();
    };

    header.addEventListener('click', () => {
        if (group.classList.contains('collapsed')) open();
        else group.classList.add('collapsed');
    });

    const destroy = () => {
        if (unsubscribe) unsubscribe();
        unsubscribe = null;
    };

    return { element: group, open, runChecks, copyReport, destroy };
}

export default createDiagnosticsSection;
