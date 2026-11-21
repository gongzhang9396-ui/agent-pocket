// ignore_for_file: avoid_relative_lib_imports, avoid_print
import '../lib/tasks/agent_identity.dart';

void main() {
  assert(threadAgentId({'id': 'dsh:one'}) == 'dsh');
  assert(threadAgentId({'id': 'grok:one', 'agentId': 'dsh'}) == 'dsh');
  assert(agentLabel('dsh') == 'DeepSeek');
  assert(!taskSupports({'agentId': 'dsh', 'source': 'bridge'}, 'attachments'));
  assert(!taskSupports({'agentId': 'dsh', 'source': 'bridge'}, 'steer'));
  assert(taskSupports({'id': 'old', 'source': 'bridge'}, 'steer'));
  assert(!taskSupports({'source': 'bridge', 'capabilities': {'steer': false}}, 'steer'));
  assert(taskSupports({'id': 'dsh:a', 'execution': {'backend': 'dsh', 'capabilities': {'steer': true}}}, 'steer'));
  print('agent identity contract passed');
}
