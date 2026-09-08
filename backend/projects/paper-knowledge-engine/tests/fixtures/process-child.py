"""Finite, offline Windows process fixture; never imports application/model code."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

# Even a blocked output pipe cannot turn a fixture into an unbounded process.
watchdog = threading.Timer(15.0, lambda: os._exit(124))
watchdog.daemon = True
watchdog.start()


def identity(role, directory):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    times = [ctypes.c_uint64() for _ in range(4)]
    kernel.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_uint64)] * 4
    if not kernel.GetProcessTimes(kernel.GetCurrentProcess(), *(ctypes.byref(t) for t in times)):
        raise ctypes.WinError(ctypes.get_last_error())
    item = {"pid": os.getpid(), "fileTime": str(times[0].value), "role": role}
    Path(directory, role + ".json").write_text(json.dumps(item), encoding="utf-8")
    print(json.dumps(item), flush=True)


mode = sys.argv[1]
if mode == "echo":
    print(json.dumps({"argv": sys.argv[2:], "cwd": os.getcwd(),
                      "env": os.environ.get("FSD_JOB_TEST"), "temp": os.environ.get("TEMP")}, ensure_ascii=False), flush=True)
elif mode == "exit":
    sys.exit(int(sys.argv[2]))
elif mode == "output":
    size = int(sys.argv[2])
    order = sys.argv[3] if len(sys.argv) > 3 else "both"
    streams = [(sys.stdout.buffer, b"O"), (sys.stderr.buffer, b"E")]
    if order == "stderr-first":
        streams.reverse()
    for stream, byte in streams:
        stream.write(byte * size)
        stream.flush()
elif mode == "tree":
    directory, role = sys.argv[2:4]
    lifetime = min(float(sys.argv[4]), 15.0)
    root_early = len(sys.argv) > 5 and sys.argv[5] == "root-early"
    identity(role, directory)
    if role != "grandchild":
        next_role = "child" if role == "root" else "grandchild"
        subprocess.Popen([sys.executable, "-B", __file__, "tree", directory, next_role,
                          str(lifetime)], close_fds=True)
    if role == "root" and len(sys.argv) > 5 and sys.argv[5] == "flood":
        ready_deadline = time.monotonic() + 2.0
        while not Path(directory, "grandchild.json").exists():
            if time.monotonic() >= ready_deadline:
                raise SystemExit("Tree not ready for output pressure")
            time.sleep(0.01)
        sys.stdout.buffer.write(b"P" * 1048576)
        sys.stdout.buffer.flush()
    time.sleep(0.8 if root_early and role == "root" else lifetime)
else:
    raise SystemExit("Unknown fixture mode")
