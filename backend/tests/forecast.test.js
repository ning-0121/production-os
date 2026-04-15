/**
 * Forecast engine tests — ARIMA + linear fallback
 * Run: node --test backend/tests/forecast.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { arimaForecast, linearFallback } from "../src/agents/forecaster.js";

describe("ARIMA Forecast", () => {
  it("produces predictions for sufficient data", () => {
    const data = [100, 105, 98, 102, 110, 108, 112, 115, 109, 120];
    const predicted = arimaForecast(data, 5);
    assert.equal(predicted.length, 5);
    predicted.forEach((v) => assert.ok(v >= 0, `Prediction ${v} should be non-negative`));
  });

  it("falls back to linear for insufficient data", () => {
    const data = [100, 110, 120];
    const predicted = arimaForecast(data, 3);
    assert.equal(predicted.length, 3);
    // Linear trend should continue upward
    assert.ok(predicted[0] >= 120, `First prediction ${predicted[0]} should continue trend`);
  });

  it("handles constant data", () => {
    const data = [50, 50, 50, 50, 50, 50, 50, 50];
    const predicted = arimaForecast(data, 3);
    assert.equal(predicted.length, 3);
    // Should stay near 50
    predicted.forEach((v) => assert.ok(Math.abs(v - 50) < 20, `Prediction ${v} should be near 50`));
  });

  it("handles single value", () => {
    const predicted = arimaForecast([42], 3);
    assert.equal(predicted.length, 3);
  });

  it("handles empty array", () => {
    const predicted = arimaForecast([], 3);
    assert.equal(predicted.length, 3);
  });
});

describe("Linear Fallback", () => {
  it("predicts upward trend", () => {
    const data = [10, 20, 30, 40, 50];
    const predicted = linearFallback(data, 3);
    assert.equal(predicted.length, 3);
    assert.ok(predicted[0] >= 55, `Should continue trend: got ${predicted[0]}`);
    assert.ok(predicted[1] > predicted[0]);
    assert.ok(predicted[2] > predicted[1]);
  });

  it("predicts downward trend without going negative", () => {
    const data = [50, 40, 30, 20, 10];
    const predicted = linearFallback(data, 5);
    predicted.forEach((v) => assert.ok(v >= 0, `Should not go negative: got ${v}`));
  });

  it("handles constant data", () => {
    const data = [100, 100, 100];
    const predicted = linearFallback(data, 3);
    predicted.forEach((v) => assert.equal(v, 100));
  });
});
