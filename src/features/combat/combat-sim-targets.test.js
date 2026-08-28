/**
 * Tests for the supported combat simulator list.
 *
 * Two things are worth asserting here. First, that page detection actually recognises each
 * supported simulator and nothing else — a simulator the script does not recognise never gets
 * the "Import from Toolasha" button, and a URL wrongly recognised as a simulator would skip the
 * whole game-side bootstrap.
 *
 * Second — and this is the part a human reviewer misses — that the three places the same list
 * has to be repeated agree with each other. The list cannot be shared with `src/entrypoint.js`
 * (a standalone bundle that imports nothing from `src/`) or with the userscript `@match` headers
 * (plain text read by the userscript manager), so each keeps its own copy. Half-adding a
 * simulator — code that recognises a domain the header does not grant access to, or the
 * reverse — is silent at build time and only shows up as a dead button on the live page.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { COMBAT_SIM_TARGETS, combatSimTargetForUrl, isCombatSimulatorPage } from './combat-sim-targets.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relativePath) => readFileSync(join(projectRoot, relativePath), 'utf8');

describe('COMBAT_SIM_TARGETS', () => {
    test('lists both supported simulators', () => {
        expect(COMBAT_SIM_TARGETS.map((target) => target.id)).toEqual(['shykai', 'szerra']);
    });

    test('every target is fully specified with a unique id, label and url', () => {
        const ids = new Set();
        const labels = new Set();
        const urls = new Set();

        for (const target of COMBAT_SIM_TARGETS) {
            for (const field of ['id', 'label', 'url', 'urlFragment', 'match']) {
                expect(typeof target[field], `${target.id}.${field}`).toBe('string');
                expect(target[field].length, `${target.id}.${field}`).toBeGreaterThan(0);
            }
            expect(target.url.startsWith('https://'), target.id).toBe(true);
            // The nav link's URL must itself be a page the script recognises, so clicking the
            // link lands somewhere the import button will appear.
            expect(target.url).toContain(target.urlFragment);
            // The @match has to cover the whole simulator, not just its landing page.
            expect(target.match).toBe(`https://${target.urlFragment}*`);

            ids.add(target.id);
            labels.add(target.label);
            urls.add(target.url);
        }

        expect(ids.size).toBe(COMBAT_SIM_TARGETS.length);
        expect(labels.size).toBe(COMBAT_SIM_TARGETS.length);
        expect(urls.size).toBe(COMBAT_SIM_TARGETS.length);
    });
});

describe('isCombatSimulatorPage', () => {
    test.each(COMBAT_SIM_TARGETS)('recognises the $id simulator', (target) => {
        expect(isCombatSimulatorPage(target.url)).toBe(true);
        expect(combatSimTargetForUrl(target.url)?.id).toBe(target.id);
    });

    test('recognises deep links inside a simulator', () => {
        expect(isCombatSimulatorPage('https://shykai.github.io/MWICombatSimulatorTest/dist/index.html#sim')).toBe(true);
        expect(isCombatSimulatorPage('https://szerra.github.io/mwi-shrine-combat-simulator/index.html?p=1')).toBe(true);
    });

    test.each([
        ['the game itself', 'https://www.milkywayidle.com/game'],
        ['the test server', 'https://test.milkywayidle.com/game'],
        ['an unrelated github pages site', 'https://doh-nuts.github.io/Enhancelator/'],
        ['the szerra user page without the simulator repo', 'https://szerra.github.io/'],
        ['the shykai user page without the simulator repo', 'https://shykai.github.io/'],
        ['an empty url', ''],
    ])('does not recognise %s', (_label, url) => {
        expect(isCombatSimulatorPage(url)).toBe(false);
        expect(combatSimTargetForUrl(url)).toBeNull();
    });

    test('survives a non-string url instead of throwing', () => {
        expect(isCombatSimulatorPage(null)).toBe(false);
        expect(isCombatSimulatorPage(undefined)).toBe(false);
        expect(isCombatSimulatorPage(42)).toBe(false);
    });
});

describe('the copies of the target list stay in sync', () => {
    test("entrypoint.js's inline detection covers exactly these targets", () => {
        const source = read('src/entrypoint.js');
        const body = source.slice(source.indexOf('function isCombatSimulatorPage'));
        const detector = body.slice(0, body.indexOf('\n}\n') + 2);

        const fragments = [...detector.matchAll(/url\.includes\('([^']+)'\)/g)].map((match) => match[1]);
        expect(fragments).toEqual(COMBAT_SIM_TARGETS.map((target) => target.urlFragment));
    });

    test.each(['userscript-header.txt', 'library-headers/entrypoint.txt'])(
        '%s grants access to every target',
        (headerPath) => {
            const header = read(headerPath);
            const matches = [...header.matchAll(/^\/\/ @match\s+(\S+)$/gm)].map((match) => match[1]);

            for (const target of COMBAT_SIM_TARGETS) {
                expect(matches, `${headerPath} is missing an @match for ${target.id}`).toContain(target.match);
            }
        }
    );
});
