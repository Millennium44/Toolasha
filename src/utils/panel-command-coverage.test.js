/**
 * The standing guard over "every Toolasha panel can be opened from Ctrl+K".
 *
 * About a dozen perfectly good panels were unreachable from the palette for no
 * better reason than that nobody had written their two lines of registration,
 * and the list of what was missing existed nowhere. This is that list, kept
 * honest: a source-text scan in the idiom of `init-ownership-coverage.test.js`.
 *
 * It finds every file under `src/features` that builds a floating panel (a
 * `createPanel` shell, `makeResizable`, `makeDraggable`, a registered floating
 * panel, saved panel geometry) and requires one of three things of it:
 *
 * 1. the file calls `registerCommand(` itself, or registers an overlay tile with an `onOpen`
 *    (the palette offers every such tile as an "Overlay row" entry on its own), or
 * 2. its entry in `COMMAND_ELSEWHERE` names the file that registers the command
 *    (and that file must really call `registerCommand(`), or
 * 3. its entry in `NOT_A_PALETTE_PANEL` gives a one-line reason it should not
 *    have a command: it is bound to a page, opened by an event, or is not a
 *    panel at all.
 *
 * A file that has both a tile and a command would list the panel twice, so its command must
 * name the tile it covers with `row: '<tile key>'` (or a list of keys); the palette then shows
 * the command and skips the tile entry. Every `row:` key must be a tile that exists.
 *
 * An entry that no longer matches a panel file is stale and fails too, so the
 * lists cannot rot into a second place nobody reads.
 *
 * The scan is textual: a pass means "every panel file is accounted for", not
 * "every command opens the right thing" or "is gated by the right setting".
 */

import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEATURES = join(SRC, 'features');

