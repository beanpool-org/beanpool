import re
import sys

def verify_lines(diff_file):
    with open(diff_file, 'r') as f:
        lines = f.readlines()

    current_file = None
    hunks = []
    
    for line in lines:
        if line.startswith("diff --git"):
            m = re.search(r"b/(.+)$", line)
            if m:
                current_file = m.group(1).strip()
        elif line.startswith("@@"):
            m = re.search(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", line)
            if m:
                new_start = int(m.group(1))
                hunks.append((current_file, new_start, []))
        elif hunks:
            hunks[-1][2].append(line)

    return hunks

hunks = verify_lines("scratch/pr123.diff")
print(f"Total hunks parsed: {len(hunks)}")
