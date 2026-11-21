import 'dart:convert';
import 'dart:io';
import 'package:app/protocol/relay_hosts.dart';
import 'package:app/protocol/rpc_client.dart';
import 'package:app/session/session_manager.dart';
import 'package:app/tasks/host_catalog_loader.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sodium/sodium_sumo.dart';

class _Store implements CredentialStore {
  _Store(this.value);
  Map<String, dynamic>? value;
  bool blocked = false;
  @override Future<Map<String, dynamic>?> load() async => value == null ? null : {...value!};
  @override Future<bool> isBlocked() async => blocked;
  @override Future<void> block() async { blocked = true; }
  @override Future<void> save(Map<String, dynamic> credentials) async { value = {...credentials}; blocked = false; }
  @override Future<void> clearCredentials() async { value = null; blocked = true; }
}
class _DirectorySocket implements HostListConnection {
  _DirectorySocket(this.rpc);
  final RpcClient rpc;
  @override Future<dynamic> call(String method, [Map<String, dynamic> params = const {}]) => rpc.call(method, params);
  @override Future<void> close() => rpc.close();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  test('session reads Host directory and catalog through WebSocket and Node crypto', () async {
    final sodium = await SodiumSumoInit.init();
    final http = HttpClient();
    final request = await http.getUrl(Uri.parse('http://127.0.0.1:49322/fixture'));
    final response = await request.close();
    final fixture = jsonDecode(await utf8.decoder.bind(response).join()) as Map<String, dynamic>;
    http.close(force: true);
    final credentials = {...fixture['credentials'] as Map<String, dynamic>, 'endpoint': 'https://example.invalid',
      'accessToken': 'fixture-access', 'refreshToken': 'unused', 'accessExpiresAt': 1000000, 'refreshExpiresAt': 2000000};
    final sessions = SessionManager(_Store(credentials), (_) async => throw StateError('unexpected refresh'), now: () => 1000);
    final ref = await sessions.snapshot();
    Future<RpcClient> socket(Uri uri, String token) async {
      expect(uri.scheme, 'wss');
      final ws = await WebSocket.connect('ws://127.0.0.1:49322/ws/device', headers: {'Authorization': 'Bearer $token'});
      return RpcClient.fromSocket(ws);
    }
    final directory = RelayHosts(sessions, connect: (uri, token) async => _DirectorySocket(await socket(uri, token)));
    final hosts = await directory.list(ref);
    expect(hosts.single.id, 'fixture-host');
    final loader = HostCatalogLoader(sodium, sessions, connect: socket);
    final tasks = await loader.load(ref, hosts.single);
    expect(tasks.single['id'], 'fixture-thread');
    final detail = await loader.readThread(ref, hosts.single, 'fixture-thread');
    expect((detail['thread'] as Map)['id'], 'fixture-thread');
    final files = await loader.listArtifacts(ref, hosts.single, 'fixture-thread');
    final temporary = await Directory.systemTemp.createTemp('pocket-fixture-');
    final file = File('${temporary.path}${Platform.pathSeparator}file.tmp');
    final output = await file.open(mode: FileMode.write);
    var closed = false;
    try {
      await loader.downloadArtifact(ref, hosts.single, 'fixture-thread', files.single, output);
      await output.close();
      closed = true;
      final bytes = await file.readAsBytes();
      expect(bytes.length, 200000);
      expect(bytes.every((byte) => byte == 0x4b), isTrue);
    } finally {
      if (!closed) { await output.close(); }
      await file.delete();
      await temporary.delete();
    }
  }, timeout: const Timeout(Duration(seconds: 30)));
}
