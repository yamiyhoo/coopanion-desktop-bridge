# coopanion-desktop-bridge

The Coopanion pet bridge for the **DSH desktop application** — the Host half that lives inside the
Electron process and opens its own loopback port.

## Why this exists instead of using the web bridge

The web build of this bridge hangs its WebSocket off `ctx.webServer`. The desktop Host does not have
that service, and two independent checks say so:

- `dsh-desktop-host/lib/index.js` describes itself as booting the project **"without a listening
  socket"**, carrying the API over framed byte pipes;
- its shipped patch layer, applied **after** any user layer, contains `- id: webserver /
  disabled: true`, so no profile edit can turn it back on;
- a probe run inside the Electron host reported `missing: webServer, webStartup, webRuntime`, and
  — in the same run — `listener ok=true roundTrip=true` for `http.createServer().listen()`.

So the desktop side needs a plugin that owns a socket rather than one that borrows the Host's. That
is what this package is. Everything above the socket is the same contract as the web bridge.

## What it does

```
pet ──ws──▶ 127.0.0.1:19400/coopanion/pet ──▶ followup() ──▶ the conversation a person last spoke in
    ◀── ready / reply / tool / approval / turn-* ──┘
```

- **Speaks into the right conversation.** The owning session is *the one a person last typed in*
  (falling back to a `pick`, then to creation order). A `user/message` the bridge itself submitted is
  not evidence of a person: it is tracked by message id and by the `（通过桌宠）说：` prefix.
- **Names what it is talking to.** `ready` and `accepted` carry the conversation's `title`, so
  "delivered" can be checked against the window a person is looking at.
- **Lists conversations.** `{t:'sessions'}` (and `GET /coopanion/sessions`) returns the newest 20 with
  `short` id, `title`, `live` and `pickable`. A conversation this Host does not hold is listed
  read-only and `pick` refuses it — listing it as ordinary would rebuild the illusion that a message
  delivered somewhere was delivered where the person is looking.

Read-only HTTP for hand-checking:

| route | |
| --- | --- |
| `GET /coopanion/status` | version, bound port, pet connected, owning session and its title, how it was chosen |
| `GET /coopanion/sessions` | the same listing the pet asks for over the socket |

Both answer loopback requests only (a non-loopback `Host` header gets `403`), and both are read-only.

## Install

Into a profile, by the same two routes as any DSH bundle — **copy-style only**:

```
dsh plugin --profile <profile> add https://github.com/yamiyhoo/coopanion-desktop-bridge
```

The desktop profile is managed by the Electron application, so the CLI refuses it; install there from
the app's plugin market with the repository URL, or copy the package into
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\coopanion-desktop-bridge` and add its name to
`dsh.profile.bundles` in that profile's `package.json`.

**Never `link:` it.** The desktop Host rejects a profile bundle whose real path resolves outside the
profile or runtime directory, and then the application does not start.

The row is declared `required: false`, so a bundle that fails to resolve leaves the Host booting
normally — an empty log means *the plugin did not load*, not that the bridge found nothing.

## Configuration

```yaml
- insert:
    - id: coopanion-desktop-bridge
      name: coopanion-desktop-bridge
      required: false
      config:
        port: 19400     # optional; 19400 by default. 0 asks the OS for a free one.
        sessions: 20    # optional; how many conversations one listing may carry.
```

The pet side points at it in Coopanion: `worlds.fatfish.url` =
`ws://127.0.0.1:19400/coopanion/pet`. Port 19387 stays with the web bridge; the two can run at once.

## Diagnostics

The desktop Host provides no `logger` service, so the bridge writes its own JSONL:
`%USERPROFILE%\.dsh\logs\coopanion-desktop-bridge.jsonl` (and stdout). One `load` line per boot names
the process, the Electron version and the port; every warning after it says what failed.

## Safety

- `apply` never throws: it runs while a person's application boots.
- A port already in use is reported in `/coopanion/status` (`listenError`) and in the log, never raised.
- The listener accepts upgrade requests only on `/coopanion/pet`, from loopback, and everything else is
  destroyed.
- No dependencies at install time beyond a prebuilt `dist/index.cjs`; `ws` is bundled into it.

## Licence

AGPL-3.0-or-later.
