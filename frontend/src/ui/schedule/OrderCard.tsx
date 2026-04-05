import React from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { Allocation } from "../../types";

type Props = {
  allocation: Allocation;
  isOverlay?: boolean;
};

const URGENCY_DAYS = { high: 3, medium: 7 };

export function OrderCard({ allocation, isOverlay }: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: allocation.id,
    data: { allocation },
    disabled: isOverlay,
  });

  const dueDate = allocation.planned_end_date?.slice(0, 10) ?? "";
  const daysLeft = dueDate
    ? Math.ceil((new Date(dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 999;

  const urgency = daysLeft <= URGENCY_DAYS.high
    ? "high"
    : daysLeft <= URGENCY_DAYS.medium
      ? "medium"
      : "low";

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      className={`orderCard orderCard--${urgency} ${isOverlay ? "orderCard--overlay" : ""}`}
      style={style}
      {...listeners}
      {...attributes}
    >
      <div className="orderCardTop">
        <span className="orderCardId">{allocation.order_id ?? allocation.id.slice(0, 8)}</span>
        <span className={`orderCardUrgency orderCardUrgency--${urgency}`}>
          {daysLeft <= 0 ? "已逾期" : `${daysLeft}天`}
        </span>
      </div>
      <div className="orderCardMeta">
        <span className="orderCardQty">{allocation.allocated_qty}件</span>
        <span className="orderCardDue">{dueDate}</span>
      </div>
    </div>
  );
}
