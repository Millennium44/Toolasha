/**
 * Re-export of the shop-derived valuation, which moved to `utils/alchemy-shop-value.js`
 * so the profit calculator in an earlier bundle can read it too.
 */

export { getAlchemyOutputShopValue, describeShopValue } from '../../utils/alchemy-shop-value.js';
