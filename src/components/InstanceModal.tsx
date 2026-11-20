import { Alert, Button, Group, Loader, Modal, Radio, Stack, Text, TextInput } from "@mantine/core";
import { IconAlertTriangle, IconDeviceFloppy } from "@tabler/icons-react";
import { useEffect, useState, type FormEvent } from "react";
import type { ClaudeBinary, ClaudeProfile, InstanceInfo } from "../../shared/types.ts";
import { api } from "../api.ts";

export interface Detected {
  binaries: ClaudeBinary[];
  profiles: ClaudeProfile[];
}

interface Props {
  opened: boolean;
  instance: InstanceInfo | null;
  onClose: () => void;
}

const same = (a: string, b: string) => a.toLowerCase().replace(/[\\/]+$/, "") === b.toLowerCase().replace(/[\\/]+$/, "");

/** Pick which Claude Code (binary + config profile) this HUD drives, and what the assistant is called. */
export function InstanceModal({ opened, instance, onClose }: Props) {
  const [found, setFound] = useState<Detected | null>(null);
  const [bin, setBin] = useState("");
  const [configDir, setConfigDir] = useState("");
  const [name, setName] = useState("Ella");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setError(null);
    setFound(null);
    setBin(instance?.bin ?? "");
    setConfigDir(instance?.configDir ?? "");
    setName(instance?.name ?? "Ella");
    api<Detected>("GET", "/api/instance/detect").then(
      (d) => {
        setFound(d);
        setBin((b) => (d.binaries.some((x) => same(x.path, b)) ? b : (d.binaries[0]?.path ?? b)));
      },
      (e: Error) => setError(e.message),
    );
  }, [opened, instance]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/instance", { bin: bin.trim(), configDir: configDir.trim(), name: name.trim() });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={700} style={{ letterSpacing: "0.1em" }}>WHICH CLAUDE?</Text>} size="lg">
      <form onSubmit={submit}>
        <Stack gap="md" className="hud-input">
          <Text size="sm" c="dimmed">
            Found on this computer. This choice is saved for port <b>{instance?.port}</b> only, so another instance on another port can drive a different Claude.
          </Text>

          {!found && !error && (
            <Group gap="xs"><Loader size="xs" /> <Text size="sm">Looking for Claude Code installs and profiles…</Text></Group>
          )}

          {found && (
            <>
              <Radio.Group label="Claude Code binary" description="Only detected CLIs can be used. Missing one? Set CLAUDE_BIN in .env and restart" value={found.binaries.some((b) => same(b.path, bin)) ? bin : ""} onChange={setBin}>
                <Stack gap={6} mt={6}>
                  {found.binaries.length === 0 && <Text size="sm" c="red">No Claude Code CLI found — install it, or type its path below.</Text>}
                  {found.binaries.map((b) => (
                    <Radio key={b.path} value={b.path} label={<span><b>{b.version}</b> <span className="dim mono">{b.path}</span></span>} description={b.source} />
                  ))}
                </Stack>
              </Radio.Group>

              <Radio.Group label="Profile (account / config folder)" description="Each config folder is a separate login, history and settings" value={found.profiles.some((p) => same(p.configDir, configDir)) ? configDir : ""} onChange={setConfigDir}>
                <Stack gap={6} mt={6}>
                  {found.profiles.map((p) => (
                    <Radio
                      key={p.configDir}
                      value={p.configDir}
                      label={<span><b>{p.label}</b> <span className="dim mono">{p.configDir}</span></span>}
                      description={`${p.account ?? "not logged in / API key"} · ${p.projects} projects · ${p.source}`}
                    />
                  ))}
                </Stack>
              </Radio.Group>
            </>
          )}

          <TextInput label="Config folder" description="Pick above, or paste a path" value={configDir} onChange={(e) => setConfigDir(e.currentTarget.value)} required />
          <TextInput label="Assistant name" description="Shown in the HUD and used to name the sessions it starts" value={name} maxLength={24} onChange={(e) => setName(e.currentTarget.value)} required />

          {error && <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}
          <Group justify="flex-end">
            <Button variant="subtle" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={busy} leftSection={<IconDeviceFloppy size={16} />} disabled={!bin.trim() || !configDir.trim() || !name.trim()}>
              Use this Claude
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
