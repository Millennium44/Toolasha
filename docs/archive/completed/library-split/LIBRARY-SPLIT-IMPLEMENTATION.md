# Library Split Implementation

## Overview

Successfully implemented library split to comply with Greasy Fork's 2MB per-file size limit. The monolithic userscript has been divided into 6 separate libraries plus a minimal entrypoint.

## Library Architecture

### Libraries

1. **toolasha-core.user.js** (~176KB)
    - Core infrastructure modules
    - API clients (marketplace)
    - All GM grants and external dependencies
    - **Status:** Under 2MB limit

2. **toolasha-utils.user.js** (~229KB)
    - All utility modules (formatters, calculators, helpers)
    - Pure functions, no side effects
    - Grants aligned with entrypoint for consistent context

3. **toolasha-market.user.js** (~543KB)
    - Market features
    - Inventory features
    - Economy/networth features

4. **toolasha-actions.user.js** (~523KB)
    - Production/crafting features
    - Gathering features
    - Alchemy features

5. **toolasha-combat.user.js** (~409KB)
    - Combat features
    - Abilities features
    - Combat stats
    - Profile features
    - Requires Chart.js

6. **toolasha-ui.user.js** (~442KB)
    - UI enhancements
    - Tasks features
    - Skills features
    - House features
    - Settings UI
    - Dictionary features
    - Enhancement features
    - Notifications

7. **Toolasha.user.js** (~16KB)
    - Minimal entrypoint
    - Loads all libraries via @require
    - Orchestrates initialization
    - Registers features dynamically

### Total Size

- **Combined:** ~2.3MB across 7 files
- **Original:** 2.1MB single file
- **Overhead:** Minimal (shared core/utils are externalized in library builds)

## Load Order

Libraries must be loaded in this specific order (defined in entrypoint header):

```
1. toolasha-core.user.js      (foundation)
2. toolasha-utils.user.js     (utilities)
3. toolasha-market.user.js    (features)
4. toolasha-actions.user.js   (features)
5. toolasha-combat.user.js    (features)
6. toolasha-ui.user.js        (features)
7. Toolasha.user.js           (orchestrator)
```

## Global Namespace

Each library exports to `window.Toolasha.*`:

```javascript
window.Toolasha = {
    Core: {
        storage,
        config,
        webSocketHook,
        domObserver,
        dataManager,
        featureRegistry,
        settingsStorage,
        settingsGroups,
        profileManager,
        marketAPI,
    },
    Utils: {
        formatters,
        efficiency,
        profitHelpers,
        // ... all utility modules
    },
    Market: {
        tooltipPrices,
        expectedValueCalculator,
        // ... all market features
    },
    Actions: {
        /* ... */
    },
    Combat: {
        /* ... */
    },
    UI: {
        /* ... */
    },
    version: '0.14.3',
    features: {
        /* API */
    },
};
```

## Build System

### Development Build (Standalone)

```bash
npm run build:dev
```

- Uses `src/main.js` as entry point
- Outputs `dist/Toolasha-dev.user.js`
- Intended for local testing and iteration

### Production Build (Multi-Bundle)

```bash
npm run build
```

- Uses `BUILD_MODE=production` environment variable (set by npm script)
- Outputs 7 separate files to `dist/` and `dist/libraries/`
- Core/utils are externalized in feature library builds
- Entrypoint is minimal (no bundled code)

### Configuration

Rollup config (`rollup.config.js`) uses:

- `BUILD_MODE=production` for multi-bundle output
- `BUILD_TARGET=dev-standalone` for dev standalone output

## Feature Registration

The entrypoint dynamically registers features from all libraries:

```javascript
// In src/entrypoint.js
function registerFeatures() {
    const allFeatures = [
        { key: 'tooltipPrices', module: Market.tooltipPrices, async: true },
        { key: 'actionTimeDisplay', module: Actions.actionTimeDisplay, async: false },
        // ... all 50+ features
    ];

    const features = allFeatures.map((f) => ({
        key: f.key,
        name: f.name,
        category: f.category,
        initialize: () => f.module.initialize(),
        async: f.async,
    }));

    featureRegistry.replaceFeatures(features);
}
```

## Dependency Resolution

### Circular Dependencies (Resolved)

Before library split, these circular dependencies blocked clean separation:

1. ✅ `core/config.js` → `features/settings/*` (moved to core)
2. ✅ `core/websocket.js` → `features/combat/profile-cache.js` (moved to core)
3. ✅ `core/feature-registry.js` → all features (now dynamic)

### External Dependencies

**Core Library:**

- mathjs (CDN via @require)
- lz-string (CDN via @require)
- GM APIs (Tampermonkey grants)

**Combat Library:**

- Chart.js (CDN via @require)
- chartjs-plugin-datalabels (CDN via @require)

## Release Workflow Notes

- Entrypoint @require URLs start as placeholders in `library-headers/entrypoint.txt`.
- Release workflow replaces placeholders with GitHub raw URLs pinned to the release commit SHA.
- Built artifacts are pushed to the `releases` branch.

## Testing

### Local Testing

1. Build production bundles: `npm run build`
2. Inspect sizes: `ls -lh dist/libraries/*.user.js`
3. Test entrypoint loads libraries correctly
4. Verify all features initialize properly

### Tampermonkey Testing

1. Install the entrypoint userscript
2. Verify libraries load via @require before entrypoint execution
3. Test core features (market, actions, combat, UI)
4. Check for console errors or missing features

## File Structure

```
library-headers/
├── core.txt           # Core library userscript header
├── utils.txt          # Utils library header
├── market.txt         # Market library header
├── actions.txt        # Actions library header
├── combat.txt         # Combat library header
├── ui.txt             # UI library header
└── entrypoint.txt     # Entrypoint header (with @require URLs)

src/
├── libraries/
│   ├── core.js        # Core library entry point
│   ├── utils.js       # Utils library entry point
│   ├── market.js      # Market library entry point
│   ├── actions.js     # Actions library entry point
│   ├── combat.js      # Combat library entry point
│   └── ui.js          # UI library entry point
└── entrypoint.js      # Entrypoint script

dist/
├── libraries/
│   ├── toolasha-core.user.js
│   ├── toolasha-utils.user.js
│   ├── toolasha-market.user.js
│   ├── toolasha-actions.user.js
│   ├── toolasha-combat.user.js
│   └── toolasha-ui.user.js
├── Toolasha.user.js       # Production entrypoint
└── Toolasha-dev.user.js   # Dev standalone
```

## Migration Notes

### For Users

- **Before:** Install single Toolasha.user.js
- **After:** Install single Toolasha.user.js (entrypoint) which @requires libraries
- **Compatibility:** Same features, same settings, same data

### For Developers

- **Dev workflow:** `npm run build:dev` for standalone testing
- **Prod build:** `npm run build` for multi-bundle output
- **Feature changes:** Edit feature in appropriate library
- **New features:** Add to correct library + register in entrypoint

## Performance Impact

- **Load time:** Slightly slower (7 HTTP requests vs 1)
- **Memory:** Similar (same code, different loading)
- **Execution:** Identical (same initialization flow)
- **Cache:** GitHub raw caching per library

## Success Criteria

- ✅ All libraries under 2MB individually
- ✅ Dev workflow unchanged
- ✅ All tests pass (170/170)
- ✅ Feature registration works
- ✅ Load order correct
- ✅ Release workflow publishes artifacts and pins entrypoint @require URLs
