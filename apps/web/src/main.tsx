import React from "react";
import { createRoot } from "react-dom/client";
import "@basalt/ui/fonts.css";
import "@basalt/ui/tokens.css";
// After tokens.css: a vision mode overrides the palette it just defined.
import "@basalt/ui/vision.css";
import "@basalt/ui/base.css";
// The old app.css, one file per area (R0, a pure move). The order is the cascade: each file's
// rules kept their order, and no rule that used to override another now comes before it
// (checked rule by rule, then every page compared computed style for computed style). The shell
// goes last because its phone block, which frames every page, was the end of app.css.
import "./styles/shared.css";
import "./styles/door.css";
import "./styles/notes.css";
import "./styles/find.css";
import "./styles/capture.css";
import "./styles/settings.css";
import "./styles/planning.css";
import "./styles/ask.css";
import "./styles/orrery.css";
import "./styles/reader.css";
import "./styles/people.css";
import "./styles/editor.css";
import "./styles/today.css";
import "./styles/project.css";
import "./styles/mail.css";
import "./styles/money.css";
import "./styles/projects.css";
import "./styles/shell.css";
// The design system last: its classes are its own, and it wins any tie with an older rule.
import "./ui/ui.css";
import { App } from "./App.js";
import { guardStorage } from "./storage.js";

// Before anything renders: a browser that refuses storage gets an in-memory one, so screens
// that still call localStorage directly keep working (WEB-025).
guardStorage();

const root = createRoot(document.getElementById("root")!);
if (import.meta.env.DEV && location.pathname === "/dev/ui") {
  // The component gallery, for the dev server only: a production build drops this branch and
  // the module with it.
  void import("./ui/dev/Gallery.js").then(({ Gallery }) => root.render(<Gallery />));
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
