# Very Important

Automation of Whatsapp Messages without Meta (Business-)API is against WhatsApp' Terms of Service! 
You take full responsibility for everything you do with this MCP-Server. It is possible that your account will be flagged/restricted.

# MCP WhatsApp Web (TypeScript)

A Model Context Protocol (MCP) server for WhatsApp Web, implemented in TypeScript. This project is a TypeScript port of the original [whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) repository.

With this MCP server, you can:
- Search and read your personal WhatsApp messages (including media)
- Search your contacts
- Send messages to individuals or groups
- Send and receive media files (images, videos, documents, audio)

![image](https://github.com/user-attachments/assets/7a28ff03-8f52-40f9-b676-2df1ebae0005)
![image](https://github.com/user-attachments/assets/105e42c3-2f4d-49cf-9be1-f7d481e5a11b)


## Features

- **TypeScript Implementation**: Fully typed codebase for better developer experience and code reliability
- **Selectable WhatsApp Backend**: Uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) by default, with an optional [Baileys](https://github.com/WhiskeySockets/Baileys) backend that runs without a browser
- **MCP Server**: Implements the [Model Context Protocol](https://modelcontextprotocol.io/) for seamless integration with AI assistants
- **Media Support**: Send and receive images, videos, documents, and audio messages
- **Multiple Transport Options**: Supports stdio and Streamable HTTP transports — even both at once from a single process (start with stdio and set `MCP_HTTP_PORT` to additionally expose `http://127.0.0.1:<port>/mcp`, or run HTTP-only with `--http`)
- **Flexible Authentication**: QR code (as an MCP image tool), pairing code (`request_pairing_code` tool, or automatically printed to stderr at startup via `WHATSAPP_PAIRING_PHONE_NUMBER`), and owner-authenticated HTTP with optional OAuth (`MCP_OAUTH=true`) and explicit client consent — unlinking WhatsApp revokes tokens so clients automatically re-authenticate

## Architecture

This MCP server consists of:

1. **TypeScript MCP Server**: Implements the Model Context Protocol to provide standardized tools for AI assistants to interact with WhatsApp
2. **WhatsApp Backend**: A shared service interface selects web.js/Puppeteer or Baileys/WebSocket, handles authentication, and manages message sending/receiving
3. **Tool Implementations**: Provides various tools for contacts, chats, messages, media, and authentication

## Prerequisites

- Node.js >= 22.19.0 (Node 22 or 24 recommended for the Baileys SQLite dependency)
- npm or yarn
- For the default `webjs` backend: Google Chrome or Microsoft Edge (auto-detected; needed for video/GIF codec support; other operations can use an explicitly installed compatible Chromium)
- For `baileys`: install optional dependencies, including the native `better-sqlite3` module. No Chrome, Edge, or Chromium is needed at runtime.

FFmpeg is bundled automatically via the `ffmpeg-static` npm package — no manual installation needed. You can point the `FFMPEG_PATH` environment variable at your own binary to override it.

## Installation

### Manual Installation

1. **Clone this repository**

   ```bash
   git clone https://github.com/mario-andreschak/mcp-whatsapp-web.git
   cd mcp-whatsapp-web
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Build the project**

   ```bash
   npm run build
   ```

4. **Configure environment variables (optional)**

   Copy the example environment file and modify as needed:

   ```bash
   cp .env.example .env
   ```

   You can select the backend with `WHATSAPP_BACKEND`, adjust logging levels, pin the WhatsApp Web version, or override the auto-detected browser (`BROWSER_EXECUTABLE_PATH`) and ffmpeg binary (`FFMPEG_PATH`). `WHATSAPP_HEADLESS=false` shows the web.js browser window, and `WHATSAPP_SESSION_DIR` relocates its persistent profile. Use an absolute session directory to keep it consistent across working directories.

### Choosing a backend

`WHATSAPP_BACKEND=webjs` is the default and preserves existing sessions and MCP tool names. It uses a dedicated persistent `LocalAuth` profile, not your personal Chrome profile. It now keeps the browser's native user agent and graphics defaults, omits Puppeteer's automation banner flag, and leaves the browser sandbox enabled. Containers that require disabling the sandbox can explicitly set `WHATSAPP_NO_SANDBOX=true`. These settings do not guarantee that automation is undetectable.

To use the optional Baileys backend, set these variables in your MCP client configuration or `.env`, then restart the server:

```dotenv
WHATSAPP_BACKEND=baileys
BAILEYS_SESSION_DIR=C:/path/to/your/baileys-sessions
```

`BAILEYS_SESSION_DIR` defaults to `<working directory>/baileys-sessions`; the example above should be replaced with your own absolute directory. Pair this backend separately with `get_qr_code` or `request_pairing_code`. The existing `WHATSAPP_PAIRING_PHONE_NUMBER` option also works. Baileys cannot reuse the web.js browser profile. You can switch back to `webjs` and resume its existing session.

Baileys and SQLite are pinned optional dependencies installed by normal `npm install`. If your package manager omitted them, run `npm install --include=optional`. SQLite uses a native addon; a supported prebuilt binary or a local native build toolchain is required. To avoid downloading Chromium when installing for Baileys or an existing system browser, use:

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm install --include=optional
npm run build
```

On macOS/Linux, the equivalent installation command is `PUPPETEER_SKIP_DOWNLOAD=true npm install --include=optional`. Selecting Baileys loads only its driver and never starts or cleans up browser processes. An unavailable backend produces an error; it never silently switches drivers or retries a send through another backend.

### Baileys sessions and history

- Credentials, Signal keys, contacts, chats and messages persist in `BAILEYS_SESSION_DIR/session.sqlite`. Keep the whole directory private and out of version control. Only one running server may own a session directory. Use separate directories for independent accounts.
- Normal shutdown preserves the session. Explicit logout or invalid authentication clears the Baileys credentials and cached account data, and revokes its OAuth access tokens. Baileys HTTP OAuth state is stored separately from web.js in `BAILEYS_SESSION_DIR/oauth-store.json`.
- `get_backend_status` reports the active backend, authentication, stored record counts and history synchronization state. Being connected does not mean history has finished arriving. An `available` history state means local data is available, not that WhatsApp supplied a complete archive.
- Contact and history tools query the local synchronized store. Initial full-history sync is requested and can take time on large accounts. `list_messages` may request up to 100 additional older messages when a known chat has fewer than requested, with a bounded wait and a per-chat cooldown. Late history batches are persisted for subsequent queries. WhatsApp may still supply only part of an account's history.
- Treat returned message IDs as opaque and use IDs from the active backend. Legacy `@c.us` phone-number inputs, `@s.whatsapp.net`, groups and `@lid` identifiers are supported; known LID/phone mappings are persisted. Message IDs from web.js cannot be passed to Baileys or vice versa.
- Text, media, downloads, voice notes and the existing authentication tools use the same MCP interface. Voice-note inputs must be local files or base64; FFmpeg converts them to mono Opus/Ogg before sending. If conversion fails, the tool reports an error without sending a different message type.

The Baileys backend is opt-in and pinned to `7.0.0-rc14`. Review upstream changes before upgrading, especially authentication and message-format migrations. See the [Baileys documentation](https://baileys.wiki/) and [release history](https://github.com/WhiskeySockets/Baileys/releases).

### Installation with FLUJO

[FLUJO](https://github.com/mario-andreschak/FLUJO/) provides a streamlined installation process:

1. Navigate to the MCP section in FLUJO
2. Click "Add Server"
3. Copy and paste this GitHub repository URL: `https://github.com/mario-andreschak/mcp-whatsapp-web`
4. Click "Parse", "Clone, "Install", "Build" and "Update Server"

FLUJO will automatically handle the cloning, dependency installation, and building process for you.

## Usage

### Starting the MCP Server

```bash
npm start
```

This will start the MCP server using stdio transport by default, which is suitable for integration with Claude Desktop or similar applications.

> **Important:** After starting the server for the first time, you must authenticate with WhatsApp by using the `get_qr_code` tool and scanning the QR code with your phone. See the [Authentication](#authentication) section for detailed instructions.

### HTTP authentication and owner consent

Every HTTP listener requires `MCP_OPERATOR_TOKEN`, including loopback listeners and HTTP exposed alongside stdio. Generate a random URL-safe token, keep it in a private environment or secret store, and configure clients to send it as `Authorization: Bearer ...` when OAuth is disabled. Stdio does not require this token.

```dotenv
MCP_HTTP_PORT=3001
MCP_HTTP_HOST=127.0.0.1
# Required for HTTP: replace with 32–256 random URL-safe characters.
MCP_OPERATOR_TOKEN=replace-with-a-random-generated-secret
# Optional: issued OAuth grants replace the owner token on /mcp.
MCP_OAUTH=true
```

With OAuth enabled, each client authorization opens an owner consent page. Enter the operator token there, review the client's name and callback URI, link WhatsApp if needed, and click **Authorize this client**. A linked account does not automatically approve a new client. The page keeps the operator token in memory; it is never put in a URL, cookie, or browser storage. QR/status/pairing/approval endpoints require owner authentication. OAuth clients use their issued token on `/mcp`; the operator token is reserved for approving them.

This is one account per server process. Every explicitly approved client can read and send messages and unlink that account. Run separate processes with separate absolute session directories and separate owner tokens for independent accounts. HTTP uses stateless MCP request handling; it does not share MCP session IDs between clients.

For a reverse proxy, configure `MCP_PUBLIC_URL=https://whatsapp.example.com` and preserve that public **Host** header upstream. Non-loopback binding requires an HTTPS public URL. Incoming Host, scheme and port must match the configured public address. Browser Origins must exactly match it or an entry in `MCP_ALLOWED_ORIGINS` (comma-separated absolute origins). Wildcard and opaque `null` Origins are rejected. Missing Origin is permitted for authenticated native clients. Do not derive the public URL from forwarded request headers.

OAuth grants are bound to the canonical issuer/resource and the absolute account directory. Logout/session invalidation revokes tokens, pending approvals and codes. Codes expire after 60 seconds, approvals after 15 minutes, and access tokens after 30 days. State has bounded capacities of 256 clients, pending approvals, codes and tokens. Private OAuth files contain hashed access tokens and client registration credentials. Stop the server and remove its `oauth-store.json` to reset registrations/grants if needed; this does not remove the WhatsApp profile.

**Upgrade:** unauthenticated HTTP is removed. Configure the operator token before restarting HTTP deployments. Old unbound OAuth grants are intentionally rejected: authorize clients again. web.js OAuth state now lives in `WHATSAPP_SESSION_DIR/oauth-store.json`; Baileys uses `BAILEYS_SESSION_DIR/oauth-store.json`. Existing WhatsApp profiles remain usable.

### Protocol and runtime limits

The server explicitly serves MCP revision **2026-07-28** through SDK 2, with legacy 2025 stdio/Streamable HTTP compatibility. It advertises implemented tools and their read/write annotations; it does not advertise unused logging or client roots capabilities. Tool schemas remain the source of truth for accepted inputs. Modern raw HTTP clients must send matching `Mcp-Protocol-Version`, `Mcp-Method`, and, for named calls, `Mcp-Name` headers.

Tool calls time out after 60 seconds by default (`MCP_TOOL_TIMEOUT_MS`, 100–300000 ms), with at most 32 pending provider operations. Cancellation/timeout prevents the tool from starting its next backend operation. Providers cannot roll back a send already in flight: after an ambiguous failure, check the chat before retrying. Audio conversion uses a directly spawned FFmpeg process with a 60-second deadline and a 64 MiB local input limit.

`node dist/index.js --no-connect` (or `MCP_AUTO_CONNECT=false`) exposes protocol discovery, ping and backend status without connecting to WhatsApp. This is intended for diagnostics and release tests. Normal startup still connects in the background. Closing stdio input shuts down the process and releases its driver.

The npm tarball bundles web.js and its resolved Puppeteer 25 dependency tree, because npm ignores a dependency's `overrides` when installing it downstream. No browser binary is included. Use system Chrome/Edge (auto-detected) or `BROWSER_EXECUTABLE_PATH`; alternatively install the matching Puppeteer browser explicitly. Source checkouts install it during normal `npm ci` unless `PUPPETEER_SKIP_DOWNLOAD=true` is set. The release gate checks the actual installed Puppeteer version and Chromium launch.

### Development Mode

```bash
npm run dev
```

This starts the server in development mode with TypeScript watch mode and automatic server restarts.

### Debugging with MCP Inspector

```bash
npm run debug
```

This launches the MCP Inspector tool, which provides a web interface for testing and debugging your MCP server. The inspector allows you to:

- View all available tools and their schemas
- Execute tools directly and see their responses
- Test your server without needing to connect it to an AI assistant
- Debug tool execution and inspect responses

### Connecting to Claude Desktop

1. Create a configuration file for Claude Desktop:

   ```json
   {
     "mcpServers": {
       "whatsapp": {
         "command": "node",
         "args": [
           "PATH_TO/dist/index.js"
         ]
       }
     }
   }
   ```

   Replace `PATH_TO` with the absolute path to the repository.

2. Save this as `claude_desktop_config.json` in your Claude Desktop configuration directory:

   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Linux: `~/.config/Claude/claude_desktop_config.json`

3. Restart Claude Desktop

### Connecting to Cursor

1. Create a configuration file for Cursor:

   ```json
   {
     "mcpServers": {
       "whatsapp": {
         "command": "node",
         "args": [
           "PATH_TO/dist/index.js"
         ]
       }
     }
   }
   ```

   Replace `PATH_TO` with the absolute path to the repository.

2. Save this as `mcp.json` in your Cursor configuration directory:

   - macOS/Linux: `~/.cursor/mcp.json`
   - Windows: `%USERPROFILE%\.cursor\mcp.json`

3. Restart Cursor

## Authentication

The first time you run the server, you'll need to authenticate with WhatsApp:

1. Start the MCP server
2. **Important:** You must use the `get_qr_code` tool to generate a QR code
   - In Claude or other AI assistants, explicitly ask to "use the get_qr_code tool to authenticate WhatsApp"
   - The assistant will call this tool and display the QR code image
3. Scan the QR code with your WhatsApp mobile app
   - Open WhatsApp on your phone
   - Go to Settings > Linked Devices > Link a Device
   - Point your phone camera at the QR code displayed

Your session will be saved locally in the `whatsapp-sessions` directory and will be reused automatically on subsequent runs. If you don't authenticate using the QR code, you won't be able to use any WhatsApp functionality.

### Authentication Status and Logout

You can check your current authentication status and manage your session:

- Use the `check_auth_status` tool to verify if you're currently authenticated
- If you need to authenticate with a different WhatsApp account or re-authenticate:
  1. Use the `logout` tool to log out from your current session
  2. Then use the `get_qr_code` tool to authenticate with a new QR code

This is particularly useful when:
- You want to switch between different WhatsApp accounts
- Your session has expired or been invalidated
- You're experiencing connection issues and need to re-authenticate

## Available MCP Tools

`check_auth_status`, `download_media`, `get_backend_status`, `get_chat_by_id`, `get_contact_by_id`, `get_direct_chat_by_contact_number`, `get_last_interaction`, `get_message_by_id`, `get_message_context`, `get_qr_code`, `list_chats`, `list_messages`, `logout`, `ping`, `request_pairing_code`, `search_contacts`, `send_media`, `send_message`.

Use `tools/list` for input schemas. `send_media` supports files, URLs, base64 and voice-note conversion; `list_messages` returns the provider's message event types, not only text.

## Browser Process Management

This MCP server uses Puppeteer to control Chrome browsers for WhatsApp Web connectivity. The server includes a robust browser process management system to prevent orphaned Chrome processes.

### Automatic Browser Cleanup

The server automatically:
- Tracks Chrome browser processes using a PID tracking system
- Cleans up orphaned processes on startup
- Properly closes browser processes during shutdown
- Maintains a record of browser PIDs in `.chrome-pids.json`

### Manual Browser Cleanup

If you notice orphaned Chrome processes that weren't automatically cleaned up, you can use the included cleanup utility:

```bash
npm run cleanup-browsers
```

This utility will:
1. Scan for Chrome processes that might be related to WhatsApp Web
2. Display a list of potentially orphaned processes
3. Ask for confirmation before terminating them
4. Clean up the PID tracking file

## Development

### Project Structure

- `src/index.ts`- Entry point
- `src/server.ts`- MCP server implementation
- `src/services/whatsapp.ts`- WhatsApp Web service
- `src/tools/`- Tool implementations for various WhatsApp features
- `src/types/`- TypeScript type definitions
- `src/utils/`- Utility functions

### Scripts

- `npm run build`- Build the TypeScript code
- `npm run dev`- Run in development mode with watch
- `npm run lint`- Run ESLint
- `npm run format`- Format code with Prettier
- `npm run cleanup-browsers`- Detect and clean up orphaned Chrome browser processes
- `npm test` - Run the unit test suite (fast, no browser needed)
- `npm run test:watch` - Run unit tests in watch mode during development
- `npm run test:e2e` - Build and test actual compiled stdio/HTTP entry points with isolated state and no WhatsApp connection
- `npm run test:package` - Install the production-only tarball, verify both protocol eras/backends, native SQLite/FFmpeg and installed browser dependencies
- Set `RUN_BROWSER_TESTS=true` to include real Chromium owner-consent and installed browser-driver tests

## Troubleshooting

### Authentication Issues

- If the QR code doesn't appear, try restarting the server
- If you're already authenticated, no QR code will be shown (use `check_auth_status` to verify)
- If you need to re-authenticate, use the `logout` tool first, then request a new QR code
- WhatsApp limits the number of linked devices; you may need to remove an existing device
- If you receive a message saying "No QR code is currently available," but you're already authenticated, this is normal behavior - use `check_auth_status` to confirm your authentication status

### Connection Issues

- Make sure you have a stable internet connection
- If the connection fails, try restarting the server
- Check the logs for detailed error messages

### Browser Process Issues

- If you notice high CPU usage or memory consumption, there might be orphaned Chrome processes
- Run `npm run cleanup-browsers` to detect and clean up orphaned processes
- If the server crashes frequently, check for orphaned processes and clean them up
- On Windows, you can also use Task Manager to look for multiple Chrome processes with "headless" in the command line
- On Linux/macOS, use `ps aux | grep chrome` to check for orphaned processes

## License

MIT

---

This project is a TypeScript port of the original [whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) by [lharries](https://github.com/lharries).

## Verification scope

CI runs Node 22/24 on Linux and Windows, plus Node 24 on macOS. It covers offline web.js/Baileys adapters, real SQLite persistence, real FFmpeg conversion, HTTP authorization, a real Chromium consent page, raw modern and legacy protocol exchanges, and the installed npm tarball. No live WhatsApp login, message send, or production host acceptance is automated. Offline fixtures cannot establish that WhatsApp will accept a real account or supply complete history; upstream service changes still require a separately authorized live acceptance check.

Primary compatibility references: [SDK 2 protocol migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28), [web.js guide](https://wwebjs.dev/guide/), [Baileys migration guidance](https://baileys.wiki/).
