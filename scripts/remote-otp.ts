import QRCode from "qrcode";
import { importLegacyRemoteOtp, rotateRemoteOtp } from "../lib/remote-otp.ts";

const mode = Bun.argv[2];
const source = mode === "import" && Bun.argv.length === 4 ? Bun.argv[3] : undefined;
const generates = Bun.argv.length === 3 && (mode === "setup" || mode === "reset");
if (!process.stdout.isTTY || (!generates && !source)) {
  console.error("请在私人本机终端运行 bun scripts/remote-otp.ts setup 或 bun scripts/remote-otp.ts reset。要导入旧配对，使用 bun scripts/remote-otp.ts import <旧 otp.yaml>。");
  process.exitCode = 1;
} else if (source) {
  try {
    importLegacyRemoteOtp(process.cwd(), source);
    console.log("旧验证器已导入。请等待下一分钟后再用验证码。");
  } catch {
    console.error("旧配对未导入。请检查文件格式、路径和本机是否已配对。");
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
    console.error("配对未完成。请检查目录权限，已配对时使用 reset。");
    process.exitCode = 1;
  }
}
