import os
import re

ice_servers_code = """const peerConfig = {
    config: {
        'iceServers': [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.relay.metered.ca:80' },
            { urls: 'turn:global.relay.metered.ca:80', username: 'fe841146f64ad98d3f631f65', credential: '1RWiOOZ7GOYCgcBw' },
            { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'fe841146f64ad98d3f631f65', credential: '1RWiOOZ7GOYCgcBw' },
            { urls: 'turn:global.relay.metered.ca:443', username: 'fe841146f64ad98d3f631f65', credential: '1RWiOOZ7GOYCgcBw' },
            { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'fe841146f64ad98d3f631f65', credential: '1RWiOOZ7GOYCgcBw' }
        ]
    }
};"""

directory = r"c:\Users\Sports Investments\Downloads\paintball-manager-main\paintball-manager-main"

files_to_check = [
    "vmix_bg.html", "streaming.html", "pit.html", 
    "obs_bar.html", "ledwall.html", "board.html", "control.html"
]

for filename in files_to_check:
    filepath = os.path.join(directory, filename)
    if not os.path.exists(filepath):
        continue
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Replacing `const peer = new Peer();` or `peer = new Peer();`
    # Also handles `peer = new Peer(targetId);` for control.html
    if 'peerConfig =' not in content:
        content = re.sub(
            r'const peer = new Peer\(\);',
            f'{ice_servers_code}\n    const peer = new Peer(peerConfig);',
            content
        )
        content = re.sub(
            r'(\s+)peer = new Peer\(\);',
            f'\\1{ice_servers_code.replace("const peerConfig", "const peerConfig").replace(chr(10), chr(10) + "    ")}\n\\1peer = new Peer(peerConfig);',
            content
        )
        content = re.sub(
            r'(\s+)peer = new Peer\(targetId\);',
            f'\\1{ice_servers_code.replace("const peerConfig", "const peerConfig").replace(chr(10), chr(10) + "    ")}\n\\1peer = new Peer(targetId, peerConfig);',
            content
        )
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Updated {filename}")
    else:
        print(f"Skipped {filename}, already has peerConfig")
