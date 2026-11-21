import 'dart:async';
import 'package:app/protocol/relay_event_feed.dart';
import 'package:app/protocol/relay_hosts.dart';
import 'package:app/session/background_connection.dart';
import 'package:app/session/native_configuration.dart';
import 'package:app/session/pocket_session_service.dart';
import 'package:app/session/session_manager.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

class _Feed implements RelayEventFeed {
  final stopped = Completer<void>();
  final stream = StreamController<FeedUpdate>.broadcast();
  @override Stream<FeedUpdate> get updates => stream.stream;
  @override Future<void> stop() async { if (!stopped.isCompleted) stopped.complete(); }
  @override Future<void> start(SessionRef session, List<RelayHost> hosts) async {}
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
class _Service implements PocketSessionService {
  @override final _Feed feed = _Feed();
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  test('native foreground timeout stops the connection without replacing the app engine', () async {
    final service = _Service(), before = await NativeConfiguration.read();
    final background = BackgroundConnection(service);
    try {
      await background.start();
      // The harness sends HOME after observing this marker and configures the
      // task-owned emulator's dataSync timeout to three seconds, then restores it.
      // ignore: avoid_print
      print('NATIVE_BACKGROUND_READY');
      await service.feed.stopped.future.timeout(const Duration(seconds: 40));
      final after = await NativeConfiguration.read();
      expect(after['engineInstanceId'], before['engineInstanceId']); expect(after['engineInstanceId'], isNotNull);
    } finally { await background.stop(); await background.dispose(); await service.feed.stream.close(); }
  }, timeout: const Timeout(Duration(minutes: 1)));
}
