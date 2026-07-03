import React from "react";
import { createRoot } from "react-dom/client";
import "@basalt/ui/tokens.css";
import "@basalt/ui/base.css";
import "./app.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
