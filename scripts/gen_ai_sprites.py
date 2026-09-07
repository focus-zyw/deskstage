# -*- coding: utf-8 -*-
"""AI 生成正式立绘:public/sprites/{a,b}/{action}.png

甲 = 阳光元气便利店女店员(蓝/白/黄/浅棕),乙 = 慵懒程序员宅男(黑/深灰/白)。
提示词为用户提供的原文,固定 seed + 末尾表情句实现 6 表情差分。

用法:
  python scripts/gen_ai_sprites.py candidates          # 选美轮:每角色 4 个 seed 出 idle,拼 ai_candidates.png
  python scripts/gen_ai_sprites.py gen <seed甲> <seed乙>  # 全量:6 表情 + 抠背景 + 统一对齐,覆盖 public/sprites

管线:Pollinations Flux(704x1024,与 440:640 同比例)→ 浅色背景四边 flood-fill 抠图
→ 每角色 6 张取 alpha 并集 bbox 做同一裁剪 → 缩放至高约 615px、脚底贴 y=640 → 输出 440x640 RGBA。
原始图缓存在 scripts/ai_raw/,重跑同 seed 自动跳过下载。
"""

import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageDraw, ImageFilter, ImageFont

GW, GH = 704, 1024  # 生成尺寸,440:640 同比例
TARGET_H = 615      # 对齐后角色高(留头顶余量,脚底贴 640)
CANVAS = (440, 640)
ACTIONS = ["idle", "talk", "happy", "angry", "sad", "surprise"]

# 提示词为用户中文人设的英文紧凑版。实测 pollinations 会截断长提示词(约 300-500 字符),
# 且 Flux 对长中文遵循度差 —— 因此表情/构图/风格词置顶,人设精简在后,总长控制在 ~400。
BASE_A = (
    "2.5-head-tall chibi anime girl, full body standing straight, feet visible, "
    "isolated on plain white background, no shadow, cel shading, no text. "
    "Sunny clerk girl: brown hair in single high ponytail with small yellow hair clips, "
    "big warm brown eyes; blue and white short jacket, black pleated skirt, white sneakers."
)
BASE_B = (
    "2.5-head-tall chibi anime boy, full body standing straight, feet visible, "
    "isolated on plain white background, no shadow, cel shading, no text. "
    "Lazy programmer boy: black messy hair, gray-blue half-lidded eyes, tired calm face, "
    "black round glasses; dark gray hoodie over white T-shirt, black cargo pants, "
    "big headphones around neck, black backpack."
)

# 表情前缀(权重最高的位置);同 seed 锁定身体。措辞加重避免同 seed 下表情被弱化
EXPRS = {
    "idle": "",
    "talk": "Talking cheerfully with mouth open mid-speech, bright eyes. ",
    "happy": "Laughing joyfully, eyes squeezed shut in happy crescents, mouth wide open smiling. ",
    "angry": "Angry, brows furrowed, glaring, puffed cheeks in a pout. ",
    "sad": "Very sad, drooping eyebrows, big teary eyes with a tear running down, downturned mouth. ",
    "surprise": "Shocked, eyes wide open, mouth hanging open in an O shape, sweat drop. ",
}

CHARS = {"a": BASE_A, "b": BASE_B}
CANDIDATE_SEEDS = [11, 42, 77, 2024]

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "ai_raw")
SPRITE_ROOT = os.path.join(HERE, "..", "public", "sprites")


def prompt_for(ch: str, action: str) -> str:
    # 表情词在最前(截断保不住尾巴,且模型对开头权重最高)
    return (EXPRS[action] + CHARS[ch]).strip()


def fetch(prompt: str, seed: int, out_path: str, overwrite: bool = False) -> bool:
    if not overwrite and os.path.exists(out_path):
        print("cache", os.path.basename(out_path))
        return True
    import urllib.error

    url = "https://image.pollinations.ai/prompt/" + urllib.parse.quote(prompt)
    url += f"?width={GW}&height={GH}&seed={seed}&model=flux&nologo=true&private=true"
    for attempt in range(8):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = resp.read()
            with open(out_path, "wb") as f:
                f.write(data)
            Image.open(out_path).load()  # 校验图片完整
            print("ok", os.path.basename(out_path), f"{len(data)//1024}KB", flush=True)
            time.sleep(5)  # 匿名通道限流:请求间隔
            return True
        except urllib.error.HTTPError as exc:
            wait = exc.headers.get("Retry-After") if exc.headers else None
            wait = int(wait) if wait and wait.isdigit() else 15 + 10 * attempt
            print(f"  retry{attempt + 1}", os.path.basename(out_path),
                  f"HTTP {exc.code}, wait {wait}s", flush=True)
            time.sleep(wait)
        except Exception as exc:  # noqa: BLE001
            print(f"  retry{attempt + 1}", os.path.basename(out_path), exc, flush=True)
            time.sleep(8 * (attempt + 1))
    return False


def download_all(tasks):
    """tasks: [(prompt, seed, out_path)] 串行下载(匿名通道限流 1 并发),返回成功数"""
    ok = 0
    for task in tasks:
        ok += fetch(*task)
    return ok


