import os

html_files = [
    "apps/website/index.html",
    "apps/website/privacy.html",
    "apps/website/safety.html",
    "apps/website/terms.html"
]

replacements = {
    # Favicon link
    "<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='28' font-size='28'>🫘</text></svg>\">": 
    "<link rel=\"icon\" type=\"image/png\" href=\"favicon.png\">",
    
    # Also handle index.html version with single quotes
    "<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'><text y=\'28\' font-size=\'28\'>🫘</text></svg>\">":
    "<link rel=\"icon\" type=\"image/png\" href=\"favicon.png\">",

    # Header logo links
    "class=\"logo\">🫘 <span>BeanPool</span></a>": 
    "class=\"logo\"><img src=\"bean.png\" alt=\"BeanPool Icon\" style=\"width: 32px; height: 32px; object-fit: contain; vertical-align: middle; margin-right: 0.1rem;\" /> <span>BeanPool</span></a>",
    
    # Footer logo links
    "class=\"logo\">🫘 BeanPool</span>": 
    "class=\"logo\"><img src=\"bean.png\" alt=\"BeanPool Icon\" style=\"width: 32px; height: 32px; object-fit: contain; vertical-align: middle; margin-right: 0.1rem;\" /> BeanPool</span>",
    
    # Made with bean in footer
    "Made with 🫘 by communities": 
    "Made with <img src=\"bean.png\" alt=\"love\" style=\"width: 16px; height: 16px; object-fit: contain; vertical-align: middle; margin: 0 0.1rem;\" /> by communities",
    
    # Feature icons in index.html
    "<div class=\"feature-icon\">🫘</div>": 
    "<div class=\"feature-icon\"><img src=\"bean.png\" alt=\"BeanPool Icon\" style=\"width: 42px; height: 42px; object-fit: contain; vertical-align: middle;\" /></div>",
    
    # Staying in the loop title in index.html
    "<h3>🫘 Stay in the Loop</h3>": 
    "<h3><img src=\"bean.png\" alt=\"Icon\" style=\"width: 24px; height: 24px; object-fit: contain; vertical-align: middle; margin-right: 0.4rem; margin-top: -4px;\" />Stay in the Loop</h3>"
}

for path in html_files:
    if not os.path.exists(path):
        print(f"⚠️ Warning: File not found {path}")
        continue
        
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
        
    orig_content = content
    for old, new in replacements.items():
        content = content.replace(old, new)
        
    if content != orig_content:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"✅ Updated {path}")
    else:
        print(f"ℹ️ No changes needed for {path}")
