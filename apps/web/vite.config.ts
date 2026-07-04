import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = `http://127.0.0.1:${process.env.BASALT_API_PORT ?? 4623}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.BASALT_WEB_PORT ?? 4625),
    proxy: {
      "/api": { target: api, ws: true },
      // Private calendar feed URLs (/ics/<token>.ics) are same-origin in prod;
      // proxy them in dev so a copied URL works there too.
      "/ics": { target: api },
    },
  },
});
