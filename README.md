# DockerLab

A GNS3-style lab builder for Docker containers. Drag images onto a bench, cable them together, set addresses, ports, volumes, environment and startup commands, then deploy. Open a console on any container in the browser, and capture any cable in Wireshark with one click. The app runs on your Windows PC; the containers run on the Docker engine inside a Linux VM, the *Docker host*.

```
Windows PC                               Docker host VM (VirtualBox)
+---------------------------+    SSH    +-----------------------------+
| browser --> DockerLab     | --------> | Docker engine               |
| http://127.0.0.1:8000     |           |  dl-<lab>-<node> containers |
| (FastAPI + docker SDK)    |           |  one bridge per cable       |
+---------------------------+           +-----------------------------+
```

## 1. Prepare the Docker host VM (once)

The Docker host is a Linux VM in VirtualBox, such as the Debian 13 VM that comes with the course. Any Linux VM works if it has Docker, an SSH server and `sudo`; the GNS3 VM does too.

1. Import the VM and start it. Its network adapter must be on the VirtualBox **host-only** network, or Windows can't reach it. It gets its address there by DHCP, so the address can differ from one PC to another: the VM shows it on its console (e.g. `192.168.56.103`).
2. That's all: DockerLab sets up the rest the first time it connects (below). The VM's Docker version is shown once connected. **Fixed interface names (eth0, eth1, nat0) need Docker 28 or newer.** On an older engine everything else works, but Docker picks the names; the bench then shows the real names, and startup commands that name interfaces need adjusting.

## 2. Run DockerLab on Windows

Needs Python 3.10 or newer.

In **PowerShell** (the default in Windows Terminal):

```powershell
cd backend
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

Open http://127.0.0.1:8000.

### Connecting to the Docker host

DockerLab starts without connecting. Press **Connect…** in the Docker Host pane at the top left, enter the VM's address (from its console) and its user, and press **Connect**. On a fresh VM, two questions follow, once each:

1. **Trust the host's key.** DockerLab shows the VM's SSH key fingerprint, like `ssh` does the first time. Trust it, and it's saved in your `known_hosts`. If the key ever changes (for example after re-importing the VM), DockerLab says so, in red, and asks before replacing it.
2. **The user's password, once.** DockerLab logs in with it to install your SSH key (creating `~/.ssh/id_ed25519` if you have none), adds the user to the `docker` group if needed, and, with *Also allow packet capture* ticked, adds a sudo rule so `tcpdump` and `iptables` run without a password (in `/etc/sudoers.d/dockerlab`). The password isn't stored; from then on, DockerLab logs in with the key.

DockerLab remembers the host (in `~/.dockerlab/settings.json`), so next time the Connect dialog is already filled in, and recent hosts are one click away. It connects only when you press **Connect**, unless you tick *Connect to it automatically when DockerLab starts*. Since the VM's address comes from DHCP, check it on the VM's console if connecting fails after a restart. The **Docker Host** pane at the top left shows the connection, e.g. *Docker 29.6.2 on 192.168.56.103*. DockerLab checks it on its own, and notices within a few seconds if the VM is switched off or unreachable; **Retry** checks again once you've fixed it, and DockerLab also reconnects by itself when the VM is back. **Change…** to connect elsewhere (recent hosts are one click away) or disconnect, and **Console** for a terminal on the host.

Below that, the pane shows how busy the Docker host is, updated every 5 seconds:

- **CPU**: all of the host's CPUs together (hover for the load average). **RAM**: memory in use, not counting what Linux would free from its caches. The bars turn amber at 70% and red at 90%. If the host runs out of memory and starts swapping, a warning says how much: everything gets slow then, so stop a lab or give the VM more memory.
- **▸ Per container** lists what each running container uses, busiest first, with its lab. Here 100% means one full CPU, so a container can show more on a host with several CPUs. It's measured only while the list is open, because `docker stats` takes a second each time.

The figures come from the host's own counters (`/proc`), read over one SSH connection that stays open, so watching them doesn't log in to the VM every few seconds. With Docker Desktop, Docker runs in a VM DockerLab can't look into, so the load isn't shown. *On this computer* uses a Docker engine on the PC itself, such as Docker Desktop. Switching hosts while labs run asks whether to stop them first.

If you set up key login yourself, nothing is asked. A `DOCKER_HOST` environment variable, if set, still wins at startup, for scripted setups.

If connecting fails, the dialog says why: VM not reachable at that address, password refused, Docker not usable by that user, and so on. If the problem is with SSH itself, setting `DOCKERLAB_SSH_CLIENT=1` makes the app use Windows' own `ssh` command (and your `~/.ssh/config`) instead of the built-in Python SSH client.

If an action fails with `ChannelException(2, 'Connect failed')`, the VM's SSH server refused another session. DockerLab keeps at most 6 sessions on its shared SSH connection (OpenSSH allows 10), plus one connection per open console, so this shouldn't happen; if it does, restart DockerLab.

Security note: anyone who can open DockerLab in a browser can control the Docker host's engine and open a shell on it, as the user DockerLab connects with. With the default `DOCKERLAB_BIND=127.0.0.1` that's only you, on this PC. Think twice before binding to `0.0.0.0`.

Other settings: `DOCKERLAB_KEEP_RUNNING` (set to `1` to leave lab containers running when DockerLab exits), `DOCKERLAB_WIRESHARK` (full path to Wireshark.exe, if it isn't in `C:\Program Files\Wireshark`), `DOCKERLAB_PORT` (default 8000), `DOCKERLAB_BIND` (default `127.0.0.1`; use `0.0.0.0` to let other machines use it), `DOCKERLAB_LABS` (folder where lab files are saved, default `Documents\DockerLab\labs`).

### Where your files are

Your labs are saved in **`Documents\DockerLab\labs`** (one `.json` file per lab), outside the app folder, so updating or reinstalling DockerLab never touches them. Hover over the DockerLab name at the top left to see the exact folder and the version. Versions before 0.9 kept labs in `backend\labs`; the first start of 0.9 copies them over (the originals stay where they were) and says so in Messages. The connection settings (Docker host, recent hosts) are in `.dockerlab\settings.json` in your user folder.

## 3. Using it

- **Add a container:** drag an image from the shelf onto the bench. No images yet? Pull one in *Manage → Images* (type a name like `alpine:3.20`), or build one (below).
- **Add a note:** drag *Note* from the top of the shelf. Double-click it to write on it; drag it to move; drag a corner to resize. Click it to change its colour or edit its text in the right pane. Notes are saved with the lab and ignored by Deploy.
- **Add a switch:** drag *Switch* from the top of the shelf. Every container cabled to it shares one segment (subnet), like a real Ethernet switch.
- **Connect:** hover a container, then drag from one of the small circles on its edge to another container or to a switch.
- **Describe the lab:** write in the *Lab description* pane at the bottom right. It's saved with the lab, for its purpose and tasks.

### Lab descriptions

A lab's description is written in **Markdown** and shown formatted, so it can hold a whole worksheet: headings, tables of addresses, numbered steps, commands, checklists and callouts.

- It has a pane of its own, below Details, so the instructions stay in view while students click containers, open consoles and capture cables. Drag the divider between the two to share the height. Hide the pane with *View*, and the description shows in Details again when nothing is selected.
- **↗** opens it in a browser window of its own, to put beside DockerLab or on a second screen (or a projector). That window follows the lab open in DockerLab, including edits as you type; edit it in the main window.
- **Read** shows it formatted; **Edit** shows the Markdown (double-click the text to switch). **Expand** opens a large window with the Markdown on the left and the result on the right.
- In the editor, Ctrl+B, Ctrl+I and Ctrl+E make the selection bold, italic or `code`. *Markdown*, under the editor, lists the syntax.
- Commands in a fenced block (between two lines of three backticks) get a **Copy** button, so students can paste them into a console.
- Callouts, as on GitHub: a quote that starts with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`:
  ```
  > [!TIP]
  > Capture the cable before you start the ping.
  ```
