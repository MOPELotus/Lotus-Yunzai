import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import QRCode from "qrcode";
import { importLegacyRemoteOtp, rotateRemoteOtp } from "../lib/remote-otp.ts";

const mode = Bun.argv[2];
const source = mode === "import" && Bun.argv.length === 4 ? Bun.argv[3] : undefined;
const generates = Bun.argv.length === 3 && (mode === "setup" || mode === "reset");
if (!process.stdout.isTTY || (!generates && !source)) {
  console.error($t("scripts.remote-otp.text_18af8af583"));
  process.exitCode = 1;
} else if (source) {
  try {
    importLegacyRemoteOtp(process.cwd(), source);
    console.log($t("scripts.remote-otp.text_b39f3cf372"));
  } catch {
    console.error($t("scripts.remote-otp.text_a52e02eca7"));
    process.exitCode = 1;
  }
} else {
  try {
    const uri = rotateRemoteOtp(process.cwd(), mode === "reset");
    try {
      const qr = await QRCode.toString(uri, { type: "terminal", small: true });
      process.stdout.write(qr);
    } catch {
      process.stdout.write(`${uri}\n`);
    }
  } catch {
    console.error($t("scripts.remote-otp.text_b0d4859440"));
    process.exitCode = 1;
  }
}
