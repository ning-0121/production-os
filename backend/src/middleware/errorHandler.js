/**
 * Global Error Handler Middleware
 *
 * Catches all unhandled errors and returns a consistent JSON response.
 * Must be registered AFTER all routes.
 */

export function errorHandler(err, _req, res, _next) {
  // Log the error for debugging
  console.error("[ERROR]", err.message || err);
  if (err.stack && process.env.NODE_ENV !== "production") {
    console.error(err.stack);
  }

  // Determine status code
  const status = err.status || err.statusCode || 500;

  // Build response
  const response = {
    error: status === 500 ? "服务器内部错误" : err.message,
    code: err.code || "INTERNAL_ERROR",
  };

  // Include details in non-production environments
  if (process.env.NODE_ENV !== "production" && err.details) {
    response.details = err.details;
  }

  res.status(status).json(response);
}
