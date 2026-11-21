String threadAgentId(Map thread) {
  final explicit = thread['agentId'];
  if (explicit is String && explicit.isNotEmpty) return explicit;
  final id = thread['id'];
  if (id is String && id.startsWith('dsh:')) return 'dsh';
  if (id is String && id.startsWith('grok:')) return 'grok';
  final execution = thread['execution'];
  final backend = execution is Map ? execution['backend'] : thread['source'];
  return backend == 'dsh' || backend == 'grok' ? backend as String : 'codex';
}

String agentLabel(String id) => const {'all': '全部', 'codex': 'Codex', 'grok': 'Grok', 'dsh': 'DeepSeek'}[id] ?? id;

bool taskSupports(Map thread, String action) {
  final execution = thread['execution'];
  final raw = execution is Map ? execution['capabilities'] : thread['capabilities'];
  final caps = raw is Map ? raw : const {};
  if (caps.containsKey(action)) return caps[action] == true;
  final backend = execution is Map ? execution['backend'] : thread['source'];
  return threadAgentId(thread) == 'codex' &&
    ((action == 'steer' && backend == 'bridge') || (action == 'attachments' && {'bridge', 'desktop'}.contains(backend)));
}