/** What makes a file a panel file: the helpers a floating panel is built from */
const PANEL_SHAPES = [
    /\bcreatePanel\(/,
    /\bmakeResizable\b/,
    /\bmakeDraggable\b/,
    /\bregisterFloatingPanel\b/,
    /\battachMinimize\b/,
    /\bZ_FLOATING_PANEL\b/,
    /\bsaveGeometry\b/,
    /\brestoreGeometry\b/,
    // A full-screen modal rather than a floating panel, and a panel built on the shared shell's helpers
    /\bZ_MODAL\b/,
    /simple-panel\.js/,
];

/**
 * Panel files whose command is registered by a sibling, because the panel
 * object lives here and the feature that owns its lifecycle lives there.
 * Keyed by path under `src/features`, valued by the file that registers it.
 */
const COMMAND_ELSEWHERE = {
    'combat-sim/combat-sim-ui.js': 'combat-sim/combat-sim.js',
    'combat-sim/lab-sim-ui.js': 'combat-sim/lab-sim.js',
    'combat/dungeon-tracker-ui-interactions.js': 'combat/dungeon-tracker-ui.js',
    'combat/party-luck-panel.js': 'combat/combat-drop-luck.js',
    'dev/health-status.js': 'ui/command-palette.js',
    'guild/guild-trial-scoreboard.js': 'guild/guild-trials.js',
    'profile/build-score-panel.js': 'profile/build-score-row.js',
    'queue-monitor/queue-monitor-ui.js': 'queue-monitor/queue-monitor.js',
    'sync/pull-summary-panel.js': 'sync/sync-manager.js',
};

/**
 * Panel-shaped files that deliberately have no palette command, each with the
 * reason. Page-bound panels belong here: a command that opens them off their
 * page would open something with nothing to show.
 */
const NOT_A_PALETTE_PANEL = {
    'actions/tea-recommendation.js': 'popup anchored to the action panel it advises; has nothing to show elsewhere',
    'chat/mention-popup.js': 'popup for one chat channel, opened from that channel’s own mention badge',
    'chat/pop-out-chat.js': 'opens or focuses a browser window (no toggle), and only from the chat tab’s button',
    'collection/collection-navigation.js': 'buttons injected into the game’s collection popover, not a panel',
    'combat-sim/guild-trial-assign-ui.js': 'a view inside the Trial Simulator, reached through that panel’s command',
    'combat-sim/sim-entity-select-fallback.js': 'a dropdown replacement inside the simulators, not a panel',
    'combat/dungeon-tracker-ui-state.js': 'saved preferences of the Dungeon Tracker, which has its own command',
    'combat/labyrinth-room-distribution.js': 'popup bound to the labyrinth room it describes',
    'crafting-plan/crafting-plan-walk.js': 'walk widget that follows a plan in progress, started from the plan itself',
    'guild/guild-trial-input-capture.js': 'checklist inside the Trial Simulator’s setup, reached through its command',
    'market/market-history-viewer.js': 'the marketplace Market History tab: opens only from its tab on that page',
    'networth/networth-exclusion-popup.js': 'opened from the net worth settings and tile menu that it edits',
    'profile/combat-score.js': 'the combat-score breakdown, opened from the profile card it explains',
    'settings/whats-new.js': 'shown once per update on its own and from the settings tab, not a standing panel',
    'ui/text-appearance.js': 'applies a text size to existing panels; not a panel',
};

/** Every non-test `.js` file under a directory, recursively, as paths under `src/features` */
function sourceFiles(directory) {
    const files = [];
    for (const name of readdirSync(directory)) {
        const full = join(directory, name);
        if (statSync(full).isDirectory()) {
            files.push(...sourceFiles(full));
        } else if (name.endsWith('.js') && !name.endsWith('.test.js')) {
            files.push(relative(FEATURES, full).split('\\').join('/'));
        }
    }
    return files;
}

/** The source of a file under `src/features`, or null if it is not there */
function read(path) {
    try {
        return readFileSync(join(FEATURES, path), 'utf8');
    } catch {
        return null;
    }
}

const registers = (source) => /\bregisterCommand\(/.test(source ?? '');
/** The source without comments, so a doc example of registerRow does not count as a tile */
const code = (source) => (source ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** A tile the palette lists by itself: registered with an `onOpen` that opens something */
const hasOpenTile = (source) => /\bregisterRow\(\{/.test(code(source)) && /\bonOpen:/.test(code(source));
const isPanelFile = (source) => PANEL_SHAPES.some((shape) => shape.test(source));

const panelFiles = sourceFiles(FEATURES).filter((path) => isPanelFile(read(path)));
const unregistered = panelFiles.filter((path) => !registers(read(path)) && !hasOpenTile(read(path)));

const allFiles = sourceFiles(FEATURES);
/** Every tile key registered anywhere under `src/features` */
const tileKeys = new Set(
    allFiles.flatMap((path) =>
        [...code(read(path)).matchAll(/registerRow\(\{\s*key:\s*'([^']+)'/g)].map((match) => match[1])
    )
);
/** The `row:` links in a file's registerCommand calls, as keys */
const linkedKeys = (source) =>
    [...(source ?? '').matchAll(/^\s*row:\s*(\[[^\]]*\]|'[^']*')/gm)].flatMap((match) =>
        [...match[1].matchAll(/'([^']*)'/g)].map((key) => key[1])
    );

describe('every Toolasha panel can be opened from Ctrl+K', () => {
    test('the scan finds the panels it should', () => {
        // A refactor that breaks the shapes above leaves a test that passes forever and
        // detects nothing, so it is anchored to files that are known to be panels
        expect(panelFiles).toContain('account/account-panel.js');
        expect(panelFiles).toContain('market/overbid-panel.js');
        expect(panelFiles).toContain('ui/combat-panels.js');
        expect(panelFiles.length).toBeGreaterThan(40);
    });

    test('every panel file registers a command or says why not', () => {
        const unaccounted = unregistered.filter(
            (path) => !(path in COMMAND_ELSEWHERE) && !(path in NOT_A_PALETTE_PANEL)
        );

        expect(
            unaccounted,
            `These files build a floating panel but nothing offers it in the Ctrl+K palette:\n  ${unaccounted.join('\n  ')}\n\n` +
                'Register a command with registerCommand() from utils/command-registry.js (see queue-monitor.js ' +
                'for a feature with a lifecycle, gold-sources-panel.js for one without), gated by the same setting ' +
                'as the panel. If the panel only makes sense on a page, add it to NOT_A_PALETTE_PANEL in ' +
                'src/utils/panel-command-coverage.test.js with a one-line reason; if its command lives in another ' +
                'file, add it to COMMAND_ELSEWHERE.'
        ).toEqual([]);
    });

    test('a command registered elsewhere really is', () => {
        const missing = Object.entries(COMMAND_ELSEWHERE)
            .filter(([, via]) => !registers(read(via)))
            .map(([path, via]) => `${path} -> ${via}`);

        expect(missing, 'COMMAND_ELSEWHERE names a file that never calls registerCommand()').toEqual([]);
    });

    test('the lists hold no stale entries', () => {
        const stale = [...Object.keys(COMMAND_ELSEWHERE), ...Object.keys(NOT_A_PALETTE_PANEL)].filter(
            (path) => !unregistered.includes(path)
        );

        expect(
            stale,
            'These entries are no longer panel files without a command of their own (renamed, deleted, or now ' +
                'registering their own command): remove them from the lists in src/utils/panel-command-coverage.test.js'
        ).toEqual([]);
    });

    test('every allowlist entry gives a reason', () => {
        for (const [path, reason] of Object.entries(NOT_A_PALETTE_PANEL)) {
            expect(reason.length, path).toBeGreaterThan(10);
        }
    });

    test('a file with both a tile and a command links the tile, so the palette lists the panel once', () => {
        const unlinked = allFiles.filter((path) => {
            const source = read(path);
            return hasOpenTile(source) && registers(source) && linkedKeys(source).length === 0;
        });

        expect(
            unlinked,
            `These files register an overlay tile with an onOpen and a palette command, but the command does not ` +
                `say which tile it covers, so Ctrl+K lists the panel twice:\n  ${unlinked.join('\n  ')}\n\n` +
                "Add row: '<tile key>' (or a list of keys) to the registerCommand call. Or drop the command if " +
                'the tile entry is enough.'
        ).toEqual([]);
    });

    test('every row link names a tile that exists', () => {
        const dangling = allFiles.flatMap((path) =>
            registers(read(path))
                ? linkedKeys(read(path))
                      .filter((key) => !tileKeys.has(key))
                      .map((key) => `${path}: ${key}`)
                : []
        );

        expect(dangling, 'A registerCommand row: names a tile key no registerRow declares').toEqual([]);
        expect(tileKeys.has('netWorth')).toBe(true);
    });
});
