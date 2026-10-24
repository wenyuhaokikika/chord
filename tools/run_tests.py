#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
项目自检总入口 —— Windows 上一条命令跑完全部检查。

  1. 引擎自检（tools/selftest.html）：乐理、指法合法性、指板坐标、性能
  2. 即兴自检（tools/improvtest.html）：mock 四 agent、Bias、配和弦、六线谱、双库、离线音频
  3. 界面自检（tools/uitest.html）：模拟点击 + 布局体检，默认跑 3 种手机视口 + 1 种桌面视口
  4. APK 校验（dist/*.apk）：包名/权限/签名/图标/网页资源逐字节一致性

用法：
    python tools/run_tests.py                 # 全部
    python tools/run_tests.py --engine        # 只跑引擎自检
    python tools/run_tests.py --ui            # 只跑界面自检
    python tools/run_tests.py --apk           # 只校验 APK
    python tools/run_tests.py --keep-open     # 顺便用可见窗口打开界面，自己点着看

退出码：全部通过为 0，有失败为 1（可直接用在 CI 里）。
"""
import argparse
import glob
import hashlib
import html
import os
import re
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "app", "src", "main", "assets", "www", "index.html")

BROWSER_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

UI_VIEWPORTS = ["390x844", "360x640", "320x568", "1280x900"]

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
DIM = "\033[2m"
RESET = "\033[0m"
if os.name == "nt" and not os.environ.get("WT_SESSION"):
    # 老式 cmd 不一定支持颜色，简单关掉
    GREEN = RED = YELLOW = DIM = RESET = ""


def find_browser():
    for path in BROWSER_CANDIDATES:
        if os.path.exists(path):
            return path
    for name in ("chrome.exe", "msedge.exe", "chrome", "chromium", "msedge"):
        found = glob.glob(os.path.join(os.environ.get("PROGRAMFILES", "/nonexistent"), "**", name), recursive=False)
        if found:
            return found[0]
    return None


def run_headless(browser, page, query="", timeout=180):
    """用无头浏览器加载页面，取回 <pre id="out"> 里的测试结论"""
    tmp = tempfile.mkdtemp(prefix="chordtest-")
    url = "file:///" + os.path.abspath(page).replace("\\", "/") + query
    cmd = [browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
           "--allow-file-access-from-files", "--user-data-dir=" + tmp,
           "--virtual-time-budget=40000", "--dump-dom", url]
    try:
        out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             timeout=timeout, text=True, encoding="utf-8",
                             errors="replace").stdout
    except subprocess.TimeoutExpired:
        return None, "超时（%ds）" % timeout
    finally:
        for base, dirs, files in os.walk(tmp, topdown=False):
            for f in files:
                try:
                    os.remove(os.path.join(base, f))
                except OSError:
                    pass
            for d in dirs:
                try:
                    os.rmdir(os.path.join(base, d))
                except OSError:
                    pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass

    m = re.search(r'<pre id="out">(.*?)</pre>', out, re.S)
    if not m:
        return None, "页面没有输出结论（JS 可能报错了）"
    return html.unescape(m.group(1)), None


def summarize(text):
    lines = text.split("\n")
    total = len([l for l in lines if l.startswith(("PASS", "FAIL"))])
    fails = [l for l in lines if l.startswith("FAIL")]
    passed = ("PASSED" in text) or ("ALL_TESTS" in text and not fails)
    notes = [l.strip() for l in lines if l.startswith("      ") and l.strip()]
    return total, fails, passed, notes


def run_engine(browser, verbose):
    print("【1/3】引擎自检  tools/selftest.html")
    text, err = run_headless(browser, os.path.join(ROOT, "tools", "selftest.html"))
    if err:
        print("  %s✗ %s%s" % (RED, err, RESET))
        return False
    total, fails, passed, notes = summarize(text)
    print("  %s%d 条断言，%s%s" % (GREEN if passed else RED, total,
                                   "全部通过" if passed else "%d 条失败" % len(fails), RESET))
    for n in notes:
        if any(k in n for k in ("耗时", "找到", "ms")):
            print("  %s%s%s" % (DIM, n, RESET))
    for f in fails:
        print("  %s%s%s" % (RED, f, RESET))
    return passed


def run_improv(browser, verbose):
    print("【即兴自检】tools/improvtest.html（mock 模型流水线 + 本地作曲 + 离线音频）")
    text, err = run_headless(browser, os.path.join(ROOT, "tools", "improvtest.html"))
    if err:
        print("  %s✗ %s%s" % (RED, err, RESET))
        return False
    total, fails, passed, notes = summarize(text)
    print("  %s%d 条断言，%s%s" % (GREEN if passed else RED, total,
                                   "全部通过" if passed else "%d 条失败" % len(fails), RESET))
    if verbose:
        for n in notes:
            print("  %s%s%s" % (DIM, n, RESET))
    for f in fails:
        print("  %s%s%s" % (RED, f, RESET))
    return passed


def run_ui(browser, viewports, verbose):
    print("【2/3】界面自检  tools/uitest.html（模拟点击 + 布局体检）")
    allpass = True
    for vp in viewports:
        w, h = vp.split("x")
        text, err = run_headless(browser, os.path.join(ROOT, "tools", "uitest.html"),
                                 "?w=%s&h=%s" % (w, h))
        if err:
            print("  %s%s  ✗ %s%s" % (RED, vp, err, RESET))
            allpass = False
            continue
        total, fails, passed, notes = summarize(text)
        print("  %s%-9s %d 条断言  %s%s" % (GREEN if passed else RED, vp, total,
                                            "全部通过" if passed else "%d 条失败" % len(fails), RESET))
        for f in fails:
            print("    %s%s%s" % (RED, f, RESET))
        if verbose:
            for n in notes:
                print("    %s%s%s" % (DIM, n, RESET))
        allpass = allpass and passed
    return allpass


def find_java_home():
    """apksigner 是 .bat/.sh，需要一个能用的 java"""
    if os.environ.get("JAVA_HOME") and os.path.exists(
            os.path.join(os.environ["JAVA_HOME"], "bin", "java.exe")):
        return os.environ["JAVA_HOME"]
    cand = os.path.join(ROOT, ".toolchain", "jdk", "jdk-17")
    if os.path.exists(os.path.join(cand, "bin", "java.exe")):
        return cand
    for base in (r"C:\Program Files\Java", r"C:\Program Files\Eclipse Adoptium",
                 r"C:\Program Files\Microsoft", r"C:\Program Files\Android\Android Studio\jbr"):
        if os.path.isdir(base):
            if os.path.exists(os.path.join(base, "bin", "java.exe")):
                return base
            for name in sorted(os.listdir(base), reverse=True):
                p = os.path.join(base, name)
                if os.path.exists(os.path.join(p, "bin", "java.exe")):
                    return p
    return None


def find_tool(name):
    """在本地 .toolchain 的 SDK 里找 aapt2 / apksigner"""
    pattern = os.path.join(ROOT, ".toolchain", "android-sdk", "build-tools", "*", name)
    hits = sorted(glob.glob(pattern))
    if hits:
        return hits[-1]
    for base in (os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"),
                 os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk")):
        if base:
            hits = sorted(glob.glob(os.path.join(base, "build-tools", "*", name)))
            if hits:
                return hits[-1]
    return None


def apk_env():
    env = dict(os.environ)
    java_home = find_java_home()
    if java_home:
        env["JAVA_HOME"] = java_home
        env["PATH"] = os.path.join(java_home, "bin") + os.pathsep + env.get("PATH", "")
    return env


def run_tool(cmd):
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, errors="replace", env=apk_env())


def run_audio_page(verbose, page, title, module_dir):
    """跑调音 / 鼓机的音频端到端测试（run_audio_test.py 起本地服务回传结果）"""
    print(title)
    script = os.path.join(ROOT, "tools", "run_audio_test.py")
    args = [sys.executable, script, "--timeout", "120"]
    if page != "tuner":
        args += ["--page", page]
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, errors="replace")
    out = proc.stdout or ""
    if verbose:
        for line in out.splitlines():
            print("  " + line)
    fails = [l.strip() for l in out.splitlines() if l.strip().startswith("FAIL")]
    passes = len([l for l in out.splitlines() if l.strip().startswith("PASS")])
    okpass = "TESTS_PASSED" in out
    print("  %s%d 条断言，%s%s" % (GREEN if okpass else RED, passes,
                                    "全部通过" if okpass else "%d 条失败" % len(fails), RESET))
    for f in fails:
        print("  %s%s%s" % (RED, f, RESET))
    return okpass


def run_apk(verbose):
    print("【3/3】APK 校验  dist/*.apk")
    apks = sorted(glob.glob(os.path.join(ROOT, "dist", "*.apk")))
    if not apks:
        print("  %s✗ dist/ 下没有 APK，先跑 python tools/build_apk.py%s" % (RED, RESET))
        return False
    apk = apks[-1]
    print("  %s%s (%.1f KB)%s" % (DIM, os.path.basename(apk),
                                  os.path.getsize(apk) / 1024.0, RESET))
    ok = True

    # 3.1 包信息 / 权限
    aapt2 = find_tool("aapt2.exe") or find_tool("aapt2")
    if aapt2:
        badging = run_tool([aapt2, "dump", "badging", apk]).stdout
        for key in ("package:", "sdkVersion", "targetSdkVersion", "application-label", "launchable-activity"):
            for line in badging.split("\n"):
                if line.startswith(key):
                    print("  %s" % line.strip())
        perms = [l.strip() for l in badging.split("\n") if l.startswith("uses-permission")]
        # 合法权限：录音（调音）+ 网络（只有即兴调用用户自己配置的模型 API 时才用）
        allowed = ("RECORD_AUDIO", "INTERNET")
        unexpected = [p for p in perms
                      if not any(("android.permission." + a) in p for a in allowed)]
        if perms:
            names = "、".join(p.split("'")[1] for p in perms if "'" in p)
            print("  %s权限声明 %d 条：%s%s" % (GREEN if not unexpected else RED, len(perms), names, RESET))
        else:
            print("  %s· 权限声明 0 条%s" % (YELLOW, RESET))
        if unexpected:
            print("  %s✗ 出现了预期外的权限：%s%s" % (RED, unexpected, RESET))
            ok = False
    else:
        print("  %s· 没找到 aapt2，跳过包信息检查（可设 ANDROID_HOME）%s" % (YELLOW, RESET))

    # 3.2 签名
    apksigner = find_tool("apksigner.bat") or find_tool("apksigner")
    if apksigner:
        proc = run_tool([apksigner, "verify", "--print-certs", apk])
        if proc.returncode == 0:
            for line in proc.stdout.split("\n"):
                if "Verified using" in line or "certificate DN" in line:
                    print("  %s%s%s" % (GREEN, line.strip(), RESET))
        else:
            print("  %s✗ 签名校验失败：%s%s" % (RED, proc.stdout.strip()[:200], RESET))
            ok = False
    else:
        print("  %s· 没找到 apksigner，跳过签名校验%s" % (YELLOW, RESET))

    # 3.3 网页资源是否与源码一致（最容易出的问题：改完忘了重新打包）
    src = os.path.join(ROOT, "app", "src", "main", "assets")
    z = zipfile.ZipFile(apk)
    names = set(z.namelist())
    bad, count = [], 0
    for base, _dirs, files in os.walk(src):
        for f in files:
            full = os.path.join(base, f).replace(os.sep, "/")
            rel = full[len(os.path.join(ROOT, "app", "src", "main").replace(os.sep, "/")) + 1:]
            count += 1
            if rel not in names:
                bad.append("APK 里缺少 " + rel)
            elif hashlib.md5(open(full, "rb").read()).hexdigest() != hashlib.md5(z.read(rel)).hexdigest():
                bad.append("内容不一致 " + rel)
    if bad:
        print("  %s✗ 界面资源与源码不一致（改完界面要重新打包）%s" % (RED, RESET))
        for b in bad:
            print("    %s%s%s" % (RED, b, RESET))
        ok = False
    else:
        print("  %s✓ %d 个网页资源与源码逐字节一致%s" % (GREEN, count, RESET))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", action="store_true", help="只跑引擎自检")
    ap.add_argument("--ui", action="store_true", help="只跑界面自检")
    ap.add_argument("--improv", action="store_true", help="只跑即兴自检（mock 模型 + 离线音频）")
    ap.add_argument("--apk", action="store_true", help="只校验 APK")
    ap.add_argument("--audio", action="store_true", help="只跑音频端到端（调音 + 鼓机，稍慢）")
    ap.add_argument("--verbose", "-v", action="store_true", help="打印更多信息")
    ap.add_argument("--keep-open", action="store_true", help="跑完用可见窗口打开界面，方便手动点")
    args = ap.parse_args()

    only = args.engine or args.ui or args.improv or args.apk or args.audio
    do_engine = args.engine or not only
    do_ui = args.ui or not only
    do_improv = args.improv or not only
    do_apk = args.apk or not only
    do_audio = args.audio or not only

    browser = find_browser()
    if (do_engine or do_ui or do_improv) and not browser:
        print("%s找不到 Chrome 或 Edge，无法跑网页自检。%s" % (RED, RESET))
        print("也可以直接双击打开这些文件看结果：tools/selftest.html、tools/improvtest.html、tools/uitest.html")
        if not do_apk and not do_audio:
            return 1
    else:
        print("%s浏览器: %s%s\n" % (DIM, browser, RESET))

    results = []
    if do_engine:
        results.append(("引擎自检", run_engine(browser, args.verbose)))
        print()
    if do_improv:
        results.append(("即兴自检", run_improv(browser, args.verbose)))
        print()
    if do_ui:
        results.append(("界面自检", run_ui(browser, UI_VIEWPORTS, args.verbose)))
        print()
    if do_apk:
        results.append(("APK 校验", run_apk(args.verbose)))
        print()
    if do_audio:
        results.append(("调音端到端", run_audio_page(args.verbose, "tuner",
            "【调音端到端】tunertest.html（注入已知频率振荡器，跑完整条音频链路）", "tuner")))
        print()
        results.append(("鼓机端到端", run_audio_page(args.verbose, "drums",
            "【鼓机端到端】drumtest.html（离线渲染音频，核对每一下敲击时刻）", "drums")))
        print()

    print("=" * 52)
    allok = True
    for name, ok in results:
        print("  %-10s %s%s%s" % (name, GREEN if ok else RED, "通过" if ok else "失败", RESET))
        allok = allok and ok
    print("=" * 52)

    if args.keep_open and browser:
        print("\n打开界面供手动测试：%s" % PAGE)
        subprocess.Popen([browser, "file:///" + os.path.abspath(PAGE).replace("\\", "/")])
    return 0 if allok else 1


if __name__ == "__main__":
    sys.exit(main())
