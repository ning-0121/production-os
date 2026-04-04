/**
 * JWT Authentication Middleware
 *
 * Verifies Supabase Auth JWT tokens from the Authorization header.
 * Attaches user info to req.user for downstream use.
 *
 * Public routes (health check, etc.) skip verification.
 */

import { supabaseAdmin } from "../supabase.js";

const PUBLIC_PATHS = ["/health", "/api/health"];

export function authMiddleware(req, res, next) {
  // Skip auth for public routes and OPTIONS (CORS preflight)
  if (req.method === "OPTIONS") return next();
  if (PUBLIC_PATHS.some((p) => req.path === p || req.originalUrl === p)) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "未登录，请先登录系统",
      code: "AUTH_REQUIRED",
    });
  }

  const token = authHeader.slice(7);

  supabaseAdmin.auth
    .getUser(token)
    .then(({ data, error }) => {
      if (error || !data.user) {
        return res.status(401).json({
          error: "登录已过期，请重新登录",
          code: "AUTH_INVALID",
        });
      }

      req.user = {
        id: data.user.id,
        email: data.user.email,
        role: data.user.user_metadata?.role ?? "operator",
        name: data.user.user_metadata?.name ?? data.user.email?.split("@")[0] ?? "anonymous",
      };

      next();
    })
    .catch(() => {
      return res.status(401).json({
        error: "认证服务异常",
        code: "AUTH_ERROR",
      });
    });
}
