import { registerLanguage, setLanguage } from "../../packages/i18n/index.ts";

// Loaded before application labels are evaluated. The server injects display catalogs only.
try {
  const input = JSON.parse(document.getElementById("lotus-language")?.textContent || "null");
  if (typeof input?.language === "string" && input.messages && typeof input.messages === "object" && !Array.isArray(input.messages)) {
    registerLanguage(input.language, input.messages);
    setLanguage(input.language);
  }
} catch { /* A damaged optional display catalog does not interrupt account login. */ }
