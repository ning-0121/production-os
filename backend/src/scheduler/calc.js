import { differenceInCalendarDays, isValid, parseISO } from "date-fns";

function toDate(d) {
  if (d instanceof Date) return d;
  const parsed = typeof d === "string" ? parseISO(d) : new Date(d);
  return isValid(parsed) ? parsed : new Date();
}

export function pickCapability(factory, productType) {
  return factory.capabilities?.find((c) => c.product_type === productType) ?? null;
}

export function calcProductionMinutes(order, capability) {
  const qty = Number(order.quantity ?? 0);
  const setup = Number(capability?.setup_minutes ?? 0);
  const perUnit = Number(capability?.minutes_per_unit ?? 0);
  const production = Math.max(0, qty * perUnit);
  return {
    setup_minutes: Math.max(0, setup),
    production_minutes: production,
    total_minutes: Math.max(0, setup + production),
  };
}

export function calcLoadSnapshot(factory, horizonDays = 30) {
  const daily = Number(factory.capacity?.daily_capacity_minutes ?? 8 * 60);
  const capacityWindow = Math.max(1, daily * horizonDays);

  const allocated =
    horizonDays <= 7
      ? Number(factory.load?.allocated_minutes_next_7d ?? 0)
      : Number(factory.load?.allocated_minutes_next_30d ?? factory.load?.allocated_minutes_next_7d ?? 0);

  const utilization = factory.load?.utilization_pct != null
    ? Number(factory.load.utilization_pct)
    : Math.max(0, Math.min(100, (allocated / capacityWindow) * 100));

  return {
    allocated_minutes_window: Math.max(0, allocated),
    capacity_minutes_window: capacityWindow,
    utilization_pct: Math.max(0, Math.min(100, utilization)),
  };
}

export function calcDueUrgency(order) {
  const due = toDate(order.due_date);
  const today = new Date();
  const days = differenceInCalendarDays(due, today);
  return { days_until_due: days };
}

