import QRCode from "qrcode";
import { rotateRemoteOtp } from "../lib/remote-otp.ts";

const mode = Bun.argv[2];
if (!process.stdout.isTTY || Bun.argv.length !== 3 || (mode !== "setup" && mode !== "reset")) {
  console.error("请在私人本机终端运行 bun scripts/remote-otp.ts setup 或 bun scripts/remote-otp.ts reset。");
  process.exitCode = 1;
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
    console.error("配对未完成。请检查目录权限，已配对时使用 reset。");
    process.exitCode = 1;
  }
}
