import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:app/tasks/thread_page.dart';
import 'package:app/ui/interaction_card.dart';

void main() {
  testWidgets('DSH multi-select replies preserve both labels and custom text', (tester) async {
    Map<String, dynamic>? sent;
    final item = ThreadItem(id: 'dsh-question', turnId: 'turn', type: 'pocketQuestion', raw: {
      'requestId': 'r', 'questionId': 'q', 'prompt': '选择', 'multiSelect': true, 'available': true, 'options': ['first', 'second'],
    });
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: InteractionCard(items: [item], enabled: true,
      onAction: (method, params) async { expect(method, 'question/respond'); sent = params; })))));
    await tester.tap(find.text('first')); await tester.pump();
    await tester.tap(find.text('second')); await tester.pump();
    await tester.enterText(find.byType(TextField), 'custom'); await tester.pump();
    await tester.tap(find.text('提交回答')); await tester.pumpAndSettle();
    expect(sent?['requestId'], 'r');
    expect((sent?['answers'] as Map)['q'], {'answers': ['first', 'second', 'custom']});
  });
  testWidgets('unavailable DSH questions cannot submit a stale answer', (tester) async {
    var writes = 0;
    final item = ThreadItem(id: 'dsh-ended', turnId: 'turn', type: 'pocketQuestion', raw: {
      'requestId': 'r', 'questionId': 'q', 'prompt': '已结束', 'available': false, 'options': ['first'],
    });
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: InteractionCard(items: [item], enabled: true, onAction: (_, _) async { writes++; }))));
    await tester.tap(find.text('first')); await tester.pump();
    expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull); expect(writes, 0);
  });
}
