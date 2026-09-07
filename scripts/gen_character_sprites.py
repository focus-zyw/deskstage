# -*- coding: utf-8 -*-
"""生成正式风格角色立绘:public/sprites/{a,b}/{action}.png

替代 gen_placeholder_sprites.py 的光板胶囊小人,规格完全一致:
- 画布 440x640,RGBA 透明背景,脚底贴画布底边,各表情头脚严格对齐
- 文件名 = 动作词(idle|talk|happy|angry|sad|surprise),小写
- 甲(紫 #7C6CF0):瘦高、黑色呆毛短发、持折扇;乙(橙 #F08C5A):矮圆、锅盖头、圆眼镜
- 身体 6 张共用同一底图,只重绘脸部,切换交叉淡入时不会穿帮
- 先按 4 倍超采样绘制再缩小,保证描边平滑

预览:运行后生成 scripts/preview_sprites.png(12 张拼图)。
"""

import os

from PIL import Image, ImageDraw, ImageFont

S = 4  # 超采样倍数
W, H = 440, 640
ACTIONS = ["idle", "talk", "happy", "angry", "sad", "surprise"]

OUTLINE = (67, 48, 43, 255)  # 暖深棕描边
SKIN = (255, 227, 200, 255)
BLUSH = (255, 199, 192, 255)
BLUSH_HOT = (255, 158, 146, 255)
MOUTH = (107, 48, 57, 255)
TONGUE = (227, 119, 111, 255)
TEAR = (143, 212, 255, 255)
TEAR_EDGE = (74, 144, 196, 255)
ANGER = (226, 74, 74, 255)
WHITE = (255, 255, 255, 255)
FAN = (217, 168, 92, 255)

CHARS = {
    "a": dict(
        body=(124, 108, 240, 255),  # 与 SPRITE_SETS.accent 一致
        body_dark=(84, 68, 196, 255),
        trim=(237, 235, 255, 255),
        hair=(43, 36, 34, 255),
        body_poly=[(152, 288), (288, 288), (310, 616), (130, 616)],
        shoes=[(157, 598, 213, 645), (227, 598, 283, 645)],
        sleeves=[
            [(154, 306), (110, 320), (120, 478), (164, 466)],
            [(286, 306), (330, 320), (320, 478), (276, 466)],
        ],
        cuffs=[
            [(118, 458), (166, 450), (164, 470), (120, 478)],
            [(322, 458), (274, 450), (276, 470), (320, 478)],
        ],
        hands=[(124, 472, 160, 508), (280, 472, 316, 508)],
        fan=True,
    ),
    "b": dict(
        body=(240, 140, 90, 255),
        body_dark=(196, 100, 56, 255),
        trim=(255, 233, 216, 255),
        hair=(74, 53, 46, 255),
        body_poly=[(140, 288), (300, 288), (322, 616), (118, 616)],
        shoes=[(148, 598, 208, 645), (232, 598, 292, 645)],
        sleeves=[
            [(144, 306), (100, 322), (112, 480), (158, 468)],
            [(296, 306), (340, 322), (328, 480), (282, 468)],
        ],
        cuffs=[
            [(110, 460), (160, 448), (158, 470), (112, 480)],
            [(330, 460), (280, 448), (282, 470), (328, 480)],
        ],
        hands=[(115, 472, 155, 512), (285, 472, 325, 512)],
        fan=False,
    ),
}


def sc(v):
    if isinstance(v[0], (tuple, list)):  # 点列表 [(x,y),...]
        return [t for pt in v for t in (pt[0] * S, pt[1] * S)]
    return [x * S for x in v]


def ell(d, box, fill=None, outline=None, w=0):
    d.ellipse(sc(box), fill=fill, outline=outline, width=int(w * S) if w else 0)


def lne(d, pts, fill, w):
    d.line(sc(pts), fill=fill, width=max(1, int(w * S)), joint="curve")


def poly(d, pts, fill=None, outline=None, w=0):
    pts = sc(pts)
    if fill:
        d.polygon(pts, fill=fill)
    if outline:
        d.line(pts + pts[:2], fill=outline, width=max(1, int(w * S)), joint="curve")


def rr(d, box, radius, fill=None, outline=None, w=0):
    d.rounded_rectangle(
        sc(box), radius=radius * S, fill=fill,
        outline=outline, width=int(w * S) if w else 0,
    )


def draw_fan(d):
    # 合拢的折扇,别在右手边(带扇钉与扇骨)
    poly(d, [(298, 486), (320, 492), (352, 442), (332, 430)], fill=FAN, outline=OUTLINE, w=3)
    lne(d, [(304, 483), (344, 443)], OUTLINE, 2)
    lne(d, [(311, 487), (350, 452)], OUTLINE, 2)
    ell(d, (303, 482, 315, 492), fill=OUTLINE)


