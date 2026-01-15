# Apple Watch → Home Assistant Voice Control via MCP

A complete implementation plan for building a natural language voice interface between Apple Watch and Home Assistant using the Model Context Protocol (MCP).

---

## Project Overview

**Goal**: Speak to your Apple Watch and have an LLM (Claude) interpret your command, execute actions on Home Assistant via MCP, and speak back a natural language response.

**Architecture**:
```
Apple Watch → Siri Shortcut → Middleware API → Claude + MCP → Home Assistant
                    ↑                                              ↓
                    └──────────── Response spoken ←────────────────┘
```

---

## Components Summary

| Component | Technology | Purpose |
|-----------|------------|---------|
| Voice Input | Apple Watch + Siri | Capture voice, convert to text |
| Trigger | Siri Shortcut | HTTP request to middleware |
| Middleware | Node.js/Python service | Bridge between Shortcut and LLM |
| Intelligence | Claude API | Natural language understanding |
| Home Control | Home Assistant MCP Server | Execute actions, query state |
| Voice Output | Siri "Speak Text" | Read response aloud |

---

## Phase 1: Home Assistant MCP Server Setup

### Prerequisites
- Home Assistant 2025.2.0 or newer
- Network access to your HA instance (local or via Nabu Casa/reverse proxy)

### Steps

1. **Enable MCP Server Integration**
   - Go to: Settings → Devices & Services → Add Integration
   - Search for: "Model Context Protocol Server"
   - Follow the setup wizard

2. **Create Long-Lived Access Token**
   - Go to: Your Profile (bottom left) → Security → Long-Lived Access Tokens
   - Create new token, name it "MCP Middleware"
   - **Save this token securely** - you'll need it for the middleware

3. **Expose Entities**
   - Go to: Settings → Voice Assistants → Expose Entities
   - Select entities you want controllable via voice
   - Be selective for security and to minimize token usage
   - Recommended: lights, switches, sensors, locks, climate, covers

4. **Note Your HA URL**
   - Local: `http://homeassistant.local:8123` or `http://<IP>:8123`
   - Remote: Your Nabu Casa URL or custom domain
   - MCP endpoint will be: `<HA_URL>/api/mcp`

### Verification
```bash
# Test that MCP Server is accessible
curl -X GET "http://your-ha-instance:8123/api/" \
  -H "Authorization: Bearer YOUR_TOKEN"
# Should return: {"message": "API running."}
```

---

## Phase 2: Middleware Service

### Option A: Node.js (Recommended)

#### Project Structure
```
ha-voice-middleware/
├── package.json
├── .env
├── src/
│   ├── index.js          # Express server
│   ├── claude.js         # Claude API integration
│   ├── homeassistant.js  # Home Assistant MCP client
│   └── tools.js          # MCP tool definitions
└── README.md
```

#### Dependencies
```json
{
  "name": "ha-voice-middleware",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "express": "^4.18.2",
    "@anthropic-ai/sdk": "^0.30.0",
    "dotenv": "^16.3.1"
  }
}
```

#### Environment Variables (.env)
```bash
# Anthropic API
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx

# Home Assistant
HA_URL=http://homeassistant.local:8123
HA_TOKEN=your_long_lived_access_token

# Middleware
PORT=3000
API_KEY=your_secret_middleware_key  # For Shortcut authentication
```

#### Core Implementation (src/index.js)
```javascript
import express from 'express';
import { Anthropic } from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Authentication middleware
app.use('/voice', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Main voice endpoint
app.post('/voice', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    const response = await processVoiceCommand(text);
    res.json({ response });
    
  } catch (error) {
    console.error('Error processing voice command:', error);
    res.status(500).json({ 
      response: 'Sorry, I encountered an error processing your request.' 
    });
  }
});

async function processVoiceCommand(userText) {
  // Define the tools Claude can use
  const tools = [
    {
      name: 'get_entity_state',
      description: 'Get the current state of a Home Assistant entity',
      input_schema: {
        type: 'object',
        properties: {
          entity_id: {
            type: 'string',
            description: 'The entity ID (e.g., light.living_room, sensor.temperature)'
          }
        },
        required: ['entity_id']
      }
    },
    {
      name: 'call_service',
      description: 'Call a Home Assistant service to control devices',
      input_schema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Service domain (e.g., light, switch, climate)'
          },
          service: {
            type: 'string',
            description: 'Service name (e.g., turn_on, turn_off, toggle)'
          },
          target: {
            type: 'object',
            description: 'Target entities or areas',
            properties: {
              entity_id: { type: 'string' },
              area_id: { type: 'string' }
            }
          },
          data: {
            type: 'object',
            description: 'Additional service data (e.g., brightness, temperature)'
          }
        },
        required: ['domain', 'service']
      }
    },
    {
      name: 'list_entities',
      description: 'List available Home Assistant entities, optionally filtered by domain',
      input_schema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Optional domain filter (e.g., light, sensor)'
          }
        }
      }
    }
  ];

  // System prompt for Claude
  const systemPrompt = `You are a helpful smart home assistant. You control a Home Assistant instance.

