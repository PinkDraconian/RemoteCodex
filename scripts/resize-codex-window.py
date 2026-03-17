#!/usr/bin/env python3
import ctypes
import ctypes.util
import os
import re
import subprocess
import sys
import time


WINDOW_PATTERN = re.compile(r"^\s*(0x[0-9a-f]+)\s+\"Codex\":", re.IGNORECASE)


class XWindowChanges(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int),
        ("y", ctypes.c_int),
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("border_width", ctypes.c_int),
        ("sibling", ctypes.c_ulong),
        ("stack_mode", ctypes.c_int),
    ]


def read_root_geometry():
    output = subprocess.check_output(
        ["xrandr", "--current"],
        text=True,
        stderr=subprocess.DEVNULL,
    )
    match = re.search(r"current\s+(\d+)\s+x\s+(\d+)", output)
    if not match:
        raise RuntimeError("Unable to determine root display geometry.")
    return int(match.group(1)), int(match.group(2))


def find_codex_window_id():
    output = subprocess.check_output(
        ["xwininfo", "-root", "-tree"],
        text=True,
        stderr=subprocess.DEVNULL,
    )
    for line in output.splitlines():
        match = WINDOW_PATTERN.match(line)
        if match:
            return int(match.group(1), 16)
    return None


def main():
    display_name = os.environ.get("DISPLAY", ":99")
    target_width, target_height = read_root_geometry()

    lib_path = ctypes.util.find_library("X11")
    if not lib_path:
      raise RuntimeError("libX11 not found")
    x11 = ctypes.cdll.LoadLibrary(lib_path)

    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XQueryTree.argtypes = [
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.POINTER(ctypes.c_ulong),
        ctypes.POINTER(ctypes.c_ulong),
        ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
        ctypes.POINTER(ctypes.c_uint),
    ]
    x11.XMoveResizeWindow.argtypes = [
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint,
        ctypes.c_uint,
    ]
    x11.XResizeWindow.argtypes = [
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.c_uint,
        ctypes.c_uint,
    ]
    x11.XMapRaised.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XFree.argtypes = [ctypes.c_void_p]

    display = x11.XOpenDisplay(display_name.encode("utf-8"))
    if not display:
        raise RuntimeError(f"Unable to open X display {display_name}")

    try:
        for _ in range(40):
            window_id = find_codex_window_id()
            if not window_id:
                time.sleep(0.5)
                continue

            root = ctypes.c_ulong()
            parent = ctypes.c_ulong()
            children = ctypes.POINTER(ctypes.c_ulong)()
            child_count = ctypes.c_uint()
            status = x11.XQueryTree(
                display,
                ctypes.c_ulong(window_id),
                ctypes.byref(root),
                ctypes.byref(parent),
                ctypes.byref(children),
                ctypes.byref(child_count),
            )
            if status == 0:
                time.sleep(0.5)
                continue

            try:
                frame_id = parent.value or window_id
            finally:
                if children:
                    x11.XFree(children)

            x11.XMoveResizeWindow(
                display,
                ctypes.c_ulong(frame_id),
                0,
                0,
                target_width,
                target_height,
            )
            x11.XResizeWindow(
                display,
                ctypes.c_ulong(window_id),
                target_width,
                target_height,
            )
            x11.XMapRaised(display, ctypes.c_ulong(frame_id))
            x11.XRaiseWindow(display, ctypes.c_ulong(frame_id))
            x11.XFlush(display)
            time.sleep(0.4)
        return 0
    finally:
        x11.XFlush(display)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"resize-codex-window: {exc}", file=sys.stderr)
        raise SystemExit(1)
