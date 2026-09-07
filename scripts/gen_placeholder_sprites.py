"""生成联调占位立绘:public/sprites/{a,b}/{action}.png

本脚本同时是正式素材的规格参考:
- 画布 440x640(逻辑显示高 320 的 2 倍,适配 Windows 125%/150% DPI)
- RGBA 透明背景;脚底基线贴画布底边;同一角色各表情头脚位置严格对齐
- 文件名 = 动作词(idle|talk|happy|angry|sad|surprise),小写
正式素材到位后,直接用同名同规格文件覆盖即可,代码零改动。
"""

import os

from PIL import Image, ImageDraw

# 表情差异:占位图只换嘴形/眉毛,正式素材为整幅重绘
MOUTHS = {
    "idle": "line",
    "talk": "open",
    "happy": "smile",
    "angry": "frown",
    "sad": "sad",
    "surprise": "o",
}
CHARS = {
    "a": (124, 108, 240, 255),  # 甲 · 紫,与 SPRITE_SETS.accent 一致
    "b": (240, 140, 90, 255),  # 乙 · 橙
}
INK = (20, 20, 31, 255)

W, H = 440, 640
BODY = (70, 40, 370, 640)  # 身体轮廓,底边贴画布底
EYE_Y = 200
MOUTH = (220, 300)
BROW_Y = 160


def draw_brows(d: ImageDraw.ImageDraw, action: str) -> None:
    lx, rx, y = 150, 262, BROW_Y
    if action == "angry":  # 眉头下压
        d.line((lx, y + 2, lx + 28, y + 18), fill=INK, width=7)
        d.line((rx, y + 18, rx + 28, y + 2), fill=INK, width=7)
    elif action == "sad":  # 眉头上挑
        d.line((lx, y + 18, lx + 28, y + 2), fill=INK, width=7)
        d.line((rx, y + 2, rx + 28, y + 18), fill=INK, width=7)
    elif action == "surprise":  # 高抬平眉
        d.line((lx, y - 12, lx + 28, y - 12), fill=INK, width=7)
        d.line((rx, y - 12, rx + 28, y - 12), fill=INK, width=7)


def draw_mouth(d: ImageDraw.ImageDraw, action: str) -> None:
    cx, cy = MOUTH
    if action == "idle":
        d.line((cx - 16, cy, cx + 16, cy), fill=INK, width=6)
    elif action == "talk":
        d.ellipse((cx - 14, cy - 10, cx + 14, cy + 12), fill=INK)
    elif action == "happy":
        d.arc((cx - 22, cy - 22, cx + 22, cy + 10), start=20, end=160, fill=INK, width=6)
    elif action == "angry":
        d.arc((cx - 20, cy - 14, cx + 20, cy + 14), start=200, end=340, fill=INK, width=6)
    elif action == "sad":
        d.arc((cx - 20, cy - 8, cx + 20, cy + 18), start=200, end=340, fill=INK, width=6)
    elif action == "surprise":
        d.ellipse((cx - 11, cy - 10, cx + 11, cy + 10), outline=INK, width=6)


def main() -> None:
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "sprites")
    for ch, color in CHARS.items():
        outdir = os.path.join(root, ch)
        os.makedirs(outdir, exist_ok=True)
        for action in MOUTHS:
            img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            # 身体:圆顶 + 直筒 + 圆角脚底
            d.ellipse((BODY[0], BODY[1], BODY[2], BODY[1] + 300), fill=color)
            d.rectangle((BODY[0], BODY[1] + 150, BODY[2], BODY[3] - 16), fill=color)
            d.rounded_rectangle((BODY[0], BODY[3] - 40, BODY[2], BODY[3]), radius=20, fill=color)
            # 五官
            d.ellipse((150, EYE_Y, 178, EYE_Y + 34), fill=INK)
            d.ellipse((262, EYE_Y, 290, EYE_Y + 34), fill=INK)
            draw_brows(d, action)
            draw_mouth(d, action)
            path = os.path.join(outdir, f"{action}.png")
            img.save(path)
            print("ok", os.path.relpath(path, os.path.join(root, "..", "..")))


if __name__ == "__main__":
    main()
