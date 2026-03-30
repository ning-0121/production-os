import { differenceInCalendarDays, parseISO, isValid } from "date-fns";

/**
 * @typedef {'SAFE' | 'MEDIUM' | 'HIGH'} RiskLevel
 * @typedef {{ level: RiskLevel, buffer_days: number, message?: string }} RiskResult
 */

/**
 * Risk thresholds:
 *   SAFE   — >= 5 days buffer
 *   MEDIUM — 2..4 days buffer
 *   HIGH   — < 2 days or overdue
 *
 * @param {{ due_date: string | Date }} order
 * @param {{ planned_end_date: string | Date }} allocation
 * @param {{ safe_threshold?: number, medium_threshold?: number }} [opts]
 * @returns {RiskResult}
 */
export function checkRisk(order, allocation, opts = {}) {
  const safeThreshold = Number(opts.safe_threshold ?? 5);
  const mediumThreshold = Number(opts.medium_threshold ?? 2);

  const due = toDate(order.due_date);
  const end = toDate(allocation.planned_end_date);

  const diff = differenceInCalendarDays(due, end);

  if (diff < 0) {
    return { level: "HIGH", buffer_days: diff, message: "已超出交期，需立即处理" };
  }
  if (diff < mediumThreshold) {
    return { level: "HIGH", buffer_days: diff, message: "交期紧迫，缓冲不足2天" };
  }
  if (diff < safeThreshold) {
    return { level: "MEDIUM", buffer_days: diff, message: "交期风险，建议提前沟通客户" };
  }
  return { level: "SAFE", buffer_days: diff };
}

function toDate(d) {
  if (d instanceof Date) return d;
  const parsed = typeof d === "string" ? parseISO(d) : new Date(d);
  return isValid(parsed) ? parsed : new Date();
}
