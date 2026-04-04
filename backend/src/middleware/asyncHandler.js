/**
 * Async Route Handler Wrapper
 *
 * Wraps async route handlers so that rejected promises are
 * forwarded to Express error handling instead of crashing.
 */

export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
