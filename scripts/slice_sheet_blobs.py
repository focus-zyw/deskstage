# -*- coding: utf-8 -*-
"""表情表切图:固定网格粗切 + 格内主色块提取。

长发会跨越格子边界(上一行角色的头发垂进下一行),固定网格切出来会带上
邻居的发丝。处理:粗切后对格内做连通域标记,只保留与主体相连的最大色块
(邻居垂落的发丝是独立色块,直接丢弃),再按邻近原则吸收自己的表情特效。
"""

import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TEMP = os.path.join(HERE, "..", "temp")
OUT = os.path.join(HERE, "..", "public", "sprites")
CANVAS_W = 440
CANVAS_H = 640
TARGET_H = 615
STAND_CELL = 512
JUMP_GAP = 46
DS = 2  # 连通域分析的下采样倍数

SHEETS = {
    "girl-sheet1.png": ("a", ["idle", "talk", "happy", "laugh", "angry", "sad"]),
    "girl-sheet2.png": ("a", ["surprise", "shy", "sleepy", "wave", "thinking", "jump"]),
    "boy-sheet2.png": ("b", ["surprise", "shy", "sleepy", "wave", "thinking", "jump"]),
}


def label(mask, w, h):
    labels = bytearray(w * h)
    out = []
    stack = []
    for start in range(w * h):
        if mask[start] and not labels[start]:
            labels[start] = 1
            stack.append(start)
            minx = maxx = start % w
            miny = maxy = start // w
            area = 0
            while stack:
                px = stack.pop()
                area += 1
                x, y = px % w, px // w
                minx = min(minx, x); maxx = max(maxx, x)
                miny = min(miny, y); maxy = max(maxy, y)
                for ny in (y - 1, y, y + 1):
                    for nx in (x - 1, x, x + 1):
                        if 0 <= nx < w and 0 <= ny < h:
                            n = ny * w + nx
                            if mask[n] and not labels[n]:
                                labels[n] = 1
                                stack.append(n)
            out.append({"area": area, "bbox": (minx, miny, maxx + 1, maxy + 1)})
    return out


def extract_cell(cell):
    """返回格内主体 bbox(全尺寸坐标):格内连通域取最大,邻近小色块(特效)吸收。"""
    sw, sh = cell.size[0] // DS, cell.size[1] // DS
    small = cell.resize((sw, sh), Image.BILINEAR)
    alpha = small.getchannel("A").point(lambda v: 255 if v > 4 else 0)
    comps = [c for c in label(alpha.tobytes(), sw, sh) if c["area"] >= 16]
    if not comps:
        return None
    comps.sort(key=lambda c: -c["area"])
    body = list(comps[0]["bbox"])
    rest = comps[1:]
    # 方向性吸收(防邻居入侵):凡接触格子顶/左/右边缘的色块都是邻格入侵,绝不吸收。
    # 吸收两类:①特效——中心落在主体邻域,且不触顶/左/右边;②断开的下半身——
    # x 范围与主体重叠、且紧贴主体底边之下(揉眼等姿势的头身断开)。
    edge_t, edge_s = 1, 2  # 下采样坐标的边缘判定(全尺寸 2px/4px)
    g = 2
    for _ in range(3):
        changed = False
        for c in rest[:]:
            cx0, cy0, cx1, cy1 = c["bbox"]
            touches_edge = cy0 <= edge_t or cx0 <= edge_s or cx1 >= sw - edge_s
            cx, cy = (cx0 + cx1) / 2, (cy0 + cy1) / 2
            near = (body[0] - g <= cx <= body[2] + g and body[1] - g <= cy <= body[3] + g)
            below = (cx0 < body[2] + g and cx1 > body[0] - g and body[1] - 2 <= cy0 <= body[3] + 12)
            if not touches_edge and (near or below):
                body = [min(body[0], cx0), min(body[1], cy0), max(body[2], cx1), max(body[3], cy1)]
                rest.remove(c)
                changed = True
        if not changed:
            break
    return (body[0] * DS, body[1] * DS, body[2] * DS, body[3] * DS)


def process(sheet_file, ch, acts):
    sheet = Image.open(os.path.join(TEMP, sheet_file)).convert("RGBA")
    w, h = sheet.size
    for idx, act in enumerate(acts):
        row, col = divmod(idx, 2)
        cell = sheet.crop((col * w // 2, row * h // 3, (col + 1) * w // 2, (row + 1) * h // 3))
        bbox = extract_cell(cell)
        if bbox is None:
            print(f"  {act}: 空格,跳过")
            continue
        crop = cell.crop(bbox)
        scale = TARGET_H / STAND_CELL
        nw, nh = round(crop.width * scale), round(crop.height * scale)
        crop = crop.resize((nw, nh), Image.LANCZOS)
        cw = max(CANVAS_W, nw + 16)
        canvas = Image.new("RGBA", (cw, CANVAS_H), (0, 0, 0, 0))
        bottom = CANVAS_H - JUMP_GAP if act == "jump" else CANVAS_H
        canvas.paste(crop, ((cw - nw) // 2, bottom - nh), crop)
        canvas.save(os.path.join(OUT, ch, f"{act}.png"))
        print(f"  {act:9s} {nw}x{nh}")


def main():
    for f, (ch, acts) in SHEETS.items():
        p = os.path.join(TEMP, f)
        if not os.path.exists(p):
            print(f"缺少 {f},跳过")
            continue
        print(f"[{f}]")
        process(f, ch, acts)


if __name__ == "__main__":
    main()
