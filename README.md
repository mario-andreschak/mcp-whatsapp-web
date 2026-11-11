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
- **Webhooks** (Baileys): signed notifications for new messages and for incoming calls, including who is calling
- **Multiple Transport Options**: Supports stdio and Streamable HTTP transports — even both at once from a single process (start with stdio and set `MCP_HTTP_PORT` to additionally expose `http://127.0.0.1:<port>/mcp`, or run HTTP-only with `--http`)
- **Flexible Authentication**: QR code (as an MCP image tool), pairing code (`request_pairing_code` tool, or automatically printed to stderr at startup via `WHATSAPP_PAIRING_PHONE_NUMBER`), and an optional OAuth flow for HTTP clients (`MCP_OAUTH=true`) where the browser authorization page shows the WhatsApp QR code — unlinking WhatsApp revokes tokens so clients automatically re-authenticate

## Architecture

This MCP server consists of:

1. **TypeScript MCP Server**: Implements the Model Context Protocol to provide standardized tools for AI assistants to interact with WhatsApp
2. **WhatsApp Backend**: A shared service interface selects web.js/Puppeteer or Baileys/WebSocket, handles authentication, and manages message sending/receiving
3. **Tool Implementations**: Provides various tools for contacts, chats, messages, media, and authentication

## Prerequisites

