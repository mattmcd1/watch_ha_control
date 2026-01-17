# Apple Watch Home Assistant Voice Control

A natural language voice interface between Apple Watch and Home Assistant using Claude.

## Architecture

```
Apple Watch → Siri Shortcut → Middleware API → Claude + Tools → Home Assistant
                    ↑                                               ↓
                    └──────────── Response spoken ←─────────────────┘
```

## How It Works

1. Speak a command to Siri on your Apple Watch
2. Siri Shortcut sends the text to the middleware
3. Middleware calls Claude with Home Assistant tool definitions
4. Claude decides what actions to take and returns tool calls
5. Middleware executes those tools via Home Assistant's REST API
6. Claude generates a natural language response
7. Siri speaks the response back to you

### Performance Notes

- The middleware caches HA entity/state data to avoid fetching `/api/states` on every request.
- The middleware also caches “intent plans” (resolved HA tool calls) for repeated commands to reduce Claude round-trips.
- A small fast-path handles common commands like “turn on/off …” and “pool temperature” without calling Claude.

## Setup

### Prerequisites

- Home Assistant instance with REST API access
- Anthropic API key
- Docker (for deployment)

### Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required variables:
- `ANTHROPIC_API_KEY` - Your Anthropic API key
- `HA_URL` - Home Assistant URL (e.g., `https://192.168.1.100:8123`)
- `HA_TOKEN` - Home Assistant long-lived access token
- `API_KEY` - Secret key for authenticating Siri Shortcut requests

Optional:
- `PORT` - Server port (default: 3000)
- `NODE_TLS_REJECT_UNAUTHORIZED` - Set to `0` if HA uses a self-signed certificate
- `HA_STATES_TTL_MS` - Cache TTL for HA `/api/states` (default: 5000)
- `HA_REQUEST_TIMEOUT_MS` - Timeout for HA HTTP requests (default: 6000)
- `HA_WARMUP_ON_START` - Set to `0` to disable HA cache warmup on boot
- `INTENT_CACHE_MAX` - Max cached voice intents (default: 500)
- `INTENT_CACHE_TTL_MS` - TTL for cached voice intents (default: 7 days)

### Running Locally

```bash
npm install
npm start
```

### Docker Deployment

```bash
# Build and start the container
sudo DOCKER_BUILDKIT=0 docker-compose up -d --build

# View logs
sudo docker-compose logs --tail=100
```

## API

### POST /voice

Send a voice command for processing.

**Headers:**
- `Authorization: Bearer YOUR_API_KEY`
- `Content-Type: application/json`

**Body:**
```json
{
  "text": "Turn on the living room lights"
}
```

**Response:**
```json
{
  "response": "I've turned on the living room lights."
}
```

### GET /health

Health check endpoint.

## Siri Shortcut Setup

1. Open Shortcuts app on iPhone
2. Create new shortcut named "Home Control"
3. Add actions:
   - **Dictate Text** (Stop: After Pause)
   - **Get Contents of URL**: POST to `http://your-server:3000/voice`
     - Header: `Authorization: Bearer YOUR_API_KEY`
     - Header: `Content-Type: application/json`
     - Body (JSON): `{"text": "[Dictated Text]"}`
   - **Get Dictionary Value**: Key `response`
   - **Speak Text**: [Dictionary Value]
4. Enable "Show on Apple Watch" in shortcut settings

## Example Commands

- "Turn on the outside lights"
- "What's the pool temperature?"
- "Turn off all the lights"
- "What lights are available?"
- "Set the bedroom light to 50% brightness"
