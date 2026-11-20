import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { guardConfig, guardRequest, resolveStatic } from "./guard.ts";
import { HttpError } from "./http-error.ts";

const prod = guardConfig(4317, null);
const dev = guardConfig(4317, 5173);

function status(req: { method?: string; headers: Record<string, string | undefined> }, cfg = prod): number {
  try {
    guardRequest(req, cfg);
    return 200;
  } catch (err) {
    assert.ok(err instanceof HttpError);
    return err.status;
  }
}

describe("request guard", () => {
  it("allows the UI's own GET and POST", () => {
    assert.equal(status({ method: "GET", headers: { host: "127.0.0.1:4317" } }), 200);
    assert.equal(status({ method: "POST", headers: { host: "localhost:4317", origin: "http://localhost:4317" } }), 200);
  });
  it("blocks DNS rebinding (foreign Host)", () => {
    assert.equal(status({ method: "GET", headers: { host: "attacker.example:4317" } }), 421);
    assert.equal(status({ method: "GET", headers: {} }), 421);
  });
  it("blocks cross-origin requests, including opaque origins", () => {
    assert.equal(status({ method: "POST", headers: { host: "127.0.0.1:4317", origin: "https://evil.example" } }), 403);
    assert.equal(status({ method: "GET", headers: { host: "127.0.0.1:4317", origin: "null" } }), 403);
  });
  it("requires same-origin proof on state-changing requests", () => {
    assert.equal(status({ method: "DELETE", headers: { host: "127.0.0.1:4317" } }), 403);
    assert.equal(status({ method: "POST", headers: { host: "127.0.0.1:4317", "sec-fetch-site": "cross-site" } }), 403);
    assert.equal(status({ method: "POST", headers: { host: "127.0.0.1:4317", "sec-fetch-site": "same-origin" } }), 200);
  });
  it("trusts the Vite dev port only in dev mode", () => {
    const req = { method: "POST", headers: { host: "localhost:5173", origin: "http://localhost:5173" } };
    assert.equal(status(req, prod), 421);
    assert.equal(status(req, dev), 200);
  });
});

describe("static path resolution", () => {
  const dist = path.resolve("dist");
  it("serves files inside dist", () => {
    assert.equal(resolveStatic(dist, "/assets/app.js"), path.join(dist, "assets", "app.js"));
  });
  it("refuses traversal, encoded traversal, NUL and bad escapes", () => {
    assert.equal(resolveStatic(dist, "/../package.json"), null);
    assert.equal(resolveStatic(dist, "/..%2f..%2fpackage.json"), null);
    assert.equal(resolveStatic(dist, "/..%5c..%5cpackage.json") === null || process.platform !== "win32", true);
    assert.equal(resolveStatic(dist, "/a%00.js"), null);
    assert.equal(resolveStatic(dist, "/%E0%A4%A"), null);
  });
});
