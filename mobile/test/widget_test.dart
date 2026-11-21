import 'package:app/protocol/relay_hosts.dart';
import 'package:app/session/pocket_session_service.dart';
import 'package:app/session/session_manager.dart';
import 'package:app/tasks/workspace_controller.dart';
import 'package:app/ui/workspace_screen.dart';
import 'package:app/ui/message_markdown.dart';
import 'package:app/ui/artifact_card.dart';
import 'package:app/ui/appearance.dart';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('shows tasks and opens a conversation', (tester) async {
    tester.view.physicalSize = const Size(320, 740);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const host = RelayHost(id: 'host', name: '电脑', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account'}), [host]);
    final controller = WorkspaceController(readDirectory: () async => directory,
      readCatalog: (_, _) async => [{'id': 'task', 'name': '测试任务'}],
      readTask: (_, _, _) async => {'thread': {'id': 'task', 'turns': [
        {'id': 'turn', 'items': [{'id': 'reply', 'type': 'agentMessage', 'text': '测试回复'}]},
      ]}}, isCurrent: (_) => true);
    await tester.pumpWidget(MaterialApp(home: WorkspaceScreen(controller: controller)));
    await tester.pumpAndSettle();
    expect(find.text('测试任务'), findsOneWidget);
    await tester.tap(find.text('测试任务'));
    await tester.pumpAndSettle();
    expect(find.text('测试回复'), findsOneWidget);
    expect(find.text('当前开发版仅支持查看'), findsOneWidget);
  });

  testWidgets('large text fits the task view', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const host = RelayHost(id: 'host', name: '电脑', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account'}), [host]);
    final controller = WorkspaceController(readDirectory: () async => directory,
      readCatalog: (_, _) async => [{'id': 'task', 'name': '一个较长的任务名称'}],
      readTask: (_, _, _) async => {}, isCurrent: (_) => true);
    await tester.pumpWidget(MaterialApp(home: MediaQuery(data: const MediaQueryData(textScaler: TextScaler.linear(1.5)),
      child: WorkspaceScreen(controller: controller))));
    await tester.pumpAndSettle();
    expect(find.text('一个较长的任务名称'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('public progress expands on a narrow screen and command copying remains available', (tester) async {
    tester.view.physicalSize = const Size(320, 740);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const host = RelayHost(id: 'host', name: '电脑', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account'}), [host]);
    final controller = WorkspaceController(readDirectory: () async => directory,
      readCatalog: (_, _) async => [{'id': 'task', 'name': '进度测试'}],
      readTask: (_, _, _) async => {'thread': {'id': 'task', 'status': 'active', 'turns': [
        {'id': 'turn', 'status': 'inProgress', 'items': [
          {'id': 'r', 'type': 'reasoning', 'summary': ['定位续期入口'], 'content': ['PRIVATE'], 'status': 'completed'},
          {'id': 'c', 'type': 'commandExecution', 'command': 'npm test', 'aggregatedOutput': 'passed', 'status': 'inProgress'},
        ]},
      ]}}, isCurrent: (_) => true);
    await tester.pumpWidget(MaterialApp(home: MediaQuery(data: const MediaQueryData(textScaler: TextScaler.linear(1.4)),
      child: WorkspaceScreen(controller: controller))));
    await tester.pumpAndSettle();
    await tester.tap(find.text('进度测试')); await tester.pumpAndSettle();
    expect(controller.progress?.title, '执行命令');
    await tester.ensureVisible(find.text('思考摘要 · 已完成'));
    await tester.tap(find.text('思考摘要 · 已完成')); await tester.pumpAndSettle();
    expect(find.textContaining('定位续期入口'), findsWidgets);
    expect(find.textContaining('PRIVATE'), findsNothing);
    await tester.ensureVisible(find.text('执行命令 · 进行中'));
    await tester.tap(find.text('执行命令 · 进行中')); await tester.pumpAndSettle();
    expect(find.byTooltip('复制代码'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('renders code and does not automatically load message images', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: MessageMarkdown(
      text: '```dart\nprint("hello");\n```\n\n![示例](https://example.invalid/image.png)',
    ))));
    await tester.pumpAndSettle();
    expect(find.byTooltip('复制代码'), findsOneWidget);
    expect(find.text('[图片：示例]'), findsOneWidget);
    await tester.tap(find.byTooltip('复制代码'));
    await tester.pump();
    expect((await Clipboard.getData(Clipboard.kTextPlain))?.text, contains('print("hello");'));
  });

  testWidgets('reads a text artifact only after the user asks', (tester) async {
    var reads = 0;
    Map<dynamic, dynamic>? saveArguments;
    const saveChannel = MethodChannel('agent_pocket/file_save');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(saveChannel, (call) async {
      saveArguments = call.arguments as Map;
      return true;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(saveChannel, null));
    final data = utf8.encode('文件内容');
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: ArtifactCard(
      artifact: {'id': 'file', 'name': '笔记.txt', 'mimeType': 'text/plain', 'size': data.length},
      download: (artifact, output, {cancelled, onProgress}) async {
        reads++;
        await output.writeFrom(data);
        onProgress?.call(data.length, data.length);
      },
    ))));
    expect(reads, 0);
    await tester.tap(find.text('读取文本'));
    await tester.pump();
    await tester.runAsync(() async { await Future<void>.delayed(const Duration(milliseconds: 300)); });
    await tester.pumpAndSettle();
    expect(reads, 1);
    expect(find.text('文件内容'), findsOneWidget);
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(saveArguments?['name'], '笔记.txt');
    expect(saveArguments?['path'], contains('/pocket-artifact-'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('previews a downloaded image and opens its zoom view', (tester) async {
    final bytes = (await rootBundle.load('assets/scene-paper-v1.png')).buffer.asUint8List();
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: ArtifactCard(
      artifact: {'id': 'image', 'name': '图片.png', 'mimeType': 'image/png', 'size': bytes.length},
      download: (artifact, output, {cancelled, onProgress}) async { await output.writeFrom(bytes); },
    ))));
    await tester.tap(find.text('显示图片'));
    await tester.pump();
    await tester.runAsync(() async { await Future<void>.delayed(const Duration(milliseconds: 300)); });
    await tester.pumpAndSettle();
    expect(find.text('放大查看'), findsOneWidget);
    expect(find.text('图片无法显示'), findsNothing);
    await tester.tap(find.text('放大查看'));
    await tester.pumpAndSettle();
    expect(find.byType(InteractiveViewer), findsOneWidget);
    await tester.tap(find.byTooltip('关闭预览'));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('offers the three existing appearance choices', (tester) async {
    const host = RelayHost(id: 'host', name: '电脑', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account'}), [host]);
    PocketSkin? selected;
    final controller = WorkspaceController(readDirectory: () async => directory, readCatalog: (_, _) async => [],
      readTask: (_, _, _) async => {}, isCurrent: (_) => true);
    await tester.pumpWidget(MaterialApp(home: WorkspaceScreen(controller: controller,
      onSkinChange: (skin) async { selected = skin; })));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('外观'));
    await tester.pumpAndSettle();
    expect(find.text('纸间'), findsOneWidget);
    expect(find.text('像素'), findsOneWidget);
    expect(find.text('画室'), findsOneWidget);
    await tester.tap(find.text('像素'));
    await tester.pumpAndSettle();
    expect(selected, PocketSkin.pixel);
  });

  testWidgets('shows pending approvals without pretending they can be submitted', (tester) async {
    const host = RelayHost(id: 'host', name: '电脑', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account'}), [host]);
    final controller = WorkspaceController(readDirectory: () async => directory,
      readCatalog: (_, _) async => [{'id': 'task', 'name': '任务'}],
      readTask: (_, _, _) async => {'thread': {'id': 'task', 'turns': [], 'interactionItems': [
        {'id': 'request', 'type': 'pocketApproval', 'summary': '访问文件', 'available': true},
      ]}}, isCurrent: (_) => true);
    await tester.pumpWidget(MaterialApp(home: WorkspaceScreen(controller: controller)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('任务'));
    await tester.pumpAndSettle();
    expect(find.text('访问文件'), findsOneWidget);
    expect(find.text('请在电脑端处理'), findsOneWidget);
    expect(find.text('允许'), findsNothing);
  });
}