When the user asks you to do something:
1. Use the available tools to query state or control devices
2. Provide a brief, natural response confirming what you did
3. If you need information, query it first then respond

Keep responses concise - they will be spoken aloud.
Be conversational but efficient.`;

  // Initial message to Claude
  let messages = [{ role: 'user', content: userText }];

  // Loop to handle tool use
  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    tools,
    messages
  });

  // Handle tool use loop
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      const result = await executeHATool(toolUse.name, toolUse.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result)
      });
    }

    // Continue conversation with tool results
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults }
    ];

    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages
    });
  }

  // Extract text response
  const textBlock = response.content.find(block => block.type === 'text');
  return textBlock?.text || 'Done.';
}

// Execute Home Assistant tool calls
async function executeHATool(toolName, input) {
  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  
  const headers = {
    'Authorization': `Bearer ${haToken}`,
    'Content-Type': 'application/json'
  };

  switch (toolName) {
    case 'get_entity_state': {
      const res = await fetch(`${haUrl}/api/states/${input.entity_id}`, { headers });
      if (!res.ok) throw new Error(`Failed to get state: ${res.status}`);
      return await res.json();
    }

    case 'call_service': {
      const serviceData = {
        ...input.data,
        ...(input.target && { target: input.target })
      };
      const res = await fetch(
        `${haUrl}/api/services/${input.domain}/${input.service}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(serviceData)
        }
      );
      if (!res.ok) throw new Error(`Failed to call service: ${res.status}`);
      return { success: true, message: `Called ${input.domain}.${input.service}` };
    }

    case 'list_entities': {
      const res = await fetch(`${haUrl}/api/states`, { headers });
      if (!res.ok) throw new Error(`Failed to list entities: ${res.status}`);
      const states = await res.json();
      let entities = states.map(s => ({
        entity_id: s.entity_id,
        state: s.state,
        friendly_name: s.attributes?.friendly_name
      }));
      if (input.domain) {
        entities = entities.filter(e => e.entity_id.startsWith(input.domain + '.'));
      }
      return entities.slice(0, 50); // Limit for token efficiency
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HA Voice Middleware running on port ${PORT}`);
});
```

### Option B: Python (Alternative)

#### Project Structure
```
ha-voice-middleware/
├── requirements.txt
├── .env
├── main.py
└── README.md
```

#### Dependencies (requirements.txt)
```
fastapi==0.109.0
uvicorn==0.27.0
anthropic==0.30.0
python-dotenv==1.0.0
httpx==0.26.0
```

#### Core Implementation (main.py)
```python
import os
import json
import httpx
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()
anthropic = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

HA_URL = os.getenv("HA_URL")
HA_TOKEN = os.getenv("HA_TOKEN")
API_KEY = os.getenv("API_KEY")

class VoiceRequest(BaseModel):
    text: str

class VoiceResponse(BaseModel):
    response: str

@app.post("/voice", response_model=VoiceResponse)
async def voice_command(
    request: VoiceRequest,
    authorization: str = Header(...)
):
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Unauthorized")
    
    response = await process_voice_command(request.text)
    return VoiceResponse(response=response)

async def process_voice_command(user_text: str) -> str:
    tools = [
        {
            "name": "get_entity_state",
            "description": "Get the current state of a Home Assistant entity",
            "input_schema": {
                "type": "object",
                "properties": {
                    "entity_id": {
                        "type": "string",
                        "description": "The entity ID"
                    }
                },
                "required": ["entity_id"]
            }
        },
        {
            "name": "call_service",
            "description": "Call a Home Assistant service",
            "input_schema": {
                "type": "object",
                "properties": {
                    "domain": {"type": "string"},
                    "service": {"type": "string"},
                    "target": {"type": "object"},
                    "data": {"type": "object"}
                },
                "required": ["domain", "service"]
            }
        }
    ]

    system_prompt = """You are a helpful smart home assistant controlling Home Assistant.
Keep responses concise - they will be spoken aloud."""

    messages = [{"role": "user", "content": user_text}]
    
    response = anthropic.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        system=system_prompt,
        tools=tools,
        messages=messages
    )

    while response.stop_reason == "tool_use":
        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                result = await execute_ha_tool(block.name, block.input)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result)
                })
        
        messages.extend([
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": tool_results}
        ])
        
        response = anthropic.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            system=system_prompt,
            tools=tools,
            messages=messages
        )

    for block in response.content:
        if hasattr(block, "text"):
            return block.text
    return "Done."

async def execute_ha_tool(tool_name: str, input_data: dict) -> dict:
    headers = {
        "Authorization": f"Bearer {HA_TOKEN}",
        "Content-Type": "application/json"
    }
    
    async with httpx.AsyncClient() as client:
        if tool_name == "get_entity_state":
            r = await client.get(
                f"{HA_URL}/api/states/{input_data['entity_id']}",
                headers=headers
            )
            return r.json()
        
        elif tool_name == "call_service":
            service_data = input_data.get("data", {})
            if input_data.get("target"):
                service_data["target"] = input_data["target"]
            r = await client.post(
                f"{HA_URL}/api/services/{input_data['domain']}/{input_data['service']}",
                headers=headers,
                json=service_data
            )
            return {"success": True}
    
    return {"error": "Unknown tool"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 3000)))
```

---

## Phase 3: Deployment Options

### Option A: Local Network (Simplest)

Run the middleware on a local machine (or same server as HA):

```bash
# Node.js
npm start

# Python
python main.py
```

**Pros**: No internet exposure, fastest latency
**Cons**: Only works when on home network (or VPN)

### Option B: Docker on Home Server

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY src ./src
EXPOSE 3000
CMD ["node", "src/index.js"]
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  ha-voice-middleware:
    build: .
    ports:
      - "3000:3000"
    env_file:
      - .env
    restart: unless-stopped
```

### Option C: Cloud Deployment (For Remote Access)

**Cloudflare Workers** (free tier available):
- Convert to edge-compatible code
- Use Cloudflare tunnel to reach local HA

**Railway/Render/Fly.io**:
- Deploy as a container
- Requires HA to be accessible from internet (Nabu Casa or reverse proxy)

### Exposing to Internet (If Needed)

If you want the middleware accessible from anywhere:

1. **Cloudflare Tunnel** (recommended)
   - Zero Trust access without opening ports
   - Free tier available

2. **Reverse Proxy + SSL**
   - Use nginx/Caddy with Let's Encrypt
   - Configure proper authentication

---

## Phase 4: Siri Shortcut

### Create the Shortcut

1. Open **Shortcuts** app on iPhone
2. Tap **+** to create new shortcut
3. Name it: "Home Control" (or whatever you want to say after "Hey Siri")

### Add Actions

**Action 1: Dictate Text**
- Search for "Dictate Text"
- Add it
- Configure:
  - Stop Listening: "After Pause"
  - Language: English (or your preference)

**Action 2: Get Contents of URL**
- Search for "Get Contents of URL"
- Add it
- Configure:
  - URL: `http://your-middleware:3000/voice` (or your deployed URL)
  - Method: POST
  - Headers:
    - `Authorization`: `Bearer YOUR_API_KEY`
    - `Content-Type`: `application/json`
  - Request Body: JSON
    - Add key: `text`
    - Value: Select "Dictated Text" from variables

**Action 3: Get Dictionary Value**
- Search for "Get Dictionary Value"
- Add it
- Configure:
  - Key: `response`
  - Dictionary: "Contents of URL" (previous action output)

**Action 4: Speak Text**
- Search for "Speak Text"
- Add it
- Input: "Dictionary Value" (previous action output)

### Enable on Apple Watch

1. Tap the shortcut name at top
2. Tap the **ⓘ** info button
3. Enable: **Show on Apple Watch**
4. Optional: Add to **Home Screen**

### Visual Shortcut Flow

```
┌─────────────────────────────────────┐
│         Shortcut: Home Control      │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐    │
│  │     📝 Dictate Text         │    │
│  │     Stop: After Pause       │    │
│  └──────────────┬──────────────┘    │
│                 │                   │
│                 ▼                   │
│  ┌─────────────────────────────┐    │
│  │   🌐 Get Contents of URL    │    │
│  │   POST to middleware        │    │
│  │   Body: {"text": [Dictated]}│    │
│  └──────────────┬──────────────┘    │
│                 │                   │
│                 ▼                   │
│  ┌─────────────────────────────┐    │
│  │   📖 Get Dictionary Value   │    │
│  │   Key: "response"           │    │
│  └──────────────┬──────────────┘    │
│                 │                   │
│                 ▼                   │
│  ┌─────────────────────────────┐    │
│  │   🔊 Speak Text             │    │
│  │   [Dictionary Value]        │    │
│  └─────────────────────────────┘    │
│                                     │
└─────────────────────────────────────┘
```

---

## Phase 5: Testing

### Test 1: Home Assistant API

```bash
# Verify HA is accessible
curl -X GET "http://your-ha:8123/api/states/light.living_room" \
  -H "Authorization: Bearer YOUR_HA_TOKEN"
```

### Test 2: Middleware Directly

```bash
# Test the middleware endpoint
curl -X POST "http://localhost:3000/voice" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "What lights are on?"}'
```

Expected response:
```json
{
  "response": "Currently, the living room light and kitchen light are on."
}
```

### Test 3: Full Flow via iPhone

1. Open Shortcuts app
2. Run "Home Control" manually
3. Speak: "Turn on the bedroom light"
4. Verify Siri speaks response
5. Check if light actually turned on

### Test 4: Apple Watch

1. Raise wrist
2. Say: "Hey Siri, Home Control"
3. Speak your command when prompted
4. Listen for response

---

## Troubleshooting

### Common Issues

| Problem | Cause | Solution |
|---------|-------|----------|
| "Unauthorized" from middleware | Wrong API key in Shortcut | Check Authorization header value |
| "Failed to get state" | Entity not exposed | Expose entity in HA Voice Assistants settings |
| Shortcut times out | Middleware unreachable | Check URL, firewall, network |
| No response spoken | JSON parsing error | Verify middleware returns `{"response": "..."}` |
| Watch says "allow"repeatedly | Known watchOS bug | Remove HA app from Watch, run Shortcut on iPhone |

### Debugging Tips

1. **Check middleware logs** - Add `console.log` statements
2. **Test each component independently** - Use curl for API testing
3. **Simplify first** - Start with a simple "What time is it?" command
4. **Check Claude usage** - Verify API key works at console.anthropic.com

---

## Enhancement Ideas

### Add More Tools

```javascript
// Weather tool (if you have weather integration)
{
  name: 'get_weather',
  description: 'Get current weather from Home Assistant',
  input_schema: {
    type: 'object',
    properties: {}
  }
}

// Scene activation
{
  name: 'activate_scene',
  description: 'Activate a Home Assistant scene',
  input_schema: {
    type: 'object',
    properties: {
      scene_id: { type: 'string' }
    },
    required: ['scene_id']
  }
}

// Automation trigger
{
  name: 'trigger_automation',
  description: 'Manually trigger an automation',
  input_schema: {
    type: 'object',
    properties: {
      automation_id: { type: 'string' }
    },
    required: ['automation_id']
  }
}
```

### Conversation Memory

Store recent context in Redis/memory for multi-turn conversations:

```javascript
const conversationHistory = new Map();

// In processVoiceCommand
const history = conversationHistory.get(userId) || [];
messages = [...history, { role: 'user', content: userText }];

// After getting response, store
conversationHistory.set(userId, messages.slice(-10)); // Keep last 10 messages
```

### Multiple Homes/Instances

Support different HA instances:

```javascript
// Pass home identifier in request
app.post('/voice/:homeId', async (req, res) => {
  const config = homes[req.params.homeId];
  // Use config.haUrl, config.haToken
});
```

---

## Security Considerations

1. **Use HTTPS** in production - Let's Encrypt is free
2. **Rotate API keys** periodically
3. **Limit exposed entities** - Only expose what you need
4. **Use strong middleware API key** - Generate with `openssl rand -hex 32`
5. **Consider IP allowlisting** - If middleware is exposed to internet
6. **Monitor usage** - Check Claude API logs for unusual activity

---

## Cost Estimates

| Service | Cost |
|---------|------|
| Claude API (Sonnet) | ~$0.003-0.01 per command |
| Home Assistant | Free (self-hosted) |
| Nabu Casa (optional) | $6.50/month |
| Cloudflare Workers | Free tier: 100k requests/day |

Typical usage: 20-50 commands/day ≈ $3-15/month in API costs

---

## Quick Start Checklist

- [ ] Home Assistant 2025.2+ running
- [ ] MCP Server integration enabled in HA
- [ ] Long-lived access token created
- [ ] Entities exposed for voice control
- [ ] Anthropic API key obtained
- [ ] Middleware code deployed
- [ ] Environment variables configured
- [ ] Middleware accessible (local or internet)
- [ ] Siri Shortcut created and tested on iPhone
- [ ] Shortcut enabled on Apple Watch
- [ ] End-to-end test completed

---

## Resources

- [Home Assistant MCP Server Docs](https://www.home-assistant.io/integrations/mcp_server/)
- [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
- [Anthropic Claude API](https://docs.anthropic.com/en/api/getting-started)
- [Apple Shortcuts User Guide](https://support.apple.com/guide/shortcuts/welcome/ios)
- [Siri Shortcuts on Apple Watch](https://support.apple.com/guide/shortcuts/run-shortcuts-from-apple-watch-apd5888b0858/ios)

---

*Last updated: January 2025*
