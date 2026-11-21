type Read = (method: string, params: any) => Promise<any>;
const agentsByChannel = new WeakMap<object, Promise<Array<string | undefined>>>();
export async function agentCatalog(read: Read) {
  try {
    const value = await read('agent/list', {});
    if (!Array.isArray(value?.data)) throw new Error('Agent 列表格式无效');
    const ids = new Set<string>();
    for (const row of value.data) if (typeof row?.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(row.id) || ids.has(row.id)) throw new Error('Agent 标识无效或重复'); else ids.add(row.id);
    if (ids.size > 16) throw new Error('Agent 列表过大');
    return value.data;
  } catch (error: any) {
    if (error.nameCode !== 'NOT_FOUND' && error.code !== -32601) throw error;
    const models = await read('model/list', { limit: 100 });
    return [{ id: 'codex', name: 'Codex', available: true, legacy: true, models: models.data || [] }];
  }
}
export async function loadTaskCatalog(channel: object, read: Read) {
  let agents = agentsByChannel.get(channel);
  if (!agents) {
    agents = agentCatalog(read).then(rows => rows.map((row: any) => row.legacy ? undefined : row.id));
    agentsByChannel.set(channel, agents); agents.catch(() => agentsByChannel.delete(channel));
  }
  const rows = new Map<string, any>();
  for (const agent of await agents) {
    let cursor: string | undefined; const seen = new Set(); let pages = 0;
    do {
      if (++pages > 100) throw new Error('任务列表页数过多，请稍后重试');
      const result = await read('thread/list', { limit: 200, ...(agent ? { agentId: agent } : {}), ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data)) throw new Error('任务列表格式无效');
      for (const row of result.data) {
        if (typeof row?.id !== 'string' || !row.id || (agent && row.agentId && row.agentId !== agent)) throw new Error('任务与 Agent 不匹配');
        const owner = agent || row.agentId || (row.id.includes(':') ? row.id.split(':')[0] : 'codex');
        if (owner === 'codex' ? row.id.includes(':') : !row.id.startsWith(`${owner}:`) || row.id.length <= owner.length + 1) throw new Error('任务标识与 Agent 不匹配');
        if (!row.archived && !row.isArchived && row.archivedAt == null) rows.set(`${owner}:${row.id}`, { ...row, agentId: owner });
      }
      const next = result.nextCursor;
      if (next != null && (typeof next !== 'string' || !next || seen.has(next))) throw new Error('任务列表分页游标无效');
      if (next) seen.add(next); cursor = next || undefined;
    } while (cursor);
  }
  return { data: [...rows.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) };
}
