import 'package:app/ui/composer.dart';
import 'package:app/ui/interaction_card.dart';
import 'package:app/tasks/thread_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('composer submits the selected model, effort and Plan', (tester) async {
    List<dynamic>? submitted;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: ChatComposer(canSend: true, canPlan: true, canAttach: false, busy: false,
      models: const {'data': [{'id': 'model-a', 'model': 'model-a', 'displayName': 'Model A',
        'supportedReasoningEfforts': [{'reasoningEffort': 'low'}, {'reasoningEffort': 'high'}]}]},
      onSend: (text, model, effort, plan, files) async { submitted = [text, model, effort, plan, files]; }))));
    await tester.tap(find.text('模型')); await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButtonFormField<String>).first); await tester.pumpAndSettle();
    await tester.tap(find.text('Model A').last); await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButtonFormField<String>).last); await tester.pumpAndSettle();
    await tester.tap(find.text('high').last); await tester.pumpAndSettle();
    await tester.tap(find.text('Plan')); await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'test message'); await tester.pump();
    await tester.tap(find.byTooltip('发送')); await tester.pumpAndSettle();
    expect(submitted?.take(4).toList(), ['test message', 'model-a', 'high', true]);
  });
  testWidgets('composer remains usable in landscape with large text and a keyboard', (tester) async {
    tester.view.physicalSize = const Size(640, 360); tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize); addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(home: MediaQuery(data: const MediaQueryData(size: Size(640, 360), textScaler: TextScaler.linear(1.8)),
      child: Scaffold(body: Column(children: [const Expanded(child: Text('对话')), ConstrainedBox(constraints: const BoxConstraints(maxHeight: 150),
        child: ChatComposer(canSend: true, canPlan: true, canAttach: true, busy: false, active: true, models: const {'data': []}, onSend: (_, _, _, _, _) async {}))])))));
    await tester.enterText(find.byType(TextField), '追加内容'); await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
  testWidgets('approval only exposes the declared choices and cannot double-submit', (tester) async {
    var actions = 0;
    final item = ThreadItem(id: 'approval', turnId: '', type: 'pocketApproval', raw: const {'id': 'approval', 'requestId': 'request',
      'available': true, 'owner': 'desktop', 'allowedDecisions': ['deny'], 'summary': '运行命令', 'command': 'echo fixture'});
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: InteractionCard(items: [item], enabled: true,
      onAction: (method, params) async { actions++; expect(method, 'approval/respond'); expect(params['decision'], 'deny'); }))));
    await tester.pumpAndSettle();
    expect(find.text('允许一次'), findsNothing);
    await tester.tap(find.text('拒绝')); await tester.pumpAndSettle(); expect(actions, 1);
  });
  testWidgets('all questions sharing one request must be answered before submission', (tester) async {
    Map<String, dynamic>? submitted;
    final items = [for (final id in ['one', 'two']) ThreadItem(id: id, turnId: '', type: 'pocketQuestion', raw: {
      'id': id, 'requestId': 'request', 'questionId': id, 'available': true, 'prompt': '问题 $id', 'options': [{'label': '选择 $id'}]})];
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: InteractionCard(items: items, enabled: true,
      onAction: (_, params) async { submitted = params; })))));
    await tester.tap(find.text('选择 one')); await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull);
    await tester.tap(find.text('选择 two')); await tester.pumpAndSettle();
    await tester.tap(find.text('提交回答')); await tester.pumpAndSettle();
    expect(submitted?['answers'], {'one': {'answers': ['选择 one']}, 'two': {'answers': ['选择 two']}});
  });
}
