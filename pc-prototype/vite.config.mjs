import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  build: {
    outDir: "dist/client",
    // The connected app serves fonts from the same origin under its CSP.
    assetsInlineLimit: filePath => /\.(?:woff2?|ttf|otf)$/iu.test(filePath) ? false : undefined,
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: mode === "connected" ? "127.0.0.1" : "0.0.0.0",
    ...(mode === "connected" && {
      proxy: { "/api": process.env.BEITIBAO_LOCAL_API ?? "http://127.0.0.1:3041" },
    }),
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
}));
