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
  engineSendCtaUrl,
  engineSendTemplate,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { pickCrossSellSuggestion } from "../ai/cross-sell";
import {
  retrieveCatalogProducts,
  type CatalogProductCandidate,
} from "../ai/catalog";
import { notifyStaffOfHandoff } from "../whatsapp/staff-notify";
import { INTERACTIVE_LIMITS } from "../whatsapp/meta-api";
import { isPriceQuestion } from "./price-question";
import { isGeneralQuestion } from "./general-question";
import {
  applyClarificationAnswer,
  editOrderList,
  findDuplicateQuestion,
  replaceTrailingLines,
  reviewOrderLines,
} from "./order-clarify";
import {
  ALCOHOL_REPLY,
  isAlcoholRequest,
  isWithinBusinessHours,
  normalizeForMatch,
  outOfHoursNotice,
} from "./store-policy";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type HandoffNodeConfig,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendCtaUrlNodeConfig,
  type SendTemplateNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
  type TextFallbackConfig,
} from "./types";

// ============================================================
// Engine-authored customer texts (everything else a customer sees
// comes from the flow's own node config). The store addresses
// customers as "usted".
// ============================================================

const IDLE_NUDGE_TEXT =
  "¿Sigue ahí? Si tiene alguna duda, dígame y seguimos con su pedido 🙂";
const DISAMBIGUATION_PROMPT = "¿Cuál de estas opciones es la que busca?";
const CAPTURE_FAILED_TEXT =
  "Disculpe, no logré registrar eso último 🙁 ¿Me lo puede escribir de nuevo?";
const FALLBACK_HANDOFF_TEXT =
  "Disculpe, no logré entenderle bien 🙏 Le comunico con uno de nuestros asesores para que le ayude.";
const EDIT_FAILED_TEXT =
  "Disculpe, no logré aplicar ese cambio 🙏 Escríbame el *número* del producto que desea cambiar.";
const editLinePrompt = (n: number, line: string) =>
  `Escriba cómo debe quedar el *${n}* (_${line}_), o escriba *borrar* para quitarlo.`;
const editOutOfRangeText = (max: number) =>
  `Ese número no está en su lista 🙂 Escriba un número del 1 al ${max}.`;
const NON_TEXT_REPLY_TEXT =
  "Por ahora no puedo escuchar audios ni ver ese tipo de mensajes 🙏 ¿Me lo puede escribir, por favor?";

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

/** The node's free-text capture, if it has one (see TextFallbackConfig). */
export function textFallbackOf(node: {
  node_type: string;
  config: Record<string, unknown>;
}): TextFallbackConfig | undefined {
  if (node.node_type === "send_buttons" || node.node_type === "send_list") {
    return (node.config as { text_fallback?: TextFallbackConfig }).text_fallback;
  }
  return undefined;
}

/** "1", "2.", "3)" or "4️⃣" → zero-based index; null for any other text. */
export function parseOptionNumber(text: string): number | null {
  // Keycap emoji ("1️⃣") count too — some customers copy them from the menu.
  const plain = text.replace(/\uFE0F?\u20E3/g, "");
  const m = plain.trim().match(/^(\d{1,2})\s*[.)-]?$/);
  return m ? Number(m[1]) - 1 : null;
}

/**
 * "1", "2." or "3)" typed at a buttons/list node picks that option, in
 * display order — customers used to numbered WhatsApp menus reply that
 * way instead of tapping, and without this a bare "1" was captured as
 * if it were an order line. Returns null for anything else.
 */
