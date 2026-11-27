// The small part of the Model Context Protocol needed to give a session tools.
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// Returns the JSON-RPC reply to one message, or null if it needs none.
async function reply(message, { instructions, tools }) {
  const { id, method, params = {} } = message || {};
  if (id === undefined || id === null) return null; // a notification
  const ok = (result) => ({ jsonrpc: '2.0', id, result });

  if (method === 'initialize') {
    return ok({
      protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[1],
      capabilities: { tools: {} },
      serverInfo: { name: 'karass', version: '0.0.1' },
      instructions,
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: tools.map(({ run, ...description }) => description) });
  }
  if (method === 'tools/call') {
    const tool = tools.find((t) => t.name === params.name);
    if (tool) {
      try {
        return ok({ content: [{ type: 'text', text: await tool.run(params.arguments || {}) }] });
      } catch (error) {
        if (!error.status) console.error(error);
        const text = error.status ? error.message : 'Karass could not do that.';
        return ok({ content: [{ type: 'text', text }], isError: true });
      }
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

module.exports = { reply };
