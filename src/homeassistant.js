function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function scoreMatch({ queryTokens, entityTokens, entityId }) {
  if (queryTokens.length === 0) return 0;

  const entityTokenSet = new Set(entityTokens);
  let score = 0;

  for (const token of queryTokens) {
    if (entityTokenSet.has(token)) score += 3;
    if (entityId.includes(token)) score += 1;
  }

  return score;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createHAClient({
  haUrl,
  haToken,
  statesTtlMs = 5000,
  requestTimeoutMs = 6000,
  warmupOnStart = true,
} = {}) {
  if (!haUrl) throw new Error('HA_URL is required');
  if (!haToken) throw new Error('HA_TOKEN is required');

  const headers = {
    Authorization: `Bearer ${haToken}`,
    'Content-Type': 'application/json',
  };

  let lastStatesRefreshAt = 0;
  let statesByEntityId = new Map();
  let entitiesByDomain = new Map();
  let refreshInFlight = null;

  function indexStates(states) {
    statesByEntityId = new Map(states.map(s => [s.entity_id, s]));

    const nextByDomain = new Map();
    for (const state of states) {
      const [domain] = state.entity_id.split('.', 1);
      const list = nextByDomain.get(domain) || [];
      list.push({
        entity_id: state.entity_id,
        name: state.attributes?.friendly_name || state.entity_id,
        state: state.state,
        attributes: state.attributes || {},
        _tokens: tokenize(state.attributes?.friendly_name || state.entity_id),
      });
      nextByDomain.set(domain, list);
    }
    entitiesByDomain = nextByDomain;
  }

  async function refreshStates({ force = false } = {}) {
    const now = Date.now();
    const stale = now - lastStatesRefreshAt > statesTtlMs;
    if (!force && !stale) return;

    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const res = await fetchWithTimeout(`${haUrl}/api/states`, { headers }, requestTimeoutMs);
      if (!res.ok) throw new Error(`Failed to fetch HA states: ${res.status}`);
      const states = await res.json();
      indexStates(states);
      lastStatesRefreshAt = Date.now();
    })();

    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function ensureStatesFresh() {
    await refreshStates({ force: false });
  }

  async function findEntities({ domain, search } = {}) {
    if (!domain) throw new Error('domain is required');
    await ensureStatesFresh();

    const entities = entitiesByDomain.get(domain) || [];
    if (!search) return entities.slice(0, 50).map(({ _tokens, attributes, ...rest }) => rest);

    const queryTokens = tokenize(search);
    const scored = entities
      .map(e => ({
        entity: e,
        score:
          scoreMatch({ queryTokens, entityTokens: e._tokens, entityId: e.entity_id }) +
          (e.name.toLowerCase().includes(search.toLowerCase()) ? 2 : 0),
      }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map(r => {
        const { _tokens, attributes, ...rest } = r.entity;
        return rest;
      });

    return scored;
  }

  async function getEntityState(entity_id) {
    if (!entity_id) throw new Error('entity_id is required');

    await ensureStatesFresh();
    const cached = statesByEntityId.get(entity_id);
    if (cached) return cached;

    await refreshStates({ force: true });
    const cachedAfter = statesByEntityId.get(entity_id);
    if (cachedAfter) return cachedAfter;

    const res = await fetchWithTimeout(`${haUrl}/api/states/${entity_id}`, { headers }, requestTimeoutMs);
    if (!res.ok) throw new Error(`Failed to get state: ${res.status}`);
    return await res.json();
  }

  async function callService({ domain, service, target, data }) {
    if (!domain) throw new Error('domain is required');
    if (!service) throw new Error('service is required');

    if (target?.entity_id) {
      await ensureStatesFresh();
      if (!statesByEntityId.has(target.entity_id)) {
        await refreshStates({ force: true });
        if (!statesByEntityId.has(target.entity_id)) {
          throw new Error(`Entity '${target.entity_id}' not found`);
        }
      }
    }

    const serviceData = {
      ...(data || {}),
      ...(target?.entity_id && { entity_id: target.entity_id }),
      ...(target?.area_id && { area_id: target.area_id }),
    };

    const res = await fetchWithTimeout(
      `${haUrl}/api/services/${domain}/${service}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(serviceData),
      },
      requestTimeoutMs
    );

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`Failed to call service: ${res.status}${errorText ? ` - ${errorText}` : ''}`);
    }

    return { success: true, message: `Called ${domain}.${service}` };
  }

  async function executeTool(toolName, input) {
    switch (toolName) {
      case 'find_entities':
        return await findEntities(input);
      case 'get_entity_state':
        return await getEntityState(input.entity_id);
      case 'call_service':
        return await callService(input);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async function warmup() {
    if (!warmupOnStart) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await refreshStates({ force: true });
        return;
      } catch (err) {
        if (attempt === 2) return;
        await sleep(250 * (attempt + 1));
      }
    }
  }

  function getEntitySummary(entity_id) {
    const state = statesByEntityId.get(entity_id);
    if (!state) return null;
    return {
      entity_id,
      name: state.attributes?.friendly_name || entity_id,
      domain: entity_id.split('.', 1)[0],
      attributes: state.attributes || {},
    };
  }

  async function resolveEntityId({ domains, search, minScore = 4 } = {}) {
    if (!Array.isArray(domains) || domains.length === 0) return null;
    if (!search) return null;

    await ensureStatesFresh();
    const queryTokens = tokenize(search);

    const candidates = [];
    for (const domain of domains) {
      const entities = entitiesByDomain.get(domain) || [];
      for (const entity of entities) {
        let score =
          scoreMatch({ queryTokens, entityTokens: entity._tokens, entityId: entity.entity_id }) +
          (entity.name.toLowerCase().includes(search.toLowerCase()) ? 2 : 0);
        // Penalize entities with unknown/unavailable state
        if (entity.state === 'unknown' || entity.state === 'unavailable') {
          score -= 10;
        }
        if (score > 0) candidates.push({ entity_id: entity.entity_id, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.score < minScore) return null;
    return best.entity_id;
  }

  return {
    warmup,
    refreshStates,
    findEntities,
    getEntityState,
    callService,
    executeTool,
    getEntitySummary,
    resolveEntityId,
  };
}

