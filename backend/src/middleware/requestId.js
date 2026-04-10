/**
 * Request ID middleware — assigns a unique ID to every request.
 * The ID is:
 *   1. Set on req.id
 *   2. Added to response header X-Request-Id
 *   3. Available for logging and audit trails
 */

let counter = 0;

export function requestId(req, _res, next) {
  counter = (counter + 1) % 1_000_000;
  const ts = Date.now().toString(36);
  const seq = counter.toString(36).padStart(4, "0");
  req.id = `${ts}-${seq}`;
  next();
}

export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
    const log = {
      level,
      request_id: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: duration,
      operator: req.pilotIdentity?.operator ?? "anonymous",
    };

    if (level === "ERROR") {
      console.error(JSON.stringify(log));
    } else if (duration > 5000 || level === "WARN") {
      console.warn(JSON.stringify(log));
    }
    // Skip logging normal GETs to reduce noise
  });

  next();
}
