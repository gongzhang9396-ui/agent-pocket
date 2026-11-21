// ignore_for_file: avoid_relative_lib_imports, avoid_print
import '../lib/tasks/thread_activity.dart';
import '../lib/tasks/thread_page.dart';

void main() {
  final page = ThreadPage.fromResponse({'thread': {'id': 'task', 'turns': [
    {'id': 'turn', 'items': [
      {'id': 'r', 'type': 'reasoning', 'summary': ['检查入口', {'text': '定位请求'}], 'content': ['PRIVATE'], 'encryptedContent': 'SECRET'},
      {'id': 't', 'type': 'mcpToolCall', 'tool': 'read_file', 'status': 'inProgress'},
      {'id': 'p', 'type': 'plan', 'plan': [{'step': '运行检查', 'status': 'inProgress'}]},
    ]},
  ]}}, 'task');
  assert(page.items[0].text == '检查入口\n\n定位请求');
  assert(page.items[1].text == 'read_file');
  assert(page.items[2].text == '→ 运行检查');
  assert(!page.items.map((item) => item.text).join().contains('PRIVATE'));
  assert(itemActivity({'type': 'reasoning', 'content': ['PRIVATE']})!.text.isEmpty);
  var command = activityEventItem('command.updated', {'item': {'id': 'c', 'type': 'commandExecution', 'command': 'npm test', 'status': 'inProgress'}}, null, 'turn')!;
  command = activityEventItem('command.updated', {'itemId': 'c', 'delta': 'passed'}, command, 'turn')!;
  command = activityEventItem('command.updated', {'item': {'id': 'c', 'type': 'commandExecution', 'status': 'completed'}}, command, 'turn')!;
  assert(itemActivity(command)!.text == 'npm test\npassed');
  final plan = activityEventItem('plan.updated', {'plan': [{'step': '检查', 'status': 'completed'}]}, null, 'turn')!;
  assert(plan['id'] == 'pocket-plan-turn' && itemActivity(plan)!.text == '✓ 检查');
  assert(runningStatus({'type': 'inProgress'}) && runningStatus('started'));
  assert(finishedStatus('interrupted') && !runningStatus('completed'));
  print('thread activity contract passed');
}
