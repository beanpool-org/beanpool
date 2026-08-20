import re

def fix_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Add import to community.ts
    pattern = r"import \{\n    getLocalConfig,\n"
    replacement = "import { checkAdminAuth } from '../admin-auth.js';\nimport {\n    getLocalConfig,\n"
    content = re.sub(pattern, replacement, content)

    with open(filepath, 'w') as f:
        f.write(content)

fix_file('apps/server/src/routes/community.ts')

def fix_settings(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    pattern = r"import \{\n    getLocalConfig, saveLocalConfig, updateLocalConfig, initAdminPassword,\n"
    replacement = "import { checkAdminAuth } from '../admin-auth.js';\nimport {\n    getLocalConfig, saveLocalConfig, updateLocalConfig, initAdminPassword,\n"
    content = re.sub(pattern, replacement, content)

    with open(filepath, 'w') as f:
        f.write(content)

fix_settings('apps/server/src/routes/settings.ts')
