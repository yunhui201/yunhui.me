"""Regenerate the committed Windows portable splash (requires Pillow and Microsoft YaHei)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT = Path('C:/Windows/Fonts/msyh.ttc')
BOLD = Path('C:/Windows/Fonts/msyhbd.ttc')
image = Image.new('RGB', (620, 250), '#f7f8fc')
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, 619, 249), outline='#dce1ef', width=1)
icon = Image.open(ROOT / 'build/icon.png').convert('RGBA').resize((58, 58), Image.Resampling.LANCZOS)
image.paste(icon, (34, 33), icon)
draw.text((110, 33), '云汇 AI', font=ImageFont.truetype(str(BOLD), 27), fill='#202b48')
draw.text((112, 72), 'yunhui.me', font=ImageFont.truetype(str(FONT), 13), fill='#74819d')
draw.text((36, 127), '正在准备云汇，请稍候…', font=ImageFont.truetype(str(BOLD), 22), fill='#293750')
draw.text((36, 170), '免安装版正在解压，完成后会自动打开。', font=ImageFont.truetype(str(FONT), 15), fill='#65728c')
draw.text((36, 201), '请勿重复打开；解压版 ZIP 可省去每次准备过程。', font=ImageFont.truetype(str(FONT), 13), fill='#7d88a0')
image.save(ROOT / 'build/portable-splash.bmp')
