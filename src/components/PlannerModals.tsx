import { Button, Checkbox, Modal, Stack, Text, TextInput } from "@mantine/core";
import { IconCalendarOff, IconPlus } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import type { TodoItem } from "../../shared/types.ts";
import { longDate } from "../format.ts";

const title = (t: string) => <Text fw={700} style={{ letterSpacing: "0.1em" }}>{t}</Text>;

export function TodoModal({ opened, now, todos, onClose, onAdd, onToggle }: { opened: boolean; now: number; todos: TodoItem[] | null; onClose: () => void; onAdd: (t: string) => Promise<void>; onToggle: (id: string, done: boolean) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const open = todos?.filter((t) => !t.done) ?? [];
  const done = todos?.filter((t) => t.done) ?? [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onAdd(text);
      setText("");
    } finally {
      setBusy(false);
    }
  };

  const item = (t: TodoItem) => (
    <Checkbox key={t.id} label={t.text} checked={t.done} onChange={(e) => onToggle(t.id, e.currentTarget.checked)} styles={{ label: { color: t.done ? "var(--hud-text-dim)" : "var(--hud-text-body)", textDecoration: t.done ? "line-through" : undefined } }} />
  );

  return (
    <Modal opened={opened} onClose={onClose} title={title("TO-DO")} size="md">
      <Text size="xs" c="dimmed" mb="sm">{longDate(now)} · {open.length} open</Text>
      <form onSubmit={submit} className="hud-input">
        <TextInput
          aria-label="New to-do"
          placeholder="Add a to-do and press Enter"
          value={text}
          maxLength={300}
          onChange={(e) => setText(e.currentTarget.value)}
          data-autofocus
          rightSection={
            <Button type="submit" variant="subtle" size="compact-xs" loading={busy} aria-label="Add to-do" disabled={!text.trim()}>
              <IconPlus size={14} />
            </Button>
          }
        />
      </form>
      <Stack gap={10} mt="md">
        {todos === null && <Text size="sm" c="dimmed">Loading…</Text>}
        {todos?.length === 0 && <Text size="sm" c="dimmed">No to-dos yet — add the first one above.</Text>}
        {open.map(item)}
        {done.length > 0 && <Text size="xs" c="dimmed" mt="xs">Done · {done.length}</Text>}
        {done.map(item)}
      </Stack>
    </Modal>
  );
}

export function MeetingsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Modal opened={opened} onClose={onClose} title={title("MEETINGS")} size="md">
      <Stack align="center" gap="xs" py="lg">
        <IconCalendarOff size={36} stroke={1.4} color="var(--hud-text-dim)" />
        <Text fw={600}>No calendar connected</Text>
        <Text size="sm" c="dimmed" ta="center">
          Calendar sync isn't built yet. Today's meetings will show up here once a calendar source is connected.
        </Text>
      </Stack>
    </Modal>
  );
}
