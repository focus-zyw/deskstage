# -*- coding: utf-8 -*-
"""把 temp/ 下用户生成的形态图规格化为游戏素材:public/sprites/{a,b}/{action}.png

输入命名:temp/{girl|boy}-{action}.png(action ∈ idle|talk|happy|angry|sad|surprise)
处理:alpha 阈值化测紧致 bbox(排除光晕噪声)→ 以 idle 的 bbox 高为基准求统一缩放
(蹲姿等小体型形态自然显矮,不被拉伸)→ 底边对齐 y=640、水平居中 → 输出 440x640 RGBA。

用法:
  python scripts/process_user_sprites.py girl           # 只处理已存在的形态
  python scripts/process_user_sprites.py boy --flip     # 整组水平镜像(面向另一角色)
"""

import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TEMP = os.path.join(HERE, "..", "temp")
OUT = os.path.join(HERE, "..", "public", "sprites")
DIR_OF = {"girl": "a", "boy": "b"}
CANVAS = (440, 640)
TARGET_H = 615   # idle 形态的目标高(头顶留 ~25px)
ALPHA_T = 60     # bbox 测量阈值:滤掉半透明光晕,只算角色本体


def tight_bbox(im: Image.Image):
    a = im.getchannel("A").point(lambda v: 255 if v > ALPHA_T else 0)
    return a.getbbox()


def head_width(im: Image.Image) -> int:
    """头部参考宽:取 bbox 顶部 6%~18% 高度带内每行 alpha 本体的最大连续段宽,取中位数。
    用于校正生成工具对个别表情的构图放大 —— 同角色各表情头部应等大。"""
    a = im.getchannel("A").point(lambda v: 255 if v > ALPHA_T else 0)
    box = a.getbbox()
    top, h = box[1], box[3] - box[1]
    widths = []
    for frac in (0.06, 0.08, 0.10, 0.12, 0.14, 0.16, 0.18):
        y = min(a.height - 1, int(top + h * frac))
        row = [x for x in range(a.width) if a.getpixel((x, y)) > 0]
        if not row:
            continue
        best = cur = 1
        prev = row[0]
        for x in row[1:]:
            if x == prev + 1:
                cur += 1
            else:
                best = max(best, cur)
                cur = 1
            prev = x
        best = max(best, cur)
        widths.append(best)
    widths.sort()
    return widths[len(widths) // 2] if widths else 0


def main(prefix: str, flip: bool = False) -> None:
    actions = ["idle", "talk", "happy", "angry", "sad", "surprise", "shy"]
    loaded = {}
    for act in actions:
        p = os.path.join(TEMP, f"{prefix}-{act}.png")
        if os.path.exists(p):
            im = Image.open(p).convert("RGBA")
            if flip:  # 整组镜像,让角色面向画面另一侧;注意图内文字会反字
                im = im.transpose(Image.FLIP_LEFT_RIGHT)
            loaded[act] = im
    if "idle" not in loaded:
        sys.exit(f"缺少 {prefix}-idle.png")
    print(f"[{prefix}] 已有形态: {list(loaded)}" + ("(已水平镜像)" if flip else ""))

    idle_box = tight_bbox(loaded["idle"])
    idle_h = idle_box[3] - idle_box[1]
    idle_head = head_width(loaded["idle"])
    scale = TARGET_H / idle_h
    # 逐表情按头部宽度归一(只缩不放):生成工具常把蹲/坐等表情的构图放大,
    # 统一缩放会让头部明显大于 idle;比值钳制在 [0.65, 1] 防矫枉过正
    for act, im in loaded.items():
        sample = im.getchannel("A")
        if sample.getextrema() == (255, 255):  # 整张不透明(白底无透明),自动抠图不可靠
            print(f"  {act}: 跳过(alpha 全 255,为白底无透明图;请用透明底 PNG 重导)")
            continue
        head = head_width(im)
        ratio = min(1.0, max(0.65, idle_head / head)) if head else 1.0
        print(f"  {act}: 头宽 {head}px,归一系数 {ratio:.3f}")
        box = tight_bbox(im)
        crop = im.crop(box)
        act_scale = scale * ratio
        nw, nh = round(crop.width * act_scale), round(crop.height * act_scale)
        crop = crop.resize((nw, nh), Image.LANCZOS)
        canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
        canvas.paste(crop, ((CANVAS[0] - nw) // 2, CANVAS[1] - nh), crop)
        canvas.save(os.path.join(OUT, DIR_OF[prefix], f"{act}.png"))
        print(f"    -> {nw}x{nh}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--flip"]
    flip = "--flip" in sys.argv[1:]
    if len(args) != 1 or args[0] not in DIR_OF:
        sys.exit(__doc__)
    main(args[0], flip=flip)
