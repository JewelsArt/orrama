import React from "react";
import { createRoot } from "react-dom/client";
import "@orrama/ui/fonts.css";
import "@orrama/ui/tokens.css";
// After tokens.css: a vision mode overrides the palette it just defined.
import "@orrama/ui/vision.css";
import "@orrama/ui/base.css";
// The old app.css, one file per area (R0, a pure move). The order is the cascade: each file's
// rules kept their order, and no rule that used to override another now comes before it
// (checked rule by rule, then every page compared computed style for computed style). The shell
// goes last because its phone block, which frames every page, was the end of app.css.
import "./styles/shared.css";
import "./styles/door.css";
import "./styles/notes.css";
import "./styles/find.css";
import "./styles/settings.css";
import "./styles/planning.css";
import "./styles/ask.css";
import "./styles/new.css";
import "./styles/orrery.css";
import "./styles/reader.css";
import "./styles/people.css";
import "./styles/editor.css";
import "./styles/today.css";
import "./styles/entity.css";
import "./styles/noticed.css";
import "./styles/project.css";
import "./styles/mail.css";
import "./styles/money.css";
import "./styles/projects.css";
import "./styles/shell.css";
// The design system last: its classes are its own, and it wins any tie with an older rule.
import "./ui/ui.css";
// Clay, the second look (19 Oct 2026): last, so it retints the components and the areas above.
import "@orrama/ui/clay.css";
import { App } from "./App.js";
import { guardStorage, migrateLegacyKeys } from "./storage.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import { installReloadKey } from "./ui/reloadKey.js";
import { installLeaveGuard } from "./noteSync.js";
import { installWriteNet } from "./ui/writes.js";

// Before anything reads a key: what this browser kept under the old basalt-… names moves to
// orrama-…, the session token included, so the rename signs no one out (R13).
migrateLegacyKeys();
// Before anything renders: a browser that refuses storage gets an in-memory one, so screens
// that still call localStorage directly keep working (WEB-025).
guardStorage();

// ⌘R, outside React, so it still reloads when a view, or the app, has crashed (WEB-011).
installReloadKey();
// Reload, ⌘R, Update ready and closing the window send a note's pending typing on the way out (WEB-002).
installLeaveGuard();
// A write that failed and that nothing caught is still said on screen, not only in the console (WEB-010).
installWriteNet();

const root = createRoot(document.getElementById("root")!);
if (import.meta.env.DEV && location.pathname === "/dev/ui") {
  // The component gallery, for the dev server only: a production build drops this branch and
  // the module with it.
  void import("./ui/dev/Gallery.js").then(({ Gallery }) => root.render(<Gallery />));
} else {
  root.render(
    <React.StrictMode>
      {/* The last line: if even the shell fails, a notice and Reload instead of a blank window. */}
      <ErrorBoundary what="Orrama">
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
