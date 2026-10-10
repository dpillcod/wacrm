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
  engineSendFlowForm,
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
import {
  getStaffPhones,
  notifyStaffOfHandoff,
  sanitizeForTemplateParam,
  type NotifyStaffResult,
} from "../whatsapp/staff-notify";
import { localPhone, toInternational } from "../whatsapp/phone-utils";
import { customerWindowOpen, findOrderPipeline, notifyAccountInApp, upsertOrderCard } from "../pipelines/order-cards";
import {
  csatThanks,
  isOrderStatusQuestion,
  orderRefFromTitle,
  orderStageKind,
  parseCsatReplyId,
  statusReply,
} from "../pipelines/order-stages";
import { updateWooOrder } from "../woocommerce/client";
import { classifyFirstMessage, readImage, transcribeAudio, type ImageReading } from "../ai/media-understanding";
import { nextGuideStep, type GuideAnswer } from "./service-guide";
import { acceptOfferedProduct, answerInFlow, looksLikeQuestion } from "./question-answer";
import { nextOpeningPhrase } from "./store-policy";
import { createOrderLinkToken, orderLinkUrl } from "../catalog/order-link";
import { keepCatalogLines, money, totalLine } from "../catalog/order-lines";
import {
  cartOrderLines,
  cartsDueForReminder,
  clearCart,
  loadCart,
  markCartReminded,
  type StoredCart,
} from "../catalog/carts";
import {
  billingLine,
  greetingName,
  isRefusal,
  loadCustomerProfile,
  parseCustomerProfile,
  profileProblemText,
  saveCustomerProfile,
  type CustomerProfile,
} from "./customer-profile";
import { formatFormReply } from "../whatsapp/flow-form";
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
  isBlockedProduct,
  isWithinBusinessHours,
  normalizeForMatch,
  outOfHoursNotice,
} from "./store-policy";
import { loadBusinessSettings, renderText, type BusinessSettings } from "../business/settings";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type HandoffFollowUpConfig,
  type HandoffNodeConfig,
  type NodeSideEffectsConfig,
  type OrderNumberConfig,
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
// comes from the flow's own node config) live in the account's
// business settings (settings.texts) — see lib/business/settings.ts.
// Only these two structural prompts stay here.
// ============================================================

/** The account's business settings (cached per account for a minute). */
function bizOf(db: AdminClient, accountId: string): Promise<BusinessSettings> {
  return loadBusinessSettings(db, accountId);
}

const editLinePrompt = (n: number, line: string) =>
  `Escriba cómo debe quedar el *${n}* (_${line}_), o escriba *borrar* para quitarlo.`;
const editOutOfRangeText = (max: number) =>
  `Ese número no está en su lista 🙂 Escriba un número del 1 al ${max}.`;

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

function optionsOf(node: {
  node_type: string;
  config: Record<string, unknown>;
}): Array<{ reply_id: string; title: string; aliases?: string[] }> {
  if (node.node_type === "send_buttons") {
    return (node.config as unknown as SendButtonsNodeConfig).buttons ?? [];
  }
  if (node.node_type === "send_list") {
    return ((node.config as unknown as SendListNodeConfig).sections ?? []).flatMap(
      (section) => section.rows ?? [],
    );
  }
  return [];
}

/**
 * Typed text that IS an option: its title ("Ya terminé", "Consumidor
 * final") or one of its aliases ("listo", "sí"), ignoring case, accents
 * and emoji. Without this, "ya terminé" typed at the "¿algo más?" step
 * was captured as if it were a product.
 */
export function optionByText(
  node: { node_type: string; config: Record<string, unknown> },
  text: string,
): { reply_id: string; title: string } | null {
  const said = normalizeForMatch(text);
  if (!said) return null;
  for (const o of optionsOf(node)) {
    const names = [o.title, ...(o.aliases ?? [])].map(normalizeForMatch).filter(Boolean);
    if (names.includes(said)) return { reply_id: o.reply_id, title: o.title };
  }
  return null;
}

/** The number of options when `text` is an option number that doesn't exist ("9" of 7), else null. */
export function outOfRangeOption(
  node: { node_type: string; config: Record<string, unknown> },
  text: string,
): number | null {
  const index = parseOptionNumber(text);
  const count = optionsOf(node).length;
  return index !== null && count > 0 && (index < 0 || index >= count) ? count : null;
}

const GREETING_WORDS = new Set([
  "hola", "ola", "holi", "buenas", "buenos", "buena", "buen", "dia", "dias", "tardes", "noches",
  "saludos", "hello", "hi", "que", "tal", "como", "esta", "estas", "señorita", "senorita", "amigo",
]);

/** "hola", "buenas tardes", "hola que tal" — a greeting and nothing else. */
export function isPlainGreeting(text: string): boolean {
  const words = normalizeForMatch(text).split(" ").filter(Boolean);
  return words.length > 0 && words.length <= 4 && words.every((w) => GREETING_WORDS.has(w)) &&
    !words.every((w) => w === "que" || w === "tal" || w === "como" || w === "esta" || w === "estas");
}

const ACK_ONLY = new Set([
  "si", "sii", "sip", "ok", "oki", "okey", "okay", "vale", "bueno", "bien", "perfecto", "dale",
  "claro", "gracias", "muchas gracias", "ok gracias", "si gracias", "listo gracias", "de acuerdo",
  "entendido", "ya", "aja", "mmm", "listo", "ya termine", "eso", "👍",
]);

/** A bare acknowledgement ("sí", "ok", "gracias") — never an order line. */
export function isAckOnly(text: string): boolean {
  const said = normalizeForMatch(text);
  return said === "" ? /^\s*(👍|👌|🙏|🙂|😊)+\s*$/u.test(text) : ACK_ONLY.has(said);
}

/** "Quiero hablar con un asesor / una persona / alguien". */
export function isHumanRequest(text: string): boolean {
  const said = normalizeForMatch(text);
  return said.length <= 80 && (
    /\b(hablar|comunicar(me)?|atender?me|contactar|pasar(me)?)\b.*\b(asesor|asesora|persona|alguien|humano|agente|vendedor|vendedora|encargad[oa]|operador[a]?)\b/.test(said) ||
    /\b(un|una) (asesor|asesora|persona|humano|agente)\b/.test(said) && said.split(" ").length <= 6
  );
}

/** "Quiero 2 sacos de cemento" → "2 sacos de cemento" (the words before the product). */
export function stripOrderLeadIn(line: string): string {
  const stripped = line
    .replace(
      /^((hola|buenas|buenos d[ií]as|por favor|porfa|disculpe|quiero|quisiera|necesito|d[eé]me|me da|me das|me puede dar|me pueden dar|me regala|me vende|me manda|me env[ií]a|env[ií]eme|m[aá]ndeme|adem[aá]s|tambi[eé]n|y tambi[eé]n)[\s,:]+)+/i,
      "",
    )
    .trim();
  return stripped || line;
}

