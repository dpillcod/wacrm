-- ============================================================
-- 043_flow_send_template_node.sql — 'send_template' flow node type
--
-- Adds a node that sends an approved WhatsApp message TEMPLATE (as
-- opposed to `send_message`'s free-form session text, which Meta only
-- delivers within 24h of the customer's last message). Needed for the
-- first message to a contact who bought on the website but has never
-- messaged the WhatsApp number — that flow_run has no open session,
-- so a plain send_message there silently fails against Meta's 24h
-- rule. See src/lib/flows/types.ts SendTemplateNodeConfig and
-- src/lib/flows/engine.ts for the runtime.
--
-- Same drop-and-recreate pattern migration 016 (send_media) and 042
-- (send_cta_url) used on this same CHECK constraint.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'send_cta_url',
    'send_template',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end'
  ));
