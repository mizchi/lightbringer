import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Serves a delayed /api/slow?ms= endpoint for the network-waterfall bench.
const slowApi = (): Plugin => ({
  name: "slow-api",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (u.pathname !== "/api/slow") return next();
      const ms = Number(u.searchParams.get("ms") ?? "200");
      setTimeout(() => {
        res.setHeader("content-type", "text/plain");
        res.end("ok");
      }, ms);
    });
  },
});

// Serves the bench fixture app (fixtures/app) for the local bench specs.
export default defineConfig({
  root: "fixtures/app",
  plugins: [react(), slowApi()],
});
