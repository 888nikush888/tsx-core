import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "./index.css";
import App from "./App.tsx";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Dashboard root element is missing.");
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
