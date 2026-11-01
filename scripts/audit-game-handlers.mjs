/**
 * Advisory audit: which message fields does Toolasha read that the game's own
 * client never reads?
 *
 * The game registers a handler per websocket message type in its main chunk
 * (`skills_updated:this.handleMessageSkillsUpdated, ...`) and each handler
 * reads a handful of fields off its message. Toolasha's `skills_updated`
 * listener once read `.characterSkills`, which the game never sends (it sends
 * `.endCharacterSkills`); only reading the game's handler showed it.
 *
 * Usage (needs a saved chunk, or the network for --fetch; NOT part of gates/CI):
 *   node scripts/audit-game-handlers.mjs --bundle <main.chunk.js>
 *   node scripts/audit-game-handlers.mjs --fetch        # test.milkywayidle.com only
 *
 * Method: both sides are parsed with acorn (a transitive dependency of eslint)
 * and the AST is walked for property reads on the message parameter, honoring
 * shadowing by inner functions/blocks. Top-level fields only (`e.a.b` -> `a`).
 *
 * Known limits (see the report footer): a message passed on to another function
 * is followed only when that function is found by name (bundle-wide for the
 * game, same file for Toolasha) up to a few hops; aliasing (`const m = e`),
 * dynamic keys (`e[k]`) and spreads are flagged, not resolved; Toolasha
 * listeners whose type or callback is not a literal/same-file name are skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import * as acorn from 'acorn';

const TEST_ORIGIN = 'https://test.milkywayidle.com';
const CACHE_DIR = path.join('.cache', 'game-bundle');
const MAX_HOPS = 3;

/**
 * @param {string} src
 * @param {boolean} isModule
 */
function parse(src, isModule) {
    return acorn.parse(src, {
        ecmaVersion: 'latest',
        sourceType: isModule ? 'module' : 'script',
        allowReturnOutsideFunction: true,
        allowHashBang: true,
        locations: true,
    });
}

const isFunction = (n) =>
    n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration');

function eachChild(node, cb) {
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
        const v = node[key];
        if (Array.isArray(v)) {
            for (const c of v) if (c && typeof c.type === 'string') cb(c, key);
        } else if (v && typeof v.type === 'string') cb(v, key);
    }
}

function patternNames(p, out = new Set()) {
    if (!p) return out;
    switch (p.type) {
        case 'Identifier':
            out.add(p.name);
            break;
        case 'ObjectPattern':
            for (const pr of p.properties) patternNames(pr.type === 'RestElement' ? pr.argument : pr.value, out);
            break;
        case 'ArrayPattern':
            for (const el of p.elements) patternNames(el, out);
            break;
        case 'RestElement':
            patternNames(p.argument, out);
            break;
        case 'AssignmentPattern':
            patternNames(p.left, out);
            break;
        default:
    }
    return out;
}

/** `var` declarations hoisted to the function scope (not entering nested functions). */
function hoistedVarNames(body, name) {
    let found = false;
    const visit = (n) => {
        if (found || isFunction(n)) return;
        if (n.type === 'VariableDeclaration' && n.kind === 'var') {
            for (const d of n.declarations) if (patternNames(d.id).has(name)) found = true;
        }
        eachChild(n, visit);
    };
    visit(body);
    return found;
}

/** let/const/class/function declared directly in a statement list. */
function declaresInList(stmts, name) {
    for (const s of stmts) {
        if (s.type === 'VariableDeclaration' && s.kind !== 'var') {
            for (const d of s.declarations) if (patternNames(d.id).has(name)) return true;
        } else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id?.name === name) {
            return true;
        }
    }
    return false;
}

/**
 * Collect how `name` (a message parameter) is used inside `root`.
 * @returns {{fields:Set<string>, dynamic:boolean, spread:boolean, escapes:boolean, passed:{callee:string,index:number}[]}}
 */
