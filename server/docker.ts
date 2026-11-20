import path from "node:path";
import type { DockerContainer, DockerProjectUsage, DockerPrune, DockerReport, DockerVolume, ProjectItem } from "../shared/types.ts";
import { run } from "./exec.ts";
import { HttpError } from "./http-error.ts";
import { log } from "./log.ts";

const DOCKER = process.env.DOCKER_BIN ?? "docker";
const VOLUME_SIZES_TTL = 5 * 60_000;
const UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** Docker's human sizes ("8.19kB (virtual 828MB)", "1.2GB") → bytes; the first figure wins. */
export function parseSize(text: string): number {
  const m = /([\d.]+)\s*([kKMGT]?B)/.exec(text);
  return m ? Math.round(Number(m[1]) * (UNITS[(m[2] ?? "B").toUpperCase()] ?? 1)) : 0;
}

function labels(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function jsonLines<T>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

/** Volume sizes need `docker system df -v`, which can take ~30 s — cached and refreshed in the background. */
let volumeSizes: { at: number; sizes: Map<string, number> } | null = null;
let volumeFailedAt = 0;
let volumeRefresh: Promise<void> | null = null;

function refreshVolumeSizes(): void {
  if (volumeRefresh) return;
  volumeRefresh = run(DOCKER, ["system", "df", "-v", "--format", "{{json .}}"], { timeoutMs: 120_000 })
    .then((r) => {
      if (r.code !== 0) throw new Error(r.stderr || "docker system df failed");
      const parsed = JSON.parse(r.stdout.trim().split(/\r?\n/)[0] ?? "{}") as { Volumes?: { Name: string; Size: string }[] };
      volumeSizes = { at: Date.now(), sizes: new Map((parsed.Volumes ?? []).map((v) => [v.Name, parseSize(v.Size)])) };
    })
    .catch((err: Error) => {
      volumeFailedAt = Date.now();
      log("warn", "docker volume sizes failed", { err: err.message });
    })
    .finally(() => {
      volumeRefresh = null;
    });
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(path.normalize(parent), path.normalize(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

export async function dockerReport(projects: ProjectItem[]): Promise<DockerReport> {
  const [ps, vols, df, dangling] = await Promise.all([
    run(DOCKER, ["ps", "-a", "--size", "--no-trunc", "--format", "{{json .}}"], { timeoutMs: 20_000 }),
    run(DOCKER, ["volume", "ls", "--format", "{{json .}}"], { timeoutMs: 20_000 }),
    run(DOCKER, ["system", "df", "--format", "{{json .}}"], { timeoutMs: 20_000 }),
    run(DOCKER, ["images", "--filter", "dangling=true", "--format", "{{.ID}}"], { timeoutMs: 20_000 }),
  ]);
  if (ps.code !== 0) {
    const none = { images: 0, buildCache: 0, volumes: 0, containers: 0 };
    return { available: false, error: (ps.stderr || "Docker is not running").trim().slice(0, 300), groups: [], imagesBytes: 0, buildCacheBytes: 0, volumesPending: false, reclaimable: none, danglingImages: 0 };
  }
  const failedRecently = Date.now() - volumeFailedAt < VOLUME_SIZES_TTL;
  if (!failedRecently && (!volumeSizes || Date.now() - volumeSizes.at > VOLUME_SIZES_TTL)) refreshVolumeSizes();

  const containers: DockerContainer[] = jsonLines<Record<string, string>>(ps.stdout).map((c) => {
    const l = labels(c.Labels);
    return {
      id: (c.ID ?? "").slice(0, 12),
      name: c.Names ?? "",
      image: c.Image ?? "",
      state: c.State ?? "",
      status: c.Status ?? "",
      sizeBytes: parseSize(c.Size ?? ""),
      composeProject: l["com.docker.compose.project"] ?? null,
      workingDir: l["com.docker.compose.project.working_dir"] ?? null,
    };
  });
  const composeDir = new Map(containers.filter((c) => c.composeProject && c.workingDir).map((c) => [c.composeProject as string, c.workingDir as string]));
  const volumes: DockerVolume[] = jsonLines<Record<string, string>>(vols.stdout).map((v) => ({
    name: v.Name ?? "",
    sizeBytes: volumeSizes?.sizes.get(v.Name ?? "") ?? 0,
    composeProject: labels(v.Labels)["com.docker.compose.project"] ?? null,
  }));

  // Group by the Claude project whose folder holds the compose working dir; otherwise by compose project; else "Unmanaged".
  const groups = new Map<string, DockerProjectUsage>();
  const groupFor = (composeProject: string | null, workingDir: string | null): DockerProjectUsage => {
    const dir = workingDir ?? (composeProject ? composeDir.get(composeProject) ?? null : null);
    const owner = dir ? projects.filter((p) => inside(dir, p.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
    const key = owner?.path ?? (composeProject ? `compose:${composeProject}` : "unmanaged");
    let g = groups.get(key);
    if (!g) {
      g = { projectPath: owner?.path ?? null, label: owner?.name ?? composeProject ?? "Not from any compose project", containers: [], volumes: [], sizeBytes: 0 };
      groups.set(key, g);
    }
    return g;
  };
  for (const c of containers) groupFor(c.composeProject, c.workingDir).containers.push(c);
  for (const v of volumes) groupFor(v.composeProject, null).volumes.push(v);
  for (const g of groups.values()) g.sizeBytes = g.containers.reduce((s, c) => s + c.sizeBytes, 0) + g.volumes.reduce((s, v) => s + v.sizeBytes, 0);

  const summary = jsonLines<{ Type: string; Size: string; Reclaimable: string }>(df.stdout);
  const size = (type: string) => parseSize(summary.find((s) => s.Type === type)?.Size ?? "");
  const reclaim = (type: string) => parseSize(summary.find((s) => s.Type === type)?.Reclaimable ?? "");
  return {
    available: true,
    error: null,
    groups: [...groups.values()].sort((a, b) => b.sizeBytes - a.sizeBytes),
    imagesBytes: size("Images"),
    buildCacheBytes: size("Build Cache"),
    volumesPending: !volumeSizes && !failedRecently,
    reclaimable: { images: reclaim("Images"), buildCache: reclaim("Build Cache"), volumes: reclaim("Local Volumes"), containers: reclaim("Containers") },
    danglingImages: dangling.stdout.split(/\r?\n/).filter((l) => l.trim()).length,
  };
}

/** start / stop / remove one container. Remove never forces: Docker refuses a running container. */
export async function containerAction(id: unknown, action: unknown): Promise<void> {
  if (typeof id !== "string" || !/^[0-9a-f]{12,64}$/.test(id)) throw new HttpError(400, "Invalid container id");
  if (action !== "start" && action !== "stop" && action !== "remove") throw new HttpError(400, "action must be start, stop or remove");
  const r = await run(DOCKER, [action === "remove" ? "rm" : action, id], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new HttpError(502, (r.stderr || `docker ${action} failed`).trim().slice(0, 300));
}

/** Removes one named volume. Docker refuses volumes a container (running or stopped) still uses. */
export async function removeVolume(name: unknown): Promise<void> {
  if (typeof name !== "string" || !/^[\w][\w.-]{0,254}$/.test(name)) throw new HttpError(400, "Invalid volume name");
  const r = await run(DOCKER, ["volume", "rm", name], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new HttpError(502, (r.stderr || "docker volume rm failed").trim().slice(0, 300));
  volumeSizes?.sizes.delete(name);
}

const PRUNE: Record<DockerPrune, string[]> = {
  "dangling-images": ["image", "prune", "-f"],
  "unused-images": ["image", "prune", "-a", "-f"],
  "build-cache": ["builder", "prune", "-f"],
  "anonymous-volumes": ["volume", "prune", "-f"],
  "stopped-containers": ["container", "prune", "-f"],
};

/** Whole-Docker cleanup. Returns Docker's own summary line (e.g. "Total reclaimed space: 1.2GB"). */
export async function prune(target: unknown): Promise<string> {
  const args = typeof target === "string" ? PRUNE[target as DockerPrune] : undefined;
  if (!args) throw new HttpError(400, "Unknown cleanup");
  const r = await run(DOCKER, args, { timeoutMs: 600_000 });
  if (r.code !== 0) throw new HttpError(502, (r.stderr || "docker prune failed").trim().slice(0, 300));
  volumeSizes = null;
  return /Total reclaimed space:.*$/m.exec(r.stdout)?.[0] ?? "Done";
}
