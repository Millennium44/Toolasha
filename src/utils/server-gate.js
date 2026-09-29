/**
 * Staging a change on the test server first.
 *
 * The game ships a patch to its test server before the live one, and Toolasha
 * sometimes has to run the new rule on one and the old rule on the other for a
 * few days. Every earlier patch (the 8/13/2026 marketplace update, the September
 * 2026 market patch) was staged this way and has since reached the live server,
 * so no gate is in use today and nothing calls {@link isTestServer} yet.
 *
 * ## How to stage the next one
 *
 * Gate the call site on `isTestServer()` — new behaviour when it is true, the
 * current behaviour otherwise — and read it at the point of use, not once at
 * module load in a shared constant, so a test can drive both branches by
 * stubbing `location`. When the patch reaches the live server, delete the gate
 * and the old branch together; do not leave a function that always returns true.
 * The vitest setup does not mock this module, so a test that needs the
 * test-server rule stubs `globalThis.location` (or mocks this module itself).
 *
 * The hostname test itself lives in `game-server.js`, which decides where data
 * may be sent; this module re-exports it under the name staging code reaches
 * for rather than repeating the hostname list.
 */

export { isTestServer } from './game-server.js';
