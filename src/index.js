import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Main voice endpoint
app.post('/voice', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    console.log(`Received command: ${text}`);
    const response = await processVoiceCommand(text);
    console.log(`Response: ${response}`);

    res.json({ response });

  } catch (error) {
    console.error('Error processing voice command:', error);
    res.status(500).json({
      response: 'Sorry, I encountered an error processing your request.'
    });
  }
});

async function processVoiceCommand(userText) {
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

  const systemPrompt = `You are a helpful smart home assistant. You control a Home Assistant instance.

When the user asks you to do something:
1. Use the available tools to query state or control devices
2. Provide a brief, natural response confirming what you did
3. If you need information, query it first then respond

Keep responses concise - they will be spoken aloud.
Be conversational but efficient.`;

  let messages = [{ role: 'user', content: userText }];

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
      console.log(`Calling tool: ${toolUse.name}`, toolUse.input);
      const result = await executeHATool(toolUse.name, toolUse.input);
      console.log(`Tool result:`, result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result)
      });
    }

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

  const textBlock = response.content.find(block => block.type === 'text');
  return textBlock?.text || 'Done.';
}

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
        ...(input.target?.entity_id && { entity_id: input.target.entity_id }),
        ...(input.target?.area_id && { area_id: input.target.area_id })
      };
      const res = await fetch(
        `${haUrl}/api/services/${input.domain}/${input.service}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(serviceData)
        }
      );
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to call service: ${res.status} - ${errorText}`);
      }
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
      return entities.slice(0, 50);
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HA Voice Middleware running on port ${PORT}`);
});
