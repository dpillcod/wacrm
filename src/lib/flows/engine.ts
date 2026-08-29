/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { pickCrossSellSuggestion } from "../ai/cross-sell";
import { notifyStaffOfHandoff } from "../whatsapp/staff-notify";
import { isPriceQuestion } from "./price-question";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  // Only text messages can match an entry trigger. Interactive replies
  // are responses to existing prompts; they never start a new flow.
  if (message.kind !== "text") return null;

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      if (matchesKeywordTrigger(
        message.text,
        flow.trigger_config as KeywordTriggerConfig,
      )) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    // interpolateVars: send_message/collect_input already ran captured
    // vars (and now vars.contact_name) through this — send_buttons never
    // did, so "{{vars.contact_name}}" rendered literally instead of
    // resolving, the one node type in the "suspend and wait" family that
    // skipped it.
    bodyText: interpolateVars(cfg.text, run.vars),
    headerText: cfg.header_text ? interpolateVars(cfg.header_text, run.vars) : cfg.header_text,
    footerText: cfg.footer_text ? interpolateVars(cfg.footer_text, run.vars) : cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    // Same gap as send_buttons (see comment there) — never interpolated.
    bodyText: interpolateVars(cfg.text, run.vars),
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text ? interpolateVars(cfg.header_text, run.vars) : cfg.header_text,
    footerText: cfg.footer_text ? interpolateVars(cfg.footer_text, run.vars) : cfg.footer_text,
    sections: cfg.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: r.title,
        description: r.description,
      })),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  const resolvedNote = cfg.note ? interpolateVars(cfg.note, run.vars) : null;
  await logEvent(db, run.id, "handoff", node.node_key, {
    // Same gap as send_buttons/send_list (see comments there) — a note
    // like "Pedido: {{vars.order_text}}" needs the captured var resolved
    // here, or the agent sees the literal template instead of the order.
    note: resolvedNote,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");

  // Best-effort — nobody watching the inbox otherwise finds out a
  // conversation needs a human until they happen to open WACRM.
  // Never let a notification failure affect the handoff itself. The
  // result is logged to flow_run_events (not just console.error) —
  // a newline-in-parameter bug here once silently failed every real
  // handoff across several live tests before anyone noticed.
  try {
    const contactNameVar = run.vars.contact_name;
    const result = await notifyStaffOfHandoff(db, {
      accountId: run.account_id,
      contactName: typeof contactNameVar === "string" ? contactNameVar.trim() : "",
      summary: resolvedNote ?? "Un cliente necesita atención.",
    });
    if (result.failed.length > 0) {
      await logEvent(db, run.id, "error", node.node_key, {
        reason: "staff_notify_failed",
        failed: result.failed,
        sent: result.sent,
      });
    }
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "staff_notify_threw",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId);
  // The staleness guards on both timers' flush functions would catch
  // this anyway (status is no longer 'active'), but clearing here too
  // stops the Map from holding onto entries for runs that are already
  // done.
  clearPendingDebounce(runId);
  clearPendingIdleNudge(runId);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  // Loaded once per advance call (not per node — the loop below can
  // pass through several auto-advance nodes before actually
  // suspending) so every suspend point below can schedule its idle
  // nudge without a redundant extra fetch each.
  const idleNudgeMinutes = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy,
  ).idle_nudge_minutes;
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      scheduleIdleNudge(db, run.id, node.node_key, idleNudgeMinutes);
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await db
            .from("contact_tags")
            .upsert(
              { contact_id: run.contact_id!, tag_id: cfg.tag_id },
              { onConflict: "contact_id,tag_id" },
            );
        } else {
          await db
            .from("contact_tags")
            .delete()
            .eq("contact_id", run.contact_id!)
            .eq("tag_id", cfg.tag_id);
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      await sendButtonsAndSuspend(db, run, node);
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      scheduleIdleNudge(db, run.id, node.node_key, idleNudgeMinutes);
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      await sendListAndSuspend(db, run, node);
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      scheduleIdleNudge(db, run.id, node.node_key, idleNudgeMinutes);
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }

      // A customer stuck on an abandoned or confusing step can restart
      // on demand by sending a fresh trigger word ("hola", "menu"...)
      // instead of waiting on the 24h cron sweep to free them up —
      // checked BEFORE handing the message to the stuck run, so it
      // takes priority over whatever that run's current node expects.
      const restartFlow = await findEntryFlow(
        db,
        input.accountId,
        input.message,
        input.isFirstInboundMessage,
      );
      if (restartFlow?.entry_node_id) {
        await endRun(db, activeRun.id, "timed_out", "restarted_by_keyword");
        const restartNodes = await loadAllNodes(db, restartFlow.id);
        return startNewRun(db, restartFlow, input, restartNodes);
      }

      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

