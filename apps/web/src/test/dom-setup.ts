/** Every DOM test starts from an empty page and empty storage. */
import { cleanup } from "@testing-library/react";
import { Storage } from "happy-dom";
import { afterEach } from "vitest";

// Node 22+ has an experimental global localStorage of its own (undefined unless Node is started
// with --localstorage-file) that wins over happy-dom's when the environment fills the globals.
// The app reads the bare global, so give it real Web Storage, as a browser would.
for (const name of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, name, { value: new Storage(), configurable: true, writable: true });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
