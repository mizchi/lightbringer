import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Serves the bench fixture app (fixtures/app) for the local bench specs.
export default defineConfig({
  root: "fixtures/app",
  plugins: [react()],
});
