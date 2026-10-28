import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: "Comic Translator",
    description: "Translate comic text in images while you read.",
    version: "0.1.0",
    permissions: ["storage", "activeTab", "scripting"],
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    optional_host_permissions: ["*://*/*"],
  },
});
