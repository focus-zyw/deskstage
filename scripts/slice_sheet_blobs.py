# -*- coding: utf-8 -*-
"""表情表切图:固定网格粗切 + 格内最大色块提取 + 邻近特效吸收。

长发会跨越格子边界,固定网格切出来会带上邻居的发丝;连通域取最大色块
即可只保留主体,再按"中心落在主体邻域"吸收自己的表情特效。
个别构图特殊的格子(如 sleepy 揉眼,头手与身体断开)用 MANUAL_BBOX 手工指定。
"""

import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TEMP = os.path.join(HERE, "..", "temp")
OUT = os.path.join(HERE, "..", "public", "sprites")
CANVAS_W = 440
CANVAS_H = 640
TARGET_H = 615
STAND_CELL = 512
JUMP_GAP = 46
DS = 2

SHEETS = {
    "girl-sheet1.png": ("a", ["idle", "talk", "happy", "laugh", "angry", "sad"]),
    "girl-sheet2.png": ("a", ["surprise", "shy", "sleepy", "wave", "thinking", "jump"]),
    "boy-sheet2.png": ("b", ["surprise", "shy", "sleepy", "wave", "thinking", "jump"]),
}

# 人工标注的每格 bbox(全尺寸坐标):布局特殊的表(如 girl-sheet2 的 3×2)必须手工标
MANUAL_SHEET_BBOX = {
    "girl-sheet1.png": [
        (120, 10, 450, 512),    # idle
        (570, 15, 960, 512),    # talk(含对话气泡)
        (105, 520, 445, 1015),  # happy(含星星)
        (550, 500, 940, 1024),  # laugh(含感叹号)
        (140, 1025, 435, 1536), # angry(含怒筋)
        (595, 1030, 885, 1536), # sad(含汗珠)
    ],
    "girl-sheet2.png": [    # 3 列 × 2 行布局
        (20, 10, 340, 760),     # surprise(含惊叹号)
        (385, 8, 665, 762),     # shy
        (695, 12, 1015, 762),   # sleepy(含 Zzz)
        (20, 780, 340, 1536),   # wave(含闪光)
        (437, 785, 670, 1536),  # thinking(含灯泡问号)
        (675, 770, 1015, 1495), # jump(腾空,脚底不含画布底)
    ],
}

# 手工 bbox 覆盖(cell 内全尺寸坐标):(sheet 文件, 表情) -> (x0, y0, x1, y1)
MANUAL_BBOX = {
    ("girl-sheet2.png", "sleepy"): (14, 0, 400, 512),  # 揉眼姿势头手与身体断开,自动提取只得半身
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
    sw, sh = cell.size[0] // DS, cell.size[1] // DS
    small = cell.resize((sw, sh), Image.BILINEAR)
    alpha = small.getchannel("A").point(lambda v: 255 if v > 4 else 0)
    comps = [c for c in label(alpha.tobytes(), sw, sh) if c["area"] >= 16]
    if not comps:
        return None
    comps.sort(key=lambda c: -c["area"])
    body = list(comps[0]["bbox"])
    for c in comps[1:]:
        cx0, cy0, cx1, cy1 = c["bbox"]
        cx, cy = (cx0 + cx1) / 2, (cy0 + cy1) / 2
        if body[0] - 3 <= cx <= body[2] + 3 and body[1] - 3 <= cy <= body[3] + 3:
            body = [min(body[0], cx0), min(body[1], cy0), max(body[2], cx1), max(body[3], cy1)]
    return (body[0] * DS, body[1] * DS, body[2] * DS, body[3] * DS)


def process(sheet_file, ch, acts):
    sheet = Image.open(os.path.join(TEMP, sheet_file)).convert("RGBA")
    w, h = sheet.size
    manual = MANUAL_SHEET_BBOX.get(sheet_file)
    # 表级缩放基准:按单元格实际高度折算到 TARGET_H
    cell_h = (h // 3) if manual is None else (h // 2 if sheet_file == "girl-sheet2.png" else h // 3)
    for idx, act in enumerate(acts):
        if manual is not None:
            bbox = manual[idx]
        else:
            row, col = divmod(idx, 2)
            cell = sheet.crop((col * w // 2, row * h // 3, (col + 1) * w // 2, (row + 1) * h // 3))
            bbox = extract_cell(cell)
        if bbox is None:
            print(f"  {act}: 空格,跳过")
            continue
        crop = sheet.crop(bbox)
        scale = TARGET_H / cell_h
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
