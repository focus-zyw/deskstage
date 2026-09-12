#!/usr/bin/env python3
"""重制产物验收:尺寸 960×540、VP9 alpha 存在、文件齐全;抽帧目检由调用方执行。"""
import glob
import os
import subprocess
import sys

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'public', 'animations', 'c')

def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                        '-show_entries', 'stream=codec_name,width,height',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    return r.stdout.strip()

def alpha_ok(path):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', path,
                        '-frames:v', '3', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
                       capture_output=True)
    # 960*540*4*3
    if len(r.stdout) < 960 * 540 * 4 * 3:
        return False, 'alpha 解码失败'
    import numpy as np
    per = 960 * 540 * 4
    f = np.frombuffer(r.stdout[:per], np.uint8).reshape(540, 960, 4)
    a = f[..., 3]
    transparent = (a < 128).mean()
    return 0.05 < transparent < 0.98, f'透明占比 {transparent:.0%}'

def main():
    files = sorted(glob.glob(os.path.join(OUT, '*.webm')))
    print(f'共 {len(files)} 个文件')
    bad = []
    total = 0
    for f in files:
        size = os.path.getsize(f)
        total += size
        info = probe(f)
        if info != 'vp9,960,540':
            bad.append((f, f'规格异常: {info}'))
            continue
        ok, msg = alpha_ok(f)
        if not ok:
            bad.append((f, msg))
    print(f'总大小: {total // 1024 // 1024}MB')
    if bad:
        print(f'异常 {len(bad)} 个:')
        for f, why in bad[:10]:
            print(' ', os.path.basename(f), why)
        sys.exit(1)
    print('全部通过: vp9/960x540/alpha 正常')

if __name__ == '__main__':
    main()
