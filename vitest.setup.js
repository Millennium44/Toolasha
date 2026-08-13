/**
 * Global test setup.
 *
 * The 8/13/2026 marketplace patch (5% tax, shrine in gear score) is gated on the
 * server hostname via `isMarketplacePatchLive()` in src/utils/server-gate.js.
 * The suite exercises the post-patch behaviour — that is the forward state and
 * the numbers the tax tests are written against — so force the gate on for every
 * test file here, rather than stubbing the global `location` (which other code
 * reads for `href`/`origin` and would break).
 *
 * Tests that need the pre-patch rule re-mock the module themselves with a
 * toggle (see score-calculator.test.js); server-gate's own test un-mocks it to
 * exercise the real hostname logic.
 */
import { vi } from 'vitest';

vi.mock('./src/utils/server-gate.js', () => ({ isMarketplacePatchLive: () => true }));
