/**
 * Global Error Handler Middleware
 *
 * Catches all unhandled errors and returns a consistent JSON response.
 * Must be registered AFTER all routes.
 */

export function errorHandler(err, req, res, _next) {
  const requestId = req.id ?? "unknown";

  // Structured error log
  console.error(JSON.stringify({
    level: "ERROR",
    request_id: requestId,
    method: req.method,
    path: req.originalUrl,
    error: err.message || String(err),
    code: err.code,
    stack: process.env.NODE_ENV !== "production" ? err.stack : undefined,
  }));

  const status = err.status || err.statusCode || 500;

  const response = {
    error: status === 500 ? "服务器内部错误" : err.message,
    code: err.code || "INTERNAL_ERROR",
    request_id: requestId,
  };

  if (process.env.NODE_ENV !== "production" && err.details) {
    response.details = err.details;
  }

  res.status(status).json(response);
}
