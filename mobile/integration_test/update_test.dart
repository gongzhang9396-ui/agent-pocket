import 'dart:convert';
import 'dart:io';
import 'package:app/session/pocket_session_service.dart';
import 'package:app/session/session_manager.dart';
import 'package:app/update/app_update.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sodium/sodium_sumo.dart';
import 'write_workflow_test.dart' show MemoryStore;

class _Service implements PocketSessionService {
  _Service(this.sodium, this.sessions);
  @override final SodiumSumo sodium;
  @override final SessionManager sessions;
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
class _LoopbackHttp implements HttpClient {
  _LoopbackHttp(this.client);
  final HttpClient client;
  Uri route(Uri original) { expect(original.scheme, 'https'); expect(original.host, 'example.invalid'); return original.replace(scheme: 'http', host: '127.0.0.1', port: 49322); }
  @override Future<HttpClientRequest> openUrl(String method, Uri url) => client.openUrl(method, route(url));
  @override Future<HttpClientRequest> getUrl(Uri url) => client.getUrl(route(url));
  @override set connectionTimeout(Duration? value) { client.connectionTimeout = value; }
  @override void close({bool force = false}) => client.close(force: force);
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  test('signed update, concurrent 401 refresh and bounded download use one shared session', () async {
    final sodium = await SodiumSumoInit.init(), fixtureClient = HttpClient();
    final response = await (await fixtureClient.getUrl(Uri.parse('http://127.0.0.1:49322/update-fixture'))).close();
    final fixture = jsonDecode(await utf8.decoder.bind(response).join()) as Map<String, dynamic>; fixtureClient.close();
    final config = {'version': '0.3.4', 'versionCode': 304, 'updatePublicKeySpki': fixture['updatePublicKey']};
    final now = DateTime.now().millisecondsSinceEpoch;
    var rotations = 0;
    final sessions = SessionManager(MemoryStore({'endpoint': 'https://example.invalid', 'accountId': 'account', 'deviceId': 'device',
      'deviceStatus': 'approved', 'contentKey': 'fixture', 'accessToken': 'expired', 'refreshToken': 'fixture-refresh',
      'accessExpiresAt': now + 60000, 'refreshExpiresAt': now + 600000}), (_) async {
        rotations++; await Future<void>.delayed(const Duration(milliseconds: 60));
        return {'accessToken': 'fixture-update-new', 'refreshToken': 'next', 'accessExpiresAt': now + 600000, 'refreshExpiresAt': now + 6000000};
      });
    binding.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('agent_pocket/configuration'), (_) async => config);
    File? downloaded;
    final clients = List.generate(8, (_) => HttpClient());
    binding.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('agent_pocket/update'), (call) async {
      downloaded = File((call.arguments as Map)['path'] as String);
      expect(await downloaded!.length(), 512 * 1024); expect((await downloaded!.openRead(0, 1).first).single, 42);
      return true;
    });
    try {
      final updater = AppUpdate(_Service(sodium, sessions));
      // The override changes only the synthetic test transport. Production
      // validation still sees the original HTTPS same-origin download URL.
      await HttpOverrides.runZoned(() async {
        final results = await Future.wait([updater.check(), updater.check()]);
        expect(rotations, 1); expect(results.first?.versionCode, 400);
        await updater.downloadAndInstall(results.first!);
      }, createHttpClient: (_) => _LoopbackHttp(clients.removeLast()));
      expect(downloaded, isNotNull);
      final signed = fixture['updateResponse'] as Map<String, dynamic>;
      expect(() => AppUpdate.verify({...signed, 'downloadUrl': 'https://unrelated.invalid/file.apk'}, config, 'https://example.invalid', sodium), throwsFormatException);
      expect(() => AppUpdate.verify({...signed, 'manifestJson': '${signed['manifestJson']} '}, config, 'https://example.invalid', sodium), throwsFormatException);
      expect(AppUpdate.verify(signed, {...config, 'version': '0.4.0', 'versionCode': 400}, 'https://example.invalid', sodium), isNull);
    } finally {
      binding.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('agent_pocket/configuration'), null);
      for (final client in clients) { client.close(force: true); }
      binding.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('agent_pocket/update'), null);
      if (downloaded != null && await downloaded!.exists()) { final parent = downloaded!.parent; await downloaded!.delete(); await parent.delete(); }
    }
  });
}
