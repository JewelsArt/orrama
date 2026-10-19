/* Before the first frame (WEB-019): the theme and colour-vision mode this device showed last
   go on <html> before anything draws, so a reload never flashes the other theme while the app
   loads. The rule is resolveTheme's in src/ui/theme.ts (its test runs this file against it);
   App keeps the keys current. A file from this origin, because the CSP allows no inline script.
   Until the rename to Orrama the keys were basalt-…; main.tsx moves them, after this has run, so
   the first load of the renamed app still finds them under the old name (R13). */
(function () {
  var root = document.documentElement;
  function read(name) {
    try {
      var value = window.localStorage.getItem("orrama-" + name);
      return value !== null ? value : window.localStorage.getItem("basalt-" + name);
    } catch (e) {
      return null;
    }
  }
  var dark;
  if (read("theme-device") === "match") {
    dark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } else {
    var stored = read("theme");
    dark = stored === "dark" || stored === "command";
  }
  // The look (Clay, 19 Oct 2026): Clay's day and night are their own data-themes.
  if (read("look") === "clay") root.setAttribute("data-theme", dark ? "clay-dark" : "clay");
  else root.setAttribute("data-theme", dark ? "dark" : "light");
  var vision = read("vision");
  if (vision) root.setAttribute("data-vision", vision);
})();
