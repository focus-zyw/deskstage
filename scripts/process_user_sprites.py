# -*- coding: utf-8 -*-
"""把 temp/ 下用户生成的形态图规格化为游戏素材:public/sprites/{a,b}/{action}.png

输入命名:temp/{girl|boy}-{action}.png(action ∈ idle|talk|happy|angry|sad|surprise)
处理:alpha 阈值化测紧致 bbox(排除光晕噪声)→ 以 idle 的 bbox 高为基准求统一缩放
(蹲姿等小体型形态自然显矮,不被拉伸)→ 底边对齐 y=640、水平居中 → 输出 440x640 RGBA。

用法:
  python scripts/process_user_sprites.py girl   # 只处理已存在的形态
  python scripts/process_user_sprites.py boy
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
MAX_W = 432      # 留 8px 边距
ALPHA_T = 60     # bbox 测量阈值:滤掉半透明光晕,只算角色本体


def tight_bbox(im: Image.Image):
    a = im.getchannel("A").point(lambda v: 255 if v > ALPHA_T else 0)
    return a.getbbox()


def main(prefix: str) -> None:
    actions = ["idle", "talk", "happy", "angry", "sad", "surprise"]
    loaded = {}
    for act in actions:
        p = os.path.join(TEMP, f"{prefix}-{act}.png")
        if os.path.exists(p):
            loaded[act] = Image.open(p).convert("RGBA")
    if "idle" not in loaded:
        sys.exit(f"缺少 {prefix}-idle.png")
    print(f"[{prefix}] 已有形态: {list(loaded)}")

    idle_h = tight_bbox(loaded["idle"])[3] - tight_bbox(loaded["idle"])[1]
    scale = TARGET_H / idle_h
    max_w = max(tight_bbox(im)[2] - tight_bbox(im)[0] for im in loaded.values())
    if max_w * scale > MAX_W:
        scale = MAX_W / max_w
    print(f"[{prefix}] 统一缩放 {scale:.4f} (idle 本体高 {idle_h}px)")

    outdir = os.path.join(OUT, DIR_OF[prefix])
    os.makedirs(outdir, exist_ok=True)
    for act, im in loaded.items():
        box = tight_bbox(im)
        crop = im.crop(box)
        nw, nh = round(crop.width * scale), round(crop.height * scale)
        crop = crop.resize((nw, nh), Image.LANCZOS)
        canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
        canvas.paste(crop, ((CANVAS[0] - nw) // 2, CANVAS[1] - nh), crop)
        canvas.save(os.path.join(outdir, f"{act}.png"))
        print(f"  {act}: bbox={box} -> {nw}x{nh}")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in DIR_OF:
        sys.exit(__doc__)
    main(sys.argv[1])
