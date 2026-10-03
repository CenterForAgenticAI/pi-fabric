import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Fixture-only Linux x86-64 cBPF filter. Constants: linux/seccomp.h,
// linux/audit.h and asm/unistd_64.h. Reject other ABIs (including x32) rather
// than applying x86-64 syscall numbers to them. No new library or privilege.
function noSocketsFilter() {
  const instructions = [
    [0x20, 0, 0, 4], // seccomp_data.arch
    [0x15, 1, 0, 0xc000003e], // AUDIT_ARCH_X86_64
    [0x06, 0, 0, 0x80000000], // SECCOMP_RET_KILL_PROCESS
    [0x20, 0, 0, 0], // seccomp_data.nr
    [0x35, 0, 1, 0x40000000], // x32 / invalid syscall ABI
    [0x06, 0, 0, 0x80000000],
  ];
  // socket, connect, sendto, sendmsg, sendmmsg, io_uring_setup.
  // socketpair stays available for Node subprocess pipes (unnamed local IPC);
  // socket/connect remain forbidden for every family, including AF_UNIX.
  for (const nr of [41, 42, 44, 46, 307, 425]) {
    instructions.push([0x15, 0, 1, nr], [0x06, 0, 0, 0x00050001]); // ERRNO EPERM
  }
  instructions.push([0x06, 0, 0, 0x7fff0000]); // ALLOW
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    bytes.writeUInt16LE(code, index * 8);
    bytes[index * 8 + 2] = jt;
    bytes[index * 8 + 3] = jf;
    bytes.writeUInt32LE(k, index * 8 + 4);
  });
  return bytes;
}

export function isolatedSpawn(root, command, args, stdio = "pipe") {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("RPC sandbox requires Linux x86-64");
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const runtime = fs.realpathSync(process.execPath);
  const filter = path.join(root, "no-sockets.bpf");
  fs.writeFileSync(filter, noSocketsFilter(), { mode: 0o600 });
  const fd = fs.openSync(filter, "r");
  const infoFd = fs.openSync(path.join(root, "sandbox-info.json"), "w", 0o600);
  try {
    return spawnSync("/usr/bin/bwrap", [
      "--unshare-user", "--unshare-pid", "--new-session", "--die-with-parent",
      "--ro-bind", "/", "/", "--proc", "/proc",
      // Hide host homes, runtime sockets and temporary files. Re-expose only
      // this checkout, the runtime executable and the synthetic writable HOME.
      "--tmpfs", "/home", "--tmpfs", "/root", "--tmpfs", "/run", "--tmpfs", "/tmp",
      "--ro-bind", repo, repo, "--ro-bind", runtime, runtime,
      "--bind", root, root, "--chdir", root, "--seccomp", "3", "--info-fd", "4", "--", command, ...args,
    ], {
      stdio: [stdio, stdio, stdio, fd, infoFd], encoding: "utf8", timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
        PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1",
        TMPDIR: path.join(root, "tmp"), PROMPT_PROBE_ROOT: root },
    });
  } finally { fs.closeSync(fd); fs.closeSync(infoFd); fs.unlinkSync(filter); }
}
