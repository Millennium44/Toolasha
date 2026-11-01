import { describe, expect, test } from 'vitest';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    FOREIGN_COPY_ALLOWLIST,
    UNOWNED_SINGLETON_ALLOWLIST,
    findForeignSingletonCopies,
    findRoutedImportMisuse,
    findUnownedSingletonCopies,
    importedNames,
    moduleOwners,
    singletonClassName,
} from './check-bundle-sharing.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const abs = (rel) => normalize(join(root, rel));

describe('singletonClassName', () => {
    test('finds `export default new X()`', () => {
        expect(singletonClassName('class Foo {}\nexport default new Foo();\n')).toBe('Foo');
    });

    test('finds the const-then-export shape the managers use', () => {
        const source =
            'class ExpectedValueCalculator {\n}\n\nconst expectedValueCalculator = new ExpectedValueCalculator();\n\nexport default expectedValueCalculator;\n';
        expect(singletonClassName(source)).toBe('ExpectedValueCalculator');
    });

    test('ignores a class that is only exported, and plain function modules', () => {
        expect(singletonClassName('export class Foo {}\nexport function make() { return new Foo(); }\n')).toBeNull();
        expect(singletonClassName('const cache = new Map();\nexport function f() {}\n')).toBeNull();
    });
});

describe('findForeignSingletonCopies — the #671 shape', () => {
    // Market owns the calculator; the utils bundle imported it inline and got its own copy.
    const evc = abs('src/features/market/expected-value-calculator.js');
    const owners = new Map([[evc, new Set(['market'])]]);
    const classNameOf = () => 'ExpectedValueCalculator';

    test('flags a bundle other than the owner carrying the singleton', () => {
        const inline = new Map([[evc, new Set(['market', 'utils'])]]);
        expect(findForeignSingletonCopies(inline, owners, classNameOf, new Map())).toEqual([
            {
                modulePath: 'src/features/market/expected-value-calculator.js',
                className: 'ExpectedValueCalculator',
                owners: ['market'],
                bundles: ['utils'],
            },
        ]);
    });

    test('passes when only the owner carries it', () => {
        const inline = new Map([[evc, new Set(['market'])]]);
        expect(findForeignSingletonCopies(inline, owners, classNameOf, new Map())).toEqual([]);
    });

    test('an allowlisted bundle passes but a new bundle still fails', () => {
        const allowlist = new Map([['src/features/market/expected-value-calculator.js', new Map([['sim', 'why']])]]);
        const inline = new Map([[evc, new Set(['market', 'sim', 'ui'])]]);
        expect(findForeignSingletonCopies(inline, owners, classNameOf, allowlist).map((v) => v.bundles)).toEqual([
            ['ui'],
        ]);
    });

    test("a module with no owner or no singleton is not this check's business", () => {
        const inline = new Map([[evc, new Set(['market', 'utils'])]]);
        expect(findForeignSingletonCopies(inline, new Map(), classNameOf, new Map())).toEqual([]);
        expect(findForeignSingletonCopies(inline, owners, () => null, new Map())).toEqual([]);
    });
});

describe('moduleOwners', () => {
    test("reads the owning library from each bundle's Toolasha.<Library>.* globals", () => {
        const configs = [
            { input: 'src/libraries/market.js', output: {} },
            {
                input: 'src/libraries/ui.js',
                output: {
                    globals: { [abs('src/a.js')]: 'Toolasha.Market.a', [abs('src/b.js')]: 'Toolasha.Nowhere.b' },
                },
            },
        ];
        const owners = moduleOwners(configs);
        expect([...(owners.get(abs('src/a.js')) || [])]).toEqual(['market']);
        expect(owners.has(abs('src/b.js'))).toBe(false);
    });
});

describe('moduleOwners with routed ownership', () => {
    test('an owned singleton no bundle names in its globals still has an owner', () => {
        const configs = [
            { input: 'src/libraries/combat.js', output: {} },
            { input: 'src/libraries/actions.js', output: {} },
        ];
        const scroll = abs('src/features/combat/scroll-simulator.js');
        const ownership = new Map([[scroll, { global: 'Toolasha.Combat.scrollSimulator' }]]);
        expect([...(moduleOwners(configs, ownership).get(scroll) || [])]).toEqual(['combat']);
        expect(moduleOwners(configs).has(scroll)).toBe(false);
    });
});

