import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { IntentCache } from './intentCache.js';
import { normalizeUtterance } from './normalize.js';
import { createHAClient } from './homeassistant.js';
import {
  buildPlanFromToolUses,
  executePlan,
  renderResponseFromToolResults,
} from './voicePlan.js';

const ENTITY_MATCH_SCORE = {
  DEFAULT: 4,
  POOL: 3,  // Pool entities often have shorter names
};

dotenv.config();

const app = express();
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const ha = createHAClient({
  haUrl: process.env.HA_URL,
  haToken: process.env.HA_TOKEN,
  statesTtlMs: Number(process.env.HA_STATES_TTL_MS) || 5000,
  requestTimeoutMs: Number(process.env.HA_REQUEST_TIMEOUT_MS) || 6000,
  warmupOnStart: process.env.HA_WARMUP_ON_START !== '0',
});
ha.warmup().catch(() => {});

const intentCache = new IntentCache({
  maxEntries: Number(process.env.INTENT_CACHE_MAX) || 500,
  defaultTtlMs: Number(process.env.INTENT_CACHE_TTL_MS) || 7 * 24 * 60 * 60 * 1000,
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

    const startedAt = Date.now();
    const normalized = normalizeUtterance(text);
    console.log(`Received command: ${text}`);

    const cachedPlan = intentCache.get(normalized);
    if (cachedPlan) {
      try {
        const toolResults = await executePlan({ ha, plan: cachedPlan });
        const response = renderResponseFromToolResults({ ha, toolResults });
        console.log(`Response (cache): ${response} (${Date.now() - startedAt}ms)`);
        return res.json({ response });
      } catch (err) {
        console.warn(`Cache plan failed for "${normalized}": ${err.message}`);
        intentCache.delete(normalized);
      }
    }

    const fastPlan = await tryFastPathPlan({ ha, normalized });
    if (fastPlan) {
      try {
        const toolResults = await executePlan({ ha, plan: fastPlan });
        const response = renderResponseFromToolResults({ ha, toolResults });
        intentCache.set(normalized, fastPlan);
        console.log(`Response (fast): ${response} (${Date.now() - startedAt}ms)`);
        return res.json({ response });
      } catch (err) {
        console.warn(`Fast path failed for "${normalized}": ${err.message}`);
        // Fall through to LLM
      }
    }

    const response = await processVoiceCommand({ userText: text, normalized });
    console.log(`Response (llm): ${response} (${Date.now() - startedAt}ms)`);

    res.json({ response });

  } catch (error) {
    console.error('Error processing voice command:', error);
    res.status(500).json({
      response: 'Sorry, I encountered an error processing your request.'
    });
  }
});

async function tryFastPathPlan({ ha, normalized }) {
  if (!normalized) return null;

  const poolTempRegexes = [
    /\bpool\b.*\b(temp|temperature)\b/,
    /\b(temp|temperature)\b.*\bpool\b/,
  ];

  if (poolTempRegexes.some(r => r.test(normalized))) {
    const entityId =
      (await ha.resolveEntityId({ domains: ['sensor'], search: 'pool temperature', minScore: ENTITY_MATCH_SCORE.POOL })) ||
      (await ha.resolveEntityId({ domains: ['sensor'], search: 'pool temp', minScore: ENTITY_MATCH_SCORE.POOL }));

    if (entityId) {
      return { version: 1, toolCalls: [{ name: 'get_entity_state', input: { entity_id: entityId } }] };
    }
  }

  const turnMatch = normalized.match(/\bturn\s+(on|off)\s+(.+)$/);
  if (turnMatch) {
    const desired = turnMatch[1];
    const targetText = turnMatch[2].trim();
    const minScore = targetText.includes('pool')
      ? ENTITY_MATCH_SCORE.POOL
      : ENTITY_MATCH_SCORE.DEFAULT;

    const entityId = await ha.resolveEntityId({
      domains: ['light', 'switch'],
      search: targetText,
      minScore,
    });

    if (entityId) {
      const domain = entityId.split('.', 1)[0];
      return {
        version: 1,
        toolCalls: [
          {
            name: 'call_service',
            input: {
              domain,
              service: desired === 'on' ? 'turn_on' : 'turn_off',
              target: { entity_id: entityId },
            },
          },
        ],
      };
    }
  }

  const suffixMatch = normalized.match(/^(.+)\s+\b(on|off)\b$/);
  if (suffixMatch) {
    const targetText = suffixMatch[1].trim();
    const desired = suffixMatch[2];

    const looksLikeQuery =
      targetText.startsWith('what ') ||
      targetText.startsWith('whats ') ||
      targetText.startsWith("what's ") ||
      targetText.startsWith('is ') ||
      targetText.startsWith('are ');

    if (!looksLikeQuery && targetText.split(' ').length <= 6) {
      const minScore = targetText.includes('pool')
        ? ENTITY_MATCH_SCORE.POOL
        : ENTITY_MATCH_SCORE.DEFAULT;
      const entityId = await ha.resolveEntityId({
        domains: ['light', 'switch'],
        search: targetText,
        minScore,
      });

      if (entityId) {
        const domain = entityId.split('.', 1)[0];
        return {
          version: 1,
          toolCalls: [
            {
              name: 'call_service',
              input: {
                domain,
                service: desired === 'on' ? 'turn_on' : 'turn_off',
                target: { entity_id: entityId },
              },
            },
          ],
        };
      }
    }
  }

  return null;
}

async function processVoiceCommand({ userText, normalized }) {
  const tools = [
    {
      name: 'find_entities',
      description: 'Find Home Assistant entities by domain to discover exact entity IDs.',
      input_schema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'The domain to search: light, switch, sensor, climate, cover, lock, fan, or scene',
            enum: ['light', 'switch', 'sensor', 'climate', 'cover', 'lock', 'fan', 'scene']
          },
          search: {
            type: 'string',
            description: 'Optional search term to filter by name (e.g., "bedroom", "pool", "temperature")'
          }
        },
        required: ['domain']
      }
    },
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
    }
  ];

  const systemPrompt = `You are a smart home voice assistant. Keep responses very brief - one sentence max.

IMPORTANT: Use find_entities to discover exact entity IDs when needed before controlling devices or querying sensors. Lights may be under "light" or "switch" domain - check both if needed.`;

  let messages = [{ role: 'user', content: userText }];

  const toolUsesSeen = [];

  let response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: systemPrompt,
    tools,
    messages
  });

  // Handle tool use loop
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      toolUsesSeen.push({ name: toolUse.name, input: toolUse.input });
      console.log(`Calling tool: ${toolUse.name}`);
      try {
        const result = await ha.executeTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      } catch (error) {
        console.log(`Tool error: ${error.message}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: error.message }),
          is_error: true
        });
      }
    }

    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults }
    ];

    response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: systemPrompt,
      tools,
      messages
    });
  }

  const textBlock = response.content.find(block => block.type === 'text');
  const responseText = textBlock?.text || 'Done.';

  const plan = buildPlanFromToolUses(toolUsesSeen);
  if (plan && normalized) {
    intentCache.set(normalized, plan);
  }

  return responseText;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HA Voice Middleware running on port ${PORT}`);
});
