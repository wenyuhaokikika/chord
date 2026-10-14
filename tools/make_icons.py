#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 Android 旧版本（API 21..25）需要的 PNG 启动图标。

Android 26+ 用 res/mipmap-anydpi-v26 里的自适应图标（矢量），
这里用纯 Python（zlib + struct，不依赖 Pillow）栅格化同样的“迷你和弦图”，
输出到 res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher[_round].png。

用法： python tools/make_icons.py
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "app", "src", "main", "res")

# 调到与 res/values/colors.xml 一致
BG_TOP = (29, 34, 45)        # #1D222D
BG_BOTTOM = (16, 19, 26)     # #10131A
GRID = (139, 147, 167)       # #8B93A7
NUT = (231, 234, 240)        # #E7EAF0
DOT = (255, 180, 84)         # #FFB454

# 和弦图在图标中的相对位置（与矢量图标保持同一比例）
BOX_L, BOX_R = 38 / 108.0, 70 / 108.0
BOX_T, BOX_B = 42 / 108.0, 78 / 108.0
STRINGS = [38, 48.7, 59.3, 70]
FRETS = [42, 51, 60, 69, 78]
DOTS = [(48.7, 46.5), (38, 55.5), (70, 64.5)]
DOT_R = 4.6 / 108.0
LINE_W = 1.8 / 108.0


def lerp(a, b, t):
    return a + (b - a) * t


def write_png(path, size, pixels):
    """pixels: 每行一个 bytes（RGBA），写出 32 位 PNG"""
    raw = b"".join(b"\x00" + row for row in pixels)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    # 位深 8，颜色类型 6（RGBA）
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def blend(base, color, cov):
    """按覆盖率把 color 混到 base（RGB 元组）上"""
    if cov <= 0:
        return base
    if cov > 1:
        cov = 1.0
    return tuple(int(round(lerp(base[i], color[i], cov))) for i in range(3))


def render(size, round_icon):
    """逐像素绘制，返回 RGBA 行"""
    cx = cy = size / 2.0
    radius = size / 2.0
    box_l, box_r = BOX_L * size, BOX_R * size
    box_t, box_b = BOX_T * size, BOX_B * size
    line_w = max(1.0, LINE_W * size)
    dot_r = DOT_R * size

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            alpha = 255

            if round_icon:
                dx, dy = px - cx, py - cy
                dist = (dx * dx + dy * dy) ** 0.5
                if dist > radius:
                    alpha = 0
                elif dist > radius - 1:
                    alpha = int(255 * (radius - dist))

            # 背景：竖直渐变
            t = y / float(size - 1)
            r = int(lerp(BG_TOP[0], BG_BOTTOM[0], t))
            g = int(lerp(BG_TOP[1], BG_BOTTOM[1], t))
            b = int(lerp(BG_TOP[2], BG_BOTTOM[2], t))
            color = (r, g, b)

            # 品丝 / 琴枕（横线，第一根是琴枕，更粗更亮）
            for i, fr in enumerate(FRETS):
                fy = fr / 108.0 * size
                w = (4.0 if i == 0 else 1.8) / 108.0 * size
                if abs(py - fy) <= max(0.5, w / 2.0) and (box_l - 3) <= px <= (box_r + 3):
                    color = NUT if i == 0 else GRID
            # 弦（竖线）
            for sx in STRINGS:
                fx = sx / 108.0 * size
                if abs(px - fx) <= max(0.5, line_w / 2.0) and box_t <= py <= box_b:
                    color = GRID
            # 按弦点（带一点抗锯齿）
            for (dx0, dy0) in DOTS:
                fx = dx0 / 108.0 * size
                fy = dy0 / 108.0 * size
                d = ((px - fx) ** 2 + (py - fy) ** 2) ** 0.5
                color = blend(color, DOT, dot_r - d + 0.5)

            row += bytes((color[0], color[1], color[2], alpha))
        rows.append(bytes(row))
    return rows


DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def main():
    for name, size in DENSITIES.items():
        d = os.path.join(RES, "mipmap-" + name)
        os.makedirs(d, exist_ok=True)
        for round_icon, fname in ((False, "ic_launcher.png"), (True, "ic_launcher_round.png")):
            path = os.path.join(d, fname)
            write_png(path, size, render(size, round_icon))
            print("written", os.path.relpath(path, RES), size, "px")


if __name__ == "__main__":
    main()
