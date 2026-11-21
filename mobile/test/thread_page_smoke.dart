// ignore_for_file: avoid_relative_lib_imports, avoid_print
import '../lib/tasks/thread_page.dart';

void main() {
  final result = <String, dynamic>{
    'thread': {'id': 'thread', 'turns': [
      {'id': 'new', 'items': [{'id': 'assistant', 'type': 'agentMessage', 'text': 'answer'}]},
      {'id': 'old', 'items': [{'id': 'user', 'type': 'userMessage', 'content': [{'type': 'text', 'text': 'question'}]}]},
    ], 'interactionItems': [{'id': 'approval', 'type': 'pocketApproval', 'requestId': 'request'}]},
    'page': {'order': 'newest_first', 'hasMore': true, 'nextCursor': 'older', 'revision': 'rev'},
  };
  final page = ThreadPage.fromResponse(result, 'thread');
  assert(page.items.map((item) => item.id).join(',') == 'user,assistant,approval');
  assert(page.items.first.text == 'question' && page.items[1].text == 'answer');
  assert(page.items[1].artifactMessageId == 'new:assistant' && page.nextCursor == 'older');
  assert(page.items.last.raw['requestId'] == 'request');
  final imagePage = ThreadPage.fromResponse({'thread': {'id': 'thread', 'turns': [
    {'id': 'turn', 'items': [{'id': 'image', 'type': 'userMessage', 'content': [{'type': 'image'}]}]},
  ]}}, 'thread');
  assert(imagePage.items.single.text == '[已添加图片]');
  try { ThreadPage.fromResponse(result, 'other'); throw StateError('wrong task accepted'); }
  on FormatException { /* Do not mix tasks. */ }
  try { ThreadPage.fromResponse(result, 'thread', requestedCursor: 'older'); throw StateError('repeated cursor accepted'); }
  on FormatException { /* Pagination must make progress. */ }
  print('thread page contract passed');
}
