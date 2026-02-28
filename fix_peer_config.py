import os
import re

directory = r"c:\Users\Sports Investments\Downloads\paintball-manager-main\paintball-manager-main"

files_to_check = [
    "vmix_bg.html", "streaming.html", "pit.html", 
    "obs_bar.html", "ledwall.html", "board.html", "control.html",
    "index.html", "referee.html"
]

target_code_to_remove = r"""\s*(const|let)\s+peerConfig\s*=\s*\{\s*config:\s*\{\s*'iceServers':\s*\[\s*\{\s*urls:\s*'stun:stun\.l\.google\.com:19302'\s*\},[\s\S]*?\]\s*\}\s*\};\s*"""

for filename in files_to_check:
    filepath = os.path.join(directory, filename)
    if not os.path.exists(filepath):
        continue
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Find the peerConfig variable and remove it
    new_content = re.sub(target_code_to_remove, '\n        ', content)
    
    # Replace `new Peer(peerConfig)` with `new Peer()`
    new_content = re.sub(r'new Peer\(peerConfig\)', 'new Peer()', new_content)
    # Replace `new Peer(targetId, peerConfig)` with `new Peer(targetId)`
    new_content = re.sub(r'new Peer\(([^,]+),\s*peerConfig\)', r'new Peer(\1)', new_content)

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f"Reverted in {filename}")
