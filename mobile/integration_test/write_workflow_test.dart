import 'dart:convert';
import 'dart:io';
import 'package:app/protocol/host_read_channel.dart';
import 'package:app/protocol/relay_hosts.dart';
import 'package:app/protocol/rpc_client.dart';
import 'package:app/tasks/host_catalog_loader.dart';
import 'package:app/tasks/attachment_uploader.dart';
import 'package:app/tasks/operation_runner.dart';
import 'package:app/protocol/relay_account_crypto.dart';
import 'package:app/session/device_enrollment.dart';
import 'package:app/session/relay_http.dart';
import 'package:app/session/session_manager.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sodium/sodium_sumo.dart';
import 'host_read_channel_test.dart' as fixture;
class MemoryStore implements CredentialStore {
  MemoryStore(this.value);
  Map<String, dynamic>? value;
  bool blocked = false;
  @override Future<Map<String, dynamic>?> load() async => value;
  @override Future<bool> isBlocked() async => blocked;
  @override Future<void> block() async { blocked = true; }
  @override Future<void> save(Map<String, dynamic> credentials) async { value = credentials; blocked = false; }
  @override Future<void> clearCredentials() async { value = null; blocked = true; }
}
class MemoryJournal implements OperationJournal {
  final values = <String, List<Map<String, dynamic>>>{};
  @override Future<List<Map<String, dynamic>>> load(String scope) async => List.of(values[scope] ?? []);
  @override Future<void> save(String scope, List<Map<String, dynamic>> operations) async { values[scope] = List.of(operations); }
}