function collectUses(root, name) {
    const res = { fields: new Set(), dynamic: false, spread: false, escapes: false, passed: [] };
    const isName = (n) => n && n.type === 'Identifier' && n.name === name;

    const addPatternKeys = (pattern) => {
        for (const pr of pattern.properties) {
            if (pr.type === 'RestElement') {
                res.spread = true;
            } else if (!pr.computed && pr.key.type === 'Identifier') {
                res.fields.add(pr.key.name);
            } else if (pr.key.type === 'Literal') {
                res.fields.add(String(pr.key.value));
            } else {
                res.dynamic = true;
            }
        }
    };

    const visit = (n) => {
        switch (n.type) {
            case 'FunctionDeclaration':
            case 'FunctionExpression':
            case 'ArrowFunctionExpression': {
                for (const p of n.params) if (patternNames(p).has(name)) return;
                if (n.body.type === 'BlockStatement' && hoistedVarNames(n.body, name)) return;
                if (n.type === 'FunctionDeclaration' && n.id?.name === name) return;
                for (const p of n.params) visit(p);
                visit(n.body);
                return;
            }
            case 'BlockStatement':
            case 'Program':
            case 'StaticBlock':
                if (declaresInList(n.body, name)) return;
                break;
            case 'ForStatement':
                if (n.init?.type === 'VariableDeclaration' && n.init.kind !== 'var') {
                    for (const d of n.init.declarations) if (patternNames(d.id).has(name)) return;
                }
                break;
            case 'ForInStatement':
            case 'ForOfStatement':
                if (n.left.type === 'VariableDeclaration' && n.left.kind !== 'var') {
                    for (const d of n.left.declarations) if (patternNames(d.id).has(name)) return;
                }
                break;
            case 'CatchClause':
                if (n.param && patternNames(n.param).has(name)) return;
                break;
            case 'MemberExpression':
                if (isName(n.object)) {
                    if (!n.computed) res.fields.add(n.property.name);
                    else if (n.property.type === 'Literal') res.fields.add(String(n.property.value));
                    else res.dynamic = true;
                } else {
                    visit(n.object);
                }
                if (n.computed) visit(n.property);
                return;
            case 'CallExpression':
            case 'NewExpression': {
                visit(n.callee);
                n.arguments.forEach((a, index) => {
                    if (isName(a)) {
                        const c = n.callee;
                        let callee = '';
                        if (c.type === 'Identifier') callee = c.name;
                        else if (c.type === 'MemberExpression' && !c.computed) callee = c.property.name;
                        if (callee) res.passed.push({ callee, index });
                        else res.escapes = true;
                    } else {
                        visit(a);
                    }
                });
                return;
            }
            case 'VariableDeclarator':
                if (n.id.type === 'ObjectPattern' && isName(n.init)) {
                    addPatternKeys(n.id);
                    return;
                }
                if (n.id.type !== 'Identifier') visit(n.id);
                if (n.init) visit(n.init);
                return;
            case 'AssignmentExpression':
                if (n.left.type === 'ObjectPattern' && isName(n.right)) {
                    addPatternKeys(n.left);
                    return;
                }
                break;
            case 'Property':
                if (n.computed) visit(n.key);
                visit(n.value);
                return;
            case 'MethodDefinition':
            case 'PropertyDefinition':
                if (n.computed) visit(n.key);
                if (n.value) visit(n.value);
                return;
            case 'Identifier':
                if (n.name === name) res.escapes = true;
                return;
            default:
        }
        eachChild(n, visit);
    };

    visit(root);
    return res;
}

/** Name -> function node for every named function-like in an AST (first wins). */
function collectFunctions(ast) {
    const map = new Map();
    const add = (name, fn) => {
        if (name && isFunction(fn) && !map.has(name)) map.set(name, fn);
    };
    const visit = (n) => {
        if (n.type === 'FunctionDeclaration') add(n.id?.name, n);
        else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') add(n.id.name, n.init);
        else if (n.type === 'MethodDefinition' || n.type === 'PropertyDefinition') {
            if (!n.computed && n.key.type === 'Identifier') add(n.key.name, n.value);
        } else if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed) {
            add(n.left.property.name, n.right);
        } else if (n.type === 'Property' && !n.computed && n.key.type === 'Identifier') add(n.key.name, n.value);
        eachChild(n, visit);
    };
    visit(ast);
    return map;
}

/**
 * Fields read from the first parameter of `fn`, following the message into
 * calls of functions found in `fnMap`.
 * @returns {{fields:Set<string>, dynamic:boolean, spread:boolean, escapes:boolean}}
 */
function analyzeFunction(fn, fnMap, hops = 0, seen = new Set()) {
    const out = { fields: new Set(), dynamic: false, spread: false, escapes: false };
    const param = fn.params[0];
    if (!param) return out;
    if (param.type === 'ObjectPattern') {
        const decl = { type: 'VariableDeclarator', id: param, init: { type: 'Identifier', name: '$m' } };
        const tmp = collectUses(decl, '$m');
        for (const f of tmp.fields) out.fields.add(f);
        out.dynamic = tmp.dynamic;
        out.spread = tmp.spread;
        return out;
    }
    if (param.type !== 'Identifier') {
        out.escapes = true;
        return out;
    }
    const uses = collectUses(fn.body, param.name);
    for (const f of uses.fields) out.fields.add(f);
    out.dynamic = uses.dynamic;
    out.spread = uses.spread;
    out.escapes = uses.escapes;
    for (const { callee, index } of uses.passed) {
        const target = fnMap.get(callee);
        if (!target || index !== 0 || hops >= MAX_HOPS || seen.has(target) || target === fn) {
            out.escapes = true;
            continue;
        }
        seen.add(target);
        const sub = analyzeFunction(target, fnMap, hops + 1, seen);
        for (const f of sub.fields) out.fields.add(f);
        out.dynamic ||= sub.dynamic;
        out.spread ||= sub.spread;
        out.escapes ||= sub.escapes;
    }
    return out;
}

