/**
 * Selector audit — the game update post-mortem, as one console command.
 *
 * The game ships CSS-module classes (`Component_name__hash`), and every one of
 * them appears in the page's stylesheets whether or not the element it styles
 * is currently drawn. That makes the stylesheets a complete, always-loaded
 * inventory of what the game calls things — and diffing this script's selector
 * registry against it says which selectors a game update broke without
 * visiting a single screen. This found two renamed classes and two rotated
 * hashes on 2026-08-17; `Toolasha.debug.selectorAudit()` makes the technique a
 * standing tool instead of a one-off session trick.
 *
 * What it can check: `class*=` prefixes (must appear inside some stylesheet
 * class name) and full hashed literals (must appear exactly). What it cannot:
 * selectors built from neither — those are reported as unchecked rather than
 * silently passed. The registry in utils/selectors.js is the inventory; a
 * selector a feature keeps privately can be handed in via `extra`.
 */

import { GAME } from '../../utils/selectors.js';

/**
 * Every CSS-module-shaped class name in the document's stylesheets.
 *
 * Cross-origin sheets throw on `cssRules` and are skipped — the game's own
 * sheets are same-origin, which is the inventory this wants.
 *
 * @param {Document} [doc=document] - Injectable for tests
 * @returns {Set<string>} Full class names, e.g. `GuildPanel_tile__2xQpF`
 */
export function collectStylesheetClasses(doc = document) {
    const classes = new Set();
    for (const sheet of doc.styleSheets) {
        let rules;
        try {
            rules = sheet.cssRules;
        } catch {
            continue; // cross-origin
        }
        for (const rule of rules) {
            const selector = rule.selectorText;
            if (!selector) continue;
            for (const match of selector.matchAll(/\.([A-Za-z]+_[A-Za-z0-9]+__[A-Za-z0-9_-]+)/g)) {
                classes.add(match[1]);
            }
        }
    }
    return classes;
}

/**
 * Judge one selector against the stylesheet inventory.
 *
 * @param {string} selector - A CSS selector
 * @param {Set<string>} classSet - From {@link collectStylesheetClasses}
 * @returns {{status: 'ok'|'broken'|'unchecked', missing: Array<string>}}
 */
export function auditSelector(selector, classSet) {
    const text = String(selector);
    // Only CSS-module-shaped prefixes (Component_name) can be judged against
    // the module-class inventory — a MUI prefix like MuiTabs-flexContainer is
    // real but never enters the set, and judging it there is a false alarm
    const prefixes = [...text.matchAll(/class[*^]?=["']([^"']+)["']/g)]
        .map((match) => match[1])
        .filter((prefix) => /^[A-Z][A-Za-z]*_[A-Za-z]/.test(prefix));
    const hashed = [...text.matchAll(/\.([A-Za-z]+_[A-Za-z0-9]+__[A-Za-z0-9_-]+)/g)].map((match) => match[1]);
    if (!prefixes.length && !hashed.length) return { status: 'unchecked', missing: [] };

    const names = [...classSet];
    const missing = [
        ...prefixes.filter((prefix) => !names.some((name) => name.includes(prefix))),
        ...hashed.filter((hash) => !classSet.has(hash)),
    ];
    return { status: missing.length ? 'broken' : 'ok', missing };
}

/**
 * Audit a named set of selectors against a class inventory. Pure — the console
 * command wraps it with the live registry and the live stylesheets.
 *
 * @param {Object<string, string>} selectors - name → selector
 * @param {Set<string>} classSet - From {@link collectStylesheetClasses}
 * @returns {{checked: number, broken: Array, unchecked: Array<string>}}
 */
export function auditSelectors(selectors, classSet) {
    const broken = [];
    const unchecked = [];
    let checked = 0;
    for (const [name, selector] of Object.entries(selectors)) {
        const verdict = auditSelector(selector, classSet);
        if (verdict.status === 'unchecked') {
            unchecked.push(name);
            continue;
        }
        checked++;
        if (verdict.status === 'broken') broken.push({ name, selector, missing: verdict.missing.join(', ') });
    }
    return { checked, broken, unchecked };
}

/**
 * The console command: audit the whole GAME registry (plus any extra selectors
 * handed in) against the live stylesheets, and say what it found.
 *
 * @param {Array<string>} [extra] - Selectors outside the registry to check too
 * @returns {{classes: number, checked: number, broken: Array, unchecked: Array<string>}}
 */
export function runSelectorAudit(extra = []) {
    const classSet = collectStylesheetClasses();
    if (!classSet.size) {
        console.warn('[SelectorAudit] No CSS-module classes found in the stylesheets — is the game page loaded?');
        return { classes: 0, checked: 0, broken: [], unchecked: [] };
    }

    const inventory = { ...GAME };
    extra.forEach((selector, index) => {
        inventory[`extra[${index}]`] = selector;
    });
    const report = auditSelectors(inventory, classSet);

    if (report.broken.length) {
        console.warn(`[SelectorAudit] ${report.broken.length} selector(s) no longer match any game class:`);
        console.table(report.broken);
    } else {
        console.log(`[SelectorAudit] All ${report.checked} checkable selectors still name real game classes.`);
    }
    if (report.unchecked.length) {
        console.log(
            `[SelectorAudit] Unchecked (not class-shaped): ${report.unchecked.join(', ')} — verify those by hand.`
        );
    }
    return { classes: classSet.size, ...report };
}
