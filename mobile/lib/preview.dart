// Isolated visual preview with synthetic data. Never used by the release entry.
import 'package:flutter/material.dart';
import 'dart:convert';
import 'protocol/relay_hosts.dart';
import 'session/pocket_session_service.dart';
import 'session/session_manager.dart';
import 'tasks/workspace_controller.dart';
import 'ui/workspace_screen.dart';
import 'ui/appearance.dart';
import 'protocol/relay_event_feed.dart';
import 'tasks/attachment_uploader.dart';
import 'dart:async';

class _PreviewFeed implements RelayEventFeed {
  final stream = StreamController<FeedUpdate>.broadcast();
  @override Stream<FeedUpdate> get updates => stream.stream;
  @override Future<void> start(SessionRef ref, List<RelayHost> hosts) async { stream.add(const FeedUpdate('connected')); }
  @override Set<String> unread(String hostId) => {};
  @override void view(String? host, String? thread) {}
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
class _PreviewService implements PocketSessionService {
  @override final feed = _PreviewFeed();
  @override Future<List<Map<String, dynamic>>> pendingOperations(HostDirectory directory, RelayHost host) async => [];
  @override Future<List<PickedAttachment>> restoreAttachments(HostDirectory directory, RelayHost host, {String? threadId}) async => [];
  @override Future<Map<String, dynamic>> options(HostDirectory directory, RelayHost host, {String? threadId}) async => {
    'capabilities': {'attachments-v2', 'plan-v1', 'goal-v1', 'model-control-v1'},
    'models': {'data': [{'id': 'preview-model', 'model': 'preview-model', 'displayName': '默认模型', 'supportedReasoningEfforts': [{'reasoningEffort': 'low'}]}]},
    'runtime': {'desktop': {'safeLaunch': true, 'canWake': false}},
    'projects': {'data': [{'cwd': '工作台 / 文档', 'name': '文档'}]},
    'agents': {'data': [{'id': 'codex', 'name': 'Codex', 'available': true, 'models': []}]},
  };
  @override Future<dynamic> perform(HostDirectory directory, RelayHost host, String method, Map<String, dynamic> params,
    {List<PickedAttachment> attachments = const [], bool Function()? cancelled, void Function(int, int)? onProgress}) async => {'ok': true};
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  const host = RelayHost(id: 'preview', name: '书房电脑', online: true, signingPublicKey: 'preview', encryptionPublicKey: 'preview');
  final directory = HostDirectory(SessionRef(0, {'accountId': 'preview'}), [host]);
  final controller = WorkspaceController(readDirectory: () async => directory,
    readCatalog: (_, _) async => [
      {'id': 'one', 'name': '整理这个月的项目记录', 'cwd': '工作台 / 文档'},
      {'id': 'two', 'name': '检查图片导出结果', 'cwd': '工作台 / 设计'},
      {'id': 'three', 'name': '继续完善移动端', 'cwd': 'Agent Pocket'},
    ],
    readTask: (_, _, id) async => {'thread': {'id': id, 'capabilities': {'send': true, 'plan': true, 'goal': true, 'handoff': false}, 'turns': [
      {'id': 'turn', 'items': [
        {'id': 'question', 'type': 'userMessage', 'content': [{'type': 'text', 'text': '把这一段整理清楚。'}]},
        {'id': 'answer', 'type': 'agentMessage', 'text': '已经整理好了，文件保存在项目目录里。'},
      ]},
    ]}}, isCurrent: (_) => true, service: _PreviewService(),
    readArtifacts: (_, _, _, {cursor}) async => [{'id': 'preview-file', 'name': '示例.txt', 'mimeType': 'text/plain',
      'size': utf8.encode('这是一份用于预览的示例文件。').length, 'messageId': 'turn:answer', 'source': '示例.txt'}],
    readArtifactFile: (_, _, _, _, output, {cancelled, onProgress}) async {
      final bytes = utf8.encode('这是一份用于预览的示例文件。');
      await output.writeFrom(bytes);
      onProgress?.call(bytes.length, bytes.length);
    });
  runApp(_PreviewApp(controller: controller));
}

class _PreviewApp extends StatefulWidget {
  const _PreviewApp({required this.controller});
  final WorkspaceController controller;
  @override State<_PreviewApp> createState() => _PreviewAppState();
}

class _PreviewAppState extends State<_PreviewApp> {
  PocketSkin skin = PocketSkin.paper;
  @override Widget build(BuildContext context) => MaterialApp(title: 'Agent Pocket preview', theme: skin.theme(),
    home: WorkspaceScreen(controller: widget.controller, skin: skin, onSkinChange: (value) async { setState(() => skin = value); }));
}
