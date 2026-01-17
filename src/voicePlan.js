function formatStateForSpeech(stateObj) {
  const name = stateObj.attributes?.friendly_name || stateObj.entity_id;
  const unit = stateObj.attributes?.unit_of_measurement || '';
  const state = stateObj.state;

  if (unit) return `${name} is ${state}${unit}.`;
  return `${name} is ${state}.`;
}

export function isCacheableToolCall(toolCall) {
  if (!toolCall?.name || !toolCall?.input) return false;

  if (toolCall.name === 'call_service') {
    const targetEntityId = toolCall.input?.target?.entity_id;
    if (!targetEntityId) return false;
    if (toolCall.input?.service === 'toggle') return false;
    return true;
  }

  if (toolCall.name === 'get_entity_state') {
    return Boolean(toolCall.input?.entity_id);
  }

  return false;
}

export function buildPlanFromToolUses(toolUses) {
  const concreteCalls = toolUses.filter(isCacheableToolCall);
  if (concreteCalls.length === 0) return null;

  return {
    version: 1,
    toolCalls: concreteCalls.map(t => ({ name: t.name, input: t.input })),
  };
}

export async function executePlan({ ha, plan }) {
  const toolResults = [];

  const stateReads = plan.toolCalls.filter(c => c.name === 'get_entity_state');
  const otherCalls = plan.toolCalls.filter(c => c.name !== 'get_entity_state');

  // Execute service calls sequentially to preserve order (e.g., unlock then open)
  for (const call of otherCalls) {
    const result = await ha.executeTool(call.name, call.input);
    toolResults.push({ name: call.name, input: call.input, result });
  }

  if (stateReads.length > 0) {
    const stateResults = await Promise.all(
      stateReads.map(async call => ({
        name: call.name,
        input: call.input,
        result: await ha.executeTool(call.name, call.input),
      }))
    );
    toolResults.push(...stateResults);
  }

  return toolResults;
}

export function renderResponseFromToolResults({ ha, toolResults }) {
  const last = toolResults[toolResults.length - 1];
  if (!last) return 'Done.';

  if (last.name === 'call_service') {
    const entityId = last.input?.target?.entity_id;
    const summary = entityId ? ha.getEntitySummary(entityId) : null;
    const service = last.input?.service;

    if (summary && (service === 'turn_on' || service === 'turn_off')) {
      const verb = service === 'turn_on' ? 'Turned on' : 'Turned off';
      return `${verb} ${summary.name}.`;
    }
    return 'Done.';
  }

  if (last.name === 'get_entity_state') {
    return formatStateForSpeech(last.result);
  }

  return 'Done.';
}

