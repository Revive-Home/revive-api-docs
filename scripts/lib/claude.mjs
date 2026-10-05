export const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

// Calls the Messages API with a JSON schema and returns the parsed object.
export async function callClaude({ system, user, schema, model = DEFAULT_MODEL, effort = 'high', maxTokens = 16000 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing required env var: ANTHROPIC_API_KEY');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.stop_reason !== 'end_turn') throw new Error(`Unexpected stop_reason from Claude: ${data.stop_reason}`);
  const text = data.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Claude returned no text content');
  console.log(`  Claude usage: ${data.usage?.input_tokens} in / ${data.usage?.output_tokens} out`);
  return JSON.parse(text);
}

export const escapeMdx = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/{/g, '&#123;').replace(/}/g, '&#125;');
