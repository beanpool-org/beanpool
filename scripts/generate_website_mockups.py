#!/usr/bin/env python3
"""
generate_website_mockups.py

Generates realistic iPhone device mockups with Dynamic Island, titanium bezels,
ambient shadows, and composite showcase for the BeanPool website.
"""

import argparse
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError as e:
    raise SystemExit(
        "Missing dependency: Pillow is required to generate website mockups.\n"
        "Install via: pip install Pillow"
    ) from e

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
WEBSITE_SCREENSHOTS_DIR = os.path.join(REPO_ROOT, "apps", "website", "assets", "screenshots")

DEFAULT_FALLBACK_DIR = "/Users/marty/.gemini/antigravity/brain/51829f8c-76d8-4c86-a853-b180d8f09262/.user_uploaded"

def get_font(font_candidates, size):
    """Attempt to load the first available font from candidates, falling back gracefully."""
    for path in font_candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except (OSError, IOError):
                continue
    for name in ["DejaVuSans-Bold.ttf", "DejaVuSans.ttf", "Arial.ttf", "arial.ttf"]:
        try:
            return ImageFont.truetype(name, size)
        except (OSError, IOError):
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()

def render_ios_status_bar(width, height, is_dark_bg=True, time_text="1:22"):
    status = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(status)
    
    text_color = (255, 255, 255, 245) if is_dark_bg else (15, 23, 42, 240)
    icon_color = (255, 255, 255, 235) if is_dark_bg else (15, 23, 42, 220)
    
    font_candidates = [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    font = get_font(font_candidates, 18)

    # Time (Left side)
    draw.text((36, 18), time_text, fill=text_color, font=font)
    
    # Cellular Bars (Right side)
    rx = width - 104
    bar_w = 3
    for i, bh in enumerate([5, 8, 12, 16]):
        bx = rx + i * 5
        by = 21 + (16 - bh)
        draw.rounded_rectangle([bx, by, bx + bar_w, 21 + 16], radius=1, fill=icon_color)
        
    # Wifi Icon
    wx = rx + 30
    draw.arc([wx - 8, 20, wx + 8, 36], start=210, end=330, fill=icon_color, width=2)
    draw.arc([wx - 5, 24, wx + 5, 34], start=210, end=330, fill=icon_color, width=2)
    draw.ellipse([wx - 2, 34, wx + 2, 37], fill=icon_color)
    
    # Battery Pill
    bat_x = width - 48
    bat_y = 22
    draw.rounded_rectangle([bat_x, bat_y, bat_x + 25, bat_y + 13], radius=3, outline=icon_color, width=2)
    draw.rounded_rectangle([bat_x + 26, bat_y + 3, bat_x + 28, bat_y + 9], radius=1, fill=icon_color)
    draw.rounded_rectangle([bat_x + 2, bat_y + 2, bat_x + 19, bat_y + 11], radius=2, fill=icon_color)
    
    return status

def generate_clean_screen(screen_path, is_light=False, time_str="1:22"):
    if not os.path.exists(screen_path):
        raise FileNotFoundError(f"Source screenshot not found: {screen_path}")

    img = Image.open(screen_path).convert("RGBA")
    w, h = img.size
    
    if not is_light:
        # Inpaint status bar area
        try:
            foliage_patch_left = img.crop((180, 10, 180 + 160, 48))
            img.paste(foliage_patch_left, (10, 10))
            
            foliage_patch_right = img.crop((190, 10, 190 + 135, 48))
            img.paste(foliage_patch_right, (315, 10))
        except Exception:
            bg_col = img.getpixel((w // 2, 10))
            draw_top = ImageDraw.Draw(img)
            draw_top.rectangle([0, 0, w, 52], fill=bg_col)
    else:
        bg_col = img.getpixel((w // 2, 20))
        draw_top = ImageDraw.Draw(img)
        draw_top.rectangle([0, 0, w, 52], fill=bg_col)
        
    # Dynamic Island
    di_w = 126
    di_h = 32
    di_rad = 16
    di_x = (w - di_w) // 2
    di_y = 11
    
    draw_s = ImageDraw.Draw(img)
    draw_s.rounded_rectangle([di_x, di_y, di_x + di_w, di_y + di_h], radius=di_rad, fill=(0, 0, 0, 255))
    
    # Camera lens inside Dynamic Island
    cam_rad = 5
    cam_x = di_x + di_w - 24
    cam_y = di_y + di_h // 2
    draw_s.ellipse([cam_x - cam_rad, cam_y - cam_rad, cam_x + cam_rad, cam_y + cam_rad], fill=(12, 16, 28, 255))
    draw_s.ellipse([cam_x - 2, cam_y - 2, cam_x + 2, cam_y + 2], fill=(28, 44, 76, 255))
    draw_s.ellipse([cam_x + 1, cam_y - 1, cam_x + 2, cam_y], fill=(140, 180, 240, 180)) # lens glint
    
    # FaceID sensor
    sens_rad = 3
    sens_x = di_x + 24
    sens_y = di_y + di_h // 2
    draw_s.ellipse([sens_x - sens_rad, sens_y - sens_rad, sens_x + sens_rad, sens_y + sens_rad], fill=(8, 10, 16, 255))
    
    # Overlay status bar
    st_bar = render_ios_status_bar(w, 56, is_dark_bg=(not is_light), time_text=time_str)
    img.paste(st_bar, (0, 0), mask=st_bar)
    
    return img

def render_framed_phone(clean_screen, output_path=None):
    s_w, s_h = clean_screen.size # 458, 1024
    
    # Frame geometry
    bezel_w = 14
    phone_w = s_w + bezel_w * 2 # 486
    phone_h = s_h + bezel_w * 2 # 1052
    outer_rad = 54
    inner_rad = 40
    
    pad_x = 36
    pad_y = 36
    canvas_w = phone_w + pad_x * 2
    canvas_h = phone_h + pad_y * 2
    
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    
    # 1. Soft multi-layer shadow
    s_mask1 = Image.new("L", (canvas_w, canvas_h), 0)
    sd1 = ImageDraw.Draw(s_mask1)
    sd1.rounded_rectangle([pad_x, pad_y + 16, pad_x + phone_w, pad_y + phone_h + 16], radius=outer_rad, fill=130)
    s1 = s_mask1.filter(ImageFilter.GaussianBlur(28))
    s1_rgba = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    s1_rgba.putalpha(s1)
    canvas = Image.alpha_composite(canvas, s1_rgba)
    
    s_mask2 = Image.new("L", (canvas_w, canvas_h), 0)
    sd2 = ImageDraw.Draw(s_mask2)
    sd2.rounded_rectangle([pad_x, pad_y + 6, pad_x + phone_w, pad_y + phone_h + 6], radius=outer_rad, fill=160)
    s2 = s_mask2.filter(ImageFilter.GaussianBlur(12))
    s2_rgba = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    s2_rgba.putalpha(s2)
    canvas = Image.alpha_composite(canvas, s2_rgba)
    
    # 2. Side Buttons
    btn_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    bdraw = ImageDraw.Draw(btn_layer)
    bw = 4
    
    # Left: Action, Vol Up, Vol Down
    act_y = pad_y + 130
    act_h = 32
    bdraw.rounded_rectangle([pad_x - bw, act_y, pad_x + 2, act_y + act_h], radius=3, fill=(35, 42, 54, 255), outline=(70, 80, 100, 255), width=1)
    
    v1_y = act_y + act_h + 18
    v1_h = 58
    bdraw.rounded_rectangle([pad_x - bw, v1_y, pad_x + 2, v1_y + v1_h], radius=3, fill=(35, 42, 54, 255), outline=(70, 80, 100, 255), width=1)
    
    v2_y = v1_y + v1_h + 14
    v2_h = 58
    bdraw.rounded_rectangle([pad_x - bw, v2_y, pad_x + 2, v2_y + v2_h], radius=3, fill=(35, 42, 54, 255), outline=(70, 80, 100, 255), width=1)
    
    # Right: Power
    pwr_y = pad_y + 180
    pwr_h = 85
    bdraw.rounded_rectangle([pad_x + phone_w - 2, pwr_y, pad_x + phone_w + bw, pwr_y + pwr_h], radius=3, fill=(35, 42, 54, 255), outline=(70, 80, 100, 255), width=1)
    
    canvas = Image.alpha_composite(canvas, btn_layer)
    
    # 3. Titanium Chassis Body
    body = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    bddraw = ImageDraw.Draw(body)
    
    bx0, by0 = pad_x, pad_y
    bx1, by1 = pad_x + phone_w, pad_y + phone_h
    
    # Outer dark titanium bezel
    bddraw.rounded_rectangle([bx0, by0, bx1, by1], radius=outer_rad, fill=(18, 22, 30, 255), outline=(75, 85, 105, 255), width=2)
    bddraw.rounded_rectangle([bx0 + 2, by0 + 2, bx1 - 2, by1 - 2], radius=outer_rad - 2, outline=(8, 12, 18, 255), width=2)
    
    # Screen Mask
    screen_mask = Image.new("L", (s_w, s_h), 0)
    smask_d = ImageDraw.Draw(screen_mask)
    smask_d.rounded_rectangle([0, 0, s_w, s_h], radius=inner_rad, fill=255)
    
    # Screen with corner rounding
    screen_comp = clean_screen.copy()
    # Subtle glass glare
    glare = Image.new("RGBA", (s_w, s_h), (0, 0, 0, 0))
    gldraw = ImageDraw.Draw(glare)
    gldraw.polygon([(0, 0), (s_w, 0), (s_w, int(s_h * 0.35)), (0, int(s_h * 0.12))], fill=(255, 255, 255, 10))
    screen_comp.paste(glare, (0, 0), mask=glare)
    
    body.paste(screen_comp, (bx0 + bezel_w, by0 + bezel_w), mask=screen_mask)
    
    # Inner border line around screen
    bddraw.rounded_rectangle([bx0 + bezel_w, by0 + bezel_w, bx0 + bezel_w + s_w, by0 + bezel_w + s_h], radius=inner_rad, outline=(12, 15, 22, 255), width=2)
    
    canvas = Image.alpha_composite(canvas, body)
    
    if output_path:
        canvas.save(output_path, "PNG", optimize=True)
        print(f"Saved {output_path}")
    
    return canvas

def generate_all_assets(input_dir):
    os.makedirs(WEBSITE_SCREENSHOTS_DIR, exist_ok=True)

    map_screen = os.path.join(input_dir, "media_1787822921136.png")
    market_screen = os.path.join(input_dir, "media_1787822758457.png")
    offer_screen = os.path.join(input_dir, "media_1787822910684.png")
    ledger_screen = os.path.join(input_dir, "media_1787822767761.png")
    trust_screen = os.path.join(input_dir, "media_1787822915872.png")
    
    print("Generating individual phone mockups...")
    clean_map = generate_clean_screen(map_screen, is_light=False, time_str="1:22")
    phone_map = render_framed_phone(clean_map, os.path.join(WEBSITE_SCREENSHOTS_DIR, "phone_map.png"))
    
    clean_market = generate_clean_screen(market_screen, is_light=False, time_str="1:23")
    phone_market = render_framed_phone(clean_market, os.path.join(WEBSITE_SCREENSHOTS_DIR, "phone_marketplace.png"))
    
    clean_offer = generate_clean_screen(offer_screen, is_light=True, time_str="1:24")
    phone_offer = render_framed_phone(clean_offer, os.path.join(WEBSITE_SCREENSHOTS_DIR, "phone_offer.png"))
    
    clean_ledger = generate_clean_screen(ledger_screen, is_light=False, time_str="1:25")
    phone_ledger = render_framed_phone(clean_ledger, os.path.join(WEBSITE_SCREENSHOTS_DIR, "phone_ledger.png"))
    
    clean_trust = generate_clean_screen(trust_screen, is_light=True, time_str="1:26")
    phone_trust = render_framed_phone(clean_trust, os.path.join(WEBSITE_SCREENSHOTS_DIR, "phone_trust.png"))
    
    # Update dashboard and marketplace single images
    phone_map.save(os.path.join(WEBSITE_SCREENSHOTS_DIR, "dashboard.png"), "PNG", optimize=True)
    phone_market.save(os.path.join(WEBSITE_SCREENSHOTS_DIR, "marketplace.png"), "PNG", optimize=True)
    
    print("Generating 4-phone showcase composite image...")
    # Composite showcase dimensions
    comp_w = 2000
    comp_h = 960
    
    # Scale phones for 4-phone layout
    scale = 0.72
    new_w = int(phone_map.width * scale) # ~401
    new_h = int(phone_map.height * scale) # ~809
    
    phones = [
        phone_map.resize((new_w, new_h), Image.Resampling.LANCZOS),
        phone_market.resize((new_w, new_h), Image.Resampling.LANCZOS),
        phone_offer.resize((new_w, new_h), Image.Resampling.LANCZOS),
        phone_ledger.resize((new_w, new_h), Image.Resampling.LANCZOS)
    ]
    
    comp = Image.new("RGBA", (comp_w, comp_h), (5, 9, 17, 255))
    
    # 1. Subtle radial gradient ambient backlights
    glow_layer = Image.new("RGBA", (comp_w, comp_h), (0, 0, 0, 0))
    g_draw = ImageDraw.Draw(glow_layer)
    # Emerald glow on left/center
    g_draw.ellipse([200, 100, 1100, 850], fill=(16, 185, 129, 32))
    # Amber/orange glow near center
    g_draw.ellipse([800, 120, 1400, 800], fill=(245, 158, 11, 20))
    # Blue/indigo glow on right
    g_draw.ellipse([1100, 100, 1850, 850], fill=(59, 130, 246, 28))
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(130))
    comp = Image.alpha_composite(comp, glow_layer)
    
    # 2. Position the 4 phones evenly
    total_phones_w = 4 * new_w
    spacing = (comp_w - total_phones_w - 140) // 3
    start_x = 70
    start_y = 60

    # Frosted cards behind each phone
    for i in range(4):
        px = start_x + i * (new_w + spacing)
        card_pad = 18
        cx0 = px - card_pad
        cy0 = start_y - card_pad + 25
        cx1 = px + new_w + card_pad
        cy1 = start_y + new_h + card_pad
        
        c_mask = Image.new("RGBA", (comp_w, comp_h), (0, 0, 0, 0))
        cdraw = ImageDraw.Draw(c_mask)
        cdraw.rounded_rectangle([cx0, cy0, cx1, cy1], radius=32, fill=(15, 23, 42, 130), outline=(255, 255, 255, 30), width=1)
        comp = Image.alpha_composite(comp, c_mask)

    # Paste phones onto composite
    for i, phone in enumerate(phones):
        px = start_x + i * (new_w + spacing)
        comp.paste(phone, (px, start_y), mask=phone)

    composite_output_path = os.path.join(WEBSITE_SCREENSHOTS_DIR, "mockup_composite.png")
    comp.save(composite_output_path, "PNG", optimize=True)
    print(f"Generated {composite_output_path} ({comp.size})")
    print(f"Generated {composite_output_path} ({comp.size})")

def parse_args():
    parser = argparse.ArgumentParser(description="Generate device mockups for BeanPool website.")
    default_dir = os.environ.get(
        "BEANPOOL_SCREENSHOT_DIR",
        os.path.join(REPO_ROOT, "apps", "website", "assets", "raw_screenshots")
    )
    if not os.path.exists(default_dir) and os.path.exists(DEFAULT_FALLBACK_DIR):
        default_dir = DEFAULT_FALLBACK_DIR

    parser.add_argument(
        "--input-dir",
        default=default_dir,
        help="Path to directory containing source raw screenshots",
    )
    return parser.parse_args()

if __name__ == "__main__":
    args = parse_args()
    generate_all_assets(args.input_dir)
