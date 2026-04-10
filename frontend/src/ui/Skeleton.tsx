import React from "react";

/** Skeleton loading placeholder with shimmer animation */
export function Skeleton({ width, height, radius }: { width?: string | number; height?: string | number; radius?: number }) {
  return (
    <div
      className="skeleton"
      style={{ width: width ?? "100%", height: height ?? 16, borderRadius: radius ?? 6 }}
    />
  );
}

/** Skeleton row: label + value */
export function SkeletonRow() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0" }}>
      <Skeleton width={80} height={14} />
      <Skeleton width={120} height={14} />
    </div>
  );
}

/** Skeleton card for KPI/stats */
export function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <Skeleton width={60} height={12} />
      <Skeleton width={40} height={24} radius={4} />
    </div>
  );
}

/** Full page loading skeleton */
export function PageSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 4 }}>
      <div style={{ display: "flex", gap: 10 }}>
        {[1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
      </div>
      <div className="card" style={{ padding: 16 }}>
        <Skeleton height={14} width={200} />
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)}
        </div>
      </div>
    </div>
  );
}
