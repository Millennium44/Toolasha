/**
 * Build-free pre-check of scripts/check-bundle-sharing.mjs.
 *
 * The real check runs after a production build (gates, CI), so an agent that
 * imports one new src/utils module from two bundles passes its own tests and
 * only learns at integration. This runs the identical analysis (the exported
 * analyze(), over the real rollup config and the static import graph, no
 * build) inside the normal test run. Dynamic imports are not followed, the
 * same as the real check (es-module-lexer reports no specifier for them and
 * src/ has none); ?raw and ?worker imports are skipped as in the real check.
 */
import { describe, expect, test } from 'vitest';
import { analyze } from './check-bundle-sharing.mjs';

describe('bundle sharing pre-check', () => {
    test('no module is duplicated across production bundles without sharing or an allowlist entry', async () => {
        const { violations, foreignCopies, unownedCopies, routedMisuse } = await analyze();
        const lines = [
            ...violations.map(
                (v) =>
                    `${v.modulePath} is bundled inline into ${v.bundles.join(' and ')}. If it is stateless, add it to ` +
                    `ALLOWLIST in scripts/check-bundle-sharing.mjs with a reason; otherwise add it to ` +
                    `utilsExternalGlobals in rollup.config.js and export it from src/libraries/utils.js ` +
                    `(src/core: coreExternalGlobals and src/libraries/core.js).`
            ),
            ...foreignCopies.map(
                (c) =>
                    `${c.modulePath} (singleton ${c.className}) is owned by ${c.owners.join(', ')} but also inline in ` +
                    `${c.bundles.join(', ')}: read it through src/utils/bundle-bridge.js instead of importing it.`
            ),
            ...unownedCopies.map(
                (c) =>
                    `${c.modulePath} (singleton ${c.className}) has no owner and is inline in ${c.bundles.join(', ')}: ` +
                    `add it to singletonOwnership in rollup.config.js.`
            ),
            ...routedMisuse.map(
                (m) =>
                    `${m.importer} (${m.bundle} bundle) imports ${m.unsupported.join(', ')} from ${m.modulePath}, ` +
                    `which is routed to its owner's instance and has no such names.`
            ),
        ];
        expect(lines, `\n${lines.join('\n')}\nSee scripts/check-bundle-sharing.mjs for the full rules.\n`).toEqual([]);
    });
});
