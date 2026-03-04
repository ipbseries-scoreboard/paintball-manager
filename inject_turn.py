import os
import re

directory = r"c:\Users\Sports Investments\Downloads\paintball-manager-main\paintball-manager-main"

files_to_check = [
    "index.html", "referee.html", "streaming.html", "pit.html",
    "vmix_bg.html", "obs_bar.html", "ledwall.html", "board.html"
]

peer_config_code = """const customIceConfig = {
    config: {
        'iceServers': [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ]
    }
};"""

for filename in files_to_check:
    filepath = os.path.join(directory, filename)
    if not os.path.exists(filepath):
        continue
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Skip if customIceConfig is already present
    if 'customIceConfig' in content:
        print(f"Skipping {filename}, already processed.")
        continue

    # 1) index.html -> peer = new Peer(targetId);
    content = re.sub(
        r'peer = new Peer\((targetId)\);',
        f'{peer_config_code}\n                peer = new Peer(\\1, customIceConfig);',
        content
    )

    # 2) peer = new Peer(); (referee, pit, etc) -> indentation matters for formatting but let's just replace
    content = re.sub(
        r'(\s+)peer = new Peer\(\);',
        f'\\1{peer_config_code.replace(chr(10), chr(10) + "    ")}\n\\1peer = new Peer(customIceConfig);',
        content
    )

    # 3) const peer = new Peer(); (board, streaming, ledwall, vmix_bg)  
    content = re.sub(
        r'(\s+)const peer = new Peer\(\);',
        f'\\1{peer_config_code.replace(chr(10), chr(10) + "    ")}\n\\1const peer = new Peer(customIceConfig);',
        content
    )

    # 4) obs_bar -> const peer = new Peer(); // Auto-generate
    content = re.sub(
        r'(\s+)const peer = new Peer\(\);\s*// Auto-generate ID(.*)',
        f'\\1{peer_config_code.replace(chr(10), chr(10) + "    ")}\n\\1const peer = new Peer(customIceConfig); // Auto-generate ID\\2',
        content
    )

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Updated {filename}")
