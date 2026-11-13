# XYSKY UDP

English | [中文](README_zh.md)

> [!IMPORTANT]
> **Sky client version compatibility**
>
> This branch targets the **0.35.1 `PlayerState` layout**. The field layout changes between
> Sky releases, and even builds of the same release do not always write the same field set:
> some clients emit the extra 8-byte field at `state+0x52B8`, some omit it. The node
> therefore identifies each player's layout at runtime and only accepts a variant that
> consumes the record exactly, so both 0.35.1 build variants are supported out of the box.
>
> **`room.player_state_decode`** (in `config.yml`) selects how deep the node parses:
>
> - `full` *(default)* — every field of the record: position, move, body frames, queued
>   pose, outfit, world quests, tail. Needed only if you want to inspect complete state.
> - `basic` — stops after `stateKind`, `position` and the `move` block (velocity). That is
>   all cross-room migration uses, it is roughly 20× cheaper, and it never touches the
>   records below the move block — the ones that change most between client builds. The
>   first frame of each player is still decoded in full to detect the layout, and later
>   frames take the cheap path.
>
> If a record cannot be matched to a known layout, the node keeps the player in the room and
> still reports its position (the first 12 bytes are fixed across all known revisions),
> logs one full sample per failing signature instead of one line per frame, and continues.
>
> **Mixing client versions is not supported.** Players on different Sky client versions
> cannot share a room; only players on the same version can see each other. For a client
> whose `PlayerState` revision differs, set `room.player_state_decode: basic`: it stops
> reading fields below the move block, so only the fixed header and the move block have to
> match.