- A single line break stays a line break, so descriptions written as plain text before 0.9.1 look the same.
- Raw HTML isn't rendered (it shows as text), and links open in a new tab, so a lab file from someone else can't run code in DockerLab.

The example labs' descriptions show what it looks like.
- **Configure a container:** click it to set its name, image, command, interfaces, startup commands, ports, volumes, environment and behaviour.
- **Interfaces:** like a real router, a container can have a fixed number of cable interfaces, e.g. 4. The bench then refuses a fifth cable, the box shows *2 of 4 interfaces*, and the panel lists the free ones (`eth2 free`). Leave it empty for one interface per cable, with no limit. Changing it needs a Redeploy. The internet interface `nat0` isn't counted. Free interfaces exist only on the bench: inside the container, `ip a` shows only cabled ones.
- **Network OS:** for router operating systems that expect their own interface names and set their own addresses, such as Nokia SR Linux. *First interface* names the cable interfaces (`e1-1` gives e1-1, e1-2, …; empty means eth0, eth1, …), *NAT interface* renames `nat0` (SR Linux's management port is `eth0`), *DockerLab sets the addresses* off leaves the cable interfaces unaddressed (also right for DHCP clients), and *Kernel settings* adds sysctls such as `net.ipv6.conf.all.disable_ipv6=0`. Lab `12-ospf-srlinux` uses all four. Turning off *DockerLab sets the addresses* on FRR routers also makes an addressing exercise: the interfaces come up empty, the cable labels show the intended addresses, and students set them in `vtysh` (`interface eth1`, `ip address 10.0.12.1/24`, `write memory`); FRR puts them back at every restart.
- **Configure a cable:** click it to set its subnet and, optionally, a fixed address for each end. Every address is usable, `.1` included.
- **Configure a switch:** click it to set its name and subnet. Its *Ports* list shows every container plugged in, where you can set each one's address, see its interface and current IP, and capture its port. The lights on the switch show one port per cable, green while that container runs.
- **Delete:** select and press Delete.
- **Changes to a deployed lab apply on Redeploy.** Unlike GNS3, where a new cable works at once, Deploy builds each container and network from the lab's settings, so editing the bench doesn't change the running lab. As soon as the bench differs from what's deployed, DockerLab says so:
  - a yellow bar above the bench lists what's not applied yet (changed, new and removed containers, switches and cables), with a **Redeploy** button; the toolbar's Redeploy button gets a yellow dot;
  - containers are marked *Changed: Redeploy to apply* or *New: Redeploy to create*, and new cables are drawn dashed;
  - the right pane of a deployed container, switch or cable says that changes there apply on Redeploy.

  Moving boxes and editing notes or the description don't count. **Startup commands** are the exception: they run at every start, so a change applies the next time the container starts (*Restart* it, or Stop all and Start all), even before you save. Such a container is marked *Startup changed: applies at next start* until then.

Toolbar:

| Button | Does |
|---|---|
| Open, New | open a saved lab, or start an empty, *untitled* bench |
| Import | add a lab from a shared `.dockerlab.json` file (see *Sharing labs*) |
| Close | stops this lab's containers and clears the bench. The containers and lab file are kept, so Open then Start all brings it back |
| Save | saves the lab file |
| Export | downloads the lab as a lab file for another DockerLab, or as a docker-compose file; or the bench as a diagram (SVG or PNG) |
| Deploy / Redeploy | saves, then creates every container and cable from scratch. Use it after changing settings |
| Start all / Stop all | starts or stops the lab's existing containers |
| Remove containers | deletes this lab's containers and networks, keeping the lab file |
| *N labs running* | lists everything running in the VM, grouped by lab, with Open and Stop for each lab (see below) |

### Lab names

A new lab is *untitled* until you save it: the first Save (or Deploy, or Export) asks for its name. Names are letters, digits, dot, dash and underscore. If you pick, or type into the lab name box, the name of another saved lab, DockerLab says so and offers to replace it or choose another name, so a new lab never overwrites one by accident. Names that differ only in capitals (`lab1`, `Lab1`) count as the same lab, as they would be the same file on Windows.

Typing a new name into the box and saving makes a copy under the new name; the old lab stays as it was.

### Panes

The window has seven panes: the top bar and the topology (always shown), and five you can hide with **View** at the top right:

| Pane | Where | Holds |
|---|---|---|
| Docker Host | left, top | the Docker engine's status, Change… and the Console button |
| Add and Images | left, below Docker Host | Switch, Note and the images to drag onto the bench; Manage and Build |
| Messages | under the topology | the message log (below) |
| Details | right, top | settings of the container, switch, cable or note you click |
| Lab description | right, below Details | the lab's description, which stays in view while you click around the topology |

Drag a divider between panes to resize them; double-click it to return to the default size. *Show all panes at their default sizes*, in View, undoes everything. Your choice is remembered in this browser. If an error comes in while Messages is hidden, View gets a red dot, and while an action runs its progress shows in the top bar instead.

### Appearance

**Appearance**, next to View, sets how the topology looks. Changes show at once, so the bench behind the panel is the preview:

- **Size**: containers and switches (text included, 70–180%), cable labels, note text, and cable width.
- **Colours**: container text, background and border; switches; the topology background; and whether the grid dots show.
- **Presets**: *Default*, *Large (projector)* for teaching on a projector, and *High contrast*.

The settings are kept in this browser, not in the lab file, so a lab looks the same to everyone who opens it, each with their own settings. Diagram exports use them too. When notes get a bigger font, drag their corner to make them larger.

Text looking small is usually the zoom rather than the settings: the bench zooms out to fit a wide lab in the window. Use the + button at the bench's bottom right, or the mouse wheel over the bench, to zoom in.

### Messages

Everything DockerLab reports (saves, deploys, errors, connection changes) goes to the **Messages** pane under the bench, with the time it happened. Messages stay there until you press **Clear**, and survive a page reload. While an action runs, the pane's header shows what it's doing.

- Drag the pane's top edge to make it taller or shorter. Click **Messages** to fold it down to one line; while folded, it counts new messages, and an error unfolds it.
- **Copy** puts the whole log on the clipboard, handy for pasting an error into a question.
- The log lives in your browser, so another browser or PC starts with an empty one.

### Labs left running

Containers run in the VM, independently of DockerLab, so DockerLab helps you keep track of them:

- **Switching labs:** if the open lab is running when you Open another lab or press New, DockerLab asks whether to stop it first (*Stop*, *Keep running* or *Cancel*). Several labs can run at once if you choose *Keep running*.
- **Running indicator:** the toolbar button on the right shows how many labs are running. Click it for every running container in the VM, grouped by lab, with *Open* and *Stop* for each lab. Containers that don't belong to DockerLab, such as GNS3's own Docker nodes, are listed under *Outside DockerLab*; DockerLab never stops those.
- **Exiting DockerLab:** pressing Ctrl+C in DockerLab's window stops every DockerLab container in the VM before it quits, and prints what it stopped. Set `DOCKERLAB_KEEP_RUNNING=1` to leave them running instead. Closing the window with its X button may not leave enough time to stop them, so prefer Ctrl+C. If the VM is already off or unreachable, DockerLab says so and quits within a few seconds, leaving the containers as they are (they're stopped anyway when the VM is).

