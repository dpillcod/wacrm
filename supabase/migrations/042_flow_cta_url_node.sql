-- ============================================================
-- 042_flow_cta_url_node.sql — 'send_cta_url' flow node type
--
-- Adds Meta's single-button "Call-To-Action URL" interactive message
-- as a new flow node type. Unlike `send_buttons` (quick-reply, routes
-- to a next node per tapped button id), tapping this button opens
-- `config.url` directly in the customer's browser — WhatsApp never
-- reports the tap back to us — so the node always auto-advances to
-- `config.next_node_key` right after the send lands. See
-- src/lib/flows/types.ts SendCtaUrlNodeConfig and
-- src/lib/flows/engine.ts for the runtime.
--
-- Same drop-and-recreate pattern migration 016 used to add
-- 'send_media' to this same CHECK constraint.
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
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end'
  ));
