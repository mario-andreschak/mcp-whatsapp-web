# MCP WhatsApp Web (TypeScript)

A Model Context Protocol (MCP) server for WhatsApp Web, implemented in TypeScript. This project is a TypeScript port of the original [whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) repository.

With this MCP server, you can:
- Search and read your personal WhatsApp messages (including media)
- Search your contacts
- Send messages to individuals or groups
- Send and receive media files (images, videos, documents, audio)

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

FLUJO provides a streamlined installation process:

1. Navigate to the MCP section in FLUJO
2. Click "Add Server"
3. Copy and paste this GitHub repository URL: `https://github.com/mario-andreschak/mcp-whatsapp-web`
4. Click "Parse, Clone, Install, Build and Save"

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
           "{{PATH_TO_REPO}}/dist/index.js"
         ]
       }
     }
   }
   ```

   Replace `{{PATH_TO_REPO}}` with the absolute path to the repository.

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
           "{{PATH_TO_REPO}}/dist/index.js"
         ]
       }
     }
   }
   ```

   Replace `{{PATH_TO_REPO}}` with the absolute path to the repository.

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

## Available MCP Tools

### Authentication
- `get_qr_code`: Get the QR code for WhatsApp Web authentication

### Contacts
- `search_contacts`: Search for contacts by name or phone number
- `get_contact`: Get information about a specific contact

### Chats
- `list_chats`: List available chats with metadata
- `get_chat`: Get information about a specific chat
- `get_direct_chat_by_contact`: Find a direct chat with a specific contact

### Messages
- `list_messages`: Retrieve messages with optional filters
- `get_message`: Get a specific message by ID
- `send_message`: Send a text message to a chat

### Media
- `send_file`: Send a file (image, video, document) to a chat
- `send_audio_message`: Send an audio message (voice note)
- `download_media`: Download media from a message

## Development

### Project Structure

- `src/index.ts`: Entry point
- `src/server.ts`: MCP server implementation
- `src/services/whatsapp.ts`: WhatsApp Web service
- `src/tools/`: Tool implementations for various WhatsApp features
- `src/types/`: TypeScript type definitions
- `src/utils/`: Utility functions

### Scripts

- `npm run build`: Build the TypeScript code
- `npm run dev`: Run in development mode with watch
- `npm run lint`: Run ESLint
- `npm run format`: Format code with Prettier

## Troubleshooting

### Authentication Issues

- If the QR code doesn't appear, try restarting the server
- If you're already authenticated, no QR code will be shown
- WhatsApp limits the number of linked devices; you may need to remove an existing device

### Connection Issues

- Make sure you have a stable internet connection
- If the connection fails, try restarting the server
- Check the logs for detailed error messages

## License

MIT

---

This project is a TypeScript port of the original [whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) by [lharries](https://github.com/lharries).
