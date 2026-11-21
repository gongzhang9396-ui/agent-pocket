import 'dart:io';
import 'package:app/preview.dart' as preview;
import 'package:app/ui/appearance.dart';
import 'package:app/ui/composer.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  for (final skin in PocketSkin.values) {
    testWidgets('${skin.label} fits narrow, regular and landscape chat layouts', (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 640);
      addTearDown(tester.view.resetPhysicalSize); addTearDown(tester.view.resetDevicePixelRatio);
      preview.main(); await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('外观')); await tester.pumpAndSettle();
      await tester.tap(find.text(skin.label)); await tester.pumpAndSettle();
      await tester.tap(find.text('整理这个月的项目记录')); await tester.pumpAndSettle();
      expect(find.byType(ChatComposer), findsOneWidget);
      for (final size in [const Size(320, 640), const Size(390, 844), const Size(640, 360)]) {
        tester.view.physicalSize = size; await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: '${skin.id} $size');
        expect(tester.getSize(find.byType(ChatComposer)).width, lessThanOrEqualTo(size.width));
      }
      tester.view.physicalSize = const Size(320, 640); await tester.pumpAndSettle();
      // Real production widgets with synthetic messages; Android image output
      // is only a visual QA artifact, never a performance measurement.
      await binding.convertFlutterSurfaceToImage(); await tester.pumpAndSettle();
      final bytes = await binding.takeScreenshot('chat-${skin.id}');
      final dir = Directory('${Directory.systemTemp.path}/pocket-visual-qa'); await dir.create();
      await File('${dir.path}/chat-${skin.id}.png').writeAsBytes(bytes);
      await tester.pumpWidget(const SizedBox());
    });
  }
}
