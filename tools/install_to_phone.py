#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 dist 下的 APK 安装到已连接的安卓手机（Windows / macOS / Linux 通用）。

会自动在几个常见位置找 adb：
    1. 项目内的 .toolchain/android-sdk/platform-tools/adb(.exe)
    2. 环境变量 ANDROID_HOME / ANDROID_SDK_ROOT / 默认 SDK 安装目录
    3. 手机助手类工具自带的 adb（如 vivo PC 套件）
    4. 系统 PATH

用法：
    python tools/install_to_phone.py            # 安装最新版本
    python tools/install_to_phone.py --run      # 装完顺便启动 App
    python tools/install_to_phone.py --list     # 只看设备列表
"""
import argparse
import glob
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 控制台/管道编码兜底：避免个别符号在旧代码页下直接抛异常
try:
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")
except Exception:
    pass

ADB_CANDIDATES = [
    os.path.join(ROOT, ".toolchain", "android-sdk", "platform-tools", "adb"),
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk", "platform-tools", "adb"),
    r"D:\program\vivo\pcsuite\adb\adb",          # vivo PC 套件自带
    r"D:\program\vivo\pcsuite\adb_41\adb",
    r"C:\Program Files\Android\Android Studio\platform-tools\adb",
    r"C:\Program Files (x86)\Android\android-sdk\platform-tools\adb",
    "/usr/local/bin/adb",
    "/usr/bin/adb",
]

EXE = ".exe" if os.name == "nt" else ""


def find_adb():
    for cand in ADB_CANDIDATES:
        for path in (cand + EXE, cand):
            if path and os.path.exists(path):
                return path
    for base in (os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT")):
        if base:
            path = os.path.join(base, "platform-tools", "adb" + EXE)
            if os.path.exists(path):
                return path
    for path in os.environ.get("PATH", "").split(os.pathsep):
        cand = os.path.join(path, "adb" + EXE)
        if os.path.exists(cand):
            return cand
    return None


def adb(adb_path, *args, **kw):
    cmd = [adb_path] + list(args)
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, errors="replace", timeout=kw.get("timeout", 180))


def devices(adb_path):
    out = adb(adb_path, "devices").stdout or ""
    result = []
    for line in out.split("\n")[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) >= 2:
            result.append((parts[0], parts[1]))
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", help="指定 APK 路径，默认取 dist 下最新的那个")
    ap.add_argument("--run", action="store_true", help="安装完成后直接启动 App")
    ap.add_argument("--list", action="store_true", help="只列出已连接的设备")
    args = ap.parse_args()

    adb_path = find_adb()
    if not adb_path:
        print("[错误] 没找到 adb。装一下 Android SDK 的 platform-tools，")
        print("       或者直接把 APK 复制进手机里点击安装。")
        return 1
    print("使用 adb: %s" % adb_path)

    if args.list:
        adb(adb_path, "start-server")
        for serial, state in devices(adb_path):
            print("  %-24s %s" % (serial, state))
        return 0

    apk = args.apk
    if not apk:
        found = sorted(glob.glob(os.path.join(ROOT, "dist", "*.apk")))
        if not found:
            print("[错误] dist/ 下没有 APK，先执行： python tools/build_apk.py")
            return 1
        apk = found[-1]
    if not os.path.exists(apk):
        print("[错误] 找不到 APK: %s" % apk)
        return 1
    print("安装包: %s (%.1f KB)" % (apk, os.path.getsize(apk) / 1024.0))

    adb(adb_path, "start-server")
    devs = devices(adb_path)
    ready = [s for s, st in devs if st == "device"]
    if not devs:
        print()
        print("[提示] 没有检测到手机，请依次检查：")
        print("  1. 手机「设置 → 关于手机 → 版本号」连点 7 次，开启开发者模式")
        print("  2. 「开发者选项」里打开 USB 调试（vivo/OPPO/小米 还需打开“USB 安装”）")
        print("  3. 用数据线连电脑，手机上弹出“允许 USB 调试”要点允许")
        print("  4. 状态若为 unauthorized，解锁屏幕后重新点一次“允许”")
        print()
        print("  连不上也不影响试用：把下面这个文件复制进手机，点击安装即可：")
        print("  %s" % apk)
        return 1
    if not ready:
        for serial, state in devs:
            print("  %-24s %s" % (serial, state))
        print()
        print("[提示] 设备还没授权（状态 %s）。解锁手机屏幕，点“允许 USB 调试”。"
              % devs[0][1])
        return 1

    print("检测到设备: %s" % ", ".join(ready))
    print("正在安装（-r 覆盖安装，保留数据）...")
    res = adb(adb_path, "install", "-r", "-d", apk, timeout=600)
    print(res.stdout.strip())
    if res.returncode != 0 or "Success" not in (res.stdout or ""):
        print()
        print("[失败] 常见原因：")
        print("  - 手机上已有同包名但签名不同的旧版本，先在手机上卸载再试")
        print("  - 手机需要手动确认安装弹窗")
        print("  - 数据线只能充电不能传数据，换线或换 USB 口")
        print("  - 手机系统禁止了 USB 安装，去开发者选项里打开")
        return 1

    print("[完成] 已安装，手机上找「和弦助手」图标打开。")
    if args.run:
        adb(adb_path, "shell", "monkey", "-p", "com.chord.helper",
            "-c", "android.intent.category.LAUNCHER", "1")
        print("[完成] 已尝试启动 App（看手机屏幕）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
