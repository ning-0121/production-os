import { recommendFactories } from "./recommend.js";

const order = {
  product_type: "widget-A",
  quantity: 1200,
  due_date: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000),
};

const factories = [
  {
    id: "f1",
    name: "Factory Shenzhen 01",
    capacity: { daily_capacity_minutes: 10 * 60 },
    load: { allocated_minutes_next_30d: 9000 },
    capabilities: [
      { product_type: "widget-A", setup_minutes: 120, minutes_per_unit: 0.35, cost_per_unit: 18, quality_score: 92 },
    ],
  },
  {
    id: "f2",
    name: "Factory Suzhou 02",
    capacity: { daily_capacity_minutes: 8 * 60 },
    load: { allocated_minutes_next_30d: 12000 },
    capabilities: [
      { product_type: "widget-A", setup_minutes: 60, minutes_per_unit: 0.5, cost_per_unit: 12, quality_score: 85 },
    ],
  },
  {
    id: "f3",
    name: "Factory Chengdu 03",
    capacity: { daily_capacity_minutes: 8 * 60 },
    load: { allocated_minutes_next_30d: 2000, utilization_pct: 12 },
    capabilities: [
      { product_type: "widget-B", setup_minutes: 30, minutes_per_unit: 0.2 },
    ],
  },
];

const recs = recommendFactories(order, factories, {
  horizonDays: 30,
  scorePlugins: [
    ({ factory }) => {
      const preferred = factory.name.includes("Shenzhen");
      return { key: "region_preference", score01: preferred ? 1 : 0.3, weight: 0.05, meta: { preferred } };
    },
  ],
});

console.log(JSON.stringify(recs, null, 2));

