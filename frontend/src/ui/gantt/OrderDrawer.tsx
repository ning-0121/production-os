import React from "react";
import { format, parseISO } from "date-fns";
import type { OrderBlock } from "./model";

export function OrderDrawer({
  order,
  factoryName,
  onClose,
}: {
  order: OrderBlock | null;
  factoryName: string;
  onClose: () => void;
}) {
  if (!order) return null;

  const start = parseISO(order.startAt);
  const end = parseISO(order.endAt);

  return (
    <div
      className="drawerOverlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="drawer"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="drawerHeader">
          <div>
            <h3>Order details</h3>
            <div style={{ marginTop: 6 }}>
              <span className="pill">{order.status}</span>
            </div>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="kv">
          <div>Factory</div>
          <div>{factoryName}</div>

          <div>Product</div>
          <div>{order.productType}</div>

          <div>Quantity</div>
          <div>{order.quantity}</div>

          <div>Start</div>
          <div>{format(start, "PPpp")}</div>

          <div>End</div>
          <div>{format(end, "PPpp")}</div>

          <div>Order ID</div>
          <div style={{ color: "var(--muted)" }}>{order.id}</div>
        </div>

        <div style={{ marginTop: 14, color: "var(--muted)", fontSize: 13, lineHeight: 1.45 }}>
          Next step: connect this drawer to Supabase row `production_allocations` and allow editing fields like
          status/priority/assumptions.
        </div>
      </div>
    </div>
  );
}

