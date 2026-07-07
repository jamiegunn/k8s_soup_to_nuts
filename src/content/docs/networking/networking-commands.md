---
title: "Networking Commands: A Cross-Platform Field Reference"
description: The host-side networking toolkit — arp, ip/ifconfig, ss/netstat, ps, dig, ping, traceroute, nc, tcpdump — with the flags that matter and a task-by-task table of the equivalents on Linux, macOS, and Windows.
sidebar:
  order: 10.5
---

Most of this site debugs *from inside a pod*, where you control the image and can install [netshoot](/networking/debugging-network/). But a huge fraction of real network troubleshooting happens on the *other* side of the wire — your macOS laptop probing a VIP, a Linux jump box on the node subnet, a Windows workstation that can't reach an internal service. The commands there are not the ones in the pod, and they differ by operating system in ways that waste time exactly when you don't have it (`traceroute` vs `tracert`, `ss` vs `netstat`, `-c` vs `-n` on ping).

This is the reference. First the one-glance table by *task*, then each command with the flags worth memorizing and what to look for — cross-linked to the deep dives that use them.

:::note[Modern vs. legacy on Linux]
The classic `ifconfig`, `netstat`, `arp`, and `route` come from **net-tools**, which is deprecated and *absent from many minimal images and modern distros*. Their replacements live in **iproute2**: `ip addr`, `ss`, `ip neigh`, `ip route`. Both are shown below; prefer the `ip`/`ss` forms on Linux and reach for the net-tools names only when that's all that's installed (and inside a stripped pod, often neither is — see [Linux Inside the Pod](/troubleshooting/linux-inside-the-pod/) and [The BusyBox Toolkit](/troubleshooting/busybox/)).
:::

## The cross-platform table

| Task | Linux (iproute2 / net-tools) | macOS | Windows |
|---|---|---|---|
| **Interfaces & IP addresses** | `ip addr` · `ifconfig -a` | `ifconfig` · `ipconfig getifaddr en0` | `ipconfig /all` |
| **ARP / neighbor cache** (IP→MAC) | `ip neigh` · `arp -n` | `arp -a` | `arp -a` |
| **Routing table** | `ip route` · `netstat -rn` | `netstat -rn` · `route get <ip>` | `route print` · `netstat -rn` |
| **Listening ports** | `ss -tulpn` · `netstat -tulpn` | `lsof -iTCP -sTCP:LISTEN -nP` · `netstat -an -p tcp` | `netstat -ano` |
| **Active connections** | `ss -tnp` · `netstat -tnp` | `netstat -an` · `lsof -i` | `netstat -ano` |
| **Which process owns a port** | `ss -tulpn` · `lsof -i :PORT` · `fuser PORT/tcp` | `lsof -i :PORT -nP` | `netstat -ano` + `tasklist /fi "pid eq N"` · PowerShell `Get-NetTCPConnection` |
| **DNS lookup** | `dig NAME +short` · `host NAME` · `resolvectl query NAME` | `dig NAME +short` · `host NAME` | `nslookup NAME` · PS `Resolve-DnsName NAME` |
| **Reverse DNS** | `dig -x <ip> +short` | `dig -x <ip> +short` | `nslookup <ip>` |
| **Trace path to host** | `traceroute -n HOST` · `mtr HOST` | `traceroute -n HOST` | `tracert -d HOST` · PS `Test-NetConnection HOST -TraceRoute` |
| **Test a TCP port** | `nc -vz -w3 HOST PORT` | `nc -vz -G3 HOST PORT` | PS `Test-NetConnection HOST -Port PORT` |
| **Ping (N times)** | `ping -c4 HOST` | `ping -c4 HOST` | `ping HOST` (4 by default) · `ping -n 4 HOST` |
| **Ping continuously** | `ping HOST` (Ctrl-C) | `ping HOST` (Ctrl-C) | `ping -t HOST` |
| **MTU probe** (don't-fragment) | `ping -M do -s 1472 HOST` | `ping -D -s 1472 HOST` | `ping -f -l 1472 HOST` |
| **Packet capture** | `tcpdump -ni any 'tcp port 443'` | `sudo tcpdump -ni en0 'tcp port 443'` | `pktmon` · Wireshark · `netsh trace start` |
| **Show a NIC's MAC** | `ip link` | `ifconfig en0 \| grep ether` | `getmac /v` |
| **Flush ARP cache** | `sudo ip neigh flush all` | `sudo arp -a -d` | `netsh interface ip delete arpcache` (admin) |
| **Flush DNS cache** | `sudo resolvectl flush-caches` | `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` | `ipconfig /flushdns` |

`PS` = Windows **PowerShell** (the `Test-NetConnection`/`Resolve-DnsName`/`Get-NetTCPConnection` cmdlets); everything else runs in either `cmd` or PowerShell. On macOS, note the trap in the table twice over: `ipconfig` is **Apple's** tool (nothing like Windows' `ipconfig`), and `nc`'s connect-timeout flag is `-G`, not `-w` (which is idle timeout).

