/* Before the first frame (WEB-019): the theme and colour-vision mode this device showed last
   go on <html> before anything draws, so a reload never flashes the other theme while the app
   loads. The rule is resolveTheme's in src/ui/theme.ts (its test runs this file against it);
   App keeps the keys current. A file from this origin, because the CSP allows no inline script. */
(function () {
  var root = document.documentElement;
  function read(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  var dark;
  if (read("basalt-theme-device") === "match") {
    dark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } else {
    var stored = read("basalt-theme");
    dark = stored === "dark" || stored === "command";
  }
  root.setAttribute("data-theme", dark ? "dark" : "light");
  var vision = read("basalt-vision");
  if (vision) root.setAttribute("data-vision", vision);
})();
