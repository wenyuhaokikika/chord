#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
直接用 Android SDK 的构建工具打 APK —— 不需要 Gradle / AGP / Android Studio。

流程与 AGP 内部一致：
    aapt2 compile + link  ->  javac  ->  d8  ->  合并 classes.dex  ->  zipalign  ->  apksigner

用法：
    python tools/build_apk.py                 # 使用 .toolchain 下的本地工具链
    python tools/build_apk.py --release       # 加上 jni 对齐（默认已开）

环境变量（可选，覆盖自动探测）：
    JAVA_HOME       JDK 目录
    ANDROID_SDK     包含 platforms/ 与 build-tools/ 的 SDK 目录
    BUILD_TOOLS     指定 build-tools 版本目录名（默认取最大版本）

产物： dist/ChordHelper-<版本>.apk
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLCHAIN = os.path.join(ROOT, ".toolchain")

VERSION_CODE = "8"
VERSION_NAME = "1.3.0"
PACKAGE = "com.chord.helper"
MIN_SDK = "21"
TARGET_SDK = "34"
COMPILE_SDK = "34"


def log(msg):
    print("[build] " + msg, flush=True)


def die(msg):
    print("[build] 失败: " + msg, file=sys.stderr, flush=True)
    sys.exit(1)


def find_jdk():
    if os.environ.get("JAVA_HOME") and os.path.exists(os.path.join(os.environ["JAVA_HOME"], "bin", "javac.exe")):
        return os.environ["JAVA_HOME"]
    cand = os.path.join(TOOLCHAIN, "jdk", "jdk-17")
    if os.path.exists(os.path.join(cand, "bin", "javac.exe")):
        return cand
    for base in (r"C:\Program Files\Java", r"C:\Program Files\Eclipse Adoptium", r"C:\Program Files\Microsoft"):
        if os.path.isdir(base):
            for name in sorted(os.listdir(base), reverse=True):
                p = os.path.join(base, name)
                if os.path.exists(os.path.join(p, "bin", "javac.exe")):
                    return p
    die("找不到 JDK，请设置 JAVA_HOME")


def find_sdk():
    if os.environ.get("ANDROID_SDK") and os.path.isdir(os.environ["ANDROID_SDK"]):
        return os.environ["ANDROID_SDK"]
    for cand in (os.path.join(TOOLCHAIN, "android-sdk"),
                 os.environ.get("ANDROID_HOME", ""),
                 os.environ.get("ANDROID_SDK_ROOT", ""),
                 os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk")):
        if cand and os.path.isdir(os.path.join(cand, "platforms")):
            return cand
    die("找不到 Android SDK，请设置 ANDROID_SDK")


def pick_build_tools(sdk):
    if os.environ.get("BUILD_TOOLS"):
        return os.path.join(sdk, "build-tools", os.environ["BUILD_TOOLS"])
    base = os.path.join(sdk, "build-tools")
    if not os.path.isdir(base):
        die("SDK 里没有 build-tools，请先安装 build-tools;34.0.0")
    versions = [d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))]

    def key(v):
        return [int(x) for x in re.findall(r"\d+", v)] or [0]

    return os.path.join(base, sorted(versions, key=key)[-1])


