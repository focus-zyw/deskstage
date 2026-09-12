#!/usr/bin/env python3
"""C 动画高清重制总驱动:step02 抠像 → step03 归一化 → 960×540 下采样替换 public/animations/c/。
上游管线(scripts/hd/chroma_step02.py + normalize_step03.py,取自 dsh-pet)已验证布局与现有一致。
用法:python scripts/hd/rebuild_hd.py [--from-step N]  (断点续跑:每步跳过已完成文件)"""

import io
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STEP2 = os.path.join(ROOT, 'tmp', 'step02')
STEP3 = os.path.join(ROOT, 'tmp', 'step03')
OUT = os.path.join(ROOT, 'public', 'animations', 'c')
SRC_MAP = os.path.join(ROOT, 'scripts', 'fetch-c-animations.mjs')
SCALE = '960:540'
CRF = '33'

# 英文 ID → 上游中文名(与 fetch-c-animations.mjs SOURCES 同源,单处维护抓取脚本)
def load_sources():
    s = io.open(SRC_MAP, encoding='utf-8').read()
    block = re.search(r'const SOURCES = \{([\s\S]*?)\n\}', s).group(1)
    pairs = re.findall(r"(\w+): \['([^']+)'\]", block)
    return dict(pairs)

def main():
    from_step = int(sys.argv[sys.argv.index('--from-step') + 1]) if '--from-step' in sys.argv else 1
    sources = load_sources()
    missing = [cn for cn in sources.values()
               if not os.path.exists(os.path.join(STEP3, f'{cn}.webm'))]
    if from_step <= 3 and missing:
        print(f'step03 缺 {len(missing)} 个,先确认 step02/step03 是否已跑完', flush=True)

    if from_step <= 3:
        print('== step01 去水印 ==', flush=True)
        subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'hd', 'watermark_step01.py')], check=True, cwd=ROOT)
        print('== step02 抠像 ==', flush=True)
        chroma = os.path.join(ROOT, 'scripts', 'hd', 'chroma_step02.py')
        cs = io.open(chroma, encoding='utf-8').read()
        cs = cs.replace('SRC = ROOT.parent / "tmp" / "vid-need"', 'SRC = ROOT.parent / "tmp" / "step01"')
        io.open(chroma, 'w', encoding='utf-8', newline='\n').write(cs)
        subprocess.run([sys.executable, chroma], check=True, cwd=ROOT)
        print('== step03 归一化 ==', flush=True)
        subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'hd', 'normalize_step03.py')], check=True, cwd=ROOT)

    print(f'== 下采样 {SCALE} CRF{CRF} 并替换 ==', flush=True)
    os.makedirs(OUT, exist_ok=True)
    total = len(sources)
    for i, (eid, cn) in enumerate(sorted(sources.items()), 1):
        src = os.path.join(STEP3, f'{cn}.webm')
        dst = os.path.join(OUT, f'{eid}.webm')
        if not os.path.exists(src):
            print(f'[{i}/{total}] 缺源 {src}')
            continue
        # 输入侧强制 libvpx 解码以读出 alpha 层(否则 format=yuva420p 补的是全 255)
        # alpha 重映射:污染圈(低alpha边缘)推向透明,去灰蒙边;despill 满强度压绿溢出
        LUT = "if(lt(val,80),0,min(255,(val-80)*4))"
        fc = (
            f'[0:v]scale={SCALE},format=yuva420p,split[main][am];'
            f"[am]alphaextract,lut=y='{LUT}'[mask];"
            f'[main][mask]alphamerge,despill=type=green:mix=1.0,format=yuva420p'
        )
        subprocess.run([
            'ffmpeg', '-v', 'error', '-y',
            '-c:v', 'libvpx-vp9', '-i', src,
            '-filter_complex', fc,
            '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
            '-crf', CRF, '-b:v', '0', '-auto-alt-ref', '0',
            '-deadline', 'good', '-cpu-used', '4', dst,
        ], check=True)
        size = os.path.getsize(dst) // 1024
        print(f'[{i}/{total}] {eid}.webm {size}KB', flush=True)
    total_size = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT) if f.endswith('.webm'))
    print(f'完成: {total} 个, 总大小 {total_size // 1024 // 1024}MB')

if __name__ == '__main__':
    main()