## `arp` / `ip neigh` — the IP-to-MAC truth

The neighbor cache maps an IP to the MAC currently answering for it on the local segment — the single most useful command when a [VIP](/networking/layers-and-vips/#what-is-a-vip) misbehaves, because it reveals *which physical machine* is claiming an address that's bound to no interface.

```console
# Linux (modern / legacy), macOS, Windows all read the same idea:
$ ip neigh show 10.40.8.112          # Linux
10.40.8.112 dev eth0 lladdr 52:54:00:ab:3e:91 REACHABLE
$ arp -a 10.40.8.112                 # macOS / Windows
? (10.40.8.112) at 52:54:00:ab:3e:91 on en0 ifscope [ethernet]
```

What to look for:

- **Which node owns a MetalLB L2 VIP.** Cross-check the MAC against the announced node ([How MetalLB Chooses the Node](/controllers/metallb-node-selection/)). The right MAC = healthy hop 1.
- **Two MACs for one IP**, or a MAC that *changes with no failover* — that's [VRRP/MetalLB split-brain](/routing/floating-vips/#split-brain-when-two-boxes-claim-the-vip); run it twice, seconds apart, to catch the flap.
- **`FAILED` / `incomplete`** — nobody answered ARP; the IP is unreachable at L2 regardless of what upper layers want. On a VIP that means no node is announcing it.
- **Stale entry after maintenance** — `sudo ip neigh flush to 10.40.8.112` (Linux) / `sudo arp -d 10.40.8.112` (macOS) / `arp -d 10.40.8.112` (Windows, admin) forces a re-ARP and often ends a post-failover blip on *your* box; when the stale cache is on an upstream switch, that's a [platform-team](/operations/working-with-platform-team/) ask.

## `ip addr` / `ifconfig` / `ipconfig` — what am I, and is the VIP here?

Shows interfaces and their addresses. Two diagnostic uses beyond "what's my IP":

```console
$ ip -br addr                # Linux, brief one-line-per-iface form
eth0  UP  10.40.8.13/24
$ ip addr | grep 10.40.8.112 # is the VIP bound anywhere? (expect: nothing)
```

- **Confirm a VIP is virtual.** Grep for it — it's on *no* interface, which is the whole point of a [VIP](/networking/layers-and-vips/#what-is-a-vip). (Exception: MetalLB L2 doesn't bind it either; keepalived/VRRP *does* add it as a secondary address on the master — see [Floating VIPs](/routing/floating-vips/).)
- **Spot a duplicate/secondary address** the box shouldn't have — a symptom of a VIP misconfigured as a static address.

## `ss` / `netstat` — sockets, listeners, and "connection refused"

`ss` (Linux) and `netstat` (macOS/Windows, and legacy Linux) show sockets. The single highest-value invocation lists **listening** TCP ports with the owning process:

```console
$ ss -tulpn                                  # Linux: TCP+UDP, listening, numeric, with PID
Netid State  Local Address:Port  Process
tcp   LISTEN 0.0.0.0:8080        users:(("java",pid=1,fd=44))
tcp   LISTEN 127.0.0.1:9000      users:(("sidecar",pid=1,fd=12))
$ netstat -ano | findstr LISTENING           # Windows
$ lsof -iTCP -sTCP:LISTEN -nP                 # macOS
```

