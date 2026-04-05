/**
 * AI Agent type definitions and contracts.
 *
 * Every agent follows the same interface:
 *   async function run(context, supabase) → { actions: AIAction[], reasoning: string }
 *
 * AIAction is the universal output type for all agents.
 */

/**
 * @typedef {Object} AIAction
 * @property {string} id - unique action identifier
 * @property {string} agent - which agent generated this (e.g. "risk-predictor")
 * @property {string} action_type - reschedule | split_order | escalate | reassign | add_overtime | alert
 * @property {string} target_type - order | factory | line
 * @property {string} target_id - ID of the target entity
 * @property {string} summary - human-readable action description (Chinese)
 * @property {"critical"|"high"|"medium"|"low"} urgency
 * @property {string} impact - what happens if we do nothing (Chinese)
 * @property {number} confidence - 0-1
 * @property {Record<string, unknown>} params - data to execute the action
 */

/**
 * @typedef {Object} ExceptionV2Response
 * @property {string} timestamp
 * @property {OrderException[]} order_exceptions
 * @property {FactoryException[]} factory_exceptions
 * @property {ResourceException[]} resource_exceptions
 * @property {IncidentException[]} incident_exceptions
 * @property {AIAction[]} ai_actions
 */

/**
 * Create a standardized AIAction.
 */
export function createAction({
  agent,
  action_type,
  target_type,
  target_id,
  summary,
  urgency = "medium",
  impact = "",
  confidence = 0.5,
  params = {},
}) {
  return {
    id: `${agent}-${target_type}-${target_id}-${Date.now()}`,
    agent,
    action_type,
    target_type,
    target_id,
    summary,
    urgency,
    impact,
    confidence,
    params,
  };
}
