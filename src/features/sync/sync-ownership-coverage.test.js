/**
 * Does the ownership registry actually cover what this script writes?
 *
 * `sync-ownership.js` decides which keys a payload may carry. A Toolasha key
 * missing from it stops syncing, and stops silently: nothing throws, nothing is
 * logged, the key simply never reaches the other device. Whoever adds the key is
 * given no sign, and the loss surfaces — if it ever does — as a feature that
 * mysteriously forgot something, long after the commit that caused it.
 *
 * So the registry is not trusted to be maintained by hand. This test reads
 * `src/` and works out, for every write this script makes into a store that is
 * filtered key by key, what key it writes. A key the registry does not cover
 * fails the test, in the commit that added it.
 *
 * ## How it reads the source
 *
 * Not with a JavaScript parser, which would be a dependency for one test. It
 * resolves expressions the way a careful reader would: string literals and
 * template literals, constants and object/array members, imports followed into
 * the module that exports them, and functions called with their arguments bound
 * to their parameters. A key built as `` `${BASE}_${characterId}` `` resolves to
 * the prefix `BASE_`; one built as `` `${characterId}_bulkSell_lastTab` ``
 * resolves to the trailing shape, because that is all a prefix registry can be
 * told about it.
 *
 * ## Wrappers
 *
 * The storage helpers that own a key family are listed in {@link SINKS}, and a
 * list matches direct calls only: a function that takes a key and hands it to
 * `writeScoped` hides its callers' key constants from the scan completely, and
 * so would the next one anybody wrote. So the wrappers are not listed either —
 * {@link discoverWrapperSinks} finds them, by looking for a function that
 * forwards one of its own parameters into a sink's *key* position, and repeats
 * until nothing new turns up, because a wrapper around a wrapper is possible.
 * Merely calling a sink is not enough to count; see that function for why the
 * narrowness matters.
 *
 * ## What it cannot see, and why that is survivable
 *
 * A handful of modules write keys they are *handed*: `chunked-history.js` writes
 * `this.prefix`, `character-key.js` writes whatever base it was passed. There is
 * nothing at those call sites to resolve. They are listed in
 * {@link CALLER_KEYED_MODULES}, and their callers are scanned instead — every
 * `createChunkedHistory({prefix})`, every `writeScoped(base)` — so the families
 * are still covered, just from the other end. The list is closed: an
 * unresolvable write appearing in any *other* file fails this test, because that
 * is a new blind spot and the point is that nobody acquires one by accident.
 */

import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_FILTERED_STORES, OWNED_KEY_PREFIXES, OWNED_KEY_PATTERNS, ownsKey } from './sync-ownership.js';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ------------------------------------------------------------------ *
 * tiny lexer helpers
 * ------------------------------------------------------------------ */

function skipString(text, start) {
    const quote = text[start];
    let i = start + 1;
    while (i < text.length) {
        const c = text[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (quote === '`' && c === '$' && text[i + 1] === '{') {
            const end = matchBracket(text, i + 1);
            i = end < 0 ? text.length : end + 1;
            continue;
        }
        if (c === quote) return i + 1;
        i += 1;
    }
    return i;
}

function matchBracket(text, open) {
    const pairs = { '(': ')', '[': ']', '{': '}' };
    if (!pairs[text[open]]) return -1;
    const stack = [pairs[text[open]]];
    let i = open + 1;
    while (i < text.length && stack.length) {
        const c = text[i];
        if (c === '/' && text[i + 1] === '/') {
            const nl = text.indexOf('\n', i);
            if (nl < 0) break;
            i = nl + 1;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i);
            if (end < 0) break;
            i = end + 2;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            i = skipString(text, i);
            continue;
        }
        if (pairs[c]) stack.push(pairs[c]);
        else if (c === ')' || c === ']' || c === '}') {
            if (stack[stack.length - 1] === c) stack.pop();
            else return -1;
        }
        i += 1;
    }
    return stack.length ? -1 : i - 1;
}

function splitTopLevel(inner, separator = ',') {
    const parts = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    while (i < inner.length) {
        const c = inner[i];
        if (c === '"' || c === "'" || c === '`') {
            i = skipString(inner, i);
            continue;
        }
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === separator && depth === 0) {
            parts.push(inner.slice(start, i).trim());
            start = i + 1;
        }
        i += 1;
    }
    parts.push(inner.slice(start).trim());
    return parts;
}

function callArgs(text, open) {
    const close = matchBracket(text, open);
    if (close < 0) return [];
    return splitTopLevel(text.slice(open + 1, close)).filter((a) => a !== '');
}