class DraftStore implements EnrollmentStore {
  Map<String, dynamic>? value;
  @override Future<Map<String, dynamic>?> load() async => value?.isEmpty == true ? null : value;
  @override Future<void> save(Map<String, dynamic> provisional) async { value = jsonDecode(jsonEncode(provisional)) as Map<String, dynamic>; }
}
class EnrollmentHttp extends RelayHttp {
  EnrollmentHttp(this.store);
  final DraftStore store;
  int attempts = 0;
  String? signing;
  @override Future<Map<String, dynamic>> json(String endpoint, String path, {String method = 'GET', Map<String, dynamic>? body, String? token, bool Function()? stillCurrent}) async {
    if (path == '/api/public/config') return {'deviceLoginRecovery': 1};
    expect(path, '/api/auth/login'); expect(store.value?['deviceSigningPrivateKey'], isNotEmpty);
    expect(body!['recoverDeviceKeys'], true); expect(body['deviceRecoveryProof'], isNotEmpty);
    signing ??= body['deviceSigningPublicKey'] as String;
    expect(body['deviceSigningPublicKey'], signing);
    if (attempts++ == 0) throw const SocketException('response lost after create');
    final now = DateTime.now().millisecondsSinceEpoch;
    return {'account': {'id': 'account', 'username': 'testuser', 'signingPublicKey': 'account-sign', 'encryptionPublicKey': 'account-box'},
      'device': {'id': 'one-device', 'name': 'Android', 'status': 'pending'},
      'tokens': {'accessToken': 'access', 'refreshToken': 'refresh', 'accessExpiresAt': now + 60000, 'refreshExpiresAt': now + 600000}};
  }
}
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  test('lost enrollment reply reuses persisted keys and recovers one device', () async {
    final sodium = await SodiumSumoInit.init(), draft = DraftStore(), credentials = MemoryStore(null);
    final sessions = SessionManager(credentials, (_) async => throw StateError('refresh'));
    final http = EnrollmentHttp(draft), enrollment = DeviceEnrollment(RelayAccountCrypto(sodium), sessions, draft, EnrollmentHttp(draft));
    await expectLater(enrollment.login('https://example.invalid', 'testuser', 'password', 'Android'), throwsA(isA<SocketException>()));
    final firstKey = draft.value!['deviceSigningPublicKey'];
    // Same service instance emulates an explicit retry; durable draft also
    // supports a new instance after process death.
    final restartedHttp = http..attempts = 1;
    final restarted = DeviceEnrollment(RelayAccountCrypto(sodium), sessions, draft, restartedHttp);
    await restarted.login('https://example.invalid', 'testuser', 'password', 'Android');
    expect(credentials.value!['deviceId'], 'one-device'); expect(credentials.value!['deviceSigningPublicKey'], firstKey);
    expect(draft.value, isEmpty);
  });
  test('encrypted Dart upload chunks, resumes after a lost acknowledgement and sends once', () async {
    final sodium = await SodiumSumoInit.init();
    final outer = fixture.FixtureOuter();
    final data = await outer.request('/fixture');
    var channel = await HostReadChannel.open(sodium, outer, data['credentials'] as Map<String, dynamic>, data['host'] as Map<String, dynamic>, newOperationId());
    final dir = await Directory.systemTemp.createTemp('pocket-upload-test-');
    final source = File('${dir.path}/source.txt');
    final bytes = List<int>.generate(attachmentChunkSize * 2 + 11, (index) => index % 251); await source.writeAsBytes(bytes);
    final attachment = PickedAttachment(path: source.path, filename: 'source.txt', mimeType: 'text/plain', size: bytes.length, sha256: sha256.convert(bytes).toString());
    final operation = newOperationId(); var writes = 0, persisted = 0;
    try {
      final failing = AttachmentUploader(read: channel.read, write: (method, params) async {
        final result = await channel.execute(method, params);
        if (method == 'attachment/write' && writes++ == 0) throw const SocketException('ack lost'); return result;
      }, persist: () async { persisted++; });
      await expectLater(failing.upload(operation, {'cwd': 'fixture-project'}, [attachment]), throwsA(isA<SocketException>()));
      expect(attachment.id, isNotNull); expect(persisted, 1); await channel.close();
      channel = await HostReadChannel.open(sodium, outer, data['credentials'] as Map<String, dynamic>, data['host'] as Map<String, dynamic>, newOperationId());
      final uploader = AttachmentUploader(read: channel.read, write: channel.execute, persist: () async {});
      final refs = await uploader.upload(operation, {'cwd': 'fixture-project'}, [attachment]);
      final runner = OperationRunner(MemoryJournal());
      final created = await runner.run('fixture', 'thread/start', {'cwd': 'fixture-project', 'text': 'test', 'attachmentIds': refs}, channel.execute, channel.read, operationId: operation);
      expect(created['thread']['id'], startsWith('created-'));
      final receipt = await channel.read('operation/get', {'operationId': operation}); expect(receipt['result'], created);
      expect(await source.exists(), true);
    } finally { await channel.close(); await outer.close(); await source.delete(); await dir.delete(); }
  }, timeout: const Timeout(Duration(minutes: 2)));
  test('a session change after a batch mutation response retains its receipt without resending', () async {
    final sodium = await SodiumSumoInit.init(), outer = fixture.FixtureOuter();
    final data = await outer.request('/fixture'), now = DateTime.now().millisecondsSinceEpoch;
    final credentials = {...data['credentials'] as Map<String, dynamic>, 'endpoint': 'https://example.invalid', 'accessToken': 'fixture-access',
      'refreshToken': 'unused', 'accessExpiresAt': now + 600000, 'refreshExpiresAt': now + 6000000};
    final sessions = SessionManager(MemoryStore(credentials), (_) async => throw StateError('unused refresh'));
    final loader = HostCatalogLoader(sodium, sessions, connect: (_, token) async => RpcClient.fromSocket(await WebSocket.connect(
      'ws://127.0.0.1:49322/ws/device', headers: {HttpHeaders.authorizationHeader: 'Bearer $token'})));
    final ref = await sessions.snapshot(), hostData = data['host'] as Map<String, dynamic>;
    final host = RelayHost(id: hostData['id'] as String, name: 'Fixture', online: true,
      signingPublicKey: hostData['signingPublicKey'] as String, encryptionPublicKey: hostData['encryptionPublicKey'] as String);
    final journal = MemoryJournal(), runner = OperationRunner(MemoryJournal());
    final checked = OperationRunner(journal), operation = newOperationId(); var sends = 0;
    try {
      await expectLater(loader.transfer(ref, host, (channel) async => checked.run('batch-generation', 'thread/start',
        {'cwd': 'fixture-project', 'text': 'generation fixture'}, (method, params) async {
          sends++; final result = await channel.execute(method, params); await sessions.clear(); return result;
        }, channel.read, operationId: operation, retainSuccess: true)), throwsA(isA<SessionChanged>()));
      expect(sends, 1); expect((await checked.pending('batch-generation')).single['operationId'], operation);
      await sessions.replace(sessions.generation, credentials);
      final fresh = await sessions.snapshot();
      final result = await checked.recover('batch-generation', (await checked.pending('batch-generation')).single,
        (method, params) => loader.read(fresh, host, method, params));
      expect(result['thread']['id'], startsWith('created-')); expect(sends, 1); expect(await checked.pending('batch-generation'), isEmpty);
      expect(await runner.pending('unrelated'), isEmpty);
    } finally { await outer.close(); }
  });
}
