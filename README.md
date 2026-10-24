# roomba-profiler

Watch an iRobot Roomba's local MQTT traffic live in a web page, control it, and open the
recording in the [Firefox Profiler](https://profiler.firefox.com).

Tested with a Roomba i3+ (firmware `daredevil+2.6.0`). It reports its state but not its position.

## Setup

1. Find the robot and get its password (hold Home on the robot for 2 s while the script waits):
   ```
   python3 -m venv .venv && .venv/bin/pip install 'roombapy[cli]'
   .venv/bin/roombapy discover            # IP and BLID
   .venv/bin/python scripts/getpw.py <ip> > password.txt
   ```
2. Run the server and open http://localhost:8980:
   ```
   cd app && npm install
   node server.js <ip> <blid> ../password.txt
   ```

The robot accepts a single local connection: nothing else can connect locally while the
server runs. All traffic is appended to `traffic.jsonl`; the page's "Open in Firefox
Profiler" button turns it into a profile. Packet markers contain the robot's identifiers
(BLID, MAC and IP addresses), so check before sharing a profile.

`app/robot-strings.json` (error messages) comes from [roombapy](https://github.com/pschmitt/roombapy).
