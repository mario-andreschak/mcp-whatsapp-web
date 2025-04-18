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
- **WhatsApp Web Integration**: Uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) for direct connection to WhatsApp Web
- **MCP Server**: Implements the [Model Context Protocol](https://modelcontextprotocol.io/) for seamless integration with AI assistants
- **Media Support**: Send and receive images, videos, documents, and audio messages
- **Multiple Transport Options**: Supports both stdio and SSE transports for flexible integration

## Architecture

This MCP server consists of:

1. **TypeScript MCP Server**: Implements the Model Context Protocol to provide standardized tools for AI assistants to interact with WhatsApp
2. **WhatsApp Web Service**: Connects to WhatsApp Web via whatsapp-web.js, handles authentication, and manages message sending/receiving
3. **Tool Implementations**: Provides various tools for contacts, chats, messages, media, and authentication

## Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- Chrome/Chromium (used by Puppeteer for WhatsApp Web connection)
- FFmpeg (optional, for audio message conversion)

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

   You can adjust logging levels and specify paths to FFmpeg if needed.

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
- `list_messages`- Retrieve messages with optional filters
- `get_message`- Get a specific message by ID
- `send_message`- Send a text message to a chat

### Media
- `send_file`- Send a file (image, video, document) to a chat
- `send_audio_message`- Send an audio message (voice note)
- `download_media`- Download media from a message

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
