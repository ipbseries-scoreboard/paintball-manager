import http.server
import json
import os
import subprocess
import time

# --- CONFIGURATION ---
PORT = 5000
STATE_FILE = "state.json"
AUTO_GIT_PUSH = True  # Set to True to auto-commit and push to GitHub
GIT_COMMIT_INTERVAL = 10 # Minimum seconds between git pushes

last_push_time = 0

class SyncHandler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        global last_push_time
        if self.path == '/update':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            
            try:
                # Validate JSON
                data = json.loads(post_data.decode('utf-8'))
                
                # Save to local file
                with open(STATE_FILE, 'w', encoding='utf-8') as f:
                    json.dump(data, f, indent=4)
                
                print(f"[{time.strftime('%H:%M:%S')}] State updated locally.")

                # Optional Git Push
                if AUTO_GIT_PUSH and (time.time() - last_push_time > GIT_COMMIT_INTERVAL):
                    print("Pushing to GitHub...")
                    try:
                        subprocess.run(["git", "add", STATE_FILE], check=True)
                        subprocess.run(["git", "commit", "-m", "Manual Cloud Sync Update"], check=False)
                        # We use a background push to not block the HTTP response
                        subprocess.Popen(["git", "push"])
                        last_push_time = time.time()
                        print("Git push initiated.")
                    except Exception as ge:
                        print(f"Git Error: {ge}")

                self.send_response(200)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(b'{"status": "ok"}')
            except Exception as e:
                print(f"Error: {e}")
                self.send_response(500)
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(b"Cloud Sync Bridge is running on port 5000")
        else:
            self.send_response(404)
            self.end_headers()

def run():
    print(f"Starting Cloud Sync Bridge on port {PORT}...")
    print(f"Local state will be saved to: {os.path.abspath(STATE_FILE)}")
    if AUTO_GIT_PUSH:
        print("Auto-Git Push is ENABLED.")
    
    server_address = ('', PORT)
    httpd = http.server.HTTPServer(server_address, SyncHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()

if __name__ == "__main__":
    run()