The flags decoded — `-t` TCP, `-u` UDP, `-l` listening only, `-p` show process, `-n` numeric (don't resolve names/ports, much faster), `-a` all (add established). On Windows `netstat`: `-a` all, `-n` numeric, `-o` owning PID, `-b` owning binary (needs admin).

What to look for:

- **`0.0.0.0:PORT` vs `127.0.0.1:PORT`.** The classic "connection refused from another host" bug: the app bound to loopback only. From inside its own netns it works; from anywhere else the SYN is refused. This one line settles it ([Debugging the Network, step 1](/networking/debugging-network/)).
- **Is anything even listening?** `connection refused` means the packet arrived and *nothing* was on that port — `ss -tln` proves presence or absence.
- **Established-connection counts** (`ss -tn state established`) — one pod holding thousands of connections to a single peer is the [long-lived-connection imbalance](/networking/long-lived-connections/) wearing numbers.

## `ps` + `lsof` — from a port to the process that owns it

`ss`/`netstat` give you a PID; `ps` turns the PID into a culprit, and `lsof` goes straight from a port to the process. The full "who has port 8080?" chain, per OS:

```console
# Linux — one step with ss, or lsof, then ps for the full command line:
$ ss -tlnp 'sport = :8080'
tcp LISTEN 0.0.0.0:8080 users:(("java",pid=3711,fd=44))
$ ps -p 3711 -o pid,ppid,user,etime,args
  PID  PPID USER     ELAPSED COMMAND
 3711     1 app     02:14:07 java -jar /app/orders.jar

# macOS — lsof is the tool:
$ lsof -nP -iTCP:8080 -sTCP:LISTEN
COMMAND   PID USER   FD  TYPE  NODE NAME
java     3711 app    44u IPv4       TCP *:8080 (LISTEN)

# Windows — netstat gives the PID, tasklist names it:
> netstat -ano | findstr :8080
  TCP    0.0.0.0:8080   0.0.0.0:0   LISTENING   3711
> tasklist /fi "pid eq 3711"
# PowerShell one-liner:
> Get-Process -Id (Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess
```

`ps aux` (BSD style, macOS/Linux) or `ps -ef` (SysV style, Linux) plus `grep` is the blunt fallback when you know the process name but not the port. Useful `ps` columns: `etime`/`etimes` (how long it's run — a process that restarted mid-incident stands out), `%cpu`, `rss` (resident memory), `args` (full command line, so you can see the actual flags a pod was launched with).

## `dig` / `nslookup` / `Resolve-DnsName` — resolution

`dig` is the precise instrument (Linux/macOS); `nslookup` is everywhere including Windows; PowerShell's `Resolve-DnsName` is the native Windows equivalent.

```console
$ dig orders.corp.example +short          # just the answer
203.0.113.45
$ dig orders.corp.example                 # full: which server, how long, authority
$ dig +trace orders.corp.example          # walk the delegation from the root
$ dig -x 203.0.113.45 +short              # reverse lookup
> Resolve-DnsName orders.corp.example     # Windows PowerShell
```

What to look for: the **answer vs. the server that gave it** (`dig` prints `SERVER:` at the bottom — resolving against the wrong resolver explains a lot), multi-second timings that betray the [`ndots` search-walk](/networking/dns/), and `NXDOMAIN` vs `SERVFAIL` (no such name vs. resolver failure — different owners). Add a **trailing dot** (`orders.corp.example.`) to force an absolute lookup and skip the search list entirely. The in-cluster resolution machinery is [DNS Inside the Cluster](/networking/dns/); this is the client-side lens.

## `ping` / `traceroute` / `mtr` — reachability and path

```console
$ ping -c4 10.40.8.112                     # Linux/macOS: 4 packets  (Windows: ping -n 4)
$ traceroute -n 10.40.8.112                # Linux/macOS: -n = no reverse DNS, faster
> tracert -d 10.40.8.112                    # Windows: -d = no reverse DNS
$ mtr 10.40.8.112                          # Linux: continuous traceroute+loss stats, best of both
```

Cautions that save wrong conclusions:

- **ICMP is often filtered.** A VIP that doesn't `ping` may still serve TCP perfectly — [ClusterIPs famously don't ping](/networking/layers-and-vips/#the-vip-zoo) but `curl` fine. Never conclude "down" from ping alone; test the actual port.
- **The MTU probe is the exception where ping is irreplaceable.** `ping -M do -s 1472` (Linux) / `ping -D -s 1472` (macOS) / `ping -f -l 1472` (Windows) sets don't-fragment; the largest size that still returns ≈ the path MTU. "Small pings work, large ones vanish" is the [MTU blackhole](/networking/networking-model/) signature, and this is how you measure it.
- **Windows `ping` sends 4 and stops; Unix `ping` runs forever** until Ctrl-C. Flip with `-n`/`-c` (count) and `-t` (Windows continuous).

## `nc` / `Test-NetConnection` / `curl` — does the port actually open?

The L4 question — "can I complete a TCP handshake to `HOST:PORT`?" — independent of DNS and L7:

```console
$ nc -vz -w3 10.40.8.112 443               # Linux: -v verbose, -z scan (no data), -w3 timeout
Connection to 10.40.8.112 443 port [tcp/https] succeeded!
$ nc -vz -G3 10.40.8.112 443               # macOS: connect-timeout is -G, not -w
> Test-NetConnection 10.40.8.112 -Port 443  # Windows PowerShell (alias: tnc)
```

`Test-NetConnection` prints `TcpTestSucceeded : True/False` plus ping and route info in one shot. For L7, `curl -sv --max-time 5 https://host/path` (present on modern Windows too) adds the request/response on top of the connect. The interpretation ladder — *refused* (something rejected: nothing listening / wrong port), *timeout* (SYN into the void: firewall, [NetworkPolicy](/networking/network-policies/), routing, or a silent drop), *succeeded* (L4 is fine, look higher) — is the backbone of [layer triage](/networking/layers-and-vips/#the-layer-triage-table).

## `tcpdump` — the only source of ground truth

Everything else *infers*; `tcpdump` *shows*. It's built into macOS and Linux; on Windows use `pktmon` (built-in on Win10+), Wireshark, or `netsh trace`.

```console
$ sudo tcpdump -ni en0 'tcp port 443 and host 10.40.8.112' -c 20
```

Flags that matter: `-n` numeric (don't resolve — faster, clearer), `-i any` all interfaces (Linux) or a named one, `-c N` stop after N packets, `-w file.pcap` save for Wireshark, and a **BPF filter** (`'tcp port 443 and host X'`) to cut noise. The diagnostic value is in comparing two captures across a suspected rewrite — same flow, both sides, addresses different = a NAT hop, which is exactly how [SNAT and DNAT](/routing/nat/#verification-kit-watching-nat-happen) proves which box rewrote your packet. Reading rule of thumb: SYN out and no SYN-ACK back → the problem is downstream; not even your SYN on the wire → it's local (a policy/eBPF drop).

## Where this meets the rest of the site

These commands are the hands; the deep dives are the map:

- Chasing which node owns a VIP → [How MetalLB Chooses the Node](/controllers/metallb-node-selection/) and [Floating VIPs](/routing/floating-vips/) (`arp`, `ip neigh`, `tcpdump vrrp`).
- Chasing a rewritten source IP → [SNAT and DNAT](/routing/nat/) and [Egress](/networking/egress/) (`tcpdump`, `curl ifconfig.me`, `ss`).
- A structured hop-by-hop hunt → [Debugging the Network](/networking/debugging-network/) (the same tools, sequenced).
- The same tools *inside* a stripped pod → [Linux Inside the Pod](/troubleshooting/linux-inside-the-pod/), [The BusyBox Toolkit](/troubleshooting/busybox/), and [Debugging Toolbox](/troubleshooting/debugging-toolbox/) for getting them there with `kubectl debug`.

The one habit worth building: **name the OS before you type the command.** Half of "the command doesn't work" is a Linux flag typed on macOS or a Unix reflex typed on Windows — and the table above exists so that costs you a glance, not a detour.
