# -*- coding: utf-8 -*-
"""把单张透明动作图规格化为桌宠使用的 440×640 PNG。

处理：按 alpha 取紧致边界，在不超过 420px 宽的前提下缩放到约 615px 高，
水平居中并让脚底贴住画布底边。适合 imagegen 生成的新动作图。

用法：
  python scripts/normalize_action_sprite.py input.png output.png
"""

from pathlib import Path
import sys

from PIL import Image

CANVAS = (440, 640)
TARGET_HEIGHT = 615
MAX_WIDTH = 420
ALPHA_THRESHOLD = 40


def tight_bbox(image: Image.Image):
    alpha = image.getchannel("A").point(lambda value: 255 if value > ALPHA_THRESHOLD else 0)
    return alpha.getbbox()


def normalize(source: Path, destination: Path) -> None:
    image = Image.open(source).convert("RGBA")
    box = tight_bbox(image)
    if box is None:
        raise ValueError("输入图没有可见像素")

    crop = image.crop(box)
    scale = min(TARGET_HEIGHT / crop.height, MAX_WIDTH / crop.width)
    width = max(1, round(crop.width * scale))
    height = max(1, round(crop.height * scale))
    crop = crop.resize((width, height), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    x = (CANVAS[0] - width) // 2
    y = CANVAS[1] - height
    canvas.alpha_composite(crop, (x, y))
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination)
    print(f"{source} -> {destination} ({width}x{height} at {x},{y})")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    normalize(Path(sys.argv[1]), Path(sys.argv[2]))
