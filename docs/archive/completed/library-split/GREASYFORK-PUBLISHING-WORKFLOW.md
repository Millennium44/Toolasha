# Greasyfork Publishing Workflow

## Overview

This document describes the process for publishing and maintaining the library-split version of Toolasha on Greasy Fork using GitHub-hosted libraries.

## Prerequisites

- Greasy Fork account with access to the Toolasha script
- GitHub repository with release workflow enabled
- Production bundles build cleanly (`npm run build`)
- Releases branch is used for published artifacts

## Initial Setup

### 1. Configure Entrypoint Placeholder URLs

`library-headers/entrypoint.txt` contains placeholder library URLs:

```
https://UPDATE-THIS-URL/toolasha-core.user.js
```

The release workflow replaces these with GitHub raw URLs pinned to the releases commit SHA.

### 2. Release Workflow Publishes Artifacts

Release-please builds production bundles and pushes to the `releases` branch:

- `dist/Toolasha.user.js` (entrypoint)
- `dist/libraries/*.user.js` (libraries)

### 3. Greasy Fork Main Script Sync

Greasy Fork syncs the entrypoint from the `releases` branch:

```
https://raw.githubusercontent.com/Celasha/Toolasha/releases/dist/Toolasha.user.js
```

## Release Workflow

### Making Changes

1. **Develop on feature branch**

    ```bash
    git checkout -b feature/my-feature
    # Make changes...
    npm run build:dev # Test dev standalone build
    npm test          # Run tests
    git commit -m "feat: add feature"
    git push origin feature/my-feature
    ```

2. **Create PR and merge to main**
    - All tests must pass
    - Pre-commit hooks validate code
    - Merge to main branch

3. **Build production bundles**

    ```bash
    git checkout main
    git pull origin main
    npm run build
    ```

4. **Commit production builds**

    ```bash
    git add dist/
    git commit -m "build: production release v0.X.Y"
    git tag v0.X.Y
    git push origin main --tags
    ```

5. **Sync updates on Greasy Fork**
    - Greasy Fork syncs the entrypoint from GitHub
    - Entrypoint @require URLs are pinned to the release commit SHA
    - Libraries are fetched from GitHub raw URLs

### Version Pinning Strategy

Entrypoint @require URLs are pinned to the release commit SHA on the `releases` branch, making library loading immutable per release.

## Breaking Changes

### What Counts as Breaking

- Removing public API functions from global namespace
- Changing initialization order requirements
- Renaming library exports
- Removing feature modules
- Changing feature keys in registry

### Breaking Change Process

1. **Major version bump** (0.14.x → 0.15.0)
2. **Document migration** in CHANGELOG.md
3. **Announce in Greasyfork description**
4. **Consider deprecation period** (old + new API coexist)

### Non-Breaking Changes

- Adding new features
- Fixing bugs
- Performance improvements
- Internal refactoring
- Adding optional parameters

## Optimization Checklist

Before publishing, ensure all libraries are under 2MB:

### Core Library

Core is under the 2MB limit. CI enforces per-bundle size checks.

1. **Remove source comments**
    - Strip JSDoc in production build
    - Saves ~5-10%

### Size Verification

```bash
npm run build
for file in dist/libraries/*.user.js; do
    size=$(wc -c < "$file")
    limit=2097152
    if [ $size -gt $limit ]; then
        echo "❌ $file is over 2MB limit ($size bytes)"
    else
        echo "✅ $file is under limit ($size bytes)"
    fi
done
```

## Testing Checklist

### Local Testing

- [ ] Dev build works: `npm run build:dev && npm test`
- [ ] Prod build succeeds: `npm run build`
- [ ] All libraries under 2MB
- [ ] No console errors in browser
- [ ] Core features work (market, actions, combat)

### Tampermonkey Testing

- [ ] Install the entrypoint script only
- [ ] Verify load order (Core → Utils → Features → Entrypoint) via @require
- [ ] Test each feature category:
    - [ ] Market prices and tooltips
    - [ ] Action panel enhancements
    - [ ] Combat tracker and stats
    - [ ] UI enhancements
    - [ ] Settings panel
- [ ] Test character switching
- [ ] Test feature toggles via settings
- [ ] Check for memory leaks (long session)

### Greasyfork Testing

- [ ] All libraries sync from GitHub
- [ ] Entrypoint loads all dependencies
- [ ] Script updates automatically
- [ ] No errors in Greasyfork console
- [ ] Users can install and use normally

## Rollback Plan

If issues arise after publishing:

### Quick Rollback

1. **Revert to single-bundle version**

    ```bash
    # Update main script to sync from pre-split commit
    https://raw.githubusercontent.com/Celasha/Toolasha/COMMIT_HASH/dist/Toolasha.user.js
    ```

2. **Disable broken libraries**
    - Comment out `@require` in entrypoint header
    - Temporarily remove from sync

3. **Fix and re-publish**
    - Fix issues on feature branch
    - Test thoroughly
    - Re-sync libraries

### Full Rollback

1. Revert Greasyfork main script to last working single-bundle version
2. Remove library entries (or mark as deprecated)
3. Communicate rollback to users
4. Fix issues before attempting library split again

## Monitoring

### Health Checks

- **Greasyfork sync status:** Check daily for sync failures
- **User reports:** Monitor Greasyfork feedback section
- **Error logs:** Check browser console for common errors
- **Size trends:** Monitor library sizes on each release

### Metrics to Track

- Install count (main script)
- Update success rate
- Error rates by library
- Load time performance
- User feedback sentiment

## Support

### User Issues

**"Script doesn't load"**

- Verify entrypoint is installed
- Check @require URLs are correct
- Check console for missing dependency errors

**"Features missing after update"**

- Force update all libraries
- Clear Tampermonkey cache
- Reinstall the entrypoint script

**"Too many scripts to install"**

- Users install only the entrypoint (libraries auto-load)

### Developer Issues

**"Build fails with dependency errors"**

- Check rollup config
- Verify library entry points exist
- Run `npm install` to update dependencies

**"Library over 2MB after changes"**

- Run size optimization checklist
- Consider splitting further
- Use minification in production

## Future Improvements

### Potential Optimizations

1. **Dynamic imports**: Load features on-demand
2. **Tree shaking**: Remove unused code paths
3. **Shared chunks**: Extract common dependencies
4. **CDN hosting**: Host stable libraries externally
5. **Compression**: Use gzip/brotli in transit

### Long-term Goals

1. Reduce total bundle size below 3MB
2. Improve load time with parallel downloads
3. Better error handling for missing libraries
4. Automatic fallback to single-bundle mode
5. User-configurable feature loading

## Appendix

### Useful Commands

```bash
# Development
npm run build:dev      # Dev standalone
npm run build          # Multi-bundle (prod)
npm test              # Run tests
npm run lint          # Check code quality

# Size analysis
ls -lh dist/libraries/*.user.js
du -sh dist/
for file in dist/libraries/*.user.js; do
    wc -c "$file" | awk '{printf "%s: %d bytes (%.2f%% of 2MB)\n", "'$file'", $1, ($1/2097152)*100}'
done

# Git workflow
git checkout main
git pull origin main
npm run build
git add dist/
git commit -m "build: production release v0.X.Y"
git tag v0.X.Y
git push origin main --tags
```

### External Resources

- [Greasyfork library documentation](https://greasyfork.org/help/writing-user-scripts)
- [Rollup documentation](https://rollupjs.org/)
- [Tampermonkey API](https://www.tampermonkey.net/documentation.php)
- [Toolasha repository](https://github.com/Celasha/Toolasha)
