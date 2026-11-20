import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@fontsource/exo-2/400.css";
import "@fontsource/exo-2/600.css";
import "@fontsource/exo-2/700.css";
import "@mantine/core/styles/baseline.css";
import "@mantine/core/styles/default-css-variables.css";
import "@mantine/core/styles/global.css";
import "@mantine/core/styles/UnstyledButton.css";
import "@mantine/core/styles/Button.css";
import "@mantine/core/styles/ActionIcon.css";
import "@mantine/core/styles/Input.css";
import "@mantine/core/styles/Combobox.css";
import "@mantine/core/styles/Popover.css";
import "@mantine/core/styles/Tooltip.css";
import "@mantine/core/styles/Menu.css";
import "@mantine/core/styles/ModalBase.css";
import "@mantine/core/styles/Modal.css";
import "@mantine/core/styles/Overlay.css";
import "@mantine/core/styles/CloseButton.css";
import "@mantine/core/styles/ScrollArea.css";
import "@mantine/core/styles/SegmentedControl.css";
import "@mantine/core/styles/InlineInput.css";
import "@mantine/core/styles/Checkbox.css";
import "@mantine/core/styles/Skeleton.css";
import "@mantine/core/styles/Notification.css";
import "@mantine/core/styles/Loader.css";
import "@mantine/core/styles/Stack.css";
import "@mantine/core/styles/Alert.css";
import "@mantine/core/styles/Text.css";
import "@mantine/core/styles/Group.css";
import "@mantine/core/styles/Badge.css";
import "@mantine/core/styles/Switch.css";
import "@mantine/core/styles/Indicator.css";
import "./styles.css";
import { theme } from "./theme.ts";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <App />
    </MantineProvider>
  </StrictMode>,
);