def draw_hair(d, c):
    d.chord(sc((102, 60, 338, 296)), 200, 340, fill=c["hair"])
    if c is CHARS["a"]:
        # 锯齿刘海 + 鬓角 + 呆毛
        poly(d, [(110, 140), (138, 120), (166, 146), (194, 118), (222, 146),
                 (250, 118), (278, 146), (306, 120), (332, 140), (332, 104), (110, 104)],
             fill=c["hair"])
        poly(d, [(104, 136), (128, 146), (118, 210)], fill=c["hair"])
        poly(d, [(336, 136), (312, 146), (322, 210)], fill=c["hair"])
        # 弯钩呆毛:从发顶向右甩出再回勾
        poly(d, [(205, 70), (246, 28), (238, 44), (229, 60), (226, 62)], fill=c["hair"])
    else:
        # 锅盖头:平刘海 + 直鬓角
        rr(d, (108, 100, 332, 158), radius=20, fill=c["hair"])
        for cx in (164, 220, 276):
            poly(d, [(cx - 14, 158), (cx + 14, 158), (cx, 134)], fill=SKIN)
        rr(d, (106, 128, 126, 206), radius=10, fill=c["hair"])
        rr(d, (314, 128, 334, 206), radius=10, fill=c["hair"])


def draw_body(d, c):
    for box in c["shoes"]:
        ell(d, box, fill=OUTLINE)
    poly(d, c["body_poly"], fill=c["body"], outline=OUTLINE, w=5)
    # 对襟 V 领 + 竖襟线 + 盘扣
    lne(d, [(200, 296), (220, 332)], c["trim"], 9)
    lne(d, [(240, 296), (220, 332)], c["trim"], 9)
    lne(d, [(220, 332), (220, 610)], c["body_dark"], 3)
    for y in (380, 440, 500):
        ell(d, (227, y - 4, 235, y + 4), fill=c["trim"])
    for sl, cuff, hand in zip(c["sleeves"], c["cuffs"], c["hands"]):
        poly(d, sl, fill=c["body"], outline=OUTLINE, w=4)
        poly(d, cuff, fill=c["trim"], outline=OUTLINE, w=3)
        ell(d, hand, fill=SKIN, outline=OUTLINE, w=4)
    if c["fan"]:
        draw_fan(d)
    ell(d, (88, 166, 116, 194), fill=SKIN, outline=OUTLINE, w=4)
    ell(d, (324, 166, 352, 194), fill=SKIN, outline=OUTLINE, w=4)
    ell(d, (102, 60, 338, 296), fill=SKIN, outline=OUTLINE, w=5)
    draw_hair(d, c)