describe('findUnownedSingletonCopies', () => {
    const tracker = abs('src/features/tasks/task-completion-tracker.js');
    const classNameOf = () => 'TaskCompletionTracker';

    test('flags a stateful singleton with no owner that two bundles carry', () => {
        const inline = new Map([[tracker, new Set(['ui', 'market'])]]);
        expect(findUnownedSingletonCopies(inline, new Map(), classNameOf, new Map())).toEqual([
            {
                modulePath: 'src/features/tasks/task-completion-tracker.js',
                className: 'TaskCompletionTracker',
                bundles: ['market', 'ui'],
            },
        ]);
    });

    test('passes one carrier, an owned module, a non-singleton and an allowlisted module', () => {
        const two = new Map([[tracker, new Set(['ui', 'market'])]]);
        expect(
            findUnownedSingletonCopies(new Map([[tracker, new Set(['ui'])]]), new Map(), classNameOf, new Map())
        ).toEqual([]);
        expect(findUnownedSingletonCopies(two, new Map([[tracker, new Set(['ui'])]]), classNameOf, new Map())).toEqual(
            []
        );
        expect(findUnownedSingletonCopies(two, new Map(), () => null, new Map())).toEqual([]);
        const allowed = new Map([['src/features/tasks/task-completion-tracker.js', 'why']]);
        expect(findUnownedSingletonCopies(two, new Map(), classNameOf, allowed)).toEqual([]);
    });
});

describe('UNOWNED_SINGLETON_ALLOWLIST', () => {
    test('every entry states a reason', () => {
        for (const reason of UNOWNED_SINGLETON_ALLOWLIST.values()) expect(reason.length).toBeGreaterThan(20);
    });
});

describe('FOREIGN_COPY_ALLOWLIST', () => {
    test('every tolerated copy states a reason', () => {
        for (const bundles of FOREIGN_COPY_ALLOWLIST.values()) {
            for (const reason of bundles.values()) expect(reason).toMatch(/bridge \+ fallback|KNOWN DEBT/);
        }
    });
});

describe('importedNames', () => {
    test('reads default, named (with aliases) and namespace shapes', () => {
        expect(importedNames("import x from './m.js'")).toEqual({ defaultImport: true, namespace: false, named: [] });
        expect(importedNames("import x, { a as b, c } from './m.js'")).toEqual({
            defaultImport: true,
            namespace: false,
            named: ['a', 'c'],
        });
        expect(importedNames("import {\n    rushFloorTable,\n    sparkText, // note\n} from '../m.js'")).toEqual({
            defaultImport: false,
            namespace: false,
            named: ['rushFloorTable', 'sparkText'],
        });
        expect(importedNames("import * as m from './m.js'").namespace).toBe(true);
        expect(importedNames("import './m.js'")).toEqual({ defaultImport: false, namespace: false, named: [] });
        expect(importedNames("export { a } from './m.js'").named).toEqual(['a']);
    });
});

describe('findRoutedImportMisuse - the ledger helpers shape', () => {
    const importer = abs('src/features/ui/consumables-panel.js');
    const ledger = abs('src/features/combat/labyrinth-run-ledger.js');
    const run = (statement, entry) =>
        findRoutedImportMisuse({
            bundle: 'ui',
            routed: new Map([[ledger, entry]]),
            inline: new Set([importer]),
            statements: () => [{ specifier: './l.js', statement }],
            resolve: () => ledger,
        });

    test('flags named imports from a module routed to an instance global', () => {
        const found = run("import { observedUse, sparkText } from '../combat/labyrinth-run-ledger.js'", {
            global: 'Toolasha.Combat.labyrinthRunLedger',
        });
        expect(found).toEqual([
            {
                bundle: 'ui',
                importer: 'src/features/ui/consumables-panel.js',
                modulePath: 'src/features/combat/labyrinth-run-ledger.js',
                unsupported: ['observedUse', 'sparkText'],
            },
        ]);
    });

    test('a default import is fine, listed names are fine, an unlisted one and a namespace are not', () => {
        const instance = { global: 'Toolasha.Combat.labyrinthRunLedger' };
        expect(run("import ledger from './l.js'", instance)).toEqual([]);
        const namespace = { global: 'Toolasha.Combat.buildScoreRow', named: ['ensureOwnScore'] };
        expect(run("import { ensureOwnScore } from './l.js'", namespace)).toEqual([]);
        expect(run("import { ensureOwnScore, other } from './l.js'", namespace)[0].unsupported).toEqual(['other']);
        expect(run("import * as l from './l.js'", instance)[0].unsupported).toEqual(['* (namespace)']);
    });
});
