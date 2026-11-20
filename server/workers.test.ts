import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { HttpError } from "./http-error.ts";
import { UsageTracker } from "./usage.ts";
import { WorkerManager, describeTool, loadWorkerSettings, prettyModel } from "./workers.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "claudia-test-"));
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