/**
 * Parse the game's main chunk: message type -> fields its handler reads.
 * @param {string} src
 * @returns {Map<string, {handler:string, fields:Set<string>, dynamic:boolean, spread:boolean, escapes:boolean}>}
 */
export function parseGameHandlers(src) {
    const ast = parse(src, false);
    const fnMap = collectFunctions(ast);
    const result = new Map();
    const visit = (n) => {
        if (
            n.type === 'Property' &&
            !n.computed &&
            n.value.type === 'MemberExpression' &&
            n.value.object.type === 'ThisExpression' &&
            !n.value.computed &&
            /^handleMessage/.test(n.value.property.name)
        ) {
            const type = n.key.type === 'Identifier' ? n.key.name : String(n.key.value);
            const handler = n.value.property.name;
            const fn = fnMap.get(handler);
            if (!result.has(type)) {
                if (fn) result.set(type, { handler, ...analyzeFunction(fn, fnMap) });
                else result.set(type, { handler, fields: new Set(), dynamic: false, spread: false, escapes: true });
            }
        }
        eachChild(n, visit);
    };
    visit(ast);
    return result;
}

/**
 * Parse one Toolasha source file: `webSocketHook.on('<type>', cb)` subscriptions.
 * @param {string} src
 * @param {string} file
 * @returns {{type:string, file:string, line:number, fields:Set<string>, dynamic:boolean, spread:boolean, escapes:boolean, resolved:boolean}[]}
 */
export function parseToolashaSubscriptions(src, file = '') {
    const ast = parse(src, true);
    const fnMap = collectFunctions(ast);
    const consts = new Map();
    for (const stmt of ast.body) {
        const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
        if (decl?.type !== 'VariableDeclaration') continue;
        for (const d of decl.declarations) {
            if (d.id.type === 'Identifier' && d.init?.type === 'Literal' && typeof d.init.value === 'string') {
                consts.set(d.id.name, d.init.value);
            }
        }
    }
    const isHook = (o) =>
        (o.type === 'Identifier' && o.name === 'webSocketHook') ||
        (o.type === 'MemberExpression' && !o.computed && o.property.name === 'webSocketHook');
    const out = [];
    const visit = (n) => {
        if (
            n.type === 'CallExpression' &&
            n.callee.type === 'MemberExpression' &&
            !n.callee.computed &&
            n.callee.property.name === 'on' &&
            isHook(n.callee.object) &&
            n.arguments.length >= 2
        ) {
            const [t, cb] = n.arguments;
            const type = t.type === 'Literal' && typeof t.value === 'string' ? t.value : consts.get(t.name);
            if (type) {
                let fn = null;
                if (isFunction(cb)) fn = cb;
                else if (cb.type === 'Identifier') fn = fnMap.get(cb.name);
                else if (cb.type === 'MemberExpression' && !cb.computed) fn = fnMap.get(cb.property.name);
                const rec = { type, file, line: n.loc.start.line, resolved: !!fn };
                if (fn) Object.assign(rec, analyzeFunction(fn, fnMap));
                else Object.assign(rec, { fields: new Set(), dynamic: false, spread: false, escapes: true });
                out.push(rec);
            }
        }
        eachChild(n, visit);
    };
    visit(ast);
    return out;
}

/**
 * Compare the two sides.
 * @param {ReturnType<typeof parseGameHandlers>} game
 * @param {ReturnType<typeof parseToolashaSubscriptions>} subs
 */
export function compare(game, subs) {
    const byType = new Map();
    for (const s of subs) {
        if (!byType.has(s.type)) byType.set(s.type, []);
        byType.get(s.type).push(s);
    }
    const rows = [];
    const noHandler = [];
    for (const [type, list] of byType) {
        const g = game.get(type);
        if (!g) {
            noHandler.push({ type, sites: list.map((s) => `${s.file}:${s.line}`) });
            continue;
        }
        const tFields = new Set();
        for (const s of list) for (const f of s.fields) if (f !== 'type') tFields.add(f);
        const wrong = [...tFields].filter((f) => !g.fields.has(f)).sort();
        const ignored = [...g.fields].filter((f) => !tFields.has(f)).sort();
        rows.push({
            type,
            handler: g.handler,
            wrong,
            ignored,
            gameOpaque: g.escapes || g.dynamic || g.spread,
            toolashaOpaque: list.some((s) => s.escapes || s.dynamic || s.spread),
            sites: list.map((s) => `${s.file}:${s.line}`),
        });
    }
    rows.sort((a, b) => b.wrong.length - a.wrong.length || a.type.localeCompare(b.type));
    noHandler.sort((a, b) => a.type.localeCompare(b.type));
    const unsubscribed = [...game.keys()].filter((t) => !byType.has(t)).sort();
    return { rows, noHandler, unsubscribed };
}

