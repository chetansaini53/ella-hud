import { Button, Group, Loader, Modal, ScrollArea, Text } from "@mantine/core";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import type { FetchState } from "../../useFetch.ts";

/** Loading / error / empty wrapper so every panel ships all states. */
export function Loadable<T>({ state, empty, isEmpty, children }: { state: FetchState<T>; empty: string; isEmpty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (state.error) {
    return (
      <div className="ctl-state error">
        <IconAlertTriangle size={16} /> {state.error}
        <Button variant="subtle" size="compact-xs" leftSection={<IconRefresh size={12} />} onClick={state.reload}>
          Retry
        </Button>
      </div>
    );
  }
  if (state.data === null) {
    return (
      <div className="ctl-state">
        <Loader size="xs" /> Loading…
      </div>
    );
  }
  if (isEmpty?.(state.data)) return <div className="ctl-state">{empty}</div>;
  return <>{children(state.data)}</>;
}

export function Section({ title, count, actions, children }: { title: string; count?: number; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="ctl-section">
      <div className="ctl-section-head">
        <span className="label-caps">{title}</span>
        {count !== undefined && <span className="dim">{count}</span>}
        <span className="ctl-actions">{actions}</span>
      </div>
      {children}
    </section>
  );
}

/** Promise-based confirm dialog: `if (await ask("Stop it?")) …`. */
export function useConfirm(): [ReactNode, (message: string, action?: string) => Promise<boolean>] {
  const [state, setState] = useState<{ message: string; action: string } | null>(null);
  const resolver = useRef<(ok: boolean) => void>(() => undefined);
  const ask = useCallback(
    (message: string, action = "Confirm") =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setState({ message, action });
      }),
    [],
  );
  const close = (ok: boolean) => {
    resolver.current(ok);
    setState(null);
  };
  const modal = (
    <Modal opened={state !== null} onClose={() => close(false)} title={<Text fw={700} style={{ letterSpacing: "0.1em" }}>CONFIRM</Text>} size="sm">
      <Text size="sm" mb="md" style={{ whiteSpace: "pre-wrap" }}>
        {state?.message}
      </Text>
      <Group justify="flex-end">
        <Button variant="subtle" onClick={() => close(false)}>
          Cancel
        </Button>
        <Button color="red" onClick={() => close(true)} data-autofocus>
          {state?.action}
        </Button>
      </Group>
    </Modal>
  );
  return [modal, ask];
}

export function TextViewer({ title, text, onClose }: { title: string | null; text: string; onClose: () => void }) {
  return (
    <Modal opened={title !== null} onClose={onClose} title={<Text fw={700}>{title}</Text>} size="xl">
      <ScrollArea.Autosize mah="70vh">
        <pre className="ctl-pre">{text}</pre>
      </ScrollArea.Autosize>
    </Modal>
  );
}