- Node.js >= 22.0.0 (Node 22 or 24 recommended for the Baileys SQLite dependency)
- npm or yarn
- For the default `webjs` backend: Google Chrome or Microsoft Edge (auto-detected; needed for video/GIF codec support; other operations can use Puppeteer's bundled Chromium)
- For `baileys`: install optional dependencies, including the native `better-sqlite3` module. No Chrome, Edge, or Chromium is needed at runtime.

FFmpeg is bundled automatically via the `ffmpeg-static` npm package — no manual installation needed. You can point the `FFMPEG_PATH` environment variable at your own binary to override it.

## Installation
### npx
   ```bash
   npx mcp-whatsapp-web
   ```


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

Baileys links as a Chrome device (shown as "Chrome (Windows)" or "Chrome (Mac OS)" under Linked devices). WhatsApp currently ends new links that claim to be the Desktop app with status 428 ("Connection Terminated") before a QR code appears. Desktop would request the full chat history; Chrome receives recent history, and live messages are stored from then on. `BAILEYS_BROWSER=Desktop` restores the old behaviour. At startup the backend also looks up the current WhatsApp Web version from `web.whatsapp.com`, because WhatsApp refuses clients that report an outdated one; `WA_WEB_VERSION` pins it, and a failed lookup falls back to the version bundled with Baileys.

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

### Voice notes

Voice notes arrive as audio, so on their own they show up as `"type": "ptt"` with an empty body. Transcription is off by default; to turn it on, point `WHATSAPP_TRANSCRIBE_COMMAND` at a speech-to-text command. The server converts each voice note to a 16 kHz mono WAV file, runs the command once per batch with the file paths appended, and reads one JSON line per file:

```json
{"file": "C:\\Temp\\wa-voice-x\\0.wav", "text": "Hallo zusammen, kurz zum Termin morgen ..."}
```

A command given a single file may also print plain text. Any engine works this way (faster-whisper, whisper.cpp, a script calling a hosted API). The command decides where the audio goes: a local engine keeps voice notes on the machine.

`examples/transcribe-faster-whisper.py` is a ready-made local command (`pip install faster-whisper`). It reads `WHISPER_MODEL` (default `large-v3`), `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE`, `WHISPER_LANGUAGE` and `WHISPER_PROMPT` (names and terms that often come up), for example:

```dotenv
WHATSAPP_TRANSCRIBE_COMMAND=C:/whisper/venv/Scripts/python.exe C:/path/to/mcp-whatsapp-web/examples/transcribe-faster-whisper.py
WHISPER_DEVICE=cuda
WHISPER_COMPUTE_TYPE=int8_float16
WHISPER_LANGUAGE=de
HF_HUB_OFFLINE=1
```

Then `list_messages` with `transcribe_voice_notes: true` returns each voice note with a `transcript` field (or `transcriptError`), and `transcribe_voice_notes` transcribes given message IDs. Each voice note is transcribed once: the Baileys backend stores transcripts beside the chat history and deletes them with their message, on chat deletion and on logout; web.js keeps them for the life of the process. Only one transcription runs at a time. The first batch includes loading the model, so allow a few minutes (`WHATSAPP_TRANSCRIBE_TIMEOUT_MS`, default 15 minutes).

### Message events (webhooks)

With the Baileys backend, the server can post each new message to a URL as a signed webhook, instead of being asked for messages on a timer. Deliveries use [Standard Webhooks](https://www.standardwebhooks.com/) signing and the webhook part of the [MCP events draft](https://github.com/modelcontextprotocol/experimental-ext-triggers-events).

Events are kept in the session database, so nothing is lost if either side is away:

- A receiver that is down gets everything it missed, in order, once it answers again. Retries back off from 5 seconds up to an hour, and a repeat delivery keeps the same `webhook-id`.
- Messages that arrive while this server is offline are delivered when WhatsApp hands them over on reconnect.
- `503`, `425` and `429` mean "not now" and honour `Retry-After`. `410` ends the subscription.

Voice notes carry a `transcript` when transcription is configured. Only messages newer than the subscription are delivered, and your own messages are skipped unless asked for.

An MCP client such as FLUJO subscribes through the `events/list` and `events/subscribe` protocol methods. These are deliberately not tools, so a model cannot create a subscription. Subscriptions expire after 7 days unless refreshed. Receivers must be on this machine unless `WHATSAPP_EVENTS_ALLOW_REMOTE=1` is set, and then they must use https.

Anything else can be configured directly:

```dotenv
WHATSAPP_WEBHOOK_URL=http://127.0.0.1:5678/webhook/whatsapp
WHATSAPP_WEBHOOK_SECRET=whsec_<base64 of 24 to 64 random bytes>
WHATSAPP_WEBHOOK_CHAT_IDS=120363000000000000@g.us
# Optional. Which events this receiver gets; the default is message.received only.
WHATSAPP_WEBHOOK_EVENTS=message.received,call.received,call.ended
```

### Call events (webhooks)

The Baileys backend can also tell a receiver when someone calls, for example to show a "who is calling" window. There are two events:

- `call.received`: a voice or video call is ringing right now.
- `call.ended`: that call stopped ringing. `reason` says how: `missed` (nobody answered), `rejected` (declined on one of your devices or with `reject_call`), `answered_elsewhere` (picked up on another device) or `ended` (the caller hung up, or the server lost track of the call for three minutes).

A ringing popup is only useful while the phone rings, so calls are treated differently from messages:

- Only live calls count. A call that came in while the server was offline, or that is already more than a minute old when it arrives, never produces `call.received`.
- A `call.received` that cannot be delivered within a minute of the call (receiver down, retries still waiting) is dropped instead of delivered late. The matching `call.ended` is still delivered, with the usual retries, so the receiver always learns how the call ended. A receiver should simply ignore a `call.ended` for a call it never saw.
- `call.ended` is only sent for calls that were announced as ringing.

Deliveries use the same envelope, signing, retries and cursor as messages:

```json
{ "eventId": "evt_…", "name": "call.received", "timestamp": "2026-11-10T21:04:05.000Z", "cursor": "42",
  "data": { "callId": "…", "chatId": "4915550001@s.whatsapp.net", "from": "4915550001@s.whatsapp.net",
            "isVideo": false, "isGroup": false, "status": "ringing",
            "contact": { "id": "4915550001@s.whatsapp.net", "name": "Alice", "pushname": "Ali",
                         "number": "4915550001", "isMyContact": true } } }
```

`call.ended` has the same `data`, with `reason` in place of `status`. In `contact`, `name` is the name saved in your address book (or `null`), `pushname` is the name the caller chose in WhatsApp (or empty) and `number` is the phone number. If the caller cannot be looked up, the call is still announced with `name: null` and the number taken from the caller's id. Callers who only show up with a private WhatsApp id are matched to their number when WhatsApp sends it along; otherwise `number` is empty. For a group call, `chatId` is the group.

To receive calls, subscribe to `call.received` and `call.ended` with `events/subscribe` (one subscription per event name; `chat_ids` limits them to certain chats or callers, `include_own` does not apply), or add them to `WHATSAPP_WEBHOOK_EVENTS` for the configured receiver.

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
         "command": "npx",
         "args": [
           "mcp-whatsapp-web"
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

### Authentication
- `get_qr_code`- Get the QR code for WhatsApp Web authentication
- `check_auth_status`- Check if you're currently authenticated with WhatsApp
- `logout`- Log out from WhatsApp and clear the current session

### Contacts
- `search_contacts`- Search for contacts by name or phone number
- `get_contact`- Get information about a specific contact

### Chats
- `list_chats`- List available chats with metadata
- `get_chat`- Get information about a specific chat
- `get_direct_chat_by_contact`- Find a direct chat with a specific contact

### Messages
- `list_messages`- Retrieve messages with optional filters; `transcribe_voice_notes: true` adds the text of voice notes
- `get_message`- Get a specific message by ID
- `send_message`- Send a text message to a chat
- `transcribe_voice_notes`- Turn voice notes into text with a local speech-to-text command (see [Voice notes](#voice-notes))

### Media
- `send_file`- Send a file (image, video, document) to a chat
- `send_audio_message`- Send an audio message (voice note)
- `download_media`- Download media from a message

### Calls
- `reject_call`- Decline a call that is ringing right now, by the `callId` from a `call.received` event (Baileys backend only; fails once the call stopped ringing)

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
- `npm run test:e2e` - Build, then run end-to-end tests (spawns the real server incl. a headless browser)

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

## Use as a library

The Baileys backend can be embedded in another Node.js service, for example a chat gateway that reacts to new messages:

```js
import { createWhatsAppBackend } from 'mcp-whatsapp-web/backend';

process.env.WHATSAPP_BACKEND = 'baileys';
const backend = await createWhatsAppBackend();
backend.onMessage(message => console.log(message.chatId, message.body, message.mentionedIds));
await backend.initialize();
```

`onMessage` reports live messages only, never history sync. The warning at the top of this README applies here too.
