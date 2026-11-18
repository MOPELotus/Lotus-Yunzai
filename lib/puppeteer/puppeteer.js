import { segment } from "../messages.ts";
import { renderTemplate } from "../renderer/shotium.ts";

export default {
  id: "shotium",
  type: "image",
  support_script: false,
  async render(_name, data = {}) {
    const images = await renderTemplate(data);
    return images && (data.multiPage ? images : images[0] ?? false);
  },
  async screenshot(_name, data = {}) {
    const images = await renderTemplate({ ...data, multiPage: false });
    return images && images[0] ? segment.image(images[0]) : false;
  },
  async screenshots(_name, data = {}) {
    const images = await renderTemplate({ ...data, multiPage: true });
    return images ? images.map((image) => segment.image(image)) : false;
  },
};