def remove_bg(im: Image.Image) -> Image.Image:
    """浅色背景:四边 flood-fill 成品红后按色匹配成 alpha,腐蚀 1px 去杂边 + 轻羽化"""
    rgb = im.convert("RGB")
    work = rgb.copy()
    wd, hd = work.size
    magenta = (255, 0, 254)
    border = [(0, 0), (wd - 1, 0), (0, hd - 1), (wd - 1, hd - 1),
              (wd // 2, 0), (wd // 2, hd - 1), (0, hd // 2), (wd - 1, hd // 2)]
    for pt in border:
        if work.getpixel(pt) != magenta:
            ImageDraw.floodfill(work, pt, magenta, thresh=40)
    try:
        import numpy as np

        arr = np.asarray(work)
        bg = (arr[:, :, 0] == 255) & (arr[:, :, 1] == 0) & (arr[:, :, 2] == 254)
        mask = Image.fromarray((~bg).astype("uint8") * 255, "L")
    except ImportError:
        mask = Image.new("L", work.size, 255)
        mpx, wpx = mask.load(), work.load()
        for y in range(hd):
            for x in range(wd):
                if wpx[x, y] == magenta:
                    mpx[x, y] = 0
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    out = rgb.convert("RGBA")
    out.putalpha(mask)
    return out


def alpha_bbox(im: Image.Image):
    return im.getchannel("A").getbbox()


def align(rgba: Image.Image, union_box, out_path: str):
    cropped = rgba.crop(union_box)
    w, h = cropped.size
    scale = TARGET_H / h
    if w * scale > CANVAS[0] - 8:
        scale = (CANVAS[0] - 8) / w
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = cropped.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    canvas.paste(resized, ((CANVAS[0] - nw) // 2, CANVAS[1] - nh), resized)
    canvas.save(out_path)
    return canvas


def sheet(items, cols, cell_w, cell_h, label_h, path):
    rows = (len(items) + cols - 1) // cols
    pad = 12
    img = Image.new("RGBA", (cols * cell_w + (cols + 1) * pad,
                             rows * (cell_h + label_h) + (rows + 1) * pad),
                    (246, 245, 250, 255))
    d = ImageDraw.Draw(img)
    for y in range(0, img.height, 16):
        for x in range(0, img.width, 16):
            if (x // 16 + y // 16) % 2 == 0:
                d.rectangle((x, y, x + 15, y + 15), fill=(232, 231, 238, 255))
    try:
        font = ImageFont.load_default(size=16)
    except TypeError:
        font = ImageFont.load_default()
    for i, (label, im) in enumerate(items):
        r, c = divmod(i, cols)
        x = pad + c * (cell_w + pad)
        y = pad + r * (cell_h + label_h + pad)
        cell = im.convert("RGBA").resize((cell_w, cell_h), Image.LANCZOS)
        img.paste(cell, (x, y), cell)
        d.text((x + 4, y + cell_h + 4), label, fill=(40, 40, 50, 255), font=font)
    img.convert("RGB").save(path)
    print("sheet", os.path.relpath(path, os.path.join(HERE, "..")))


def cmd_candidates():
    os.makedirs(RAW_DIR, exist_ok=True)
    tasks = []
    for ch in CHARS:
        for seed in CANDIDATE_SEEDS:
            out = os.path.join(RAW_DIR, f"{ch}_idle_s{seed}.png")
            tasks.append((prompt_for(ch, "idle"), seed, out))
    if download_all(tasks) < len(tasks):
        sys.exit("部分图片下载失败,见上方日志")
    items = []
    for ch in CHARS:
        for seed in CANDIDATE_SEEDS:
            p = os.path.join(RAW_DIR, f"{ch}_idle_s{seed}.png")
            items.append((f"{ch} seed={seed}", Image.open(p)))
    sheet(items, 4, 220, 320, 26, os.path.join(HERE, "ai_candidates.png"))


def cmd_gen(seed_a: int, seed_b: int):
    os.makedirs(RAW_DIR, exist_ok=True)
    seeds = {"a": seed_a, "b": seed_b}
    tasks = []
    for ch in CHARS:
        for act in ACTIONS:
            out = os.path.join(RAW_DIR, f"{ch}_{act}_s{seeds[ch]}.png")
            tasks.append((prompt_for(ch, act), seeds[ch], out))
    if download_all(tasks) < len(tasks):
        sys.exit("部分图片下载失败,见上方日志")

    for ch in CHARS:
        cut = {act: remove_bg(Image.open(os.path.join(RAW_DIR, f"{ch}_{act}_s{seeds[ch]}.png")))
               for act in ACTIONS}
        boxes = [alpha_bbox(im) for im in cut.values()]
        union = (min(b[0] for b in boxes), min(b[1] for b in boxes),
                 max(b[2] for b in boxes), max(b[3] for b in boxes))
        scale = TARGET_H / (union[3] - union[1])
        print(f"[{ch}] union={union} scale={scale:.3f}")
        for act in ACTIONS:
            out_path = os.path.join(SPRITE_ROOT, ch, f"{act}.png")
            align(cut[act], union, out_path)
            top_off = (alpha_bbox(cut[act])[1] - union[1]) * scale
            print(f"  {act}: 头顶相对偏移 {top_off:.0f}px" + ("  <-- 偏差偏大" if top_off > 15 else ""))
        print("  ->", os.path.relpath(os.path.join(SPRITE_ROOT, ch), os.path.join(HERE, "..")))

    items = [(f"{ch} · {act}", Image.open(os.path.join(SPRITE_ROOT, ch, f"{act}.png")))
             for ch in ("a", "b") for act in ACTIONS]
    sheet(items, 6, 220, 320, 26, os.path.join(HERE, "preview_ai_sprites.png"))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "candidates":
        cmd_candidates()
    elif cmd == "gen" and len(sys.argv) == 4:
        cmd_gen(int(sys.argv[2]), int(sys.argv[3]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
