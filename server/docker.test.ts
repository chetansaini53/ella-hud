import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { containerAction, prune, removeVolume } from "./docker.ts";
import { HttpError } from "./http-error.ts";

const is400 = (err: unknown) => err instanceof HttpError && err.status === 400;

describe("docker actions validate before touching Docker", () => {
  it("rejects bad container ids and unknown actions", async () => {
    await assert.rejects(containerAction("abc; rm -rf /", "remove"), is400);
    await assert.rejects(containerAction("0123456789ab", "kill"), is400);
  });
  it("rejects volume names that are not plain names", async () => {
    await assert.rejects(removeVolume("../etc"), is400);
    await assert.rejects(removeVolume("-f"), is400);
    await assert.rejects(removeVolume(""), is400);
  });
  it("only runs the known cleanups", async () => {
    await assert.rejects(prune("system --all --volumes"), is400);
    await assert.rejects(prune(undefined), is400);
  });
});