export function optionByNumber(
  node: { node_type: string; config: Record<string, unknown> },
  text: string,
): { reply_id: string; title: string } | null {
  const index = parseOptionNumber(text);
  if (index === null) return null;
  let options: Array<{ reply_id: string; title: string }> = [];
  if (node.node_type === "send_buttons") {
    options = (node.config as unknown as SendButtonsNodeConfig).buttons ?? [];
  } else if (node.node_type === "send_list") {
    options = ((node.config as unknown as SendListNodeConfig).sections ?? []).flatMap(
      (section) => section.rows ?? [],
    );
  }
  const hit = options[index];
  return hit ? { reply_id: hit.reply_id, title: hit.title } : null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 *
 * "contains" matches whole words/phrases only (accent-insensitive
 * unless case_sensitive): a plain substring test made "2 cholas" match
 * "hola" and "menudencia" match "menu", which restarted a customer's
 * flow and wiped their order mid-conversation.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  if (cfg.case_sensitive) {
    for (const needle of cfg.keywords) {
      if (!needle) continue;
      if (matchType === "exact" ? text === needle : text.includes(needle)) {
        return true;
      }
    }
    return false;
  }
  const haystack = normalizeForMatch(text);
  const paddedHaystack = ` ${haystack} `;
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = normalizeForMatch(raw);
    if (!needle) continue;
    if (
      matchType === "exact"
        ? haystack === needle
        : paddedHaystack.includes(` ${needle} `)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Stricter than `matchesKeywordTrigger`, used only while the contact
 * already has an ACTIVE run: restarting throws away that run's state
 * (the order captured so far), so only a short message that is
 * essentially the command itself ("hola", "menú", "buenas tardes")
 * counts. "Hola, también quiero 2 panes" mid-order is an order line,
 * not a request to start over.
 */
export const RESTART_MAX_WORDS = 3;

export function isRestartCommand(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!matchesKeywordTrigger(text, cfg)) return false;
  const words = normalizeForMatch(text).split(" ").filter(Boolean);
  return words.length <= RESTART_MAX_WORDS;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "send_cta_url" ||
    node_type === "send_template" ||
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
  /** True when checking whether to abandon an active run — see
   *  `isRestartCommand` for why that needs a stricter match. */
  restartOnly = false,
): Promise<FlowRow | null> {
  // Only text messages can match an entry trigger. Interactive replies
  // are responses to existing prompts; they never start a new flow.
  if (message.kind !== "text") return null;
  const matchKeyword = restartOnly ? isRestartCommand : matchesKeywordTrigger;

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
      if (matchKeyword(
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

/**
 * Non-text inbounds worth answering even with no active run: a catalog
 * cart, or a voice note / video (which otherwise gets no reply at all —
 * the AI auto-reply only handles text).
 */
export function isBotAddressableNonText(message: ParsedInbound): boolean {
  return (
    message.kind === "order" ||
    (message.kind === "other" &&
      (message.message_type === "audio" || message.message_type === "video"))
  );
}

/**
 * The account's "main menu" flow for inbounds that can't match a
 * keyword (see isBotAddressableNonText): the oldest active flow with an
 * inbound-driven trigger, same ordering findEntryFlow uses.
 */
async function findDefaultEntryFlow(
  db: AdminClient,
  accountId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .in("trigger_type", ["keyword", "first_inbound_message"])
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) return null;
  return ((data as FlowRow[] | null) ?? [])[0] ?? null;
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
  const { whatsapp_message_id } = cfg.send_as_text
    ? // A plain numbered menu (the customer replies with a number — see
      // optionByNumber). `text` must already list the options in row
      // order; a plain text also keeps any link in it tappable.
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        text: interpolateVars(cfg.text, run.vars),
      })
    : await engineSendInteractiveList({
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
  const cfg = node.config as unknown as HandoffNodeConfig;
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
  await notifyHandoff(db, run, node.node_key, {
    summary: resolvedNote ?? "Un cliente necesita atención.",
    assignTo: cfg.assign_to,
    notifyUserIds: cfg.notify_user_ids,
  });
}

/**
 * Everything that should happen around ANY handoff, whether a
 * `handoff` node reached it or the fallback policy gave up: tell the
 * customer when nobody can answer until the next opening, alert staff
 * by WhatsApp template, and add in-app notifications for extra
 * teammates. All best-effort — a failure here never undoes the
 * handoff itself.
 */
async function notifyHandoff(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string | null,
  args: {
    summary: string;
    assignTo?: string | null;
    notifyUserIds?: string[];
  },
): Promise<void> {
  if (!isWithinBusinessHours()) {
    await sendEngineText(db, run, nodeKey, outOfHoursNotice(), "out_of_hours_notice");
  }

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
      summary: args.summary,
    });
    if (result.failed.length > 0) {
      await logEvent(db, run.id, "error", nodeKey, {
        reason: "staff_notify_failed",
        failed: result.failed,
        sent: result.sent,
      });
    }
  } catch (err) {
    await logEvent(db, run.id, "error", nodeKey, {
      reason: "staff_notify_threw",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Extra in-app recipients beyond the single conversation owner — a
  // real sale shouldn't hinge on exactly one person seeing exactly one
  // notification. `assign_to` already gets its own row for free via
  // the `on_conversation_assigned` DB trigger (migration 027), so it's
  // excluded here to avoid double-notifying that same person.
  const extraRecipients = (args.notifyUserIds ?? []).filter(
    (id) => id && id !== args.assignTo,
  );
  if (extraRecipients.length > 0) {
    try {
      const contactNameVar = run.vars.contact_name;
      const contactName =
        typeof contactNameVar === "string" && contactNameVar.trim()
          ? contactNameVar.trim()
          : "un contacto";
      const { error: notifyErr } = await db.from("notifications").insert(
        extraRecipients.map((userId) => ({
          account_id: run.account_id,
          user_id: userId,
          type: "conversation_assigned",
          conversation_id: run.conversation_id,
          contact_id: run.contact_id,
          title: "Nueva conversación asignada",
          body: `Ferrobot le asignó una conversación con ${contactName}`,
        })),
      );
      if (notifyErr) {
        await logEvent(db, run.id, "error", nodeKey, {
          reason: "extra_notify_failed",
          detail: notifyErr.message,
        });
      }
    } catch (err) {
      await logEvent(db, run.id, "error", nodeKey, {
        reason: "extra_notify_threw",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
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

/** Send an engine-authored text (not a node's own) and log it; a send
 *  failure is logged, never thrown — these are courtesy replies. */
async function sendEngineText(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string | null,
  text: string,
  reason: string,
): Promise<void> {
  try {
    const { whatsapp_message_id } = await engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text,
    });
    await logEvent(db, run.id, "message_sent", nodeKey, {
      reason,
      whatsapp_message_id,
    });
  } catch (err) {
    await logEvent(db, run.id, "error", nodeKey, {
      reason: `${reason}_failed`,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * `{{vars.foo}}` interpolation for a URL: each value is URL-encoded, so
 * a cta_url can carry captured data — e.g. a wa.me link whose `?text=`
 * pre-fills the customer's whole order list into a chat with the call
 * center. Values are capped so a very long order can't push the link
 * past what WhatsApp will open.
 */
const URL_VAR_MAX_CHARS = 900;

function interpolateVarsForUrl(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    if (v === undefined || v === null) return "";
    const text = String(v);
    const capped =
      text.length > URL_VAR_MAX_CHARS ? `${text.slice(0, URL_VAR_MAX_CHARS)}…` : text;
    return encodeURIComponent(capped);
  });
}

/** "a\nb" → "1. a\n2. b" — for echoing an accumulated list back. */
export function numberLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => `${i + 1}. ${line}`)
    .join("\n");
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
  // This advance is the reply that closes any open capture batch (see
  // captureTextIntoVar). Clear the marker up front — the `_last` value
  // it accumulated stays in vars for this advance's interpolation —
  // so the customer's next message starts a fresh batch.
  if (run.vars.__capture_batch_var !== undefined) {
    const closedVars: Record<string, unknown> = { ...run.vars };
    delete closedVars.__capture_batch_var;
    delete closedVars.__capture_batch_lines;
    const { error } = await db
      .from("flow_runs")
      .update({ vars: closedVars })
      .eq("id", run.id);
    if (!error) run.vars = closedVars;
  }
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
    if (node.node_type === "send_cta_url") {
      const cfg = node.config as unknown as SendCtaUrlNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendCtaUrl({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          bodyText: interpolateVars(cfg.text, run.vars),
          headerText: cfg.header_text
            ? interpolateVars(cfg.header_text, run.vars)
            : cfg.header_text,
          footerText: cfg.footer_text
            ? interpolateVars(cfg.footer_text, run.vars)
            : cfg.footer_text,
          buttonText: cfg.button_text,
          url: interpolateVarsForUrl(cfg.url, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_cta_url",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_cta_url_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_cta_url_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_template") {
      const cfg = node.config as unknown as SendTemplateNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendTemplate({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          templateName: cfg.template_name,
          language: cfg.template_language,
          params: cfg.params?.map((p) => interpolateVars(p, run.vars)),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_template",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_template_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_template_failed");
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
        true,
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

    // No active run. Non-text messages never match a keyword trigger,
    // but two of them still deserve the bot's attention — only while
    // the bot owns the conversation (open and unassigned): once a human
    // has it, they can listen to the audio / read the cart themselves.
    if (isBotAddressableNonText(input.message)) {
      const { data: conv } = await db
        .from("conversations")
        .select("status, assigned_agent_id")
        .eq("id", input.conversationId)
        .maybeSingle();
      const c = conv as { status: string; assigned_agent_id: string | null } | null;
      const botOwnsConversation = !!c && c.status === "open" && !c.assigned_agent_id;
      if (botOwnsConversation) {
        const defaultFlow = await findDefaultEntryFlow(db, input.accountId);
        if (defaultFlow?.entry_node_id) {
          if (input.message.kind === "order") {
            // A cart sent straight from the catalog: start the bot as
            // if the customer had typed their order at the greeting.
            const nodes = await loadAllNodes(db, defaultFlow.id);
            return startNewRun(db, defaultFlow, input, nodes);
          }
          // A voice note / video as the first message: ask for text.
          try {
            await engineSendText({
              accountId: input.accountId,
              userId: input.userId,
              conversationId: input.conversationId,
              contactId: input.contactId,
              text: NON_TEXT_REPLY_TEXT,
            });
            return { consumed: true, outcome: "no_match" };
          } catch (err) {
            console.error("[flows] non-text reply failed:", err);
          }
        }
      }
      return { consumed: false, outcome: "no_match" };
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
  const node = nodes.get(expectedNodeKey);
  if (node && (await clarifyCapturedBatch(db, freshRun, node))) return;
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
// AI clarification of captured order lines — see
// CollectInputNodeConfig.ai_clarify and flows/order-clarify.ts.
// ============================================================

/** Stashed in `vars.__pending_clarification` while the customer is
 *  answering the one question asked about their last batch of lines. */
interface PendingClarification {
  var_key: string;
  next_node_key: string;
  /** The batch as reviewed — the trailing lines of the order var. */
  lines: string[];
  question: string;
}

/** The node's text-capture config: collect_input's own, or a text_fallback. */
function captureConfigOf(
  node: FlowNodeRow,
): (DisambiguationConfig & { ai_clarify?: boolean }) | undefined {
  if (node.node_type === "collect_input") {
    return node.config as unknown as CollectInputNodeConfig;
  }
  return textFallbackOf(node);
}

/** Rewrite the order var's trailing `count` lines and its derived vars. */
function withReplacedLines(
  vars: Record<string, unknown>,
  varKey: string,
  count: number,
  lines: string[],
): Record<string, unknown> {
  const current = typeof vars[varKey] === "string" ? (vars[varKey] as string) : "";
  const updated = replaceTrailingLines(current, count, lines);
  return {
    ...vars,
    [varKey]: updated,
    [`${varKey}_numbered`]: numberLines(updated),
    [`${varKey}_last`]: lines.join(", "),
  };
}

/**
 * Run the just-captured batch past the AI before it's confirmed. Tidies
 * the lines in place; if one is too vague, sends ONE question and
 * returns true — the caller must then stay on this node instead of
 * advancing (the answer is handled in handleReplyForActiveRun). Returns
 * false (advance as usual) when clarification is off, there's nothing
 * to review, or the AI is unavailable.
 */
async function clarifyCapturedBatch(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<boolean> {
  const cfg = captureConfigOf(node);
  const lines = run.vars.__capture_batch_lines;
  if (
    !cfg?.ai_clarify ||
    !cfg.append ||
    run.vars.__capture_batch_var !== cfg.var_key ||
    !Array.isArray(lines) ||
    lines.length === 0
  ) {
    return false;
  }
  const review = await reviewOrderLines(db, run.account_id, run.conversation_id, lines as string[]);
  if (!review) return false;

  let vars = withReplacedLines(run.vars, cfg.var_key, lines.length, review.lines);
  if (review.question) {
    const pending: PendingClarification = {
      var_key: cfg.var_key,
      next_node_key: cfg.next_node_key,
      lines: review.lines,
      question: review.question,
    };
    vars = { ...vars, __pending_clarification: pending };
    // The batch is now owned by the pending question.
    delete vars.__capture_batch_var;
    delete vars.__capture_batch_lines;
  }
  const { error } = await db.from("flow_runs").update({ vars }).eq("id", run.id);
  if (error) return false;
  run.vars = vars;

  if (!review.question) return false;
  await sendEngineText(db, run, node.node_key, review.question, "ai_clarify_question");
  return true;
}

// ============================================================
// List corrections (edit_list_var) and the duplicate check
// (check_duplicates_var) — both edit a newline-joined list var.
// ============================================================

/** Waiting for the new text of one line ("¿cómo debe quedar el 3?"). */
interface PendingLineEdit {
  list_var: string;
  index: number;
  next_node_key: string;
}

/** Waiting for the answer to a duplicate-product question. */
interface PendingListAnswer {
  list_var: string;
  lines: string[];
  question: string;
  /** Where to go once answered — the node that shows the list again. */
  return_node_key: string;
}

function listLines(vars: Record<string, unknown>, listVar: string): string[] {
  const raw = vars[listVar];
  return typeof raw === "string" ? raw.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/** Persist a rewritten list (and its derived vars), then move on. */
async function saveListAndAdvance(
  db: AdminClient,
  run: FlowRunRow,
  nodes: Map<string, FlowNodeRow>,
  vars: Record<string, unknown>,
  listVar: string,
  lines: string[],
  nextNodeKey: string,
  extra: Record<string, unknown> = {},
): Promise<DispatchInboundResult> {
  const list = lines.join("\n");
  const updated = {
    ...vars,
    ...extra,
    [listVar]: list,
    [`${listVar}_numbered`]: numberLines(list),
  };
  await db.from("flow_runs").update({ vars: updated, reprompt_count: 0 }).eq("id", run.id);
  run.vars = updated;
  run.reprompt_count = 0;
  const outcome = await advanceFromNodeKey(db, run, nextNodeKey, nodes);
  return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
}

async function saveVars(
  db: AdminClient,
  run: FlowRunRow,
  vars: Record<string, unknown>,
): Promise<void> {
  await db.from("flow_runs").update({ vars }).eq("id", run.id);
  run.vars = vars;
}

/**
 * Handles a reply that belongs to list editing: a pending by-number
 * edit, a pending duplicate question, or a correction typed at a node
 * with `edit_list_var`. Returns null when the message isn't about list
 * editing (the caller continues as usual). A non-text reply simply
 * drops any pending edit state.
 */
async function handleListEditing(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult | null> {
  const stay: DispatchInboundResult = { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  const lineEdit = run.vars.__pending_line_edit as PendingLineEdit | undefined;
  const listAnswer = run.vars.__pending_list_answer as PendingListAnswer | undefined;
  const rest: Record<string, unknown> = { ...run.vars };
  delete rest.__pending_line_edit;
  delete rest.__pending_list_answer;

  if (message.kind !== "text" || !message.text.trim()) {
    if (lineEdit || listAnswer) await saveVars(db, run, rest);
    return null;
  }
  const text = message.text.trim();

  if (lineEdit) {
    const lines = listLines(rest, lineEdit.list_var);
    if (lineEdit.index < lines.length) {
      if (/^(borrar|quitar|eliminar|sacar)\b/i.test(text)) {
        lines.splice(lineEdit.index, 1);
      } else {
        lines[lineEdit.index] = text;
      }
    }
    return saveListAndAdvance(db, run, nodes, rest, lineEdit.list_var, lines, lineEdit.next_node_key);
  }

  if (listAnswer) {
    const edited = await editOrderList(db, run.account_id, run.conversation_id, {
      lines: listAnswer.lines,
      instruction: `Se le preguntó: "${listAnswer.question}". El cliente respondió: "${text}".`,
    });
    const lines = edited ?? listAnswer.lines;
    // Mark this version of the list as checked so confirming it again
    // moves on instead of asking about duplicates a second time.
    return saveListAndAdvance(db, run, nodes, rest, listAnswer.list_var, lines, listAnswer.return_node_key, {
      __dups_checked_for: lines.join("\n"),
    });
  }

  const cfg = captureConfigOf(node) as { edit_list_var?: string; next_node_key: string } | undefined;
  if (!cfg?.edit_list_var) return null;
  const lines = listLines(run.vars, cfg.edit_list_var);

  // A bare number → edit that line in a second step.
  const index = parseOptionNumber(text);
  if (index !== null) {
    if (index < 0 || index >= lines.length) {
      await sendEngineText(db, run, node.node_key, editOutOfRangeText(lines.length), "list_edit_out_of_range");
      return stay;
    }
    const pending: PendingLineEdit = {
      list_var: cfg.edit_list_var,
      index,
      next_node_key: cfg.next_node_key,
    };
    await saveVars(db, run, { ...run.vars, __pending_line_edit: pending });
    await sendEngineText(db, run, node.node_key, editLinePrompt(index + 1, lines[index]), "list_edit_line");
    return stay;
  }

  const edited = await editOrderList(db, run.account_id, run.conversation_id, {
    lines,
    instruction: text,
  });
  if (!edited) {
    await sendEngineText(db, run, node.node_key, EDIT_FAILED_TEXT, "list_edit_failed");
    return stay;
  }
  return saveListAndAdvance(db, run, nodes, run.vars, cfg.edit_list_var, edited, cfg.next_node_key);
}

/**
 * The duplicate check behind a button's `check_duplicates_var`. Returns
 * true when a question was sent (the caller stays on this node). Each
 * version of the list is checked once, so a customer who confirms the
 * same list again moves on.
 */
async function askAboutDuplicates(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  listVar: string,
): Promise<boolean> {
  const lines = listLines(run.vars, listVar);
  const list = lines.join("\n");
  if (run.vars.__dups_checked_for === list) return false;
  const question = await findDuplicateQuestion(db, run.account_id, run.conversation_id, lines);
  const vars: Record<string, unknown> = { ...run.vars, __dups_checked_for: list };
  if (question) {
    const pending: PendingListAnswer = {
      list_var: listVar,
      lines,
      question,
      return_node_key: node.node_key,
    };
    vars.__pending_list_answer = pending;
  }
  await saveVars(db, run, vars);
  if (!question) return false;
  await sendEngineText(db, run, node.node_key, question, "duplicate_question");
  return true;
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
      text: IDLE_NUDGE_TEXT,
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
 * Stashed in `flow_runs.vars.__pending_disambiguation` while a
 * `collect_input` node with `disambiguate_products: true` is waiting
 * on the customer to pick one of several catalog matches from an
 * interactive list. `candidates` maps each row's `reply_id`
 * (the product's `retailerId`) back to its display name so the tap
 * can be turned into the text that would otherwise have been typed.
 */
interface PendingDisambiguation {
  var_key: string;
  next_node_key: string;
  append: boolean | undefined;
  lowercase: boolean | undefined;
  cross_sell: boolean | undefined;
  quantity: string | null;
  candidates: Record<string, string>;
  /** What the customer typed — captured as-is on "No es ninguno". */
  original_text?: string;
}

/** Row id for "none of these" in a product pick list. */
const NONE_OF_THESE_ID = "__none__";

/** The subset of a capture config product disambiguation needs —
 *  satisfied by both collect_input and a text_fallback. */
interface DisambiguationConfig {
  var_key: string;
  next_node_key: string;
  append?: boolean;
  lowercase?: boolean;
  cross_sell?: boolean;
  disambiguate_products?: boolean;
  disambiguation_show_price?: boolean;
}

/**
 * Splits a leading item count off free text ("2 cocas" -> "2" +
 * "cocas"), so a resolved catalog pick can be re-combined as
 * "2 Coca-Cola 2L" instead of losing the quantity the customer typed.
 * No leading number -> quantity is null and the whole trimmed text is
 * searched as-is.
 */
export function parseLeadingQuantity(text: string): {
  quantity: string | null;
  rest: string;
} {
  const trimmed = text.trim();
  const match = trimmed.match(/^(\d+)\s+(.+)$/);
  if (match) return { quantity: match[1], rest: match[2].trim() };
  return { quantity: null, rest: trimmed };
}

function formatCandidatePrice(candidate: CatalogProductCandidate): string {
  if (candidate.price == null) return "";
  return `${candidate.currency ?? ""} ${candidate.price}`.trim();
}

/**
 * Checked before a `collect_input` node (with `disambiguate_products:
 * true`) captures a text reply. Returns null when there's nothing to
 * disambiguate (no catalog configured, or the text matches 0-1
 * products) — the caller falls through to the normal capture. When
 * 2+ products match, sends an interactive list of the candidates and
 * suspends the run on the SAME node (no capture, no advance) — the
 * customer's tap is resolved back into a capture by the
 * `__pending_disambiguation` branch in `handleReplyForActiveRun`.
 */
async function tryStartProductDisambiguation(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  cfg: DisambiguationConfig,
  text: string,
): Promise<DispatchInboundResult | null> {
  if (!cfg.disambiguate_products) return null;

  const { data: waConfig } = await db
    .from("whatsapp_config")
    .select("catalog_id")
    .eq("account_id", run.account_id)
    .maybeSingle();
  const catalogId = (waConfig as { catalog_id: string | null } | null)
    ?.catalog_id;
  if (!catalogId) return null;

  const { quantity, rest } = parseLeadingQuantity(text);
  const candidates = await retrieveCatalogProducts(db, run.account_id, rest, 8);
  if (candidates.length < 2) return null;

  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: DISAMBIGUATION_PROMPT,
    buttonLabel: "Ver opciones",
    sections: [
      {
        rows: [
          ...candidates.map((c) => ({
            id: c.retailerId,
            title: c.name.slice(0, INTERACTIVE_LIMITS.listRowTitleMaxLength),
            // Without prices, the description carries the full name — row
            // titles cap at 24 chars, which cuts most catalog names.
            description: (cfg.disambiguation_show_price === false
              ? c.name.length > INTERACTIVE_LIMITS.listRowTitleMaxLength
                ? c.name
                : ""
              : formatCandidatePrice(c)
            ).slice(0, INTERACTIVE_LIMITS.listRowDescriptionMaxLength),
          })),
          {
            id: NONE_OF_THESE_ID,
            title: "No es ninguno",
            description: "Lo anoto tal como lo escribió",
          },
        ],
      },
    ],
  });

  const candidateMap: Record<string, string> = {};
  for (const c of candidates) candidateMap[c.retailerId] = c.name;
  const pending: PendingDisambiguation = {
    var_key: cfg.var_key,
    next_node_key: cfg.next_node_key,
    append: cfg.append,
    lowercase: cfg.lowercase,
    cross_sell: cfg.cross_sell,
    quantity,
    candidates: candidateMap,
    original_text: text.trim(),
  };
  const newVars = { ...run.vars, __pending_disambiguation: pending };
  await db.from("flow_runs").update({ vars: newVars }).eq("id", run.id);
  run.vars = newVars;

  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "collect_input_disambiguation",
    whatsapp_message_id,
    candidate_count: candidates.length,
  });

  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: "awaiting_disambiguation",
  };
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
  // A debounced batch ("1 leche", "1 queso", "10 panes" sent back to
  // back) gets ONE confirmation, so `_last` must cover every capture
  // since the previous reply — not just the final one, which made the
  // first items look dropped. `__capture_batch_var` stays set until
  // the advance loop sends that reply (see advanceFromNodeKey).
  const batchOpen = run.vars.__capture_batch_var === args.var_key;
  const prevLast = run.vars[`${args.var_key}_last`];
  const prevAside = run.vars[`${args.var_key}_cross_sell`];
  const lastValue =
    batchOpen && typeof prevLast === "string" && prevLast.length > 0
      ? `${prevLast}, ${captured}`
      : captured;
  // The same batch as individual lines, for AI clarification (see
  // clarifyCapturedBatch) — a multi-line message counts line by line.
  const prevBatchLines = batchOpen && Array.isArray(run.vars.__capture_batch_lines)
    ? (run.vars.__capture_batch_lines as string[])
    : [];
  const batchLines = [
    ...prevBatchLines,
    ...captured.split("\n").map((l) => l.trim()).filter(Boolean),
  ];

  let crossSellAside = "";
  if (args.cross_sell && !run.vars.__cross_sell_shown) {
    const suggestion = pickCrossSellSuggestion(trimmed, []);
    if (suggestion) crossSellAside = `\n\n${suggestion}`;
  }
  if (!crossSellAside && batchOpen && typeof prevAside === "string") {
    // Keep an aside an earlier item in this same batch earned.
    crossSellAside = prevAside;
  }

  const newVars = {
    ...run.vars,
    [args.var_key]: newValue,
    // Lets the node's own confirmation text echo back just what was
    // captured since the last reply (e.g. "Anotado: 1 libra de queso ✅")
    // instead of a generic ack that gives no way to notice a dropped item.
    [`${args.var_key}_last`]: lastValue,
    // Reset every turn (not just when cross_sell is on) so a stale
    // aside from an earlier capture on a different var_key can't leak
    // into this node's confirmation text.
    [`${args.var_key}_cross_sell`]: crossSellAside,
    // The whole accumulated list, numbered — for a "confirm your list"
    // step (e.g. "{{vars.order_text_numbered}}").
    ...(args.append ? { [`${args.var_key}_numbered`]: numberLines(newValue) } : {}),
    __capture_batch_var: args.var_key,
    __capture_batch_lines: batchLines,
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

  const currentCollectCfg =
    currentNode.node_type === "collect_input"
      ? (currentNode.config as unknown as CollectInputNodeConfig)
      : undefined;
  const currentTextFallback = textFallbackOf(currentNode);

  // A typed option number counts as tapping that option — unless a
  // product pick list is open, where the number means one of ITS rows
  // (handled in the pending-disambiguation branch below).
  // Likewise when a list edit is in progress or this node takes list
  // corrections — there "3" means line 3 of the customer's list.
  if (
    message.kind === "text" &&
    !run.vars.__pending_disambiguation &&
    !run.vars.__pending_clarification &&
    !run.vars.__pending_line_edit &&
    !run.vars.__pending_list_answer &&
    !currentTextFallback?.edit_list_var
  ) {
    const picked = optionByNumber(currentNode, message.text);
    if (picked) {
      message = {
        kind: "interactive_reply",
        reply_id: picked.reply_id,
        reply_title: picked.title,
        meta_message_id: message.meta_message_id,
      };
    }
  }

  // Voice notes, videos, stickers and documents used to arrive as an
  // empty text, fail the capture, burn a reprompt and — after two —
  // hand off silently. Say plainly what we can't read instead, without
  // counting it against the customer. A document IS accepted where an
  // image is (a transfer receipt often comes as a PDF); a sticker is
  // usually just an "ok" and gets no reply.
  if (message.kind === "other") {
    const acceptsDocument =
      message.message_type === "document" &&
      message.media_url &&
      currentCollectCfg?.accept === "image";
    if (acceptsDocument) {
      const next = await captureTextIntoVar(db, run, currentNode.node_key, {
        var_key: currentCollectCfg.var_key,
        append: currentCollectCfg.append,
        lowercase: false,
        cross_sell: false,
        next_node_key: currentCollectCfg.next_node_key,
        text: message.media_url!,
      });
      if (next) {
        const outcome = await advanceFromNodeKey(db, run, next, nodes);
        return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
      }
    }
    if (message.message_type !== "sticker") {
      await sendEngineText(db, run, currentNode.node_key, NON_TEXT_REPLY_TEXT, "non_text_reply");
    }
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Liquor can't be sold over WhatsApp (Meta Commerce Policy) — decline
  // it on any node that accumulates an order list, before it's captured.
  const capturesOrderList =
    currentCollectCfg?.append === true || currentTextFallback?.append === true;
  if (message.kind === "text" && capturesOrderList && isAlcoholRequest(message.text)) {
    await sendEngineText(db, run, currentNode.node_key, ALCOHOL_REPLY, "alcohol_declined");
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
        : currentTextFallback?.price_question_reply;
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

  // A general "about the business" question (schedule, location,
  // general range of products — "cual son sus horarios de atencion")
  // gets the same treatment as a price question above: answer it and
  // stay put, instead of it landing in the running order as if it
  // were another item. Checked after the price-question intercept so
  // a price question phrased ambiguously still hits that one first.
  if (message.kind === "text") {
    const generalReply =
      currentNode.node_type === "collect_input"
        ? (currentNode.config as unknown as CollectInputNodeConfig).general_info_reply
        : currentTextFallback?.general_info_reply;
    if (generalReply && isGeneralQuestion(message.text)) {
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(generalReply, run.vars),
        });
        await logEvent(db, run.id, "message_sent", currentNode.node_key, {
          reason: "general_info_reply",
        });
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "general_info_reply_failed",
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

  // A collect_input node with disambiguate_products may have paused
  // this exact node waiting on a product pick (see
  // tryStartProductDisambiguation). Whatever comes in next resolves
  // or discards that pending pick, so it's cleared up front — a tap
  // resolves it into the capture that would otherwise have happened;
  // anything else (a stale tap, or the customer typing instead of
  // tapping) just drops it and falls through to the branches below,
  // where a text reply re-enters the disambiguation check fresh.
  // List corrections — see CollectInputNodeConfig.edit_list_var and
  // SendButtonsNodeConfig buttons' check_duplicates_var.
  const listResult = await handleListEditing(db, run, currentNode, message, nodes);
  if (listResult) return listResult;

  // The customer is answering the question clarifyCapturedBatch asked.
  // A text answer is folded into those lines and the run moves on (no
  // second question, ever); anything else just drops the question —
  // the lines already stand as reviewed.
  const pendingClarification = run.vars.__pending_clarification as
    | PendingClarification
    | undefined;
  if (pendingClarification) {
    const restVars: Record<string, unknown> = { ...run.vars };
    delete restVars.__pending_clarification;
    if (message.kind === "text" && message.text.trim()) {
      const answer = message.text.trim();
      const answered = await applyClarificationAnswer(
        db,
        run.account_id,
        run.conversation_id,
        { lines: pendingClarification.lines, question: pendingClarification.question, answer },
      );
      // AI unavailable: keep the answer next to the last line rather
      // than lose it — the clerk reads the list, not a model.
      const newLines = answered ?? [
        ...pendingClarification.lines.slice(0, -1),
        `${pendingClarification.lines.at(-1)} (${answer})`,
      ];
      const vars = withReplacedLines(
        restVars,
        pendingClarification.var_key,
        pendingClarification.lines.length,
        newLines,
      );
      await db.from("flow_runs").update({ vars, reprompt_count: 0 }).eq("id", run.id);
      run.vars = vars;
      run.reprompt_count = 0;
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        clarification_applied: answered !== null,
      });
      const outcome = await advanceFromNodeKey(db, run, pendingClarification.next_node_key, nodes);
      return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
    }
    await db.from("flow_runs").update({ vars: restVars }).eq("id", run.id);
    run.vars = restVars;
  }

  const pendingDisambiguation = run.vars.__pending_disambiguation as
    | PendingDisambiguation
    | undefined;
  if (pendingDisambiguation) {
    const restVars: Record<string, unknown> = { ...run.vars };
    delete restVars.__pending_disambiguation;
    run.vars = restVars;
    const candidateIds = Object.keys(pendingDisambiguation.candidates);
    // A tap, or the row's number typed ("2"); one past the candidates is
    // the trailing "No es ninguno" row.
    let pickedId: string | undefined;
    if (message.kind === "interactive_reply") {
      pickedId = message.reply_id;
    } else if (message.kind === "text") {
      const index = parseOptionNumber(message.text);
      if (index !== null) {
        pickedId =
          index === candidateIds.length ? NONE_OF_THESE_ID : candidateIds[index];
      }
    }
    const pickedName = pickedId ? pendingDisambiguation.candidates[pickedId] : undefined;
    const pickedText =
      pickedId === NONE_OF_THESE_ID
        ? pendingDisambiguation.original_text
        : pickedName
          ? pendingDisambiguation.quantity
            ? `${pendingDisambiguation.quantity} ${pickedName}`
            : pickedName
          : undefined;
    if (pickedText) {
      matched = await captureTextIntoVar(db, run, currentNode.node_key, {
        var_key: pendingDisambiguation.var_key,
        append: pendingDisambiguation.append,
        lowercase: pendingDisambiguation.lowercase,
        cross_sell: pendingDisambiguation.cross_sell,
        next_node_key: pendingDisambiguation.next_node_key,
        text: pickedText,
      });
      // Resolving an ambiguity IS the "reply now" signal — no debounce.
    } else if (message.kind === "text" && pendingDisambiguation.original_text) {
      // They moved on and typed the next item instead of picking one
      // (common when listing items quickly). Keep the unresolved item as
      // written rather than dropping it, then handle this new text
      // normally below — the advance is left to that new text.
      await captureTextIntoVar(db, run, currentNode.node_key, {
        var_key: pendingDisambiguation.var_key,
        append: pendingDisambiguation.append,
        lowercase: pendingDisambiguation.lowercase,
        cross_sell: false,
        next_node_key: pendingDisambiguation.next_node_key,
        text: pendingDisambiguation.original_text,
      });
    }
  }

  if (matched !== null) {
    // Resolved via a disambiguation pick above — skip the rest of the
    // matching chain entirely.
  } else if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
    if (matched && currentNode.node_type === "send_buttons") {
      const tapped = (currentNode.config as unknown as SendButtonsNodeConfig).buttons.find(
        (b) => b.reply_id === message.reply_id,
      );
      if (
        tapped?.check_duplicates_var &&
        (await askAboutDuplicates(db, run, currentNode, tapped.check_duplicates_var))
      ) {
        return { consumed: true, flow_run_id: run.id, outcome: "awaiting_clarification" };
      }
    }
    if (matched) {
      // Remember which option was tapped as `{{vars.<node_key>_choice}}`
      // (e.g. "Efectivo" on ask_payment), so later text — above all the
      // handoff note staff receive — can say what the customer chose.
      // Without this a button path left no trace in vars at all.
      const choiceVars = {
        ...run.vars,
        [`${currentNode.node_key}_choice`]: message.reply_title,
      };
      const { error } = await db
        .from("flow_runs")
        .update({ vars: choiceVars })
        .eq("id", run.id);
      if (!error) run.vars = choiceVars;
    }
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
    const disambiguation = await tryStartProductDisambiguation(
      db,
      run,
      currentNode,
      cfg,
      message.text,
    );
    if (disambiguation) return disambiguation;
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
    message.kind === "order" &&
    (currentCollectCfg?.append === true || currentTextFallback?.append === true)
  ) {
    // A catalog cart lands wherever typed order lines would (an
    // order-list collect_input, or a send_buttons text_fallback like
    // "¿algo más?"). No disambiguation — the items are exact catalog
    // picks — and no debounce: a cart is one complete message.
    const target = (currentCollectCfg?.append ? currentCollectCfg : currentTextFallback)!;
    matched = await captureTextIntoVar(db, run, currentNode.node_key, {
      var_key: target.var_key,
      append: true,
      lowercase: false,
      cross_sell: false,
      next_node_key: target.next_node_key,
      text: message.text,
    });
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
  } else if (message.kind === "text" && currentTextFallback) {
    // Customers reliably keep typing instead of tapping a button —
    // most commonly to list another item after "¿algo más?". Route
    // that text into the configured var/next node (see
    // SendButtonsNodeConfig.text_fallback) instead of letting it fall
    // to the fallback policy's reprompt, which would silently discard
    // whatever they just said. Same for a list-style menu.
    const fallbackCfg = currentTextFallback;
    const disambiguation = await tryStartProductDisambiguation(
      db,
      run,
      currentNode,
      fallbackCfg,
      message.text,
    );
    if (disambiguation) return disambiguation;
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

    if (message.kind === "text" && (await clarifyCapturedBatch(db, run, currentNode))) {
      return { consumed: true, flow_run_id: run.id, outcome: "awaiting_clarification" };
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
    if (message.kind === "text" && currentTextFallback) {
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
          text: CAPTURE_FAILED_TEXT,
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
    // This path used to end silently: the customer got no reply at all
    // and no one on staff was told, so the conversation just sat in
    // "pending" until somebody happened to open the inbox.
    await sendEngineText(
      db,
      run,
      run.current_node_key,
      FALLBACK_HANDOFF_TEXT,
      "fallback_handoff_ack",
    );
    const orderSoFar =
      typeof run.vars.order_text === "string" && run.vars.order_text.trim()
        ? ` Pedido hasta ahora: ${run.vars.order_text}`
        : "";
    await notifyHandoff(db, run, run.current_node_key, {
      summary: `El bot no logró entender al cliente (paso "${run.current_node_key}").${orderSoFar}`,
    });
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

  // A catalog cart that opened the conversation is treated as the
  // customer's answer to the entry node (e.g. the greeting's "type your
  // order" text_fallback) rather than something to greet over. If the
  // entry node can't take an order list, fall back to a normal start —
  // the cart itself is still in the inbox for staff.
  if (input.message.kind === "order") {
    const entry = nodes.get(flow.entry_node_id!);
    const entryTakesOrder =
      (entry && textFallbackOf(entry)?.append === true) ||
      (entry?.node_type === "collect_input" &&
        (entry.config as unknown as CollectInputNodeConfig).append === true);
    if (entryTakesOrder) {
      const result = await handleReplyForActiveRun(db, run, input.message, nodes);
      return {
        ...result,
        outcome: result.outcome === "advanced" ? "started" : result.outcome,
      };
    }
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}

/**
 * Starts a flow run triggered by something other than an inbound
 * WhatsApp message — today, a WooCommerce "order created" webhook
 * (see src/app/api/webhooks/woocommerce/[accountId]/route.ts). Mirrors
 * startNewRun's core (insert flow_runs, log, bump the execution
 * counter, advance from the entry node) but drops everything tied to
 * a real inbound message: there's no meta_message_id to log, and no
 * keyword-trigger handoff-clearing to do (this was never a customer
 * typing "menu" to reclaim the bot from a human).
 *
 * `args.vars` seeds the run alongside the usual `contact_name` lookup
 * — e.g. `{ order_id, order_total, payment_method, order_items_summary }`
 * for a WooCommerce order, so the flow's own nodes can reference
 * `{{vars.order_total}}` etc. immediately, with no collect_input
 * needed for data the webhook already has.
 *
 * Caller is responsible for resolving/creating the contact and
 * conversation first (account-scoped — this function trusts
 * `args.contactId`/`args.conversationId` are already correct for
 * `flowId`'s account) and for treating a `no_match` outcome as
 * "nothing sent, log and move on" rather than retrying — same
 * best-effort spirit as the rest of the flow engine.
 */
export async function startFlowRunForExternalEvent(
  db: AdminClient,
  flowId: string,
  args: {
    contactId: string;
    conversationId: string;
    vars: Record<string, unknown>;
  },
): Promise<DispatchInboundResult> {
  const flow = await loadFlow(db, flowId);
  if (!flow || flow.status !== "active" || !flow.entry_node_id) {
    return { consumed: false, outcome: "no_match" };
  }
  const nodes = await loadAllNodes(db, flow.id);

  let contactName = "";
  try {
    const { data: contactRow } = await db
      .from("contacts")
      .select("name")
      .eq("id", args.contactId)
      .maybeSingle();
    const rawName = (contactRow as { name?: string | null } | null)?.name;
    if (typeof rawName === "string" && rawName.trim().length > 0) {
      contactName = ` ${rawName.trim().split(/\s+/)[0]}`;
    }
  } catch (err) {
    console.error("[flows] contact name lookup failed:", err);
  }

  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      account_id: flow.account_id,
      user_id: flow.user_id,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
      vars: { contact_name: contactName, ...args.vars },
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → this contact already has an active
    // run (idx_one_active_run_per_contact) — most likely they're mid
    // WhatsApp conversation with the bot already. Don't fight it.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startFlowRunForExternalEvent insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    source: "external_event",
  });

  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
