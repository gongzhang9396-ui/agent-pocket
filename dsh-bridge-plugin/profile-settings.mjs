import { createRequire } from 'node:module';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

const names = {
  'ui-settings-general': '@deepseek-ai/dsh-client-ui-settings-general',
  'agent-default-model': '@deepseek-ai/dsh-agent-default-model',
  'llm-pi-ai': '@deepseek-ai/dsh-llm-pi-ai',
};
const providerFields = new Set(['apiKeyEnv', 'displayName', 'api', 'baseURL', 'models', 'modelOverrides', 'compat',
  'defaultContextWindow', 'defaultMaxTokens', 'defaultInput', 'headers', 'reasoning', 'thinkingBudgets', 'cacheRetention',
  'transport', 'timeoutMs', 'websocketConnectTimeoutMs', 'streamIdleTimeoutMs', 'maxRequestImageBytes',
  'requestImagePixelBudget', 'requestImageMaxBytes', 'retryPolicy']);
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\r\n\0]/.test(value);

// YAML aliases stay bounded and cyclic or executable values never reach a patch.
function jsonData(value, depth = 0, budget = { left: 8192 }) {
  if (--budget.left < 0 || depth > 24) throw new Error('DSH settings are too complex');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => jsonData(item, depth + 1, budget));
  if (!object(value)) throw new Error('DSH settings require plain JSON data');
  const output = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid DSH setting key');
    output[key] = jsonData(item, depth + 1, budget);
  }
  return output;
}

export function profileSettings(rows, strict = false) {
  if (!Array.isArray(rows) || rows.length > 128) throw new Error('DSH settings require a bounded patch list');
  const result = [], seen = new Set();
  for (const row of rows) {
    if (!object(row) || !own(names, row.id)) {
      if (strict) throw new Error('Pocket profile contains a composition change');
      continue;
    }
    if (seen.has(row.id) || Object.keys(row).some(key => !['id', 'name', 'config'].includes(key))
      || (row.name !== undefined && row.name !== names[row.id]) || !object(row.config)) throw new Error('Invalid DSH settings entry');
    seen.add(row.id);
    const config = jsonData(row.config);
    if (row.id === 'ui-settings-general' && (Object.keys(config).some(key => key !== 'welcomeNoticeVersion')
      || (config.welcomeNoticeVersion !== undefined && (typeof config.welcomeNoticeVersion !== 'string' || config.welcomeNoticeVersion.length > 128)))) {
      throw new Error('Invalid DSH welcome setting');
    }
    if (row.id === 'agent-default-model') {
      if (Object.keys(config).some(key => !['provider', 'model', 'reasoningEffort'].includes(key)) || !text(config.provider) || !text(config.model)
        || (config.reasoningEffort !== undefined && !text(config.reasoningEffort))) throw new Error('Invalid DSH default model');
    }
    if (row.id === 'llm-pi-ai') {
      if (Object.keys(config).some(key => key !== 'providers') || !object(config.providers)) throw new Error('Invalid DSH provider settings');
      for (const [provider, settings] of Object.entries(config.providers)) {
        if (!text(provider) || !object(settings) || Object.keys(settings).some(key => !providerFields.has(key))
          || (settings.apiKeyEnv !== undefined && !text(settings.apiKeyEnv))) throw new Error('Invalid DSH provider profile');
      }
    }
    result.push({ id: row.id, config }); // Never copy plugin names or composition directives.
  }
  return result;
}

export async function readProfileSettings(file, runtime, strict = false) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('Invalid DSH settings file');
    const source = await readFile(file, 'utf8');
    let rows;
    try { rows = JSON.parse(source); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const require = createRequire(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'));
      const module = await realpath(require.resolve('js-yaml'));
      const rel = relative(await realpath(runtime), module);
      if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('DSH settings parser leaves the verified runtime');
      const yaml = require(module);
      rows = yaml.load(source, { schema: yaml.JSON_SCHEMA });
    }
    return profileSettings(rows, strict);
  } catch (error) {
    if (!strict && error.code === 'ENOENT') return [];
    // Parser diagnostics can quote a credential-bearing source line.
    throw new Error(strict ? 'Pocket 的 DSH 专用配置已更改，请检查设置' : 'DSH 网页模型设置无法安全读取，请检查电脑配置');
  }
}