/** @param {ReturnType<typeof compare>} report */
export function formatReport(report) {
    const lines = [];
    lines.push('Fields Toolasha reads that the game handler never reads (likely wrong field):');
    const suspicious = report.rows.filter((r) => r.wrong.length);
    if (!suspicious.length) lines.push('  (none)');
    for (const r of suspicious) {
        const flags = [
            r.gameOpaque ? 'game handler partly opaque' : '',
            r.toolashaOpaque ? 'Toolasha partly opaque' : '',
        ]
            .filter(Boolean)
            .join('; ');
        lines.push(`  ${r.type}  [${r.handler}]  ${r.wrong.join(', ')}${flags ? `   (${flags})` : ''}`);
        lines.push(`      at ${r.sites.join(', ')}`);
    }
    lines.push('');
    lines.push('Toolasha subscriptions with no game handler (internal event, or a message the game ignores):');
    if (!report.noHandler.length) lines.push('  (none)');
    for (const r of report.noHandler) lines.push(`  ${r.type}  at ${r.sites.join(', ')}`);
    lines.push('');
    lines.push('Fields the game reads that Toolasha ignores (informational):');
    for (const r of report.rows.filter((x) => x.ignored.length)) {
        lines.push(`  ${r.type}: ${r.ignored.join(', ')}`);
    }
    lines.push('');
    lines.push(`Game message types Toolasha does not subscribe to: ${report.unsubscribed.length}`);
    lines.push(`  ${report.unsubscribed.join(', ')}`);
    lines.push('');
    lines.push(
        'Limits: top-level fields only; aliasing (const m = e), e[key], spreads and unresolved calls are flagged "opaque",',
        'not followed; a listener registered with a non-literal type (loops, arrays) or a callback from another file is skipped.'
    );
    return lines.join('\n');
}

function listSourceFiles(dir) {
    const files = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) files.push(...listSourceFiles(p));
        else if (ent.name.endsWith('.js') && !ent.name.endsWith('.test.js')) files.push(p);
    }
    return files;
}

async function fetchBundle() {
    const page = await fetch(`${TEST_ORIGIN}/game`);
    if (!page.ok) throw new Error(`GET /game -> ${page.status}`);
    const html = await page.text();
    const m = html.match(/src="(\/?static\/js\/main\.[^"]+\.js)"/);
    if (!m) throw new Error('main.*.js script tag not found in the game page');
    const rel = m[1].replace(/^\//, '');
    const file = path.join(CACHE_DIR, path.basename(rel));
    if (!fs.existsSync(file)) {
        const res = await fetch(`${TEST_ORIGIN}/${rel}`);
        if (!res.ok) throw new Error(`GET ${rel} -> ${res.status}`);
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(file, await res.text());
    }
    return file;
}

async function main(argv) {
    const bundleIdx = argv.indexOf('--bundle');
    const srcIdx = argv.indexOf('--src');
    const srcDir = srcIdx >= 0 ? argv[srcIdx + 1] : 'src';
    let bundle = bundleIdx >= 0 ? argv[bundleIdx + 1] : null;
    if (!bundle && argv.includes('--fetch')) bundle = await fetchBundle();
    if (!bundle) {
        console.log('Usage: node scripts/audit-game-handlers.mjs (--bundle <main.chunk.js> | --fetch) [--src <dir>]');
        return;
    }
    console.log(`Game bundle: ${bundle}`);
    const game = parseGameHandlers(fs.readFileSync(bundle, 'utf8'));
    const subs = [];
    for (const f of listSourceFiles(srcDir)) {
        try {
            subs.push(...parseToolashaSubscriptions(fs.readFileSync(f, 'utf8'), f.split(path.sep).join('/')));
        } catch (error) {
            console.log(`[skip] ${f}: ${error.message}`);
        }
    }
    console.log(`Game handlers: ${game.size}; Toolasha subscriptions: ${subs.length}\n`);
    console.log(formatReport(compare(game, subs)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((error) => {
        console.log(`[audit-game-handlers] ${error.message}`);
    });
}