**Console:** double-click a running container, or click it and press *Console*. A terminal window opens in the browser, running `bash` if the image has it and `sh` otherwise. Open as many as you like. If the container stops, the window says *Disconnected*; press *Reconnect* after starting it again.

**Docker host console:** *Console*, in the Docker Host pane at the top left, opens a terminal on the machine running Docker (the VM), logged in as the user DockerLab connects with. It uses the same SSH login as DockerLab, so it works with the VM running headless. It's there when DockerLab connects over SSH.

**Copy and paste** in any console window: select text and press **Ctrl+C** to copy (with nothing selected, Ctrl+C interrupts as usual). **Ctrl+V** pastes. **Right-click** copies the selection, or pastes when nothing is selected. Ctrl+Shift+C and Ctrl+Shift+V work too.

**Startup commands** run with `sh` inside the container every time it starts: after Deploy, Start all, or starting a single node. Use them to configure addresses and routes, for example
```
ip route add default via 10.0.1.254
```
The panel lists the node's interface names, and after each run shows whether the commands succeeded, with their output. Commands that haven't finished after 20 seconds are reported as unfinished, so start long-running programs in the background (`my-server &`).

**Capture:** after deploying, click a cable and press *Capture in Wireshark* (for a switch, use *Capture* next to a port). The app runs `ssh <vm> sudo tcpdump` and pipes it into Wireshark on your PC. If it can't, it says why, usually missing SSH key login or sudo rule (if key login works already, DockerLab doesn't ask for the password, so add the rule by hand: on the host, `sudo visudo -f /etc/sudoers.d/dockerlab` and add `<user> ALL=(root) NOPASSWD: /usr/bin/tcpdump, /usr/sbin/tcpdump, /usr/sbin/iptables`). *Run it yourself* shows the same command for Windows **cmd** (not PowerShell 5, which corrupts binary pipes); it stays valid until that container restarts.