function readExpression(text, at) {
    let i = at;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    const start = i;
    let depth = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"' || c === "'" || c === '`') {
            i = skipString(text, i);
            continue;
        }
        if (c === '(' || c === '[' || c === '{') {
            depth += 1;
            i += 1;
            continue;
        }
        if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) break;
            depth -= 1;
            i += 1;
            continue;
        }
        if (depth === 0 && (c === ';' || c === ',')) break;
        if (depth === 0 && c === '\n') {
            const before = text.slice(start, i).trimEnd();
            if (!/[?:+&|=([{,]$/.test(before)) break;
        }
        i += 1;
    }
    return text.slice(start, i).trim();
}

/* ------------------------------------------------------------------ *
 * per-file symbol tables
 * ------------------------------------------------------------------ */

const modules = new Map();

function sources(dir = srcRoot, found = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) sources(p, found);
        else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) found.push(p);
    }
    return found;
}

function loadModule(file) {
    if (modules.has(file)) return modules.get(file);
    let text = '';
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        const mod = emptyModule(file);
        modules.set(file, mod);
        return mod;
    }
    return makeModule(file, text);
}

/** Put a module the scan can read at a path that is not on disk (fixtures only). */
function seedModule(file, source) {
    modules.delete(file);
    return makeModule(file, source);
}

function emptyModule(file) {
    return { file, text: '', values: new Map(), fns: new Map(), defs: new Map(), imports: new Map() };
}

/**
 * Parse one module's source into the symbol tables the resolver reads.
 *
 * Separated from {@link loadModule} so that a test can hand the scan a module
 * that is not on disk — see the wrapper negative control.
 *
 * @param {string} file - Absolute path the module answers to (imports resolve against it)
 * @param {string} source - The module's source text
 * @returns {Object} The parsed module, also cached under `file`
 */
function makeModule(file, source) {
    const mod = { ...emptyModule(file), text: stripComments(source) };
    const text = mod.text;
    modules.set(file, mod);

    const push = (map, name, v) => {
        if (!map.has(name)) map.set(name, []);
        map.get(name).push(v);
    };

    const assignRe = /(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)|this\.([A-Za-z_$][\w$]*))\s*=\s*/g;
    let m;
    while ((m = assignRe.exec(text))) {
        const name = m[1] ? m[1] : `this.${m[2]}`;
        const rhs = readExpression(text, assignRe.lastIndex);
        if (rhs) push(mod.values, name, rhs);
    }

    const fnRe =
        /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|(?:^|\n)[ \t]*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\()/g;
    while ((m = fnRe.exec(text))) {
        const name = m[1] || m[2] || m[3];
        if (!name || ['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;
        const parenOpen = m.index + m[0].length - 1;
        const parenClose = matchBracket(text, parenOpen);
        if (parenClose < 0) continue;
        const params = splitTopLevel(text.slice(parenOpen + 1, parenClose)).filter(Boolean);
        const after = text.slice(parenClose + 1);
        const arrow = /^\s*=>\s*/.exec(after);
        let returns = [];
        let body = null;
        if (arrow) {
            const at = parenClose + 1 + arrow[0].length;
            if (text[at] === '{') {
                returns = returnsIn(text, at);
                const end = matchBracket(text, at);
                if (end > 0) body = { start: at + 1, end };
            } else {
                const e = readExpression(text, at);
                if (e) {
                    returns = [e];
                    body = { start: at, end: at + e.length };
                }
            }
        } else {
            const brace = /^\s*\{/.exec(after);
            if (brace) {
                const at = parenClose + brace[0].length;
                returns = returnsIn(text, at);
                const end = matchBracket(text, at);
                if (end > 0) body = { start: at + 1, end };
            }
        }
        if (returns.length) push(mod.fns, name, { params, returns });
        if (body) {
            push(mod.defs, name, {
                params,
                bodyStart: body.start,
                bodyEnd: body.end,
                nameIndex: text.lastIndexOf(name, parenOpen),
            });
        }
    }

    const importRe = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
    while ((m = importRe.exec(text))) {
        const clause = m[1];
        const target = m[2];
        if (!target.startsWith('.')) continue;
        const resolved = resolvePath(dirname(file), target);
        const braces = /\{([\s\S]*)\}/.exec(clause);
        if (braces) {
            for (const spec of splitTopLevel(braces[1])) {
                const [orig, alias] = spec.split(/\s+as\s+/).map((s) => s.trim());
                if (!orig) continue;
                mod.imports.set(alias || orig, { file: resolved, name: orig });
            }
        }
        const dflt = clause.split(',')[0].trim();
        if (dflt && !dflt.startsWith('{') && !dflt.startsWith('*')) {
            mod.imports.set(dflt, { file: resolved, name: 'default' });
        }
    }

    return mod;
}

/** Blank out comments, preserving every offset and newline. */
function stripComments(text) {
    const out = text.split('');
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"' || c === "'" || c === '`') {
            const end = skipString(text, i);
            i = end;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            let j = i;
            while (j < text.length && text[j] !== '\n') out[j++] = ' ';
            i = j;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end < 0 ? text.length : end + 2;
            for (let j = i; j < stop; j += 1) if (out[j] !== '\n') out[j] = ' ';
            i = stop;
            continue;
        }
        i += 1;
    }
    return out.join('');
}