**XYSKY UDP** is a multiplayer room server implementing the network protocol used by
*Sky: Children of the Light* (client 0.35.1). It is written in Node.js, uses
[ENet](https://www.npmjs.com/package/sky-enet) for reliable UDP game traffic, and optionally
exposes a separate Prometheus HTTP metrics listener (disabled by default).

One process hosts **one room** with up to **8 joined players**. It can run completely
standalone, or register itself with a **QWD** room manager so that many nodes form a
dynamically allocated, auto-balancing fleet.

> This is an independent community research / server implementation project. It is not
> affiliated with or endorsed by thatgamecompany. You are responsible for ensuring your use
> of client assets, network services, and deployment complies with applicable terms and law.

## Deployment Modes

XYSKY UDP supports two modes, selected purely by whether `qwd.url` is set in `config.yml`.

### Standalone (default)

`qwd.url` is empty. The node does **not** connect to or register with any manager and simply
serves a single 8-player room at its public UDP address.

```text
XYSky (HTTP/WS backend)  ──direct UDP──▶  XYSKY UDP Node  ──▶  up to 8 players
```

In XYSky's own config, point `udp.uri` straight at this node's public UDP `IP:Port`.

### QWD-managed

`qwd.url` points at a QWD (Room Authority / Room Manager) WebSocket endpoint. On startup the
node connects over WebSocket and registers its `public_uri`. QWD then allocates rooms and
coordinates cross-room moves across all registered nodes.

```text
XYSky ──HTTP(S) /allocate──▶ QWD ──WebSocket──▶ XYSKY UDP Node ──public_uri──▶ Sky client
```

In this mode XYSky's `udp.uri` is the QWD **HTTP(S) `/allocate`** address, while the node's
`qwd.url` is the QWD **WebSocket** address — two different endpoints. See the companion
manager project under `qwd/` ([README](https://github.com/that-sky-project/that-sky-xysky-udp-room-authority/blob/main/README.md)).

## Requirements

- Node.js 20 or newer
- npm
- A C/C++ build toolchain for the native `sky-enet` module (on Windows: Visual Studio Build
  Tools / Desktop C++ workload; on Linux: `build-essential` + Python 3)
- An available UDP port reachable by clients

## Executable releases with GitHub Actions

`.github/workflows/build.yml` builds only **Windows amd64** (`windows-2022`) and
**Linux amd64** (`ubuntu-22.04`) with pinned Node **22.23.5**. Trigger **Build executables**
manually or by pushing a `v*` tag. Archives are uploaded as Actions artifacts for 30 days;
no GitHub Release is created automatically.

Outputs: `xysky-udp-<version>-windows-amd64.zip` and
`xysky-udp-<version>-linux-amd64.tar.gz`, plus SHA256 files. Extract and run
`xysky-udp.exe` / `./xysky-udp`; the target machine does not need Node installed.
This is a **Node SEA executable with required sidecar resources**, not a zero-sidecar
single file. Keep the resource directory (native ENet addon and Pino workers) alongside
it. Configuration remains editable. Release configuration uses neutral standalone/
loopback defaults with metrics disabled, not the repository's private deployment address.
Linux requires glibc (built on Ubuntu 22.04), not Alpine/musl. Windows executables are unsigned.

```bash
./xysky-udp --host 0.0.0.0 --port 7777 --public-uri 203.0.113.10:5413
# Windows: .\xysky-udp.exe --host 0.0.0.0 --port 7777 --public-uri 203.0.113.10:5413
```

Local builds require **Node 22.23.5**, Python 3 and a C/C++ toolchain:

```bash
npm ci --ignore-scripts
node node_modules/node-gyp/bin/node-gyp.js rebuild --directory=node_modules/sky-enet
npm run schema
npm run build:executable
npm run package:executable
```

esbuild/Pino's plugin bundle the application; postject injects SEA. Native resources
are built on the target platform. Archives are extracted again and their executable
is tested for help/version, ENet, metrics and JSON/pretty logging. Builds refuse to
overwrite a same-named output directory; preserve or move previous outputs first.

## Install And Run

```bash
npm install
npm start
```

With the checked-in deployment `config.yml` the node listens on:

```text
ENet UDP: 0.0.0.0:19133
```

TCP and UDP may share the same port number. Development mode with auto-reload: `npm run dev`.

### Command Line Options

Any flag passed on the command line overrides the same value in `config.yml`; flags you
omit keep the file value (or the built-in default).

```bash
node src/main.js \
  --config /etc/xysky/config.yml \
  --host 0.0.0.0 \
  --port 7777 \
  --public-uri 203.0.113.10:5413 \
  --qwd-url wss://your-qwd-host
```

| Flag | Meaning |
| --- | --- |
| `--config <PATH>` | YAML path (default: `./config.yml`); debug.yml is adjacent |
| `--host <HOST>` | ENet UDP bind hostname/IP |
| `--port <PORT>` | ENet UDP port, 1-65535 |
| `--public-uri <URI>` | Advertised `host:port` or `udp://host:port` |
| `--qwd-url <URL>` | `ws://` / `wss://` manager URL; `--qwd-url=` runs standalone |
| `--log-level <LEVEL>` | fatal / error / warn / info / debug / trace / silent |
| `--pretty`, `--no-pretty` | Enable human-readable logs / structured JSON |
| `--max-peers <COUNT>` | ENet connection slots, 1-4095 |
| `--channels <COUNT>` | ENet channels, 1-255 |
| `--tick-rate <HZ>` | Synchronization ticks/sec, 1-1000 |
| `--max-packet-bytes <BYTES>` | Accepted client packet bytes, 1-33554432 |
| `--bad-packet-limit <COUNT>` | Malformed-packet limit, 1-1000000 |
| `--move-timeout-ms <MS>` | Stuck-MOVING timeout, 1-2147483647 ms |
| `--player-state-decode <MODE>` | full / basic |
| `--metrics`, `--no-metrics` | Enable / disable Prometheus HTTP listener |
| `--metrics-host <HOST>` | Prometheus HTTP bind hostname/IP |
| `--metrics-port <PORT>` | Prometheus TCP port, 1-65535 |
| `-h`, `--help` | Generated help; exits normally without starting services |
| `-v`, `--version` | Package version; exits normally without starting services |

Commander handles help, version, unknown flags, missing values and rejected positional
arguments. Both `--port=7777` and `--port 7777` work. String fields (including numeric-looking
hostnames and config paths) remain strings; numeric values go through the shared schema.
Omitted boolean flags do not override the YAML file.

## Configuration

All configuration lives in **`config.yml`** (loaded from the working directory). The server
reads **no environment variables** — explicit CLI overrides > YAML values > schema defaults.
Relative config paths resolve from cwd; the runtime config records the absolute source path.
The checked-in deployment preserves port **19133**, channels **1**, public address
**192.168.11.4:19133** and pretty logs; these differ from the built-in defaults below.

The reusable, documented **Zod v4** schemas are exported as `configSchema` and
`debugFileSchema` from `src/config/schema.js`. Unknown configuration keys, null/empty YAML
documents, quoted numbers and quoted booleans fail explicitly; use `{}` for all defaults.
YAML syntax errors include the source path and line/column; validation uses Zod's readable
field-path diagnostics. No legacy aliases are accepted. Room identity is mutable runtime
state, not a configuration field.

`config.schema.json` and `debug.schema.json` are generated with Zod's native JSON Schema
converter: run **`npm run schema`** after editing the source schema. `config.yml` includes a
`yaml-language-server` schema directive; for debug.yml use
`# yaml-language-server: $schema=./debug.schema.json`. Bounds, defaults and descriptions come
from the schema source; URL refinements are authoritative in runtime validation and described
in the generated schemas.

Built-in defaults (not the checked-in deployment):

```yaml
logging:
  level: info             # pino level; use "debug" for protocol diagnostics
  pretty: true           # human-readable logs

room:
  host: 0.0.0.0           # ENet UDP bind address
  port: 19132             # ENet UDP schema default
  public_uri: 127.0.0.1:19132  # Advertised endpoint schema default
  max_peers: 64           # ENet connection slots (joined players still capped at 8)
  channels: 2             # ENet channels
  tick_rate: 10           # sync ticks per second
  max_packet_bytes: 16384 # max accepted client packet size
  bad_packet_limit: 8     # close a session after this many malformed packets
  move_timeout_ms: 20000  # revert a stuck MOVING session to ACTIVE after this (ms)
  player_state_decode: full  # full | basic (basic = position + velocity only)

qwd:
  url: ""                 # EMPTY => standalone. Set a wss:// address to use a QWD manager.
```

| Key | Default | Description |
| --- | --- | --- |
| `logging.level` | `info` | Pino log level |
| `logging.pretty` | `false` | Human-readable logs; no environment override |
| `room.host` | `0.0.0.0` | ENet UDP bind address |
| `room.port` | `19132` | ENet UDP port |
| `room.public_uri` | `127.0.0.1:19132` | Public UDP endpoint clients can reach |
| `room.max_peers` | `64` | ENet connection slots; joined players capped at 8 |
| `room.channels` | `2` | ENet channel count |
| `room.tick_rate` | `10` | Synchronization ticks per second |
| `room.max_packet_bytes` | `16384` | Maximum client packet size |
| `room.bad_packet_limit` | `8` | Malformed-packet limit before the session is closed |
| `room.move_timeout_ms` | `20000` | Revert a session stuck in MOVING back to ACTIVE after this |
| `room.player_state_decode` | `full` | `full` parses every `PlayerState` field; `basic` reads only `stateKind` + position + velocity |
| `qwd.url` | `""` | QWD WebSocket URL. **Empty = standalone, no manager connection.** |

### `room.public_uri`

This is the UDP address **clients must be able to reach**, which is often different from the
bind `host`. Behind NAT or on a cloud host, set it to your public `IP:Port` (for example
`123.123.123.123:19133`), not to `0.0.0.0`. It is the value reported to QWD and handed to
clients.

### Enabling / disabling QWD

- **Standalone:** leave `qwd.url: ""`. No manager connection or room registration occurs.
- **QWD-managed:** set `qwd.url: "wss://your-qwd-host"`. The node connects on startup, retries
  automatically on disconnect, and registers its `public_uri`.

### Prometheus and application lifecycle

Prometheus is disabled by default. Enable `metrics: { enabled: true, host: 127.0.0.1,
port: 9100 }`, or use `--metrics --metrics-host 127.0.0.1 --metrics-port 9100`.
Only `GET /metrics` is served with the registry's Prometheus content type; other
requests return 404. There is no authentication, so use a trusted scraping network.
The registry is isolated per application.

`main.js` loads configuration and logging, then `runtime/composition.js` explicitly
constructs services. `RoomServer` coordinates a single-use lifecycle; room identity,
telemetry, reservations and migration rosters have separate owners. ENet listens before
QWD registration. `reconnecting-websocket` owns backoff/reconnect and a public `ws`
adapter handles native send callbacks and heartbeat. `processLifecycle.js` stops
registered resources in reverse order, reports cleanup failures and flushes logging;
a 10-second deadline or second signal forces exit. Async commands/tick lanes are drained
before state cleanup, and the native listen loop ends before host destruction.

Packet handlers, codecs and feature-service implementations are outside this refactor.
The existing audience/authority cycle remains one explicit construction-time attachment.
Use `npm test`, `npm run check` and `npm run schema` for verification.

## Connection State Machine

```mermaid
stateDiagram-v2
    [*] --> CONNECTED
    CONNECTED --> PENDING: ENet connect
    PENDING --> ACTIVE: JoinGame / EnterGame
    ACTIVE --> MOVING: MoveGame
    MOVING --> ACTIVE: CancelMove or failed result
    ACTIVE --> CLOSED: disconnect
    MOVING --> CLOSED: move disconnect
```

## License

[GNU Affero General Public License v3.0](LICENSE).