def draw_face(d, expr, c):
    glasses = c is CHARS["b"]

    def brows(pts_l, pts_r, w=6):
        lne(d, pts_l, OUTLINE, w)
        lne(d, pts_r, OUTLINE, w)

    def blush(fill):
        ell(d, (148, 208, 176, 222), fill=fill)
        ell(d, (264, 208, 292, 222), fill=fill)

    if expr == "idle":
        brows([(162, 172), (196, 167)], [(244, 167), (278, 172)])
        ell(d, (168, 180, 192, 212), fill=OUTLINE)
        ell(d, (248, 180, 272, 212), fill=OUTLINE)
        ell(d, (172, 184, 180, 192), fill=WHITE)
        ell(d, (252, 184, 260, 192), fill=WHITE)
        blush(BLUSH)
        d.arc(sc((204, 222, 236, 246)), 20, 160, fill=OUTLINE, width=4 * S)
    elif expr == "talk":
        brows([(162, 172), (196, 167)], [(244, 167), (278, 172)])
        ell(d, (168, 180, 192, 212), fill=OUTLINE)
        ell(d, (248, 180, 272, 212), fill=OUTLINE)
        ell(d, (172, 184, 180, 192), fill=WHITE)
        ell(d, (252, 184, 260, 192), fill=WHITE)
        blush(BLUSH)
        ell(d, (206, 218, 234, 256), fill=MOUTH)
        ell(d, (210, 240, 230, 254), fill=TONGUE)
    elif expr == "happy":
        brows([(162, 166), (196, 161)], [(244, 161), (278, 166)])
        d.arc(sc((162, 182, 198, 208)), 180, 360, fill=OUTLINE, width=5 * S)
        d.arc(sc((242, 182, 278, 208)), 180, 360, fill=OUTLINE, width=5 * S)
        blush(BLUSH_HOT)
        d.pieslice(sc((198, 218, 242, 258)), 0, 180, fill=MOUTH)
        ell(d, (208, 244, 232, 258), fill=TONGUE)
    elif expr == "angry":
        brows([(160, 158), (198, 174)], [(242, 174), (280, 158)], w=7)
        ell(d, (170, 186, 190, 208), fill=OUTLINE)
        ell(d, (250, 186, 270, 208), fill=OUTLINE)
        ell(d, (174, 190, 180, 196), fill=WHITE)
        ell(d, (254, 190, 260, 196), fill=WHITE)
        d.arc(sc((204, 228, 236, 248)), 180, 360, fill=OUTLINE, width=4 * S)
        lne(d, [(302, 134), (302, 158)], ANGER, 5)
        lne(d, [(290, 146), (314, 146)], ANGER, 5)
    elif expr == "sad":
        brows([(164, 176), (196, 166)], [(244, 166), (276, 176)])
        ell(d, (170, 184, 190, 210), fill=OUTLINE)
        ell(d, (250, 184, 270, 210), fill=OUTLINE)
        ell(d, (174, 188, 180, 194), fill=WHITE)
        ell(d, (254, 188, 260, 194), fill=WHITE)
        d.arc(sc((206, 230, 234, 246)), 180, 360, fill=OUTLINE, width=4 * S)
        poly(d, [(170, 206), (181, 222), (179, 232), (170, 238), (161, 232), (159, 222)],
             fill=TEAR, outline=TEAR_EDGE, w=3)
    elif expr == "surprise":
        brows([(162, 156), (198, 152)], [(242, 152), (278, 156)])
        ell(d, (163, 179, 197, 213), fill=WHITE, outline=OUTLINE, w=3)
        ell(d, (243, 179, 277, 213), fill=WHITE, outline=OUTLINE, w=3)
        ell(d, (172, 188, 188, 204), fill=OUTLINE)
        ell(d, (252, 188, 268, 204), fill=OUTLINE)
        ell(d, (175, 191, 181, 197), fill=WHITE)
        ell(d, (255, 191, 261, 197), fill=WHITE)
        ell(d, (204, 222, 236, 254), fill=MOUTH)
        poly(d, [(318, 112), (331, 132), (329, 144), (319, 150), (309, 144), (307, 132)],
             fill=TEAR, outline=TEAR_EDGE, w=3)

    if glasses:
        ell(d, (160, 176, 200, 216), outline=OUTLINE, w=4)
        ell(d, (240, 176, 280, 216), outline=OUTLINE, w=4)
        lne(d, [(198, 192), (242, 192)], OUTLINE, 4)
        lne(d, [(160, 192), (142, 186)], OUTLINE, 4)
        lne(d, [(280, 192), (298, 186)], OUTLINE, 4)


def main():
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "sprites")
    sprites = []  # (label, RGBA 440x640)
    for key in ("a", "b"):
        c = CHARS[key]
        base = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
        draw_body(ImageDraw.Draw(base), c)
        outdir = os.path.join(root, key)
        os.makedirs(outdir, exist_ok=True)
        for expr in ACTIONS:
            layer = base.copy()
            draw_face(ImageDraw.Draw(layer), expr, c)
            small = layer.resize((W, H), Image.LANCZOS)
            path = os.path.join(outdir, f"{expr}.png")
            small.save(path)
            sprites.append((f"{key} · {expr}", small))
            print("ok", os.path.relpath(path, os.path.join(root, "..", "..")))

    # 预览拼图:棋盘格背景衬托透明区域
    cols, cw, ch, pad, label_h = 6, 220, 320, 12, 26
    rows = 2
    sheet = Image.new(
        "RGBA",
        (cols * cw + (cols + 1) * pad, rows * (ch + label_h) + (rows + 1) * pad),
        (246, 245, 250, 255),
    )
    ds = ImageDraw.Draw(sheet)
    for y in range(0, sheet.height, 16):
        for x in range(0, sheet.width, 16):
            if (x // 16 + y // 16) % 2 == 0:
                ds.rectangle((x, y, x + 15, y + 15), fill=(232, 231, 238, 255))
    try:
        font = ImageFont.load_default(size=16)
    except TypeError:
        font = ImageFont.load_default()
    for i, (label, img) in enumerate(sprites):
        r, col = divmod(i, cols)
        x = pad + col * (cw + pad)
        y = pad + r * (ch + label_h + pad)
        cell = img.resize((cw, ch), Image.LANCZOS)
        sheet.paste(cell, (x, y), cell)
        ds.text((x + 4, y + ch + 4), label, fill=(40, 40, 50, 255), font=font)
    preview = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preview_sprites.png")
    sheet.convert("RGB").save(preview)
    print("ok", os.path.relpath(preview, os.path.join(root, "..", "..")))


if __name__ == "__main__":
    main()
