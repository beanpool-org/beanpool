from PIL import Image
import os

source_path = "/Users/marty/projects/beanpool/apps/native/assets/images/reddit-avatar-transparent.png"

# Target files with their corresponding sizes
targets = [
    # Website
    ("/Users/marty/projects/beanpool/apps/website/bean.png", 512),
    
    # PWA public
    ("/Users/marty/projects/beanpool/apps/pwa/public/bean.png", 512),
    ("/Users/marty/projects/beanpool/apps/pwa/public/logo.png", 512),
    ("/Users/marty/projects/beanpool/apps/pwa/public/assets/bean.png", 512),
    ("/Users/marty/projects/beanpool/apps/pwa/public/assets/logo-192x192.png", 192),
    ("/Users/marty/projects/beanpool/apps/pwa/public/assets/logo-full.png", 512),
    
    # Server public
    ("/Users/marty/projects/beanpool/apps/server/public/bean.png", 512),
    ("/Users/marty/projects/beanpool/apps/server/public/logo.png", 512),
    ("/Users/marty/projects/beanpool/apps/server/public/assets/bean.png", 512),
    
    # Native assets
    ("/Users/marty/projects/beanpool/apps/native/assets/images/bean.png", 512),
    ("/Users/marty/projects/beanpool/apps/native/assets/images/logo.png", 512),
    
    # Branding
    ("/Users/marty/projects/beanpool/branding/bean-icon.png", 512),
    ("/Users/marty/projects/beanpool/branding/logo-full.png", 512),
    ("/Users/marty/projects/beanpool/branding/bean-icon-16x16.png", 16),
    ("/Users/marty/projects/beanpool/branding/bean-icon-32x32.png", 32),
    ("/Users/marty/projects/beanpool/branding/bean-icon-48x48.png", 48),
    ("/Users/marty/projects/beanpool/branding/bean-icon-64x64.png", 64),
    ("/Users/marty/projects/beanpool/branding/bean-icon-128x128.png", 128),
    ("/Users/marty/projects/beanpool/branding/bean-icon-192x192.png", 192),
    ("/Users/marty/projects/beanpool/branding/bean-icon-256x256.png", 256),
    ("/Users/marty/projects/beanpool/branding/bean-icon-512x512.png", 512),
    ("/Users/marty/projects/beanpool/branding/logo-64x64.png", 64),
    ("/Users/marty/projects/beanpool/branding/logo-128x128.png", 128),
    ("/Users/marty/projects/beanpool/branding/logo-192x192.png", 192),
    ("/Users/marty/projects/beanpool/branding/logo-256x256.png", 256),
    ("/Users/marty/projects/beanpool/branding/logo-512x512.png", 512),
]

def regenerate():
    img = Image.open(source_path)
    for path, size in targets:
        # Create parent dir if it doesn't exist
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Resize image using LANCZOS for high quality downscaling
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        # Save to target path
        resized.save(path, "PNG")
        print(f"✅ Generated {size}x{size} -> {path}")

if __name__ == "__main__":
    regenerate()
