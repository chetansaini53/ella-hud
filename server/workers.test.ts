import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { HttpError } from "./http-error.ts";
import { UsageTracker, parseResetTime, parseUsageText } from "./usage.ts";
import { WorkerManager, describeTool, loadWorkerSettings, prettyModel } from "./workers.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "ella-test-"));
const root = path.join(tmp, "root");
const outside = path.join(tmp, "outside");
mkdirSync(path.join(root, "proj"), { recursive: true });
mkdirSync(outside);
after(() => rmSync(tmp, { recursive: true, force: true }));

// A bin that does not exist: validation must fail before anything is spawned.
const manager = new WorkerManager({ ...loadWorkerSettings({ WORKSPACE_ROOTS: root }), claudeBin: path.join(tmp, "no-such-claude") });

function rejects(input: Record<string, unknown>, status: number) {
  assert.throws(
    () => manager.create(input),
    (err: unknown) => err instanceof HttpError && err.status === status,
  );
}

describe("worker cwd boundary", () => {
  it("rejects a relative path", () => rejects({ task: "x", cwd: "proj" }, 400));
  it("rejects a missing folder", () => rejects({ task: "x", cwd: path.join(root, "nope") }, 400));
  it("rejects a folder outside WORKSPACE_ROOTS", () => rejects({ task: "x", cwd: outside }, 403));
  it("rejects .. traversal out of the root", () => rejects({ task: "x", cwd: path.join(root, "proj", "..", "..", "outside") }, 403));
  it("rejects a sibling whose name only starts with the root", () => {
    mkdirSync(`${root}-evil`);
    rejects({ task: "x", cwd: `${root}-evil` }, 403);
  });
});

describe("resuming in a Claude-trusted folder", () => {
  const sid = "11111111-2222-4333-8444-555555555555";
  it("is allowed outside WORKSPACE_ROOTS when Claude Code trusts the folder", () => {
    const w = manager.create({ cwd: outside, resumeSessionId: sid }, { trustedCwd: true });
    assert.equal(w.status, "idle");
    manager.remove(w.id);
  });
  it("is still refused when the folder is not trusted", () => rejects({ cwd: outside, resumeSessionId: sid }, 403));
  it("never lets a new task escape the roots, trusted or not", () => {
    assert.throws(() => manager.create({ task: "x", cwd: outside }, { trustedCwd: true }), (e: unknown) => e instanceof HttpError && e.status === 403);
  });
});

describe("worker input validation", () => {
  const cwd = path.join(root, "proj");
  it("rejects an unknown model", () => rejects({ task: "x", cwd, model: "gpt" }, 400));
  it("rejects an unknown effort", () => rejects({ task: "x", cwd, effort: "turbo" }, 400));
  it("rejects an empty task", () => rejects({ task: "   ", cwd }, 400));
  it("rejects a non-UUID session to resume", () => rejects({ cwd, resumeSessionId: "../../etc" }, 400));
  it("rejects an oversized task", () => rejects({ task: "a".repeat(20_001), cwd }, 400));
});

describe("settings", () => {
  it("refuses an unknown permission mode", () => {
    assert.throws(() => loadWorkerSettings({ WORKSPACE_ROOTS: root, WORKER_PERMISSION_MODE: "yolo" }));
  });
  it("refuses MAX_WORKERS out of range", () => {
    assert.throws(() => loadWorkerSettings({ WORKSPACE_ROOTS: root, MAX_WORKERS: "50" }));
  });
});

describe("labels", () => {
  it("pretty-prints model ids", () => {
    assert.equal(prettyModel("claude-opus-5-5"), "Opus 5.5");
    assert.equal(prettyModel("claude-sonnet-5-5[1m]"), "Sonnet 5.5");
    assert.equal(prettyModel("haiku"), "Haiku");
  });
  it("describes tool calls", () => {
    assert.equal(describeTool("Bash", { command: "pnpm tsc", description: "Typecheck web" }), "Bash: Typecheck web");
    assert.equal(describeTool("Edit", { file_path: "D:\\x\\src\\App.tsx" }), "Edit: App.tsx");
    assert.equal(describeTool("TodoWrite", {}), "TodoWrite");
  });
});

describe("usage meters", () => {
  it("maps five_hour/seven_day utilization to percentages", () => {
    const u = new UsageTracker();
    const resets = Math.floor(Date.now() / 1000) + 3600;
    assert.ok(u.apply({ rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.28, resetsAt: resets } }));
    assert.ok(u.apply({ rate_limit_info: { status: "allowed", rate_limit_type: "seven_day", utilization: 36 } }));
    const got = u.get();
    assert.equal(Math.round(got.session?.pct ?? -1), 28);
    assert.equal(got.session?.resetsAt, resets * 1000);
    assert.equal(got.week?.pct, 36);
  });
  it("ignores events without utilization and drops expired windows", () => {
    const u = new UsageTracker();
    assert.equal(u.apply({ rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } }), false);
    u.apply({ rate_limit_info: { rateLimitType: "five_hour", utilization: 0.5, resetsAt: 1 } });
    assert.equal(u.get().session, null);
  });
});

describe("/usage parsing", () => {
  const now = Date.parse("2026-11-20T10:00:00Z");
  it("converts a zoned reset time to epoch", () => {
    assert.equal(parseResetTime("Nov 20, 5:50pm (Asia/Kolkata)", now), Date.parse("2026-11-20T12:20:00Z"));
    assert.equal(parseResetTime("Nov 22, 12:00am (UTC)", now), Date.parse("2026-11-22T00:00:00Z"));
    assert.equal(parseResetTime("garbage", now), null);
  });
  it("reads session, week and contributor lines", () => {
    const text = "Current session: 18% used · resets Nov 20, 5:50pm (Asia/Kolkata)\nCurrent week (all models): 21% used · resets Nov 22, 5:30pm (Asia/Kolkata)\n\nWhat's contributing to your usage?\nLast 24h · 194 requests";
    const u = parseUsageText(text, now);
    assert.equal(u.session?.pct, 18);
    assert.equal(u.week?.pct, 21);
    assert.equal(u.week?.resetsAt, Date.parse("2026-11-22T12:00:00Z"));
    assert.deepEqual(u.details, ["Last 24h · 194 requests"]);
  });
});
