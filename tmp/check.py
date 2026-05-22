import re, glob, os
os.chdir(os.path.expanduser("~/workspace"))
for f in sorted(glob.glob("**/*.mdx", recursive=True)):
    if "release-notes" in f or "node_modules" in f: continue
    txt = open(f).read()
    txt = re.sub(r"```.*?```", "", txt, flags=re.S)
    txt = re.sub(r"`[^`]+`", "X", txt)
    txt = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", txt)
    txt = re.sub(r"^---.*?---", "", txt, count=1, flags=re.S)
    txt = re.sub(r"<[^>]+>", "", txt)
    for para in txt.split("\n\n"):
        for sent in re.split(r"(?<=[.!?])\s+", para.strip()):
            sent_clean = re.sub(r"\s+", " ", sent).strip()
            words = re.findall(r"\w+", sent_clean)
            if len(words) > 35 and not sent_clean.startswith(("-","#","*","|")):
                print(f"{f} ({len(words)}w): {sent_clean[:240]}")
                print()
