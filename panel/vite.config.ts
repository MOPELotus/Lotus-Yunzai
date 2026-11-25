import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import chinese from "./i18n/zh-CN.json";

export default defineConfig({
  base: "./",
  plugins: [vue(), {
    name: "panel-localized-title",
    transformIndexHtml(html) {
      const title = chinese.messages["App.058cedd84e"].replace(/[&<>"']/gu,
        character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
      return html.replace("%LOTUS_PANEL_TITLE%", title);
    },
  }],
});
