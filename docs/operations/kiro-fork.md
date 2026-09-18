# Install the Kiro fork on another host

The Windows desktop and mobile apps can connect to this fork through T3 Connect. To run agents on another computer, install the server and provider CLIs on that computer. Each host has its own projects, authentication, and T3 Connect identity.

The steps below use Ubuntu 24.04 in WSL 2. Run the shell commands inside the Linux distro, using its Linux Node.js installation. Keep the checkout and working repositories in the Linux filesystem, for example under `~/code`.

## Build the server

Install Git, Node.js 24.13.1 or newer in the Node 24 release line, and [Vite+](https://viteplus.dev/guide/). The repository's `package.json` records the required Node version.

The terminal dependency `node-pty` may need to compile from source. Install the native build tools before the JavaScript dependencies (omit `sudo` if already running as root):

```sh
sudo apt update
sudo apt install -y git curl ca-certificates build-essential python3 pkg-config
g++ --version
```

Use GCC/G++ 12.2 or newer for Node 24. Ubuntu 24.04 provides a suitable compiler. On Ubuntu 22.04, install `gcc-12 g++-12` and run installation with `CC=gcc-12 CXX=g++-12 vp i`. Installing `build-essential` alone on an older distro can leave an incompatible compiler. An error about an unrecognized `-std=gnu++20` flag means the compiler needs upgrading; changing that flag does not supply the missing C++ support.

On Ubuntu 20.04, GCC 12 is available from the [Ubuntu toolchain PPA](https://wiki.ubuntu.com/ToolChain). To keep that distro, install the compiler alongside its existing one:

```sh
sudo apt update
sudo apt install -y software-properties-common
sudo add-apt-repository -y ppa:ubuntu-toolchain-r/test
sudo apt update
sudo apt install -y build-essential python3 gcc-12 g++-12
g++-12 --version
```

Then use `CC=gcc-12 CXX=g++-12 vp i && vp run --filter t3 build`. No global compiler switch is needed. These tools resolve the native Node dependency build; Kiro CLI must also support the distro's runtime libraries. Check `kiro-cli --version` after installation. Current Kiro provides a musl build for Linux hosts that do not meet its GNU binary's glibc requirement; see the [installation requirements](https://kiro.dev/docs/getting-started/installation/).

```sh
curl -fsSL https://vite.plus | bash
```

Open a new WSL terminal so `vp` is available. Clone the fork's Kiro branch:

```sh
mkdir -p ~/code
cd ~/code
git clone --branch feat/kiro-acp https://github.com/jcbebr/t3code-kiro.git
cd t3code-kiro
cp .env.example .env
vp i && vp run --filter t3 build
```

Copy `.env.example` before building: it supplies the public application identifiers for the production T3 Connect service. It contains no account credentials. For an existing checkout, preserve any local settings when updating `.env`.

Keep this checkout and its installed dependencies. The built server uses modules outside `dist`; copying that folder alone is not a portable installation.

## Sign in to Kiro inside WSL

Install [Kiro CLI](https://kiro.dev/docs/cli/) in the distro:

```sh
curl -fsSL https://cli.kiro.dev/install | bash
```

Open a new terminal if necessary, then check `kiro-cli --version`. This integration was validated with Kiro CLI 2.22.0 on Linux; the installer downloads the current version, so verify a conversation and session resume after installing or upgrading it.

For organization login, replace the Start URL and region with your organization's values:

```sh
kiro-cli login --license pro \
  --identity-provider https://YOUR_ORGANIZATION.awsapps.com/start \
  --region us-east-1 --use-device-flow
```

Complete the printed authorization link in the Windows browser. Kiro and the T3 server must run as the same Linux user. Other providers also need their CLI and login inside this distro.

## Link the new host to T3 Connect

From the checkout root:

```sh
node apps/server/dist/bin.mjs connect link \
  --base-dir "$HOME/.t3-kiro" --headless

node apps/server/dist/bin.mjs serve \
  --base-dir "$HOME/.t3-kiro" --host 127.0.0.1 --port 3773
```

Accept installation of the tunnel helper when requested and authorize the printed T3 Connect link using the same account as your desktop and phone. Keep the server terminal open for the first test. If port 3773 is already occupied, use a free port for this server.

Both commands must use the same `--base-dir`. Start with a new data directory; copying another running host's `environment-id` or `secrets` would duplicate its identity. Data migration is a separate operation.

In the Windows desktop, select the newly linked environment. For initial provider configuration, use this fork's web UI by opening the server's startup pairing URL in the Windows browser. In **Settings → Providers**, add Kiro and enable it. Set the Linux executable path returned by `command -v kiro-cli` if it is absent from the server's PATH. The official desktop can use an already configured Kiro instance, but its provider settings may lack this fork's Kiro-specific fields.

Add a project folder from inside WSL, start a thread with **Kiro → Kiro default**, and send a short text-only prompt. [Kiro provider guidance](../user/kiro.md) covers permissions and current limitations. The phone uses the same T3 Connect account and selects this host.

## Optional background service in WSL

First confirm the foreground server works, then stop that server with Ctrl+C. Follow [Microsoft's systemd setup](https://learn.microsoft.com/en-us/windows/wsl/systemd) if your distro does not have systemd enabled. Restarting WSL with `wsl --shutdown` stops everything in that distro, so finish active work first.

Create a **custom** user service for the fork. Replace every `/home/YOU` path and the Node executable with the absolute paths on the new host (`pwd` and `command -v node`). Save as `~/.config/systemd/user/t3code-kiro.service`:

```ini
[Unit]
Description=T3 Code with Kiro
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/YOU/code/t3code-kiro
Environment=PATH=/home/YOU/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/absolute/path/to/node /home/YOU/code/t3code-kiro/apps/server/dist/bin.mjs serve --base-dir /home/YOU/.t3-kiro --host 127.0.0.1 --port 3773 --no-browser
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=90
UMask=0077

[Install]
WantedBy=default.target
```

Include your Linux Node `bin` directory in `PATH` too if providers installed through npm need it. Then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now t3code-kiro.service
systemctl --user status t3code-kiro.service
```

This starts the service when the user manager runs. Enabling lingering with `loginctl enable-linger "$USER"` can start the user manager at distro boot, subject to the distro's permissions. **A systemd service does not keep WSL alive.** Windows must remain awake and the distro running for desktop or phone access; automatic Windows startup is a separate WSL configuration.

## Update the fork

The server must continue running this checkout's build. `npx t3`, the official installer, and the built-in `t3 service install`, `t3 service update`, or `t3 update` commands select upstream releases and do not install this integration.

On a host that consumes the fork, finish active tasks, stop its custom service, and update from the Kiro branch:

```sh
git pull --ff-only
vp i
vp run --filter t3 build
systemctl --user start t3code-kiro.service
```

Take a consistent backup of the host's T3 data before upgrading across upstream versions. Keep an older build available until startup and T3 Connect have been verified.

On the checkout where you maintain the fork, keep the original project as an `upstream` remote and merge its changes into the Kiro branch, resolving conflicts and running the relevant checks before publishing. Creating a fork does not require sending an upstream pull request. Never commit CLI credentials, local environment files, T3 data, or pairing links.
