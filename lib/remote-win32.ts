import { dlopen } from "bun:ffi";
import { join, win32 } from "node:path";

function kernelLibrary() {
  return dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetFileInformationByHandle: { args: ["u64", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
    CreateDirectoryW: { args: ["ptr", "ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    LocalFree: { args: ["u64"], returns: "u64" },
    lstrlenW: { args: ["u64"], returns: "i32" },
    RtlMoveMemory: { args: ["ptr", "u64", "u64"], returns: "void" },
    TerminateJobObject: { args: ["u64", "u32"], returns: "i32" },
  });
}

let kernel: ReturnType<typeof kernelLibrary> | undefined;
function api() {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) throw new Error("当前宿主不支持 Windows 运维。");
  return (kernel ??= kernelLibrary()).symbols;
}

function securityLibrary() {
  return dlopen("advapi32.dll", {
    CreateWellKnownSid: { args: ["i32", "ptr", "ptr", "ptr"], returns: "i32" },
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    ConvertSidToStringSidW: { args: ["u64", "ptr"], returns: "i32" },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
    GetSecurityDescriptorDacl: { args: ["u64", "ptr", "ptr", "ptr"], returns: "i32" },
    SetNamedSecurityInfoW: { args: ["ptr", "i32", "u32", "u64", "u64", "u64", "u64"], returns: "u32" },
    GetNamedSecurityInfoW: { args: ["ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: { args: ["u64", "u32", "u32", "ptr", "ptr"], returns: "i32" },
    CheckTokenMembership: { args: ["u64", "ptr", "ptr"], returns: "i32" },
  });
}

export function windowsRemoteAdministrator(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const library = securityLibrary();
    try {
      const sid = Buffer.alloc(68);
      const length = Buffer.alloc(4);
      length.writeUInt32LE(sid.length);
      const member = Buffer.alloc(4);
      return library.symbols.CreateWellKnownSid(26, null, sid, length) !== 0 &&
        library.symbols.CheckTokenMembership(0n, sid, member) !== 0 && member.readInt32LE() !== 0;
    } finally {
      library.close();
    }
  } catch {
    return false;
  }
}

export function windowsRemoteJob(pid: number) {
  const native = api();
  const job = native.CreateJobObjectW(null, null);
  if (job === 0n) throw new Error("无法创建 Windows 远程进程作业。");
  try {
    const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on Win64.
    limits.writeUInt32LE(0x00002000, 16); // BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE.
    if (!native.SetInformationJobObject(job, 9, limits, limits.length)) throw new Error("无法限制远程进程作业。");
    const processHandle = native.OpenProcess(0x0101, 0, pid); // SET_QUOTA | TERMINATE.
    if (processHandle === 0n) throw new Error("无法打开远程命令进程。");
    try {
      if (!native.AssignProcessToJobObject(job, processHandle)) throw new Error("无法派发远程进程作业。");
    } finally {
      native.CloseHandle(processHandle);
    }
  } catch (error) {
    native.CloseHandle(job);
    throw error;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    native.TerminateJobObject(job, 1);
    native.CloseHandle(job);
  };
}

function pinPath(path: string, directory: boolean) {
  const native = api();
  const wide = Buffer.from(path + "\u0000", "utf16le");
  // Read only the attributes and withhold write and delete sharing throughout the operation.
  const handle = native.CreateFileW(wide, 0x0080, 0x00000001, null, 3, 0x02200000, 0n);
  if (handle === 0xffffffffffffffffn || handle === 0n) throw new Error("无法打开受保护的运维路径。");
  const info = Buffer.alloc(52);
  try {
    if (!native.GetFileInformationByHandle(handle, info)) throw new Error("无法核对运维路径。");
    const attributes = info.readUInt32LE();
    if ((attributes & 0x0400) !== 0 || ((attributes & 0x0010) !== 0) !== directory ||
        !directory && info.readUInt32LE(40) !== 1) {
      throw new Error("运维路径不能使用链接或重解析点。");
    }
  } catch (error) {
    native.CloseHandle(handle);
    throw error;
  }
  return () => native.CloseHandle(handle);
}

export async function withWindowsRemotePath<T>(
  root: string, parts: readonly string[], name: string, read: boolean, access: (path: string, name: string) => Promise<T>,
) {
  const drive = win32.parse(root).root;
  if (!/^[A-Za-z]:\\$/u.test(drive)) throw new Error("运维文件仅支持 Windows 本地盘。");
  const release: (() => unknown)[] = [];
  let directory = drive;
  try {
    for (const part of [...root.slice(drive.length).split("\\").filter(Boolean), ...parts]) {
      directory = join(directory, part);
      release.push(pinPath(directory, true));
    }
    const target = join(directory, name);
    if (read) release.push(pinPath(target, false));
    return await access(target, name);
  } finally {
    for (const close of release.reverse()) close();
  }
}


function wideString(value: string) {
  return Buffer.from(value + "\u0000", "utf16le");
}

function fromNativeWideString(pointer: bigint) {
  const native = api();
  const length = native.lstrlenW(pointer);
  if (length < 1 || length > 16_384) throw new Error("Windows 安全描述符无效。");
  const buffer = Buffer.alloc(length * 2);
  native.RtlMoveMemory(buffer, pointer, BigInt(buffer.length));
  return buffer.toString("utf16le");
}

function hostSid(security: ReturnType<typeof securityLibrary>["symbols"]) {
  const token = Buffer.alloc(8);
  if (!security.OpenProcessToken(0xffffffffffffffffn, 0x0008, token)) throw new Error("无法读取 Windows 运行账号。");
  const handle = token.readBigUInt64LE();
  const native = api();
  try {
    const required = Buffer.alloc(4);
    security.GetTokenInformation(handle, 1, null, 0, required);
    const size = required.readUInt32LE();
    if (size < 16 || size > 16_384) throw new Error("Windows 运行账号无效。");
    const information = Buffer.alloc(size);
    if (!security.GetTokenInformation(handle, 1, information, size, required)) throw new Error("无法读取 Windows 运行账号。");
    const stringPointer = Buffer.alloc(8);
    if (!security.ConvertSidToStringSidW(information.readBigUInt64LE(), stringPointer)) throw new Error("无法识别 Windows 运行账号。");
    const pointer = stringPointer.readBigUInt64LE();
    try { return fromNativeWideString(pointer); }
    finally { native.LocalFree(pointer); }
  } finally {
    native.CloseHandle(handle);
  }
}

export function protectWindowsRemoteAuth(path: string, create: boolean, directory: boolean) {
  const library = securityLibrary();
  const security = library.symbols;
  const native = api();
  const target = wideString(path);
  try {
    const sid = hostSid(security);
    function descriptorString(descriptor: bigint) {
      const output = Buffer.alloc(8);
      if (!security.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 5, output, null)) {
        throw new Error("无法核对 Windows 运维配对权限。");
      }
      const text = output.readBigUInt64LE();
      try { return fromNativeWideString(text); }
      finally { native.LocalFree(text); }
    }

    const descriptor = Buffer.alloc(8);
    if (!security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
      wideString(`O:${sid}D:P(A;${directory ? "OICI" : ""};FA;;;${sid})`), 1, descriptor, null,
    )) throw new Error("无法准备 Windows 运维配对权限。");
    const expected = descriptor.readBigUInt64LE();
    try {
      if (create) {
        const attributes = Buffer.alloc(24);
        attributes.writeUInt32LE(24);
        attributes.writeBigUInt64LE(expected, 8);
        // Only the running Windows account can access this directory and files it creates.
        let created = false;
        if (directory) {
          created = native.CreateDirectoryW(target, attributes) !== 0;
        } else {
          const file = native.CreateFileW(target, 0x0080, 0x00000001, attributes, 1, 0x80, 0n);
          created = file !== 0xffffffffffffffffn && file !== 0n;
          if (created) native.CloseHandle(file);
        }
        if (created) {
          const acl = Buffer.alloc(8);
          const exists = Buffer.alloc(4);
          if (!security.GetSecurityDescriptorDacl(expected, exists, acl, Buffer.alloc(4)) ||
              !exists.readInt32LE() || security.SetNamedSecurityInfoW(target, 1, 0x80000004,
                0n, 0n, acl.readBigUInt64LE(), 0n) !== 0) {
            throw new Error("无法设置 Windows 运维配对权限。");
          }
        } else if (native.GetLastError() !== 183) {
          throw new Error(directory ? "无法建立 Windows 运维配对目录。" : "无法建立 Windows 运维配对数据库。");
        }
      }
      const actual = Buffer.alloc(8);
      const release = pinPath(path, directory);
      try {
        if (security.GetNamedSecurityInfoW(target, 1, 5, null, null, null, null, actual) !== 0) {
          throw new Error("无法读取 Windows 运维配对权限。");
        }
        const current = actual.readBigUInt64LE();
        try {
          const normalized = (text: string) => text.replace(/D:[A-Z]*/u, "D:");
          const value = descriptorString(current);
          if (!/D:P/u.test(value) || normalized(value) !== normalized(descriptorString(expected))) {
            throw new Error(directory ? "Windows 运维配对目录的权限过宽。" : "Windows 运维配对数据库的权限过宽。");
          }
        } finally {
          native.LocalFree(current);
        }
      } finally {
        release();
      }
    } finally {
      native.LocalFree(expected);
    }
  } finally {
    library.close();
  }
}