// ============================================================
// Reply debouncing — see CollectInputNodeConfig.debounce_ms. A
// customer listing several items back-to-back ("1 leche", "1 queso",
// "10 panes" as separate messages) would otherwise get a stacked
// "Anotado ✅ ¿algo más?" bubble after each one; this coalesces them
// into a single reply once they pause.
//
// In-memory only — correct for this single-persistent-container
// deployment (EasyPanel, not serverless: a setTimeout scheduled during
// one request keeps running after the response is sent, for as long
// as the process itself stays up), but NOT durable across a restart.
// Worst case on a restart mid-debounce: the customer's already-
// captured item sits un-acknowledged until their next message
// re-triggers a reply — never lost, just delayed. Keyed by run.id, so
// unrelated conversations never contend.
// ============================================================
const pendingDebounces = new Map<string, ReturnType<typeof setTimeout>>();

function clearPendingDebounce(runId: string): void {
  const existing = pendingDebounces.get(runId);
  if (existing) {
    clearTimeout(existing);
    pendingDebounces.delete(runId);
  }
}

async function flushDebouncedAdvance(
  db: AdminClient,
  runId: string,
  expectedNodeKey: string,
  nextNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<void> {
  pendingDebounces.delete(runId);
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (error || !data) return;
  const freshRun = data as FlowRunRow;
  // Something else already moved this run on while we were waiting —
  // a button tap raced ahead of the debounce window, the cron swept
  // it, etc. The delayed advance is stale; skip it rather than
  // re-entering a node the run has already left (or reviving an ended
  // run).
  if (freshRun.status !== "active" || freshRun.current_node_key !== expectedNodeKey) {
    return;
  }
  if (freshRun.reprompt_count !== 0) {
    await db.from("flow_runs").update({ reprompt_count: 0 }).eq("id", runId);
    freshRun.reprompt_count = 0;
  }
  await advanceFromNodeKey(db, freshRun, nextNodeKey, nodes);
}

function scheduleDebouncedAdvance(
  db: AdminClient,
  runId: string,
  expectedNodeKey: string,
  nextNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
  delayMs: number,
): void {
  clearPendingDebounce(runId);
  const timer = setTimeout(() => {
    flushDebouncedAdvance(db, runId, expectedNodeKey, nextNodeKey, nodes).catch((err) => {
      console.error("[flows] debounced advance failed:", err);
    });
  }, delayMs);
  pendingDebounces.set(runId, timer);
}

// ============================================================
// Idle nudge — see FlowFallbackPolicy.idle_nudge_minutes. A customer
// who goes quiet mid-order otherwise hears nothing again until the
// on_timeout_hours sweep, hours later. Same in-memory-timer model and
// caveats as the debounce above (correct for this single-persistent-
// container deployment; a restart mid-wait just means the nudge
// doesn't fire that once, nothing is lost).
// ============================================================
const pendingIdleNudges = new Map<string, ReturnType<typeof setTimeout>>();

function clearPendingIdleNudge(runId: string): void {
  const existing = pendingIdleNudges.get(runId);
  if (existing) {
    clearTimeout(existing);
    pendingIdleNudges.delete(runId);
  }
}

async function sendIdleNudge(
  db: AdminClient,
  runId: string,
  expectedNodeKey: string,
): Promise<void> {
  pendingIdleNudges.delete(runId);
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (error || !data) return;
  const freshRun = data as FlowRunRow;
  // They already replied (or the run moved/ended some other way) —
  // stale, skip. Mirrors the same staleness guard the debounce flush
  // uses, and for the same reason: this timer was scheduled minutes
  // ago against whatever node was current back then.
  if (freshRun.status !== "active" || freshRun.current_node_key !== expectedNodeKey) {
    return;
  }
  try {
    const { whatsapp_message_id } = await engineSendText({
      accountId: freshRun.account_id,
      userId: freshRun.user_id,
      conversationId: freshRun.conversation_id!,
      contactId: freshRun.contact_id!,
      text: "¿Sigues ahí? Si tienes alguna duda, dime y seguimos con tu pedido 🙂",
    });
    await logEvent(db, runId, "message_sent", expectedNodeKey, {
      reason: "idle_nudge",
      whatsapp_message_id,
    });
  } catch (err) {
    console.error("[flows] idle nudge send failed:", err);
  }
}

function scheduleIdleNudge(
  db: AdminClient,
  runId: string,
  nodeKey: string,
  minutes: number,
): void {
  clearPendingIdleNudge(runId);
  if (!minutes || minutes <= 0) return;
  const timer = setTimeout(() => {
    sendIdleNudge(db, runId, nodeKey).catch((err) => {
      console.error("[flows] idle nudge failed:", err);
    });
  }, minutes * 60_000);
  pendingIdleNudges.set(runId, timer);
}

/**
 * Shared by collect_input's own capture and send_buttons' text_fallback
 * (see SendButtonsNodeConfig.text_fallback) — both need the identical
 * "trim, append-or-overwrite, persist, mirror in-memory, log" sequence,
 * just triggered from a different node type. Returns the next node_key
 * on success, or null if the text was empty/blank (caller falls
 * through to the fallback policy in that case) or the write failed.
 */
async function captureTextIntoVar(
  db: AdminClient,
  run: FlowRunRow,
  fromNodeKey: string,
  args: {
    var_key: string;
    append: boolean | undefined;
    lowercase: boolean | undefined;
    cross_sell: boolean | undefined;
    next_node_key: string;
    text: string;
  },
): Promise<string | null> {
  const trimmed = args.text.trim();
  if (trimmed.length === 0 || !args.var_key) return null;
  // Applied before append, so a multi-line accumulated value stays
  // consistently-cased across every turn rather than only new ones.
  const captured = args.lowercase ? trimmed.toLowerCase() : trimmed;

  const existing = run.vars[args.var_key];
  const newValue =
    args.append && typeof existing === "string" && existing.length > 0
      ? `${existing}\n${captured}`
      : captured;

  // At most one cross-sell aside per run, regardless of how many
  // capturing nodes have it enabled — a customer who mentions pan,
  // then leche, then queso should get ONE nudge, not three.
  let crossSellAside = "";
  if (args.cross_sell && !run.vars.__cross_sell_shown) {
    const suggestion = pickCrossSellSuggestion(trimmed, []);
    if (suggestion) crossSellAside = `\n\n${suggestion}`;
  }

  const newVars = {
    ...run.vars,
    [args.var_key]: newValue,
    // Lets the node's own confirmation text echo back just what was
    // captured THIS turn (e.g. "Anotado: 1 libra de queso ✅") instead
    // of a generic ack that gives no way to notice a dropped item.
    [`${args.var_key}_last`]: captured,
    // Reset every turn (not just when cross_sell is on) so a stale
    // aside from an earlier capture on a different var_key can't leak
    // into this node's confirmation text.
    [`${args.var_key}_cross_sell`]: crossSellAside,
    ...(crossSellAside ? { __cross_sell_shown: true } : {}),
  };
  let capErr = (
    await db
      .from("flow_runs")
      .update({ vars: newVars, reprompt_count: 0 })
      .eq("id", run.id)
  ).error;
  if (capErr) {
    // One immediate retry — a transient write failure here must not
    // silently drop whatever the customer just said. If it fails
    // twice, surface the real reason instead of a bare null so this
    // is diagnosable from logs rather than another mystery drop.
    capErr = (
      await db
        .from("flow_runs")
        .update({ vars: newVars, reprompt_count: 0 })
        .eq("id", run.id)
    ).error;
  }
  if (capErr) {
    console.error("[flows] captureTextIntoVar update failed twice:", {
      run_id: run.id,
      var_key: args.var_key,
      error: capErr,
    });
    return null;
  }

  // Mirror the UPDATE in-memory so downstream interpolation in the
  // advance loop sees the captured var without re-SELECTing the row.
  run.vars = newVars;
  run.reprompt_count = 0;
  await logEvent(db, run.id, "node_entered", fromNodeKey, {
    captured_key: args.var_key,
    captured_length: captured.length,
  });
  return args.next_node_key;
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Any new inbound message supersedes whatever an earlier debounced
  // capture was waiting on — if this message itself schedules a fresh
  // debounce below, that's exactly the "extend the wait" behavior we
  // want; if it's a button tap instead, this prevents the stale timer
  // from re-entering a node the tap has already moved the run past.
  clearPendingDebounce(run.id);
  // They clearly ARE still there — cancel any pending "¿sigues ahí?".
  clearPendingIdleNudge(run.id);

  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // A price/total question ("cuánto es", "cuánto le debo"...) is
  // handled before anything else can claim the message — otherwise it
  // either lands in the running order as if it were another item
  // (collect_input/ask_more) or, worse, "¿cuánto es para transferir?"
  // gets misread as choosing Transferencia at the payment step, since
  // it contains "transf". Answer it and stay put; don't advance.
  if (message.kind === "text") {
    const priceReply =
      currentNode.node_type === "collect_input"
        ? (currentNode.config as unknown as CollectInputNodeConfig).price_question_reply
        : currentNode.node_type === "send_buttons"
          ? (currentNode.config as unknown as SendButtonsNodeConfig).text_fallback
              ?.price_question_reply
          : undefined;
    if (priceReply && isPriceQuestion(message.text)) {
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(priceReply, run.vars),
        });
        await logEvent(db, run.id, "message_sent", currentNode.node_key, {
          reason: "price_question_reply",
        });
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "price_question_reply_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
    }
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  let debounceMs: number | undefined;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input" &&
    ((currentNode.config as unknown as CollectInputNodeConfig).accept !== "image" ||
      (currentNode.config as unknown as CollectInputNodeConfig).optional)
  ) {
    // `accept: "image", optional: true` also lands here for a text
    // reply — live-testing showed a hard block on the transfer receipt
    // stalls the conversation (the customer often hasn't gone and made
    // the bank transfer yet). Whatever they typed is captured as-is
    // instead of silently discarded, and the run advances rather than
    // reprompting for the photo.
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    matched = await captureTextIntoVar(db, run, currentNode.node_key, {
      var_key: cfg.var_key,
      append: cfg.append,
      lowercase: cfg.lowercase,
      cross_sell: cfg.cross_sell,
      next_node_key: cfg.next_node_key,
      text: message.text,
    });
    debounceMs = cfg.debounce_ms;
  } else if (
    message.kind === "image" &&
    currentNode.node_type === "collect_input" &&
    (currentNode.config as unknown as CollectInputNodeConfig).accept === "image"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    matched = await captureTextIntoVar(db, run, currentNode.node_key, {
      var_key: cfg.var_key,
      append: cfg.append,
      lowercase: false,
      cross_sell: false,
      next_node_key: cfg.next_node_key,
      text: message.media_url,
    });
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "send_buttons" &&
    (currentNode.config as unknown as SendButtonsNodeConfig).text_fallback
  ) {
    // Customers reliably keep typing instead of tapping a button —
    // most commonly to list another item after "¿algo más?". Route
    // that text into the configured var/next node (see
    // SendButtonsNodeConfig.text_fallback) instead of letting it fall
    // to the fallback policy's reprompt, which would silently discard
    // whatever they just said.
    const fallbackCfg = (currentNode.config as unknown as SendButtonsNodeConfig)
      .text_fallback!;
    matched = await captureTextIntoVar(db, run, currentNode.node_key, {
      var_key: fallbackCfg.var_key,
      append: fallbackCfg.append,
      lowercase: fallbackCfg.lowercase,
      cross_sell: fallbackCfg.cross_sell,
      next_node_key: fallbackCfg.next_node_key,
      text: message.text,
    });
    debounceMs = fallbackCfg.debounce_ms;
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }

    if (debounceMs && debounceMs > 0) {
      // Capture already landed above — only the reply + advance is
      // deferred, so nothing the customer said is at risk of being
      // lost even if the process restarts before the timer fires.
      scheduleDebouncedAdvance(db, run.id, currentNode.node_key, matched, nodes, debounceMs);
      return { consumed: true, flow_run_id: run.id, outcome: "debounced" };
    }

    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    const textFallbackCfg =
      currentNode.node_type === "send_buttons"
        ? (currentNode.config as unknown as SendButtonsNodeConfig).text_fallback
        : undefined;
    if (message.kind === "text" && textFallbackCfg) {
      // A text_fallback node accepts ANY non-empty text, so landing
      // here means the capture write itself failed (see
      // captureTextIntoVar) — not that the customer said something
      // unparseable. Re-sending the node's own prompt would look
      // identical to the "got it" message on a successful loop and
      // falsely tell the customer their item was recorded. Say so
      // honestly instead and ask them to repeat it.
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: "Perdón, no logré registrar eso último 🙁 ¿Puedes escribirlo de nuevo?",
        });
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (currentNode.node_type === "send_buttons") {
      await sendButtonsAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "send_list") {
      await sendListAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "collect_input") {
      // Customer typed something we couldn't accept (empty after trim,
      // or var_key missing — rare). Re-send the prompt so they try again.
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(db, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Seed `vars.contact_name` up front so any node's `{{vars.contact_name}}`
  // (send_message/send_buttons text, prompt_text, etc.) can greet the
  // customer by name without every flow author needing a collect_input
  // step just to ask for a name we already have on file. Leading space
  // is baked into the value itself (" Juan" vs "") rather than the
  // template, so "¡Hola{{vars.contact_name}}!" reads naturally as
  // either "¡Hola Juan!" or "¡Hola!" without a second no-name template.
  // Best-effort: a lookup failure just means an unpersonalized greeting,
  // never a reason to fail the run.
  let contactName = "";
  try {
    const { data: contactRow } = await db
      .from("contacts")
      .select("name")
      .eq("id", input.contactId)
      .maybeSingle();
    const rawName = (contactRow as { name?: string | null } | null)?.name;
    if (typeof rawName === "string" && rawName.trim().length > 0) {
      contactName = ` ${rawName.trim().split(/\s+/)[0]}`;
    }
  } catch (err) {
    console.error("[flows] contact name lookup failed:", err);
  }

  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
      vars: { contact_name: contactName },
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });

  // A keyword trigger is the customer explicitly typing a command
  // ("menu"/"ayuda"/"inicio") to reclaim self-service — most commonly
  // the "back to menu" escape hatch. If an earlier `handoff` node (e.g.
  // "hablar con alguien") left this conversation assigned to a human
  // and the AI permanently muted, that assignment would otherwise
  // outlive the customer's change of mind: every later free-text
  // message (an actual order) silently gets zero reply forever, since
  // `dispatchInboundToAiReply` bails out the moment `assigned_agent_id`
  // is set — the customer only ever sees this flow's own scripted
  // replies and never realizes the bot's LLM half died hours earlier.
  // Typing the keyword again is an unambiguous signal they want the
  // bot back, so clear the human handoff here rather than leaving it
  // sticky until an agent notices and manually reopens it.
  if (flow.trigger_type === "keyword" && input.conversationId) {
    await db
      .from("conversations")
      .update({
        assigned_agent_id: null,
        ai_autoreply_disabled: false,
        ai_handoff_summary: null,
      })
      .eq("id", input.conversationId);
  }
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