function returnsIn(text, braceAt) {
    const end = matchBracket(text, braceAt);
    if (end < 0) return [];
    const body = text.slice(braceAt + 1, end);
    const out = [];
    const retRe = /\breturn\s+/g;
    while (retRe.exec(body)) {
        const e = readExpression(body, retRe.lastIndex);
        if (e) out.push(e);
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * resolution
 * ------------------------------------------------------------------ */

const LITERAL_RE = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/;
const MAX_DEPTH = 12;

function resolve(expr, ctx) {
    const { mod, bindings = new Map(), seen = new Set(), depth = 0 } = ctx;
    if (!expr || depth > MAX_DEPTH) return [];
    const e = stripParens(expr.trim());
    const cacheKey = `${mod.file}|${e}|${depth > 6 ? depth : ''}|${[...bindings.keys()].join(',')}`;
    if (seen.has(cacheKey)) return [];
    seen.add(cacheKey);
    const next = (x, over = {}) => resolve(x, { mod, bindings, seen, depth: depth + 1, ...over });

    const lit = LITERAL_RE.exec(e);
    if (lit) return [{ kind: 'literal', value: lit[2] }];
    if (e.startsWith('`')) return template(e, { mod, bindings, seen, depth });

    // ternary
    const q = topLevel(e, '?');
    if (q > 0) {
        const colon = topLevel(e, ':', q + 1);
        if (colon > 0) return [...next(e.slice(q + 1, colon)), ...next(e.slice(colon + 1))];
    }
    for (const op of ['??', '||']) {
        const idx = topLevel(e, op);
        if (idx > 0) return [...next(e.slice(0, idx)), ...next(e.slice(idx + op.length))];
    }
    const plus = topLevel(e, '+');
    if (plus > 0) return next(e.slice(0, plus)).map((r) => ({ kind: 'prefix', value: r.value }));

    // call
    const call = /^((?:new\s+)?[A-Za-z_$][\w$.?]*)\s*\(/.exec(e);
    if (call && matchBracket(e, call[0].length - 1) === e.length - 1) {
        const callee = call[1].replace(/^new\s+/, '').replace(/\?\./g, '.');
        const args = callArgs(e, call[0].length - 1);
        return callFunction(callee, args, { mod, bindings, seen, depth });
    }

    // identifier / this.x
    const id = /^(this\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)$/.exec(e);
    if (id) return lookup(id[1], { mod, bindings, seen, depth });

    // member access: X.y  (object literal property)
    const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(e);
    if (member) {
        const objects = objectLiteralsFor(member[1], { mod, bindings, seen, depth });
        const out = [];
        for (const { text: objText, mod: objMod } of objects) {
            const prop = propertyOf(objText, member[2]);
            if (prop) out.push(...resolve(prop, { mod: objMod, bindings: new Map(), seen, depth: depth + 1 }));
        }
        return out;
    }

    // member access on a call: f(...).y
    const callMember = /^([\s\S]+\))\.([A-Za-z_$][\w$]*)$/.exec(e);
    if (callMember) {
        const inner = callMember[1];
        const innerCall = /^((?:new\s+)?[A-Za-z_$][\w$.?]*)\s*\(/.exec(inner);
        if (innerCall && matchBracket(inner, innerCall[0].length - 1) === inner.length - 1) {
            const callee = innerCall[1].replace(/^new\s+/, '').replace(/\?\./g, '.');
            const args = callArgs(inner, innerCall[0].length - 1);
            const out = [];
            for (const { text: objText, mod: objMod, bindings: objBindings } of returnedObjects(callee, args, {
                mod,
                bindings,
                seen,
                depth,
            })) {
                const prop = propertyOf(objText, callMember[2]);
                if (prop) out.push(...resolve(prop, { mod: objMod, bindings: objBindings, seen, depth: depth + 1 }));
            }
            return out;
        }
    }

    // index into an array literal: X[i] — every element is a possible value
    const index = /^([A-Za-z_$][\w$]*)\[[^\]]*\]$/.exec(e);
    if (index) {
        const out = [];
        for (const { text: arrayText, mod: arrayMod } of arrayLiteralsFor(index[1], { mod, bindings })) {
            const close = matchBracket(arrayText, 0);
            if (close < 0) continue;
            for (const element of splitTopLevel(arrayText.slice(1, close))) {
                if (element)
                    out.push(...resolve(element, { mod: arrayMod, bindings: new Map(), seen, depth: depth + 1 }));
            }
        }
        return out;
    }

    return [];
}

function stripParens(e) {
    while (e.startsWith('(') && matchBracket(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
    return e;
}

function lookup(name, ctx) {
    const { mod, bindings, seen, depth } = ctx;
    if (bindings.has(name)) {
        const b = bindings.get(name);
        return resolve(b.expr, { mod: b.mod, bindings: b.bindings, seen, depth: depth + 1 });
    }
    const local = mod.values.get(name);
    if (local) {
        const out = [];
        for (const rhs of local) out.push(...resolve(rhs, { mod, bindings, seen, depth: depth + 1 }));
        if (out.length) return out;
    }
    const imported = mod.imports.get(name);
    if (imported) {
        const target = loadModule(imported.file);
        const rhs = target.values.get(imported.name);
        if (rhs) {
            const out = [];
            for (const r of rhs) out.push(...resolve(r, { mod: target, bindings: new Map(), seen, depth: depth + 1 }));
            return out;
        }
    }
    return [];
}

function callFunction(callee, args, ctx) {
    const { mod, bindings, seen, depth } = ctx;
    const short = callee.split('.').pop();
    const candidates = [];
    if (mod.fns.has(short)) candidates.push({ mod, defs: mod.fns.get(short) });
    const imported = mod.imports.get(callee.split('.')[0]) || mod.imports.get(short);
    if (imported) {
        const target = loadModule(imported.file);
        if (target.fns.has(short)) candidates.push({ mod: target, defs: target.fns.get(short) });
        else if (target.fns.has(imported.name)) candidates.push({ mod: target, defs: target.fns.get(imported.name) });
    }
    const out = [];
    for (const { mod: fnMod, defs } of candidates) {
        for (const def of defs) {
            const inner = bindParams(def.params, args, { mod, bindings });
            for (const ret of def.returns) {
                out.push(...resolve(ret, { mod: fnMod, bindings: inner, seen, depth: depth + 1 }));
            }
        }
    }
    return out;
}

function bindParams(params, args, caller) {
    const inner = new Map();
    params.forEach((param, i) => {
        const p = param.trim();
        if (p.startsWith('{')) {
            // destructured options object
            const close = matchBracket(p, 0);
            const props = splitTopLevel(p.slice(1, close < 0 ? p.length : close));
            const argText = args[i];
            const argProps = argText && argText.trim().startsWith('{') ? objectProperties(argText.trim()) : new Map();
            for (const prop of props) {
                const [namePart, defaultPart] = splitOnFirstEquals(prop);
                const [, alias] = namePart.split(':').map((s) => s.trim());
                const key = namePart.split(':')[0].trim();
                const local = alias || key;
                if (!local) continue;
                if (argProps.has(key))
                    inner.set(local, { expr: argProps.get(key), mod: caller.mod, bindings: caller.bindings });
                else if (defaultPart)
                    inner.set(local, { expr: defaultPart, mod: caller.mod, bindings: caller.bindings });
            }
            return;
        }
        const [namePart, defaultPart] = splitOnFirstEquals(p);
        const name = namePart.trim();
        if (!name || name.startsWith('...')) return;
        if (args[i] !== undefined) inner.set(name, { expr: args[i], mod: caller.mod, bindings: caller.bindings });
        else if (defaultPart) inner.set(name, { expr: defaultPart, mod: caller.mod, bindings: caller.bindings });
    });
    return inner;
}

function splitOnFirstEquals(text) {
    const idx = topLevel(text, '=');
    if (idx < 0) return [text, null];
    if (text[idx + 1] === '=' || text[idx - 1] === '=' || text[idx + 1] === '>') return [text, null];
    return [text.slice(0, idx), text.slice(idx + 1).trim()];
}

function objectProperties(objText) {
    const close = matchBracket(objText, 0);
    const map = new Map();
    if (close < 0) return map;
    for (const entry of splitTopLevel(objText.slice(1, close))) {
        if (!entry) continue;
        const colon = topLevel(entry, ':');
        if (colon < 0) {
            const name = entry.trim();
            if (/^[A-Za-z_$][\w$]*$/.test(name)) map.set(name, name);
            continue;
        }
        map.set(
            entry
                .slice(0, colon)
                .trim()
                .replace(/^['"]|['"]$/g, ''),
            entry.slice(colon + 1).trim()
        );
    }
    return map;
}

function propertyOf(objText, prop) {
    return objectProperties(objText).get(prop) || null;
}

function returnedObjects(callee, args, ctx) {
    const { mod, bindings } = ctx;
    const short = callee.split('.').pop();
    const candidates = [];
    if (mod.fns.has(short)) candidates.push({ mod, defs: mod.fns.get(short) });
    const imported = mod.imports.get(callee.split('.')[0]) || mod.imports.get(short);
    if (imported) {
        const target = loadModule(imported.file);
        if (target.fns.has(short)) candidates.push({ mod: target, defs: target.fns.get(short) });
    }
    const out = [];
    for (const { mod: fnMod, defs } of candidates) {
        for (const def of defs) {
            const inner = bindParams(def.params, args, { mod, bindings });
            for (const ret of def.returns) {
                const t = ret.trim();
                if (t.startsWith('{')) out.push({ text: t, mod: fnMod, bindings: inner });
            }
        }
    }
    return out;
}

function arrayLiteralsFor(name, ctx) {
    const { mod } = ctx;
    const out = [];
    for (const rhs of mod.values.get(name) || []) if (rhs.trim().startsWith('[')) out.push({ text: rhs.trim(), mod });
    const imported = mod.imports.get(name);
    if (imported) {
        const target = loadModule(imported.file);
        for (const rhs of target.values.get(imported.name) || []) {
            if (rhs.trim().startsWith('[')) out.push({ text: rhs.trim(), mod: target });
        }
    }
    return out;
}

function objectLiteralsFor(name, ctx) {
    const { mod, bindings } = ctx;
    if (bindings.has(name)) {
        const b = bindings.get(name);
        if (b.expr.trim().startsWith('{')) return [{ text: b.expr.trim(), mod: b.mod }];
    }
    const out = [];
    for (const rhs of mod.values.get(name) || []) {
        if (rhs.trim().startsWith('{')) out.push({ text: rhs.trim(), mod });
    }
    const imported = mod.imports.get(name);
    if (imported) {
        const target = loadModule(imported.file);
        for (const rhs of target.values.get(imported.name) || []) {
            if (rhs.trim().startsWith('{')) out.push({ text: rhs.trim(), mod: target });
        }
    }
    return out;
}

function template(e, ctx) {
    const body = e.slice(1, -1);
    const parts = [];
    let i = 0;
    let staticRun = '';
    while (i < body.length) {
        if (body[i] === '$' && body[i + 1] === '{') {
            const close = matchBracket(body, i + 1);
            if (close < 0) break;
            parts.push({ static: staticRun });
            staticRun = '';
            parts.push({ hole: body.slice(i + 2, close) });
            i = close + 1;
            continue;
        }
        staticRun += body[i];
        i += 1;
    }
    parts.push({ static: staticRun });

    const resolved = parts.map((part) => {
        if (part.static !== undefined) return part.static;
        const results = resolve(part.hole, { ...ctx, depth: ctx.depth + 1 });
        const literal = results.find((r) => r.kind === 'literal');
        return literal ? literal.value : null;
    });

    if (resolved.every((piece) => piece !== null)) return [{ kind: 'literal', value: resolved.join('') }];
    const firstHole = resolved.indexOf(null);
    const head = resolved.slice(0, firstHole).join('');
    if (head) return [{ kind: 'prefix', value: head }];
    const rest = resolved.slice(firstHole + 1);
    const nextHole = rest.indexOf(null);
    const tail = (nextHole < 0 ? rest : rest.slice(0, nextHole)).join('');
    return tail ? [{ kind: 'suffix', value: tail }] : [];
}

function topLevel(text, token, from = 0) {
    let depth = 0;
    let i = from;
    while (i < text.length) {
        const c = text[i];
        if (c === '"' || c === "'" || c === '`') {
            i = skipString(text, i);
            continue;
        }
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (depth === 0 && text.startsWith(token, i)) {
            if (token === '?' && (text[i + 1] === '.' || text[i + 1] === '?')) {
                i += 2;
                continue;
            }
            if (token === '+' && (text[i + 1] === '+' || text[i - 1] === '+')) {
                i += 1;
                continue;
            }
            if (token === '=' && (text[i + 1] === '=' || text[i + 1] === '>' || text[i - 1] === '=')) {
                i += 1;
                continue;
            }
            return i;
        }
        i += 1;
    }
    return -1;
}

/* ------------------------------------------------------------------ *
 * scan
 * ------------------------------------------------------------------ */

/** `(charId) => `x_${charId}`` → the expression it returns. */
function unwrapArrow(expr) {
    const arrow = /^\(?[A-Za-z_$][\w$]*\)?\s*=>\s*/.exec(expr.trim());
    if (!arrow) return expr;
    const body = expr.trim().slice(arrow[0].length).trim();
    if (!body.startsWith('{')) return body;
    const returns = returnsIn(body, 0);
    return returns[0] || expr;
}

/*
 * sinks: helpers that own a key family on their caller's behalf.
 *
 * These are the ones written by hand. Wrappers around them are found rather
 * than listed — see {@link discoverWrapperSinks}.
 */
const SINKS = {
    writeScoped: { key: { arg: 0, kind: 'prefix' }, store: { arg: 2, default: 'settings' } },
    readScoped: { key: { arg: 0, kind: 'prefix' }, store: { arg: 1, default: 'settings' } },
    readScopedFrom: { key: { arg: 0, kind: 'prefix' }, store: { arg: 2, default: 'settings' } },
    createPersistedRecord: { key: { option: 'base', kind: 'prefix' }, store: { option: 'store', default: 'settings' } },
    createCuratedRecord: { key: { option: 'base', kind: 'prefix' }, store: { option: 'store', default: 'settings' } },
    createNameKeyedStore: {
        key: { option: 'key', kind: 'literal' },
        store: { option: 'storeName', default: 'settings' },
    },
    createFloatingWidget: { key: { option: 'positionKey', kind: 'literal' }, store: { default: 'settings' } },
    createChunkedHistory: {
        keys: [
            { option: 'prefix', kind: 'prefix' },
            { option: 'legacyKey', kind: 'prefix' },
        ],
        store: { option: 'storeName' },
    },
    createDailyCheckpoints: {
        keys: [
            { option: 'prefix', kind: 'prefix' },
            { option: 'legacyKey', kind: 'prefix' },
        ],
        store: { option: 'storeName' },
    },
    createLiveSessionPersister: { key: { option: 'kind', kind: 'ignore' }, store: { option: 'storeName' } },
    // The sync's own bookkeeping goes down one bulk write, so the keys are named
    // at the call sites rather than at the write
    rememberLocal: { objectKeys: 0, store: { default: 'settings' } },
};

/* ------------------------------------------------------------------ *
 * wrapper discovery
 * ------------------------------------------------------------------ */

/**
 * What a function's parameters are called inside it.
 *
 * A plain parameter binds its own name to its position. A destructured options
 * object binds each property (honouring `a: b` aliases) to the property name, so
 * that `function save({key})` forwarding `key` can be expressed as an
 * option-keyed sink the same way `createPersistedRecord` is.
 *
 * @param {{params: string[]}} def - A parsed function definition
 * @returns {Map<string, {arg?: number, option?: string, index: number}>} Local name → where it came from
 */
function parameterOrigins(def) {
    const origins = new Map();
    def.params.forEach((param, i) => {
        const p = param.trim();
        if (!p || p.startsWith('...')) return;
        if (p.startsWith('{')) {
            const close = matchBracket(p, 0);
            for (const prop of splitTopLevel(p.slice(1, close < 0 ? p.length : close))) {
                if (!prop || prop.trim().startsWith('...')) continue;
                const [namePart] = splitOnFirstEquals(prop);
                const [key, alias] = namePart.split(':').map((s) => s.trim());
                const local = alias || key;
                if (local && /^[A-Za-z_$][\w$]*$/.test(local)) origins.set(local, { option: key, index: i });
            }
            return;
        }
        const [namePart] = splitOnFirstEquals(p);
        const name = namePart.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) origins.set(name, { arg: i, index: i });
    });
    return origins;
}

/** The expression a sink was handed for one of its key (or store) positions. */
function sinkArgument(part, args) {
    if (!part) return undefined;
    if (part.arg !== undefined) return args[part.arg];
    if (part.option !== undefined) {
        const first = (args[0] || '').trim();
        if (!first.startsWith('{')) return undefined;
        return objectProperties(first).get(part.option);
    }
    return undefined;
}

/** A parameter forwarded verbatim — `f(key)`, and `f(key)` after `key = 'x'`. */
function forwardedParameter(expr, origins) {
    if (expr === undefined || expr === null) return null;
    const e = stripParens(String(expr).trim());
    if (!/^[A-Za-z_$][\w$]*$/.test(e)) return null;
    return origins.get(e) || null;
}

/**
 * Which store a discovered wrapper writes into, as a sink spec fragment.
 *
 * Usually a constant in the wrapper's own module (`writeScoped(key, v, STORE)`),
 * which resolves once, here. When the wrapper forwards a store parameter of its
 * own, the fragment points at the caller's argument instead.
 */
function wrapperStore(storeSpec, args, origins, mod) {
    const part = storeSpec || {};
    // a wrapper around a wrapper inherits the store the inner one already resolved
    if (part.resolved !== undefined) return { resolved: part.resolved };
    const expr = sinkArgument(part, args);
    if (expr === undefined) {
        return { resolved: part.default ? [{ kind: 'literal', value: part.default }] : [] };
    }
    const forwarded = forwardedParameter(expr, origins);
    if (forwarded && forwarded.arg !== undefined) return { arg: forwarded.arg, default: part.default };
    return { resolved: resolve(expr, { mod, bindings: new Map(), seen: new Set(), depth: 0 }) };
}

/**
 * Sinks that are not written down: functions that forward a parameter of their
 * own into a sink's *key* position.
 *
 * {@link SINKS} lists the helpers that own a key family, and matching it by name
 * catches only direct calls. A wrapper — `saveUpgradeResults(key, …)` calling
 * `writeScoped(key, …)` — hides its callers' key constants from the scan
 * entirely, and the next one anybody writes would hide theirs. So the wrappers
 * are found rather than listed: a function whose parameter reaches a sink's key
 * position is itself a sink, its call sites are scanned like any other sink's,
 * and the pass repeats until nothing new turns up, because a wrapper around a
 * wrapper is possible.
 *
 * The narrowness is the point. It is not enough for a function to *call* a
 * sink — half of `src/` does that with a constant of its own, and treating those
 * as sinks would flood the scan with noise, which gets silenced, which is worse
 * than the gap. The parameter has to be handed to the sink as the key.
 *
 * @param {string[]} files - The modules to read
 * @param {Object} baseSinks - The written-down sinks to start from
 * @returns {{sinks: Object, discovered: string[], defSites: Set<string>, forwardSites: Set<string>}}
 *   The full sink table, the names it grew by, the wrapper definitions to skip,
 *   and the forwarding calls whose keys their callers name instead
 */
function discoverWrapperSinks(files, baseSinks) {
    const sinks = { ...baseSinks };
    const discovered = [];
    const defSites = new Set();
    const forwardSites = new Set();

    for (let pass = 0; pass < 6; pass += 1) {
        const found = new Map();

        for (const file of files) {
            const mod = loadModule(file);
            if (!mod.defs.size) continue;
            const defs = [];
            for (const [name, list] of mod.defs) for (const def of list) defs.push({ name, def });

            for (const [sinkName, sinkSpec] of Object.entries(sinks)) {
                const re = new RegExp(`\\b${sinkName}\\s*\\(`, 'g');
                let m;
                while ((m = re.exec(mod.text))) {
                    const at = m.index;
                    const before = mod.text.slice(Math.max(0, at - 30), at);
                    if (/(function|class)\s+$/.test(before)) continue;
                    const open = at + m[0].length - 1;
                    const args = callArgs(mod.text, open);
                    const parts = sinkSpec.keys || (sinkSpec.key ? [sinkSpec.key] : []);

                    // innermost first: the parameter belongs to the closest
                    // enclosing function, not to whatever encloses that
                    const enclosing = defs
                        .filter(({ def }) => at >= def.bodyStart && at < def.bodyEnd)
                        .sort((a, b) => a.def.bodyEnd - a.def.bodyStart - (b.def.bodyEnd - b.def.bodyStart));

                    for (const part of parts) {
                        if (part.kind === 'ignore') continue;
                        const expr = sinkArgument(part, args);
                        if (expr === undefined) continue;
                        const host = enclosing.find(({ def }) => forwardedParameter(expr, parameterOrigins(def)));
                        if (!host || host.name === sinkName) continue;
                        const origins = parameterOrigins(host.def);
                        const origin = forwardedParameter(expr, origins);
                        const keyPart =
                            origin.arg !== undefined
                                ? { arg: origin.arg, kind: part.kind }
                                : origin.index === 0
                                  ? { option: origin.option, kind: part.kind }
                                  : null;
                        // a destructured options object in any position but the
                        // first cannot be addressed at the call site, so it is
                        // left undiscovered — the write then shows up as a blind
                        // spot, which is the alarm, not a silence
                        if (!keyPart) continue;
                        // covered from this wrapper's own call sites instead
                        forwardSites.add(`${file}|${at}`);
                        if (sinks[host.name]) continue;
                        keyPart.store = wrapperStore(part.store || sinkSpec.store, args, origins, mod);
                        if (!found.has(host.name)) found.set(host.name, { keys: [], sites: [] });
                        const entry = found.get(host.name);
                        const same = (k) => k.arg === keyPart.arg && k.option === keyPart.option;
                        if (!entry.keys.some(same)) entry.keys.push(keyPart);
                        entry.sites.push(`${file}|${host.def.nameIndex}`);
                    }
                }
            }
        }

        let added = false;
        for (const [name, spec] of found) {
            if (sinks[name]) continue;
            sinks[name] = { keys: spec.keys, store: { resolved: [] } };
            for (const site of spec.sites) defSites.add(site);
            discovered.push(name);
            added = true;
        }
        if (!added) break;
    }

    return { sinks, discovered, defSites, forwardSites };
}

/**
 * The keys an object literal names, resolved.
 *
 * `{[KEY_GIST_ID]: null, …}` is a bulk write that says exactly which keys it
 * writes; only the constants are in the way. An argument that is not written out
 * as an object here (a variable, a spread, a function's parameter) yields
 * nothing, and the site counts as unresolved.
 *
 * @param {string} expr - The argument as written
 * @param {Object} mod - The module it was written in
 * @returns {Array<{kind: string, value: string}>} Resolved key names
 */
function objectKeyNames(expr, mod) {
    const text = (expr || '').trim();
    if (!text.startsWith('{')) return [];
    const close = matchBracket(text, 0);
    if (close < 0) return [];
    const out = [];
    for (const entry of splitTopLevel(text.slice(1, close))) {
        const colon = topLevel(entry, ':');
        if (colon < 0) continue;
        const name = entry.slice(0, colon).trim();
        const computed = /^\[([\s\S]+)\]$/.exec(name);
        const source = computed ? computed[1] : name;
        const results = resolve(source, { mod, bindings: new Map(), seen: new Set(), depth: 0 });
        if (results.length) out.push(...results);
        else if (!computed && /^[A-Za-z_$][\w$]*$/.test(name)) out.push({ kind: 'literal', value: name });
    }
    return out;
}

/**
 * Every place this script writes a storage key, with the store and the key
 * resolved as far as the source allows.
 *
 * @returns {Array<{file: string, line: number, via: string|null,
 *   stores: Array<{kind: string, value: string}>, keys: Array<{kind: string, value: string}>,
 *   bulk: boolean}>} One row per write site (per key family, for a helper that owns several)
 */
function scanWrites(files, sinks = SINKS, meta = {}) {
    const rows = [];
    const defSites = meta.defSites || new Set();
    const forwardSites = meta.forwardSites || new Set();

    for (const file of files) {
        const mod = loadModule(file);
        const rel = file.slice(srcRoot.length + 1).replace(/\\/g, '/');
        const callRe = /storage\s*\.\s*(set|setJSON|putAll)\s*\(/g;
        let m;
        while ((m = callRe.exec(mod.text))) {
            const open = m.index + m[0].length - 1;
            const args = callArgs(mod.text, open);
            const line = mod.text.slice(0, m.index).split('\n').length;
            const ctx = () => ({ mod, bindings: new Map(), seen: new Set(), depth: 0 });
            if (m[1] === 'putAll') {
                // A bulk write names its keys in the object it is handed, when
                // that object is written out where it is passed
                rows.push({
                    file: rel,
                    line,
                    via: null,
                    stores: resolve(args[0], ctx()),
                    keys: objectKeyNames(args[1], mod),
                    bulk: true,
                });
                continue;
            }
            rows.push({
                file: rel,
                line,
                via: null,
                stores: args[2] ? resolve(args[2], ctx()) : [{ kind: 'literal', value: 'settings' }],
                keys: resolve(args[0], ctx()),
                bulk: false,
            });
        }
    }

    for (const file of files) {
        const mod = loadModule(file);
        for (const [name, spec] of Object.entries(sinks)) {
            const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
            let m;
            while ((m = re.exec(mod.text))) {
                const open = m.index + m[0].length - 1;
                const args = callArgs(mod.text, open);
                const line = mod.text.slice(0, m.index).split('\n').length;
                const rel = file.slice(srcRoot.length + 1).replace(/\\/g, '/');
                const before = mod.text.slice(Math.max(0, m.index - 30), m.index);
                if (/(function|class)\s+$/.test(before)) continue; // the definition, not a call
                if (defSites.has(`${file}|${m.index}`)) continue; // a discovered wrapper's own definition
                const forwarded = forwardSites.has(`${file}|${m.index}`);
                const ctx = () => ({ mod, bindings: new Map(), seen: new Set(), depth: 0 });
                const optionExprs = (option) => {
                    const first = (args[0] || '').trim();
                    const out = [];
                    if (first.startsWith('{')) {
                        const direct = objectProperties(first).get(option);
                        if (direct !== undefined) out.push({ expr: direct, mod });
                        // spread of another options object
                        for (const entry of splitTopLevel(first.slice(1, matchBracket(first, 0)))) {
                            const spread = /^\.\.\.\s*([A-Za-z_$][\w$]*)$/.exec(entry.trim());
                            if (!spread) continue;
                            for (const obj of objectLiteralsFor(spread[1], { mod, bindings: new Map() })) {
                                const prop = propertyOf(obj.text, option);
                                if (prop) out.push({ expr: prop, mod: obj.mod });
                            }
                        }
                        return out;
                    }
                    const id = /^[A-Za-z_$][\w$]*$/.exec(first);
                    if (id) {
                        for (const obj of objectLiteralsFor(first, { mod, bindings: new Map() })) {
                            const prop = propertyOf(obj.text, option);
                            if (prop) out.push({ expr: prop, mod: obj.mod });
                        }
                    }
                    return out;
                };
                const pick = (part) => {
                    if (!part) return [];
                    // a discovered wrapper's store was resolved once, where the
                    // wrapper was found, because it is a constant there
                    if (part.resolved !== undefined) return part.resolved;
                    if (part.option !== undefined) {
                        const exprs = optionExprs(part.option);
                        if (!exprs.length) return part.default ? [{ kind: 'literal', value: part.default }] : [];
                        const out = [];
                        for (const { expr, mod: exprMod } of exprs) {
                            out.push(
                                ...resolve(unwrapArrow(expr), {
                                    mod: exprMod,
                                    bindings: new Map(),
                                    seen: new Set(),
                                    depth: 0,
                                })
                            );
                        }
                        return out;
                    }
                    if (part.arg !== undefined) {
                        if (args[part.arg] === undefined) {
                            return part.default ? [{ kind: 'literal', value: part.default }] : [];
                        }
                        return resolve(args[part.arg], ctx());
                    }
                    return part.default ? [{ kind: 'literal', value: part.default }] : [];
                };
                const storeRes = pick(spec.store);
                if (spec.objectKeys !== undefined) {
                    const named = objectKeyNames(args[spec.objectKeys], mod);
                    if (named.length) {
                        rows.push({ file: rel, line, via: name, stores: storeRes, keys: named, bulk: false });
                    }
                    continue;
                }
                const parts = spec.keys || [spec.key];
                for (const part of parts) {
                    if (part.kind === 'ignore') continue;
                    const keyRes = pick(part).map((r) => ({
                        kind: part.kind === 'prefix' && r.kind !== 'suffix' ? 'prefix' : r.kind,
                        value: r.value,
                    }));
                    rows.push({
                        file: rel,
                        line,
                        via: name,
                        stores: part.store ? pick(part.store) : storeRes,
                        keys: keyRes,
                        bulk: false,
                        forwarded,
                    });
                }
            }
        }
    }

    return rows;
}

/**
 * Modules that write a key someone else chose.
 *
 * Each is a storage helper: it is handed a base, a prefix or a whole key and
 * writes under it, so there is nothing at its own write site to resolve. The
 * families they write are covered from their call sites instead — see
 * {@link SINKS} — and listing a module here says "this file's own write sites
 * are expected to be unreadable", not "these keys need not be registered".
 *
 * `core/settings-storage.js` is here for a different reason: its one unreadable
 * write is `importSettings`, which writes back whatever keys a backup file
 * contains. Those keys were written by some other site, which this scan does
 * read.
 */
const CALLER_KEYED_MODULES = new Set([
    'core/settings-storage.js',
    // Its one write is `rememberLocal`, a wrapper whose callers name the keys —
    // and those call sites are scanned, as a sink
    'features/sync/sync-manager.js',
    'utils/character-key.js',
    'utils/chunked-history.js',
    'utils/daily-checkpoints.js',
    'utils/floating-widget.js',
    'utils/full-backup.js',
    'utils/live-session-persist.js',
    'utils/name-keyed-store.js',
    'utils/persisted-record.js',
    'utils/scoped-data-repair.js',
]);

/**
 * Whether a resolved key is covered by a registry.
 *
 * A prefix is asked about as though it were the shortest key in its family: if
 * `actionSortMode_` is covered then every `actionSortMode_<id>` is. A trailing
 * shape (a key whose leading segment is a character id) is asked about with a
 * stand-in id in front, which is exactly the shape the patterns match.
 *
 * @param {{kind: string, value: string}} key - A resolved key, prefix or shape
 * @param {(store: string, key: string) => boolean} owns - The registry to ask
 * @returns {boolean} Whether the registry claims it
 */
function covered(key, owns) {
    if (key.kind === 'suffix') return owns('settings', `aCharacterId${key.value}`);
    return owns('settings', key.value);
}

/** The write sites that could name a key in a store filtered key by key. */
function rowsNeedingCoverage(rows) {
    return rows.filter((row) => {
        if (row.stores.length === 0) return true; // store unknown: assume the filtered one
        return row.stores.some((store) => KEY_FILTERED_STORES.includes(store.value));
    });
}

/**
 * A trailing shape that identifies nothing.
 *
 * `` `${base}_${characterId ?? 'default'}` `` inside a storage helper resolves to
 * the shape `_default` — which is true and useless: it says the key ends with a
 * character id, and every scoped key does. Treating such a result as a *key*
 * would have the coverage test demand a registry entry for `_default`; treating
 * it as *resolved* would let a helper's unreadable write pass as readable. It is
 * neither, so it is dropped, and the site counts as unresolved — which is what
 * {@link CALLER_KEYED_MODULES} already says about the files it happens in.
 */
function identifying(key) {
    if (key.kind !== 'suffix') return Boolean(key.value);
    if (key.value.length < 8) return false;
    return !/^[_:-]*(default)?[_:-]*$/.test(key.value);
}

/**
 * Read a set of modules: find the wrappers, then every write site.
 *
 * @param {string[]} files - Modules to read
 * @param {{followWrappers?: boolean}} [options] - `followWrappers: false` runs
 *   the written-down sinks only, which is how the negative control shows what
 *   the fixed-point pass is worth
 * @returns {{writes: Array, discovered: string[]}} The write sites and the sinks found
 */
function analyze(files, { followWrappers = true } = {}) {
    const found = followWrappers
        ? discoverWrapperSinks(files, SINKS)
        : { sinks: SINKS, discovered: [], defSites: new Set(), forwardSites: new Set() };
    const rows = scanWrites(files, found.sinks, found).map((row) => ({
        ...row,
        keys: row.keys.filter(identifying),
    }));
    return { writes: rows, discovered: found.discovered };
}

const analysis = analyze(sources());
const writes = analysis.writes;

describe('what the scan can read', () => {
    test('it finds the write sites at all', () => {
        // A resolver that silently stopped working would make every other test
        // here pass by finding nothing
        expect(writes.length).toBeGreaterThan(200);
        expect(writes.filter((row) => row.via).length).toBeGreaterThan(30);
    });

    test('only the declared storage helpers write keys it cannot resolve', () => {
        const blind = rowsNeedingCoverage(writes)
            .filter((row) => !row.bulk && row.keys.length === 0)
            .filter((row) => !row.forwarded) // a wrapper's own write: its callers name the key
            .filter((row) => !CALLER_KEYED_MODULES.has(row.file))
            .map((row) => `${row.file}:${row.line}${row.via ? ` (via ${row.via})` : ''}`);

        // A new entry here is a new place a key can be added without this test
        // noticing. Resolve it, or route it through one of the helpers above —
        // adding it to CALLER_KEYED_MODULES only silences the alarm.
        expect(blind).toEqual([]);
    });

    test('the wrappers it follows are the ones that exist', () => {
        // Pinned, like the unused-prefix list: a new wrapper around a storage
        // helper is a new family of keys arriving by a route nobody looked at,
        // and it should be looked at once. Adding a name here is the whole
        // maintenance cost of the fixed-point pass.
        // `collectionRecord` forwards a base into `createCuratedRecord`;
        // `saveUpgradeResults` / `loadUpgradeResults` forward a key into
        // `writeScoped` / `readScoped`. Both families land in an object store of
        // their own rather than in `settings`, so neither is filtered by key
        // today — they are found so that the next one, which might be, is too.
        expect([...analysis.discovered].sort()).toEqual([
            'collectionRecord',
            'loadUpgradeResults',
            'saveUpgradeResults',
        ]);
    });

    test('every bulk write into a filtered store says which keys it writes', () => {
        // `putAll` hands the store a whole object. Where that object is written
        // out at the call site its keys are read like any others; where it is
        // handed in from somewhere else, this scan cannot tell what lands in a
        // shared store, and that is the one thing it must not shrug at.
        const bulk = rowsNeedingCoverage(writes)
            .filter((row) => row.bulk && row.keys.length === 0)
            .filter((row) => !CALLER_KEYED_MODULES.has(row.file))
            .map((row) => `${row.file}:${row.line}`);
        expect(bulk).toEqual([]);
    });
});

describe('registry coverage', () => {
    test('every key this script writes into a shared store is registered', () => {
        const uncovered = [];
        for (const row of rowsNeedingCoverage(writes)) {
            for (const key of row.keys) {
                if (!key.value) continue;
                if (covered(key, ownsKey)) continue;
                uncovered.push(`${key.value} (${key.kind}) — ${row.file}:${row.line}`);
            }
        }

        // Every name here is a record that would stop syncing, silently, on the
        // day this change ships. Add it to OWNED_KEY_PREFIXES in
        // sync-ownership.js; when in doubt, add it anyway.
        expect(uncovered).toEqual([]);
    });

    test('it notices a registry with a hole in it', () => {
        // The test above is only worth having if it fails when the registry
        // stops covering something. Take one prefix away and it must.
        const victim = 'panelGeometry';
        expect(OWNED_KEY_PREFIXES).toContain(victim);
        const thinned = OWNED_KEY_PREFIXES.filter((prefix) => prefix !== victim);
        const owns = (store, key) =>
            thinned.some((prefix) => String(key).startsWith(prefix)) ||
            OWNED_KEY_PATTERNS.some((pattern) => pattern.test(String(key)));

        const uncovered = rowsNeedingCoverage(writes)
            .flatMap((row) => row.keys)
            .filter((key) => key.value && !covered(key, owns))
            .map((key) => key.value);

        expect(uncovered).toContain(victim);
    });

    test('it notices a key that only reaches storage through a wrapper', () => {
        // The other control thins the registry; this one thins nothing and
        // instead hands the scan a wrapper of the exact shape the fixed-point
        // pass exists for — a function forwarding its own parameter into
        // `writeScoped`, and another wrapping that one. Without it the new
        // machinery has nothing proving it still works.
        const dir = join(srcRoot, '__wrapper_control__');
        const inner = join(dir, 'inner.js');
        const outer = join(dir, 'outer.js');
        const caller = join(dir, 'caller.js');

        seedModule(
            inner,
            [
                "import { writeScoped } from '../utils/character-key.js';",
                "const CONTROL_STORE = 'settings';",
                'export async function saveControlRecord(key, value) {',
                '    await writeScoped(key, value, CONTROL_STORE, true);',
                '}',
            ].join('\n')
        );
        seedModule(
            outer,
            [
                "import { saveControlRecord } from './inner.js';",
                'export async function saveControlRecordLabeled(key, value, label) {',
                '    await saveControlRecord(key, { value, label });',
                '}',
            ].join('\n')
        );
        seedModule(
            caller,
            [
                "import { saveControlRecordLabeled } from './outer.js';",
                "const CONTROL_KEY = 'zzControlKeyNobodyRegistered';",
                'export async function recordControlThing(value) {',
                "    await saveControlRecordLabeled(CONTROL_KEY, value, 'label');",
                '}',
            ].join('\n')
        );

        const files = [inner, outer, caller];
        const followed = analyze(files);

        // both levels found, which is what iterating to a fixed point buys
        expect([...followed.discovered].sort()).toEqual(['saveControlRecord', 'saveControlRecordLabeled']);

        const keys = rowsNeedingCoverage(followed.writes).flatMap((row) => row.keys.map((key) => key.value));
        expect(keys).toContain('zzControlKeyNobodyRegistered');
        expect(keys.filter((value) => !ownsKey('settings', value))).toContain('zzControlKeyNobodyRegistered');

        // and the wrapper's own write is not reported as a new blind spot,
        // because its callers are what name the key
        const blind = rowsNeedingCoverage(followed.writes)
            .filter((row) => !row.bulk && row.keys.length === 0 && !row.forwarded)
            .map((row) => `${row.file}:${row.line}`);
        expect(blind).toEqual([]);

        // with the wrapper pass off, the key is invisible — that is the gap
        const direct = analyze(files, { followWrappers: false });
        expect(direct.writes.flatMap((row) => row.keys.map((key) => key.value))).not.toContain(
            'zzControlKeyNobodyRegistered'
        );
    });

    test('the prefixes nothing writes are the ones deliberately kept', () => {
        // A prefix matching no write is usually a legacy key kept on purpose —
        // an account can still hold one, and it is still entitled to sync. But
        // it is also what a typo looks like, and a typo'd prefix silently stops
        // covering the key it was meant to. Pinning the list means a new one has
        // to be looked at once.
        // Every store, not only the filtered one: a record that moved out of
        // `settings` into an object store of its own keeps its name, and the
        // prefix is still what covers the copies left on older accounts
        const written = writes.flatMap((row) => row.keys.map((key) => key.value));
        const unused = OWNED_KEY_PREFIXES.filter(
            (prefix) => !written.some((value) => value && (value.startsWith(prefix) || prefix.startsWith(value)))
        );

        // Empty today: every registered prefix answers to a write somewhere in
        // `src/`. A legacy name kept for accounts that still hold one belongs
        // here with a line saying so — a name that turns up here without one is
        // a typo, and a typo'd prefix covers nothing.
        expect(unused).toEqual([]);
    });
});
