import type { CommandModule } from "./commands.ts";

export const donationCommand: CommandModule = {
  name: "@lotus-yunzai/donation",
  aliases: {
    "捐赠": "#捐赠",
    "#donate": "#捐赠",
    "donate": "#捐赠",
    "#Donate": "#捐赠",
    "Donate": "#捐赠",
  },
  commands: {
    "#捐赠": argument => argument ? [] : "https://www.lotusshared.cn/donate",
  },
};