def run(cmd, env, cwd=ROOT, quiet=False):
    if not quiet:
        log("$ " + " ".join(os.path.basename(c) if i == 0 else c for i, c in enumerate(cmd)))
    proc = subprocess.run(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True, errors="replace")
    if proc.returncode != 0:
        print(proc.stdout)
        die("命令返回 %d" % proc.returncode)
    if proc.stdout.strip() and not quiet:
        for line in proc.stdout.strip().splitlines():
            print("      " + line)
    return proc.stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=os.path.join(ROOT, "dist"))
    ap.add_argument("--keep-work", action="store_true", help="保留中间产物以便排查")
    args = ap.parse_args()

    jdk = find_jdk()
    sdk = find_sdk()
    bt = pick_build_tools(sdk)
    android_jar = os.path.join(sdk, "platforms", "android-" + COMPILE_SDK, "android.jar")
    if not os.path.exists(android_jar):
        die("缺少 android.jar：" + android_jar)

    env = dict(os.environ)
    env["JAVA_HOME"] = jdk
    env["PATH"] = os.path.join(jdk, "bin") + os.pathsep + env.get("PATH", "")

    def tool(name):
        exe = os.path.join(bt, name + ".exe")
        bat = os.path.join(bt, name + ".bat")
        if os.path.exists(exe):
            return exe
        if os.path.exists(bat):
            return bat
        die("build-tools 里找不到 " + name)

    aapt2, d8, zipalign, apksigner = tool("aapt2"), tool("d8"), tool("zipalign"), tool("apksigner")
    javac = os.path.join(jdk, "bin", "javac.exe")
    keytool = os.path.join(jdk, "bin", "keytool.exe")

    log("JDK        : " + jdk)
    log("SDK        : " + sdk)
    log("build-tools: " + os.path.basename(bt))

    work = os.path.join(ROOT, "build", "manual")
    if os.path.isdir(work):
        shutil.rmtree(work)
    os.makedirs(work)
    gen = os.path.join(work, "gen")
    classes = os.path.join(work, "classes")
    dex = os.path.join(work, "dex")
    for d in (gen, classes, dex):
        os.makedirs(d)

    res_dir = os.path.join(ROOT, "app", "src", "main", "res")
    assets_dir = os.path.join(ROOT, "app", "src", "main", "assets")
    manifest = os.path.join(ROOT, "app", "src", "main", "AndroidManifest.xml")

    # AGP 8 要求 manifest 里不能写 package（由 namespace 注入），而 aapt2 直接编译时必须要它，
    # 所以这里生成一份临时副本补上 package 属性。
    with open(manifest, "r", encoding="utf-8") as f:
        manifest_xml = f.read()
    if "package=" not in manifest_xml.split(">", 2)[1]:
        manifest_xml = manifest_xml.replace(
            '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
            '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    package="%s">' % PACKAGE,
            1)
    manifest = os.path.join(work, "AndroidManifest.xml")
    with open(manifest, "w", encoding="utf-8") as f:
        f.write(manifest_xml)

    # 1) 编译资源
    res_zip = os.path.join(work, "res.zip")
    run([aapt2, "compile", "--dir", res_dir, "-o", res_zip], env)

    # 2) 链接资源 + 打包 assets，生成 R.java
    unsigned = os.path.join(work, "unsigned.apk")
    run([aapt2, "link",
         "-o", unsigned,
         "-I", android_jar,
         "--manifest", manifest,
         "-R", res_zip,
         "-A", assets_dir,
         "--java", gen,
         "--min-sdk-version", MIN_SDK,
         "--target-sdk-version", TARGET_SDK,
         "--version-code", VERSION_CODE,
         "--version-name", VERSION_NAME,
         "--auto-add-overlay"], env)

    # 3) 编译 Java
    sources = []
    for base, _dirs, files in os.walk(os.path.join(ROOT, "app", "src", "main", "java")):
        sources += [os.path.join(base, f) for f in files if f.endswith(".java")]
    r_java = None
    for base, _dirs, files in os.walk(gen):
        for f in files:
            if f == "R.java":
                r_java = os.path.join(base, f)
    if not r_java:
        die("aapt2 没有生成 R.java")
    run([javac, "-source", "8", "-target", "8", "-nowarn", "-Xlint:-options",
         "-encoding", "UTF-8", "-classpath", android_jar, "-d", classes, r_java] + sources, env)

    # 4) 转成 dex
    class_files = []
    for base, _dirs, files in os.walk(classes):
        class_files += [os.path.join(base, f) for f in files if f.endswith(".class")]
    if not class_files:
        die("没有编译出 class 文件")
    run([d8, "--release", "--min-api", MIN_SDK, "--lib", android_jar,
         "--output", dex] + class_files, env)

    # 5) 把 classes.dex 合进 APK
    merged = os.path.join(work, "merged.apk")
    with zipfile.ZipFile(unsigned, "r") as zin, zipfile.ZipFile(merged, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zout:
        for item in zin.infolist():
            zout.writestr(item, zin.read(item.filename))
        for f in sorted(os.listdir(dex)):
            if f.endswith(".dex"):
                zout.write(os.path.join(dex, f), f)

    # 6) 4 字节对齐（必须在签名之前）
    aligned = os.path.join(work, "aligned.apk")
    run([zipalign, "-p", "-f", "4", merged, aligned], env, quiet=True)
    log("zipalign  完成")

    # 7) 签名（没有 keystore 就用 keytool 生成一个 debug 用的）
    keystore = os.path.join(TOOLCHAIN, "debug.keystore")
    if not os.path.exists(keystore):
        os.makedirs(TOOLCHAIN, exist_ok=True)
        run([keytool, "-genkeypair", "-keystore", keystore,
             "-storepass", "android", "-keypass", "android",
             "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048",
             "-validity", "10000",
             "-dname", "CN=Android Debug,O=Android,C=US"], env, quiet=True)
        log("已生成调试签名 " + os.path.relpath(keystore, ROOT))

    os.makedirs(args.out_dir, exist_ok=True)
    final = os.path.join(args.out_dir, "ChordHelper-%s.apk" % VERSION_NAME)
    run([apksigner, "sign", "--ks", keystore,
         "--ks-pass", "pass:android", "--key-pass", "pass:android",
         "--ks-key-alias", "androiddebugkey", "--v1-signing-enabled", "true",
         "--v2-signing-enabled", "true", "--v3-signing-enabled", "true",
         "--v4-signing-enabled", "false",     # 不需要增量安装用的 .idsig 附带文件
         "--out", final, aligned], env, quiet=True)
    log("签名完成 -> " + os.path.relpath(final, ROOT))

    out = run([apksigner, "verify", "--print-certs", final], env, quiet=True)
    for line in out.splitlines():
        if "Verified using" in line or "Signer #1 certificate DN" in line:
            log(line.strip())
    badging = run([aapt2, "dump", "badging", final], env, quiet=True)
    for line in badging.splitlines():
        if line.startswith(("package:", "application-label", "sdkVersion", "targetSdkVersion",
                            "launchable-activity", "uses-permission")):
            log(line.strip())

    log("APK 大小 %.2f MB" % (os.path.getsize(final) / 1048576.0))
    if not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    log("完成")


if __name__ == "__main__":
    main()
