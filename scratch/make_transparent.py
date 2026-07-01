from PIL import Image, ImageDraw

def make_transparent(source_path, dest_path_1024, dest_path_32):
    # Load image and convert to RGBA
    img = Image.open(source_path).convert("RGBA")
    width, height = img.size
    
    # Bounding box of the green ring detected earlier was: [48, 40, 975, 977]
    # Center of the ring is at:
    cx = (48 + 975) / 2.0  # 511.5
    cy = (40 + 977) / 2.0  # 508.5
    
    # Outer radius of the ring including its glow is roughly 470px.
    # We will use a smooth anti-aliased transition between 467px and 471px.
    r_inner = 467.0
    r_outer = 471.0
    
    pixels = img.load()
    for y in range(height):
        for x in range(width):
            dx = x - cx
            dy = y - cy
            dist = (dx*dx + dy*dy) ** 0.5
            
            if dist > r_outer:
                # Fully transparent outside the ring
                pixels[x, y] = (0, 0, 0, 0)
            elif dist > r_inner:
                # Smooth linear alpha transition for anti-aliasing
                alpha = int(255 * (r_outer - dist) / (r_outer - r_inner))
                r, g, b, _ = pixels[x, y]
                pixels[x, y] = (r, g, b, alpha)
            else:
                # Inside the ring, keep original pixel intact
                pass
                
    # Save the high-res 1024x1024 transparent version
    img.save(dest_path_1024, "PNG")
    print(f"Saved 1024x1024 transparent version to: {dest_path_1024}")
    
    # Resize and save the 32x32 favicon version
    # Using Resampling.LANCZOS for high-quality downscaling
    fav_img = img.resize((32, 32), Image.Resampling.LANCZOS)
    fav_img.save(dest_path_32, "PNG")
    print(f"Saved 32x32 transparent favicon to: {dest_path_32}")

if __name__ == "__main__":
    make_transparent(
        "/Users/marty/projects/beanpool/apps/native/assets/images/reddit-avatar.png",
        "/Users/marty/projects/beanpool/apps/native/assets/images/reddit-avatar-transparent.png",
        "/Users/marty/projects/beanpool/apps/native/assets/images/favicon.png"
    )
