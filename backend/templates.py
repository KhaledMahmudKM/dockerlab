"""Starting points for the Build image dialog. Each is an editable Dockerfile.

All start from Alpine, which is small (a few MB) and has a large package collection.
Packages are installed when the image is *built*, so every container made from it
starts with them, with no download at startup and no internet needed then.
"""

ROUTER = """\
FROM alpine:latest

# Networking tools for a gateway or router
RUN apk add --no-cache iproute2 iptables tcpdump bind-tools curl iputils

# nat-on: masquerade traffic leaving through the NAT interface (nat0).
# Safe to run more than once; use it in startup commands.
RUN printf '%s\\n' '#!/bin/sh' \\
      'iptables -t nat -C POSTROUTING -o nat0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -o nat0 -j MASQUERADE' \\
      > /usr/local/bin/nat-on && chmod +x /usr/local/bin/nat-on
"""

HOST = """\
FROM alpine:latest

# Everyday tools for an end host: full ip, packet capture, DNS lookups, web requests
RUN apk add --no-cache iproute2 tcpdump bind-tools curl iputils
"""

BLANK = """\
FROM alpine:latest

# Add packages with: RUN apk add --no-cache <package> ...
"""

TEMPLATES = [
    {"id": "router", "name": "Router", "tag": "dockerlab/router:latest", "dockerfile": ROUTER,
     "description": "iptables, iproute2, tcpdump, dig, curl and ping, plus a nat-on command for gateways."},
    {"id": "host", "name": "Host", "tag": "dockerlab/host:latest", "dockerfile": HOST,
     "description": "iproute2, tcpdump, dig, curl and ping for end hosts."},
    {"id": "blank", "name": "Blank", "tag": "dockerlab/custom:latest", "dockerfile": BLANK,
     "description": "Plain Alpine to add your own packages to."},
]