Capture listens on a container's *port*: the VM-side end of its virtual cable. On a cable between two containers that sees everything on the cable. On a switch it sees what that one container sends and receives, like a mirror port: broadcasts such as ARP reach every port, but unicast reaches only its destination, so pc3's port won't show pc1 talking to pc2. (Capturing on the Linux bridge itself would miss unicast between its ports entirely.)

**Shell without the app:** `ssh -t <user>@<VM address> docker exec -it dl-<lab>-<node> sh`. The `-t` is required. Containers aren't reachable from Windows by plain `ssh`, because cable networks are internal to the VM.

### Build an image

*Build*, next to *Images* on the shelf, builds an image in the VM from a Dockerfile. Packages are installed once, at build time, so every container made from the image starts with them: no download at startup, and no internet needed then. Pick a starting point, adjust it if you like, and press *Build*:

| Template | Image name | Contains |
|---|---|---|
| Router | `dockerlab/router:latest` | iptables, iproute2, tcpdump, dig, curl, ping, and a `nat-on` command |
| Host | `dockerlab/host:latest` | iproute2, tcpdump, dig, curl, ping |
| Blank | `dockerlab/custom:latest` | plain Alpine, to add your own packages |

The build needs the VM's internet connection and can take a minute. If it fails, the panel shows the error and the build log. The new image appears on the shelf when done. Rebuilding with the same name replaces it; Redeploy a lab to use the new version.

With the Router image, a gateway's startup commands shrink to one line, `nat-on`, which adds the masquerade rule for traffic leaving through `nat0` (safe to run more than once).

### Containers and images on the Docker host

*Manage* and *Build* open as tabs over the topology (*Docker host*, *Build an image*), next to a *Topology* tab, so they use the full width of the centre and stay open while you go back to the topology; hide the side panes with *View* for even more room. *Open in a new window ↗* moves the active one into a browser window of its own, for example on a second screen; what it does still shows in the main window's Messages pane, and its lists update the shelf there.

*Manage*, next to *Images* on the shelf (or *All containers and images…* in the running-labs panel), lists everything in the Docker host's engine:

- **Containers**, running or stopped, grouped by lab, plus those not created by DockerLab (*Outside DockerLab*, e.g. GNS3's). **Console** opens a shell in any running container, including ones DockerLab didn't create, such as those from a `docker compose` file; **Start**, **Stop** and **Restart** control any container (all also on a container's details page). A DockerLab container is started the way its lab starts it, with the lab's addresses and its startup commands; if its lab file is missing, it starts with Docker's internal addresses, and DockerLab says so. Delete single containers, or *Remove* a whole lab's containers and networks. A lab whose containers were deleted needs a Redeploy; its lab file is kept. Deleting a lab's last container also removes its networks.
- **Images**: *Pull an image* at the top fetches one from Docker Hub (`alpine:3.20`, `nicolaka/netshoot`) or from another registry by its address (`ghcr.io/owner/image:tag`); it needs the Docker host's internet access. Below it, the images, with their size, which containers use them, and which saved labs need them. An image used by any container, even a stopped one, can't be deleted until the container is. *Clean up* removes unnamed images left behind by rebuilds and pulls.
- **Networks**: every Docker network on the host, with its driver, subnet, and the containers attached to it, running or stopped (Docker's own list shows only running ones). Networks of DockerLab labs are tagged with their lab; those no container uses any more are *left over* (for example from labs removed outside DockerLab), and *Clean up* deletes them all at once. *Delete every unused network…* also removes unused networks DockerLab didn't create, such as GNS3's or stopped Compose projects', after asking. Deleting a network that containers use disconnects them first, after asking; a stopped one then won't start on it again, so a lab needs a Redeploy. *New network…* creates one: a **bridge** (a virtual switch on the host; optionally internal, with your subnet, gateway, address range, bridge name, MTU and IPv6), or a **macvlan** or **ipvlan** network that puts containers directly on one of the host's real networks (give its parent interface, such as `eth0`, and that network's subnet and router). For macvlan in VirtualBox, set that adapter's *Promiscuous Mode* to *Allow All*.
- **Volumes**: every Docker volume on the host, with its size, where its files are, the containers that mount it (running or stopped), and the saved labs that use it. *Details* shows that, plus a **file browser**: click through the volume's folders and see each file's size and date. It reads them through a small helper container that mounts the volume read-only, so it needs no sudo. *New volume…* creates one, either in Docker's storage (the usual kind, deleted with the volume) or bound to an existing folder of the host (the files stay there when the volume is deleted). Docker won't delete a volume any container has, even a stopped one, so *Delete* is offered only for unused ones, and names what's still using the others. *Delete unused anonymous volumes* clears out the nameless ones Docker creates for images that declare a `VOLUME`; *Delete every unused volume…* removes the named ones too, after asking.
- **Details:** click a container, image, network or volume name (or *Details* next to it; for a deployed node, *Details* in its right pane; for an image on the shelf, double-click it) for what `docker inspect` shows, laid out in sections: state, command, networks and published ports, storage, environment, security and resource settings, and labels for a container; overview, how its containers start (entrypoint, command, environment, exposed ports), its Dockerfile if it was built in DockerLab, its build steps with the size each adds, and which containers and saved labs use it, for an image; overview, addresses, attached containers, options and labels for a network. Names link to each other, *Back* returns, and the raw JSON is at the bottom. For lab containers, the addresses actually set inside the container are shown next to Docker's carrier ones.

**Recovering a lost lab file.** A lab whose containers are still in the VM but whose lab file is gone is marked *no lab file*; *Recover lab file* rebuilds the file from the containers. Containers deployed by this version carry a compressed copy of their whole lab, so recovery is exact. For containers deployed by earlier versions it's best-effort: containers, images, switches, cables, subnets, fixed addresses, interface order, and the Router, Internet, port, volume and environment settings come back, but bench positions, startup commands, the description and interface limits don't (Redeploy once after recovering, and they'll be kept from then on).

### Sharing labs

*Export → Lab file* downloads `<lab>.dockerlab.json`. Anyone with DockerLab can *Import* it and press Deploy. The file holds the whole lab: layout, containers, switches, cables, subnets and addresses, startup commands and description.

It also holds the **Dockerfile of every image built in DockerLab** that the lab uses. So on another VM, Deploy first gets any image that VM lacks: it **builds** images that came with a Dockerfile, and **pulls** the rest (e.g. `alpine:3.20`) from Docker Hub. Both need the VM's internet connection, and the deploy message says what it fetched.

Things that don't travel: volumes that point at folders on your VM, and images from a private registry. If two labs on one VM use the same subnet, only one can be deployed at a time; Deploy says which lab holds it.

If a lab with the same name already exists, Import offers to save it under a new name or replace yours.

Images built with DockerLab versions before lab sharing don't carry their Dockerfile, so a lab using one can't be deployed elsewhere. Save and Export warn about such images: rebuild them once with *Build* (same name), then export again.

### Reaching a service in a lab

To open a web server (or any service) in a lab from your PC, publish its port: click the container and add a row under **Port mappings**, e.g. *Host 8080, Container 80*. After a Redeploy, Docker listens on port 8080 on all of the Docker host's addresses, including the VM's Host-only one, so the panel shows a link such as `http://192.168.56.103:8080`. Notes:

- The service must listen on all interfaces (`0.0.0.0`) inside the container: published traffic arrives on `nat0`.
- Each host port can be used once on the VM, across all labs. Avoid ports the VM itself uses (22 for SSH; on the GNS3 VM also 80 and 3080): 8080 and up are safe.
- **Changing the default route breaks it.** Docker forwards the request without changing its source address, so the container replies to your PC. If its startup commands send the default route into the lab (`ip route replace default via …`), the reply is lost. The panel warns about this and shows the fix: a route back to your PC's network through `nat0`, e.g. `ip route add 192.168.56.0/24 via 172.17.0.1 dev nat0`.
- The realistic alternative is to publish the port on the lab's gateway and forward it to the server, as a home router does. The *07-port-forward* lab does exactly this.

To reach it from other machines than your PC, which can't see the Host-only network, either forward a port on Windows (`netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8080 connectaddress=192.168.56.103 connectport=8080`, plus a firewall rule allowing TCP 8080), or give the VM a Bridged adapter so it has an address on your LAN.

### Example labs

DockerLab comes with ready-made labs, listed under *Examples* in *Open…*. Opening one gives you your own copy, saved in your labs folder under the example's name, so you can change it freely; opening it again later asks whether to open your copy or start over from the original. Each carries the Dockerfiles of its images, so the first Deploy builds any it needs on the Docker host; that needs the VM's internet access and takes a minute or two.

They're numbered in teaching order, from one container to routing protocols and a data-centre fabric. Each description has the addressing, step-by-step tasks with the commands, and questions; the routing labs come up unconfigured and leave the configuration to the student, with the full configuration in the description (to type, or paste into `vtysh`) and the steps to verify it.

| Lab | What it shows |
|---|---|
| `01-console` | One Linux container with internet access: a first look at a container and its console. |
| `02-web-server` | A web server published on the Docker host's port 8080: port mapping. |
| `03-web-volume` | A web site kept in a Docker volume, served by two containers (one read-only); it survives removing them. |
| `04-nat-gateway` | A PC behind a NAT gateway, as at home: masquerading, seen from both sides. |
| `05-switch-lan` | Two PCs on a switch: a LAN, ARP, and why the same subnet matters. |
| `06-lan-gateway` | Two PCs on a switch and a gateway to the internet: what goes through the gateway, and what doesn't. |
| `07-port-forward` | A LAN behind a gateway that forwards port 8080 of the Docker host to a web server inside (formerly *example-web*). |
| `08-two-lans` | Two LANs joined by a router that also NATs both to the internet. |
| `09-two-lans-desktop` | The same with a Linux desktop in the browser ([webtop](https://docs.linuxserver.io/images/docker-webtop), XFCE with Firefox) on LAN 1, reached at `https://<Docker host>:3001` (formerly *example-two-lans*). The desktop image is about 1.5 GB; give the VM at least 4 GB of RAM and, for a smooth desktop, 4 vCPUs. |
| `10-static-routing` | Three FRR routers in a ring, each with a LAN; students configure static routes, then a backup route. |
| `10a-static-addressing` | Lab 10 with nothing configured: students first give every router interface its address in `vtysh` and every PC its address and gateway, then add the static routes. |
| `11-ospf` | The same ring; students configure OSPF, verify the adjacencies and routes, and break a link to watch it reroute. |
| `11a-ospf-addressing` | Lab 11, addresses included in the exercise (as 10a). |
| `12-ospf-srlinux` | The same ring with Nokia SR Linux routers, configured in SR Linux's CLI. The image is about 2.5 GB, and each router needs over 1 GB of memory: give the VM 8 GB. |
| `13-dhcp` | A gateway that hands out addresses by DHCP (dnsmasq); students watch the DORA exchange and reserve an address. |
| `14-dns` | A DNS server for the zone `lab.test` with A and CNAME records, forwarding other names. |
| `15-load-balancer` | nginx sharing requests between two web servers, published on port 8080. |
| `16-firewall` | A firewall between a LAN, a DMZ with a web server, and the internet; students write the iptables policy. |
| `17-bgp` | The ring of labs 10 and 11 with each router in its own AS: eBGP, AS paths, and traffic engineering with AS-path prepending. |
| `17a-bgp-addressing` | Lab 17, addresses included in the exercise (as 10a). |
| `18-evpn-leaf-spine` | A data-centre fabric: 2 spines, 3 leaves, 6 PCs in VLANs 10 and 20 stretched across the leaves with VXLAN and BGP EVPN (FRR). Same-VLAN PCs reach each other, other-VLAN PCs don't. The leaves' data plane (bridges, VXLAN) is built by their startup commands; students configure BGP. |

The images the labs build: *dockerlab/host* (end host tools), *dockerlab/router* (iptables and `nat-on`), *dockerlab/web* (BusyBox httpd), *dockerlab/gateway* (router plus dnsmasq), *dockerlab/frr* (FRRouting, privileged because FRR's daemons need it), *dockerlab/nginx*, *dockerlab/desktop*; lab 12 pulls `ghcr.io/nokia/srlinux`.

### Diagrams

*Export → Diagram as SVG / PNG* draws the bench, with your Appearance settings: containers with their addresses (live ones if deployed), switches, cables with their labels, and notes. The SVG is a real vector drawing with the font embedded, so it stays sharp at any size and can be edited in Inkscape or Illustrator. The PNG is the same drawing at double resolution. Programs that ignore embedded fonts, such as Word and PowerPoint, substitute a similar font, so the layout stays the same.

### Export to docker-compose

*Export compose* downloads `<lab>.compose.yaml`, which recreates the lab with `docker compose -f <lab>.compose.yaml up -d` on any Docker host, for example to hand a finished lab to students. Images that DockerLab built, such as `dockerlab/host` or the example labs' images, exist only on the VM that built them, so the file carries their Dockerfiles (`build:` with `dockerfile_inline`) and Compose builds them on the new host; that needs Docker Compose 2.17 or newer, and internet access while building. `pull_policy: build` keeps Compose from pulling an unrelated image of the same name from Docker Hub instead. Images from a registry (`alpine:3.20`, `nginx:alpine`) are pulled as usual.

Startup commands run as **`post_start` hooks** (Docker Compose 2.30 or newer): Compose runs them in each container every time it starts it (`up`, `start`, `restart`), as DockerLab does, so routes, NAT and servers come up on their own. A plain `docker start` doesn't run them. Every `$` in commands, environment values and Dockerfiles is written as `$$`, so Compose leaves the shell's variables alone.

A lab with cables or switches also gets a one-off service, **`dockerlab-hostfw`**, which the lab's containers wait for. If the host has bridge netfilter on, it adds the same two iptables rules DockerLab adds on its own hosts (see *Lab traffic and the Docker host's firewall*); without them, traffic routed between the lab's networks, or out through its gateway, would be dropped. It runs with the host's network and `NET_ADMIN`, prints what it did (`docker compose logs dockerlab-hostfw`), and exits.

One difference from DockerLab: internet access uses a network called `nat` instead of Docker's default bridge.

## How a lab maps to Docker

| On the bench | In Docker |
|---|---|
| Lab `demo` | everything labelled `dockerlab.lab=demo`; nothing else on the engine is touched, including GNS3's own containers |
| Container `r1` | container `dl-demo-r1`, hostname `r1`, with `NET_ADMIN` and `NET_RAW` so `ip` and `ping` work |
| Cable between two containers | an *internal* bridge network with just those two containers |
| Switch | one *internal* bridge network; every cable to it attaches that container to it. Switches can't be cabled to each other yet |
| Cable ends | `eth0`, `eth1`, ... in the order that container's cables were drawn, with the lab's address for that cable (see *Lab addresses*) |
| Router | `net.ipv4.ip_forward=1` inside the container |
| Internet access, or any published port | an extra interface `nat0` on Docker's default `bridge` network (NAT). Published ports require it |
| A container with no cables and no internet | `network_mode: none` (loopback only) |

Containers run with a TTY attached, so images whose default command is a shell (alpine, ubuntu, busybox) stay running.

The bench shows each container's interfaces once deployed, e.g. `eth0  to pc1  10.0.1.3/24`. These are read from inside the running container, so they're correct even on an engine older than Docker 28.

**Lab traffic and the Docker host's firewall.** Lab networks are Docker *internal* networks, and Docker's firewall drops packets on them whose source or destination is outside the subnet Docker knows for the network, which is the carrier subnet (see below), so that's every lab packet. That never matters unless the Docker host has *bridge netfilter* on (`net.bridge.bridge-nf-call-iptables = 1`); then nothing in a lab could talk. On every Deploy, DockerLab checks for this and, if needed, adds two rules on the Docker host: one accepts traffic within its own bridges (named `dl…`), `iptables -I DOCKER-USER -i dl+ -o dl+ -j ACCEPT`, and one keeps that traffic out of Docker's NAT, `iptables -t nat -I POSTROUTING -o dl+ -j RETURN` (otherwise a connection from the Docker host itself to a published port, such as `curl localhost:8080` in its console, gets masqueraded inside the lab and its reply is lost). It uses the same SSH login as capture, and the sudo rule DockerLab offers when it first connects; if that's not possible, Deploy says so and shows the command to run yourself.

**Lab addresses.** Each lab has its own address space: two labs can use the same subnets at the same time, and every address, `.1` included, is yours. Docker requires every network on the engine to have its own subnet, so DockerLab doesn't give it the lab's: each cable and switch gets a private *carrier* subnet from `100.64.0.0/10` that only Docker sees. After every container start (Deploy, Start, Restart), DockerLab replaces the carrier addresses inside the container with the lab's, using the image's `ip` command, or, for images without one, a small helper container (`alpine`) that shares the container's network. Cables and switches without a subnet get one of their own from `172.31.0.0/16`, and ends without a fixed address get the lowest free address of their subnet; both stay the same across redeploys. Docker gives a restarted container new MAC addresses, so DockerLab then announces each address with a gratuitous ARP (if the image has `arping`, as BusyBox does), and neighbours update at once instead of after their ARP cache times out. Containers with *DockerLab sets the addresses* off only get the carrier addresses removed; for 30 seconds after each start, DockerLab announces whatever addresses appear on them (set by a routing daemon from its saved configuration, a DHCP client or a network OS) the same way.

**Names.** DockerLab also adds every node's name to each container's `/etc/hosts`, so `ping serv-www` works in any lab container, without DNS.

**Default routes:** cable networks don't give containers a default route, so a host only reaches its own subnet until you add routes, which is what you want for a routing lab: `ip route add default via <router-ip>` inside the host. A container with internet access gets a default route through the NAT interface.

## Project layout

```
backend/
  main.py          FastAPI app: REST API + serves the built UI
  deployer.py      topology -> Docker networks/containers, start/stop, startup commands, status
  capture.py       launches ssh | tcpdump | Wireshark
  compose.py       docker-compose export
  templates.py     Dockerfile templates for Build image
  images.py        image builds, and pulling or building a lab's missing images
  connection.py    which Docker host to use; first-connection setup (host key, SSH key, sudo rule)
  vmshell.py       SSH shell and commands on the Docker host, for its Console
  hostfw.py        keeps the Docker host's firewall from dropping routed lab traffic
  hostload.py      CPU and memory of the Docker host, and per container
  vmadmin.py       container and image inventory, deletes, lab recovery
  netadmin.py      Docker networks: list, inspect, create, delete, clean up
  voladmin.py      Docker volumes: list, inspect, browse files, create, delete, clean up
  models.py        topology data model (validated with pydantic)
  static/          built UI (generated by `npm run build`)
frontend/          React + React Flow source; console.html + src/console.js is the terminal window
examples/          example labs, listed under Examples in Open…
VERSION            the version number, shown next to the DockerLab name
```

To work on the UI: `cd frontend`, `npm install`, `npm run dev` (with the backend running), then open the URL Vite prints. `npm run build` writes the result into `backend/static`.

## REST API

| Method | Path | Does |
|---|---|---|
| GET | `/api/status` | engine connection and version; `{"connected": false}` before you connect |
| GET | `/api/images` | images on the engine |
| GET | `/api/images/templates` | Dockerfile starting points for *Build* |
| POST | `/api/images/build` | `{"tag": "dockerlab/router:latest", "dockerfile": "..."}`; returns `ok`, and `error` and `log` on failure |
| POST | `/api/images/pull` | `{"name": "alpine:3.20"}` |
| GET | `/api/labs` | saved lab names |
| GET, PUT, DELETE | `/api/labs/{name}` | read, save, delete a lab file |
| POST | `/api/labs/{name}/deploy` | create networks and containers |
| POST | `/api/labs/{name}/destroy` | remove them |
| GET | `/api/labs/{name}/state` | per-node status and IPs, per-link bridge names |
| POST | `/api/labs/{name}/start`, `/stop` | start or stop all of the lab's containers (stop works even if the lab file was deleted) |
| POST | `/api/labs/{name}/nodes/{id}/{start,stop,restart}` | control one container |
| WS | `/api/vm/console` | terminal on the Docker host (the VM), same framing as container consoles |
| WS | `/api/labs/{name}/nodes/{id}/console` | terminal: binary frames are terminal bytes, text frames are JSON (`{"resize": [cols, rows]}`) |
| WS | `/api/vm/containers/{id}/console` | terminal in any running container on the Docker host, same framing |
| POST | `/api/labs/{name}/links/{id}/capture` | open a live capture of a cable in Wireshark |
| GET | `/api/labs/{name}/compose` | the lab as a docker-compose file |
| GET | `/api/labs/{name}/file` | the lab file, for sharing |
| POST | `/api/labs/import` | add a lab from a lab file (body); 409 with a suggested name if it exists; `?overwrite=true` or `?rename=` |
| GET | `/api/vm/containers` | every container in the VM, grouped by lab, with whether the lab file exists |
| DELETE | `/api/vm/containers/{id}` | delete a container (and its lab's networks once the lab has no containers left) |
| POST | `/api/vm/containers/{id}/{start,stop,restart}` | control any container; DockerLab's are started with their lab addresses and startup commands |
| GET | `/api/vm/images` | every image, with the containers and labs using it, and unnamed leftovers |
| DELETE | `/api/vm/images/{tag}` | delete an image; 409 if a container uses it |
| POST | `/api/vm/images/prune` | remove unnamed leftover images |
| POST | `/api/vm/labs/{lab}/recover` | rebuild a lab file from its deployed containers |
| GET | `/api/vm/volumes`, `/api/vm/volumes/{name}` | volumes with their users and labs; one volume |
| GET | `/api/vm/volumes/{name}/files?path=` | the entries of one folder in a volume |
| GET | `/api/vm/volumes-sizes` | bytes used by each volume |
| POST, DELETE | `/api/vm/volumes`, `/api/vm/volumes/{name}` | create (`{"name", "device"?}`) or delete a volume |
| POST | `/api/vm/volumes-prune?scope=anonymous\|all` | delete unused volumes |
| GET | `/api/running` | every running container on the engine, grouped by lab, plus those outside DockerLab |

Interactive docs at http://127.0.0.1:8000/docs.

## License

Copyright (C) 2026 Khaled Mahmud

DockerLab is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

Labs you make with DockerLab are yours; the license covers DockerLab's own code.

## Third-party software

DockerLab bundles open-source packages (FastAPI, docker-py, paramiko, React, React Flow, xterm.js, the Atkinson Hyperlegible font and their dependencies). They're listed with their licenses in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); `python tools/notices.py` regenerates it from what's installed, and release builds run it.
