import { createApp } from "vue";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/input/style/css";
import { bootstrapPanelLanguage } from "./i18n.ts";
import "./styles.css";

await bootstrapPanelLanguage();
const { default: App } = await import("./App.vue");
createApp(App).mount("#app");
