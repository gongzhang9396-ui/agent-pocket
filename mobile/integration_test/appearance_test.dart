import 'package:app/ui/appearance.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  test('keeps the legacy appearance identifiers in Android preferences', () async {
    const channel = MethodChannel('agent_pocket/appearance');
    final original = await channel.invokeMethod<String>('read');
    final first = AppearanceController();
    final second = AppearanceController();
    try {
      await first.select(PocketSkin.pixel);
      await second.load();
      expect(second.skin, PocketSkin.pixel);
      await second.select(PocketSkin.studio);
      expect(await channel.invokeMethod<String>('read'), 'oil');
    } finally {
      first.dispose(); second.dispose();
      await channel.invokeMethod<void>('write', {'skin': {'plain', 'pixel', 'oil'}.contains(original) ? original : 'plain'});
    }
  });
}
