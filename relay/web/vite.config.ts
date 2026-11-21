import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({root:fileURLToPath(new URL(".",import.meta.url)),base:"/app/",plugins:[react()],build:{outDir:"dist",emptyOutDir:true,rollupOptions:{output:{manualChunks:{sodium:["libsodium-wrappers-sumo"]}}}},server:{host:"127.0.0.1",port:8792,proxy:{"/api":"http://127.0.0.1:8790","/ws":"ws://127.0.0.1:8790"}}});
