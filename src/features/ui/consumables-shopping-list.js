/**
 * Consumables shopping list — moved to `utils/shopping-list.js`.
 *
 * The implementation left this file when the goal planner wanted the same
 * hand-off: the planner is bundled into `actions` and the consumables panel into
 * `ui`, so a copy of this module ended up in each of them, each with its own
 * `tabs` and `watchTimer`, fighting over the one marketplace tab bar. The shared
 * home under `utils/` is externalised in `rollup.config.js`, so both bundles now
 * reach the same instance.
 *
 * This re-export stays so the panel that first asked for the feature does not
 * have to care where it went.
 */

export { openShoppingList, clearShoppingList } from '../../utils/shopping-list.js';