/** Whether the run is holding an order list the customer is still building. */
function runHoldsList(run: FlowRunRow): boolean {
  return Object.entries(run.vars).some(
    ([k, v]) => k.endsWith("_numbered") && typeof v === "string" && v.trim() !== "",
  );
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

  if (cfg.create_order_card) {
    const total = Number(String(run.vars.order_total ?? "").replace(",", "."));
    const cardId = await upsertOrderCard(db, {
      accountId: run.account_id,
      userId: run.user_id,
      contactId: run.contact_id!,
      conversationId: run.conversation_id,
      dealId: typeof run.vars.__deal_id === "string" ? run.vars.__deal_id : null,
      title: orderCardTitle(run),
      notes: resolvedNote ?? "",
      value: Number.isFinite(total) ? total : undefined,
      pipelineName:
        cfg.card_board === "services" ? (await bizOf(db, run.account_id)).serviceBoard.pipelineName : undefined,
    });
    if (cardId && cardId !== run.vars.__deal_id) {
      await saveVars(db, run, { ...run.vars, __deal_id: cardId });
    }
  }

  // Keep the customer company after the handoff (see HandoffNodeConfig).
  // State lives on the ended run's vars: it's the record of this order.
  if (cfg.follow_up || cfg.after_handoff_reply) {
    const followUp: FollowUpState | undefined = cfg.follow_up
      ? { ...cfg.follow_up, asked: 0, reminded: 0, done: false, summary: resolvedNote ?? "" }
      : undefined;
    const vars = {
      ...run.vars,
      ...(followUp ? { __follow_up: followUp } : {}),
      ...(cfg.after_handoff_reply ? { __after_handoff_reply: cfg.after_handoff_reply } : {}),
    };
    await saveVars(db, run, vars);
    if (followUp && isWithinBusinessHours(await bizOf(db, run.account_id))) {
      scheduleFollowUp(db, run.id, followUp.every_minutes);
    }
  }
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
  const biz = await bizOf(db, run.account_id);
  if (!isWithinBusinessHours(biz)) {
    await sendEngineText(db, run, nodeKey, outOfHoursNotice(biz), "out_of_hours_notice");
  }

  // Best-effort — nobody watching the inbox otherwise finds out a
  // conversation needs a human until they happen to open WACRM.
  // Never let a notification failure affect the handoff itself. The
  // result is logged to flow_run_events (not just console.error) —
  // a newline-in-parameter bug here once silently failed every real
  // handoff across several live tests before anyone noticed.
  let staffResult: NotifyStaffResult | null = null;
  try {
    staffResult = await alertStaff(db, run, nodeKey, args.summary);
  } catch (err) {
    await logEvent(db, run.id, "error", nodeKey, {
      reason: "staff_notify_threw",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // In-app notifications for the whole team (free — and the one channel
  // that works while WhatsApp alerts depend on staff being "on shift").
  // Includes the shared shop-floor account and any notify_user_ids.
  const noOneOnShift =
    staffResult !== null &&
    getStaffPhones(biz).length > 0 &&
    staffResult.sent.length === 0;
  await notifyTeamInApp(db, run, nodeKey, {
    title: orderTitle(
      run,
      run.vars.svc_problema ? "🔧 Servicio para atender" : run.vars.order_text ? "🧾 Pedido para atender" : "💬 Cliente para atender",
    ),
    body:
      args.summary +
      (noOneOnShift
        ? "\n\n⚠️ Ningún número del personal recibió el aviso por WhatsApp: nadie escribió *turno* al bot en las últimas 24 horas."
        : ""),
    extraUserIds: args.notifyUserIds,
  });
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
  // The whole URL is one variable (e.g. {{vars.catalog_link}}, a link the
  // engine built): use it as is — the caller checks it's https.
  const whole = /^\s*\{\{vars\.([a-zA-Z0-9_]+)\}\}\s*$/.exec(template);
  if (whole) {
    const v = vars[whole[1]];
    return typeof v === "string" ? v.trim() : "";
  }
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    if (v === undefined || v === null) return "";
    const text = String(v);
    const capped =
      text.length > URL_VAR_MAX_CHARS ? `${text.slice(0, URL_VAR_MAX_CHARS)}…` : text;
    return encodeURIComponent(capped);
  });
}

/**
 * Apply a collect_input's `validation` to a text reply. Returns the
 * value to capture — for email / phone / regex, just the matching part
 * ("mi cédula es 0105280069" → "0105280069") — or null when nothing in
 * the reply is valid. `any` (the default) passes the text through.
 */
export function extractValidInput(
  cfg: Pick<CollectInputNodeConfig, "validation" | "regex">,
  text: string,
): string | null {
  let pattern: RegExp | null = null;
  switch (cfg.validation) {
    case "email":
      pattern = /[^\s@]+@[^\s@]+\.[^\s@]+/;
      break;
    case "phone":
      pattern = /\+?\d[\d\s-]{6,}\d/;
      break;
    case "regex":
      if (cfg.regex) {
        try {
          pattern = new RegExp(cfg.regex, "i");
        } catch {
          pattern = null; // invalid pattern: don't block the customer
        }
      }
      break;
  }
  if (!pattern) return text;
  const m = text.match(pattern);
  return m ? m[0].trim() : null;
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
    if ((node.config as OrderNumberConfig).assign_order_number) {
      await assignOrderNumber(db, run);
    }
    if ((node.config as OrderNumberConfig).assign_service_number) {
      await assignServiceNumber(db, run);
    }
    await runNodeSideEffects(db, run, node);

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
      const ctaUrl = interpolateVarsForUrl(cfg.url, run.vars);
      // No usable link (e.g. the CRM's public address isn't set yet):
      // the text alone, and the conversation carries on.
      if (!/^https:\/\/[^\s/]+/.test(ctaUrl)) {
        await sendEngineText(db, run, node.node_key, interpolateVars(cfg.text, run.vars), "cta_without_link");
        currentKey = cfg.next_node_key;
        continue;
      }
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
          headerImageUrl: cfg.header_image_url,
          buttonText: cfg.button_text,
          url: ctaUrl,
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
          // Order data (item lists, notes) can be multi-line; Meta
          // rejects a template parameter containing newlines.
          params: cfg.params?.map((p) => sanitizeForTemplateParam(interpolateVars(p, run.vars)) || "-"),
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
      const known = run.vars[cfg.var_key];
      if (cfg.ai_guide && typeof known === "string" && known.trim()) {
        // The job is already described: go straight to the advisor's
        // questions instead of asking for it again.
        if (await advanceCurrentNodeKey(db, run.id, run.current_node_key, node.node_key)) {
          run.current_node_key = node.node_key;
        }
        return runServiceGuide(db, run, node, nodes, []);
      }
      if (cfg.silent) {
        // The question already went out (e.g. in a template) — just
        // wait. No idle nudge: outside the 24h window it couldn't be
        // delivered anyway.
        const advancedSilently = await advanceCurrentNodeKey(
          db,
          run.id,
          run.current_node_key,
          node.node_key,
        );
        if (!advancedSilently) {
          await logEvent(db, run.id, "error", node.node_key, {
            reason: "lost_race_during_advance",
          });
        }
        return { outcome: "advanced" };
      }
      // An empty prompt: the message before (e.g. a link button) already
      // asked — just wait for the answer.
      const askNothing = !cfg.form && !interpolateVars(cfg.prompt_text ?? "", run.vars).trim();
      if (!askNothing) try {
        const { whatsapp_message_id } = cfg.form
          ? // Ask with an in-chat form (see CollectInputNodeConfig.form).
            await engineSendFlowForm({
              accountId: run.account_id,
              userId: run.user_id,
              conversationId: run.conversation_id!,
              contactId: run.contact_id!,
              bodyText: interpolateVars(cfg.prompt_text, run.vars),
              flowId: cfg.form.flow_id,
              flowCta: cfg.form.cta,
              screen: cfg.form.screen,
              flowToken: run.id,
            })
          : await engineSendText({
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
  // A voice note is transcribed first and then handled exactly as if
  // the customer had typed it (keywords, the order list, questions…).
  // The inbox shows the text next to the audio.
  let transcript: string | undefined;
  const m = input.message;
  if (m.kind === "other" && m.message_type === "audio" && m.media_url) {
    try {
      const db = supabaseAdmin();
      const biz = await bizOf(db, input.accountId);
      if (biz.aiFeatures.transcribeAudio && (await audiosTranscribedToday(db, input.accountId, biz)) < biz.aiFeatures.audioDailyLimit) {
        const result = await transcribeAudio(db, input.accountId, m.media_url);
        if (result && "tooLong" in result) {
          await engineSendText({
            accountId: input.accountId,
            userId: input.userId,
            conversationId: input.conversationId,
            contactId: input.contactId,
            text: biz.texts.audioTooLong,
          });
          return { consumed: true, outcome: "no_match" };
        }
        const text = result?.text;
        if (text) {
          transcript = text;
          await db
            .from("messages")
            .update({ content_text: `🎤 ${text}` })
            .eq("conversation_id", input.conversationId)
            .eq("message_id", m.meta_message_id);
          input = { ...input, message: { kind: "text", text, meta_message_id: m.meta_message_id, voice: true } };
        }
      }
    } catch (err) {
      console.error("[flows] voice note transcription threw:", err);
    }
  }
  const result = await dispatchInboundToFlowsInner(input);
  return transcript ? { ...result, transcript } : result;
}

/** Voice notes transcribed today (local time) for this account — for the daily cap. */
async function audiosTranscribedToday(db: AdminClient, accountId: string, biz: BusinessSettings): Promise<number> {
  const offsetMs = biz.utcOffsetHours * 3_600_000;
  const localMidnight = new Date(Math.floor((Date.now() + offsetMs) / 86_400_000) * 86_400_000 - offsetMs);
  const { count } = await db
    .from("messages")
    .select("id, conversations!inner(account_id)", { count: "exact", head: true })
    .eq("conversations.account_id", accountId)
    .eq("content_type", "audio")
    .like("content_text", "🎤%")
    .gte("created_at", localMidnight.toISOString());
  return count ?? 0;
}

/** A bot-made "cart": order lines read from a photo or a typed first message. */
function linesAsOrder(lines: string[], metaMessageId: string): ParsedInbound {
  return { kind: "order", items: [], text: lines.join("\n"), meta_message_id: metaMessageId };
}

/**
 * Free text with no bot conversation running that the AI reads as an
 * order: start the main flow with those lines (as a catalog cart would).
 * Null when it isn't an order, the feature is off, or a person has the chat.
 */
async function startOrderFromFirstMessage(
  db: AdminClient,
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
  /** "Buenas, ¿tienen cemento?" matched the greeting: leave a question to the chat AI. */
  questionsToAi = false,
): Promise<DispatchInboundResult | null> {
  if (input.message.kind !== "text") return null;
  if (!(await bizOf(db, input.accountId)).aiFeatures.entryRouter) return null;
  if (!(await botOwnsConversation(db, input.conversationId))) return null;
  const defaultFlow = await findDefaultEntryFlow(db, input.accountId);
  if (!defaultFlow?.entry_node_id) return null;
  const route = await classifyFirstMessage(db, input.accountId, input.conversationId, input.message.text);
  // "Buenas tardes, ¿tendrá garbanzo?": a direct answer (catalog +
  // the business's own information), no menu. A product question opens
  // the order quietly, so "sí, 2 libras" writes it down.
  if (route?.intent === "question" && (await bizOf(db, input.accountId)).aiFeatures.answerQuestions) {
    const answer = await answerInFlow(db, input.accountId, input.conversationId, input.message.text, "menu");
    if (answer) {
      await engineSendText({
        accountId: input.accountId,
        userId: input.userId,
        conversationId: input.conversationId,
        contactId: input.contactId,
        text: answer.reply,
      });
      if (answer.product) {
        const nodes = await loadAllNodes(db, defaultFlow.id);
        await startNewRun(db, defaultFlow, input, nodes, {
          silent: true,
          vars: { __offered_product: answer.product },
        });
      }
      return { consumed: true, outcome: "no_match" };
    }
  }
  if (questionsToAi && (route?.intent === "question" || route?.intent === "human")) {
    return { consumed: false, outcome: "no_match" };
  }
  // "Se me dañó la llave del baño, necesito un plomero": straight to the
  // home-service request, with what they said as its description.
  if (route?.intent === "service" || route?.intent === "bakery") {
    const biz = await bizOf(db, input.accountId);
    const entryNode = route.intent === "service" ? biz.serviceBoard.entryNode : biz.bakery.entryNode;
    const nodes = await loadAllNodes(db, defaultFlow.id);
    if (!entryNode || !nodes.has(entryNode)) {
      return questionsToAi ? { consumed: false, outcome: "no_match" } : null;
    }
    // What they said becomes the description the advisor starts from.
    const startNode = nodes.get(entryNode)!;
    const describedVar =
      (startNode.config as { text_fallback?: { var_key?: string } }).text_fallback?.var_key ??
      (route.intent === "service" ? "svc_problema" : "pst_detalle");
    return startNewRun(db, defaultFlow, input, nodes, {
      startAt: entryNode,
      vars: { [describedVar]: input.message.text },
    });
  }
  if (route?.intent !== "order") return null;
  const nodes = await loadAllNodes(db, defaultFlow.id);
  return startNewRun(
    db,
    defaultFlow,
    { ...input, message: linesAsOrder(route.lines, input.message.meta_message_id) },
    nodes,
  );
}

/**
 * Worth asking the AI to split into products: a voice note, or a long
 * sentence that lists things ("…leche y un paquete de arroz", commas).
 */
export function looksLikeSeveralItems(text: string, voice: boolean): boolean {
  const words = normalizeForMatch(text).split(" ").filter(Boolean);
  if (voice) return words.length >= 3;
  return words.length >= 7 && /,|;| y | e | tambien | ademas /.test(` ${normalizeForMatch(text)} `.replace(/,/g, " , "));
}

/** A payment receipt photo: thank the customer, tell the team. */
async function acknowledgeReceipt(
  db: AdminClient,
  input: DispatchInboundInput,
  reading: Extract<ImageReading, { kind: "receipt" }>,
  run: FlowRunRow | null,
): Promise<void> {
  const biz = await bizOf(db, input.accountId);
  try {
    await engineSendText({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text: biz.texts.receiptReceived,
    });
  } catch (err) {
    console.error("[flows] receipt acknowledgement failed:", err);
  }
  const imageUrl = input.message.kind === "image" ? input.message.media_url : "";
  const body = `El cliente envió un comprobante de pago${reading.summary ? `: ${reading.summary}` : ""}.\n${imageUrl}`;
  if (run) {
    await saveVars(db, run, { ...run.vars, payment_receipt_url: imageUrl });
    await notifyTeamInApp(db, run, run.current_node_key, { title: orderTitle(run, "🧾 Comprobante de pago"), body });
  } else {
    await notifyAccountInApp(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      title: "🧾 Comprobante de pago",
      body,
    });
  }
}

/** The service advisor's open question (see CollectInputNodeConfig.ai_guide). */
interface PendingGuide {
  node_key: string;
  question: string;
  answers: GuideAnswer[];
}

/**
 * One turn of the service advisor: ask the next question (and stay on
 * this node), or — when there's enough, the AI is unavailable, or the
 * question budget is spent — save the summary and move on.
 */
async function runServiceGuide(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  nodes: Map<string, FlowNodeRow>,
  answers: GuideAnswer[],
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  const cfg = node.config as unknown as CollectInputNodeConfig;
  const max = Math.max(0, Math.min(cfg.ai_guide?.max_questions ?? 3, 5));
  const initial = String(run.vars[cfg.var_key] ?? "").trim();
  const step = await nextGuideStep(db, run.account_id, run.conversation_id, {
    context: interpolateVars(cfg.ai_guide?.context ?? "", run.vars),
    initial,
    answers,
    remaining: max - answers.length,
    kind: cfg.ai_guide?.kind,
  });
  const vars: Record<string, unknown> = { ...run.vars };
  delete vars.__pending_guide;
  vars[`${cfg.var_key}_qa`] = answers.map((x) => `• ${x.q} → ${x.a}`).join("\n");
  const tip = step?.tip && !run.vars.__guide_tip_sent ? step.tip : null;
  if (tip) vars.__guide_tip_sent = true;

  if (step?.question && answers.length < max) {
    vars.__pending_guide = { node_key: node.node_key, question: step.question, answers } satisfies PendingGuide;
    await saveVars(db, run, vars);
    await sendEngineText(db, run, node.node_key, tip ? `${tip}\n\n${step.question}` : step.question, "service_guide_question");
    return { outcome: "advanced" };
  }

  vars[`${cfg.var_key}_resumen`] = step?.summary || [initial, ...answers.map((x) => x.a)].filter(Boolean).join(". ");
  await saveVars(db, run, vars);
  if (tip) await sendEngineText(db, run, node.node_key, tip, "service_guide_tip");
  return advanceFromNodeKey(db, run, cfg.next_node_key, nodes);
}

// ============================================================
// Gentle reminders with buttons (see sendIdleNudge) and the two-hour
// recovery of a list left half-way. In-memory timers, like follow-ups.
// ============================================================

const NUDGE_GO_PREFIX = "nudge_go:";
const NUDGE_MENU_PREFIX = "nudge_menu:";
const RECOVER_GO_PREFIX = "recover_go:";
const RECOVER_LATER_PREFIX = "recover_later:";
// Two hours; FLOW_RECOVERY_DELAY_MS shortens it for tests.
const RECOVERY_DELAY_MS = Number(process.env.FLOW_RECOVERY_DELAY_MS) || 2 * 3_600_000;
const pendingRecoveries = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRecovery(db: AdminClient, runId: string, nodeKey: string): void {
  const existing = pendingRecoveries.get(runId);
  if (existing) clearTimeout(existing);
  pendingRecoveries.set(
    runId,
    setTimeout(() => {
      pendingRecoveries.delete(runId);
      sendRecovery(db, runId, nodeKey).catch((err) => console.error("[flows] recovery failed:", err));
    }, RECOVERY_DELAY_MS),
  );
}

/** "Su lista quedó guardada… ¿Seguimos?" — once, in opening hours, if they still haven't moved. */
async function sendRecovery(db: AdminClient, runId: string, nodeKey: string): Promise<void> {
  const run = await loadRun(db, runId);
  if (!run || run.status !== "active" || run.current_node_key !== nodeKey || run.vars.__recovered) return;
  const biz = await bizOf(db, run.account_id);
  if (!isWithinBusinessHours(biz) || !runHoldsList(run)) return;
  const list = Object.entries(run.vars).find(([k, v]) => k.endsWith("_numbered") && typeof v === "string" && v.trim());
  const lines = String(list?.[1] ?? "").split("\n").filter(Boolean);
  const preview = lines.slice(0, 5).join("\n") + (lines.length > 5 ? `\n… (+${lines.length - 5})` : "");
  await saveVars(db, run, { ...run.vars, __recovered: true });
  await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: renderText(biz.texts.recoveryReminder, { lista: preview }),
    buttons: [
      { id: `${RECOVER_GO_PREFIX}${run.id}`, title: "✅ Continuar pedido" },
      { id: `${RECOVER_LATER_PREFIX}${run.id}`, title: "⏰ Más tarde" },
    ],
  });
  await logEvent(db, run.id, "message_sent", nodeKey, { reason: "list_recovery" });
}

/** Taps on the reminder buttons. Null when it isn't one. */
async function handleNudgeReply(
  db: AdminClient,
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
  replyId: string,
): Promise<DispatchInboundResult | null> {
  const prefix = [NUDGE_GO_PREFIX, NUDGE_MENU_PREFIX, RECOVER_GO_PREFIX, RECOVER_LATER_PREFIX].find((p) =>
    replyId.startsWith(p),
  );
  if (!prefix) return null;
  const run = await loadRun(db, replyId.slice(prefix.length));
  if (!run || run.account_id !== input.accountId || run.contact_id !== input.contactId) {
    return { consumed: true, outcome: "no_match" };
  }
  const recovery = pendingRecoveries.get(run.id);
  if (recovery) clearTimeout(recovery);
  pendingRecoveries.delete(run.id);

  if (prefix === RECOVER_LATER_PREFIX) {
    await sendEngineText(db, run, null, (await bizOf(db, run.account_id)).texts.recoveryLater, "recovery_later");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }
  if (prefix === NUDGE_MENU_PREFIX || run.status !== "active" || !run.current_node_key) {
    if (run.status === "active") await endRun(db, run.id, "timed_out", "menu_from_reminder");
    const flow = await findDefaultEntryFlow(db, input.accountId);
    if (!flow?.entry_node_id) return { consumed: true, outcome: "no_match" };
    return startNewRun(db, flow, input, await loadAllNodes(db, flow.id));
  }
  // Continue: show the step they were on again — or, from the two-hour
  // reminder, go straight to their list to send it.
  const nodes = await loadAllNodes(db, run.flow_id);
  let target = run.current_node_key;
  if (prefix === RECOVER_GO_PREFIX) {
    const listStep = [...nodes.values()].find((n) => !!textFallbackOf(n)?.edit_list_var);
    if (listStep) target = listStep.node_key;
  }
  const outcome = await advanceFromNodeKey(db, run, target, nodes);
  return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
}

/**
 * Products picked in the product picker (/pedir/<token>) arrive here:
 * they're added to the customer's list in the main flow (a new quiet
 * run if there's none) and the bot shows the list step ("Su lista … ¿Cómo
 * desea su factura?") with the estimated total. Lines carry price and
 * code (see catalog/order-lines.ts); the customer's note is added as
 * typed lines.
 */
export async function receiveCatalogOrder(args: {
  accountId: string;
  contactId: string;
  conversationId: string;
  lines: string[];
  note?: string;
}): Promise<{ ok: true; flow_run_id: string } | { ok: false; error: string }> {
  const db = supabaseAdmin();
  const flow = await findDefaultEntryFlow(db, args.accountId);
  if (!flow?.entry_node_id) return { ok: false, error: "no_flow" };
  const nodes = await loadAllNodes(db, flow.id);
  const listNode = [...nodes.values()].find((n) => !!textFallbackOf(n)?.edit_list_var);
  const listVar = listNode ? textFallbackOf(listNode)!.edit_list_var! : null;
  if (!listNode || !listVar) return { ok: false, error: "no_list_step" };

  const { data: config } = await db
    .from("whatsapp_config")
    .select("user_id")
    .eq("account_id", args.accountId)
    .maybeSingle();
  const userId = (config as { user_id?: string } | null)?.user_id;
  if (!userId) return { ok: false, error: "no_whatsapp_config" };

  let run = await loadActiveRunForContact(db, args.accountId, args.contactId);
  if (run && run.flow_id !== flow.id) {
    await endRun(db, run.id, "timed_out", "catalog_order");
    run = null;
  }
  if (!run) {
    const started = await startNewRun(
      db,
      flow,
      {
        accountId: args.accountId,
        userId,
        contactId: args.contactId,
        conversationId: args.conversationId,
        message: { kind: "text", text: "", meta_message_id: `catalog-${Date.now()}` },
      },
      nodes,
      { silent: true },
    );
    run = started.flow_run_id ? await loadRun(db, started.flow_run_id) : null;
    if (!run) return { ok: false, error: "run_not_started" };
  }

  const noteLines = (args.note ?? "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 20);
  const existing = typeof run.vars[listVar] === "string" ? (run.vars[listVar] as string).trim() : "";
  const list = [existing, ...args.lines, ...noteLines].filter(Boolean).join("\n");
  const vars: Record<string, unknown> = {
    ...run.vars,
    [listVar]: list,
    [`${listVar}_numbered`]: numberLines(list),
    [`${listVar}_last`]: args.lines.length ? `${args.lines.length} producto(s) del catálogo` : noteLines.join(", "),
    __from_catalog: true,
  };
  for (const k of ["__pending_clarification", "__pending_line_edit", "__pending_list_answer", "__pending_disambiguation", "__pending_guide", "__offered_product"]) {
    delete vars[k];
  }
  await saveVars(db, run, vars);
  clearPendingDebounce(run.id);
  clearPendingIdleNudge(run.id);
  await logEvent(db, run.id, "node_entered", listNode.node_key, { reason: "catalog_order", lines: args.lines.length });
  await advanceFromNodeKey(db, run, listNode.node_key, nodes);
  return { ok: true, flow_run_id: run.id };
}

/** Run vars from a saved profile: greeting name and invoice data. */
function profileVars(p: CustomerProfile, current: Record<string, unknown>): Record<string, unknown> {
  return {
    contact_name: p.name ? ` ${greetingName(p.name)}` : current.contact_name ?? "",
    customer_registered: "si",
    billing_info: billingLine(p),
    billing_line: billingLine(p),
  };
}

/**
 * A new run's first vars: `contact_name` (" Juan", or "" — so
 * "¡Hola{{vars.contact_name}}!" reads right either way) and, for a
 * registered customer, the name they gave and their invoice data (see
 * customer-profile.ts). Best-effort: a lookup failure only means an
 * unpersonalized greeting.
 */
async function customerStartVars(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<Record<string, unknown>> {
  let contactName = "";
  try {
    const { data: contactRow } = await db.from("contacts").select("name").eq("id", contactId).maybeSingle();
    const rawName = (contactRow as { name?: string | null } | null)?.name;
    if (typeof rawName === "string" && rawName.trim().length > 0) {
      contactName = ` ${rawName.trim().split(/\s+/)[0]}`;
    }
  } catch (err) {
    console.error("[flows] contact name lookup failed:", err);
  }
  try {
    const biz = await bizOf(db, accountId);
    const profile = await loadCustomerProfile(db, accountId, contactId, biz.idNumberFieldName);
    if (profile) return { contact_name: contactName, ...profileVars(profile, { contact_name: contactName }) };
  } catch (err) {
    console.error("[flows] customer profile lookup failed:", err);
  }
  return { contact_name: contactName };
}

/** The customer's personal product-picker link (24 h), or "" when the CRM has no public address. */
async function catalogLink(db: AdminClient, accountId: string, contactId: string, conversationId: string): Promise<string> {
  try {
    const biz = await bizOf(db, accountId);
    const token = createOrderLinkToken({
      accountId,
      contactId,
      conversationId,
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    });
    return orderLinkUrl(biz.publicAppUrl || process.env.NEXT_PUBLIC_SITE_URL || "", token) ?? "";
  } catch (err) {
    console.error("[flows] catalog link failed:", err);
    return "";
  }
}

// ============================================================
// A cart left in the product picker: one reminder with buttons
// ("Enviar mi pedido" / "Ver carrito") after CART_REMINDER_MS without
// changes, in opening hours and inside the free 24 h window. An
// in-memory timer per cart, plus sweepCartReminders from the cron for
// carts whose timer was lost (restart) or fell outside opening hours.
// ============================================================

const CART_SEND_PREFIX = "cart_send:";
const CART_VIEW_PREFIX = "cart_view:";
// 30 minutes; CART_REMINDER_DELAY_MS shortens it for tests.
export const CART_REMINDER_MS = Number(process.env.CART_REMINDER_DELAY_MS) || 30 * 60_000;
const pendingCartReminders = new Map<string, ReturnType<typeof setTimeout>>();

/** (Re)start the reminder timer for a contact's cart — call after every save. */
export function scheduleCartReminder(accountId: string, contactId: string): void {
  const key = `${accountId}:${contactId}`;
  const existing = pendingCartReminders.get(key);
  if (existing) clearTimeout(existing);
  pendingCartReminders.set(
    key,
    setTimeout(() => {
      pendingCartReminders.delete(key);
      const db = supabaseAdmin();
      loadCart(db, accountId, contactId)
        .then((cart) =>
          cart && !cart.remindedAt && Date.now() - Date.parse(cart.updatedAt) >= CART_REMINDER_MS - 1000
            ? sendCartReminder(db, cart)
            : false,
        )
        .catch((err) => console.error("[flows] cart reminder failed:", err));
    }, CART_REMINDER_MS + 2000),
  );
}

/** Carts due for their reminder (from the cron). Returns how many were reminded. */
export async function sweepCartReminders(db: AdminClient = supabaseAdmin()): Promise<number> {
  let sent = 0;
  for (const cart of await cartsDueForReminder(db, CART_REMINDER_MS)) {
    if (await sendCartReminder(db, cart).catch(() => false)) sent += 1;
  }
  return sent;
}

async function configOwner(db: AdminClient, accountId: string): Promise<string | null> {
  const { data } = await db.from("whatsapp_config").select("user_id").eq("account_id", accountId).maybeSingle();
  return (data as { user_id?: string } | null)?.user_id ?? null;
}

async function sendCartReminder(db: AdminClient, cart: StoredCart): Promise<boolean> {
  if (!cart.conversationId || !cart.items.length) return false;
  const biz = await bizOf(db, cart.accountId);
  // Closed now: the cron tries again once the store opens.
  if (!isWithinBusinessHours(biz)) return false;
  const userId = await configOwner(db, cart.accountId);
  if (!userId) return false;
  const windowOpen = await customerWindowOpen(db, cart.conversationId);
  const { total, units } = await cartOrderLines(db, cart.accountId, cart.items);
  // Claim it first, so the timer and the cron never both send it.
  if (!(await markCartReminded(db, cart))) return false;
  if (!windowOpen || units === 0) return false;
  await engineSendInteractiveButtons({
    accountId: cart.accountId,
    userId,
    conversationId: cart.conversationId,
    contactId: cart.contactId,
    bodyText: renderText(biz.texts.cartReminder, {
      productos: `${units} producto${units === 1 ? "" : "s"}`,
      total: money(total),
    }),
    buttons: [
      { id: `${CART_SEND_PREFIX}${cart.contactId}`, title: "✅ Enviar mi pedido" },
      { id: `${CART_VIEW_PREFIX}${cart.contactId}`, title: "🛒 Ver carrito" },
    ],
  });
  return true;
}

/** Taps on the cart reminder's buttons. Null when it isn't one. */
async function handleCartReply(
  db: AdminClient,
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
  replyId: string,
): Promise<DispatchInboundResult | null> {
  const send = replyId.startsWith(CART_SEND_PREFIX);
  if (!send && !replyId.startsWith(CART_VIEW_PREFIX)) return null;
  const contactId = replyId.slice((send ? CART_SEND_PREFIX : CART_VIEW_PREFIX).length);
  if (contactId !== input.contactId) return { consumed: true, outcome: "no_match" };
  const biz = await bizOf(db, input.accountId);
  const cart = await loadCart(db, input.accountId, input.contactId);
  const reply = (text: string) =>
    engineSendText({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text,
    });
  if (!cart || (!cart.items.length && !cart.note.trim())) {
    await reply(biz.texts.cartEmpty);
    return { consumed: true, outcome: "no_match" };
  }
  if (send) {
    const { lines } = await cartOrderLines(db, input.accountId, cart.items);
    const result = await receiveCatalogOrder({
      accountId: input.accountId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      lines,
      note: cart.note,
    });
    if (!result.ok) {
      console.error("[flows] cart send failed:", result.error);
      return { consumed: false, outcome: "no_match" };
    }
    await clearCart(db, input.accountId, input.contactId);
    return { consumed: true, flow_run_id: result.flow_run_id, outcome: "advanced" };
  }
  const link = await catalogLink(db, input.accountId, input.contactId, input.conversationId);
  if (!link) {
    await reply(biz.texts.cartEmpty);
    return { consumed: true, outcome: "no_match" };
  }
  await engineSendCtaUrl({
    accountId: input.accountId,
    userId: input.userId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    bodyText: biz.texts.cartView,
    buttonText: "🛒 Ver mi carrito",
    url: link,
  });
  return { consumed: true, outcome: "advanced" };
}

/** "Llámenme", "¿me pueden llamar?", "necesito que me llamen". */
export function isCallRequest(text: string): boolean {
  const t = normalizeForMatch(text);
  return t.length <= 120 && /\b(llamenme|llameme|llamame|llamarme|me (pueden|puede|podrian|podria) llamar|que me llamen|me llaman|me llama|necesito una llamada|quiero una llamada|hablar por telefono|llamada telefonica|me devuelven la llamada|devuelvan la llamada)\b/.test(t);
}

const recentCallAlerts = new Map<string, number>();

/** Urgent "call this customer" alert to the whole team, and the customer told when. */
async function requestCallBack(
  db: AdminClient,
  input: DispatchInboundInput,
  run: FlowRunRow | null,
): Promise<void> {
  const biz = await bizOf(db, input.accountId);
  const open = isWithinBusinessHours(biz);
  const reply = open
    ? biz.texts.callRequestOpen
    : renderText(biz.texts.callRequestClosed, { cuando: nextOpeningPhrase(biz) });
  try {
    await engineSendText({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text: reply,
    });
  } catch (err) {
    console.error("[flows] call request reply failed:", err);
  }
  const last = recentCallAlerts.get(input.contactId) ?? 0;
  if (Date.now() - last < 10 * 60_000) return;
  recentCallAlerts.set(input.contactId, Date.now());
  const { data: contact } = await db.from("contacts").select("name, phone").eq("id", input.contactId).maybeSingle();
  const c = contact as { name?: string | null; phone?: string | null } | null;
  const phone = c?.phone ? localPhone(c.phone.replace(/^\+/, ""), biz.phoneCountryCode) : "";
  const who = `${c?.name?.trim() || "Cliente"}${phone ? ` (${phone})` : ""}`;
  const order = run?.vars.order_number ? ` · pedido N° ${run.vars.order_number}` : "";
  await notifyAccountInApp(db, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    title: `📞 LLAMAR AHORA: ${who}`,
    body: `El cliente pidió que lo llamen${order}.${open ? "" : " (Fuera de horario: llamar al abrir.)"}`,
  });
  await notifyStaffOfHandoff(db, {
    accountId: input.accountId,
    contactName: c?.name?.trim() || "Cliente",
    summary: `📞 PIDE QUE LO LLAMEN — ${phone}${order}`,
  }).catch(() => null);
}

/** "Mis pedidos → Historial": the contact's last 3 orders, newest first. */
async function orderHistoryText(db: AdminClient, run: FlowRunRow): Promise<string> {
  const { data } = await db
    .from("flow_runs")
    .select("started_at, vars")
    .eq("account_id", run.account_id)
    .eq("contact_id", run.contact_id!)
    .eq("status", "handed_off")
    .not("vars->>order_number", "is", null)
    .order("started_at", { ascending: false })
    .limit(3);
  const rows = (data ?? []) as { started_at: string; vars: Record<string, unknown> }[];
  if (rows.length === 0) return renderText((await bizOf(db, run.account_id)).orderBoard.statusReplies.none, {});
  const biz = await bizOf(db, run.account_id);
  const day = (iso: string) =>
    new Date(new Date(iso).getTime() + biz.utcOffsetHours * 3_600_000).toISOString().slice(0, 10).split("-").reverse().join("/");
  const items = rows.map((r) => {
    const lines = String(r.vars.order_text ?? r.vars.pst_detalle_resumen ?? "").split("\n").filter(Boolean);
    const shown = lines.slice(0, 3).join(", ") + (lines.length > 3 ? ` y ${lines.length - 3} más` : "");
    return `• *N° ${r.vars.order_number}* (${day(r.started_at)}): ${shown || "—"}`;
  });
  return `🗂️ *Sus últimos pedidos:*\n\n${items.join("\n")}\n\nPara repetir el último, escriba *repetir* 🙂`;
}

/** Open and unassigned: nobody on the team has taken this conversation. */
async function botOwnsConversation(db: AdminClient, conversationId: string): Promise<boolean> {
  const { data: conv } = await db
    .from("conversations")
    .select("status, assigned_agent_id")
    .eq("id", conversationId)
    .maybeSingle();
  const c = conv as { status: string; assigned_agent_id: string | null } | null;
  return !!c && c.status === "open" && !c.assigned_agent_id;
}

async function dispatchInboundToFlowsInner(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    // A staff member clocking in ("turno") — not a customer.
    const checkIn = await handleStaffCheckIn(db, input);
    if (checkIn) return checkIn;

    // A tap on a post-handoff follow-up question belongs to that ended
    // run, whatever the contact is doing now.
    if (input.message.kind === "interactive_reply") {
      const followUpResult = await handleFollowUpReply(db, input, input.message.reply_id);
      if (followUpResult) return followUpResult;
      const csatResult = await handleCsatReply(db, input, input.message.reply_id);
      if (csatResult) return csatResult;
      const nudgeResult = await handleNudgeReply(db, input, input.message.reply_id);
      if (nudgeResult) return nudgeResult;
      const cartResult = await handleCartReply(db, input, input.message.reply_id);
      if (cartResult) return cartResult;
    }

    // "Llámenme" / "¿me pueden llamar?": urgent alert to the team — unless
    // the bot is waiting for typed input (a complaint can say "llámenme").
    if (input.message.kind === "text" && isCallRequest(input.message.text)) {
      const running = await loadActiveRunForContact(db, input.accountId, input.contactId);
      const node = running?.current_node_key ? await loadNode(db, running.flow_id, running.current_node_key) : null;
      if (node?.node_type !== "collect_input") {
        await requestCallBack(db, input, running);
        return { consumed: true, flow_run_id: running?.id, outcome: "no_match" };
      }
    }

    // A message naming a run that's waiting for its customer (web order
    // reference) claims it, even from a different phone.
    if (input.message.kind === "text") {
      const claimed = await claimWaitingRun(db, input);
      if (claimed) return claimed;
    }

    // "¿Dónde está mi pedido?" — answered from the order board.
    if (input.message.kind === "text" && isOrderStatusQuestion(input.message.text)) {
      const answered = await answerOrderStatusQuestion(db, input);
      if (answered) return answered;
    }

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
      // A run waiting for its customer to write first (silent node, e.g.
      // a web order) must not be thrown away by a "hola": that "hola" IS
      // the customer showing up, and continues the run below.
      const waitingNode = activeRun.current_node_key
        ? await loadNode(db, activeRun.flow_id, activeRun.current_node_key)
        : null;
      const isWaitingForCustomer =
        waitingNode?.node_type === "collect_input" &&
        (waitingNode.config as unknown as CollectInputNodeConfig).silent === true;
      // A plain "hola" in the middle of an order would throw the list
      // away; say we're still on it instead ("menú" still starts over).
      if (
        restartFlow?.entry_node_id &&
        !isWaitingForCustomer &&
        input.message.kind === "text" &&
        isPlainGreeting(input.message.text) &&
        runHoldsList(activeRun)
      ) {
        await sendEngineText(
          db,
          activeRun,
          activeRun.current_node_key,
          (await bizOf(db, input.accountId)).texts.resumeOrder,
          "resume_order",
        );
        return { consumed: true, flow_run_id: activeRun.id, outcome: "no_match" };
      }
      if (restartFlow?.entry_node_id && !isWaitingForCustomer) {
        await endRun(db, activeRun.id, "timed_out", "restarted_by_keyword");
        const restartNodes = await loadAllNodes(db, restartFlow.id);
        return startNewRun(db, restartFlow, input, restartNodes);
      }

      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run and a photo: a written list or a product starts an
    // order, as a catalog cart would — only while the bot owns the chat.
    if (input.message.kind === "image") {
      const biz = await bizOf(db, input.accountId);
      if (biz.aiFeatures.readImages && (await botOwnsConversation(db, input.conversationId))) {
        const defaultFlow = await findDefaultEntryFlow(db, input.accountId);
        if (defaultFlow?.entry_node_id) {
          const reading = await readImage(
            db,
            input.accountId,
            input.conversationId,
            input.message.media_url,
            input.message.caption,
          );
          if (reading?.kind === "receipt") {
            await acknowledgeReceipt(db, input, reading, null);
            return { consumed: true, outcome: "no_match" };
          }
          if (reading && reading.kind !== "other") {
            const nodes = await loadAllNodes(db, defaultFlow.id);
            return startNewRun(
              db,
              defaultFlow,
              { ...input, message: linesAsOrder(reading.lines, input.message.meta_message_id) },
              nodes,
            );
          }
        }
      }
      return { consumed: false, outcome: "no_match" };
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
              text: (await bizOf(db, input.accountId)).texts.nonTextReply,
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
      const afterHandoff = await replyAfterHandoff(db, input);
      if (afterHandoff) return afterHandoff;
      // "Quiero 2 panes y una leche" with no conversation open: start the
      // order with those lines instead of leaving it to the chat AI.
      const routed = await startOrderFromFirstMessage(db, input);
      if (routed) return routed;
      return { consumed: false, outcome: "no_match" };
    }
    // "Buenas, quisiera 2 panes y una leche" also matches the greeting
    // keyword — but it's an order, not a request for the menu.
    if (
      input.message.kind === "text" &&
      normalizeForMatch(input.message.text).split(" ").length > RESTART_MAX_WORDS + 1
    ) {
      const routed = await startOrderFromFirstMessage(db, input, true);
      if (routed) return routed;
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
    await sendEngineText(db, run, node.node_key, (await bizOf(db, run.account_id)).texts.editFailed, "list_edit_failed");
    return stay;
  }
  return saveListAndAdvance(db, run, nodes, run.vars, cfg.edit_list_var, keepCatalogLines(lines, edited), cfg.next_node_key);
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
// Order numbers, post-handoff follow-ups and replies — see
// OrderNumberConfig and HandoffNodeConfig.follow_up /
// after_handoff_reply.
// ============================================================

/** See NodeSideEffectsConfig. Best-effort; outcomes are logged on the run. */
async function runNodeSideEffects(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as NodeSideEffectsConfig;

  if (cfg.woo && run.vars.order_id) {
    const result = await updateWooOrder(String(run.vars.order_id), {
      status: cfg.woo.status,
      note: cfg.woo.note ? interpolateVars(cfg.woo.note, run.vars) : undefined,
    }, (await bizOf(db, run.account_id)).woocommerceUrl);
    await logEvent(db, run.id, result.ok ? "node_entered" : "error", node.node_key, {
      reason: result.ok ? "woo_updated" : "woo_update_failed",
      woo: cfg.woo,
      detail: result.error ?? null,
    });
  }

  if (cfg.order_card_stage && typeof run.vars.__deal_id === "string") {
    const { data: deal } = await db
      .from("deals")
      .select("pipeline_id")
      .eq("id", run.vars.__deal_id)
      .maybeSingle();
    const pipelineId = (deal as { pipeline_id?: string } | null)?.pipeline_id;
    if (pipelineId) {
      const { data: stages } = await db
        .from("pipeline_stages")
        .select("id, name")
        .eq("pipeline_id", pipelineId);
      const target = ((stages ?? []) as { id: string; name: string }[]).find(
        (s) => orderStageKind(s.name) === cfg.order_card_stage,
      );
      if (target) {
        await db
          .from("deals")
          .update({ stage_id: target.id, updated_at: new Date().toISOString() })
          .eq("id", run.vars.__deal_id);
      }
    }
  }

  if (cfg.notify_team) {
    await notifyTeamInApp(db, run, node.node_key, {
      title: orderTitle(run, "Pedido"),
      body: interpolateVars(cfg.notify_team, run.vars),
    });
  }

  if (cfg.prefill_last_order) {
    await prefillLastOrder(db, run, node.node_key, cfg.prefill_last_order);
  }

  if (cfg.save_customer_profile && run.contact_id) {
    const key = cfg.save_customer_profile;
    const biz = await bizOf(db, run.account_id);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(run.vars)) {
      if (k.startsWith(`${key}_`)) fields[k.slice(key.length + 1)] = v;
    }
    const typed = typeof run.vars[key] === "string" ? (run.vars[key] as string) : "";
    const fromForm = ["nombre", "cedula", "correo"].some((k) => k in fields);
    const refused = !fromForm && isRefusal(typed);
    const parsed = parseCustomerProfile(fromForm ? { fields } : { text: typed }, biz.phoneCountryCode);
    let vars: Record<string, unknown>;
    if (refused) {
      vars = { ...run.vars, profile_ok: "", profile_refused: "si", profile_problem: "" };
    } else if (parsed.ok) {
      try {
        await saveCustomerProfile(db, {
          accountId: run.account_id,
          userId: run.user_id,
          contactId: run.contact_id,
          idFieldName: biz.idNumberFieldName,
          profile: parsed.profile,
        });
      } catch (err) {
        // Not kept for next time, but this order still carries the data.
        console.error("[flows] saving the customer profile failed:", err);
      }
      vars = { ...run.vars, ...profileVars(parsed.profile, run.vars), profile_ok: "si", profile_problem: "" };
    } else {
      vars = { ...run.vars, profile_ok: "", profile_problem: profileProblemText(parsed) };
    }
    // Typed data that isn't complete stays, so the next message adds to
    // it (minus a wrong ID number, to be typed again); otherwise the raw
    // answers go — kept on the contact when valid, and never mistaken
    // for an order list (the "su lista quedó guardada" reminder reads
    // *_numbered).
    if (!parsed.ok && !fromForm && !refused) {
      vars[key] = parsed.problem === "id" ? typed.replace(/\d[\d .-]{8,20}\d/g, " ").trim() : typed;
    } else {
      delete vars[key];
    }
    for (const k of Object.keys(fields)) delete vars[`${key}_${k}`];
    await saveVars(db, run, vars);
    await logEvent(db, run.id, "node_entered", node.node_key, {
      reason: refused ? "customer_profile_refused" : parsed.ok ? "customer_profile_saved" : "customer_profile_invalid",
      problem: refused || parsed.ok ? null : parsed.problem,
    });
  }

  if (cfg.catalog_link && run.contact_id && run.conversation_id) {
    const link = await catalogLink(db, run.account_id, run.contact_id, run.conversation_id);
    await saveVars(db, run, { ...run.vars, catalog_link: link });
  }

  if (cfg.list_total) {
    const list = typeof run.vars[cfg.list_total] === "string" ? (run.vars[cfg.list_total] as string) : "";
    await saveVars(db, run, { ...run.vars, order_total_line: totalLine(list) });
  }

  if (cfg.order_history_reply && run.contact_id) {
    await sendEngineText(db, run, node.node_key, await orderHistoryText(db, run), "order_history_reply");
  }

  if (cfg.call_request && run.contact_id && run.conversation_id) {
    await requestCallBack(
      db,
      { accountId: run.account_id, userId: run.user_id, contactId: run.contact_id, conversationId: run.conversation_id, message: { kind: "text", text: "", meta_message_id: "" } },
      run,
    );
  }

  if (cfg.order_status_reply && run.contact_id) {
    const status = await orderStatusText(db, run.account_id, run.contact_id);
    await sendEngineText(db, run, node.node_key, status.text, "order_status_reply");
  }
}

/** See NodeSideEffectsConfig.prefill_last_order. */
async function prefillLastOrder(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string,
  listVar: string,
): Promise<void> {
  // The var name goes into a PostgREST JSON filter — keep it a plain key.
  if (!run.contact_id || !/^\w+$/.test(listVar)) return;
  const { data } = await db
    .from("flow_runs")
    .select("id, vars")
    .eq("account_id", run.account_id)
    .eq("contact_id", run.contact_id)
    .eq("flow_id", run.flow_id)
    .eq("status", "handed_off")
    .neq("id", run.id)
    .not(`vars->>${listVar}`, "is", null)
    .order("started_at", { ascending: false })
    .limit(1);
  const previous = ((data ?? []) as { id: string; vars: Record<string, unknown> }[])[0];
  const list = typeof previous?.vars[listVar] === "string"
    ? (previous.vars[listVar] as string).trim()
    : "";
  if (!list) {
    await logEvent(db, run.id, "node_entered", nodeKey, { reason: "no_previous_order" });
    return;
  }
  await saveVars(db, run, {
    ...run.vars,
    [listVar]: list,
    [`${listVar}_numbered`]: numberLines(list),
    __repeated_from_run: previous.id,
  });
  await logEvent(db, run.id, "node_entered", nodeKey, {
    reason: "prefilled_last_order",
    from_run: previous.id,
  });
}

const ORDER_STATUS_LOOKBACK_MS = 30 * 86_400_000;

/**
 * What to tell a customer asking where their order is: the status reply
 * for their latest card on the order board (last 30 days), or the "no
 * recent order" text. `found` says whether there was a card.
 */
async function orderStatusText(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<{ found: boolean; text: string }> {
  const biz = await bizOf(db, accountId);
  const board = await findOrderPipeline(db, accountId);
  if (board) {
    const { data } = await db
      .from("deals")
      .select("title, stage_id")
      .eq("account_id", accountId)
      .eq("pipeline_id", board.pipelineId)
      .eq("contact_id", contactId)
      .gte("created_at", new Date(Date.now() - ORDER_STATUS_LOOKBACK_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const deal = data as { title: string; stage_id: string } | null;
    if (deal) {
      const { data: stage } = await db
        .from("pipeline_stages")
        .select("name")
        .eq("id", deal.stage_id)
        .maybeSingle();
      const kind = orderStageKind((stage as { name?: string } | null)?.name ?? "");
      return { found: true, text: statusReply(kind, orderRefFromTitle(deal.title), biz) };
    }
  }
  return { found: false, text: renderText(biz.orderBoard.statusReplies.none, {}) };
}

/**
 * A customer asking in their own words where their order is. Answered
 * from the board when they have a recent order. With no order: answered
 * with the "no recent order" text only when no bot conversation is in
 * progress — a run mid-way (e.g. a web order waiting for this very
 * message) handles the message itself.
 */
async function answerOrderStatusQuestion(
  db: AdminClient,
  input: DispatchInboundInput,
): Promise<DispatchInboundResult | null> {
  if (await isDuplicateInbound(db, input.accountId, input.contactId, input.message.meta_message_id)) {
    return null;
  }
  const status = await orderStatusText(db, input.accountId, input.contactId);
  const activeRun = await loadActiveRunForContact(db, input.accountId, input.contactId);
  if (activeRun) {
    const node = activeRun.current_node_key
      ? await loadNode(db, activeRun.flow_id, activeRun.current_node_key)
      : null;
    // A run asking for typed input (a complaint, billing data, a web
    // order waiting for this message…) owns the reply: "el pedido llegó
    // incompleto" there is a complaint, not a status question.
    if (!status.found || node?.node_type === "collect_input") return null;
  }
  try {
    await engineSendText({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text: status.text,
    });
  } catch (err) {
    console.error("[flows] order status reply failed:", err);
    return null;
  }
  return { consumed: true, flow_run_id: activeRun?.id, outcome: "no_match" };
}

async function assignServiceNumber(db: AdminClient, run: FlowRunRow): Promise<void> {
  if (run.vars.service_number) return;
  const { count } = await db
    .from("flow_runs")
    .select("id", { count: "exact", head: true })
    .eq("account_id", run.account_id)
    .not("vars->>service_number", "is", null);
  await saveVars(db, run, {
    ...run.vars,
    service_number: `S-${String((count ?? 0) + 1).padStart(4, "0")}`,
  });
}

async function assignOrderNumber(db: AdminClient, run: FlowRunRow): Promise<void> {
  if (run.vars.order_number) return;
  // Count-based, not a DB sequence: two orders confirmed in the same
  // instant could share a number — rare at this volume, and the number
  // is a human reference, never a key.
  const { count } = await db
    .from("flow_runs")
    .select("id", { count: "exact", head: true })
    .eq("account_id", run.account_id)
    .not("vars->>order_number", "is", null);
  await saveVars(db, run, {
    ...run.vars,
    order_number: String((count ?? 0) + 1).padStart(4, "0"),
  });
}

/** WhatsApp-template alert to staff numbers, with the customer's phone
 *  (staff act from their own phones, often before the customer reaches
 *  them, so a name alone isn't enough to get back to them). Each send
 *  is logged with its message id, so a failure Meta reports later (see
 *  recordDeliveryFailure) lands on this run instead of only in logs. */
async function alertStaff(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string | null,
  summary: string,
): Promise<NotifyStaffResult> {
  const contactNameVar = run.vars.contact_name;
  const { data: contactRow } = await db
    .from("contacts")
    .select("phone")
    .eq("id", run.contact_id!)
    .maybeSingle();
  const cc = (await bizOf(db, run.account_id)).phoneCountryCode;
  const phone = localPhone((contactRow as { phone?: string } | null)?.phone ?? "", cc);
  const result = await notifyStaffOfHandoff(db, {
    accountId: run.account_id,
    contactName: typeof contactNameVar === "string" ? contactNameVar.trim() : "",
    summary: phone ? `📞 ${phone} · ${summary}` : summary,
  });
  for (const s of result.sent) {
    await logEvent(db, run.id, "message_sent", nodeKey, {
      reason: "staff_alert",
      to: localPhone(s.phone, cc),
      whatsapp_message_id: s.messageId,
    });
  }
  if (result.failed.length > 0 || result.skipped.length > 0) {
    await logEvent(db, run.id, "error", nodeKey, {
      reason: result.failed.length > 0 ? "staff_notify_failed" : "staff_not_on_shift",
      failed: result.failed,
      not_on_shift: result.skipped.map((p) => localPhone(p, cc)),
    });
  }
  return result;
}

/** "Pedido N° 0015 — Juan" / "Pedido web N° 45637 — Diego" for the board. */
function orderCardTitle(run: FlowRunRow): string {
  const name =
    typeof run.vars.contact_name === "string" && run.vars.contact_name.trim()
      ? ` — ${run.vars.contact_name.trim()}`
      : "";
  if (run.vars.service_number) return `Servicio N° ${run.vars.service_number}${name}`;
  if (run.vars.order_number) return `Pedido N° ${run.vars.order_number}${name}`;
  if (run.vars.order_id) return `Pedido web N° ${run.vars.order_id}${name}`;
  return `Pedido${name}`;
}

function orderTitle(run: FlowRunRow, fallback: string): string {
  const name =
    typeof run.vars.contact_name === "string" && run.vars.contact_name.trim()
      ? ` — ${run.vars.contact_name.trim()}`
      : "";
  if (run.vars.service_number) return `🔧 Servicio N° ${run.vars.service_number}${name}`;
  if (run.vars.order_number) return `🧾 Pedido N° ${run.vars.order_number}${name}`;
  if (run.vars.order_id) return `🛒 Pedido web N° ${run.vars.order_id}${name}`;
  return `${fallback}${name}`;
}

/** One in-app notification per account member (plus extra user ids). */
async function notifyTeamInApp(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string | null,
  args: { title: string; body: string; extraUserIds?: string[] },
): Promise<void> {
  try {
    const error = await notifyAccountInApp(db, {
      accountId: run.account_id,
      conversationId: run.conversation_id,
      contactId: run.contact_id,
      title: args.title,
      body: args.body,
      extraUserIds: args.extraUserIds,
    });
    if (error) {
      await logEvent(db, run.id, "error", nodeKey, {
        reason: "in_app_notify_failed",
        detail: error,
      });
    }
  } catch (err) {
    await logEvent(db, run.id, "error", nodeKey, {
      reason: "in_app_notify_threw",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

interface FollowUpState extends HandoffFollowUpConfig {
  asked: number;
  reminded: number;
  done: boolean;
  /** The handoff note, repeated in staff reminders. */
  summary: string;
}

const FOLLOW_UP_YES_PREFIX = "followup_yes:";
const FOLLOW_UP_NO_PREFIX = "followup_no:";
const pendingFollowUps = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleFollowUp(db: AdminClient, runId: string, minutes: number): void {
  const existing = pendingFollowUps.get(runId);
  if (existing) clearTimeout(existing);
  if (!minutes || minutes <= 0) return;
  const timer = setTimeout(() => {
    pendingFollowUps.delete(runId);
    runFollowUp(db, runId).catch((err) => console.error("[flows] follow-up failed:", err));
  }, minutes * 60_000);
  pendingFollowUps.set(runId, timer);
}

async function loadRun(db: AdminClient, runId: string): Promise<FlowRunRow | null> {
  const { data } = await db.from("flow_runs").select("*").eq("id", runId).maybeSingle();
  return (data as FlowRunRow | null) ?? null;
}

/**
 * True once someone is evidently handling it: the conversation was
 * closed, or staff replied from the inbox after the handoff.
 */
async function humanHasTakenOver(db: AdminClient, run: FlowRunRow): Promise<boolean> {
  if (!run.conversation_id) return true;
  const { data: conv } = await db
    .from("conversations")
    .select("status")
    .eq("id", run.conversation_id)
    .maybeSingle();
  if ((conv as { status?: string } | null)?.status === "closed") return true;
  const { count } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", run.conversation_id)
    .eq("sender_type", "agent")
    .gt("created_at", run.ended_at ?? run.started_at);
  return (count ?? 0) > 0;
}

async function remindStaff(db: AdminClient, run: FlowRunRow, state: FollowUpState): Promise<void> {
  state.reminded += 1;
  const order = run.vars.order_number ? `Pedido N° ${run.vars.order_number} · ` : "";
  const text = `⚠️ RECORDATORIO ${state.reminded}/${state.max}: sigue sin atender · ${order}${state.summary}`;
  await alertStaff(db, run, null, text).catch((err) =>
    console.error("[flows] staff reminder failed:", err),
  );
  await notifyTeamInApp(db, run, null, {
    title: `⚠️ ${orderTitle(run, "Pedido")} sigue sin atender`,
    body: text,
  });
}

async function runFollowUp(db: AdminClient, runId: string): Promise<void> {
  const run = await loadRun(db, runId);
  const state = run?.vars.__follow_up as FollowUpState | undefined;
  if (!run || !state || state.done) return;
  // Opening hours only; out of hours the customer already has the
  // "we'll attend you when we open" note.
  if (!isWithinBusinessHours(await bizOf(db, run.account_id)) || (await humanHasTakenOver(db, run))) return;

  if (state.asked < state.max) {
    state.asked += 1;
    try {
      await engineSendInteractiveButtons({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        bodyText: interpolateVars(state.question, run.vars),
        buttons: [
          { id: `${FOLLOW_UP_YES_PREFIX}${run.id}`, title: "✅ Sí" },
          { id: `${FOLLOW_UP_NO_PREFIX}${run.id}`, title: "⏳ Aún no" },
        ],
      });
    } catch (err) {
      console.error("[flows] follow-up question failed:", err);
    }
  }
  if (state.reminded < state.max) await remindStaff(db, run, state);
  await saveVars(db, run, { ...run.vars, __follow_up: state });
  if (state.asked < state.max) scheduleFollowUp(db, run.id, state.every_minutes);
}

/** Handles a tap on a follow-up question; null if it isn't one. */
async function handleFollowUpReply(
  db: AdminClient,
  input: DispatchInboundInput,
  replyId: string,
): Promise<DispatchInboundResult | null> {
  const yes = replyId.startsWith(FOLLOW_UP_YES_PREFIX);
  if (!yes && !replyId.startsWith(FOLLOW_UP_NO_PREFIX)) return null;
  const runId = replyId.slice((yes ? FOLLOW_UP_YES_PREFIX : FOLLOW_UP_NO_PREFIX).length);
  const run = await loadRun(db, runId);
  if (!run || run.account_id !== input.accountId || run.contact_id !== input.contactId) {
    return { consumed: true, outcome: "no_match" };
  }
  const state = run.vars.__follow_up as FollowUpState | undefined;
  if (!state) return { consumed: true, outcome: "no_match" };

  if (yes) {
    state.done = true;
    const timer = pendingFollowUps.get(run.id);
    if (timer) clearTimeout(timer);
    pendingFollowUps.delete(run.id);
    await saveVars(db, run, { ...run.vars, __follow_up: state });
    await sendEngineText(db, run, null, (await bizOf(db, run.account_id)).texts.followUpYes, "follow_up_yes");
  } else {
    if (state.reminded < state.max) await remindStaff(db, run, state);
    await saveVars(db, run, { ...run.vars, __follow_up: state });
    await sendEngineText(db, run, null, (await bizOf(db, run.account_id)).texts.followUpNo, "follow_up_no");
  }
  return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
}

/**
 * A tap on the satisfaction survey sent when an order card reaches
 * "Entregado" (see lib/pipelines/order-stages.ts): the rating is added
 * to the card's notes, the customer is thanked, and a bad rating
 * alerts the whole team in the CRM. Null if it isn't a survey tap.
 */
async function handleCsatReply(
  db: AdminClient,
  input: DispatchInboundInput,
  replyId: string,
): Promise<DispatchInboundResult | null> {
  const parsed = parseCsatReplyId(replyId);
  if (!parsed) return null;
  const { data } = await db
    .from("deals")
    .select("id, title, notes, account_id")
    .eq("id", parsed.dealId)
    .maybeSingle();
  const deal = data as { id: string; title: string; notes: string | null; account_id: string } | null;
  if (!deal || deal.account_id !== input.accountId) return { consumed: true, outcome: "no_match" };

  const label = parsed.key === "excelente" ? "⭐ Excelente" : parsed.key === "bien" ? "👍 Bien" : "👎 Mal";
  await db
    .from("deals")
    .update({ notes: `${deal.notes ?? ""}\n\nCalificación del cliente: ${label}`.trim() })
    .eq("id", deal.id);
  try {
    await engineSendText({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text: csatThanks(parsed.key, await bizOf(db, input.accountId)),
    });
  } catch (err) {
    console.error("[flows] csat thanks failed:", err);
  }
  if (parsed.key === "mal") {
    await notifyAccountInApp(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      title: `👎 Cliente insatisfecho — ${deal.title}`,
      body: "Calificó la atención como mala. Escríbale para saber qué pasó.",
    });
  }
  return { consumed: true, outcome: "no_match" };
}

const AFTER_HANDOFF_WINDOW_MS = 12 * 3_600_000;
const AFTER_HANDOFF_MIN_GAP_MS = 30 * 60_000;

/**
 * A customer writing again after their order was handed off used to
 * get silence (the conversation is a human's now, so the AI stays
 * quiet). Until staff actually reply, answer with the handoff node's
 * `after_handoff_reply` — at most every 30 minutes, for 12 hours.
 */
async function replyAfterHandoff(
  db: AdminClient,
  input: DispatchInboundInput,
): Promise<DispatchInboundResult | null> {
  if (input.message.kind !== "text") return null;
  const { data } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", input.accountId)
    .eq("contact_id", input.contactId)
    .eq("status", "handed_off")
    .order("ended_at", { ascending: false })
    .limit(1);
  const run = ((data as FlowRunRow[] | null) ?? [])[0];
  const template = run?.vars.__after_handoff_reply;
  if (!run || typeof template !== "string" || !run.ended_at) return null;
  const now = Date.now();
  if (now - new Date(run.ended_at).getTime() > AFTER_HANDOFF_WINDOW_MS) return null;
  const texts = (await bizOf(db, input.accountId)).texts;
  const ref = run.vars.order_number ? `N° ${run.vars.order_number}` : run.vars.order_id ? `N° ${run.vars.order_id}` : "";
  // "¿Cuánto es el total?": keep them engaged and tell staff right away
  // (a customer asking the total is ready to pay).
  if (isPriceQuestion(input.message.text) && !(await humanHasTakenOver(db, run))) {
    await sendEngineText(db, run, null, renderText(texts.totalPending, { pedido: ref }), "total_pending");
    const lastAlert = typeof run.vars.__total_alert_at === "string" ? new Date(run.vars.__total_alert_at).getTime() : 0;
    if (now - lastAlert > 10 * 60_000) {
      await saveVars(db, run, { ...run.vars, __total_alert_at: new Date(now).toISOString() });
      await notifyTeamInApp(db, run, null, {
        title: `💰 ${orderTitle(run, "Cliente")} pide el TOTAL`,
        body: `El cliente pregunta cuánto debe pagar por su pedido ${ref}. Envíele el total por el chat.`,
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }
  // A plain "gracias" gets a short "con gusto", not the whole reminder.
  if (isAckOnly(input.message.text)) {
    const lastThanks = typeof run.vars.__thanks_at === "string" ? new Date(run.vars.__thanks_at).getTime() : 0;
    if (now - lastThanks < AFTER_HANDOFF_MIN_GAP_MS) return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
    await saveVars(db, run, { ...run.vars, __thanks_at: new Date(now).toISOString() });
    await sendEngineText(db, run, null, texts.thanksReply, "thanks_reply");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }
  const lastAck = typeof run.vars.__after_handoff_ack_at === "string"
    ? new Date(run.vars.__after_handoff_ack_at).getTime()
    : 0;
  if (now - lastAck < AFTER_HANDOFF_MIN_GAP_MS) return null;
  if (await humanHasTakenOver(db, run)) return null;
  // Staff moving the order's card means someone is on it — "your order
  // is with our advisor, send them your list" would be stale by then.
  if (typeof run.vars.__deal_id === "string") {
    const { data: deal } = await db
      .from("deals")
      .select("stage_id")
      .eq("id", run.vars.__deal_id)
      .maybeSingle();
    const stageId = (deal as { stage_id?: string } | null)?.stage_id;
    if (stageId) {
      const { data: stage } = await db.from("pipeline_stages").select("name").eq("id", stageId).maybeSingle();
      const kind = orderStageKind((stage as { name?: string } | null)?.name ?? "");
      if (kind && kind !== "new") return null;
    }
  }

  await saveVars(db, run, { ...run.vars, __after_handoff_ack_at: new Date(now).toISOString() });
  await sendEngineText(db, run, null, interpolateVars(template, run.vars), "after_handoff_reply");
  return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
}

// ============================================================
// Staff check-in — see whatsapp/staff-notify.ts. A WhatsApp alert to a
// staff number is only free (and, without a Meta payment method, only
// delivered at all) within 24h of that number writing to the bot. So
// staff write "turno" when their shift starts; the bot confirms until
// when their alerts are on, instead of showing them the customer menu.
// ============================================================

export function isStaffCheckInText(biz: BusinessSettings, text: string): boolean {
  const said = normalizeForMatch(text);
  return biz.checkInWords.some((w) => normalizeForMatch(w) === said);
}

export function checkInReply(biz: BusinessSettings, now: Date = new Date()): string {
  const until = new Date(now.getTime() + 24 * 3_600_000 + biz.utcOffsetHours * 3_600_000);
  const hh = String(until.getUTCHours()).padStart(2, "0");
  const mm = String(until.getUTCMinutes()).padStart(2, "0");
  return renderText(biz.texts.checkIn, { hasta: `${hh}:${mm}` });
}

async function handleStaffCheckIn(
  db: AdminClient,
  input: DispatchInboundInput,
): Promise<DispatchInboundResult | null> {
  if (input.message.kind !== "text") return null;
  const biz = await bizOf(db, input.accountId);
  if (!isStaffCheckInText(biz, input.message.text)) return null;
  const staff = getStaffPhones(biz);
  if (staff.length === 0) return null;
  const { data: contact } = await db
    .from("contacts")
    .select("phone")
    .eq("id", input.contactId)
    .maybeSingle();
  const phone = toInternational((contact as { phone?: string } | null)?.phone ?? "", biz.phoneCountryCode);
  if (!phone || !staff.includes(phone)) return null;
  try {
    await engineSendText({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text: checkInReply(biz),
    });
  } catch (err) {
    console.error("[flows] staff check-in reply failed:", err);
  }
  return { consumed: true, outcome: "no_match" };
}

// ============================================================
// Runs waiting for their customer to write first — see
// CollectInputNodeConfig.silent / claim_pattern.
// ============================================================

async function loadNode(
  db: AdminClient,
  flowId: string,
  nodeKey: string,
): Promise<FlowNodeRow | null> {
  const { data } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId)
    .eq("node_key", nodeKey)
    .maybeSingle();
  return (data as FlowNodeRow | null) ?? null;
}

/**
 * If this text names a run that's waiting for its customer at a node
 * with `claim_pattern` (e.g. "Pedido N°: 45635" for a web order placed
 * with another phone), move that run to the sender and continue it with
 * this message. Null when nothing is claimed — including when the run
 * already belongs to this sender (the normal path handles that).
 */
async function claimWaitingRun(
  db: AdminClient,
  input: DispatchInboundInput,
): Promise<DispatchInboundResult | null> {
  if (input.message.kind !== "text") return null;
  const text = input.message.text;
  const { data } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", input.accountId)
    .eq("status", "active")
    .neq("contact_id", input.contactId)
    .limit(200);
  for (const run of (data as FlowRunRow[] | null) ?? []) {
    if (!run.current_node_key) continue;
    const node = await loadNode(db, run.flow_id, run.current_node_key);
    const cfg = node?.config as unknown as CollectInputNodeConfig | undefined;
    if (!node || node.node_type !== "collect_input" || !cfg?.silent) continue;
    if (!cfg.claim_pattern || !cfg.claim_var) continue;
    let match: RegExpMatchArray | null = null;
    try {
      match = text.match(new RegExp(cfg.claim_pattern, "i"));
    } catch {
      continue;
    }
    if (!match?.[1] || String(run.vars[cfg.claim_var] ?? "") !== match[1]) continue;

    // The sender can only have one active run: theirs gives way.
    const theirs = await loadActiveRunForContact(db, input.accountId, input.contactId);
    if (theirs) await endRun(db, theirs.id, "timed_out", "superseded_by_claimed_run");
    const { error } = await db
      .from("flow_runs")
      .update({ contact_id: input.contactId, conversation_id: input.conversationId })
      .eq("id", run.id)
      .eq("status", "active");
    if (error) {
      console.error("[flows] claim run failed:", error.message);
      return null;
    }
    run.contact_id = input.contactId;
    run.conversation_id = input.conversationId;
    // The order's card follows: column messages, "¿dónde está mi
    // pedido?" and the survey must reach the phone that actually wrote.
    if (typeof run.vars.__deal_id === "string") {
      await db
        .from("deals")
        .update({ contact_id: input.contactId, conversation_id: input.conversationId })
        .eq("id", run.vars.__deal_id);
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      claimed_by_contact: input.contactId,
      claimed_ref: match[1],
    });
    const nodes = await loadAllNodes(db, run.flow_id);
    return handleReplyForActiveRun(db, run, input.message, nodes);
  }
  return null;
}

const CATCH_UP_WINDOW_MS = 30 * 60_000;

/**
 * WooCommerce can deliver its order webhook after the buyer already
 * wrote ("🛒 Nuevo Pedido … N°: 45635"). A run that starts waiting for
 * that message would then wait forever — so right after starting, look
 * back 30 minutes for a customer message naming this run's reference
 * (per the waiting node's claim_pattern), from any phone, and continue
 * with it. Returns null when there's nothing to catch up on.
 */
export async function catchUpWaitingRun(
  db: AdminClient,
  runId: string,
): Promise<DispatchInboundResult | null> {
  const run = await loadRun(db, runId);
  if (!run || run.status !== "active" || !run.current_node_key) return null;
  const node = await loadNode(db, run.flow_id, run.current_node_key);
  const cfg = node?.config as unknown as CollectInputNodeConfig | undefined;
  if (!node || !cfg?.silent || !cfg.claim_pattern || !cfg.claim_var) return null;
  const ref = String(run.vars[cfg.claim_var] ?? "");
  if (!ref) return null;

  const { data } = await db
    .from("messages")
    .select("message_id, content_text, conversation_id, conversations!inner(account_id, contact_id)")
    .eq("sender_type", "customer")
    .eq("conversations.account_id", run.account_id)
    .ilike("content_text", `%${ref}%`)
    .gte("created_at", new Date(Date.now() - CATCH_UP_WINDOW_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(20);
  let pattern: RegExp;
  try {
    pattern = new RegExp(cfg.claim_pattern, "i");
  } catch {
    return null;
  }
  const hit = ((data ?? []) as unknown as Array<{
    message_id: string;
    content_text: string | null;
    conversation_id: string;
    conversations: { account_id: string; contact_id: string };
  }>).find((m) => m.content_text?.match(pattern)?.[1] === ref);
  if (!hit) return null;

  if (hit.conversations.contact_id !== run.contact_id) {
    const theirs = await loadActiveRunForContact(db, run.account_id, hit.conversations.contact_id);
    if (theirs) await endRun(db, theirs.id, "timed_out", "superseded_by_claimed_run");
    await db
      .from("flow_runs")
      .update({ contact_id: hit.conversations.contact_id, conversation_id: hit.conversation_id })
      .eq("id", run.id);
    run.contact_id = hit.conversations.contact_id;
    run.conversation_id = hit.conversation_id;
  }
  await logEvent(db, run.id, "node_entered", node.node_key, { caught_up_ref: ref });
  const nodes = await loadAllNodes(db, run.flow_id);
  return handleReplyForActiveRun(
    db,
    run,
    { kind: "text", text: hit.content_text ?? "", meta_message_id: hit.message_id },
    nodes,
  );
}

/**
 * Meta reports a failed delivery asynchronously (a status webhook), long
 * after the send call succeeded. Record why on the flow run that sent
 * it, so a silent "the customer never got it" is visible and explained.
 */
export async function recordDeliveryFailure(
  whatsappMessageId: string,
  errors: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>,
): Promise<void> {
  const db = supabaseAdmin();
  const first = errors[0] ?? {};
  const detail = {
    reason: "delivery_failed",
    whatsapp_message_id: whatsappMessageId,
    code: first.code ?? null,
    title: first.title ?? first.message ?? null,
    details: first.error_data?.details ?? null,
  };
  console.error("[flows] WhatsApp delivery failed:", detail);
  const { data } = await db
    .from("flow_run_events")
    .select("flow_run_id, node_key")
    .eq("event_type", "message_sent")
    .filter("payload->>whatsapp_message_id", "eq", whatsappMessageId)
    .limit(1)
    .maybeSingle();
  const sent = data as { flow_run_id: string; node_key: string | null } | null;
  if (sent) await logEvent(db, sent.flow_run_id, "error", sent.node_key, detail);
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
  // Someone looking at the menu isn't "in the middle" of anything: no
  // "¿sigue ahí?" there. Elsewhere, only mention the order when there is one.
  const holdsList = runHoldsList(freshRun);
  const flow = await loadFlow(db, freshRun.flow_id);
  const { data: entryNode } = flow?.entry_node_id
    ? await db.from("flow_nodes").select("node_key").eq("id", flow.entry_node_id).maybeSingle()
    : { data: null };
  if (!holdsList && (entryNode as { node_key?: string } | null)?.node_key === expectedNodeKey) return;
  // Once per conversation is a reminder; twice is nagging.
  if (freshRun.vars.__idle_nudged) return;
  // Picking products in the catalog (a cart in progress): not idle — the
  // cart has its own reminder.
  if (freshRun.contact_id && (await loadCart(db, freshRun.account_id, freshRun.contact_id).catch(() => null))) return;
  await saveVars(db, freshRun, { ...freshRun.vars, __idle_nudged: true });
  const texts = (await bizOf(db, freshRun.account_id)).texts;
  // A list left half-way gets one more chance two hours later.
  if (holdsList) scheduleRecovery(db, runId, expectedNodeKey);
  try {
    const { whatsapp_message_id } = await engineSendInteractiveButtons({
      accountId: freshRun.account_id,
      userId: freshRun.user_id,
      conversationId: freshRun.conversation_id!,
      contactId: freshRun.contact_id!,
      bodyText: holdsList ? texts.idleNudge : texts.idleNudgeGeneral,
      buttons: [
        { id: `${NUDGE_GO_PREFIX}${runId}`, title: "▶️ Continuar" },
        { id: `${NUDGE_MENU_PREFIX}${runId}`, title: "📋 Menú" },
      ],
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
    bodyText: (await bizOf(db, run.account_id)).texts.disambiguationPrompt,
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
  // An order line reads "2 sacos de cemento", not "quiero 2 sacos de cemento".
  const trimmed = args.append
    ? args.text
        .split("\n")
        .map((l) => stripOrderLeadIn(l.trim()))
        .filter(Boolean)
        .join("\n")
    : args.text.trim();
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
    const suggestion = pickCrossSellSuggestion(trimmed, [], (await bizOf(db, run.account_id)).crossSell);
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
  // The option's title or an alias typed out ("ya terminé", "listo",
  // "consumidor final") counts too — even where numbers mean list lines.
  if (
    message.kind === "text" &&
    !run.vars.__pending_disambiguation &&
    !run.vars.__pending_clarification &&
    !run.vars.__pending_line_edit &&
    !run.vars.__pending_list_answer
  ) {
    const byNumber = currentTextFallback?.edit_list_var
      ? null
      : optionByNumber(currentNode, message.text);
    const picked = byNumber ?? optionByText(currentNode, message.text);
    if (picked) {
      message = {
        kind: "interactive_reply",
        reply_id: picked.reply_id,
        reply_title: picked.title,
        meta_message_id: message.meta_message_id,
      };
    } else if (!currentTextFallback?.edit_list_var) {
      // "9" on a 7-option menu: say which numbers exist instead of
      // treating "9" as the start of an order.
      const max = outOfRangeOption(currentNode, message.text);
      if (max) {
        const biz = await bizOf(db, run.account_id);
        await sendEngineText(db, run, currentNode.node_key, renderText(biz.texts.invalidOption, { max: String(max) }), "invalid_option");
        return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
      }
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
      await sendEngineText(db, run, currentNode.node_key, (await bizOf(db, run.account_id)).texts.nonTextReply, "non_text_reply");
    }
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Liquor can't be sold over WhatsApp (Meta Commerce Policy) — decline
  // it on any node that accumulates an order list, before it's captured.
  const capturesOrderList =
    currentCollectCfg?.append === true || currentTextFallback?.append === true;
  const bizForRules = await bizOf(db, run.account_id);
  // A photo while the order is being written: a written list or a
  // product becomes order lines (liquor left out); anything else gets a
  // friendly "write it to me". A receipt-capture node keeps its photo.
  if (message.kind === "image" && capturesOrderList && currentCollectCfg?.accept !== "image") {
    const reading = bizForRules.aiFeatures.readImages
      ? await readImage(db, run.account_id, run.conversation_id, message.media_url, message.caption)
      : null;
    if (reading?.kind === "receipt") {
      await acknowledgeReceipt(
        db,
        { accountId: run.account_id, userId: run.user_id, contactId: run.contact_id!, conversationId: run.conversation_id!, message },
        reading,
        run,
      );
      return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
    }
    if (!reading || reading.kind === "other") {
      await sendEngineText(db, run, currentNode.node_key, bizForRules.texts.photoNotUnderstood, "photo_not_understood");
      return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
    }
    const lines = reading.lines;
    const photoVar = `${(currentCollectCfg?.append ? currentCollectCfg : currentTextFallback)!.var_key}_photos`;
    const photos = typeof run.vars[photoVar] === "string" ? `${run.vars[photoVar]}\n` : "";
    await saveVars(db, run, { ...run.vars, [photoVar]: `${photos}${message.media_url}` });
    message = linesAsOrder(lines, message.meta_message_id);
  }
  // A voice note, or a long sentence naming several things ("deme dos
  // litros de leche y un paquete de arroz"), becomes one line per product
  // — before the liquor check, so a beer in the sentence drops alone.
  if (
    message.kind === "text" &&
    capturesOrderList &&
    !run.vars.__pending_clarification &&
    bizForRules.aiFeatures.entryRouter &&
    looksLikeSeveralItems(message.text, message.voice === true)
  ) {
    const route = await classifyFirstMessage(db, run.account_id, run.conversation_id, message.text);
    if (route?.intent === "order" && route.lines.length > 0) {
      message = linesAsOrder(route.lines, message.meta_message_id);
    }
  }
  if (message.kind === "text" && capturesOrderList && isBlockedProduct(bizForRules, message.text)) {
    await sendEngineText(db, run, currentNode.node_key, bizForRules.blockedProducts.reply, "alcohol_declined");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }
  // The bot just offered a product it was asked about ("¿Tiene grilón?"
  // → "Sí, lo manejamos, ¿se lo anoto?"): "sí, 10 metros" writes it down.
  const offered = typeof run.vars.__offered_product === "string" ? run.vars.__offered_product : null;
  if (offered && message.kind === "text") {
    const vars = { ...run.vars };
    delete vars.__offered_product;
    await saveVars(db, run, vars);
    const line = capturesOrderList ? acceptOfferedProduct(message.text, offered) : null;
    if (line) message = { ...message, text: line };
  }

  // A question is answered, never written down as a product ("¿Dispone
  // de Grilon?" used to become order line 1).
  const takesListText = capturesOrderList || !!currentTextFallback?.edit_list_var;
  if (
    message.kind === "text" &&
    takesListText &&
    bizForRules.aiFeatures.answerQuestions &&
    !run.vars.__pending_clarification &&
    !run.vars.__pending_line_edit &&
    !run.vars.__pending_list_answer &&
    !run.vars.__pending_disambiguation &&
    looksLikeQuestion(message.text)
  ) {
    const flow = await loadFlow(db, run.flow_id);
    const situation = flow?.entry_node_id === currentNode.id ? "menu" : "order";
    const answer = await answerInFlow(db, run.account_id, run.conversation_id, message.text, situation);
    if (answer) {
      if (answer.product) await saveVars(db, run, { ...run.vars, __offered_product: answer.product });
      await sendEngineText(db, run, currentNode.node_key, answer.reply, "question_answered");
      return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
    }
  }

  // "sí" / "ok" / "gracias" and "quiero hablar con un asesor" are not
  // products — answer them instead of adding them to the list.
  if (message.kind === "text" && capturesOrderList && !run.vars.__pending_clarification) {
    const reply = isHumanRequest(message.text)
      ? bizForRules.texts.humanRequest
      : isAckOnly(message.text)
        ? bizForRules.texts.orderAck
        : null;
    if (reply) {
      await sendEngineText(db, run, currentNode.node_key, reply, "not_an_order_line");
      return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
    }
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
  // The customer is answering the service advisor's question.
  const pendingGuide = run.vars.__pending_guide as PendingGuide | undefined;
  if (pendingGuide && pendingGuide.node_key === currentNode.node_key) {
    if (message.kind === "text" && message.text.trim()) {
      const answers = [...pendingGuide.answers, { q: pendingGuide.question, a: message.text.trim() }];
      const guided = await runServiceGuide(db, run, currentNode, nodes, answers);
      return { consumed: true, flow_run_id: run.id, outcome: guided.outcome };
    }
    if (message.kind === "image") {
      // A photo of the problem in the middle of the questions: keep it.
      const photoVar = `${(currentNode.config as unknown as CollectInputNodeConfig).var_key}_fotos`;
      const prev = typeof run.vars[photoVar] === "string" ? `${run.vars[photoVar]}\n` : "";
      await saveVars(db, run, { ...run.vars, [photoVar]: `${prev}${message.media_url}` });
      await sendEngineText(db, run, currentNode.node_key, `📸 ¡Gracias por la foto! ${pendingGuide.question}`, "service_guide_photo");
      return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
    }
  }

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
    // A reply that doesn't pass the node's validation (e.g. a pasted
    // order summary where a cédula was asked) leaves `matched` null, so
    // the fallback policy re-asks with prompt_text.
    let validated = extractValidInput(cfg, message.text);
    // "listo" / "no tengo" where an optional photo was asked: no photo.
    if (
      validated !== null && cfg.accept === "image" && cfg.optional &&
      (isAckOnly(validated) || /^(no|no tengo|sin foto|ninguna|nada)/.test(normalizeForMatch(validated)))
    ) {
      validated = "(sin foto)";
    }
    if (validated !== null) {
      const disambiguation = await tryStartProductDisambiguation(
        db,
        run,
        currentNode,
        cfg,
        validated,
      );
      if (disambiguation) return disambiguation;
      matched = await captureTextIntoVar(db, run, currentNode.node_key, {
        var_key: cfg.var_key,
        append: cfg.append,
        lowercase: cfg.lowercase,
        cross_sell: cfg.cross_sell,
        next_node_key: cfg.next_node_key,
        text: validated,
      });
      debounceMs = cfg.debounce_ms;
      if (matched && cfg.ai_guide) {
        const guided = await runServiceGuide(db, run, currentNode, nodes, []);
        return { consumed: true, flow_run_id: run.id, outcome: guided.outcome };
      }
    }
  } else if (message.kind === "form_reply" && currentCollectCfg) {
    // A submitted in-chat form: all its answers as one capture, plus one
    // var per field.
    const cfg = currentCollectCfg;
    matched = await captureTextIntoVar(db, run, currentNode.node_key, {
      var_key: cfg.var_key,
      append: cfg.append,
      lowercase: false,
      cross_sell: false,
      next_node_key: cfg.next_node_key,
      text: formatFormReply(message.data, cfg.form?.labels),
    });
    if (matched) {
      const fieldVars: Record<string, unknown> = { ...run.vars };
      for (const [field, value] of Object.entries(message.data)) {
        fieldVars[`${cfg.var_key}_${field}`] = value;
      }
      await saveVars(db, run, fieldVars);
    }
  } else if (
    message.kind === "order" &&
    (currentCollectCfg?.append === true || currentTextFallback?.append === true)
  ) {
    // A catalog cart lands wherever typed order lines would (an
    // order-list collect_input, or a send_buttons text_fallback like
    // "¿algo más?"). No disambiguation — the items are exact catalog
    // picks — and no debounce: a cart is one complete message.
    const target = (currentCollectCfg?.append ? currentCollectCfg : currentTextFallback)!;
    // Lines read from a photo or a sentence can include liquor too.
    const allLines = message.text.split("\n").map((l) => l.trim()).filter(Boolean);
    const allowed = allLines.filter((l) => !isBlockedProduct(bizForRules, l));
    if (allowed.length < allLines.length) {
      await sendEngineText(db, run, currentNode.node_key, bizForRules.blockedProducts.reply, "alcohol_declined");
    }
    if (allowed.length === 0) {
      return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
    }
    matched = await captureTextIntoVar(db, run, currentNode.node_key, {
      var_key: target.var_key,
      append: true,
      lowercase: false,
      cross_sell: false,
      next_node_key: target.next_node_key,
      text: allowed.join("\n"),
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
          text: (await bizOf(db, run.account_id)).texts.captureFailed,
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
      // or var_key missing — rare). Re-send the prompt so they try again
      // (a node without one asks the generic "didn't get that").
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text:
            interpolateVars(cfg.prompt_text ?? "", run.vars).trim() ||
            (await bizOf(db, run.account_id)).texts.captureFailed,
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
      (await bizOf(db, run.account_id)).texts.fallbackHandoff,
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
  /**
   * Start somewhere other than the entry node, with some vars already
   * known; `silent` only opens the run at that node (nothing is sent) —
   * the next message continues there.
   */
  opts: { startAt?: string; vars?: Record<string, unknown>; silent?: boolean } = {},
): Promise<DispatchInboundResult> {
  const startAt = opts.startAt && nodes.has(opts.startAt) ? opts.startAt : flow.entry_node_id!;
  // Seed `vars.contact_name` up front so any node's `{{vars.contact_name}}`
  // (send_message/send_buttons text, prompt_text, etc.) can greet the
  // customer by name without every flow author needing a collect_input
  // step just to ask for a name we already have on file. Leading space
  // is baked into the value itself (" Juan" vs "") rather than the
  // template, so "¡Hola{{vars.contact_name}}!" reads naturally as
  // either "¡Hola Juan!" or "¡Hola!" without a second no-name template.
  // Best-effort: a lookup failure just means an unpersonalized greeting,
  // never a reason to fail the run.
  const greetVars = await customerStartVars(db, flow.account_id, input.contactId);

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
      current_node_key: startAt,
      vars: { ...(opts.vars ?? {}), ...greetVars },
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
  if (opts.silent) {
    await advanceCurrentNodeKey(db, run.id, startAt, startAt);
    return { consumed: true, flow_run_id: run.id, outcome: "started" };
  }

  if (input.message.kind === "order" && startAt === flow.entry_node_id) {
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

  // Run the advance loop starting from the entry (or requested) node.
  const outcome = await advanceFromNodeKey(db, run, startAt, nodes);
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
    /**
     * End the contact's current active run (if any) instead of giving
     * up. A web order is more important than whatever chat the buyer
     * left half-way; a birthday greeting is not, so it stays off there.
     */
    supersedeActive?: boolean;
  },
): Promise<DispatchInboundResult> {
  const flow = await loadFlow(db, flowId);
  if (!flow || flow.status !== "active" || !flow.entry_node_id) {
    return { consumed: false, outcome: "no_match" };
  }
  const nodes = await loadAllNodes(db, flow.id);

  const greetVars = await customerStartVars(db, flow.account_id, args.contactId);

  if (args.supersedeActive) {
    const existing = await loadActiveRunForContact(db, flow.account_id, args.contactId);
    if (existing) await endRun(db, existing.id, "timed_out", "superseded_by_external_event");
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
      vars: { ...greetVars, ...args.vars },
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
