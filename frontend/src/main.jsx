import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles.css";
import App from "./App.jsx";
import Standalone from "./Standalone.jsx";

// ?tool=manage or ?tool=build: that tool alone, in a window of its own
const tool = new URLSearchParams(location.search).get("tool");

createRoot(document.getElementById("root")).render(
  tool === "manage" || tool === "build"
    ? <Standalone tool={tool} />
    : <ReactFlowProvider><App /></ReactFlowProvider>
);
