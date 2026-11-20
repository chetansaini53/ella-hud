import { createTheme, type MantineColorsTuple } from "@mantine/core";

/** Cyan scale built around the reference accent #62d9f0 (index 5). */
const hud: MantineColorsTuple = ["#e6fbff", "#c7f3fc", "#a3eaf8", "#86e2f5", "#73dcf2", "#62d9f0", "#3fb7cf", "#2b8fa3", "#1d6878", "#10414d"];

export const theme = createTheme({
  primaryColor: "hud",
  primaryShade: 5,
  colors: { hud },
  fontFamily: "'Exo 2', system-ui, sans-serif",
  headings: { fontFamily: "'Exo 2', system-ui, sans-serif" },
  defaultRadius: 0,
  black: "#04070f",
  components: {
    Tooltip: { defaultProps: { openDelay: 300, withArrow: true, color: "dark" } },
    Modal: { defaultProps: { centered: true, overlayProps: { backgroundOpacity: 0.6, blur: 2 } } },
  },
});
