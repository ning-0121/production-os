/**
 * Supabase Realtime subscription hook.
 *
 * Listens for INSERT/UPDATE/DELETE on a table and calls `onEvent`.
 * Automatically cleans up subscription on unmount.
 */

import { useEffect, useRef } from "react";
import { supabase } from "../services/auth";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";

type ChangeEvent = "INSERT" | "UPDATE" | "DELETE" | "*";

export function useRealtime(
  table: string,
  event: ChangeEvent,
  onEvent: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void,
) {
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    const channel = supabase
      .channel(`realtime-${table}-${event}`)
      .on(
        "postgres_changes" as const,
        { event, schema: "public", table },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          onEvent(payload);
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, event]);
}

/**
 * Convenience: auto-refetch when a table changes.
 */
export function useRealtimeRefetch(table: string, refetch: () => void) {
  useRealtime(table, "*", () => {
    refetch();
  });
}
