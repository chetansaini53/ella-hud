import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUsageText, UsageTracker } from "./usage.ts";

const now = Date.parse("2026-11-20T10:00:00Z");

describe("/usage report edge cases", () => {
  it("keeps the all-models week and ignores per-model weeks, whatever their order", () => {
    const text = "Current week (Opus): 4% used · resets Nov 22, 5:30pm (Asia/Kolkata)\nCurrent session: 9% used\nCurrent week (all models): 23% used · resets Nov 22, 5:30pm (Asia/Kolkata)";
    const u = parseUsageText(text, now);
    assert.equal(u.week?.pct, 23);
    assert.equal(u.session?.pct, 9);
    assert.equal(u.session?.resetsAt, null);
  });
  it("gives no meters for an error or the cost-only summary", () => {
    assert.equal(parseUsageText("Failed to authenticate: OAuth session expired", now).session, null);
    assert.equal(parseUsageText("Estimated cost: $0.0000\nUsage: 0 input, 0 output", now).week, null);
  });
});

describe("usage snapshots", () => {
  it("ignore an empty /usage result so the last good meters stay", () => {
    const t = new UsageTracker();
    assert.ok(t.setSnapshot(parseUsageText("Current session: 18% used", now)));
    assert.equal(t.setSnapshot(parseUsageText("nothing useful", now)), false);
    assert.equal(t.get().session?.pct, 18);
  });
  it("worker rate-limit events still fill the meters", () => {
    const t = new UsageTracker();
    assert.ok(t.apply({ rate_limit_info: { rateLimitType: "seven_day", utilization: 0.5 } }));
    assert.equal(t.get().week?.pct, 50);
  });
});
