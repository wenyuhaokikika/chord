#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
在安卓模拟器上真机跑一遍 APK：自动建 AVD -> 启动 -> 安装 -> 启动 App -> 截图 -> 收集日志。

适合“不想插手机，但想看看 APK 在真实 Android 上长什么样”的场景。
需要：SDK 里有 emulator 与 system-images，且 Windows 上开启了 Hyper-V/WHPX（或 AEHD）加速。

用法：
    python tools/run_on_emulator.py                      # 默认 API 34，无窗口，截 3 张图
    python tools/run_on_emulator.py --api 21             # 换成 API 21（验证 minSdk）
    python tools/run_on_emulator.py --window             # 显示模拟器窗口，自己点着玩
    python tools/run_on_emulator.py --keep               # 跑完不关模拟器

产物：
    build/emulator/api<级别>-1.png ...      截图
    build/emulator/logcat.txt               应用与 WebView 日志（排查崩溃用）
"""
import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SDK = os.path.join(ROOT, ".toolchain", "android-sdk")
AVD_HOME = os.path.join(ROOT, ".toolchain", "avd")
OUT = os.path.join(ROOT, "build", "emulator")
PACKAGE = "com.chord.helper"

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass


def find_tool(name, *subdirs):
    for sub in subdirs:
        for cand in (name + ".exe", name + ".bat", name):
            p = os.path.join(SDK, sub, cand)
            if os.path.exists(p):
                return p
    for base in (os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT")):
        if base:
            for sub in subdirs:
                for cand in (name + ".exe", name + ".bat", name):
                    p = os.path.join(base, sub, cand)
                    if os.path.exists(p):
                        return p
    return None


def env_with_java():
    env = dict(os.environ)
    for cand in (os.environ.get("JAVA_HOME"), os.path.join(ROOT, ".toolchain", "jdk", "jdk-17")):
        if cand and os.path.exists(os.path.join(cand, "bin", "java.exe")):
            env["JAVA_HOME"] = cand
            env["PATH"] = os.path.join(cand, "bin") + os.pathsep + env.get("PATH", "")
            break
    env["ANDROID_SDK_ROOT"] = SDK
    env["ANDROID_AVD_HOME"] = AVD_HOME
    return env


def run(cmd, env, timeout=600, quiet=True):
    proc = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, errors="replace", timeout=timeout)
    if not quiet and proc.stdout.strip():
        print(proc.stdout.strip())
    return proc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", type=int, default=34, help="系统镜像的 API 级别（默认 34）")
    ap.add_argument("--apk", help="APK 路径，默认 dist 下最新")
    ap.add_argument("--window", action="store_true", help="显示模拟器窗口")
    ap.add_argument("--keep", action="store_true", help="跑完保留模拟器")
    ap.add_argument("--shots", type=int, default=3, help="截几张图（默认 3）")
    ap.add_argument("--timeout", type=int, default=420, help="等待开机的最长秒数")
    args = ap.parse_args()

    emulator = find_tool("emulator", "emulator")
    adb = find_tool("adb", os.path.join("platform-tools"), "platform-tools")
    avdmanager = find_tool("avdmanager", os.path.join("cmdline-tools", "latest", "bin"),
                           os.path.join("cmdline-tools", "bin"))
    if not (emulator and adb and avdmanager):
        print("[错误] 缺少 emulator / adb / avdmanager，请先在 SDK 里安装：")
        print('  sdkmanager "emulator" "platform-tools" "system-images;android-%d;google_apis;x86_64"' % args.api)
        return 1

    apk = args.apk
    if not apk:
        dist = os.path.join(ROOT, "dist")
        apks = sorted(glob.glob(os.path.join(dist, "*.apk"))) if os.path.isdir(dist) else []
        apk = apks[-1] if apks else None
    if not apk or not os.path.exists(apk):
        print("[错误] 找不到 APK，先执行 python tools/build_apk.py")
        return 1

    image = "system-images;android-%d;google_apis;x86_64" % args.api
    avd_name = "chord%d" % args.api
    env = env_with_java()
    os.makedirs(AVD_HOME, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)

    # 1) 建 AVD（已存在就复用）
    existing = [l.strip() for l in run([avdmanager, "list", "avd"], env).stdout.split("\n") if l.strip().startswith("Name:")]
    if not any(l.split(":", 1)[1].strip() == avd_name for l in existing):
        print("[1/6] 创建 AVD %s（镜像 %s）" % (avd_name, image))
        proc = subprocess.run([avdmanager, "create", "avd", "-n", avd_name, "-k", image,
                               "-d", "pixel_5", "--force"],
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, input="no\n", timeout=600)
        if proc.returncode != 0:
            print(proc.stdout)
            print("[失败] 创建 AVD 失败，确认镜像已安装： sdkmanager \"%s\"" % image)
            return 1
    else:
        print("[1/6] 复用已有 AVD %s" % avd_name)

    # 2) 启动模拟器
    print("[2/6] 启动模拟器（%s）..." % ("带窗口" if args.window else "无窗口，硬件加速"))
    cmd = [emulator, "-avd", avd_name, "-no-snapshot", "-no-boot-anim",
           "-no-audio", "-gpu", "swiftshader_indirect", "-memory", "2048"]
    if not args.window:
        cmd.append("-no-window")
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 3) 等设备 + 等开机完成
    print("[3/6] 等待设备上线...")
    t0 = time.time()
    run([adb, "start-server"], env)
    booted = False
    while time.time() - t0 < args.timeout:
        out = run([adb, "shell", "getprop", "sys.boot_completed"], env, timeout=60).stdout
        if "1" in out:
            booted = True
            break
        if proc.poll() is not None:
            print("[失败] 模拟器进程已退出，可能是加速不可用或镜像损坏")
            return 1
        time.sleep(5)
    if not booted:
        print("[失败] 等开机超时（%ds）" % args.timeout)
        return 1
    print("      开机完成，用时 %.0fs" % (time.time() - t0))
    run([adb, "shell", "settings", "put", "global", "window_animation_scale", "0"], env)
    run([adb, "shell", "settings", "put", "global", "transition_animation_scale", "0"], env)
    time.sleep(3)

    # 4) 安装
    print("[4/6] 安装 %s" % os.path.basename(apk))
    res = run([adb, "install", "-r", "-d", apk], env, timeout=600, quiet=True)
    print("      " + res.stdout.strip().replace("\n", "\n      "))
    if "Success" not in res.stdout:
        print("[失败] 安装失败")
        return 1

    # 5) 启动 App 并截图
    print("[5/6] 启动 App 并截图")
    run([adb, "logcat", "-c"], env)
    run([adb, "shell", "am", "start", "-n", PACKAGE + "/.MainActivity"], env)
    # 等 App 自己报告页面加载完成（WebView 首次初始化比较慢，不能用固定 sleep）
    t1 = time.time()
    while time.time() - t1 < 90:
        lg = run([adb, "logcat", "-d", "-s", "ChordHelper:I"], env, timeout=60).stdout
        if "onPageFinished" in lg:
            break
        time.sleep(2)
    time.sleep(2.5)
    print("      页面加载完成，用时 %.1fs" % (time.time() - t1))
    shots = []
    for i in range(args.shots):
        path = os.path.join(OUT, "api%d-%d.png" % (args.api, i + 1))
        with open(path, "wb") as f:
            subprocess.run([adb, "exec-out", "screencap", "-p"], env=env, stdout=f, timeout=120)
        shots.append(path)
        print("      已截图 %s" % os.path.relpath(path, ROOT))
        if i == 0:
            # 第二张：滚动到指法列表
            run([adb, "shell", "input", "swipe", "195", "700", "195", "260", "300"], env)
            time.sleep(2)
        elif i == 1:
            # 第三张：打开查询条件面板
            run([adb, "shell", "input", "tap", "22", "165"], env)
            time.sleep(2)

    # 6) 收集日志与状态
    print("[6/6] 收集日志")
    log = run([adb, "logcat", "-d", "-v", "brief"], env, timeout=180).stdout
    keep = [l for l in log.split("\n")
            if any(k in l for k in ("chord", "WebView", "chromium", "AndroidRuntime", "ActivityManager: Start",
                                    "FATAL", "Exception"))]
    log_path = os.path.join(OUT, "logcat.txt")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write("\n".join(keep))
    print("      日志 %s（%d 行）" % (os.path.relpath(log_path, ROOT), len(keep)))
    fatal = [l for l in keep if "FATAL" in l or "AndroidRuntime" in l]
    if fatal:
        print("      [注意] 日志里有异常：")
        for l in fatal[:6]:
            print("        " + l.strip()[:160])
    else:
        print("      没有崩溃异常")

    if not args.keep:
        print("关闭模拟器...")
        run([adb, "emu", "kill"], env)
        time.sleep(3)
        if proc.poll() is None:
            proc.terminate()
    print("[完成] 截图在 %s" % os.path.relpath(OUT, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
