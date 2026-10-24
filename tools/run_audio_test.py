#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
音频功能的端到端测试跑法（调音 / 鼓机共用一套）。

为什么单独一个脚本：调音依赖实时音频，而无头浏览器的 --virtual-time-budget
会把时钟快进、音频却按真实时间产生样本，两者冲突（结果就是永远等不到读数）。
所以这里让浏览器按真实时间跑，测试页用 sendBeacon 把结果回传给本地 HTTP 服务。

    python tools/run_audio_test.py                      # 调音：注入已知频率的振荡器
    python tools/run_audio_test.py --mic                # 调音：真实 getUserMedia + 假麦克风 WAV
    python tools/run_audio_test.py --page drums         # 鼓机：离线渲染一段音频检查敲击时刻

依赖：Chrome/Edge；--mic 模式需要 tools/test-tone.wav（先用 make 生成，仓库里已带）。
"""
import argparse
import glob
import http.server
import os
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8765
RESULT = {}

BROWSER_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
]


def find_browser():
    for p in BROWSER_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        RESULT["body"] = body
        RESULT["done"] = True
        if self.path.startswith("/result"):
            self.send_response(204)
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mic", action="store_true", help="用假麦克风 + WAV 走真实 getUserMedia 路径（调音）")
    ap.add_argument("--page", default="tuner", choices=["tuner", "drums"], help="测哪个模块")
    ap.add_argument("--timeout", type=int, default=90, help="等待结果的秒数")
    ap.add_argument("--keep", action="store_true", help="保留浏览器进程（调试用）")
    args = ap.parse_args()

    browser = find_browser()
    if not browser:
        print("[错误] 找不到 Chrome / Edge")
        return 1

    global PORT
    for p in range(PORT, PORT + 20):
        try:
            probe = socket.socket()
            probe.bind(("127.0.0.1", p))
            probe.close()
            PORT = p
            break
        except OSError:
            continue

    server = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()

    tmp = tempfile.mkdtemp(prefix="tunertest-")
    page_file = "tunertest.html" if args.page == "tuner" else "drumtest.html"
    url = ("file:///" + os.path.join(ROOT, "tools", page_file).replace("\\", "/")
           + "?port=%d" % PORT + ("&mic=1" if args.mic else ""))
    cmd = [browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
           "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required",
           "--user-data-dir=" + tmp, "--window-size=420,900", url]
    if args.mic:
        wav = os.path.join(ROOT, "tools", "test-tone.wav")
        if not os.path.exists(wav):
            print("[错误] 缺少 %s（--mic 模式需要它作为假麦克风输入）" % wav)
            return 1
        cmd += ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                "--use-file-for-fake-audio-capture=" + wav.replace("\\", "/")]

    mode = ("调音 · 真实 getUserMedia + 假麦克风(WAV)" if args.mic else
            ("调音 · 注入振荡器" if args.page == "tuner" else "鼓机 · 离线渲染"))
    print("[audio] 浏览器: %s" % browser)
    print("[audio] 模式  : %s" % mode)
    print("[audio] 端口  : %d（测试页用 sendBeacon 回传结果）" % PORT)
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    t0 = time.time()
    last_progress = None
    while time.time() - t0 < args.timeout:
        body = RESULT.get("body")
        if body and ("TUNER_TESTS_" in body or "DRUM_TESTS_" in body):      # 进度回报里没有这个标记
            break
        if body and body != last_progress:
            last_progress = body
            first = body.split("\n")[0]
            print("[audio] 进度: %s" % first)
        time.sleep(0.5)

    if not args.keep:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    server.shutdown()

    body = RESULT.get("body")
    if not body or ("TUNER_TESTS_" not in body and "DRUM_TESTS_" not in body):
        print("[audio] 超时（%ds）没有收到最终结果。最后进度：%s" %
              (args.timeout, (body or "").split("\n")[0]))
        return 1

    for line in body.split("\n"):
        print("  " + line)
    okpass = ("TUNER_TESTS_PASSED" in body) or ("DRUM_TESTS_PASSED" in body)
    print("[audio] %s" % ("通过" if okpass else "失败"))
    return 0 if okpass else 1


if __name__ == "__main__":
    sys.exit(main())
