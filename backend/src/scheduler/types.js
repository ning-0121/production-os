/**
 * @typedef {Object} OrderInput
 * @property {string} product_type
 * @property {number} quantity
 * @property {string|Date} due_date
 */

/**
 * @typedef {Object} FactoryCapability
 * @property {string} product_type
 * @property {number} setup_minutes
 * @property {number} minutes_per_unit
 * @property {number} [base_capacity_units_per_day]
 * @property {number} [cost_per_unit]
 * @property {number} [quality_score] // 0..100
 * @property {Record<string, any>} [features]
 */

/**
 * @typedef {Object} FactoryInput
 * @property {string} id
 * @property {string} name
 * @property {string} [timezone]
 * @property {FactoryCapability[]} capabilities
 * @property {{ allocated_minutes_next_7d?: number, allocated_minutes_next_30d?: number, utilization_pct?: number }} [load]
 * @property {{ daily_capacity_minutes?: number }} [capacity]
 * @property {Record<string, any>} [metadata]
 */

/**
 * @typedef {Object} Recommendation
 * @property {string} factory_id
 * @property {string} factory_name
 * @property {number} score
 * @property {boolean} feasible
 * @property {{ production_minutes: number, setup_minutes: number, total_minutes: number }} timing
 * @property {{ utilization_pct: number, allocated_minutes_window: number, capacity_minutes_window: number }} load
 * @property {Record<string, number>} score_breakdown
 * @property {Record<string, any>} assumptions
 */

export {};

