const verification = /^(?:[#＃井]|\/)\s*(?:Bot|机器人)验证(?=$|[\s\d:：]|[^:\s]+[:：])/u;
const operation = /^#(?:Bot|机器人)(上线|下线)(.+)$/u;

export function isBotVerificationInput(text: string) {
  return verification.test(text.trimStart());
}

export function botOperationCommand(text: string) {
  text = text.trim();
  const control = operation.exec(text);
  const verify = text.startsWith("#") && isBotVerificationInput(text);
  if (!control && !verify) return;

  const target = verify
    ? text.replace(/^#\s*(?:Bot|机器人)验证/u, "").split(/[:：]/u, 1)[0]!.trim()
    : control![2]!.trim();
  const id = /^[1-9]\d{0,15}$/u.test(target) ? Number(target) : NaN;
  return { target: Number.isSafeInteger(id) ? id : undefined };
}
