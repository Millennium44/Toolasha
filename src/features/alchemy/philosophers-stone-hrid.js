/**
 * The Philosopher's Stone item hrid.
 *
 * Standalone rather than exported from `philo-calculator.js`: that module is
 * the profitability calculator, and a notifier that only needs the one
 * constant should not have to pull in everything else that file does. Both
 * import this instead of each re-declaring the same magic string.
 */
export const PHILO_HRID = '/items/philosophers_stone';
