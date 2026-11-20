import { Alert, Autocomplete, Button, Group, Modal, SegmentedControl, Stack, Text, Textarea } from "@mantine/core";
import { IconAlertTriangle, IconFlame } from "@tabler/icons-react";
import { useEffect, useState, type FormEvent } from "react";
import { EFFORTS, MODELS, type Effort, type Model } from "../../shared/types.ts";

export interface NewWorkerInput {
  task: string;
  cwd: string;
  model: Model;
  effort: Effort;
}

interface Props {
  opened: boolean;
  initialTask: string;
  defaultCwd: string;
  recentCwds: string[];
  permissionMode: string;
  onClose: () => void;
  onCreate: (input: NewWorkerInput) => Promise<void>;
}

export function NewWorkerModal({ opened, initialTask, defaultCwd, recentCwds, permissionMode, onClose, onCreate }: Props) {
  const [task, setTask] = useState("");
  const [cwd, setCwd] = useState(defaultCwd);
  const [model, setModel] = useState<Model>("opus");
  const [effort, setEffort] = useState<Effort>("high");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setTask(initialTask);
    setError(null);
    setCwd((c) => c || defaultCwd);
  }, [opened, initialTask, defaultCwd]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate({ task: task.trim(), cwd: cwd.trim(), model, effort });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={700} style={{ letterSpacing: "0.1em" }}>NEW WORKER</Text>} size="lg">
      <form onSubmit={submit}>
        <Stack gap="sm" className="hud-input">
          <Textarea label="Task" description="What should this worker cook?" required autosize minRows={3} maxRows={10} maxLength={20000} value={task} onChange={(e) => setTask(e.currentTarget.value)} data-autofocus />
          <Autocomplete label="Folder" description="Absolute path inside WORKSPACE_ROOTS" required data={recentCwds} value={cwd} onChange={setCwd} limit={12} />
          <Group grow align="flex-start">
            <Stack gap={4}>
              <Text size="sm" fw={500}>Model</Text>
              <SegmentedControl data={MODELS.map((m) => ({ value: m, label: m.charAt(0).toUpperCase() + m.slice(1) }))} value={model} onChange={(v) => setModel(v as Model)} />
            </Stack>
            <Stack gap={4}>
              <Text size="sm" fw={500}>Effort</Text>
              <SegmentedControl data={[...EFFORTS]} value={effort} onChange={(v) => setEffort(v as Effort)} />
            </Stack>
          </Group>
          <Text size="xs" c="dimmed">
            Permission mode: <b>{permissionMode}</b>. Workers run headless, so anything this mode does not allow gets denied and the card shows NEEDS YOU.
          </Text>
          {error && (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} variant="light">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} leftSection={<IconFlame size={16} />} disabled={!task.trim() || !cwd.trim()}>
              Start cooking
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
