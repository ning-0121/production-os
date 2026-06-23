/**
 * Isolated, self-cleaning test fixtures for the V7.5 validation + benchmark
 * scripts. Everything created carries the V75_MARK so it is unmistakably test
 * data and can be torn down completely.
 *
 * Design: each run creates a DEDICATED test factory + line and attaches all
 * downstream test rows to them. Teardown deletes the factory (cascades
 * production_lines / daily_production_reports / etc.) and then explicitly
 * removes the soft-FK rows the cascade doesn't reach (runtime, tasks,
 * decisions, shopfloor, notifications).
 *
 * Safe against a production DB: it never touches non-test rows.
 */

export const V75_MARK = "v75test";
export const V75_ACTOR = "v75-validate";

const code = (s) => `${V75_MARK}-${s}`;

/** Create a fresh, clearly-marked test factory + line. Returns their ids. */
export async function createTestFactoryAndLine(db, suffix = "") {
  const factoryCode = code(`factory${suffix}`);
  // Idempotent: reuse if a prior crashed run left one behind.
  let { data: existing } = await db.from("factories").select("id").eq("code", factoryCode).maybeSingle();
  let factoryId = existing?.id;
  if (!factoryId) {
    const { data, error } = await db.from("factories")
      .insert({ code: factoryCode, name: `V7.5 Test Factory ${suffix}`.trim(), status: "active" })
      .select("id").single();
    if (error) throw new Error(`create test factory: ${error.message}`);
    factoryId = data.id;
  }

  const lineName = code(`line${suffix}`);
  let { data: line } = await db.from("production_lines").select("id").eq("factory_id", factoryId).eq("name", lineName).maybeSingle();
  let lineId = line?.id;
  if (!lineId) {
    const { data, error } = await db.from("production_lines")
      .insert({ factory_id: factoryId, name: lineName, status: "active" })
      .select("id").single();
    if (error) throw new Error(`create test line: ${error.message}`);
    lineId = data.id;
  }
  return { factoryId, lineId };
}

/**
 * Full teardown of every V7.5 test artifact. Best-effort: each delete is
 * independent so one failure doesn't strand the rest. Returns counts removed.
 */
export async function teardownTestData(db) {
  const removed = {};
  const del = async (label, fn) => {
    try { await fn(); removed[label] = "ok"; }
    catch (err) { removed[label] = `skip: ${err.message ?? err}`; }
  };

  // 1) Soft-FK rows first (no cascade from factory).
  // Decision tasks created by our flows → cascades task_events + notification_events.
  await del("decision_tasks", () => db.from("decision_tasks").delete().or(
    `source_ref.like.%${V75_MARK}%,subject_id.like.%${V75_MARK}%,created_by.eq.${V75_ACTOR}`,
  ));
  // Decision assessments by our test subjects → cascades decision_logs + feedback.
  await del("decision_assessments", () => db.from("decision_assessments").delete().like("subject_id", `%${V75_MARK}%`));
  // Shopfloor work orders (created_by marker) → cascades reports + events.
  await del("shopfloor_work_orders", () => db.from("shopfloor_work_orders").delete().eq("created_by", V75_ACTOR));
  // Runtime events tied to our test factory.
  await del("runtime_events", () => db.from("runtime_events").delete().like("source_ref", `%${V75_MARK}%`));

  // 2) Factory subtree last — cascade removes lines, daily reports, runtime lines bound by FK.
  //    (production_runtime_lines.factory_id is a soft FK, so clear it explicitly first.)
  const { data: factories } = await db.from("factories").select("id").like("code", `${V75_MARK}-%`);
  const factoryIds = (factories ?? []).map((f) => f.id);
  if (factoryIds.length) {
    await del("production_runtime_lines", () => db.from("production_runtime_lines").delete().in("factory_id", factoryIds));
    await del("runtime_events_byfactory", () => db.from("runtime_events").delete().in("factory_id", factoryIds));
    await del("factories", () => db.from("factories").delete().in("id", factoryIds));
  }

  return removed;
}
